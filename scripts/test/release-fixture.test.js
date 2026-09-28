import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PERMISSION, PERMISSIONS, install, uninstall } from "../lib/installer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function exists(file) {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

async function fixtureNpmCi(cwd) {
    await mkdir(path.join(cwd, "node_modules"), { recursive: true });
    await writeFile(path.join(cwd, "node_modules", ".aeo-fixture"), "ok\n");
}

test("release fixture survives install, reinstall, and uninstall without a live npm registry", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "aeo-release-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-release-home-"));
    const agents = "# Architecture\nDo not change the billing schema.\n";
    const config = `model = "gpt-6-astra"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[mcp_servers.docs]
command = "node"
args = ["docs.js"]

[agents.custom_reviewer]
description = "Existing reviewer"
config_file = "C:/custom/reviewer.toml"
`;
    const claude = "# Domain\nKeep the public checkout API.\n";
    const mcp = { mcpServers: { docs: { command: "node", args: ["docs.js"] } } };
    const settings = { permissions: { allow: ["Bash(git diff*)"], deny: ["Bash(git reset*)"] } };
    try {
        await mkdir(path.join(target, ".codex", "agents"), { recursive: true });
        await mkdir(path.join(target, ".claude", "agents"), { recursive: true });
        await mkdir(path.join(home, ".codex"), { recursive: true });
        await writeFile(path.join(target, "AGENTS.md"), agents);
        await writeFile(path.join(target, ".codex", "config.toml"), config);
        await writeFile(path.join(target, "CLAUDE.md"), claude);
        await writeFile(path.join(target, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);
        await writeFile(path.join(target, ".claude", "settings.local.json"), `${JSON.stringify(settings, null, 2)}\n`);
        await writeFile(path.join(target, ".claude", "agents", "security.md"), "USER SECURITY AGENT\n");
        await writeFile(path.join(target, ".codex", "agents", "custom.toml"), "name = \"custom\"\n");
        await writeFile(path.join(home, ".codex", "config.toml"), "model = \"global-only\"\n");

        const options = { target, homeDir: home, repoRoot, codex: true, claude: true, npmCi: fixtureNpmCi };
        const first = await install(options);
        assert.equal(first.ok, true, first.error || (first.conflicts || []).join("\n"));
        const bridge = path.join(target, ".aeo", "bridge", "antigravity-mcp");
        assert.equal(await exists(path.join(bridge, "node_modules", ".aeo-fixture")), true);
        assert.equal(await exists(path.join(bridge, "package.json")), true);
        assert.equal(await exists(path.join(bridge, "package-lock.json")), true);
        assert.equal(await exists(path.join(bridge, "test")), false);
        const installedConfig = await readFile(path.join(target, ".codex", "config.toml"), "utf8");
        assert.equal(installedConfig.startsWith(config), true);
        assert.match(installedConfig, /\[mcp_servers\.aeo-antigravity\]/);
        const tomlCommands = [
            ["python3", ["-c", "import tomllib,sys; tomllib.loads(sys.stdin.read())"]],
            ["python", ["-c", "import tomllib,sys; tomllib.loads(sys.stdin.read())"]],
            ["py", ["-3", "-c", "import tomllib,sys; tomllib.loads(sys.stdin.read())"]]
        ];
        let tomlError = "Python 3.11+ with tomllib was not available";
        let tomlOk = false;
        for (const [command, args] of tomlCommands) {
            const toml = spawnSync(command, args, { input: installedConfig, encoding: "utf8" });
            if (toml.error) {
                tomlError = toml.error.message;
                continue;
            }
            if (toml.status === 0) {
                tomlOk = true;
                break;
            }
            tomlError = toml.stderr || toml.stdout || tomlError;
        }
        assert.equal(tomlOk, true, tomlError);
        assert.equal((await readFile(path.join(target, "AGENTS.md"), "utf8")).startsWith(agents), true);
        assert.equal(await readFile(path.join(target, "CLAUDE.md"), "utf8"), claude);
        assert.equal(await readFile(path.join(target, ".claude", "agents", "security.md"), "utf8"), "USER SECURITY AGENT\n");
        assert.equal(await readFile(path.join(home, ".codex", "config.toml"), "utf8"), "model = \"global-only\"\n");

        const second = await install(options);
        assert.equal(second.ok, true, second.error || "");
        assert.equal(second.wrote, false);
        const mcpAfter = JSON.parse(await readFile(path.join(target, ".mcp.json"), "utf8"));
        assert.deepEqual(mcpAfter.mcpServers.docs, mcp.mcpServers.docs);
        assert.equal(Object.keys(mcpAfter.mcpServers).filter((key) => key === "aeo-antigravity").length, 1);
        const settingsAfter = JSON.parse(await readFile(path.join(target, ".claude", "settings.local.json"), "utf8"));
        for (const perm of PERMISSIONS) {
            assert.equal(settingsAfter.permissions.allow.filter((entry) => entry === perm).length, 1);
        }

        const removed = await uninstall({ target });
        assert.equal(removed.ok, true, removed.error || "");
        const configFinal = await readFile(path.join(target, ".codex", "config.toml"), "utf8");
        assert.match(configFinal, /gpt-6-astra/);
        assert.match(configFinal, /custom_reviewer/);
        assert.equal(configFinal.includes("aeo-antigravity"), false);
        assert.match(await readFile(path.join(target, "AGENTS.md"), "utf8"), /billing schema/);
        assert.equal((await readFile(path.join(target, "AGENTS.md"), "utf8")).includes("AEO:BEGIN"), false);
        assert.equal(await readFile(path.join(target, "CLAUDE.md"), "utf8"), claude);
        const mcpFinal = JSON.parse(await readFile(path.join(target, ".mcp.json"), "utf8"));
        assert.deepEqual(mcpFinal, mcp);
        const settingsFinal = JSON.parse(await readFile(path.join(target, ".claude", "settings.local.json"), "utf8"));
        assert.deepEqual(settingsFinal, settings);
        assert.equal(await readFile(path.join(target, ".codex", "agents", "custom.toml"), "utf8"), "name = \"custom\"\n");
        assert.equal(await readFile(path.join(target, ".claude", "agents", "security.md"), "utf8"), "USER SECURITY AGENT\n");
        assert.equal(await exists(path.join(target, ".aeo")), false);
        assert.equal(await readFile(path.join(home, ".codex", "config.toml"), "utf8"), "model = \"global-only\"\n");
    } finally {
        await rm(target, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
    }
});
