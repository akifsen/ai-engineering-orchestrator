import { spawn } from "node:child_process";
import { defaultNpmCi } from "./npm-ci.mjs";
import { createHash } from "node:crypto";
import { access, chmod, constants, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AEO_VERSION = "1.0.0";
export const AGENTS_BEGIN = "<!-- AEO:BEGIN ORCHESTRATION -->";
export const AGENTS_END = "<!-- AEO:END ORCHESTRATION -->";
export const CONFIG_BEGIN = "# >>> AEO MANAGED CONFIG BEGIN";
export const CONFIG_END = "# <<< AEO MANAGED CONFIG END";

export const PERMISSION = "mcp__aeo-antigravity__delegate_antigravity";
export const PERMISSIONS = [
    PERMISSION,
    "mcp__aeo-antigravity__apply_delegation",
    "mcp__aeo-antigravity__discard_delegation"
];
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

export const TRUST_NOTE = "Codex loads <project>/.codex/config.toml only when the project is trusted. AEO does not change trust. Trust the project in Codex if the project configuration does not appear. Codex CLI and Codex IDE share these configuration layers, which is why AEO does not edit ~/.codex/config.toml.";
export const TRUST_NOTE_GLOBAL = "Codex CLI and Codex IDE share ~/.codex/config.toml across all projects. AEO does not change trust settings. Global configuration applies across projects regardless of individual project trust.";

export function resolveLayout(options = {}) {
    const isGlobal = Boolean(options.global);
    const hasTarget = Boolean(options.target);
    if ((isGlobal && hasTarget) || (!isGlobal && !hasTarget)) {
        throw new Error("Pass either --target <project> or --global, not both.");
    }
    if (hasTarget && (typeof options.target !== "string" || options.target.trim() === "" || options.target.startsWith("--"))) {
        throw new Error("Pass --target <project>.");
    }
    const home = path.resolve(options.homeDir || os.homedir());
    const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : defaultRepoRoot();
    if (isGlobal) {
        const root = home;
        const bridgeDir = path.join(root, ".aeo", "bridge", "antigravity-mcp");
        return {
            mode: "global",
            root,
            id: "global",
            homeDir: home,
            repoRoot,
            agentsFile: path.join(root, ".codex", "AGENTS.md"),
            codexConfigFile: path.join(root, ".codex", "config.toml"),
            codexAgentsDir: path.join(root, ".codex", "agents"),
            claudeRuleFile: path.join(root, ".claude", "rules", "aeo-orchestration.md"),
            claudeAgentsDir: path.join(root, ".claude", "agents"),
            claudeMcpFile: path.join(root, ".claude.json"),
            claudeSettingsFile: path.join(root, ".claude", "settings.json"),
            bridgeDir,
            bridgeIndex: path.join(bridgeDir, "index.js"),
            manifestFile: path.join(root, ".aeo", "global-install-manifest.json"),
            backupDir: path.join(home, ".aeo", "backups", "global")
        };
    }
    const target = path.resolve(options.target);
    const root = target;
    const id = projectId(root);
    const bridgeDir = path.join(root, ".aeo", "bridge", "antigravity-mcp");
    return {
        mode: "project",
        root,
        id,
        homeDir: home,
        repoRoot,
        agentsFile: path.join(root, "AGENTS.md"),
        codexConfigFile: path.join(root, ".codex", "config.toml"),
        codexAgentsDir: path.join(root, ".codex", "agents"),
        claudeRuleFile: path.join(root, ".claude", "rules", "aeo-orchestration.md"),
        claudeAgentsDir: path.join(root, ".claude", "agents"),
        claudeMcpFile: path.join(root, ".mcp.json"),
        claudeSettingsFile: path.join(root, ".claude", "settings.local.json"),
        bridgeDir,
        bridgeIndex: path.join(bridgeDir, "index.js"),
        manifestFile: path.join(root, ".aeo", "install-manifest.json"),
        backupDir: path.join(home, ".aeo", "backups", id)
    };
}

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
    if (normalizeLineEndings(current) === normalizeLineEndings(preset)) {
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

function unownedFileConflict(relative, isGlobal = false, adopt = false) {
    const hint = (isGlobal && !adopt) ? " Pass --adopt to claim it." : "";
    return `An AEO-namespaced file already exists at ${relative}, but this installation cannot prove that AEO owns it. AEO does not own it. Matching content is not sufficient ownership evidence. The file was preserved.${hint}`;
}

function normalizeLineEndings(content) {
    if (content === null || content === undefined) {
        return "";
    }
    const str = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
    return str.replace(/\r\n/g, "\n");
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
        throw new Error(`Refusing to write outside the target: ${file}`);
    }
}

export function codexConfigBlock(bridgeIndex, target) {
    const bridge = toPosix(bridgeIndex);
    const isAgentsDir = target.endsWith("/agents") || target.endsWith("\\agents") || target.endsWith(".codex/agents") || target.endsWith(".codex\\agents");
    const agent = (name) => toPosix(isAgentsDir ? path.join(target, name) : path.join(target, ".codex", "agents", name));
    const sections = [
        "# AEO-owned project config. It does not set model, effort, sandbox, approval, or trust.",
        "",
        "[mcp_servers.aeo-antigravity]",
        'command = "node"',
        `args = ["${bridge}"]`,
        "enabled = true",
        'enabled_tools = ["delegate_antigravity", "apply_delegation", "discard_delegation"]',
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

async function loadManifest(targetOrLayout) {
    const file = typeof targetOrLayout === "string"
        ? path.join(targetOrLayout, ".aeo", "install-manifest.json")
        : targetOrLayout.manifestFile;
    const text = await readText(file);
    if (text === null) {
        return null;
    }
    return JSON.parse(text);
}

async function ownedPresetFiles(presets, options, layout = null) {
    const root = layout?.root;
    const items = [{ relative: GITIGNORE_RELATIVE, preset: Buffer.from(GITIGNORE_TEXT) }];
    if (options.codex) {
        for (const [fileName] of CODEX_AGENTS) {
            const agentRel = root ? toPosix(path.relative(root, path.join(layout.codexAgentsDir, fileName))) : toPosix(path.join(".codex", "agents", fileName));
            items.push({
                relative: agentRel,
                preset: await readFile(path.join(presets.codexAgents, fileName))
            });
        }
    }
    if (options.claude) {
        const ruleRel = root ? toPosix(path.relative(root, layout.claudeRuleFile)) : ".claude/rules/aeo-orchestration.md";
        items.push({
            relative: ruleRel,
            preset: await readFile(presets.claudeRule)
        });
        for (const fileName of CLAUDE_AGENTS) {
            const claudeRel = root ? toPosix(path.relative(root, path.join(layout.claudeAgentsDir, fileName))) : toPosix(path.join(".claude", "agents", fileName));
            items.push({
                relative: claudeRel,
                preset: await readFile(path.join(presets.claudeAgents, fileName))
            });
        }
    }
    for (const fileName of BRIDGE_FILES) {
        const bridgeRel = root ? toPosix(path.relative(root, path.join(layout.bridgeDir, fileName))) : `${BRIDGE_DIR}/${toPosix(fileName)}`;
        items.push({
            relative: bridgeRel,
            preset: await readFile(path.join(presets.bridge, fileName))
        });
    }
    return items;
}

export function ownsValue(manifest, file, entryPath, value) {
    if (!manifest) {
        return false;
    }
    return (manifest.mergedEntries || []).some((entry) => entry.file === file && entry.path === entryPath && entry.value === value);
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
    const isAgents = relative === "AGENTS.md" || relative === ".codex/AGENTS.md";
    const agentsLabel = `${relative} orchestration block`;
    const configLabel = `${relative} AEO block`;

    if (decision.kind === "safe-update") {
        buckets.safeUpdate.push(label);
        buckets.backups.push(relative);
        buckets.merge.push(isAgents
            ? `${agentsLabel} (update interior only)`
            : configLabel);
        return;
    }
    if (decision.action === "write") {
        buckets.merge.push(decision.planned.state === "present"
            ? (isAgents
                ? `${agentsLabel} (update interior only)`
                : configLabel)
            : (isAgents
                ? agentsLabel
                : configLabel));
        buckets.backups.push(relative);
        return;
    }
    buckets.unchanged.push(label);
}

export async function planInstall(options) {
    const layout = options.layout || resolveLayout(options);
    const target = layout.root;
    const repoRoot = layout.repoRoot;
    const presets = presetPaths(repoRoot);
    const info = await stat(target);
    if (!info.isDirectory()) {
        throw new Error(`${layout.mode === "global" ? "Home" : "Target"} is not a directory: ${target}`);
    }
    if (!options.codex && !options.claude) {
        throw new Error("Pass --codex, --claude, or both. AEO does not guess which tools to configure.");
    }
    if (options.replaceCodexAgentsMd && (!options.global || layout.mode !== "global")) {
        throw new Error("--replace-codex-agents-md can only be used with --global install or update.");
    }
    if (options.adopt && (!options.global || layout.mode !== "global")) {
        throw new Error("--adopt can only be used with --global install.");
    }

    const manifest = await loadManifest(layout);
    if (manifest && manifest.schemaVersion !== 1 && manifest.schemaVersion !== SCHEMA_VERSION) {
        throw new Error("Unsupported AEO manifest schema. Installation stopped.");
    }
    if (manifest && manifest.projectId && manifest.projectId !== layout.id) {
        throw new Error("The AEO manifest belongs to a different project path. Installation stopped.");
    }
    const bridgeIndex = layout.bridgeIndex;
    const force = Boolean(options.forceManagedUpdate);
    const isGlobal = layout.mode === "global";
    const replaceCodexAgentsMd = Boolean(isGlobal && options.replaceCodexAgentsMd);
    const adopt = Boolean(isGlobal && options.adopt);

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
    const adopted = [];
    const buckets = { merge, backups, unchanged, safeUpdate, userModified, forceOverwrite };

    if (options.codex) {
        const relativeAgents = toPosix(path.relative(layout.root, layout.agentsFile));
        const agentsFile = layout.agentsFile;
        const agentsBody = await readFile(presets.codexBlock, "utf8");

        const isAgentsWholeFile = isGlobal && (replaceCodexAgentsMd || manifestOwnsFile(manifest, relativeAgents));

        if (isAgentsWholeFile) {
            const currentBytes = await readBytes(agentsFile);
            const presetBytes = Buffer.from(agentsBody, "utf8");
            const isOwned = manifestOwnsFile(manifest, relativeAgents);
            const lastHash = lastInstalledHash(manifest, relativeAgents);
            if (currentBytes === null) {
                if (isOwned) {
                    recreate.push(relativeAgents);
                } else {
                    create.push(relativeAgents);
                }
            } else if (!isOwned) {
                if (sha256Hex(currentBytes) === sha256Hex(presetBytes) || normalizeLineEndings(currentBytes) === normalizeLineEndings(presetBytes)) {
                    unchanged.push(relativeAgents);
                } else {
                    backups.push(relativeAgents);
                    safeUpdate.push(relativeAgents);
                }
            } else {
                const decision = classifyOwned({
                    current: currentBytes,
                    preset: presetBytes,
                    owned: true,
                    lastHash,
                    force
                });
                if (decision.action === "unchanged") {
                    unchanged.push(relativeAgents);
                } else if (decision.action === "safe-update") {
                    safeUpdate.push(relativeAgents);
                } else if (decision.action === "force") {
                    forceOverwrite.push(relativeAgents);
                    backups.push(relativeAgents);
                } else if (decision.action === "preserve-drift") {
                    userModified.push(relativeAgents);
                } else if (decision.action === "recreate") {
                    recreate.push(relativeAgents);
                }
            }
        } else {
            const agentsText = await readText(agentsFile);
            const agentsRecord = blockRecord(manifest, relativeAgents, "AEO_ORCHESTRATION");
            const agentsDecision = classifyBlock({
                currentText: agentsText,
                begin: AGENTS_BEGIN,
                end: AGENTS_END,
                body: agentsBody,
                lastHash: agentsRecord?.sha256 || null,
                owned: blockOwned(manifest, relativeAgents, "AEO_ORCHESTRATION"),
                force
            });
            if (agentsDecision.action === "malformed") {
                conflicts.push(`${relativeAgents} has partial or repeated AEO markers. Installation stopped.`);
            } else if (agentsDecision.action === "collision") {
                ownershipUnknown.push(BLOCK_LABELS.AEO_ORCHESTRATION);
                conflicts.push(unprovenOwnershipConflict(relativeAgents, "an AEO orchestration block"));
            } else if (agentsText === null) {
                create.push(relativeAgents);
                merge.push(`${relativeAgents} orchestration block`);
            } else {
                preserve.push(relativeAgents);
                noteManagedPlan(agentsDecision, BLOCK_LABELS.AEO_ORCHESTRATION, relativeAgents, buckets);
            }
        }

        const configFile = layout.codexConfigFile;
        const relativeConfig = toPosix(path.relative(layout.root, configFile));
        const configText = await readText(configFile);
        const configBody = codexConfigBlock(bridgeIndex, layout.root);
        const configRecord = blockRecord(manifest, relativeConfig, "AEO_CONFIG");
        const configDecision = classifyBlock({
            currentText: configText,
            begin: CONFIG_BEGIN,
            end: CONFIG_END,
            body: configBody,
            lastHash: configRecord?.sha256 || null,
            owned: blockOwned(manifest, relativeConfig, "AEO_CONFIG"),
            force
        });
        if (configText !== null) {
            const found = collisionTables(configText);
            if (found.malformed || configDecision.action === "malformed") {
                conflicts.push(`${relativeConfig} has partial or repeated AEO markers. Installation stopped.`);
            } else if (found.tables.length > 0) {
                conflicts.push(`AEO table already exists outside the managed block: ${found.tables.join(", ")}. Installation stopped.`);
            } else if (configDecision.action === "collision") {
                ownershipUnknown.push(BLOCK_LABELS.AEO_CONFIG);
                conflicts.push(unprovenOwnershipConflict(relativeConfig, "an AEO managed configuration block"));
            } else {
                preserve.push(relativeConfig);
                noteManagedPlan(configDecision, BLOCK_LABELS.AEO_CONFIG, relativeConfig, buckets);
            }
        } else {
            create.push(relativeConfig);
            merge.push(`${relativeConfig} AEO block`);
        }
        notes.push(isGlobal ? TRUST_NOTE_GLOBAL : TRUST_NOTE);
    }

    if (options.claude) {
        const claudeFile = isGlobal ? path.join(layout.root, ".claude", "CLAUDE.md") : path.join(layout.root, "CLAUDE.md");
        const relativeClaude = toPosix(path.relative(layout.root, claudeFile));
        if (await exists(claudeFile)) {
            preserve.push(relativeClaude);
        }

        const mcpFile = layout.claudeMcpFile;
        const relativeMcp = toPosix(path.relative(layout.root, mcpFile));
        const mcpText = await readText(mcpFile);
        if (mcpText === null) {
            create.push(relativeMcp);
            merge.push(`${relativeMcp} mcpServers.aeo-antigravity`);
        } else {
            let parsed;
            try {
                parsed = JSON.parse(mcpText);
            } catch {
                conflicts.push(`${relativeMcp} is not valid JSON. Installation stopped.`);
                parsed = null;
            }
            if (parsed) {
                if (parsed.mcpServers !== undefined && (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null || Array.isArray(parsed.mcpServers))) {
                    conflicts.push(`${relativeMcp} mcpServers is not an object. Installation stopped.`);
                } else {
                    const servers = parsed.mcpServers || {};
                    const entry = mcpEntry(bridgeIndex);
                    const alreadyPresent = Object.hasOwn(servers, MCP_ID);
                    const isOwned = owns(manifest, relativeMcp, "mcpServers.aeo-antigravity");
                    if (alreadyPresent && !isOwned) {
                        const existingServer = servers[MCP_ID];
                        const argsMatch = Array.isArray(existingServer?.args) &&
                            existingServer.args.length === 1 &&
                            toPosix(existingServer.args[0]) === toPosix(entry.args[0]);
                        const commandMatch = existingServer?.command === entry.command;
                        const canAdopt = Boolean(adopt && commandMatch && argsMatch);
                        if (canAdopt) {
                            adopted.push(`${relativeMcp} mcpServers.aeo-antigravity`);
                        } else if (adopt) {
                            conflicts.push(`${relativeMcp} already has mcpServers.aeo-antigravity and AEO does not own it. It cannot be adopted because command/args differ from what AEO would write. Installation stopped.`);
                        } else {
                            const hint = isGlobal ? " Pass --adopt to claim it." : "";
                            conflicts.push(`${relativeMcp} already has mcpServers.aeo-antigravity and AEO does not own it.${hint} Installation stopped.`);
                        }
                    } else if (isOwned) {
                        if (servers[MCP_ID]?.env) {
                            entry.env = servers[MCP_ID].env;
                        }
                        if (JSON.stringify(servers[MCP_ID]) !== JSON.stringify(entry)) {
                            preserve.push(relativeMcp);
                            backups.push(relativeMcp);
                            merge.push(`${relativeMcp} mcpServers.aeo-antigravity`);
                        } else {
                            preserve.push(relativeMcp);
                        }
                    } else if (!alreadyPresent) {
                        preserve.push(relativeMcp);
                        backups.push(relativeMcp);
                        merge.push(`${relativeMcp} mcpServers.aeo-antigravity`);
                    } else {
                        preserve.push(relativeMcp);
                    }
                }
            }
        }

        const settingsFile = layout.claudeSettingsFile;
        const relativeSettings = toPosix(path.relative(layout.root, settingsFile));
        const settingsText = await readText(settingsFile);
        if (settingsText === null) {
            create.push(relativeSettings);
            merge.push(`${relativeSettings} AEO permission`);
        } else {
            try {
                const parsed = JSON.parse(settingsText);
                const allow = parsed?.permissions?.allow;
                if (allow !== undefined && !Array.isArray(allow)) {
                    conflicts.push(`${relativeSettings} permissions.allow is not an array. Installation stopped.`);
                } else {
                    const allowList = Array.isArray(allow) ? allow : [];
                    const missing = PERMISSIONS.filter((perm) => !allowList.includes(perm));
                    let hasUnownedAdopted = false;
                    for (const perm of PERMISSIONS) {
                        if (allowList.includes(perm)) {
                            const isOwned = ownsValue(manifest, relativeSettings, "permissions.allow", perm);
                            if (!isOwned && adopt) {
                                hasUnownedAdopted = true;
                            }
                        }
                    }
                    if (hasUnownedAdopted) {
                        adopted.push(`${relativeSettings} AEO permission`);
                    }
                    preserve.push(relativeSettings);
                    if (missing.length > 0) {
                        backups.push(relativeSettings);
                        merge.push(`${relativeSettings} AEO permission`);
                    }
                }
            } catch {
                conflicts.push(`${relativeSettings} is not valid JSON. Installation stopped.`);
            }
        }
    }

    for (const item of await ownedPresetFiles(presets, options, layout)) {
        const current = await readBytes(path.join(layout.root, item.relative));
        const isOwned = manifestOwnsFile(manifest, item.relative);
        const lastHash = lastInstalledHash(manifest, item.relative);
        if (current !== null && !isOwned) {
            if (adopt && normalizeLineEndings(current) === normalizeLineEndings(item.preset)) {
                adopted.push(item.relative);
                backups.push(item.relative);
            } else {
                unownedFiles.push(item.relative);
                conflicts.push(unownedFileConflict(item.relative, isGlobal, adopt));
            }
            continue;
        }
        const decision = classifyOwned({
            current,
            preset: item.preset,
            owned: isOwned,
            lastHash,
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
            conflicts.push(unownedFileConflict(item.relative, isGlobal, adopt));
        }
    }

    return {
        layout,
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
        adopted,
        forceManagedUpdate: force,
        warnings: [],
        notes
    };
}

async function safeChmod(targetPath, mode) {
    try {
        await chmod(targetPath, mode);
    } catch {
        // Best effort; ignore chmod errors on win32
    }
}

async function backupFile(homeDir, id, stamp, target, relative) {
    const source = path.join(target, relative);
    const destination = path.join(homeDir, ".aeo", "backups", id, stamp, relative);
    const destDir = path.dirname(destination);
    await mkdir(destDir, { recursive: true, mode: 0o700 });
    await writeFile(destination, await readFile(source), { mode: 0o600 });
    await safeChmod(destination, 0o600);

    const backupsRoot = path.join(homeDir, ".aeo", "backups");
    const idDir = path.join(backupsRoot, id);
    const stampDir = path.join(idDir, stamp);

    const dirs = new Set([backupsRoot, idDir, stampDir, destDir]);
    let current = destDir;
    while (current.length > backupsRoot.length && current.startsWith(backupsRoot)) {
        dirs.add(current);
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    const sortedDirs = [...dirs].sort((a, b) => a.length - b.length);
    for (const dir of sortedDirs) {
        await safeChmod(dir, 0o700);
    }

    return destination;
}

export { defaultNpmCi };

async function applyOwned({
    layout,
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
    writeImpl,
    adopt,
    adopted
}) {
    const file = path.join(target, relative);
    assertInside(target, file);
    const posix = toPosix(relative);
    const current = await readBytes(file);
    const isOwned = manifestOwnsFile(manifest, posix);
    const lastHash = lastInstalledHash(manifest, posix);

    if (adopt && !isOwned && current !== null && normalizeLineEndings(current) === normalizeLineEndings(preset)) {
        backupFiles.push(await backupFile(homeDir, id, when, target, posix));
        adopted?.push(posix);
        return { path: posix, sha256: sha256Hex(current), wrote: false };
    }

    const decision = classifyOwned({
        current,
        preset,
        owned: isOwned,
        lastHash,
        force
    });
    if (decision.action === "conflict") {
        throw new Error(unownedFileConflict(posix, layout?.mode === "global", adopt));
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
    const layout = options.layout || resolveLayout(options);
    const plan = await planInstall({ ...options, layout });
    const dryRun = Boolean(options.dryRun);
    if (plan.conflicts.length > 0) {
        return { ok: false, dryRun, wrote: false, ...plan, changed: [], backupFiles: [], warnings: [] };
    }
    if (dryRun) {
        return { ok: true, dryRun: true, wrote: false, ...plan, changed: [], backupFiles: [], warnings: [] };
    }

    const homeDir = layout.homeDir;
    const npmCi = options.npmCi || defaultNpmCi;
    const writeImpl = options.writeFile || null;
    const id = layout.id;
    const when = stamp();
    const changed = [];
    const backupFiles = [];
    const warnings = [];
    const created = new Set(plan.manifest?.createdFiles || []);
    const force = Boolean(options.forceManagedUpdate);
    const isGlobal = layout.mode === "global";
    const replaceCodexAgentsMd = Boolean(isGlobal && options.replaceCodexAgentsMd);
    const adopt = Boolean(isGlobal && options.adopt);
    const adopted = [];

    const ownedContext = {
        layout,
        target: layout.root,
        manifest: plan.manifest,
        force,
        homeDir,
        id,
        when,
        backupFiles,
        changed,
        writeImpl,
        bridgeIndex: layout.bridgeIndex,
        adopt,
        adopted
    };
    const ownedItems = await ownedPresetFiles(plan.presets, options, layout);
    const bridgeItems = ownedItems.filter((item) => item.relative.startsWith(`${BRIDGE_DIR}/`));
    const otherItems = ownedItems.filter((item) => !item.relative.startsWith(`${BRIDGE_DIR}/`));
    let bridgeEntries = [];
    try {
        bridgeEntries = await deployBridge(bridgeItems, ownedContext, npmCi);
    } catch (error) {
        if (await exists(layout.bridgeIndex)) {
            changed.push(BRIDGE_DIR);
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
    let claimPermissions = [];
    const installed = [...bridgeEntries];
    const blocks = [];
    try {
        if (options.codex) {
            const relativeAgents = toPosix(path.relative(layout.root, layout.agentsFile));
            const agentsPreset = await readFile(plan.presets.codexBlock);
            const isAgentsWholeFile = isGlobal && (replaceCodexAgentsMd || manifestOwnsFile(plan.manifest, relativeAgents));
            if (isAgentsWholeFile) {
                const currentBytes = await readBytes(layout.agentsFile);
                const isOwned = manifestOwnsFile(plan.manifest, relativeAgents);
                const lastHash = lastInstalledHash(plan.manifest, relativeAgents);
                if (currentBytes === null) {
                    await writeAtomic(layout.agentsFile, agentsPreset, writeImpl);
                    changed.push(relativeAgents);
                    const written = await readBytes(layout.agentsFile);
                    installed.push({ path: relativeAgents, sha256: sha256Hex(written) });
                } else if (!isOwned) {
                    if (sha256Hex(currentBytes) === sha256Hex(agentsPreset) || normalizeLineEndings(currentBytes) === normalizeLineEndings(agentsPreset)) {
                        installed.push({ path: relativeAgents, sha256: sha256Hex(currentBytes) });
                    } else {
                        const backupDest = await backupFile(homeDir, id, when, layout.root, relativeAgents);
                        backupFiles.push(backupDest);
                        const noteText = `Original ${relativeAgents} was backed up to ${backupDest}. Uninstall deletes ${relativeAgents} if unchanged but does not restore the original.`;
                        if (!plan.notes.includes(noteText)) {
                            plan.notes.push(noteText);
                        }
                        await writeAtomic(layout.agentsFile, agentsPreset, writeImpl);
                        changed.push(relativeAgents);
                        const written = await readBytes(layout.agentsFile);
                        installed.push({ path: relativeAgents, sha256: sha256Hex(written) });
                    }
                } else {
                    const decision = classifyOwned({
                        current: currentBytes,
                        preset: agentsPreset,
                        owned: true,
                        lastHash,
                        force
                    });
                    if (decision.action === "unchanged") {
                        installed.push({ path: relativeAgents, sha256: decision.currentHash });
                    } else if (decision.action === "preserve-drift") {
                        installed.push({ path: relativeAgents, sha256: decision.lastHash || lastHash });
                    } else if (decision.action === "force") {
                        const backupDest = await backupFile(homeDir, id, when, layout.root, relativeAgents);
                        backupFiles.push(backupDest);
                        await writeAtomic(layout.agentsFile, agentsPreset, writeImpl);
                        changed.push(relativeAgents);
                        const written = await readBytes(layout.agentsFile);
                        installed.push({ path: relativeAgents, sha256: sha256Hex(written) });
                    } else if (decision.action === "safe-update" || decision.action === "recreate") {
                        await writeAtomic(layout.agentsFile, agentsPreset, writeImpl);
                        changed.push(relativeAgents);
                        const written = await readBytes(layout.agentsFile);
                        installed.push({ path: relativeAgents, sha256: sha256Hex(written) });
                    }
                }
            } else {
                const block = agentsPreset.toString("utf8");
                blocks.push(await applyTextMerge({
                    layout,
                    target: layout.root,
                    relative: relativeAgents,
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
            }

            const relativeConfig = toPosix(path.relative(layout.root, layout.codexConfigFile));
            blocks.push(await applyTextMerge({
                layout,
                target: layout.root,
                relative: relativeConfig,
                begin: CONFIG_BEGIN,
                end: CONFIG_END,
                blockId: "AEO_CONFIG",
                body: codexConfigBlock(layout.bridgeIndex, layout.root),
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
                layout,
                target: layout.root,
                bridgeIndex: layout.bridgeIndex,
                manifest: plan.manifest,
                homeDir,
                id,
                when,
                backupFiles,
                changed,
                created,
                warnings,
                adopt,
                adopted,
                writeImpl
            });
            claimPermissions = await mergePermission({
                layout,
                target: layout.root,
                manifest: plan.manifest,
                homeDir,
                id,
                when,
                backupFiles,
                changed,
                created,
                warnings,
                adopt,
                adopted,
                writeImpl
            });
        }

        const manifest = combineManifest(plan.manifest, buildManifest({
            id,
            codex: options.codex,
            claude: options.claude,
            created: [...created],
            claimMcp,
            claimPermissions,
            installed,
            blocks,
            layout
        }));
        const manifestPath = layout.manifestFile;
        const relativeManifest = toPosix(path.relative(layout.root, manifestPath));
        const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
        if (await readText(manifestPath) !== manifestText) {
            try {
                await writeAtomic(manifestPath, manifestText, writeImpl);
                changed.push(relativeManifest);
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
                    error: `Installation is incomplete. Some AEO files may already have been copied, but ${relativeManifest} was not saved. ${recovery} Backups, if any, were not restored automatically. ${detail}`
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
            manifest,
            adopted
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
    layout,
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
    adopt,
    adopted,
    writeImpl
}) {
    const file = layout ? layout.claudeMcpFile : path.join(target, ".mcp.json");
    const relative = layout ? toPosix(path.relative(layout.root, file)) : ".mcp.json";
    const current = await readText(file);
    const entry = mcpEntry(bridgeIndex);
    let parsed = { mcpServers: {} };
    if (current !== null) {
        parsed = JSON.parse(current);
        if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) {
            parsed.mcpServers = {};
        }
        const alreadyPresent = Object.hasOwn(parsed.mcpServers, MCP_ID);
        const isOwned = owns(manifest, relative, "mcpServers.aeo-antigravity");
        if (alreadyPresent && !isOwned) {
            const existingServer = parsed.mcpServers[MCP_ID];
            const argsMatch = Array.isArray(existingServer?.args) &&
                existingServer.args.length === 1 &&
                toPosix(existingServer.args[0]) === toPosix(entry.args[0]);
            const commandMatch = existingServer?.command === entry.command;
            if (adopt && commandMatch && argsMatch) {
                if (existingServer.env) {
                    entry.env = existingServer.env;
                }
                parsed.mcpServers[MCP_ID] = entry;
                adopted?.push(`${relative} mcpServers.aeo-antigravity`);
                const next = `${JSON.stringify(parsed, null, 2)}\n`;
                if (next !== current) {
                    backupFiles.push(await backupFile(homeDir, id, when, layout ? layout.root : target, relative));
                    await writeAtomic(file, next, writeImpl);
                    changed.push(relative);
                }
                return true;
            }
            if (adopt) {
                throw new Error("Refusing to overwrite an unowned aeo-antigravity MCP server. It cannot be adopted because command/args differ from what AEO would write.");
            }
            const hint = (layout?.mode === "global") ? " Pass --adopt to claim it." : "";
            throw new Error(`Refusing to overwrite an unowned aeo-antigravity MCP server.${hint}`);
        }
        if (isOwned && parsed.mcpServers[MCP_ID]?.env) {
            entry.env = parsed.mcpServers[MCP_ID].env;
        }
        if (JSON.stringify(parsed.mcpServers[MCP_ID]) === JSON.stringify(entry)) {
            return true;
        }
        if (alreadyPresent) {
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
        backupFiles.push(await backupFile(homeDir, id, when, layout ? layout.root : target, relative));
    }
    await writeAtomic(file, next, writeImpl);
    changed.push(relative);
    return true;
}

async function mergePermission({
    layout,
    target,
    manifest,
    homeDir,
    id,
    when,
    backupFiles,
    changed,
    created,
    warnings,
    adopt,
    adopted,
    writeImpl
}) {
    const file = layout ? layout.claudeSettingsFile : path.join(target, path.join(".claude", "settings.local.json"));
    const relative = layout ? toPosix(path.relative(layout.root, file)) : toPosix(path.join(".claude", "settings.local.json"));
    const current = await readText(file);
    let parsed = { permissions: { allow: [] } };
    if (current !== null) {
        parsed = JSON.parse(current);
    }
    if (!parsed.permissions || typeof parsed.permissions !== "object" || Array.isArray(parsed.permissions)) {
        if (current !== null && parsed.permissions !== undefined) {
            throw new Error(`${relative} permissions is not an object. Installation stopped.`);
        }
        parsed.permissions = {};
    }
    if (parsed.permissions.allow === undefined) {
        parsed.permissions.allow = [];
    }
    if (!Array.isArray(parsed.permissions.allow)) {
        throw new Error(`${relative} permissions.allow is not an array. Installation stopped.`);
    }
    const toAdd = [];
    const claimPermissions = [];
    let hasAdopted = false;
    for (const perm of PERMISSIONS) {
        const already = parsed.permissions.allow.includes(perm);
        const owned = ownsValue(manifest, relative, "permissions.allow", perm);
        if (already && !owned && current !== null) {
            if (adopt) {
                hasAdopted = true;
                claimPermissions.push(perm);
            } else {
                const hint = (layout?.mode === "global" && !adopt) ? " Pass --adopt to claim it." : "";
                warnings.push(`The AEO permission ${perm} is already present and was not added by a previous AEO manifest. AEO will not claim it.${hint}`);
            }
        } else if (already) {
            claimPermissions.push(perm);
        } else {
            toAdd.push(perm);
            claimPermissions.push(perm);
        }
    }

    if (hasAdopted) {
        adopted?.push(`${relative} AEO permission`);
    }

    if (toAdd.length > 0) {
        parsed.permissions.allow.push(...toAdd);
        const next = `${JSON.stringify(parsed, null, 2)}\n`;
        if (current === null) {
            created.add(toPosix(relative));
        } else {
            backupFiles.push(await backupFile(homeDir, id, when, layout ? layout.root : target, relative));
        }
        await writeAtomic(file, next, writeImpl);
        changed.push(toPosix(relative));
    }
    return claimPermissions;
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

function mergeBlocks(previous, next, installedFiles = []) {
    const ownedPaths = new Set((installedFiles || []).map((entry) => (typeof entry === "string" ? entry : entry.path)));
    const map = new Map();
    const add = (block) => {
        if (!block?.file || ownedPaths.has(block.file)) {
            return;
        }
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
        const key = entry.value !== undefined
            ? `${entry.file}\0${entry.path}\0${entry.value}`
            : `${entry.file}\0${entry.path}`;
        entries.set(key, entry);
    }
    const mergedInstalled = mergeInstalled(previous, next.installedFiles);
    return {
        schemaVersion: SCHEMA_VERSION,
        aeoVersion: AEO_VERSION,
        projectId: next.projectId,
        targets: unique([...(previous?.targets || []), ...(next.targets || [])]),
        createdFiles: unique([...(previous?.createdFiles || []), ...(next.createdFiles || [])]),
        installedFiles: mergedInstalled,
        managedBlocks: mergeBlocks(previous, next.managedBlocks, mergedInstalled),
        mergedEntries: [...entries.values()]
    };
}

function buildManifest({ id, codex, claude, created, claimMcp, claimPermissions, installed, blocks, layout }) {
    const mergedEntries = [];
    const targets = [];
    if (codex) {
        targets.push("codex");
    }
    if (claude) {
        targets.push("claude");
        const mcpRel = layout ? toPosix(path.relative(layout.root, layout.claudeMcpFile)) : ".mcp.json";
        const settingsRel = layout ? toPosix(path.relative(layout.root, layout.claudeSettingsFile)) : ".claude/settings.local.json";
        if (claimMcp) {
            mergedEntries.push({ file: mcpRel, path: "mcpServers.aeo-antigravity" });
        }
        const perms = Array.isArray(claimPermissions) ? claimPermissions : [];
        for (const value of perms) {
            mergedEntries.push({
                file: settingsRel,
                path: "permissions.allow",
                value
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
    if (relative === ".codex/AGENTS.md") {
        return readFile(path.join(repoRoot, "presets", "codex", "orchestration-block.md"));
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
    const layout = options.layout || resolveLayout(options);
    const target = layout.root;
    const repoRoot = options.repoRoot || defaultRepoRoot();
    const forceRemove = Boolean(options.forceRemoveModified);
    const manifest = await loadManifest(layout);
    if (!manifest) {
        return { ok: false, error: "No AEO install manifest. Refusing to guess which files to delete.", preserved: [] };
    }
    if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== SCHEMA_VERSION) {
        return { ok: false, error: "Unsupported AEO manifest schema. Uninstall stopped.", preserved: [] };
    }
    const problems = await preflightUninstall(layout, manifest);
    if (problems.length > 0) {
        return { ok: false, error: problems.join(" "), changed: [], preserved: [] };
    }
    const changed = [];
    const preserved = [];
    for (const block of manifest.managedBlocks || []) {
        await removeManagedBlock(target, block, repoRoot, forceRemove, changed, preserved, manifest.createdFiles);
    }

    const mcpRel = toPosix(path.relative(layout.root, layout.claudeMcpFile));
    if ((manifest.mergedEntries || []).some((entry) => entry.file === mcpRel)) {
        await removeMcp(layout, manifest, changed);
    }
    const settingsRel = toPosix(path.relative(layout.root, layout.claudeSettingsFile));
    if ((manifest.mergedEntries || []).some((entry) => entry.file === settingsRel)) {
        await removePermission(layout, manifest, changed);
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
    await rm(layout.manifestFile, { force: true });
    await removeIfEmpty(path.join(layout.bridgeDir, "lib"));
    await removeIfEmpty(layout.bridgeDir);
    await removeIfEmpty(path.join(layout.root, ".aeo", "bridge"));
    await removeIfEmpty(path.join(layout.root, ".aeo"));
    await removeIfEmpty(layout.codexAgentsDir);
    if (layout.mode === "project") {
        await removeIfEmpty(path.join(layout.root, ".codex"));
    }
    await removeIfEmpty(layout.claudeAgentsDir);
    await removeIfEmpty(path.join(layout.root, ".claude", "rules"));
    if (layout.mode === "project") {
        await removeIfEmpty(path.join(layout.root, ".claude"));
    }
    return { ok: true, changed, preserved };
}

async function preflightUninstall(layout, manifest) {
    const target = layout.root;
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
    const mcpRel = toPosix(path.relative(layout.root, layout.claudeMcpFile));
    const settingsRel = toPosix(path.relative(layout.root, layout.claudeSettingsFile));
    for (const relative of [mcpRel, settingsRel]) {
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

async function removeMcp(layout, manifest, changed) {
    const file = layout.claudeMcpFile;
    const relative = toPosix(path.relative(layout.root, file));
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
    const created = (manifest.createdFiles || []).includes(relative);
    if (serverCount === 0 && otherKeys.length === 0 && created) {
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

async function removePermission(layout, manifest, changed) {
    const file = layout.claudeSettingsFile;
    const relative = toPosix(path.relative(layout.root, file));
    const current = await readText(file);
    if (current === null) {
        return;
    }
    const ownedPermissions = new Set(
        (manifest.mergedEntries || [])
            .filter((entry) => entry.file === relative && entry.path === "permissions.allow" && typeof entry.value === "string")
            .map((entry) => entry.value)
    );
    if (ownedPermissions.size === 0) {
        return;
    }
    const parsed = JSON.parse(current);
    if (parsed.permissions && Array.isArray(parsed.permissions.allow)) {
        parsed.permissions.allow = parsed.permissions.allow.filter((entry) => !ownedPermissions.has(entry));
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

function wholeFileCandidates(layout = null) {
    const list = [
        GITIGNORE_RELATIVE,
        ...CODEX_AGENTS.map(([fileName]) => toPosix(path.join(".codex", "agents", fileName))),
        ".claude/rules/aeo-orchestration.md",
        ...CLAUDE_AGENTS.map((fileName) => toPosix(path.join(".claude", "agents", fileName))),
        ...BRIDGE_FILES.map((fileName) => `${BRIDGE_DIR}/${toPosix(fileName)}`)
    ];
    if (layout?.mode === "global") {
        list.push(".codex/AGENTS.md");
    }
    return list;
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

async function ownershipReport(targetOrLayout, manifest) {
    const layout = typeof targetOrLayout === "object" && targetOrLayout.root ? targetOrLayout : null;
    const target = layout ? layout.root : path.resolve(targetOrLayout);
    const rows = [];
    const isAgentsWholeFile = manifestOwnsFile(manifest, ".codex/AGENTS.md");
    for (const relative of wholeFileCandidates(layout)) {
        if (relative === ".codex/AGENTS.md" && !isAgentsWholeFile) {
            continue;
        }
        rows.push(await fileOwnership(target, manifest, relative));
    }
    const agentsRel = layout ? toPosix(path.relative(layout.root, layout.agentsFile)) : "AGENTS.md";
    const configRel = layout ? toPosix(path.relative(layout.root, layout.codexConfigFile)) : ".codex/config.toml";
    if (!isAgentsWholeFile) {
        rows.push(await blockOwnership(target, manifest, agentsRel, "AEO_ORCHESTRATION", AGENTS_BEGIN, AGENTS_END));
    }
    rows.push(await blockOwnership(target, manifest, configRel, "AEO_CONFIG", CONFIG_BEGIN, CONFIG_END));
    return rows;
}

export async function status(options) {
    const layout = options.layout || resolveLayout(options);
    const target = layout.root;
    const manifest = await loadManifest(layout);
    const homeDir = layout.homeDir;
    const report = {
        installed: Boolean(manifest),
        manifest,
        ownership: await ownershipReport(layout, manifest),
        codex: {},
        claude: {},
        bridge: {},
        trustNote: layout.mode === "global" ? TRUST_NOTE_GLOBAL : TRUST_NOTE
    };
    const agents = await readText(layout.agentsFile);
    const config = await readText(layout.codexConfigFile);
    const isAgentsWholeFile = manifestOwnsFile(manifest, toPosix(path.relative(layout.root, layout.agentsFile)));
    report.codex = {
        orchestrationBlock: isAgentsWholeFile || analyzeMarkers(agents || "", AGENTS_BEGIN, AGENTS_END).state === "present",
        configBlock: analyzeMarkers(config || "", CONFIG_BEGIN, CONFIG_END).state === "present",
        agents: await Promise.all(CODEX_AGENTS.map(async ([fileName]) => exists(path.join(layout.codexAgentsDir, fileName)))),
        server: Boolean(config && config.includes("[mcp_servers.aeo-antigravity]"))
    };
    report.claude = {
        rule: await exists(layout.claudeRuleFile),
        agents: await Promise.all(CLAUDE_AGENTS.map(async (fileName) => exists(path.join(layout.claudeAgentsDir, fileName)))),
        server: false,
        permission: false,
        permissions: Object.fromEntries(PERMISSIONS.map((perm) => [perm, false]))
    };
    const mcpText = await readText(layout.claudeMcpFile);
    if (mcpText) {
        try {
            const parsed = JSON.parse(mcpText);
            report.claude.server = Boolean(parsed.mcpServers && parsed.mcpServers[MCP_ID]);
        } catch {
            report.claude.server = false;
        }
    }
    const settingsText = await readText(layout.claudeSettingsFile);
    if (settingsText) {
        try {
            const parsed = JSON.parse(settingsText);
            const allow = Array.isArray(parsed.permissions?.allow) ? parsed.permissions.allow : [];
            const permissionsMap = {};
            for (const perm of PERMISSIONS) {
                permissionsMap[perm] = allow.includes(perm);
            }
            report.claude.permissions = permissionsMap;
            report.claude.permission = PERMISSIONS.every((perm) => allow.includes(perm));
        } catch {
            report.claude.permission = false;
            report.claude.permissions = Object.fromEntries(PERMISSIONS.map((perm) => [perm, false]));
        }
    }
    report.bridge = {
        filesPresent: await exists(layout.bridgeIndex),
        dependenciesInstalled: await exists(path.join(path.dirname(layout.bridgeIndex), "node_modules")),
        agy: await agyDiscoverable()
    };
    report.trustNote = layout.mode === "global" ? TRUST_NOTE_GLOBAL : await trustNote(target, homeDir);
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
    const layout = options.layout || resolveLayout(options);
    const target = layout.root;
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
    const agentsRel = toPosix(path.relative(layout.root, layout.agentsFile));
    const agents = await readText(layout.agentsFile);
    if (agents !== null) {
        const markers = analyzeMarkers(agents, AGENTS_BEGIN, AGENTS_END);
        if (markers.state === "malformed") {
            problems.push(`${agentsRel} has malformed AEO markers.`);
        }
    }
    const configRel = toPosix(path.relative(layout.root, layout.codexConfigFile));
    const config = await readText(layout.codexConfigFile);
    if (config !== null) {
        const markers = analyzeMarkers(config, CONFIG_BEGIN, CONFIG_END);
        if (markers.state === "malformed") {
            problems.push(`${configRel} has malformed AEO markers.`);
        }
        const duplicates = duplicateTables(config);
        if (duplicates.length > 0) {
            problems.push(`Duplicate TOML tables: ${duplicates.join(", ")}`);
        }
        if (markers.state === "present") {
            for (const [fileName] of CODEX_AGENTS) {
                if (!(await exists(path.join(layout.codexAgentsDir, fileName)))) {
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
    for (const file of [layout.claudeMcpFile, layout.claudeSettingsFile]) {
        const text = await readText(file);
        if (text !== null) {
            try {
                JSON.parse(text);
            } catch {
                problems.push(`${toPosix(path.relative(layout.root, file))} is not valid JSON.`);
            }
        }
    }
    const bridgeIndex = layout.bridgeIndex;
    if (!(await exists(bridgeIndex))) {
        warnings.push("Bridge entrypoint is not installed in .aeo/bridge.");
    } else if (!(await exists(path.join(path.dirname(bridgeIndex), "node_modules")))) {
        warnings.push("Bridge dependencies are not installed.");
    }
    if (!(await agyDiscoverable())) {
        warnings.push("agy was not found on PATH and AGY_BIN is unset or missing.");
    }
    const manifest = await loadManifest(layout);
    if (manifest && manifest.schemaVersion !== 1 && manifest.schemaVersion !== SCHEMA_VERSION) {
        problems.push("Unsupported AEO manifest schema.");
    }
    if (manifest && manifest.targets && manifest.targets.includes("claude")) {
        const settingsText = await readText(layout.claudeSettingsFile);
        if (settingsText !== null) {
            try {
                const parsed = JSON.parse(settingsText);
                const allow = Array.isArray(parsed.permissions?.allow) ? parsed.permissions.allow : [];
                const missing = PERMISSIONS.filter((perm) => !allow.includes(perm));
                if (missing.length > 0) {
                    warnings.push(`Missing Claude permissions: ${missing.join(", ")}`);
                }
            } catch {
                // Invalid JSON handled above
            }
        }
    }
    for (const row of await ownershipReport(layout, manifest)) {
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
    if (layout.mode === "project") {
        const globalManifestPath = path.join(layout.homeDir, ".aeo", "global-install-manifest.json");
        const projectManifest = await loadManifest(layout);
        if (projectManifest && (await exists(globalManifestPath))) {
            warnings.push("Both a global AEO installation and a project AEO installation exist. Both configure the same agent and MCP server names.");
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
    for (const file of unique(result.adopted || [])) {
        lines.push(`ADOPTED: ${file}`);
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
