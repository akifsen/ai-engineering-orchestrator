import { spawn } from "node:child_process";
import { defaultNpmCi } from "./npm-ci.mjs";
import { createHash } from "node:crypto";
import { access, constants, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AEO_VERSION = "1.0.0";
export const AGENTS_BEGIN = "<!-- AEO:BEGIN ORCHESTRATION -->";
export const AGENTS_END = "<!-- AEO:END ORCHESTRATION -->";
export const CONFIG_BEGIN = "# >>> AEO MANAGED CONFIG BEGIN";
export const CONFIG_END = "# <<< AEO MANAGED CONFIG END";

export const PERMISSION = "mcp__aeo-antigravity__delegate_antigravity";
export const MCP_ID = "aeo-antigravity";

export const CODEX_TABLES = [
    "mcp_servers.aeo-antigravity",
    "agents.aeo_explorer",
    "agents.aeo_architect",
    "agents.aeo_reviewer",
    "agents.aeo_fast_worker"
];

const CODEX_AGENTS = [
    ["aeo-explorer.toml", "aeo_explorer", "Read-only discovery for AEO. Locate code, trace a call path, find tests, and return evidence. Do not implement or modify files."],
    ["aeo-architect.toml", "aeo_architect", "AEO architecture role. Cross-module design, transactions, persistence, concurrency, security, and large refactors. Do not implement the change."],
    ["aeo-reviewer.toml", "aeo_reviewer", "AEO independent review of correctness, regressions, security, concurrency, and test gaps. Do not approve the work and do not attribute edits without the Team Lead baseline."],
    ["aeo-fast-worker.toml", "aeo_fast_worker", "AEO role for a truly trivial deterministic edit only. Do not use for features, behavioral bug fixes, substantive tests, refactors, multi-file work, integrations, migrations, backend or frontend features, architecture, security, or concurrency. If the task is substantive, return it for Antigravity."]
];

const CLAUDE_AGENTS = [
    "aeo-explorer.md",
    "aeo-architect.md",
    "aeo-reviewer.md",
    "aeo-fast-worker.md"
];

const BRIDGE_FILES = [
    "package.json",
    "package-lock.json",
    "index.js",
    "README.md",
    "lib/delegate.js",
    "lib/server.js"
];

const BRIDGE_DIR = ".aeo/bridge/antigravity-mcp";
const GITIGNORE_RELATIVE = ".aeo/.gitignore";
const GITIGNORE_TEXT = "bridge/**/node_modules/\n";
const SCHEMA_VERSION = 2;

const BLOCK_LABELS = {
    AEO_ORCHESTRATION: "AGENTS.md AEO orchestration block",
    AEO_CONFIG: ".codex/config.toml AEO config block"
};

const TRUST_NOTE = "Codex loads <project>/.codex/config.toml only when the project is trusted. AEO does not change trust. Trust the project in Codex if the project configuration does not appear. Codex CLI and Codex IDE share these configuration layers, which is why AEO does not edit ~/.codex/config.toml.";

export function projectId(target) {
    return createHash("sha256").update(path.resolve(target)).digest("hex").slice(0, 16);
}

export function analyzeMarkers(text, begin, end) {
    const begins = indexesOf(text, begin);
    const ends = indexesOf(text, end);
    if (begins.length === 0 && ends.length === 0) {
        return { state: "absent" };
    }
    if (begins.length === 1 && ends.length === 1 && begins[0] < ends[0]) {
        const innerStart = begins[0] + begin.length;
        if (text.indexOf(end, innerStart) !== ends[0]) {
            return { state: "malformed" };
        }
        return {
            state: "present",
            prefix: text.slice(0, begins[0]),
            suffix: text.slice(ends[0] + end.length),
            inner: text.slice(innerStart, ends[0])
        };
    }
    return { state: "malformed" };
}

function indexesOf(text, needle) {
    const found = [];
    let from = 0;
    while (from <= text.length) {
        const index = text.indexOf(needle, from);
        if (index < 0) {
            return found;
        }
        found.push(index);
        from = index + needle.length;
    }
    return found;
}

export function nextManaged(current, begin, end, body) {
    const source = current ?? "";
    const markers = analyzeMarkers(source, begin, end);
    if (markers.state === "malformed") {
        return { state: "malformed", changed: false, next: source };
    }
    const trimmed = body.replace(/^\n+|\s+$/g, "");
    const raw = markers.state === "present"
        ? `${markers.prefix}${begin}\n${trimmed}\n${end}${markers.suffix}`
        : renderManaged(source, begin, trimmed, end, "");
    const next = raw.endsWith("\n") ? raw : `${raw}\n`;
    return { state: markers.state, next, changed: current !== next };
}

export function renderManaged(prefix, begin, body, end, suffix) {
    const trimmed = body.replace(/^\n+|\s+$/g, "");
    const block = `${begin}\n${trimmed}\n${end}`;
    if (prefix.length === 0) {
        return `${block}\n${suffix.replace(/^\n/, "")}`;
    }
    const glue = prefix.endsWith("\n\n") ? "" : prefix.endsWith("\n") ? "\n" : "\n\n";
    return `${prefix}${glue}${block}\n${suffix.replace(/^\n/, "")}`;
}

export function removeManaged(text, begin, end) {
    const markers = analyzeMarkers(text, begin, end);
    if (markers.state === "malformed") {
        throw new Error(`Malformed AEO markers in a managed file. Refusing to rewrite it.`);
    }
    if (markers.state === "absent") {
        return text;
    }
    return `${markers.prefix}${markers.suffix}`;
}

export function tableNames(text) {
    const names = [];
    let inTriple = false;
    for (const line of text.split(/\r?\n/)) {
        const quotes = line.match(/"""/g);
        if (quotes && quotes.length % 2 === 1) {
            inTriple = !inTriple;
            continue;
        }
        if (inTriple || /^\s*#/.test(line)) {
            continue;
        }
        const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
        if (header) {
            names.push(header[1].replaceAll("\"", "").replaceAll("'", "").trim());
        }
    }
    return names;
}

export function duplicateTables(text) {
    const names = tableNames(text);
    return [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
}

function tomlTablesOutside(text) {
    const markers = analyzeMarkers(text, CONFIG_BEGIN, CONFIG_END);
    const outside = markers.state === "present"
        ? `${markers.prefix}\n${markers.suffix}`
        : text;
    return tableNames(outside);
}

function toPosix(filePath) {
    return filePath.replaceAll("\\", "/");
}

async function readText(file) {
    try {
        return await readFile(file, "utf8");
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

async function exists(file) {
    try {
        await access(file, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function writeAtomic(file, contents, writeImpl = null) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.aeo-tmp`;
    try {
        if (writeImpl) {
            await writeImpl(temporary, contents);
        } else {
            const handle = await open(temporary, "w");
            try {
                await handle.writeFile(contents);
                await handle.sync();
            } finally {
                await handle.close();
            }
        }
        try {
            await rename(temporary, file);
        } catch (error) {
            if (error && (error.code === "EPERM" || error.code === "EEXIST")) {
                await rm(file, { force: true });
                await rename(temporary, file);
                return;
            }
            throw error;
        }
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

function defaultRepoRoot() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function sha256Hex(content) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return createHash("sha256").update(data).digest("hex");
}

async function readBytes(file) {
    try {
        return await readFile(file);
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

function hashInnerText(text, begin, end) {
    if (typeof text !== "string") {
        return null;
    }
    const markers = analyzeMarkers(text, begin, end);
    if (markers.state !== "present") {
        return null;
    }
    return sha256Hex(Buffer.from(markers.inner, "utf8"));
}

function installedEntries(manifest) {
    if (!manifest) {
        return [];
    }
    return (manifest.installedFiles || []).map((entry) => {
        if (typeof entry === "string") {
            return { path: entry, sha256: null };
        }
        return { path: entry.path, sha256: entry.sha256 || null };
    });
}

function manifestOwnsFile(manifest, relative) {
    const posix = toPosix(relative);
    return installedEntries(manifest).some((entry) => entry.path === posix || (entry.path === BRIDGE_DIR && posix.startsWith(`${BRIDGE_DIR}/`)));
}

function lastInstalledHash(manifest, relative) {
    const posix = toPosix(relative);
    const direct = installedEntries(manifest).find((entry) => entry.path === posix);
    return direct?.sha256 || null;
}

function blockRecord(manifest, file, id) {
    return (manifest?.managedBlocks || []).find((block) => block.file === file && block.id === id) || null;
}

export function classifyOwned({ current, preset, owned, lastHash, force }) {
    const presetHash = sha256Hex(preset);
    if (current === null) {
        return {
            action: owned ? "recreate" : "create",
            presetHash,
            currentHash: null,
            lastHash: lastHash || null
        };
    }
    const currentHash = sha256Hex(current);
    // Content equality is not ownership. An existing file must be claimed by the
    // active manifest before it can be unchanged, updated, or deleted later.
    if (!owned) {
        return { action: "conflict", presetHash, currentHash, lastHash: null };
    }
    if (currentHash === presetHash) {
        return { action: "unchanged", presetHash, currentHash, lastHash: lastHash || null };
    }
    if (lastHash && currentHash === lastHash) {
        return { action: "safe-update", presetHash, currentHash, lastHash };
    }
    return {
        action: force ? "force" : "preserve-drift",
        presetHash,
        currentHash,
        lastHash: lastHash || null
    };
}

function unownedFileConflict(relative) {
    return `An AEO-namespaced file already exists at ${relative}, but this installation cannot prove that AEO owns it. AEO does not own it. Matching content is not sufficient ownership evidence. The file was preserved.`;
}

function blockOwned(manifest, file, id) {
    return Boolean(blockRecord(manifest, file, id));
}

function unprovenOwnershipConflict(file, blockName) {
    return [
        `COLLISION: ${file} already contains ${blockName}, but no active install manifest owns it.`,
        `An existing AEO managed block was found in ${file}, but this installation cannot prove ownership of it. The block may contain user modifications. AEO will not overwrite it automatically.`,
        "Action: Preserved existing block. No overwrite performed.",
        "Possible next step: Review or remove the existing block manually if you want AEO to install a fresh managed version."
    ].join("\n");
}

function classifyBlock({ currentText, begin, end, body, lastHash, owned, force }) {
    const planned = nextManaged(currentText, begin, end, body);
    if (planned.state === "malformed") {
        return { action: "malformed", kind: "malformed", planned, nextHash: null, lastHash: lastHash || null };
    }
    const nextHash = hashInnerText(planned.next, begin, end);
    const currentHash = hashInnerText(currentText, begin, end);
    if (currentText === null || planned.state === "absent") {
        return {
            action: planned.changed ? "write" : "unchanged",
            kind: planned.changed ? "append" : "unchanged",
            planned,
            nextHash,
            currentHash,
            lastHash: lastHash || null
        };
    }
    // Markers are not ownership. A matching preset hash is not ownership either.
    if (!owned) {
        return {
            action: "collision",
            kind: "ownership-unknown",
            planned,
            nextHash,
            currentHash,
            lastHash: null
        };
    }
    if (currentHash === nextHash) {
        return { action: "unchanged", kind: "unchanged", planned, nextHash, currentHash, lastHash: lastHash || null };
    }
    if (lastHash && currentHash === lastHash) {
        return { action: "write", kind: "safe-update", planned, nextHash, currentHash, lastHash };
    }
    return {
        action: force ? "write" : "preserve",
        kind: force ? "force" : "preserve",
        planned,
        nextHash,
        currentHash,
        lastHash: lastHash || null
    };
}

function assertInside(root, file) {
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Refusing to write outside the target project: ${file}`);
    }
}

export function codexConfigBlock(bridgeIndex, target) {
    const bridge = toPosix(bridgeIndex);
    const agent = (name) => toPosix(path.join(target, ".codex", "agents", name));
    const sections = [
        "# AEO-owned project config. It does not set model, effort, sandbox, approval, or trust.",
        "",
        "[mcp_servers.aeo-antigravity]",
        'command = "node"',
        `args = ["${bridge}"]`,
        "enabled = true",
        'enabled_tools = ["delegate_antigravity"]',
        "startup_timeout_sec = 30",
        "tool_timeout_sec = 1200",
        'default_tools_approval_mode = "approve"',
        ""
    ];
    for (const [fileName, role, description] of CODEX_AGENTS) {
        sections.push(
            `[agents.${role}]`,
            "description = \"\"\"",
            description,
            "\"\"\"",
            `config_file = "${agent(fileName)}"`,
            ""
        );
    }
    return sections.join("\n").trim();
}

export function mcpEntry(bridgeIndex) {
    return {
        type: "stdio",
        command: "node",
        args: [toPosix(bridgeIndex)]
    };
}

function presetPaths(repoRoot) {
    return {
        codexBlock: path.join(repoRoot, "presets", "codex", "orchestration-block.md"),
        claudeRule: path.join(repoRoot, "presets", "claude", "rules", "aeo-orchestration.md"),
        codexAgents: path.join(repoRoot, "presets", "codex", "agents"),
        claudeAgents: path.join(repoRoot, "presets", "claude", "agents"),
        bridge: path.join(repoRoot, "bridge", "antigravity-mcp")
    };
}

async function loadManifest(target) {
    const file = path.join(target, ".aeo", "install-manifest.json");
    const text = await readText(file);
    if (text === null) {
        return null;
    }
    return JSON.parse(text);
}

async function ownedPresetFiles(presets, options) {
    const items = [{ relative: GITIGNORE_RELATIVE, preset: Buffer.from(GITIGNORE_TEXT) }];
    if (options.codex) {
        for (const [fileName] of CODEX_AGENTS) {
            items.push({
                relative: toPosix(path.join(".codex", "agents", fileName)),
                preset: await readFile(path.join(presets.codexAgents, fileName))
            });
        }
    }
    if (options.claude) {
        items.push({
            relative: ".claude/rules/aeo-orchestration.md",
            preset: await readFile(presets.claudeRule)
        });
        for (const fileName of CLAUDE_AGENTS) {
            items.push({
                relative: toPosix(path.join(".claude", "agents", fileName)),
                preset: await readFile(path.join(presets.claudeAgents, fileName))
            });
        }
    }
    for (const fileName of BRIDGE_FILES) {
        items.push({
            relative: `${BRIDGE_DIR}/${toPosix(fileName)}`,
            preset: await readFile(path.join(presets.bridge, fileName))
        });
    }
    return items;
}

function owns(manifest, file, entryPath) {
    if (!manifest) {
        return false;
    }
    return (manifest.mergedEntries || []).some((entry) => entry.file === file && entry.path === entryPath);
}

function collisionTables(text) {
    const markers = analyzeMarkers(text, CONFIG_BEGIN, CONFIG_END);
    if (markers.state === "malformed") {
        return { malformed: true, tables: [] };
    }
    const outside = tomlTablesOutside(text);
    return {
        malformed: false,
        tables: outside.filter((table) => CODEX_TABLES.includes(table))
    };
}

function noteManagedPlan(decision, label, relative, buckets) {
    if (decision.kind === "preserve") {
        buckets.userModified.push(label);
        return;
    }
    if (decision.kind === "force") {
        buckets.forceOverwrite.push(label);
        buckets.backups.push(relative);
        return;
    }
    if (decision.kind === "safe-update") {
        buckets.safeUpdate.push(label);
        buckets.backups.push(relative);
        buckets.merge.push(relative === "AGENTS.md"
            ? "AGENTS.md orchestration block (update interior only)"
            : ".codex/config.toml AEO block");
        return;
    }
    if (decision.action === "write") {
        buckets.merge.push(decision.planned.state === "present"
            ? (relative === "AGENTS.md"
                ? "AGENTS.md orchestration block (update interior only)"
                : ".codex/config.toml AEO block")
            : (relative === "AGENTS.md"
                ? "AGENTS.md orchestration block"
                : ".codex/config.toml AEO block"));
        buckets.backups.push(relative);
        return;
    }
    buckets.unchanged.push(label);
}

export async function planInstall(options) {
    const target = path.resolve(options.target);
    const repoRoot = options.repoRoot || defaultRepoRoot();
    const presets = presetPaths(repoRoot);
    const info = await stat(target);
    if (!info.isDirectory()) {
        throw new Error(`Target is not a directory: ${target}`);
    }
    if (!options.codex && !options.claude) {
        throw new Error("Pass --codex, --claude, or both. AEO does not guess which tools to configure.");
    }

    const manifest = await loadManifest(target);
    if (manifest && manifest.schemaVersion !== 1 && manifest.schemaVersion !== SCHEMA_VERSION) {
        throw new Error("Unsupported AEO manifest schema. Installation stopped.");
    }
    if (manifest && manifest.projectId && manifest.projectId !== projectId(target)) {
        throw new Error("The AEO manifest belongs to a different project path. Installation stopped.");
    }
    const bridgeIndex = path.join(target, ".aeo", "bridge", "antigravity-mcp", "index.js");
    const force = Boolean(options.forceManagedUpdate);
    const conflicts = [];
    const create = [];
    const preserve = [];
    const merge = [];
    const backups = [];
    const notes = [];
    const unchanged = [];
    const safeUpdate = [];
    const userModified = [];
    const forceOverwrite = [];
    const recreate = [];
    const ownershipUnknown = [];
    const unownedFiles = [];
    const buckets = { merge, backups, unchanged, safeUpdate, userModified, forceOverwrite };

    if (options.codex) {
        const agentsFile = path.join(target, "AGENTS.md");
        const agentsText = await readText(agentsFile);
        const agentsBody = await readFile(presets.codexBlock, "utf8");
        const agentsRecord = blockRecord(manifest, "AGENTS.md", "AEO_ORCHESTRATION");
        const agentsDecision = classifyBlock({
            currentText: agentsText,
            begin: AGENTS_BEGIN,
            end: AGENTS_END,
            body: agentsBody,
            lastHash: agentsRecord?.sha256 || null,
            owned: blockOwned(manifest, "AGENTS.md", "AEO_ORCHESTRATION"),
            force
        });
        if (agentsDecision.action === "malformed") {
            conflicts.push("AGENTS.md has partial or repeated AEO markers. Installation stopped.");
        } else if (agentsDecision.action === "collision") {
            ownershipUnknown.push(BLOCK_LABELS.AEO_ORCHESTRATION);
            conflicts.push(unprovenOwnershipConflict("AGENTS.md", "an AEO orchestration block"));
        } else if (agentsText === null) {
            create.push("AGENTS.md");
            merge.push("AGENTS.md orchestration block");
        } else {
            preserve.push("AGENTS.md");
            noteManagedPlan(agentsDecision, BLOCK_LABELS.AEO_ORCHESTRATION, "AGENTS.md", buckets);
        }

        const configFile = path.join(target, ".codex", "config.toml");
        const configText = await readText(configFile);
        const configBody = codexConfigBlock(bridgeIndex, target);
        const configRecord = blockRecord(manifest, ".codex/config.toml", "AEO_CONFIG");
        const configDecision = classifyBlock({
            currentText: configText,
            begin: CONFIG_BEGIN,
            end: CONFIG_END,
            body: configBody,
            lastHash: configRecord?.sha256 || null,
            owned: blockOwned(manifest, ".codex/config.toml", "AEO_CONFIG"),
            force
        });
        if (configText !== null) {
            const found = collisionTables(configText);
            if (found.malformed || configDecision.action === "malformed") {
                conflicts.push(".codex/config.toml has partial or repeated AEO markers. Installation stopped.");
            } else if (found.tables.length > 0) {
                conflicts.push(`AEO table already exists outside the managed block: ${found.tables.join(", ")}. Installation stopped.`);
            } else if (configDecision.action === "collision") {
                ownershipUnknown.push(BLOCK_LABELS.AEO_CONFIG);
                conflicts.push(unprovenOwnershipConflict(".codex/config.toml", "an AEO managed configuration block"));
            } else {
                preserve.push(".codex/config.toml");
                noteManagedPlan(configDecision, BLOCK_LABELS.AEO_CONFIG, ".codex/config.toml", buckets);
            }
        } else {
            create.push(".codex/config.toml");
            merge.push(".codex/config.toml AEO block");
        }
        notes.push(TRUST_NOTE);
    }

    if (options.claude) {
        const claudeFile = path.join(target, "CLAUDE.md");
        if (await exists(claudeFile)) {
            preserve.push("CLAUDE.md");
        }

        const mcpFile = path.join(target, ".mcp.json");
        const mcpText = await readText(mcpFile);
        if (mcpText === null) {
            create.push(".mcp.json");
            merge.push(".mcp.json mcpServers.aeo-antigravity");
        } else {
            let parsed;
            try {
                parsed = JSON.parse(mcpText);
            } catch {
                conflicts.push(".mcp.json is not valid JSON. Installation stopped.");
                parsed = null;
            }
            if (parsed) {
                if (parsed.mcpServers !== undefined && (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null || Array.isArray(parsed.mcpServers))) {
                    conflicts.push(".mcp.json mcpServers is not an object. Installation stopped.");
                } else {
                    const servers = parsed.mcpServers || {};
                    const entry = mcpEntry(bridgeIndex);
                    if (Object.hasOwn(servers, MCP_ID) && !owns(manifest, ".mcp.json", "mcpServers.aeo-antigravity")) {
                        conflicts.push(".mcp.json already has mcpServers.aeo-antigravity and AEO does not own it. Installation stopped.");
                    } else if (!Object.hasOwn(servers, MCP_ID) || JSON.stringify(servers[MCP_ID]) !== JSON.stringify(entry)) {
                        preserve.push(".mcp.json");
                        backups.push(".mcp.json");
                        merge.push(".mcp.json mcpServers.aeo-antigravity");
                    } else {
                        preserve.push(".mcp.json");
                    }
                }
            }
        }

        const settingsFile = path.join(target, ".claude", "settings.local.json");
        const settingsText = await readText(settingsFile);
        if (settingsText === null) {
            create.push(".claude/settings.local.json");
            merge.push(".claude/settings.local.json AEO permission");
        } else {
            try {
                const parsed = JSON.parse(settingsText);
                const allow = parsed?.permissions?.allow;
                if (allow !== undefined && !Array.isArray(allow)) {
                    conflicts.push(".claude/settings.local.json permissions.allow is not an array. Installation stopped.");
                } else if (Array.isArray(allow) && allow.includes(PERMISSION)) {
                    preserve.push(".claude/settings.local.json");
                } else {
                    preserve.push(".claude/settings.local.json");
                    backups.push(".claude/settings.local.json");
                    merge.push(".claude/settings.local.json AEO permission");
                }
            } catch {
                conflicts.push(".claude/settings.local.json is not valid JSON. Installation stopped.");
            }
        }
    }

    for (const item of await ownedPresetFiles(presets, options)) {
        const current = await readBytes(path.join(target, item.relative));
        const decision = classifyOwned({
            current,
            preset: item.preset,
            owned: manifestOwnsFile(manifest, item.relative),
            lastHash: lastInstalledHash(manifest, item.relative),
            force
        });
        if (decision.action === "create") {
            create.push(item.relative);
        } else if (decision.action === "recreate") {
            recreate.push(item.relative);
        } else if (decision.action === "unchanged") {
            unchanged.push(item.relative);
        } else if (decision.action === "safe-update") {
            safeUpdate.push(item.relative);
        } else if (decision.action === "force") {
            forceOverwrite.push(item.relative);
            backups.push(item.relative);
        } else if (decision.action === "preserve-drift") {
            userModified.push(item.relative);
        } else if (decision.action === "conflict") {
            unownedFiles.push(item.relative);
            conflicts.push(unownedFileConflict(item.relative));
        }
    }

    return {
        target,
        bridgeIndex,
        presets,
        repoRoot,
        manifest,
        conflicts,
        create,
        preserve,
        merge,
        replaceOwned: safeUpdate,
        backups,
        unchanged,
        safeUpdate,
        userModified,
        forceOverwrite,
        recreate,
        ownershipUnknown,
        unownedFiles,
        forceManagedUpdate: force,
        warnings: [],
        notes
    };
}

async function backupFile(homeDir, id, stamp, target, relative) {
    const source = path.join(target, relative);
    const destination = path.join(homeDir, ".aeo", "backups", id, stamp, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
    return destination;
}

export { defaultNpmCi };

async function applyOwned({
    target,
    relative,
    preset,
    manifest,
    force,
    homeDir,
    id,
    when,
    backupFiles,
    changed,
    writeImpl
}) {
    const file = path.join(target, relative);
    assertInside(target, file);
    const posix = toPosix(relative);
    const current = await readBytes(file);
    const decision = classifyOwned({
        current,
        preset,
        owned: manifestOwnsFile(manifest, posix),
        lastHash: lastInstalledHash(manifest, posix),
        force
    });
    if (decision.action === "conflict") {
        throw new Error(unownedFileConflict(posix));
    }
    if (decision.action === "preserve-drift") {
        return { path: posix, sha256: decision.lastHash || undefined, wrote: false };
    }
    if (decision.action === "unchanged") {
        return { path: posix, sha256: decision.currentHash, wrote: false };
    }
    if (decision.action === "force") {
        backupFiles.push(await backupFile(homeDir, id, when, target, posix));
    }
    await writeAtomic(file, preset, writeImpl);
    const written = await readBytes(file);
    if (written === null) {
        throw new Error(`Write did not produce ${posix}. The install manifest was not updated for this file.`);
    }
    changed.push(posix);
    return { path: posix, sha256: sha256Hex(written), wrote: true };
}

async function deployBridge(items, context, npmCi) {
    let copied = false;
    const entries = [];
    for (const item of items) {
        const entry = await applyOwned({ ...context, relative: item.relative, preset: item.preset });
        entries.push(entry);
        if (entry.wrote) {
            copied = true;
        }
    }
    const destination = path.dirname(context.bridgeIndex);
    const modules = path.join(destination, "node_modules");
    if (copied || !(await exists(modules))) {
        await npmCi(destination);
        if (!(await exists(modules))) {
            throw new Error("npm ci finished without installing bridge dependencies. MCP configuration was not activated.");
        }
    }
    return entries;
}

function stamp() {
    return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function install(options) {
    const plan = await planInstall(options);
    const dryRun = Boolean(options.dryRun);
    if (plan.conflicts.length > 0) {
        return { ok: false, dryRun, wrote: false, ...plan, changed: [], backupFiles: [], warnings: [] };
    }
    if (dryRun) {
        return { ok: true, dryRun: true, wrote: false, ...plan, changed: [], backupFiles: [], warnings: [] };
    }

    const homeDir = options.homeDir || os.homedir();
    const npmCi = options.npmCi || defaultNpmCi;
    const writeImpl = options.writeFile || null;
    const id = projectId(plan.target);
    const when = stamp();
    const changed = [];
    const backupFiles = [];
    const warnings = [];
    const created = new Set(plan.manifest?.createdFiles || []);
    const force = Boolean(options.forceManagedUpdate);
    const ownedContext = {
        target: plan.target,
        manifest: plan.manifest,
        force,
        homeDir,
        id,
        when,
        backupFiles,
        changed,
        writeImpl,
        bridgeIndex: plan.bridgeIndex
    };
    const ownedItems = await ownedPresetFiles(plan.presets, options);
    const bridgeItems = ownedItems.filter((item) => item.relative.startsWith(`${BRIDGE_DIR}/`));
    const otherItems = ownedItems.filter((item) => !item.relative.startsWith(`${BRIDGE_DIR}/`));
    let bridgeEntries = [];
    try {
        bridgeEntries = await deployBridge(bridgeItems, ownedContext, npmCi);
    } catch (error) {
        if (await exists(plan.bridgeIndex)) {
            changed.push(".aeo/bridge/antigravity-mcp");
        }
        const detail = error instanceof Error ? error.message : String(error);
        const recovery = plan.manifest
            ? ""
            : " Files copied before the manifest was saved are not owned. Matching content is not ownership. The next install reports a collision and does not adopt them. Inspect those files and remove them manually if that is safe.";
        return {
            ok: false,
            dryRun: false,
            wrote: changed.length > 0,
            ...plan,
            changed,
            backupFiles,
            warnings,
            error: `${detail}${recovery}`
        };
    }

    let claimMcp = false;
    let claimPermission = false;
    const installed = [...bridgeEntries];
    const blocks = [];
    try {
        if (options.codex) {
            const block = await readFile(plan.presets.codexBlock, "utf8");
            blocks.push(await applyTextMerge({
                target: plan.target,
                relative: "AGENTS.md",
                begin: AGENTS_BEGIN,
                end: AGENTS_END,
                blockId: "AEO_ORCHESTRATION",
                body: block,
                manifest: plan.manifest,
                force,
                homeDir,
                id,
                when,
                backupFiles,
                changed,
                created,
                writeImpl
            }));
            blocks.push(await applyTextMerge({
                target: plan.target,
                relative: path.join(".codex", "config.toml"),
                begin: CONFIG_BEGIN,
                end: CONFIG_END,
                blockId: "AEO_CONFIG",
                body: codexConfigBlock(plan.bridgeIndex, plan.target),
                manifest: plan.manifest,
                force,
                homeDir,
                id,
                when,
                backupFiles,
                changed,
                created,
                writeImpl
            }));
        }

        for (const item of otherItems) {
            installed.push(await applyOwned({ ...ownedContext, relative: item.relative, preset: item.preset }));
        }

        if (options.claude) {
            claimMcp = await mergeMcp({
                target: plan.target,
                bridgeIndex: plan.bridgeIndex,
                manifest: plan.manifest,
                homeDir,
                id,
                when,
                backupFiles,
                changed,
                created,
                warnings,
                writeImpl
            });
            claimPermission = await mergePermission({
                target: plan.target,
                manifest: plan.manifest,
                homeDir,
                id,
                when,
                backupFiles,
                changed,
                created,
                warnings,
                writeImpl
            });
        }

        const manifest = combineManifest(plan.manifest, buildManifest({
            id,
            codex: options.codex,
            claude: options.claude,
            created: [...created],
            claimMcp,
            claimPermission,
            installed,
            blocks
        }));
        const manifestPath = path.join(plan.target, ".aeo", "install-manifest.json");
        const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
        if (await readText(manifestPath) !== manifestText) {
            try {
                await writeAtomic(manifestPath, manifestText, writeImpl);
                changed.push(".aeo/install-manifest.json");
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                const recovery = plan.manifest
                    ? "The previous manifest still owns the files it already recorded, and those recorded hashes were not updated. Run install again to reconcile the owned files."
                    : "No install manifest was saved, so the copied files are not owned. Matching content is not ownership. Inspect them, remove them manually if that is safe, and run install again. AEO will not adopt them.";
                return {
                    ok: false,
                    dryRun: false,
                    wrote: changed.length > 0,
                    ...plan,
                    changed,
                    backupFiles,
                    warnings,
                    manifest,
                    error: `Installation is incomplete. Some AEO files may already have been copied, but .aeo/install-manifest.json was not saved. ${recovery} Backups, if any, were not restored automatically. ${detail}`
                };
            }
        }
        return {
            ok: true,
            dryRun: false,
            wrote: changed.length > 0,
            ...plan,
            changed,
            backupFiles,
            warnings,
            manifest
        };
    } catch (error) {
        return {
            ok: false,
            dryRun: false,
            wrote: changed.length > 0,
            ...plan,
            changed,
            backupFiles,
            warnings,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

async function applyTextMerge({
    target,
    relative,
    begin,
    end,
    blockId,
    body,
    manifest,
    force,
    homeDir,
    id,
    when,
    backupFiles,
    changed,
    created,
    writeImpl
}) {
    const file = path.join(target, relative);
    assertInside(target, file);
    const posix = toPosix(relative);
    const current = await readText(file);
    const record = blockRecord(manifest, posix, blockId);
    const decision = classifyBlock({
        currentText: current,
        begin,
        end,
        body,
        lastHash: record?.sha256 || null,
        owned: Boolean(record),
        force
    });
    if (decision.action === "malformed") {
        throw new Error(`Malformed AEO markers in ${posix}. Refusing to rewrite it.`);
    }
    if (decision.action === "collision") {
        const blockName = blockId === "AEO_CONFIG"
            ? "an AEO managed configuration block"
            : "an AEO orchestration block";
        throw new Error(unprovenOwnershipConflict(posix, blockName));
    }
    if (decision.action === "preserve") {
        return { file: posix, id: blockId, sha256: decision.lastHash || undefined };
    }
    if (decision.action === "unchanged") {
        return { file: posix, id: blockId, sha256: decision.nextHash || undefined };
    }
    if (current === null) {
        created.add(posix);
    } else {
        backupFiles.push(await backupFile(homeDir, id, when, target, relative));
    }
    await writeAtomic(file, decision.planned.next, writeImpl);
    changed.push(posix);
    const written = await readText(file);
    return { file: posix, id: blockId, sha256: hashInnerText(written, begin, end) || undefined };
}

async function mergeMcp({
    target,
    bridgeIndex,
    manifest,
    homeDir,
    id,
    when,
    backupFiles,
    changed,
    created,
    warnings,
    writeImpl
}) {
    const relative = ".mcp.json";
    const file = path.join(target, relative);
    const current = await readText(file);
    const entry = mcpEntry(bridgeIndex);
    let parsed = { mcpServers: {} };
    if (current !== null) {
        parsed = JSON.parse(current);
        if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) {
            parsed.mcpServers = {};
        }
        if (Object.hasOwn(parsed.mcpServers, MCP_ID) && !owns(manifest, relative, "mcpServers.aeo-antigravity")) {
            throw new Error("Refusing to overwrite an unowned aeo-antigravity MCP server.");
        }
        if (JSON.stringify(parsed.mcpServers[MCP_ID]) === JSON.stringify(entry)) {
            return true;
        }
        if (Object.hasOwn(parsed.mcpServers, MCP_ID)) {
            warnings.push("Updating the AEO-owned aeo-antigravity MCP entry.");
        }
    }
    parsed.mcpServers[MCP_ID] = entry;
    const next = `${JSON.stringify(parsed, null, 2)}\n`;
    if (current === next) {
        return true;
    }
    if (current === null) {
        created.add(relative);
    } else {
        backupFiles.push(await backupFile(homeDir, id, when, target, relative));
    }
    await writeAtomic(file, next, writeImpl);
    changed.push(relative);
    return true;
}

async function mergePermission({
    target,
    manifest,
    homeDir,
    id,
    when,
    backupFiles,
    changed,
    created,
    warnings,
    writeImpl
}) {
    const relative = path.join(".claude", "settings.local.json");
    const file = path.join(target, relative);
    const current = await readText(file);
    let parsed = { permissions: { allow: [] } };
    if (current !== null) {
        parsed = JSON.parse(current);
    }
    if (!parsed.permissions || typeof parsed.permissions !== "object" || Array.isArray(parsed.permissions)) {
        if (current !== null && parsed.permissions !== undefined) {
            throw new Error(".claude/settings.local.json permissions is not an object. Installation stopped.");
        }
        parsed.permissions = {};
    }
    if (parsed.permissions.allow === undefined) {
        parsed.permissions.allow = [];
    }
    if (!Array.isArray(parsed.permissions.allow)) {
        throw new Error(".claude/settings.local.json permissions.allow is not an array. Installation stopped.");
    }
    const already = parsed.permissions.allow.includes(PERMISSION);
    const owned = owns(manifest, ".claude/settings.local.json", "permissions.allow");
    if (already && !owned && current !== null) {
        warnings.push("The AEO permission is already present and was not added by a previous AEO manifest. AEO will not claim it.");
        return false;
    }
    if (already) {
        return true;
    }
    parsed.permissions.allow.push(PERMISSION);
    const next = `${JSON.stringify(parsed, null, 2)}\n`;
    if (current === null) {
        created.add(toPosix(relative));
    } else {
        backupFiles.push(await backupFile(homeDir, id, when, target, relative));
    }
    await writeAtomic(file, next, writeImpl);
    changed.push(toPosix(relative));
    return true;
}

function unique(values) {
    return [...new Set(values)];
}

function mergeInstalled(previous, next) {
    const map = new Map();
    const add = (entry) => {
        if (!entry?.path || entry.path === BRIDGE_DIR) {
            return;
        }
        const current = map.get(entry.path);
        const sha256 = entry.sha256 || current?.sha256 || null;
        map.set(entry.path, sha256 ? { path: entry.path, sha256 } : { path: entry.path });
    };
    for (const entry of installedEntries(previous)) {
        add(entry);
    }
    for (const entry of installedEntries({ installedFiles: next })) {
        add(entry);
    }
    return [...map.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function mergeBlocks(previous, next) {
    const map = new Map();
    const add = (block) => {
        const key = `${block.file}\0${block.id}`;
        const current = map.get(key);
        const sha256 = block.sha256 || current?.sha256 || null;
        map.set(key, sha256
            ? { file: block.file, id: block.id, sha256 }
            : { file: block.file, id: block.id });
    };
    for (const block of previous?.managedBlocks || []) {
        add(block);
    }
    for (const block of next || []) {
        add(block);
    }
    return [...map.values()];
}

function combineManifest(previous, next) {
    const entries = new Map();
    for (const entry of [...(previous?.mergedEntries || []), ...(next.mergedEntries || [])]) {
        entries.set(`${entry.file}\0${entry.path}`, entry);
    }
    return {
        schemaVersion: SCHEMA_VERSION,
        aeoVersion: AEO_VERSION,
        projectId: next.projectId,
        targets: unique([...(previous?.targets || []), ...(next.targets || [])]),
        createdFiles: unique([...(previous?.createdFiles || []), ...(next.createdFiles || [])]),
        installedFiles: mergeInstalled(previous, next.installedFiles),
        managedBlocks: mergeBlocks(previous, next.managedBlocks),
        mergedEntries: [...entries.values()]
    };
}

function buildManifest({ id, codex, claude, created, claimMcp, claimPermission, installed, blocks }) {
    const mergedEntries = [];
    const targets = [];
    if (codex) {
        targets.push("codex");
    }
    if (claude) {
        targets.push("claude");
        if (claimMcp) {
            mergedEntries.push({ file: ".mcp.json", path: "mcpServers.aeo-antigravity" });
        }
        if (claimPermission) {
            mergedEntries.push({
                file: ".claude/settings.local.json",
                path: "permissions.allow",
                value: PERMISSION
            });
        }
    }
    return {
        schemaVersion: SCHEMA_VERSION,
        aeoVersion: AEO_VERSION,
        projectId: id,
        targets,
        createdFiles: created,
        installedFiles: installed,
        managedBlocks: blocks,
        mergedEntries
    };
}

function expandOwned(manifest) {
    const map = new Map();
    for (const entry of installedEntries(manifest)) {
        if (entry.path === BRIDGE_DIR) {
            for (const fileName of BRIDGE_FILES) {
                const posix = `${BRIDGE_DIR}/${toPosix(fileName)}`;
                if (!map.has(posix)) {
                    map.set(posix, { path: posix, sha256: null });
                }
            }
            continue;
        }
        map.set(entry.path, entry);
    }
    return [...map.values()];
}

async function presetBytes(repoRoot, relative) {
    if (relative === GITIGNORE_RELATIVE) {
        return Buffer.from(GITIGNORE_TEXT);
    }
    if (relative.startsWith(`${BRIDGE_DIR}/`)) {
        return readFile(path.join(repoRoot, "bridge", "antigravity-mcp", relative.slice(BRIDGE_DIR.length + 1)));
    }
    if (relative.startsWith(".codex/agents/")) {
        return readFile(path.join(repoRoot, "presets", "codex", "agents", path.posix.basename(relative)));
    }
    if (relative.startsWith(".claude/agents/")) {
        return readFile(path.join(repoRoot, "presets", "claude", "agents", path.posix.basename(relative)));
    }
    if (relative === ".claude/rules/aeo-orchestration.md") {
        return readFile(path.join(repoRoot, "presets", "claude", "rules", "aeo-orchestration.md"));
    }
    return null;
}

async function legacyBlockMatches(target, block, text, repoRoot) {
    const begin = block.id === "AEO_CONFIG" ? CONFIG_BEGIN : AGENTS_BEGIN;
    const end = block.id === "AEO_CONFIG" ? CONFIG_END : AGENTS_END;
    const body = block.id === "AEO_CONFIG"
        ? codexConfigBlock(path.join(target, ".aeo", "bridge", "antigravity-mcp", "index.js"), target)
        : await readFile(path.join(repoRoot, "presets", "codex", "orchestration-block.md"), "utf8");
    const planned = nextManaged(text, begin, end, body);
    if (planned.state !== "present" && planned.state !== "absent") {
        return false;
    }
    return hashInnerText(text, begin, end) === hashInnerText(planned.next, begin, end);
}

async function considerRemove(target, entry, repoRoot, forceRemove, changed, preserved) {
    const file = path.join(target, entry.path);
    assertInside(target, file);
    const current = await readBytes(file);
    if (current === null) {
        return "absent";
    }
    const currentHash = sha256Hex(current);
    let drifted = true;
    if (entry.sha256) {
        drifted = currentHash !== entry.sha256;
    } else {
        let preset = null;
        try {
            preset = await presetBytes(repoRoot, entry.path);
        } catch (error) {
            if (!error || error.code !== "ENOENT") {
                throw error;
            }
        }
        drifted = preset === null || currentHash !== sha256Hex(preset);
    }
    if (drifted && !forceRemove) {
        preserved.push(entry.path);
        return "preserved";
    }
    await rm(file, { force: true });
    changed.push(`deleted ${entry.path}`);
    return "deleted";
}

async function removeManagedBlock(target, block, repoRoot, forceRemove, changed, preserved, createdFiles) {
    const file = path.join(target, block.file);
    const current = await readText(file);
    if (current === null) {
        return;
    }
    const begin = block.id === "AEO_CONFIG" ? CONFIG_BEGIN : AGENTS_BEGIN;
    const end = block.id === "AEO_CONFIG" ? CONFIG_END : AGENTS_END;
    if (analyzeMarkers(current, begin, end).state !== "present") {
        return;
    }
    const currentHash = hashInnerText(current, begin, end);
    const drifted = block.sha256
        ? currentHash !== block.sha256
        : !(await legacyBlockMatches(target, block, current, repoRoot));
    if (drifted && !forceRemove) {
        preserved.push(BLOCK_LABELS[block.id] || `${toPosix(block.file)} ${block.id}`);
        return;
    }
    const next = removeManaged(current, begin, end);
    const empty = next.trim() === "";
    const createdByAeo = (createdFiles || []).includes(toPosix(block.file));
    if (empty && createdByAeo) {
        await rm(file, { force: true });
        changed.push(`deleted ${toPosix(block.file)}`);
        return;
    }
    if (next !== current) {
        await writeAtomic(file, next.endsWith("\n") || next.length === 0 ? next : `${next}\n`);
        changed.push(`updated ${toPosix(block.file)}`);
    }
}

export async function uninstall(options) {
    const target = path.resolve(options.target);
    const repoRoot = options.repoRoot || defaultRepoRoot();
    const forceRemove = Boolean(options.forceRemoveModified);
    const manifest = await loadManifest(target);
    if (!manifest) {
        return { ok: false, error: "No AEO install manifest. Refusing to guess which files to delete.", preserved: [] };
    }
    if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== SCHEMA_VERSION) {
        return { ok: false, error: "Unsupported AEO manifest schema. Uninstall stopped.", preserved: [] };
    }
    const problems = await preflightUninstall(target, manifest);
    if (problems.length > 0) {
        return { ok: false, error: problems.join(" "), changed: [], preserved: [] };
    }
    const changed = [];
    const preserved = [];
    for (const block of manifest.managedBlocks || []) {
        await removeManagedBlock(target, block, repoRoot, forceRemove, changed, preserved, manifest.createdFiles);
    }

    if ((manifest.mergedEntries || []).some((entry) => entry.file === ".mcp.json")) {
        await removeMcp(target, manifest, changed);
    }
    if ((manifest.mergedEntries || []).some((entry) => entry.file === ".claude/settings.local.json")) {
        await removePermission(target, manifest, changed);
    }
    let hadBridge = false;
    let bridgePreserved = false;
    for (const entry of expandOwned(manifest)) {
        if (entry.path === BRIDGE_DIR || entry.path.startsWith(`${BRIDGE_DIR}/`)) {
            hadBridge = true;
        }
        const outcome = await considerRemove(target, entry, repoRoot, forceRemove, changed, preserved);
        if (entry.path.startsWith(`${BRIDGE_DIR}/`) && outcome === "preserved") {
            bridgePreserved = true;
        }
    }
    if (hadBridge && !bridgePreserved) {
        const bridge = path.join(target, ".aeo", "bridge");
        if (await exists(bridge)) {
            await rm(bridge, { recursive: true, force: true });
            changed.push("deleted .aeo/bridge");
        }
    }
    await rm(path.join(target, ".aeo", "install-manifest.json"), { force: true });
    await removeIfEmpty(path.join(target, ".aeo", "bridge", "antigravity-mcp", "lib"));
    await removeIfEmpty(path.join(target, ".aeo", "bridge", "antigravity-mcp"));
    await removeIfEmpty(path.join(target, ".aeo", "bridge"));
    await removeIfEmpty(path.join(target, ".aeo"));
    await removeIfEmpty(path.join(target, ".codex", "agents"));
    await removeIfEmpty(path.join(target, ".codex"));
    await removeIfEmpty(path.join(target, ".claude", "agents"));
    await removeIfEmpty(path.join(target, ".claude", "rules"));
    await removeIfEmpty(path.join(target, ".claude"));
    return { ok: true, changed, preserved };
}

async function preflightUninstall(target, manifest) {
    const problems = [];
    for (const block of manifest.managedBlocks || []) {
        const text = await readText(path.join(target, block.file));
        if (text === null) {
            continue;
        }
        const begin = block.id === "AEO_CONFIG" ? CONFIG_BEGIN : AGENTS_BEGIN;
        const end = block.id === "AEO_CONFIG" ? CONFIG_END : AGENTS_END;
        if (analyzeMarkers(text, begin, end).state === "malformed") {
            problems.push(`${block.file} has malformed AEO markers. Uninstall stopped.`);
        }
    }
    for (const relative of [".mcp.json", ".claude/settings.local.json"]) {
        if (!(manifest.mergedEntries || []).some((entry) => entry.file === relative)) {
            continue;
        }
        const text = await readText(path.join(target, relative));
        if (text === null) {
            continue;
        }
        try {
            JSON.parse(text);
        } catch {
            problems.push(`${relative} is not valid JSON. Uninstall stopped.`);
        }
    }
    return problems;
}

async function removeMcp(target, manifest, changed) {
    const file = path.join(target, ".mcp.json");
    const current = await readText(file);
    if (current === null) {
        return;
    }
    const parsed = JSON.parse(current);
    if (parsed.mcpServers) {
        delete parsed.mcpServers[MCP_ID];
    }
    const serverCount = parsed.mcpServers ? Object.keys(parsed.mcpServers).length : 0;
    const otherKeys = Object.keys(parsed).filter((key) => key !== "mcpServers");
    const created = (manifest.createdFiles || []).includes(".mcp.json");
    if (serverCount === 0 && otherKeys.length === 0 && created) {
        await rm(file, { force: true });
        changed.push("deleted .mcp.json");
        return;
    }
    const next = `${JSON.stringify(parsed, null, 2)}\n`;
    if (next !== current) {
        await writeAtomic(file, next);
        changed.push("updated .mcp.json");
    }
}

async function removePermission(target, manifest, changed) {
    const relative = ".claude/settings.local.json";
    const file = path.join(target, relative);
    const current = await readText(file);
    if (current === null) {
        return;
    }
    if (!(manifest.mergedEntries || []).some((entry) => entry.value === PERMISSION)) {
        return;
    }
    const parsed = JSON.parse(current);
    if (parsed.permissions && Array.isArray(parsed.permissions.allow)) {
        parsed.permissions.allow = parsed.permissions.allow.filter((entry) => entry !== PERMISSION);
    }
    const allow = parsed.permissions?.allow || [];
    const otherPermissionKeys = parsed.permissions
        ? Object.keys(parsed.permissions).filter((key) => key !== "allow")
        : [];
    const otherTop = Object.keys(parsed).filter((key) => key !== "permissions");
    const created = (manifest.createdFiles || []).includes(relative);
    const emptyAllow = allow.length === 0;
    const emptyPermissions = emptyAllow && otherPermissionKeys.length === 0;
    if (emptyPermissions && otherTop.length === 0 && created) {
        await rm(file, { force: true });
        changed.push(`deleted ${relative}`);
        return;
    }
    const next = `${JSON.stringify(parsed, null, 2)}\n`;
    if (next !== current) {
        await writeAtomic(file, next);
        changed.push(`updated ${relative}`);
    }
}

async function removeIfEmpty(directory) {
    let entries = [];
    try {
        entries = await readdir(directory);
    } catch {
        return;
    }
    if (entries.length === 0) {
        await rm(directory, { recursive: true, force: true });
    }
}

function wholeFileCandidates() {
    return [
        GITIGNORE_RELATIVE,
        ...CODEX_AGENTS.map(([fileName]) => toPosix(path.join(".codex", "agents", fileName))),
        ".claude/rules/aeo-orchestration.md",
        ...CLAUDE_AGENTS.map((fileName) => toPosix(path.join(".claude", "agents", fileName))),
        ...BRIDGE_FILES.map((fileName) => `${BRIDGE_DIR}/${toPosix(fileName)}`)
    ];
}

async function fileOwnership(target, manifest, relative) {
    const bytes = await readBytes(path.join(target, relative));
    const owned = manifestOwnsFile(manifest, relative);
    if (bytes === null) {
        return { path: relative, state: owned ? "missing" : "absent" };
    }
    if (!owned) {
        return { path: relative, state: "unowned" };
    }
    const lastHash = lastInstalledHash(manifest, relative);
    if (!lastHash) {
        return { path: relative, state: "owned" };
    }
    return {
        path: relative,
        state: sha256Hex(bytes) === lastHash ? "owned-unchanged" : "owned-drifted"
    };
}

async function blockOwnership(target, manifest, file, id, begin, end) {
    const text = await readText(path.join(target, file));
    const present = Boolean(text) && analyzeMarkers(text, begin, end).state === "present";
    const record = blockRecord(manifest, file, id);
    const row = { path: file, id, state: "absent" };
    if (!present) {
        row.state = record ? "missing" : "absent";
        return row;
    }
    if (!record) {
        row.state = "unowned";
        return row;
    }
    if (!record.sha256) {
        row.state = "owned";
        return row;
    }
    const hash = hashInnerText(text, begin, end);
    row.state = hash === record.sha256 ? "owned-unchanged" : "owned-drifted";
    return row;
}

async function ownershipReport(target, manifest) {
    const rows = [];
    for (const relative of wholeFileCandidates()) {
        rows.push(await fileOwnership(target, manifest, relative));
    }
    rows.push(await blockOwnership(target, manifest, "AGENTS.md", "AEO_ORCHESTRATION", AGENTS_BEGIN, AGENTS_END));
    rows.push(await blockOwnership(target, manifest, ".codex/config.toml", "AEO_CONFIG", CONFIG_BEGIN, CONFIG_END));
    return rows;
}

export async function status(options) {
    const target = path.resolve(options.target);
    const manifest = await loadManifest(target);
    const homeDir = options.homeDir || os.homedir();
    const report = {
        installed: Boolean(manifest),
        manifest,
        ownership: await ownershipReport(target, manifest),
        codex: {},
        claude: {},
        bridge: {},
        trustNote: TRUST_NOTE
    };
    const agents = await readText(path.join(target, "AGENTS.md"));
    const config = await readText(path.join(target, ".codex", "config.toml"));
    report.codex = {
        orchestrationBlock: analyzeMarkers(agents || "", AGENTS_BEGIN, AGENTS_END).state === "present",
        configBlock: analyzeMarkers(config || "", CONFIG_BEGIN, CONFIG_END).state === "present",
        agents: await Promise.all(CODEX_AGENTS.map(async ([fileName]) => exists(path.join(target, ".codex", "agents", fileName)))),
        server: Boolean(config && config.includes("[mcp_servers.aeo-antigravity]"))
    };
    report.claude = {
        rule: await exists(path.join(target, ".claude", "rules", "aeo-orchestration.md")),
        agents: await Promise.all(CLAUDE_AGENTS.map(async (fileName) => exists(path.join(target, ".claude", "agents", fileName)))),
        server: false,
        permission: false
    };
    const mcpText = await readText(path.join(target, ".mcp.json"));
    if (mcpText) {
        try {
            const parsed = JSON.parse(mcpText);
            report.claude.server = Boolean(parsed.mcpServers && parsed.mcpServers[MCP_ID]);
        } catch {
            report.claude.server = false;
        }
    }
    const settingsText = await readText(path.join(target, ".claude", "settings.local.json"));
    if (settingsText) {
        try {
            const parsed = JSON.parse(settingsText);
            report.claude.permission = Boolean(parsed.permissions?.allow?.includes(PERMISSION));
        } catch {
            report.claude.permission = false;
        }
    }
    const bridgeIndex = path.join(target, ".aeo", "bridge", "antigravity-mcp", "index.js");
    report.bridge = {
        filesPresent: await exists(bridgeIndex),
        dependenciesInstalled: await exists(path.join(target, ".aeo", "bridge", "antigravity-mcp", "node_modules")),
        agy: await agyDiscoverable()
    };
    report.trustNote = await trustNote(target, homeDir);
    return report;
}

async function trustNote(target, homeDir) {
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const text = await readText(configPath);
    if (text && text.toLowerCase().includes(toPosix(target).toLowerCase()) && text.includes("untrusted")) {
        return `${TRUST_NOTE} The user Codex config mentions this path near an untrusted marker. AEO did not change it.`;
    }
    return TRUST_NOTE;
}

async function agyDiscoverable() {
    if (process.env.AGY_BIN) {
        return exists(process.env.AGY_BIN);
    }
    const command = process.platform === "win32" ? "where.exe" : "which";
    return new Promise((resolve) => {
        const child = spawn(command, ["agy"], {
            stdio: "ignore",
            windowsHide: true,
            shell: false
        });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
    });
}

export async function doctor(options) {
    const target = path.resolve(options.target);
    const problems = [];
    const warnings = [];
    const info = await stat(target).catch(() => null);
    if (!info || !info.isDirectory()) {
        return { ok: false, problems: ["Target is not a directory."], warnings };
    }
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 20) {
        problems.push(`Node ${process.versions.node} is older than 20.`);
    }
    const agents = await readText(path.join(target, "AGENTS.md"));
    if (agents !== null) {
        const markers = analyzeMarkers(agents, AGENTS_BEGIN, AGENTS_END);
        if (markers.state === "malformed") {
            problems.push("AGENTS.md has malformed AEO markers.");
        }
    }
    const config = await readText(path.join(target, ".codex", "config.toml"));
    if (config !== null) {
        const markers = analyzeMarkers(config, CONFIG_BEGIN, CONFIG_END);
        if (markers.state === "malformed") {
            problems.push(".codex/config.toml has malformed AEO markers.");
        }
        const duplicates = duplicateTables(config);
        if (duplicates.length > 0) {
            problems.push(`Duplicate TOML tables: ${duplicates.join(", ")}`);
        }
        if (markers.state === "present") {
            for (const [fileName] of CODEX_AGENTS) {
                if (!(await exists(path.join(target, ".codex", "agents", fileName)))) {
                    problems.push(`Missing ${fileName}`);
                }
            }
            if (!config.includes("[mcp_servers.aeo-antigravity]")) {
                problems.push("Codex managed block is missing aeo-antigravity.");
            }
            if (/^(model|model_reasoning_effort|service_tier|sandbox_mode|approval_policy|notify|trust_level)\s*=/m.test(markers.inner || "")) {
                problems.push("AEO Codex block sets a user-level Codex option. That is not allowed.");
            }
            for (const match of (markers.inner || "").matchAll(/config_file\s*=\s*"([^"]+)"/g)) {
                if (!(await exists(match[1]))) {
                    problems.push(`Codex config_file does not exist: ${match[1]}`);
                }
            }
            const bridgeArg = /args\s*=\s*\[\s*"([^"]+)"/.exec(markers.inner || "");
            if (bridgeArg && !(await exists(bridgeArg[1]))) {
                problems.push("MCP config points at a missing bridge.");
            }
        }
    }
    for (const relative of [".mcp.json", path.join(".claude", "settings.local.json")]) {
        const text = await readText(path.join(target, relative));
        if (text !== null) {
            try {
                JSON.parse(text);
            } catch {
                problems.push(`${toPosix(relative)} is not valid JSON.`);
            }
        }
    }
    const bridgeIndex = path.join(target, ".aeo", "bridge", "antigravity-mcp", "index.js");
    if (!(await exists(bridgeIndex))) {
        warnings.push("Bridge entrypoint is not installed in .aeo/bridge.");
    } else if (!(await exists(path.join(path.dirname(bridgeIndex), "node_modules")))) {
        warnings.push("Bridge dependencies are not installed.");
    }
    if (!(await agyDiscoverable())) {
        warnings.push("agy was not found on PATH and AGY_BIN is unset or missing.");
    }
    const manifest = await loadManifest(target);
    if (manifest && manifest.schemaVersion !== 1 && manifest.schemaVersion !== SCHEMA_VERSION) {
        problems.push("Unsupported AEO manifest schema.");
    }
    for (const row of await ownershipReport(target, manifest)) {
        if (row.state === "unowned") {
            const label = row.id ? `${row.path} ${row.id}` : row.path;
            problems.push(`PRESENT BUT NOT OWNED: ${label} exists and the active manifest does not own it. Matching content is not ownership. AEO did not change it.`);
        }
    }
    if (manifest) {
        for (const entry of installedEntries(manifest)) {
            if (!entry.sha256 || entry.path === BRIDGE_DIR) {
                continue;
            }
            const bytes = await readBytes(path.join(target, entry.path));
            if (bytes && sha256Hex(bytes) !== entry.sha256) {
                warnings.push(`USER MODIFIED — PRESERVED: ${entry.path} differs from the hash AEO installed. A normal update will not overwrite it.`);
            }
        }
        for (const block of manifest.managedBlocks || []) {
            if (!block.sha256) {
                continue;
            }
            const text = await readText(path.join(target, block.file));
            if (text === null) {
                continue;
            }
            const begin = block.id === "AEO_CONFIG" ? CONFIG_BEGIN : AGENTS_BEGIN;
            const end = block.id === "AEO_CONFIG" ? CONFIG_END : AGENTS_END;
            const hash = hashInnerText(text, begin, end);
            if (hash && hash !== block.sha256) {
                warnings.push(`USER MODIFIED — PRESERVED: ${BLOCK_LABELS[block.id] || block.file} differs from the hash AEO installed. A normal update will not overwrite it.`);
            }
        }
    }
    return { ok: problems.length === 0, problems, warnings };
}

export function formatPlan(result) {
    const lines = [];
    lines.push(result.dryRun ? "Dry run. No files were written." : result.ok ? "Install finished." : "Install stopped.");
    for (const label of result.ownershipUnknown || []) {
        lines.push(`OWNERSHIP UNKNOWN — PRESERVED: ${label}`);
    }
    for (const file of result.unownedFiles || []) {
        lines.push(`UNOWNED EXISTING FILE — COLLISION: ${file}`);
    }
    for (const conflict of result.conflicts || []) {
        lines.push(`Conflict: ${conflict}`);
    }
    if (result.error) {
        lines.push(`Error: ${result.error}`);
    }
    for (const file of result.create || []) {
        lines.push(`Create: ${file}`);
    }
    for (const file of result.preserve || []) {
        lines.push(`Preserve: ${file}`);
    }
    for (const file of result.merge || []) {
        lines.push(`Merge: ${file}`);
    }
    for (const file of result.recreate || []) {
        lines.push(`RECREATE MISSING: ${file}`);
    }
    for (const file of result.unchanged || []) {
        lines.push(`UNCHANGED: ${file}`);
    }
    for (const file of result.safeUpdate || []) {
        lines.push(`SAFE UPDATE: ${file}`);
    }
    for (const file of result.userModified || []) {
        lines.push(`USER MODIFIED — PRESERVED: ${file}`);
        if (!result.forceManagedUpdate) {
            lines.push(`WOULD OVERWRITE WITH --force-managed-update: ${file}`);
        }
    }
    for (const file of result.forceOverwrite || []) {
        lines.push(result.dryRun
            ? `WOULD OVERWRITE WITH --force-managed-update: ${file}`
            : `OVERWRITE WITH --force-managed-update: ${file}`);
    }
    for (const file of result.backups || []) {
        lines.push(`Backup if modified: ${file}`);
    }
    for (const note of result.notes || []) {
        lines.push(note);
    }
    for (const warning of result.warnings || []) {
        lines.push(`Warning: ${warning}`);
    }
    for (const file of result.backupFiles || []) {
        lines.push(`Backup written: ${file}`);
    }
    return lines.join("\n");
}
