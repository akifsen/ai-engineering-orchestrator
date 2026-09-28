import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    doctor,
    duplicateTables,
    install,
    ownsValue,
    projectId,
    status,
    uninstall
} from "../lib/installer.mjs";
import { defaultNpmCi } from "../lib/npm-ci.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts", "aeo.mjs");

const USER_AGENTS = "# Billing\nDo not change the billing schema.\n";
const USER_CONFIG = `model = "gpt-6-astra"
model_reasoning_effort = "medium"
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[mcp_servers.docs]
command = "node"
args = ["docs.js"]

[mcp_servers.antigravity]
command = "node"
args = ["user-owned.js"]

[agents.my_agent]
description = "User agent"
config_file = "C:/custom/my-agent.toml"

[agents.explorer]
description = "User explorer"
config_file = "C:/custom/explorer.toml"
`;
const USER_CLAUDE = "# Project\nKeep the public checkout API.\n";
const USER_MCP = {
    mcpServers: {
        docs: { command: "node", args: ["docs.js"] },
        antigravity: { command: "node", args: ["user-owned.js"] }
    }
};
const USER_SETTINGS = {
    permissions: {
        allow: ["Bash(git status*)"],
        deny: ["Bash(git push*)"]
    },
    extra: true
};

async function exists(file) {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

async function fakeNpmCi(cwd) {
    await mkdir(path.join(cwd, "node_modules"), { recursive: true });
    await writeFile(path.join(cwd, "node_modules", ".installed"), "ok\n");
}

function baseOptions(target, home, extra = {}) {
    return {
        target,
        homeDir: home,
        repoRoot,
        npmCi: fakeNpmCi,
        codex: true,
        claude: true,
        ...extra
    };
}

async function fingerprint(root) {
    const { readdir } = await import("node:fs/promises");
    const rows = [];
    async function walk(dir) {
        let entries = [];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else {
                const data = await readFile(full);
                rows.push(`${path.relative(root, full)} ${createHash("sha256").update(data).digest("hex")}`);
            }
        }
    }
    await walk(root);
    return rows.sort().join("\n");
}

async function makeWorkspace() {
    const target = await mkdtemp(path.join(os.tmpdir(), "aeo-project-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-home-"));
    await mkdir(path.join(target, ".codex", "agents"), { recursive: true });
    await mkdir(path.join(target, ".claude", "agents"), { recursive: true });
    await mkdir(path.join(target, "src"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(target, "AGENTS.md"), USER_AGENTS);
    await writeFile(path.join(target, ".codex", "config.toml"), USER_CONFIG);
    await writeFile(path.join(target, "CLAUDE.md"), USER_CLAUDE);
    await writeFile(path.join(target, ".mcp.json"), `${JSON.stringify(USER_MCP, null, 2)}\n`);
    await writeFile(path.join(target, ".claude", "settings.local.json"), `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
    await writeFile(path.join(target, ".claude", "settings.json"), "{\"userSettings\":true}\n");
    await writeFile(path.join(target, ".codex", "agents", "explorer.toml"), "name = \"explorer\"\nUSER CODEX AGENT\n");
    await writeFile(path.join(target, ".claude", "agents", "Explore.md"), "USER CLAUDE AGENT\n");
    await writeFile(path.join(target, "src", "keep.txt"), "keep\n");
    const globalCodex = `model = "global-only"\nUNIQUE_GLOBAL_SENTINEL\ntrust_level = "untrusted"\n# ${target.split("\\").join("/")}\n`;
    await writeFile(path.join(home, ".codex", "config.toml"), globalCodex);
    await writeFile(path.join(home, ".codex", "AGENTS.md"), "GLOBAL AGENTS\n");
    await writeFile(path.join(home, ".claude", "CLAUDE.md"), "GLOBAL CLAUDE\n");
    await writeFile(path.join(home, ".claude", "settings.json"), "{\"global\":true}\n");
    await writeFile(path.join(home, ".claude.json"), "{\"global\":true}\n");
    return { target, home, globalCodex };
}

async function cleanup(target, home) {
    await rm(target, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
}

function assertToml(text) {
    const attempts = [
        ["python3", ["-c", "import tomllib,sys; tomllib.loads(sys.stdin.read().replace('\\r\\n','\\n'))"]],
        ["python", ["-c", "import tomllib,sys; tomllib.loads(sys.stdin.read().replace('\\r\\n','\\n'))"]],
        ["py", ["-3", "-c", "import tomllib,sys; tomllib.loads(sys.stdin.read().replace('\\r\\n','\\n'))"]]
    ];
    let last = "Python 3.11+ with tomllib was not available";
    for (const [command, args] of attempts) {
        const result = spawnSync(command, args, { input: text, encoding: "utf8" });
        if (result.error) {
            last = result.error.message;
            continue;
        }
        if (result.status === 0) {
            return;
        }
        last = result.stderr || result.stdout || last;
    }
    assert.fail(last);
}

function blockInner(text, begin, end) {
    const start = text.indexOf(begin);
    const stop = text.indexOf(end);
    assert.notEqual(start, -1);
    assert.notEqual(stop, -1);
    return text.slice(start + begin.length, stop);
}

test("existing Codex and Claude configuration survives install, reinstall, and uninstall", async () => {
    const { target, home, globalCodex } = await makeWorkspace();
    try {
        const first = await install(baseOptions(target, home));
        assert.equal(first.ok, true, first.error || first.conflicts.join("\n"));
        const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
        const config = await readFile(path.join(target, ".codex", "config.toml"), "utf8");
        assert.equal(agents.slice(0, USER_AGENTS.length), USER_AGENTS);
        assert.equal(config.slice(0, USER_CONFIG.length), USER_CONFIG);
        assert.equal((agents.match(/AEO:BEGIN ORCHESTRATION/g) || []).length, 1);
        assert.equal((config.match(/AEO MANAGED CONFIG BEGIN/g) || []).length, 1);
        assert.match(agents, /remain applicable/);
        assert.match(agents, /aeo_explorer/);
        assert.match(agents, /delegate_antigravity/);
        const inner = blockInner(config, CONFIG_BEGIN, CONFIG_END);
        assert.equal(/^(model|model_reasoning_effort|service_tier|sandbox_mode|approval_policy|notify|trust_level)\s*=/m.test(inner), false);
        assert.match(inner, /\[mcp_servers\.aeo-antigravity\]/);
        assert.equal(inner.includes("[mcp_servers.antigravity]"), false);
        assert.equal(inner.split(/\r?\n/).includes("[agents]"), false);
        assert.equal(duplicateTables(config).length, 0);
        assert.equal(config.includes("UNIQUE_GLOBAL_SENTINEL"), false);
        assertToml(config);
        for (const fileName of ["aeo-explorer.toml", "aeo-architect.toml", "aeo-reviewer.toml", "aeo-fast-worker.toml"]) {
            const file = path.join(target, ".codex", "agents", fileName);
            assert.equal(await exists(file), true);
            assert.match(await readFile(file, "utf8"), /name = "aeo_/);
        }
        assert.equal(await readFile(path.join(target, ".codex", "agents", "explorer.toml"), "utf8"), "name = \"explorer\"\nUSER CODEX AGENT\n");
        assert.equal(await readFile(path.join(target, "CLAUDE.md"), "utf8"), USER_CLAUDE);
        assert.equal(await readFile(path.join(target, ".claude", "settings.json"), "utf8"), "{\"userSettings\":true}\n");
        assert.equal(await readFile(path.join(target, ".claude", "agents", "Explore.md"), "utf8"), "USER CLAUDE AGENT\n");
        const mcp = JSON.parse(await readFile(path.join(target, ".mcp.json"), "utf8"));
        assert.deepEqual(mcp.mcpServers.docs, USER_MCP.mcpServers.docs);
        assert.deepEqual(mcp.mcpServers.antigravity, USER_MCP.mcpServers.antigravity);
        assert.equal(mcp.mcpServers["aeo-antigravity"].command, "node");
        assert.equal(Object.keys(mcp.mcpServers)[0], "docs");
        const settings = JSON.parse(await readFile(path.join(target, ".claude", "settings.local.json"), "utf8"));
        assert.deepEqual(settings.permissions.allow, ["Bash(git status*)", ...PERMISSIONS]);
        assert.deepEqual(settings.permissions.deny, ["Bash(git push*)"]);
        assert.equal(settings.extra, true);
        assert.equal(await readFile(path.join(target, "src", "keep.txt"), "utf8"), "keep\n");
        assert.equal(await readFile(path.join(home, ".codex", "config.toml"), "utf8"), globalCodex);
        assert.equal(await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8"), "GLOBAL AGENTS\n");
        assert.equal(await readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8"), "GLOBAL CLAUDE\n");
        assert.equal(await readFile(path.join(home, ".claude", "settings.json"), "utf8"), "{\"global\":true}\n");
        assert.equal(await readFile(path.join(home, ".claude.json"), "utf8"), "{\"global\":true}\n");
        const manifestText = await readFile(path.join(target, ".aeo", "install-manifest.json"), "utf8");
        const manifest = JSON.parse(manifestText);
        assert.equal(manifest.schemaVersion, 2);
        const explorerEntry = manifest.installedFiles.find((entry) => entry.path === ".codex/agents/aeo-explorer.toml");
        const explorerBytes = await readFile(path.join(target, ".codex", "agents", "aeo-explorer.toml"));
        assert.equal(explorerEntry.sha256, createHash("sha256").update(explorerBytes).digest("hex"));
        assert.equal(manifest.installedFiles.some((entry) => String(entry.path).includes("node_modules")), false);
        assert.equal(manifest.projectId, projectId(target));
        assert.equal(manifestText.includes(target), false);
        assert.equal(manifestText.includes("UNIQUE_GLOBAL_SENTINEL"), false);
        assert.ok(first.backupFiles.length >= 4);
        assert.equal(first.backupFiles.every((file) => file.startsWith(target)), false);
        assert.match(await readFile(first.backupFiles.find((file) => file.endsWith("AGENTS.md")), "utf8"), /billing schema/);
        const bridgeIndex = path.join(target, ".aeo", "bridge", "antigravity-mcp", "index.js");
        assert.equal(await exists(bridgeIndex), true);
        assert.equal(await exists(path.join(target, ".aeo", "bridge", "antigravity-mcp", "test")), false);
        assert.match(config, /aeo\/bridge\/antigravity-mcp\/index\.js/);

        const calls = { count: 0 };
        const second = await install(baseOptions(target, home, {
            npmCi: async () => {
                calls.count += 1;
            }
        }));
        assert.equal(second.ok, true, second.error || "");
        assert.equal(second.wrote, false);
        assert.equal(calls.count, 0);
        assert.equal(second.backupFiles.length, 0);
        const agentsAgain = await readFile(path.join(target, "AGENTS.md"), "utf8");
        assert.equal((agentsAgain.match(/AEO:BEGIN ORCHESTRATION/g) || []).length, 1);
        const settingsAgain = JSON.parse(await readFile(path.join(target, ".claude", "settings.local.json"), "utf8"));
        assert.equal(settingsAgain.permissions.allow.filter((entry) => entry === PERMISSION).length, 1);

        let editedAgents = agentsAgain.replace("billing schema", "billing schema and tax rules");
        editedAgents = editedAgents.replace("model_reasoning_effort", "model_reasoning_effort");
        const editedConfig = (await readFile(path.join(target, ".codex", "config.toml"), "utf8")).replace("gpt-6-astra", "gpt-6-custom");
        await writeFile(path.join(target, "AGENTS.md"), editedAgents);
        await writeFile(path.join(target, ".codex", "config.toml"), editedConfig);
        const settingsEdited = JSON.parse(await readFile(path.join(target, ".claude", "settings.local.json"), "utf8"));
        settingsEdited.permissions.allow.push("Bash(npm test*)");
        await writeFile(path.join(target, ".claude", "settings.local.json"), `${JSON.stringify(settingsEdited, null, 2)}\n`);
        const afterEdit = await install(baseOptions(target, home, { npmCi: async () => {} }));
        assert.equal(afterEdit.ok, true, afterEdit.error || "");
        const agentsEdited = await readFile(path.join(target, "AGENTS.md"), "utf8");
        assert.match(agentsEdited, /tax rules/);
        assert.equal((agentsEdited.match(/AEO:BEGIN ORCHESTRATION/g) || []).length, 1);
        assert.match(await readFile(path.join(target, ".codex", "config.toml"), "utf8"), /gpt-6-custom/);

        const removed = await uninstall({ target });
        assert.equal(removed.ok, true, removed.error || "");
        const agentsFinal = await readFile(path.join(target, "AGENTS.md"), "utf8");
        const configFinal = await readFile(path.join(target, ".codex", "config.toml"), "utf8");
        assert.match(agentsFinal, /tax rules/);
        assert.equal(agentsFinal.includes("AEO:BEGIN"), false);
        assert.match(configFinal, /gpt-6-custom/);
        assert.match(configFinal, /workspace-write/);
        assert.match(configFinal, /on-request/);
        assert.match(configFinal, /\[mcp_servers\.docs\]/);
        assert.match(configFinal, /\[mcp_servers\.antigravity\]/);
        assert.match(configFinal, /\[agents\.my_agent\]/);
        assert.match(configFinal, /\[agents\.explorer\]/);
        assert.equal(configFinal.includes("AEO MANAGED CONFIG"), false);
        assert.equal(configFinal.includes("[mcp_servers.aeo-antigravity]"), false);
        assert.equal(await exists(path.join(target, ".codex", "agents", "explorer.toml")), true);
        assert.equal(await exists(path.join(target, ".codex", "agents", "aeo-explorer.toml")), false);
        assert.equal(await readFile(path.join(target, "CLAUDE.md"), "utf8"), USER_CLAUDE);
        assert.equal(await readFile(path.join(target, ".claude", "agents", "Explore.md"), "utf8"), "USER CLAUDE AGENT\n");
        assert.equal(await exists(path.join(target, ".claude", "agents", "aeo-explorer.md")), false);
        assert.equal(await exists(path.join(target, ".claude", "rules", "aeo-orchestration.md")), false);
        const mcpFinal = JSON.parse(await readFile(path.join(target, ".mcp.json"), "utf8"));
        assert.deepEqual(mcpFinal.mcpServers.docs, USER_MCP.mcpServers.docs);
        assert.deepEqual(mcpFinal.mcpServers.antigravity, USER_MCP.mcpServers.antigravity);
        assert.equal(Object.hasOwn(mcpFinal.mcpServers, "aeo-antigravity"), false);
        const settingsFinal = JSON.parse(await readFile(path.join(target, ".claude", "settings.local.json"), "utf8"));
        assert.deepEqual(settingsFinal.permissions.allow, ["Bash(git status*)", "Bash(npm test*)"]);
        assert.deepEqual(settingsFinal.permissions.deny, ["Bash(git push*)"]);
        assert.equal(settingsFinal.extra, true);
        assert.equal(await readFile(path.join(target, "src", "keep.txt"), "utf8"), "keep\n");
        assert.equal(await readFile(path.join(target, ".claude", "settings.json"), "utf8"), "{\"userSettings\":true}\n");
        assert.equal(await exists(path.join(target, ".aeo", "install-manifest.json")), false);
        assert.equal(await readFile(path.join(home, ".codex", "config.toml"), "utf8"), globalCodex);
        const backup = await readFile(first.backupFiles.find((file) => file.endsWith("AGENTS.md")), "utf8");
        assert.match(backup, /billing schema/);
        assert.equal(backup.includes("tax rules"), false);
    } finally {
        await cleanup(target, home);
    }
});

test("dry-run performs no filesystem changes", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const before = await fingerprint(target);
        const beforeHome = await fingerprint(home);
        let calls = 0;
        const result = await install(baseOptions(target, home, {
            dryRun: true,
            npmCi: async () => {
                calls += 1;
            }
        }));
        assert.equal(result.ok, true);
        assert.equal(result.wrote, false);
        assert.equal(calls, 0);
        assert.ok(result.create.includes("AGENTS.md") === false);
        assert.ok(result.preserve.includes("AGENTS.md"));
        assert.ok(result.preserve.includes("CLAUDE.md"));
        assert.ok(result.merge.some((line) => line.includes("AGENTS.md")));
        assert.ok(result.backups.includes("AGENTS.md"));
        assert.equal(await fingerprint(target), before);
        assert.equal(await fingerprint(home), beforeHome);
        const cliResult = spawnSync(process.execPath, [cli, "install", "--target", target, "--codex", "--claude", "--dry-run"], {
            encoding: "utf8"
        });
        assert.equal(cliResult.status, 0, cliResult.stderr);
        assert.match(cliResult.stdout, /Dry run/);
        assert.equal(await fingerprint(target), before);
    } finally {
        await cleanup(target, home);
    }
});

test("Codex table collision outside the managed block aborts without writes", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const configPath = path.join(target, ".codex", "config.toml");
        const original = `${USER_CONFIG}\n[mcp_servers.aeo-antigravity]\ncommand = "node"\n`;
        await writeFile(configPath, original);
        const before = await fingerprint(target);
        const result = await install(baseOptions(target, home));
        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.match(result.conflicts.join("\n"), /outside the managed block/);
        assert.equal(await readFile(configPath, "utf8"), original);
        assert.equal(await fingerprint(target), before);
        assert.equal(await exists(path.join(target, ".aeo")), false);
    } finally {
        await cleanup(target, home);
    }
});

test("malformed AEO markers abort without writes", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const agentsPath = path.join(target, "AGENTS.md");
        const original = `${USER_AGENTS}${AGENTS_BEGIN}\npartial\n`;
        await writeFile(agentsPath, original);
        const before = await fingerprint(target);
        const result = await install(baseOptions(target, home));
        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.match(result.conflicts.join("\n"), /partial or repeated/);
        assert.equal(await readFile(agentsPath, "utf8"), original);
        assert.equal(await fingerprint(target), before);
    } finally {
        await cleanup(target, home);
    }
});

test("unowned aeo-antigravity MCP entry aborts without writes", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const mcpPath = path.join(target, ".mcp.json");
        const original = `${JSON.stringify({ mcpServers: { "aeo-antigravity": { command: "node", args: ["user.js"] }, docs: USER_MCP.mcpServers.docs } }, null, 2)}\n`;
        await writeFile(mcpPath, original);
        const before = await fingerprint(target);
        const result = await install(baseOptions(target, home));
        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.match(result.conflicts.join("\n"), /does not own it/);
        assert.equal(await readFile(mcpPath, "utf8"), original);
        assert.equal(await fingerprint(target), before);
    } finally {
        await cleanup(target, home);
    }
});

test("npm ci failure does not activate MCP configuration", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const configPath = path.join(target, ".codex", "config.toml");
        const agentsPath = path.join(target, "AGENTS.md");
        const beforeConfig = await readFile(configPath, "utf8");
        const beforeAgents = await readFile(agentsPath, "utf8");
        const result = await install(baseOptions(target, home, {
            npmCi: async () => {
                throw new Error("npm ci failed for test");
            }
        }));
        assert.equal(result.ok, false);
        assert.match(result.error, /npm ci failed/);
        assert.equal(await readFile(configPath, "utf8"), beforeConfig);
        assert.equal(await readFile(agentsPath, "utf8"), beforeAgents);
        assert.equal(await exists(path.join(target, ".aeo", "install-manifest.json")), false);
        assert.equal((await readFile(configPath, "utf8")).includes("aeo-antigravity"), false);
        assert.match(result.error, /not owned/);
        const bridge = path.join(target, ".aeo", "bridge", "antigravity-mcp", "index.js");
        const bridgeBytes = await readFile(bridge);
        const retry = await install(baseOptions(target, home, {
            forceManagedUpdate: true,
            npmCi: async () => {
                throw new Error("npm should not run");
            }
        }));
        assert.equal(retry.ok, false);
        assert.equal(retry.wrote, false);
        assert.match(retry.conflicts.join("\n"), /cannot prove that AEO owns it/);
        assert.equal(retry.unchanged.includes(".aeo/bridge/antigravity-mcp/index.js"), false);
        assert.deepEqual(await readFile(bridge), bridgeBytes);
        const removed = await uninstall({ target });
        assert.equal(removed.ok, false);
        assert.deepEqual(await readFile(bridge), bridgeBytes);
    } finally {
        await cleanup(target, home);
    }
});

test("installing only one integration leaves the other configuration untouched", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const agentsBefore = await readFile(path.join(target, "AGENTS.md"));
        const configBefore = await readFile(path.join(target, ".codex", "config.toml"));
        const claude = await install(baseOptions(target, home, { codex: false, claude: true }));
        assert.equal(claude.ok, true, claude.error || "");
        assert.deepEqual(await readFile(path.join(target, "AGENTS.md")), agentsBefore);
        assert.deepEqual(await readFile(path.join(target, ".codex", "config.toml")), configBefore);
        assert.equal(await exists(path.join(target, ".codex", "agents", "aeo-explorer.toml")), false);
        assert.equal(await exists(path.join(target, ".claude", "rules", "aeo-orchestration.md")), true);
        await uninstall({ target });

        const claudeBefore = await readFile(path.join(target, "CLAUDE.md"));
        const mcpBefore = await readFile(path.join(target, ".mcp.json"));
        const settingsBefore = await readFile(path.join(target, ".claude", "settings.local.json"));
        const codex = await install(baseOptions(target, home, { codex: true, claude: false }));
        assert.equal(codex.ok, true, codex.error || "");
        assert.deepEqual(await readFile(path.join(target, "CLAUDE.md")), claudeBefore);
        assert.deepEqual(await readFile(path.join(target, ".mcp.json")), mcpBefore);
        assert.deepEqual(await readFile(path.join(target, ".claude", "settings.local.json")), settingsBefore);
        assert.equal(await exists(path.join(target, ".claude", "agents", "aeo-explorer.md")), false);
        assert.equal(await exists(path.join(target, ".codex", "agents", "aeo-explorer.toml")), true);
    } finally {
        await cleanup(target, home);
    }
});

test("missing tool flags do not guess", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const before = await fingerprint(target);
        await assert.rejects(() => install(baseOptions(target, home, { codex: false, claude: false })));
        assert.equal(await fingerprint(target), before);
        const cliResult = spawnSync(process.execPath, [cli, "install", "--target", target], { encoding: "utf8" });
        assert.equal(cliResult.status, 1);
        assert.match(cliResult.stderr, /--codex/);
    } finally {
        await cleanup(target, home);
    }
});

test("a pre-existing AEO permission is not claimed or removed", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const settings = {
            permissions: {
                allow: [...PERMISSIONS, "Bash(git status*)"],
                deny: ["Bash(git push*)"]
            }
        };
        const original = `${JSON.stringify(settings, null, 2)}\n`;
        await writeFile(path.join(target, ".claude", "settings.local.json"), original);
        const result = await install(baseOptions(target, home));
        assert.equal(result.ok, true, result.error || "");
        assert.match(result.warnings.join("\n"), /will not claim/);
        assert.equal(await readFile(path.join(target, ".claude", "settings.local.json"), "utf8"), original);
        const manifest = JSON.parse(await readFile(path.join(target, ".aeo", "install-manifest.json"), "utf8"));
        assert.equal(manifest.mergedEntries.some((entry) => entry.path === "permissions.allow"), false);
        await uninstall({ target });
        assert.equal(await readFile(path.join(target, ".claude", "settings.local.json"), "utf8"), original);
    } finally {
        await cleanup(target, home);
    }
});

test("removePermission does not strip permissions recorded for a different file", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const settings = {
            permissions: {
                allow: [PERMISSION, "Bash(git status*)"]
            }
        };
        const settingsPath = path.join(target, ".claude", "settings.local.json");
        await mkdir(path.dirname(settingsPath), { recursive: true });
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

        const manifest = {
            schemaVersion: 2,
            aeoVersion: "1.0.0",
            projectId: "test",
            targets: ["claude"],
            createdFiles: [],
            installedFiles: [],
            managedBlocks: [],
            mergedEntries: [
                {
                    file: ".claude/other-settings.json",
                    path: "permissions.allow",
                    value: PERMISSION
                }
            ]
        };
        const manifestDir = path.join(target, ".aeo");
        await mkdir(manifestDir, { recursive: true });
        await writeFile(path.join(manifestDir, "install-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

        const removed = await uninstall({ target });
        assert.equal(removed.ok, true, removed.error || "");
        const settingsAfter = JSON.parse(await readFile(settingsPath, "utf8"));
        assert.equal(settingsAfter.permissions.allow.includes(PERMISSION), true, "permission recorded for other file must not be removed");
    } finally {
        await cleanup(target, home);
    }
});

test("a pre-existing namespaced agent file that AEO does not own aborts", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const agent = path.join(target, ".codex", "agents", "aeo-explorer.toml");
        await writeFile(agent, "name = \"aeo_explorer\"\nUSER OWNED\n");
        const before = await fingerprint(target);
        const result = await install(baseOptions(target, home));
        assert.equal(result.ok, false);
        assert.match(result.conflicts.join("\n"), /does not own it/);
        assert.equal(await readFile(agent, "utf8"), "name = \"aeo_explorer\"\nUSER OWNED\n");
        assert.equal(await fingerprint(target), before);
    } finally {
        await cleanup(target, home);
    }
});

test("an AGENTS.md created by AEO is removed when nothing user-owned remains", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "aeo-empty-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-home-"));
    try {
        const result = await install(baseOptions(target, home, { claude: false }));
        assert.equal(result.ok, true, result.error || "");
        assert.equal(await exists(path.join(target, "AGENTS.md")), true);
        const removed = await uninstall({ target });
        assert.equal(removed.ok, true, removed.error || "");
        assert.equal(await exists(path.join(target, "AGENTS.md")), false);
        assert.equal(await exists(path.join(target, ".codex", "config.toml")), false);
    } finally {
        await cleanup(target, home);
    }
});

test("uninstall without a manifest does not guess", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const agent = path.join(target, ".codex", "agents", "aeo-explorer.toml");
        await writeFile(agent, "name = \"aeo_explorer\"\n");
        const result = await uninstall({ target });
        assert.equal(result.ok, false);
        assert.match(result.error, /manifest/);
        assert.equal(await exists(agent), true);
    } finally {
        await cleanup(target, home);
    }
});

test("doctor and status do not mutate the project", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const installed = await install(baseOptions(target, home));
        assert.equal(installed.ok, true, installed.error || "");
        const before = await fingerprint(target);
        const beforeHome = await fingerprint(home);
        const health = await doctor({ target });
        const report = await status({ target, homeDir: home });
        assert.equal(health.ok, true, health.problems.join("\n"));
        assert.equal(report.codex.orchestrationBlock, true);
        assert.equal(report.codex.configBlock, true);
        assert.equal(report.codex.server, true);
        assert.equal(report.claude.rule, true);
        assert.equal(report.claude.server, true);
        assert.equal(report.claude.permission, true);
        assert.equal(report.bridge.filesPresent, true);
        assert.equal(report.bridge.dependenciesInstalled, true);
        assert.match(report.trustNote, /does not change trust/);
        assert.equal(await fingerprint(target), before);
        assert.equal(await fingerprint(home), beforeHome);
    } finally {
        await cleanup(target, home);
    }
});

test("an existing AEO block without manifest ownership is not replaced", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const agentsPath = path.join(target, "AGENTS.md");
        const seeded = `${USER_AGENTS}${AGENTS_BEGIN}\nold policy\n${AGENTS_END}\nAFTER\n`;
        await writeFile(agentsPath, seeded);
        const before = await fingerprint(target);
        const result = await install(baseOptions(target, home));
        assert.equal(result.ok, false);
        assert.equal(result.wrote, false);
        assert.match(result.conflicts.join("\n"), /cannot prove ownership/);
        assert.match(result.ownershipUnknown.join("\n"), /AGENTS.md/);
        assert.equal(await readFile(agentsPath, "utf8"), seeded);
        assert.equal((seeded.match(/AEO:BEGIN ORCHESTRATION/g) || []).length, 1);
        assert.equal(await exists(path.join(target, ".aeo", "install-manifest.json")), false);
        assert.equal(await fingerprint(target), before);
    } finally {
        await cleanup(target, home);
    }
});

test("a timed-out npm ci does not activate MCP configuration", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const configPath = path.join(target, ".codex", "config.toml");
        const before = await readFile(configPath, "utf8");
        const child = new EventEmitter();
        child.pid = 5150;
        child.stderr = new EventEmitter();
        child.kill = () => true;
        const result = await install(baseOptions(target, home, {
            npmCi: (cwd) => defaultNpmCi(cwd, {
                timeoutMs: 30,
                spawnImpl: () => child,
                terminateProcess: (targetChild) => {
                    targetChild.emit("close", null);
                },
                timers: {
                    setTimeout: (fn) => {
                        queueMicrotask(fn);
                        return { id: "npm-timeout" };
                    },
                    clearTimeout: () => {}
                }
            })
        }));
        assert.equal(result.ok, false);
        assert.match(result.error, /timed out after 0.03 seconds while installing the AEO Antigravity MCP bridge/);
        assert.equal(await readFile(configPath, "utf8"), before);
        assert.equal((await readFile(configPath, "utf8")).includes("[mcp_servers.aeo-antigravity]"), false);
        assert.equal(await exists(path.join(target, ".aeo", "install-manifest.json")), false);
    } finally {
        await cleanup(target, home);
    }
});

test("backup file and directory permissions are restricted to owner (0600 / 0700)", {
    skip: process.platform === "win32" ? "POSIX file permissions do not apply on Windows" : false
}, async () => {
    const { target, home } = await makeWorkspace();
    try {
        const result = await install(baseOptions(target, home));
        assert.equal(result.ok, true, result.error || "");
        assert.ok(result.backupFiles.length > 0, "install should produce backup files");
        for (const backupPath of result.backupFiles) {
            const fileStat = await stat(backupPath);
            assert.equal(fileStat.mode & 0o777, 0o600, `backup file ${backupPath} mode should be 0o600`);
            const dirStat = await stat(path.dirname(backupPath));
            assert.equal(dirStat.mode & 0o777, 0o700, `backup directory ${path.dirname(backupPath)} mode should be 0o700`);
        }
    } finally {
        await cleanup(target, home);
    }
});

test("fresh install adds all three permissions and manifest has three permission entries", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const result = await install(baseOptions(target, home));
        assert.equal(result.ok, true, result.error || "");
        const settings = JSON.parse(await readFile(path.join(target, ".claude", "settings.local.json"), "utf8"));
        for (const perm of PERMISSIONS) {
            assert.ok(settings.permissions.allow.includes(perm), `settings should include ${perm}`);
        }
        const manifest = JSON.parse(await readFile(path.join(target, ".aeo", "install-manifest.json"), "utf8"));
        const permEntries = manifest.mergedEntries.filter((e) => e.path === "permissions.allow");
        assert.equal(permEntries.length, 3);
        for (const perm of PERMISSIONS) {
            assert.ok(permEntries.some((e) => e.value === perm), `manifest should own ${perm}`);
        }
    } finally {
        await cleanup(target, home);
    }
});

test("upgrade from an old manifest adds the two new permissions and claims them while delegate stays claimed", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const settingsPath = path.join(target, ".claude", "settings.local.json");
        await writeFile(settingsPath, `${JSON.stringify({
            permissions: {
                allow: ["Bash(git status*)", PERMISSION],
                deny: ["Bash(git push*)"]
            },
            extra: true
        }, null, 2)}\n`);

        const manifestPath = path.join(target, ".aeo", "install-manifest.json");
        await mkdir(path.dirname(manifestPath), { recursive: true });
        await writeFile(manifestPath, `${JSON.stringify({
            schemaVersion: 2,
            aeoVersion: "1.0.0",
            projectId: projectId(target),
            targets: ["claude"],
            createdFiles: [],
            installedFiles: [],
            managedBlocks: [],
            mergedEntries: [
                { file: ".claude/settings.local.json", path: "permissions.allow", value: PERMISSION }
            ]
        }, null, 2)}\n`);

        const upgraded = await install(baseOptions(target, home, { codex: false, claude: true }));
        assert.equal(upgraded.ok, true, upgraded.error || "");

        const settingsAfter = JSON.parse(await readFile(settingsPath, "utf8"));
        for (const perm of PERMISSIONS) {
            assert.ok(settingsAfter.permissions.allow.includes(perm), `settings should have ${perm}`);
        }

        const manifestAfter = JSON.parse(await readFile(manifestPath, "utf8"));
        const permEntries = manifestAfter.mergedEntries.filter((e) => e.path === "permissions.allow");
        assert.equal(permEntries.length, 3);
        for (const perm of PERMISSIONS) {
            assert.ok(permEntries.some((e) => e.value === perm), `manifest should own ${perm}`);
        }
    } finally {
        await cleanup(target, home);
    }
});

test("user pre-existing unowned apply_delegation permission is not claimed and warning emitted while others added; with adopt it is claimed", async () => {
    const unownedPerm = "mcp__aeo-antigravity__apply_delegation";

    // Part A: Without adopt
    {
        const { target, home } = await makeWorkspace();
        try {
            const settingsPath = path.join(target, ".claude", "settings.local.json");
            await writeFile(settingsPath, `${JSON.stringify({
                permissions: {
                    allow: ["Bash(git status*)", unownedPerm],
                    deny: ["Bash(git push*)"]
                },
                extra: true
            }, null, 2)}\n`);

            const result = await install(baseOptions(target, home, { codex: false, claude: true }));
            assert.equal(result.ok, true, result.error || "");
            assert.ok(result.warnings.some((w) => w.includes("will not claim") && w.includes(unownedPerm)));

            const settings = JSON.parse(await readFile(settingsPath, "utf8"));
            for (const perm of PERMISSIONS) {
                assert.ok(settings.permissions.allow.includes(perm));
            }

            const manifest = JSON.parse(await readFile(path.join(target, ".aeo", "install-manifest.json"), "utf8"));
            const permEntries = manifest.mergedEntries.filter((e) => e.path === "permissions.allow");
            assert.equal(permEntries.length, 2);
            assert.equal(permEntries.some((e) => e.value === unownedPerm), false);
            assert.ok(permEntries.some((e) => e.value === PERMISSION));
            assert.ok(permEntries.some((e) => e.value === "mcp__aeo-antigravity__discard_delegation"));

            const unres = await uninstall({ target });
            assert.equal(unres.ok, true, unres.error || "");
            const settingsFinal = JSON.parse(await readFile(settingsPath, "utf8"));
            assert.deepEqual(settingsFinal.permissions.allow, ["Bash(git status*)", unownedPerm]);
        } finally {
            await cleanup(target, home);
        }
    }

    // Part B: With adopt (in global mode where adopt is supported)
    {
        const home = await mkdtemp(path.join(os.tmpdir(), "aeo-adopt-home-"));
        try {
            const settingsPath = path.join(home, ".claude", "settings.json");
            await mkdir(path.dirname(settingsPath), { recursive: true });
            await writeFile(settingsPath, `${JSON.stringify({
                permissions: { allow: [unownedPerm] }
            }, null, 2)}\n`);

            const result = await install({
                global: true,
                homeDir: home,
                repoRoot,
                npmCi: fakeNpmCi,
                codex: false,
                claude: true,
                adopt: true
            });
            assert.equal(result.ok, true, result.error || "");
            assert.equal(result.warnings.some((w) => w.includes(unownedPerm)), false);

            const manifest = JSON.parse(await readFile(path.join(home, ".aeo", "global-install-manifest.json"), "utf8"));
            const permEntries = manifest.mergedEntries.filter((e) => e.path === "permissions.allow");
            assert.equal(permEntries.length, 3);
            assert.ok(permEntries.some((e) => e.value === unownedPerm));
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
});

test("uninstall removes only owned values; a user-owned copy survives; old-manifest uninstall removes only delegate", async () => {
    // Sub-case 1: User-added copy survives uninstall
    {
        const { target, home } = await makeWorkspace();
        try {
            const settingsPath = path.join(target, ".claude", "settings.local.json");
            await writeFile(settingsPath, `${JSON.stringify({
                permissions: { allow: ["mcp__aeo-antigravity__apply_delegation"] }
            }, null, 2)}\n`);

            const result = await install(baseOptions(target, home, { codex: false, claude: true }));
            assert.equal(result.ok, true);

            const removed = await uninstall({ target });
            assert.equal(removed.ok, true);
            const settingsFinal = JSON.parse(await readFile(settingsPath, "utf8"));
            assert.deepEqual(settingsFinal.permissions.allow, ["mcp__aeo-antigravity__apply_delegation"]);
        } finally {
            await cleanup(target, home);
        }
    }

    // Sub-case 2: Old manifest only owns delegate; uninstall removes only delegate
    {
        const { target, home } = await makeWorkspace();
        try {
            const settingsPath = path.join(target, ".claude", "settings.local.json");
            await writeFile(settingsPath, `${JSON.stringify({
                permissions: { allow: [PERMISSION, "mcp__aeo-antigravity__apply_delegation"] }
            }, null, 2)}\n`);

            const manifestPath = path.join(target, ".aeo", "install-manifest.json");
            await mkdir(path.dirname(manifestPath), { recursive: true });
            await writeFile(manifestPath, `${JSON.stringify({
                schemaVersion: 2,
                aeoVersion: "1.0.0",
                projectId: projectId(target),
                targets: ["claude"],
                createdFiles: [],
                installedFiles: [],
                managedBlocks: [],
                mergedEntries: [
                    { file: ".claude/settings.local.json", path: "permissions.allow", value: PERMISSION }
                ]
            }, null, 2)}\n`);

            const removed = await uninstall({ target });
            assert.equal(removed.ok, true, removed.error || "");
            const settingsFinal = JSON.parse(await readFile(settingsPath, "utf8"));
            assert.deepEqual(settingsFinal.permissions.allow, ["mcp__aeo-antigravity__apply_delegation"]);
        } finally {
            await cleanup(target, home);
        }
    }
});

test("status reports per-permission booleans and permission false when one is missing", async () => {
    const { target, home } = await makeWorkspace();
    try {
        const settingsPath = path.join(target, ".claude", "settings.local.json");
        // Include delegate and apply, but omit discard
        await writeFile(settingsPath, `${JSON.stringify({
            permissions: {
                allow: [
                    PERMISSION,
                    "mcp__aeo-antigravity__apply_delegation"
                ]
            }
        }, null, 2)}\n`);

        const rep = await status({ target, homeDir: home });
        assert.equal(rep.claude.permission, false);
        assert.equal(rep.claude.permissions[PERMISSION], true);
        assert.equal(rep.claude.permissions["mcp__aeo-antigravity__apply_delegation"], true);
        assert.equal(rep.claude.permissions["mcp__aeo-antigravity__discard_delegation"], false);

        // Now add discard_delegation
        await writeFile(settingsPath, `${JSON.stringify({
            permissions: {
                allow: PERMISSIONS
            }
        }, null, 2)}\n`);

        const repComplete = await status({ target, homeDir: home });
        assert.equal(repComplete.claude.permission, true);
        for (const perm of PERMISSIONS) {
            assert.equal(repComplete.claude.permissions[perm], true);
        }
    } finally {
        await cleanup(target, home);
    }
});

test("codex block contains three tools; unmodified old block refreshed on update; user-modified block still preserved", async () => {
    // Part A: Unmodified old block refreshed on update
    {
        const { target, home } = await makeWorkspace();
        try {
            const first = await install(baseOptions(target, home, { codex: true, claude: false }));
            assert.equal(first.ok, true, first.error || "");

            const configPath = path.join(target, ".codex", "config.toml");
            const manifestPath = path.join(target, ".aeo", "install-manifest.json");

            const currentConfig = await readFile(configPath, "utf8");
            assert.match(currentConfig, /enabled_tools = \["delegate_antigravity", "apply_delegation", "discard_delegation"\]/);

            const oldConfigBlock = currentConfig.replace(
                'enabled_tools = ["delegate_antigravity", "apply_delegation", "discard_delegation"]',
                'enabled_tools = ["delegate_antigravity"]'
            );
            await writeFile(configPath, oldConfigBlock);

            const innerOld = oldConfigBlock.slice(
                oldConfigBlock.indexOf(CONFIG_BEGIN) + CONFIG_BEGIN.length,
                oldConfigBlock.indexOf(CONFIG_END)
            );
            const oldHash = createHash("sha256").update(Buffer.from(innerOld, "utf8")).digest("hex");

            const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
            const block = manifest.managedBlocks.find((b) => b.id === "AEO_CONFIG");
            block.sha256 = oldHash;
            await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

            const updated = await install(baseOptions(target, home, { codex: true, claude: false, npmCi: async () => {} }));
            assert.equal(updated.ok, true, updated.error || "");
            assert.ok(updated.safeUpdate.includes(".codex/config.toml AEO config block"));

            const refreshedConfig = await readFile(configPath, "utf8");
            assert.match(refreshedConfig, /enabled_tools = \["delegate_antigravity", "apply_delegation", "discard_delegation"\]/);
        } finally {
            await cleanup(target, home);
        }
    }

    // Part B: User-modified block preserved (drift protection)
    {
        const { target, home } = await makeWorkspace();
        try {
            const first = await install(baseOptions(target, home, { codex: true, claude: false }));
            assert.equal(first.ok, true, first.error || "");

            const configPath = path.join(target, ".codex", "config.toml");
            const originalConfig = await readFile(configPath, "utf8");

            const modifiedConfig = originalConfig.replace(CONFIG_BEGIN, `${CONFIG_BEGIN}\n# USER CUSTOM EDIT`);
            await writeFile(configPath, modifiedConfig);

            const second = await install(baseOptions(target, home, { codex: true, claude: false, npmCi: async () => {} }));
            assert.equal(second.ok, true, second.error || "");
            assert.ok(second.userModified.includes(".codex/config.toml AEO config block"));

            const preservedConfig = await readFile(configPath, "utf8");
            assert.match(preservedConfig, /# USER CUSTOM EDIT/);
        } finally {
            await cleanup(target, home);
        }
    }
});

