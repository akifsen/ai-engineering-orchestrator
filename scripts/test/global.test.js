import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    TRUST_NOTE_GLOBAL,
    doctor,
    formatPlan,
    install,
    status,
    uninstall
} from "../lib/installer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts", "aeo.mjs");

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

function globalOptions(home, extra = {}) {
    return {
        global: true,
        homeDir: home,
        repoRoot,
        npmCi: fakeNpmCi,
        codex: true,
        claude: true,
        ...extra
    };
}

function toPosix(filePath) {
    return filePath.replaceAll("\\", "/");
}

test("case a: global install creates all expected files, entries, and blocks", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-a-"));
    try {
        const result = await install(globalOptions(home));
        assert.equal(result.ok, true, result.error);

        // ~/.claude/rules/aeo-orchestration.md
        assert.equal(await exists(path.join(home, ".claude", "rules", "aeo-orchestration.md")), true);

        // ~/.claude/agents/aeo-*.md
        for (const name of ["aeo-explorer.md", "aeo-architect.md", "aeo-reviewer.md", "aeo-fast-worker.md"]) {
            assert.equal(await exists(path.join(home, ".claude", "agents", name)), true);
        }

        // ~/.claude.json mcpServers.aeo-antigravity
        assert.equal(await exists(path.join(home, ".claude.json")), true);
        const claudeJson = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
        assert.ok(claudeJson.mcpServers && claudeJson.mcpServers["aeo-antigravity"]);
        assert.equal(claudeJson.mcpServers["aeo-antigravity"].command, "node");

        // ~/.claude/settings.json allow entry
        assert.equal(await exists(path.join(home, ".claude", "settings.json")), true);
        const settingsJson = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
        assert.ok(settingsJson.permissions?.allow?.includes(PERMISSION));

        // ~/.codex/agents/aeo_*.toml
        for (const name of ["aeo-explorer.toml", "aeo-architect.toml", "aeo-reviewer.toml", "aeo-fast-worker.toml"]) {
            assert.equal(await exists(path.join(home, ".codex", "agents", name)), true);
        }

        // ~/.codex/config.toml AEO block
        assert.equal(await exists(path.join(home, ".codex", "config.toml")), true);
        const configToml = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
        assert.ok(configToml.includes(CONFIG_BEGIN));
        assert.ok(configToml.includes(CONFIG_END));
        assert.ok(configToml.includes("[mcp_servers.aeo-antigravity]"));

        // ~/.codex/AGENTS.md AEO block
        assert.equal(await exists(path.join(home, ".codex", "AGENTS.md")), true);
        const agentsMd = await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8");
        assert.ok(agentsMd.includes(AGENTS_BEGIN));
        assert.ok(agentsMd.includes(AGENTS_END));

        // ~/.aeo/global-install-manifest.json
        assert.equal(await exists(path.join(home, ".aeo", "global-install-manifest.json")), true);
        const manifest = JSON.parse(await readFile(path.join(home, ".aeo", "global-install-manifest.json"), "utf8"));
        assert.equal(manifest.projectId, "global");
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case b: second install is idempotent; status and doctor report no problems", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-b-"));
    try {
        const first = await install(globalOptions(home));
        assert.equal(first.ok, true);

        const second = await install(globalOptions(home));
        assert.equal(second.ok, true);
        assert.equal(second.changed.length, 0);

        const stat = await status(globalOptions(home));
        assert.equal(stat.installed, true);
        assert.equal(stat.codex.orchestrationBlock, true);
        assert.equal(stat.codex.configBlock, true);
        assert.equal(stat.codex.server, true);
        assert.equal(stat.claude.rule, true);
        assert.equal(stat.claude.server, true);
        assert.equal(stat.claude.permission, true);
        assert.equal(stat.trustNote, TRUST_NOTE_GLOBAL);

        const doc = await doctor(globalOptions(home));
        assert.equal(doc.ok, true, doc.problems.join("; "));
        assert.equal(doc.problems.length, 0);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case c: unrelated keys in ~/.claude.json, ~/.claude/settings.json and other tables in ~/.codex/config.toml survive install and uninstall", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-c-"));
    try {
        await writeFile(path.join(home, ".claude.json"), JSON.stringify({
            unrelatedKey: "preserved-claude",
            mcpServers: {
                "other-server": { command: "node", args: ["other.js"] }
            }
        }, null, 2));

        await mkdir(path.join(home, ".claude"), { recursive: true });
        await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({
            unrelatedSetting: true,
            permissions: {
                allow: ["unrelated-allow"]
            }
        }, null, 2));

        await mkdir(path.join(home, ".codex"), { recursive: true });
        await writeFile(path.join(home, ".codex", "config.toml"), `model = "gpt-5"

[user_table]
custom_setting = "yes"
`);

        const installResult = await install(globalOptions(home));
        assert.equal(installResult.ok, true);

        // Verify post-install state
        const claudeJsonPostInstall = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
        assert.equal(claudeJsonPostInstall.unrelatedKey, "preserved-claude");
        assert.ok(claudeJsonPostInstall.mcpServers["other-server"]);
        assert.ok(claudeJsonPostInstall.mcpServers["aeo-antigravity"]);

        const settingsPostInstall = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
        assert.equal(settingsPostInstall.unrelatedSetting, true);
        assert.ok(settingsPostInstall.permissions.allow.includes("unrelated-allow"));
        assert.ok(settingsPostInstall.permissions.allow.includes(PERMISSION));

        const configPostInstall = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
        assert.ok(configPostInstall.includes("[user_table]"));
        assert.ok(configPostInstall.includes('custom_setting = "yes"'));
        assert.ok(configPostInstall.includes(CONFIG_BEGIN));

        // Uninstall
        const uninstallResult = await uninstall(globalOptions(home));
        assert.equal(uninstallResult.ok, true);

        // Verify post-uninstall state: files survive and unrelated keys remain intact
        assert.equal(await exists(path.join(home, ".claude.json")), true);
        const claudeJsonPostUninstall = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
        assert.equal(claudeJsonPostUninstall.unrelatedKey, "preserved-claude");
        assert.ok(claudeJsonPostUninstall.mcpServers["other-server"]);
        assert.equal(claudeJsonPostUninstall.mcpServers["aeo-antigravity"], undefined);

        assert.equal(await exists(path.join(home, ".claude", "settings.json")), true);
        const settingsPostUninstall = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
        assert.equal(settingsPostUninstall.unrelatedSetting, true);
        assert.ok(settingsPostUninstall.permissions.allow.includes("unrelated-allow"));
        assert.equal(settingsPostUninstall.permissions.allow.includes(PERMISSION), false);

        assert.equal(await exists(path.join(home, ".codex", "config.toml")), true);
        const configPostUninstall = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
        assert.ok(configPostUninstall.includes("[user_table]"));
        assert.ok(configPostUninstall.includes('custom_setting = "yes"'));
        assert.equal(configPostUninstall.includes(CONFIG_BEGIN), false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case d: uninstall removes owned files/entries/blocks", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-d-"));
    try {
        const installResult = await install(globalOptions(home));
        assert.equal(installResult.ok, true);

        const uninstallResult = await uninstall(globalOptions(home));
        assert.equal(uninstallResult.ok, true);

        assert.equal(await exists(path.join(home, ".claude", "rules", "aeo-orchestration.md")), false);
        for (const name of ["aeo-explorer.md", "aeo-architect.md", "aeo-reviewer.md", "aeo-fast-worker.md"]) {
            assert.equal(await exists(path.join(home, ".claude", "agents", name)), false);
        }
        assert.equal(await exists(path.join(home, ".claude.json")), false);
        assert.equal(await exists(path.join(home, ".claude", "settings.json")), false);
        for (const name of ["aeo-explorer.toml", "aeo-architect.toml", "aeo-reviewer.toml", "aeo-fast-worker.toml"]) {
            assert.equal(await exists(path.join(home, ".codex", "agents", name)), false);
        }
        assert.equal(await exists(path.join(home, ".codex", "config.toml")), false);
        assert.equal(await exists(path.join(home, ".codex", "AGENTS.md")), false);
        assert.equal(await exists(path.join(home, ".aeo", "global-install-manifest.json")), false);
        assert.equal(await exists(path.join(home, ".aeo", "bridge")), false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case e: default preserves user text and appends block; with replaceCodexAgentsMd creates backup, replaces file, uninstall deletes when unchanged and preserves when edited", async () => {
    // Sub-case 1: Default install appends block and preserves user text
    {
        const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-e1-"));
        try {
            await mkdir(path.join(home, ".codex"), { recursive: true });
            const userText = "# Custom User Guidelines\nDo not violate them.\n";
            await writeFile(path.join(home, ".codex", "AGENTS.md"), userText);

            const res = await install(globalOptions(home));
            assert.equal(res.ok, true);

            const content = await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8");
            assert.ok(content.startsWith(userText));
            assert.ok(content.includes(AGENTS_BEGIN));
            assert.ok(content.includes(AGENTS_END));

            const unres = await uninstall(globalOptions(home));
            assert.equal(unres.ok, true);
            const preserved = await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8");
            assert.equal(preserved.trim(), userText.trim());
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }

    // Sub-case 2: With replaceCodexAgentsMd, backed up, replaced, deleted on uninstall when unchanged
    {
        const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-e2-"));
        try {
            await mkdir(path.join(home, ".codex"), { recursive: true });
            const userText = "# User AGENTS To Be Replaced\nOriginal text.\n";
            await writeFile(path.join(home, ".codex", "AGENTS.md"), userText);

            const res = await install(globalOptions(home, { replaceCodexAgentsMd: true }));
            assert.equal(res.ok, true);

            // Backup exists under ~/.aeo/backups/global/
            const backupDir = path.join(home, ".aeo", "backups", "global");
            assert.equal(await exists(backupDir), true);
            const stamps = await readdir(backupDir);
            assert.ok(stamps.length > 0);
            const backupContent = await readFile(path.join(backupDir, stamps[0], ".codex", "AGENTS.md"), "utf8");
            assert.equal(backupContent, userText);

            // File replaced
            const replaced = await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8");
            assert.equal(replaced.includes("# User AGENTS To Be Replaced"), false);
            assert.ok(replaced.includes("AEO orchestration rules"));

            // Uninstall when unchanged deletes the file
            const unres = await uninstall(globalOptions(home, { replaceCodexAgentsMd: true }));
            assert.equal(unres.ok, true);
            assert.equal(await exists(path.join(home, ".codex", "AGENTS.md")), false);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }

    // Sub-case 3: With replaceCodexAgentsMd, preserved on uninstall when edited
    {
        const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-e3-"));
        try {
            await mkdir(path.join(home, ".codex"), { recursive: true });
            await writeFile(path.join(home, ".codex", "AGENTS.md"), "# Initial\n");

            const res = await install(globalOptions(home, { replaceCodexAgentsMd: true }));
            assert.equal(res.ok, true);

            // User edits .codex/AGENTS.md after install
            await writeFile(path.join(home, ".codex", "AGENTS.md"), "# User Post-Install Edit\n", { flag: "a" });

            const unres = await uninstall(globalOptions(home, { replaceCodexAgentsMd: true }));
            assert.equal(unres.ok, true);
            assert.ok(unres.preserved.includes(".codex/AGENTS.md"));
            assert.equal(await exists(path.join(home, ".codex", "AGENTS.md")), true);
            const postUninstall = await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8");
            assert.ok(postUninstall.includes("# User Post-Install Edit"));
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
});

test("case f: pre-existing CRLF copies of Claude presets refused without adopt, accepted and owned with adopt, removed on uninstall", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-f-"));
    try {
        const ruleSrc = await readFile(path.join(repoRoot, "presets", "claude", "rules", "aeo-orchestration.md"), "utf8");
        const crlfRule = ruleSrc.replace(/\r?\n/g, "\r\n");
        await mkdir(path.join(home, ".claude", "rules"), { recursive: true });
        await writeFile(path.join(home, ".claude", "rules", "aeo-orchestration.md"), crlfRule);

        // Refused without adopt
        const rejected = await install(globalOptions(home, { adopt: false }));
        assert.equal(rejected.ok, false);
        const planText = formatPlan(rejected);
        assert.ok(planText.includes("Pass --adopt") || rejected.conflicts.some((c) => c.includes("Pass --adopt")));

        // Succeeded with adopt
        const adopted = await install(globalOptions(home, { adopt: true }));
        assert.equal(adopted.ok, true);
        const adoptedPlanText = formatPlan(adopted);
        assert.ok(adoptedPlanText.includes("ADOPTED: .claude/rules/aeo-orchestration.md"));
        assert.ok(adopted.adopted.includes(".claude/rules/aeo-orchestration.md"));

        // Uninstall removes them
        const unres = await uninstall(globalOptions(home));
        assert.equal(unres.ok, true);
        assert.equal(await exists(path.join(home, ".claude", "rules", "aeo-orchestration.md")), false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case g: pre-existing mcpServers.aeo-antigravity with matching command/args plus env {AGY_BIN: 'x'} adopted and env kept", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-g-"));
    try {
        const bridgeIndex = toPosix(path.join(home, ".aeo", "bridge", "antigravity-mcp", "index.js"));
        await writeFile(path.join(home, ".claude.json"), JSON.stringify({
            mcpServers: {
                "aeo-antigravity": {
                    command: "node",
                    args: [bridgeIndex],
                    env: { AGY_BIN: "x" }
                }
            }
        }, null, 2));

        const res = await install(globalOptions(home, { adopt: true }));
        assert.equal(res.ok, true);
        assert.ok(res.adopted.some((item) => item.includes("mcpServers.aeo-antigravity")));

        const claudeJson = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
        assert.deepEqual(claudeJson.mcpServers["aeo-antigravity"].env, { AGY_BIN: "x" });
        assert.equal(claudeJson.mcpServers["aeo-antigravity"].command, "node");
        assert.deepEqual(claudeJson.mcpServers["aeo-antigravity"].args, [bridgeIndex]);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case h: doctor with a project target that has its own install while global manifest exists produces coexistence warning, not a problem", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-h-"));
    const project = path.join(home, "project");
    await mkdir(project, { recursive: true });
    try {
        // Global install
        const globalRes = await install(globalOptions(home));
        assert.equal(globalRes.ok, true);

        // Project install
        const projectRes = await install(baseOptions(project, home));
        assert.equal(projectRes.ok, true);

        // Doctor on project
        const doc = await doctor(baseOptions(project, home));
        assert.equal(doc.ok, true);
        assert.equal(doc.problems.length, 0);
        assert.ok(doc.warnings.some((w) => w.includes("Both a global AEO installation and a project AEO installation exist")));
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case i: CLI rejects both --global with --target and neither --global nor --target", () => {
    const both = spawnSync(process.execPath, [cli, "install", "--global", "--target", "some/project", "--codex"], { encoding: "utf8" });
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /Pass either --target <project> or --global, not both\./);

    const neither = spawnSync(process.execPath, [cli, "install", "--codex"], { encoding: "utf8" });
    assert.notEqual(neither.status, 0);
    assert.match(neither.stderr, /Pass either --target <project> or --global, not both\./);
});

test("case j: after adopt install with env {AGY_BIN: 'x'}, a second plain install reports no changes and env is still present", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-j-"));
    try {
        const bridgeIndex = toPosix(path.join(home, ".aeo", "bridge", "antigravity-mcp", "index.js"));
        await writeFile(path.join(home, ".claude.json"), JSON.stringify({
            mcpServers: {
                "aeo-antigravity": {
                    command: "node",
                    args: [bridgeIndex],
                    env: { AGY_BIN: "x" }
                }
            }
        }, null, 2));

        const res1 = await install(globalOptions(home, { adopt: true }));
        assert.equal(res1.ok, true);

        // Second plain install without --adopt
        const res2 = await install(globalOptions(home));
        assert.equal(res2.ok, true);
        assert.equal(res2.changed.length, 0);
        assert.equal(res2.warnings.some((w) => w.includes("aeo-antigravity")), false);

        const claudeJson = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
        assert.deepEqual(claudeJson.mcpServers["aeo-antigravity"].env, { AGY_BIN: "x" });
        assert.equal(claudeJson.mcpServers["aeo-antigravity"].command, "node");
        assert.deepEqual(claudeJson.mcpServers["aeo-antigravity"].args, [bridgeIndex]);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case k: after adopting CRLF preset copies, second install reports no changes and files keep their bytes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-k-"));
    try {
        const ruleSrc = await readFile(path.join(repoRoot, "presets", "claude", "rules", "aeo-orchestration.md"), "utf8");
        const crlfRule = ruleSrc.replace(/\r?\n/g, "\r\n");
        await mkdir(path.join(home, ".claude", "rules"), { recursive: true });
        const ruleFile = path.join(home, ".claude", "rules", "aeo-orchestration.md");
        await writeFile(ruleFile, crlfRule);

        const explorerSrc = await readFile(path.join(repoRoot, "presets", "claude", "agents", "aeo-explorer.md"), "utf8");
        const crlfExplorer = explorerSrc.replace(/\r?\n/g, "\r\n");
        await mkdir(path.join(home, ".claude", "agents"), { recursive: true });
        const explorerFile = path.join(home, ".claude", "agents", "aeo-explorer.md");
        await writeFile(explorerFile, crlfExplorer);

        const initialRuleBytes = await readFile(ruleFile);
        const initialExplorerBytes = await readFile(explorerFile);

        const adoptRes = await install(globalOptions(home, { adopt: true }));
        assert.equal(adoptRes.ok, true);

        // Second plain install
        const plainRes = await install(globalOptions(home));
        assert.equal(plainRes.ok, true);
        assert.equal(plainRes.changed.length, 0);

        const currentRuleBytes = await readFile(ruleFile);
        const currentExplorerBytes = await readFile(explorerFile);
        assert.deepEqual(currentRuleBytes, initialRuleBytes);
        assert.deepEqual(currentExplorerBytes, initialExplorerBytes);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case l: --adopt with mismatched args does not print 'Pass --adopt'", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-l-"));
    try {
        await writeFile(path.join(home, ".claude.json"), JSON.stringify({
            mcpServers: {
                "aeo-antigravity": {
                    command: "node",
                    args: ["completely/different/path/index.js"]
                }
            }
        }, null, 2));

        const res = await install(globalOptions(home, { adopt: true }));
        assert.equal(res.ok, false);
        const planText = formatPlan(res);
        assert.equal(planText.includes("Pass --adopt"), false, "output should not contain 'Pass --adopt'");
        assert.ok(res.conflicts.some((c) => c.includes("cannot be adopted because command/args differ from what AEO would write")));
        for (const conflict of res.conflicts) {
            assert.equal(conflict.includes("Pass --adopt"), false);
        }

        // CLI test
        const cliRun = spawnSync(process.execPath, [cli, "install", "--global", "--adopt", "--claude"], {
            cwd: repoRoot,
            env: { ...process.env, HOME: home, USERPROFILE: home },
            encoding: "utf8"
        });
        assert.notEqual(cliRun.status, 0);
        assert.equal(cliRun.stdout.includes("Pass --adopt"), false);
        assert.equal(cliRun.stderr.includes("Pass --adopt"), false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case m: ADOPTED lines unique in formatPlan output", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-m-"));
    try {
        const ruleSrc = await readFile(path.join(repoRoot, "presets", "claude", "rules", "aeo-orchestration.md"), "utf8");
        await mkdir(path.join(home, ".claude", "rules"), { recursive: true });
        await writeFile(path.join(home, ".claude", "rules", "aeo-orchestration.md"), ruleSrc.replace(/\r?\n/g, "\r\n"));

        const bridgeIndex = toPosix(path.join(home, ".aeo", "bridge", "antigravity-mcp", "index.js"));
        await writeFile(path.join(home, ".claude.json"), JSON.stringify({
            mcpServers: {
                "aeo-antigravity": {
                    command: "node",
                    args: [bridgeIndex]
                }
            }
        }, null, 2));

        const res = await install(globalOptions(home, { adopt: true }));
        assert.equal(res.ok, true);
        const planText = formatPlan(res);
        const adoptedLines = planText.split("\n").filter((line) => line.startsWith("ADOPTED: "));
        assert.ok(adoptedLines.length >= 2);
        assert.equal(adoptedLines.length, new Set(adoptedLines).size);

        // Also verify replaceCodexAgentsMd backup notice is printed once
        await mkdir(path.join(home, ".codex"), { recursive: true });
        await writeFile(path.join(home, ".codex", "AGENTS.md"), "# Custom user agents\n");
        const resReplace = await install(globalOptions(home, { replaceCodexAgentsMd: true }));
        assert.equal(resReplace.ok, true);
        const replacePlanText = formatPlan(resReplace);
        const backupNotices = replacePlanText.split("\n").filter((line) => line.includes("Uninstall deletes .codex/AGENTS.md if unchanged"));
        assert.equal(backupNotices.length, 1);
        assert.equal(replacePlanText.includes("Warning: Original .codex/AGENTS.md was backed up to"), false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case n: global dry-run plan contains an AGENTS.md block line and config.toml line exactly once each", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-n-"));
    try {
        // Without existing files
        const res1 = await install(globalOptions(home, { dryRun: true, codex: true, claude: false }));
        assert.equal(res1.ok, true);
        const text1 = formatPlan(res1);
        const agentsLines1 = text1.split("\n").filter((l) => l.includes(".codex/AGENTS.md") && (l.includes("orchestration block") || l.includes("AEO block")));
        const configLines1 = text1.split("\n").filter((l) => l.includes(".codex/config.toml") && l.includes("AEO block"));
        assert.equal(agentsLines1.length, 1, `Expected 1 AGENTS.md line, got: ${JSON.stringify(agentsLines1)}`);
        assert.equal(configLines1.length, 1, `Expected 1 config.toml line, got: ${JSON.stringify(configLines1)}`);

        // With existing files containing user text
        await mkdir(path.join(home, ".codex"), { recursive: true });
        await writeFile(path.join(home, ".codex", "AGENTS.md"), "# Pre-existing user text\n");
        await writeFile(path.join(home, ".codex", "config.toml"), "model = 'gpt-5'\n");
        const res2 = await install(globalOptions(home, { dryRun: true, codex: true, claude: false }));
        assert.equal(res2.ok, true);
        const text2 = formatPlan(res2);
        const agentsLines2 = text2.split("\n").filter((l) => l.includes(".codex/AGENTS.md") && (l.includes("orchestration block") || l.includes("AEO block")));
        const configLines2 = text2.split("\n").filter((l) => l.includes(".codex/config.toml") && l.includes("AEO block"));
        assert.equal(agentsLines2.length, 1, `Expected 1 AGENTS.md line, got: ${JSON.stringify(agentsLines2)}`);
        assert.equal(configLines2.length, 1, `Expected 1 config.toml line, got: ${JSON.stringify(configLines2)}`);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case o: replace install, then plain install without flag: file bytes unchanged, no AEO:BEGIN marker, manifest still whole-file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-o-"));
    try {
        await mkdir(path.join(home, ".codex"), { recursive: true });
        await writeFile(path.join(home, ".codex", "AGENTS.md"), "# Pre-existing policy to replace\n");

        const first = await install(globalOptions(home, { replaceCodexAgentsMd: true, adopt: true }));
        assert.equal(first.ok, true);
        const bytesAfterFirst = await readFile(path.join(home, ".codex", "AGENTS.md"));

        // Plain install without replace flag
        const second = await install(globalOptions(home));
        assert.equal(second.ok, true);
        assert.equal(second.changed.includes(".codex/AGENTS.md"), false);

        const bytesAfterSecond = await readFile(path.join(home, ".codex", "AGENTS.md"));
        assert.deepEqual(bytesAfterSecond, bytesAfterFirst);

        const content = bytesAfterSecond.toString("utf8");
        assert.equal(content.includes(AGENTS_BEGIN), false);
        assert.equal(content.includes(AGENTS_END), false);

        const planText = formatPlan(second);
        assert.equal(planText.includes("Merge: .codex/AGENTS.md orchestration block"), false);
        assert.ok(planText.includes("UNCHANGED: .codex/AGENTS.md"));

        const manifest = JSON.parse(await readFile(path.join(home, ".aeo", "global-install-manifest.json"), "utf8"));
        const installedEntry = (manifest.installedFiles || []).find((e) => (typeof e === "string" ? e : e.path) === ".codex/AGENTS.md");
        assert.ok(installedEntry, "manifest should own .codex/AGENTS.md in installedFiles");
        const blockEntry = (manifest.managedBlocks || []).find((b) => b.file === ".codex/AGENTS.md");
        assert.equal(blockEntry, undefined, "manifest should not have managed block for .codex/AGENTS.md");

        // CLI verification replicating Team Lead evidence
        const cliHome = await mkdtemp(path.join(os.tmpdir(), "aeo-global-cli-sticky-"));
        try {
            await mkdir(path.join(cliHome, ".codex"), { recursive: true });
            await writeFile(path.join(cliHome, ".codex", "AGENTS.md"), "# Pre-existing policy\n");

            const cliRun1 = spawnSync(process.execPath, [cli, "install", "--global", "--codex", "--claude", "--adopt", "--replace-codex-agents-md"], {
                cwd: repoRoot,
                env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome },
                encoding: "utf8"
            });
            assert.equal(cliRun1.status, 0, cliRun1.stderr);

            const cliRun2 = spawnSync(process.execPath, [cli, "install", "--global", "--codex", "--claude"], {
                cwd: repoRoot,
                env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome },
                encoding: "utf8"
            });
            assert.equal(cliRun2.status, 0, cliRun2.stderr);
            assert.equal(cliRun2.stdout.includes("Merge: .codex/AGENTS.md orchestration block"), false);
            assert.ok(cliRun2.stdout.includes("UNCHANGED: .codex/AGENTS.md"));

            const cliAgentsText = await readFile(path.join(cliHome, ".codex", "AGENTS.md"), "utf8");
            assert.equal(cliAgentsText.includes(AGENTS_BEGIN), false);
            const lineCount = cliAgentsText.split(/\r?\n/).length;
            assert.ok(lineCount < 300, `Expected single policy (~250 lines), but got ${lineCount} lines`);
        } finally {
            await rm(cliHome, { recursive: true, force: true });
        }
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case p: replace install twice: second run writes no backup and reports no change for AGENTS.md", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-p-"));
    try {
        await mkdir(path.join(home, ".codex"), { recursive: true });
        await writeFile(path.join(home, ".codex", "AGENTS.md"), "# Original AGENTS to replace\n");

        const first = await install(globalOptions(home, { replaceCodexAgentsMd: true }));
        assert.equal(first.ok, true);
        assert.ok(first.backupFiles.some((f) => f.includes("AGENTS.md")));

        const backupDir = path.join(home, ".aeo", "backups", "global");
        const firstStamps = await readdir(backupDir);
        assert.ok(firstStamps.length > 0);

        // Second run with replace flag and file unchanged
        const second = await install(globalOptions(home, { replaceCodexAgentsMd: true }));
        assert.equal(second.ok, true);
        assert.equal(second.backupFiles.some((f) => f.includes("AGENTS.md")), false);
        assert.equal(second.changed.includes(".codex/AGENTS.md"), false);

        const secondPlanText = formatPlan(second);
        assert.equal(secondPlanText.includes("Backup written:"), false);
        assert.equal(secondPlanText.includes("Backup if modified: .codex/AGENTS.md"), false);
        assert.ok(secondPlanText.includes("UNCHANGED: .codex/AGENTS.md"));

        // Backup directory unchanged (no new timestamp subdirectories)
        const secondStamps = await readdir(backupDir);
        assert.equal(secondStamps.length, firstStamps.length);

        // CLI verification
        const cliHome = await mkdtemp(path.join(os.tmpdir(), "aeo-global-cli-idempotent-"));
        try {
            await mkdir(path.join(cliHome, ".codex"), { recursive: true });
            await writeFile(path.join(cliHome, ".codex", "AGENTS.md"), "# Pre-existing\n");

            const cliRun1 = spawnSync(process.execPath, [cli, "install", "--global", "--codex", "--claude", "--replace-codex-agents-md"], {
                cwd: repoRoot,
                env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome },
                encoding: "utf8"
            });
            assert.equal(cliRun1.status, 0);
            assert.ok(cliRun1.stdout.includes("Backup written:"));

            const cliRun2 = spawnSync(process.execPath, [cli, "install", "--global", "--codex", "--claude", "--replace-codex-agents-md"], {
                cwd: repoRoot,
                env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome },
                encoding: "utf8"
            });
            assert.equal(cliRun2.status, 0);
            assert.equal(cliRun2.stdout.includes("Backup written:"), false);
            assert.ok(cliRun2.stdout.includes("No changes.") || cliRun2.stdout.includes("UNCHANGED: .codex/AGENTS.md"));
        } finally {
            await rm(cliHome, { recursive: true, force: true });
        }
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("case q: replace install, user edits the file, plain install: file preserved (not rewritten, no block appended)", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-global-case-q-"));
    try {
        await mkdir(path.join(home, ".codex"), { recursive: true });
        await writeFile(path.join(home, ".codex", "AGENTS.md"), "# Initial text\n");

        const first = await install(globalOptions(home, { replaceCodexAgentsMd: true }));
        assert.equal(first.ok, true);

        // User edits the file
        const editedContent = (await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")) + "\n# Custom User Guidance Post-Install\n";
        await writeFile(path.join(home, ".codex", "AGENTS.md"), editedContent);

        // Plain install without replace flag
        const second = await install(globalOptions(home));
        assert.equal(second.ok, true);
        assert.equal(second.changed.includes(".codex/AGENTS.md"), false);

        const secondPlanText = formatPlan(second);
        assert.ok(secondPlanText.includes("USER MODIFIED — PRESERVED: .codex/AGENTS.md"));
        assert.equal(secondPlanText.includes("Merge: .codex/AGENTS.md"), false);
        assert.equal(secondPlanText.includes("Backup written:"), false);

        // File preserved
        const contentAfter = await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8");
        assert.equal(contentAfter, editedContent);
        assert.equal(contentAfter.includes(AGENTS_BEGIN), false);
        assert.equal(contentAfter.includes(AGENTS_END), false);

        // Manifest still owns .codex/AGENTS.md as whole file
        const manifest = JSON.parse(await readFile(path.join(home, ".aeo", "global-install-manifest.json"), "utf8"));
        const installedEntry = (manifest.installedFiles || []).find((e) => (typeof e === "string" ? e : e.path) === ".codex/AGENTS.md");
        assert.ok(installedEntry, "manifest should still own .codex/AGENTS.md in installedFiles");
        const blockEntry = (manifest.managedBlocks || []).find((b) => b.file === ".codex/AGENTS.md");
        assert.equal(blockEntry, undefined, "manifest should not have managed block for .codex/AGENTS.md");
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
