import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
    AGENTS_BEGIN,
    AGENTS_END,
    CONFIG_BEGIN,
    CONFIG_END,
    PERMISSION,
    PERMISSIONS,
    classifyOwned,
    doctor,
    formatPlan,
    install,
    sha256Hex,
    status,
    uninstall
} from "../lib/installer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts", "aeo.mjs");
const USER_AGENTS = "# Billing\nDo not change the billing schema.\n";
const USER_CONFIG = "model = \"gpt-6-astra\"\n\n[mcp_servers.docs]\ncommand = \"node\"\nargs = [\"docs.js\"]\n";
const KEEP = "keep-unrelated\n";

async function fakeNpmCi(cwd) {
    await mkdir(path.join(cwd, "node_modules"), { recursive: true });
    await writeFile(path.join(cwd, "node_modules", ".installed"), "ok\n");
}

async function workspace() {
    const target = await mkdtemp(path.join(os.tmpdir(), "aeo-own-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-own-home-"));
    await mkdir(path.join(target, "src"), { recursive: true });
    await mkdir(path.join(target, ".codex"), { recursive: true });
    await writeFile(path.join(target, "src", "keep.txt"), KEEP);
    return { target, home };
}

function options(target, home, extra = {}) {
    return {
        target,
        homeDir: home,
        repoRoot,
        npmCi: fakeNpmCi,
        codex: true,
        claude: false,
        ...extra
    };
}

async function cleanup(target, home, extra) {
    await rm(target, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    if (extra) {
        await rm(extra, { recursive: true, force: true });
    }
}

function count(text, needle) {
    return text.split(needle).length - 1;
}

async function alternatePreset(edit) {
    const root = await mkdtemp(path.join(os.tmpdir(), "aeo-own-preset-"));
    await cp(path.join(repoRoot, "presets"), path.join(root, "presets"), { recursive: true });
    const bridgeDest = path.join(root, "bridge", "antigravity-mcp");
    for (const relative of ["package.json", "package-lock.json", "index.js", "README.md", "lib/delegate.js", "lib/server.js", "lib/worktree.js"]) {
        await mkdir(path.dirname(path.join(bridgeDest, relative)), { recursive: true });
        await cp(path.join(repoRoot, "bridge", "antigravity-mcp", relative), path.join(bridgeDest, relative));
    }
    await edit(root);
    return root;
}

async function plantExact(target, relative, sourceRelative) {
    const bytes = await readFile(path.join(repoRoot, sourceRelative));
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    return bytes;
}

function ownershipState(report, filePath) {
    return report.ownership.find((item) => item.path === filePath && item.id === undefined)?.state;
}

test("clean first install creates one AEO block in a missing AGENTS.md and config.toml", async () => {
    const { target, home } = await workspace();
    try {
        const result = await install(options(target, home));
        assert.equal(result.ok, true, result.error || result.conflicts.join("\n"));
        const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
        const config = await readFile(path.join(target, ".codex", "config.toml"), "utf8");
        assert.equal(count(agents, AGENTS_BEGIN), 1);
        assert.equal(count(agents, AGENTS_END), 1);
        assert.equal(count(config, CONFIG_BEGIN), 1);
        assert.equal(count(config, CONFIG_END), 1);
        assert.match(agents, /delegate_antigravity/);
        assert.match(config, /\[mcp_servers\.aeo-antigravity\]/);
        assert.equal(await readFile(path.join(target, "src", "keep.txt"), "utf8"), KEEP);
    } finally {
        await cleanup(target, home);
    }
});

test("existing AGENTS.md and config.toml without AEO markers keep their bytes and gain one block", async () => {
    const { target, home } = await workspace();
    try {
        await writeFile(path.join(target, "AGENTS.md"), USER_AGENTS);
        await writeFile(path.join(target, ".codex", "config.toml"), USER_CONFIG);
        const result = await install(options(target, home));
        assert.equal(result.ok, true, result.error || result.conflicts.join("\n"));
        const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
        const config = await readFile(path.join(target, ".codex", "config.toml"), "utf8");
        assert.equal(agents.slice(0, USER_AGENTS.length), USER_AGENTS);
        assert.equal(config.slice(0, USER_CONFIG.length), USER_CONFIG);
        assert.equal(count(agents, AGENTS_BEGIN), 1);
        assert.equal(count(config, CONFIG_BEGIN), 1);
        assert.match(config, /\[mcp_servers\.docs\]/);
        assert.equal(await readFile(path.join(target, "src", "keep.txt"), "utf8"), KEEP);
    } finally {
        await cleanup(target, home);
    }
});

test("an existing AEO block without a manifest is a collision and stays byte-identical", async () => {
    const { target, home } = await workspace();
    try {
        const agentsPath = path.join(target, "AGENTS.md");
        const original = `${USER_AGENTS}${AGENTS_BEGIN}\nuser orchestration\n${AGENTS_END}\nAFTER\n`;
        await writeFile(agentsPath, original);
        await writeFile(path.join(target, ".codex", "config.toml"), USER_CONFIG);
        const keep = await readFile(path.join(target, "src", "keep.txt"));
        const result = await install(options(target, home));
        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.match(result.conflicts.join("\n"), /cannot prove ownership/);
        assert.match(result.conflicts.join("\n"), /Preserved existing block/);
        assert.match(result.ownershipUnknown.join("\n"), /AGENTS.md/);
        assert.equal(await readFile(agentsPath, "utf8"), original);
        assert.equal(count(original, AGENTS_BEGIN), 1);
        assert.equal(await readFile(path.join(target, ".codex", "config.toml"), "utf8"), USER_CONFIG);
        assert.deepEqual(await readFile(path.join(target, "src", "keep.txt")), keep);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);

        const again = await install(options(target, home, { forceManagedUpdate: true }));
        assert.equal(again.ok, false);
        assert.equal(await readFile(agentsPath, "utf8"), original);
        assert.equal(count(await readFile(agentsPath, "utf8"), AGENTS_BEGIN), 1);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);
    } finally {
        await cleanup(target, home);
    }
});

test("dry-run reports ownership unknown and writes nothing", async () => {
    const { target, home } = await workspace();
    try {
        const agentsPath = path.join(target, "AGENTS.md");
        const original = `${USER_AGENTS}${AGENTS_BEGIN}\nkeep me\n${AGENTS_END}\n`;
        await writeFile(agentsPath, original);
        const before = await readFile(agentsPath);
        let calls = 0;
        const dry = await install(options(target, home, {
            dryRun: true,
            npmCi: async () => {
                calls += 1;
            }
        }));
        assert.equal(dry.ok, false);
        assert.equal(dry.wrote, false);
        assert.equal(calls, 0);
        const rendered = formatPlan(dry);
        assert.match(rendered, /Dry run/);
        assert.match(rendered, /OWNERSHIP UNKNOWN — PRESERVED/);
        assert.match(rendered, /cannot prove ownership/);
        assert.equal(rendered.includes("Install finished."), false);
        assert.deepEqual(await readFile(agentsPath), before);
        const cliResult = spawnSync(process.execPath, [cli, "install", "--target", target, "--codex", "--dry-run"], {
            encoding: "utf8"
        });
        assert.equal(cliResult.status, 1, cliResult.stderr);
        assert.match(cliResult.stdout, /OWNERSHIP UNKNOWN — PRESERVED/);
        assert.deepEqual(await readFile(agentsPath), before);
    } finally {
        await cleanup(target, home);
    }
});

test("an existing Codex managed block without a manifest is preserved", async () => {
    const { target, home } = await workspace();
    try {
        const configPath = path.join(target, ".codex", "config.toml");
        await mkdir(path.dirname(configPath), { recursive: true });
        const original = `${USER_CONFIG}${CONFIG_BEGIN}\n# USER CONFIG CUSTOM\nstartup_timeout_sec = 99\n${CONFIG_END}\n`;
        await writeFile(path.join(target, "AGENTS.md"), USER_AGENTS);
        await writeFile(configPath, original);
        const agentsBefore = await readFile(path.join(target, "AGENTS.md"));
        const result = await install(options(target, home));
        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.match(result.conflicts.join("\n"), /\.codex\/config\.toml/);
        assert.match(result.conflicts.join("\n"), /cannot prove ownership/);
        assert.equal(await readFile(configPath, "utf8"), original);
        assert.equal(count(original, CONFIG_BEGIN), 1);
        assert.deepEqual(await readFile(path.join(target, "AGENTS.md")), agentsBefore);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);
    } finally {
        await cleanup(target, home);
    }
});

test("install, customize, uninstall, and reinstall preserves AGENTS.md and config.toml", async () => {
    const { target, home } = await workspace();
    try {
        await writeFile(path.join(target, "AGENTS.md"), USER_AGENTS);
        await writeFile(path.join(target, ".codex", "config.toml"), USER_CONFIG);
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || first.conflicts.join("\n"));
        const agentsPath = path.join(target, "AGENTS.md");
        const configPath = path.join(target, ".codex", "config.toml");
        const customAgents = (await readFile(agentsPath, "utf8")).replace(AGENTS_BEGIN, `${AGENTS_BEGIN}\nUSER BLOCK CUSTOMIZATION`);
        const customConfig = (await readFile(configPath, "utf8")).replace("startup_timeout_sec = 30", "startup_timeout_sec = 45");
        await writeFile(agentsPath, customAgents);
        await writeFile(configPath, customConfig);
        const removed = await uninstall({ target, repoRoot });
        assert.equal(removed.ok, true, removed.error || "");
        assert.ok(removed.preserved.some((item) => item.includes("AGENTS.md")));
        assert.ok(removed.preserved.some((item) => item.includes("config.toml")));
        assert.equal(await readFile(agentsPath, "utf8"), customAgents);
        assert.equal(await readFile(configPath, "utf8"), customConfig);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);

        const again = await install(options(target, home));
        assert.equal(again.ok, false);
        assert.equal(again.wrote, false);
        assert.match(again.conflicts.join("\n"), /cannot prove ownership/);
        assert.equal(await readFile(agentsPath, "utf8"), customAgents);
        assert.equal(await readFile(configPath, "utf8"), customConfig);
        assert.equal(count(await readFile(agentsPath, "utf8"), AGENTS_BEGIN), 1);
        assert.equal(count(await readFile(configPath, "utf8"), CONFIG_BEGIN), 1);
        assert.match(await readFile(agentsPath, "utf8"), /billing schema/);
        assert.match(await readFile(configPath, "utf8"), /gpt-6-astra/);
        assert.match(await readFile(configPath, "utf8"), /\[mcp_servers\.docs\]/);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);
        assert.equal(await readFile(path.join(target, ".codex", "agents", "aeo-explorer.toml")).then(() => true, () => false), false);

        const forced = await install(options(target, home, { forceManagedUpdate: true }));
        assert.equal(forced.ok, false);
        assert.equal(await readFile(agentsPath, "utf8"), customAgents);
        assert.equal(await readFile(configPath, "utf8"), customConfig);
        assert.equal(count(await readFile(agentsPath, "utf8"), AGENTS_BEGIN), 1);
        assert.equal(count(await readFile(configPath, "utf8"), CONFIG_BEGIN), 1);
    } finally {
        await cleanup(target, home);
    }
});

test("a block that still matches the preset is not adopted without a manifest", async () => {
    const { target, home } = await workspace();
    try {
        await writeFile(path.join(target, "AGENTS.md"), USER_AGENTS);
        await writeFile(path.join(target, ".codex", "config.toml"), USER_CONFIG);
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const agentsPath = path.join(target, "AGENTS.md");
        const saved = await readFile(agentsPath);
        const removed = await uninstall({ target, repoRoot });
        assert.equal(removed.ok, true, removed.error || "");
        await writeFile(agentsPath, saved);
        const again = await install(options(target, home));
        assert.equal(again.ok, false);
        assert.match(again.conflicts.join("\n"), /cannot prove ownership/);
        assert.deepEqual(await readFile(agentsPath), saved);
        assert.equal(count(saved.toString("utf8"), AGENTS_BEGIN), 1);
        const manifestPath = path.join(target, ".aeo", "install-manifest.json");
        assert.equal(await readFile(manifestPath).then(() => true, () => false), false);
    } finally {
        await cleanup(target, home);
    }
});

test("a manifest-owned block still updates when the installed hash matches", async () => {
    const { target, home } = await workspace();
    const preset = await alternatePreset(async (root) => {
        const file = path.join(root, "presets", "codex", "orchestration-block.md");
        const text = await readFile(file, "utf8");
        await writeFile(file, `${text.trim()}\nAEO_SAFE_UPDATE_SENTINEL\n`);
    });
    try {
        await writeFile(path.join(target, "AGENTS.md"), `${USER_AGENTS}AFTER\n`);
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const agentsPath = path.join(target, "AGENTS.md");
        const before = await readFile(agentsPath, "utf8");
        const manifestBefore = JSON.parse(await readFile(path.join(target, ".aeo", "install-manifest.json"), "utf8"));
        const hashBefore = manifestBefore.managedBlocks.find((block) => block.id === "AEO_ORCHESTRATION").sha256;
        const second = await install(options(target, home, { repoRoot: preset, npmCi: async () => {} }));
        assert.equal(second.ok, true, second.error || second.conflicts.join("\n"));
        assert.ok(second.safeUpdate.includes("AGENTS.md AEO orchestration block"));
        const after = await readFile(agentsPath, "utf8");
        assert.match(after, /AEO_SAFE_UPDATE_SENTINEL/);
        assert.equal(after.startsWith(`${USER_AGENTS}AFTER\n`), true);
        assert.equal(count(after, AGENTS_BEGIN), 1);
        assert.equal(count(after, AGENTS_END), 1);
        const manifestAfter = JSON.parse(await readFile(path.join(target, ".aeo", "install-manifest.json"), "utf8"));
        const hashAfter = manifestAfter.managedBlocks.find((block) => block.id === "AEO_ORCHESTRATION").sha256;
        assert.equal(hashAfter.length, 64);
        assert.notEqual(hashAfter, hashBefore);
        assert.notEqual(after, before);
    } finally {
        await cleanup(target, home, preset);
    }
});

test("a manifest record without a block hash is still ownership", async () => {
    const { target, home } = await workspace();
    try {
        await writeFile(path.join(target, "AGENTS.md"), USER_AGENTS);
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const manifestPath = path.join(target, ".aeo", "install-manifest.json");
        const agentsPath = path.join(target, "AGENTS.md");
        const original = await readFile(agentsPath);
        const legacy = JSON.parse(await readFile(manifestPath, "utf8"));
        for (const block of legacy.managedBlocks) {
            delete block.sha256;
        }
        await writeFile(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`);
        const hashed = await install(options(target, home, { npmCi: async () => {} }));
        assert.equal(hashed.ok, true, hashed.error || hashed.conflicts.join("\n"));
        assert.deepEqual(await readFile(agentsPath), original);
        const recorded = JSON.parse(await readFile(manifestPath, "utf8"));
        const block = recorded.managedBlocks.find((item) => item.id === "AEO_ORCHESTRATION");
        assert.equal(block.sha256.length, 64);

        const custom = original.toString("utf8").replace(AGENTS_BEGIN, `${AGENTS_BEGIN}\nLEGACY DRIFT`);
        await writeFile(agentsPath, custom);
        const driftedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
        for (const item of driftedManifest.managedBlocks) {
            delete item.sha256;
        }
        await writeFile(manifestPath, `${JSON.stringify(driftedManifest, null, 2)}\n`);
        const preserved = await install(options(target, home, { npmCi: async () => {} }));
        assert.equal(preserved.ok, true, preserved.error || preserved.conflicts.join("\n"));
        assert.equal(await readFile(agentsPath, "utf8"), custom);
        assert.ok(preserved.userModified.includes("AGENTS.md AEO orchestration block"));
    } finally {
        await cleanup(target, home);
    }
});

test("an existing aeo-antigravity MCP entry without a manifest is not overwritten", async () => {
    const { target, home } = await workspace();
    try {
        const mcpPath = path.join(target, ".mcp.json");
        const original = `${JSON.stringify({
            mcpServers: {
                docs: { command: "node", args: ["docs.js"] },
                "aeo-antigravity": { command: "node", args: ["user-owned.js"] }
            }
        }, null, 2)}\n`;
        await writeFile(mcpPath, original);
        await writeFile(path.join(target, "src", "keep.txt"), KEEP);
        const result = await install(options(target, home, { codex: false, claude: true }));
        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.match(result.conflicts.join("\n"), /does not own it/);
        assert.equal(await readFile(mcpPath, "utf8"), original);
        assert.equal(await readFile(path.join(target, "src", "keep.txt"), "utf8"), KEEP);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);
    } finally {
        await cleanup(target, home);
    }
});

test("an existing AEO permission without a manifest is not overwritten or claimed", async () => {
    const { target, home } = await workspace();
    try {
        const settingsPath = path.join(target, ".claude", "settings.local.json");
        await mkdir(path.dirname(settingsPath), { recursive: true });
        const settings = {
            permissions: {
                allow: ["Bash(git status*)", ...PERMISSIONS],
                deny: ["Bash(git push*)"]
            },
            extra: true
        };
        const original = `${JSON.stringify(settings, null, 2)}\n`;
        await writeFile(settingsPath, original);
        const result = await install(options(target, home, { codex: false, claude: true }));
        assert.equal(result.ok, true, result.error || result.conflicts.join("\n"));
        assert.match(result.warnings.join("\n"), /will not claim/);
        assert.equal(await readFile(settingsPath, "utf8"), original);
        const manifest = JSON.parse(await readFile(path.join(target, ".aeo", "install-manifest.json"), "utf8"));
        assert.equal(manifest.mergedEntries.some((entry) => entry.path === "permissions.allow"), false);
        const removed = await uninstall({ target, repoRoot });
        assert.equal(removed.ok, true, removed.error || "");
        assert.equal(await readFile(settingsPath, "utf8"), original);
    } finally {
        await cleanup(target, home);
    }
});

test("a collision does not rewrite an existing install manifest", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home, { codex: false, claude: true }));
        assert.equal(first.ok, true, first.error || "");
        const manifestPath = path.join(target, ".aeo", "install-manifest.json");
        const manifestBefore = await readFile(manifestPath);
        const agentsPath = path.join(target, "AGENTS.md");
        const orphan = `${AGENTS_BEGIN}\npreserved orphan\n${AGENTS_END}\n`;
        await writeFile(agentsPath, orphan);
        const blocked = await install(options(target, home, { codex: true, claude: true, forceManagedUpdate: true }));
        assert.equal(blocked.ok, false);
        assert.equal(blocked.wrote, false);
        assert.match(blocked.conflicts.join("\n"), /cannot prove ownership/);
        assert.equal(await readFile(agentsPath, "utf8"), orphan);
        assert.deepEqual(await readFile(manifestPath), manifestBefore);
        const mcp = JSON.parse(await readFile(path.join(target, ".mcp.json"), "utf8"));
        assert.equal(mcp.mcpServers["aeo-antigravity"].command, "node");
    } finally {
        await cleanup(target, home);
    }
});

test("block hash uses the installed interior, not a preset hash, for an unchanged owned block", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const manifest = JSON.parse(await readFile(path.join(target, ".aeo", "install-manifest.json"), "utf8"));
        const block = manifest.managedBlocks.find((item) => item.id === "AEO_ORCHESTRATION");
        const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
        const inner = agents.slice(agents.indexOf(AGENTS_BEGIN) + AGENTS_BEGIN.length, agents.indexOf(AGENTS_END));
        assert.equal(block.sha256, createHash("sha256").update(Buffer.from(inner, "utf8")).digest("hex"));
    } finally {
        await cleanup(target, home);
    }
});

test("classifyOwned treats exact preset bytes as a conflict until the manifest owns the file", () => {
    const preset = Buffer.from("preset-v1");
    const same = Buffer.from("preset-v1");
    const edited = Buffer.from("preset-v1-user");
    const next = Buffer.from("preset-v2");
    const hash = sha256Hex(same);
    assert.equal(classifyOwned({ current: null, preset, owned: false, lastHash: null, force: false }).action, "create");
    assert.equal(classifyOwned({ current: null, preset, owned: true, lastHash: hash, force: false }).action, "recreate");
    assert.equal(classifyOwned({ current: same, preset, owned: false, lastHash: null, force: true }).action, "conflict");
    assert.equal(classifyOwned({ current: edited, preset, owned: false, lastHash: null, force: true }).action, "conflict");
    assert.equal(classifyOwned({ current: same, preset, owned: true, lastHash: hash, force: false }).action, "unchanged");
    assert.equal(classifyOwned({ current: same, preset: next, owned: true, lastHash: hash, force: false }).action, "safe-update");
    assert.equal(classifyOwned({ current: edited, preset, owned: true, lastHash: hash, force: false }).action, "preserve-drift");
    assert.equal(classifyOwned({ current: edited, preset, owned: true, lastHash: hash, force: true }).action, "force");
});

test("exact-match Codex agent files without a manifest are preserved and not deleted", async () => {
    const { target, home } = await workspace();
    try {
        const explorer = ".codex/agents/aeo-explorer.toml";
        const architect = ".codex/agents/aeo-architect.toml";
        const explorerBytes = await plantExact(target, explorer, path.join("presets", "codex", "agents", "aeo-explorer.toml"));
        const architectBytes = await plantExact(target, architect, path.join("presets", "codex", "agents", "aeo-architect.toml"));
        const dry = await install(options(target, home, { dryRun: true, npmCi: async () => { throw new Error("npm should not run"); } }));
        assert.equal(dry.ok, false);
        assert.equal(dry.wrote, false);
        const rendered = formatPlan(dry);
        assert.match(rendered, /Dry run/);
        assert.match(rendered, /UNOWNED EXISTING FILE — COLLISION: \.codex\/agents\/aeo-explorer\.toml/);
        assert.match(rendered, /UNOWNED EXISTING FILE — COLLISION: \.codex\/agents\/aeo-architect\.toml/);
        assert.equal(rendered.includes("UNCHANGED: .codex/agents/aeo-explorer.toml"), false);
        assert.equal(rendered.includes("Install finished."), false);
        assert.match(dry.conflicts.join("\n"), /cannot prove that AEO owns it/);
        assert.match(dry.conflicts.join("\n"), /Matching content is not sufficient ownership evidence/);
        const blocked = await install(options(target, home, { forceManagedUpdate: true }));
        assert.equal(blocked.ok, false);
        assert.equal(blocked.wrote, false);
        assert.deepEqual(await readFile(path.join(target, explorer)), explorerBytes);
        assert.deepEqual(await readFile(path.join(target, architect)), architectBytes);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);
        const report = await status({ target, homeDir: home });
        assert.equal(report.installed, false);
        assert.equal(ownershipState(report, explorer), "unowned");
        assert.equal(ownershipState(report, architect), "unowned");
        const health = await doctor({ target });
        assert.equal(health.ok, false);
        assert.match(health.problems.join("\n"), /PRESENT BUT NOT OWNED: \.codex\/agents\/aeo-explorer\.toml/);
        assert.match(health.problems.join("\n"), /PRESENT BUT NOT OWNED: \.codex\/agents\/aeo-architect\.toml/);
        assert.deepEqual(await readFile(path.join(target, explorer)), explorerBytes);
        const removed = await uninstall({ target, repoRoot });
        assert.equal(removed.ok, false);
        assert.deepEqual(await readFile(path.join(target, explorer)), explorerBytes);
        assert.deepEqual(await readFile(path.join(target, architect)), architectBytes);
    } finally {
        await cleanup(target, home);
    }
});

test("exact-match Claude rule and agent files without a manifest are preserved", async () => {
    const { target, home } = await workspace();
    try {
        const rule = ".claude/rules/aeo-orchestration.md";
        const agent = ".claude/agents/aeo-explorer.md";
        const ruleBytes = await plantExact(target, rule, path.join("presets", "claude", "rules", "aeo-orchestration.md"));
        const agentBytes = await plantExact(target, agent, path.join("presets", "claude", "agents", "aeo-explorer.md"));
        const dry = await install(options(target, home, {
            codex: false,
            claude: true,
            dryRun: true,
            npmCi: async () => {
                throw new Error("npm should not run");
            }
        }));
        assert.equal(dry.ok, false);
        assert.equal(dry.wrote, false);
        const rendered = formatPlan(dry);
        assert.match(rendered, /Dry run/);
        assert.match(rendered, /UNOWNED EXISTING FILE — COLLISION: \.claude\/rules\/aeo-orchestration\.md/);
        assert.match(rendered, /UNOWNED EXISTING FILE — COLLISION: \.claude\/agents\/aeo-explorer\.md/);
        assert.equal(rendered.includes("UNCHANGED: .claude/rules/aeo-orchestration.md"), false);
        assert.equal(rendered.includes("Install finished."), false);
        const blocked = await install(options(target, home, { codex: false, claude: true, forceManagedUpdate: true }));
        assert.equal(blocked.ok, false);
        assert.equal(blocked.wrote, false);
        assert.match(blocked.conflicts.join("\n"), /aeo-orchestration\.md/);
        assert.match(blocked.conflicts.join("\n"), /aeo-explorer\.md/);
        assert.match(blocked.conflicts.join("\n"), /cannot prove that AEO owns it/);
        assert.equal(blocked.unchanged.includes(rule), false);
        assert.equal(blocked.unchanged.includes(agent), false);
        assert.deepEqual(await readFile(path.join(target, rule)), ruleBytes);
        assert.deepEqual(await readFile(path.join(target, agent)), agentBytes);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);
        const report = await status({ target, homeDir: home });
        assert.equal(report.installed, false);
        assert.equal(ownershipState(report, rule), "unowned");
        assert.equal(ownershipState(report, agent), "unowned");
        const health = await doctor({ target });
        assert.match(health.problems.join("\n"), /PRESENT BUT NOT OWNED: \.claude\/rules\/aeo-orchestration\.md/);
        assert.match(health.problems.join("\n"), /PRESENT BUT NOT OWNED: \.claude\/agents\/aeo-explorer\.md/);
        assert.deepEqual(await readFile(path.join(target, rule)), ruleBytes);
        const removed = await uninstall({ target, repoRoot });
        assert.equal(removed.ok, false);
        assert.deepEqual(await readFile(path.join(target, rule)), ruleBytes);
        assert.deepEqual(await readFile(path.join(target, agent)), agentBytes);
    } finally {
        await cleanup(target, home);
    }
});

test("an exact-match bridge runtime file without a manifest is not adopted", async () => {
    const { target, home } = await workspace();
    try {
        const relative = ".aeo/bridge/antigravity-mcp/index.js";
        const bytes = await plantExact(target, relative, path.join("bridge", "antigravity-mcp", "index.js"));
        const blocked = await install(options(target, home, { forceManagedUpdate: true }));
        assert.equal(blocked.ok, false);
        assert.equal(blocked.wrote, false);
        assert.match(blocked.conflicts.join("\n"), /bridge\/antigravity-mcp\/index\.js/);
        assert.match(blocked.conflicts.join("\n"), /cannot prove that AEO owns it/);
        assert.equal(blocked.unchanged.includes(relative), false);
        assert.deepEqual(await readFile(path.join(target, relative)), bytes);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);
        const removed = await uninstall({ target, repoRoot });
        assert.equal(removed.ok, false);
        assert.deepEqual(await readFile(path.join(target, relative)), bytes);
        const report = await status({ target, homeDir: home });
        assert.equal(ownershipState(report, relative), "unowned");
    } finally {
        await cleanup(target, home);
    }
});

test("manifest-owned exact-match Codex and Claude files stay unchanged", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home, { claude: true }));
        assert.equal(first.ok, true, first.error || first.conflicts.join("\n"));
        const explorer = path.join(target, ".codex", "agents", "aeo-explorer.toml");
        const rule = path.join(target, ".claude", "rules", "aeo-orchestration.md");
        const explorerBefore = await readFile(explorer);
        const ruleBefore = await readFile(rule);
        const second = await install(options(target, home, { claude: true, npmCi: async () => {} }));
        assert.equal(second.ok, true, second.error || second.conflicts.join("\n"));
        assert.equal(second.wrote, false);
        assert.ok(second.unchanged.includes(".codex/agents/aeo-explorer.toml"));
        assert.ok(second.unchanged.includes(".claude/rules/aeo-orchestration.md"));
        assert.equal(formatPlan(second).includes("UNOWNED EXISTING FILE — COLLISION: .codex/agents/aeo-explorer.toml"), false);
        assert.deepEqual(await readFile(explorer), explorerBefore);
        assert.deepEqual(await readFile(rule), ruleBefore);
        const report = await status({ target, homeDir: home });
        assert.equal(report.installed, true);
        assert.equal(ownershipState(report, ".codex/agents/aeo-explorer.toml"), "owned-unchanged");
        assert.equal(ownershipState(report, ".claude/rules/aeo-orchestration.md"), "owned-unchanged");
        const health = await doctor({ target });
        assert.equal(health.problems.some((problem) => problem.includes("PRESENT BUT NOT OWNED")), false);
        const removed = await uninstall({ target, repoRoot });
        assert.equal(removed.ok, true, removed.error || "");
        assert.equal(await readFile(explorer).then(() => true, () => false), false);
        assert.equal(await readFile(rule).then(() => true, () => false), false);
    } finally {
        await cleanup(target, home);
    }
});

test("a first install that fails before the manifest is saved does not adopt the copied files", async () => {
    const { target, home } = await workspace();
    try {
        const failed = await install(options(target, home, {
            writeFile: async (file, contents) => {
                if (String(file).includes("install-manifest.json.aeo-tmp")) {
                    throw new Error("simulated manifest failure");
                }
                await writeFile(file, contents);
            }
        }));
        assert.equal(failed.ok, false);
        assert.match(failed.error, /incomplete/);
        assert.match(failed.error, /not owned/);
        assert.match(failed.error, /will not adopt/);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);
        const relative = ".codex/agents/aeo-explorer.toml";
        const copied = await readFile(path.join(target, relative));
        const preset = await readFile(path.join(repoRoot, "presets", "codex", "agents", "aeo-explorer.toml"));
        assert.deepEqual(copied, preset);
        const retry = await install(options(target, home, {
            forceManagedUpdate: true,
            npmCi: async () => {
                throw new Error("npm should not run");
            }
        }));
        assert.equal(retry.ok, false);
        assert.equal(retry.wrote, false);
        assert.match(retry.conflicts.join("\n"), /cannot prove that AEO owns it/);
        assert.match(retry.conflicts.join("\n"), /Matching content is not sufficient ownership evidence/);
        assert.equal(retry.unchanged.includes(relative), false);
        assert.deepEqual(await readFile(path.join(target, relative)), copied);
        assert.equal(await readFile(path.join(target, ".aeo", "install-manifest.json")).then(() => true, () => false), false);
        const report = await status({ target, homeDir: home });
        assert.equal(report.installed, false);
        assert.equal(ownershipState(report, relative), "unowned");
        const removed = await uninstall({ target, repoRoot });
        assert.equal(removed.ok, false);
        assert.deepEqual(await readFile(path.join(target, relative)), copied);
    } finally {
        await cleanup(target, home);
    }
});

test("a collision does not add an exact-match file to an existing manifest", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home, { codex: false, claude: true }));
        assert.equal(first.ok, true, first.error || "");
        const manifestPath = path.join(target, ".aeo", "install-manifest.json");
        const before = await readFile(manifestPath);
        const relative = ".codex/agents/aeo-reviewer.toml";
        const bytes = await plantExact(target, relative, path.join("presets", "codex", "agents", "aeo-reviewer.toml"));
        const blocked = await install(options(target, home, { claude: true, forceManagedUpdate: true }));
        assert.equal(blocked.ok, false);
        assert.equal(blocked.wrote, false);
        assert.match(blocked.conflicts.join("\n"), /aeo-reviewer\.toml/);
        assert.deepEqual(await readFile(manifestPath), before);
        assert.equal(JSON.parse(before.toString("utf8")).installedFiles.some((item) => item.path === relative), false);
        assert.deepEqual(await readFile(path.join(target, relative)), bytes);
    } finally {
        await cleanup(target, home);
    }
});
