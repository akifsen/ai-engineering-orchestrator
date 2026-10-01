import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AGENTS_BEGIN, AGENTS_END, install, uninstall } from "../lib/installer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts", "aeo.mjs");
const USER_AGENTS = "# Billing\nDo not change the billing schema.\n";
const USER_CLAUDE = "# Project\nKeep the public checkout API.\n";
const USER_MCP = {
    mcpServers: {
        docs: { command: "node", args: ["docs.js"] },
        antigravity: { command: "node", args: ["user-owned.js"] }
    }
};

async function fakeNpmCi(cwd) {
    await mkdir(path.join(cwd, "node_modules"), { recursive: true });
    await writeFile(path.join(cwd, "node_modules", ".installed"), "ok\n");
}

function hash(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

async function workspace() {
    const target = await mkdtemp(path.join(os.tmpdir(), "aeo-drift-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "aeo-drift-home-"));
    await mkdir(path.join(target, ".codex", "agents"), { recursive: true });
    await mkdir(path.join(target, ".claude", "agents"), { recursive: true });
    await mkdir(path.join(target, "src"), { recursive: true });
    await writeFile(path.join(target, "AGENTS.md"), USER_AGENTS);
    await writeFile(path.join(target, "CLAUDE.md"), USER_CLAUDE);
    await writeFile(path.join(target, ".mcp.json"), `${JSON.stringify(USER_MCP, null, 2)}\n`);
    await writeFile(path.join(target, ".codex", "config.toml"), "model = \"gpt-6-astra\"\n");
    await writeFile(path.join(target, ".codex", "agents", "explorer.toml"), "USER CODEX AGENT\n");
    await writeFile(path.join(target, ".claude", "agents", "Explore.md"), "USER CLAUDE AGENT\n");
    await writeFile(path.join(target, "src", "keep.txt"), "keep\n");
    return { target, home };
}

function options(target, home, extra = {}) {
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

async function cleanup(target, home, extra) {
    await rm(target, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    if (extra) {
        await rm(extra, { recursive: true, force: true });
    }
}

async function manifestOf(target) {
    return JSON.parse(await readFile(path.join(target, ".aeo", "install-manifest.json"), "utf8"));
}

function entry(manifest, relative) {
    return manifest.installedFiles.find((item) => item.path === relative);
}

async function alternatePreset(edit) {
    const root = await mkdtemp(path.join(os.tmpdir(), "aeo-preset-"));
    await cp(path.join(repoRoot, "presets"), path.join(root, "presets"), { recursive: true });
    const bridgeDest = path.join(root, "bridge", "antigravity-mcp");
    for (const relative of ["package.json", "package-lock.json", "index.js", "README.md", "lib/delegate.js", "lib/server.js", "lib/worktree.js"]) {
        await mkdir(path.dirname(path.join(bridgeDest, relative)), { recursive: true });
        await cp(path.join(repoRoot, "bridge", "antigravity-mcp", relative), path.join(bridgeDest, relative));
    }
    await edit(root);
    return root;
}

test("initial install stores SHA-256 of the bytes written for AEO-owned files", async () => {
    const { target, home } = await workspace();
    try {
        const result = await install(options(target, home));
        assert.equal(result.ok, true, result.error || "");
        const manifest = await manifestOf(target);
        assert.equal(manifest.schemaVersion, 2);
        for (const relative of [
            ".codex/agents/aeo-explorer.toml",
            ".codex/agents/aeo-architect.toml",
            ".claude/rules/aeo-orchestration.md",
            ".claude/agents/aeo-reviewer.md",
            ".aeo/.gitignore",
            ".aeo/bridge/antigravity-mcp/index.js",
            ".aeo/bridge/antigravity-mcp/lib/delegate.js"
        ]) {
            const bytes = await readFile(path.join(target, relative));
            assert.equal(entry(manifest, relative).sha256, hash(bytes), relative);
        }
        const block = manifest.managedBlocks.find((item) => item.id === "AEO_ORCHESTRATION");
        assert.equal(typeof block.sha256, "string");
        assert.equal(block.sha256.length, 64);
        assert.equal(manifest.installedFiles.some((item) => item.path.includes("node_modules")), false);
    } finally {
        await cleanup(target, home);
    }
});

test("reinstall with unchanged files and unchanged presets writes nothing", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const before = await readFile(path.join(target, ".aeo", "install-manifest.json"));
        const agent = await readFile(path.join(target, ".codex", "agents", "aeo-explorer.toml"));
        let npmCalls = 0;
        const second = await install(options(target, home, {
            npmCi: async () => {
                npmCalls += 1;
            }
        }));
        assert.equal(second.ok, true, second.error || "");
        assert.equal(second.wrote, false);
        assert.equal(second.backupFiles.length, 0);
        assert.equal(npmCalls, 0);
        assert.deepEqual(await readFile(path.join(target, ".aeo", "install-manifest.json")), before);
        assert.deepEqual(await readFile(path.join(target, ".codex", "agents", "aeo-explorer.toml")), agent);
    } finally {
        await cleanup(target, home);
    }
});

test("reinstall updates an unchanged AEO file when the preset hash changes", async () => {
    const { target, home } = await workspace();
    const preset = await alternatePreset(async (root) => {
        const file = path.join(root, "presets", "codex", "agents", "aeo-reviewer.toml");
        const text = await readFile(file, "utf8");
        await writeFile(file, text.replace("model = \"gpt-6-sol\"", "model = \"gpt-6-sol-next\""));
    });
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const explorerBefore = await readFile(path.join(target, ".codex", "agents", "aeo-explorer.toml"));
        const second = await install(options(target, home, { repoRoot: preset, npmCi: async () => {} }));
        assert.equal(second.ok, true, second.error || "");
        assert.ok(second.safeUpdate.includes(".codex/agents/aeo-reviewer.toml"));
        const reviewer = await readFile(path.join(target, ".codex", "agents", "aeo-reviewer.toml"), "utf8");
        assert.match(reviewer, /gpt-6-sol-next/);
        assert.deepEqual(await readFile(path.join(target, ".codex", "agents", "aeo-explorer.toml")), explorerBefore);
        const manifest = await manifestOf(target);
        const reviewerBytes = await readFile(path.join(target, ".codex", "agents", "aeo-reviewer.toml"));
        assert.equal(entry(manifest, ".codex/agents/aeo-reviewer.toml").sha256, hash(reviewerBytes));
    } finally {
        await cleanup(target, home, preset);
    }
});

test("reinstall preserves customized Codex, Claude, and policy files and leaves unrelated files byte-identical", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const codexAgent = path.join(target, ".codex", "agents", "aeo-architect.toml");
        const claudeAgent = path.join(target, ".claude", "agents", "aeo-reviewer.md");
        const rule = path.join(target, ".claude", "rules", "aeo-orchestration.md");
        const codexText = (await readFile(codexAgent, "utf8")).replace("model = \"gpt-6-sol\"", "model = \"account-custom\"");
        const claudeText = `${await readFile(claudeAgent, "utf8")}\nCustom review instruction.\n`;
        const ruleText = `${await readFile(rule, "utf8")}\nProject-specific routing note.\n`;
        await writeFile(codexAgent, codexText);
        await writeFile(claudeAgent, claudeText);
        await writeFile(rule, ruleText);
        const unrelated = [
            "CLAUDE.md",
            "AGENTS.md",
            ".mcp.json",
            path.join(".codex", "agents", "explorer.toml"),
            path.join(".claude", "agents", "Explore.md"),
            path.join("src", "keep.txt")
        ];
        const before = new Map();
        for (const relative of unrelated) {
            before.set(relative, await readFile(path.join(target, relative)));
        }
        const manifestBefore = await manifestOf(target);
        const architectHash = entry(manifestBefore, ".codex/agents/aeo-architect.toml").sha256;
        const second = await install(options(target, home, { npmCi: async () => {} }));
        assert.equal(second.ok, true, second.error || "");
        assert.equal(await readFile(codexAgent, "utf8"), codexText);
        assert.equal(await readFile(claudeAgent, "utf8"), claudeText);
        assert.equal(await readFile(rule, "utf8"), ruleText);
        for (const relative of [
            ".codex/agents/aeo-architect.toml",
            ".claude/agents/aeo-reviewer.md",
            ".claude/rules/aeo-orchestration.md"
        ]) {
            assert.ok(second.userModified.includes(relative), relative);
        }
        const manifestAfter = await manifestOf(target);
        assert.equal(entry(manifestAfter, ".codex/agents/aeo-architect.toml").sha256, architectHash);
        for (const relative of unrelated) {
            assert.deepEqual(await readFile(path.join(target, relative)), before.get(relative), relative);
        }
        const mcp = JSON.parse(await readFile(path.join(target, ".mcp.json"), "utf8"));
        assert.deepEqual(mcp.mcpServers.docs, USER_MCP.mcpServers.docs);
        assert.deepEqual(mcp.mcpServers.antigravity, USER_MCP.mcpServers.antigravity);
    } finally {
        await cleanup(target, home);
    }
});

test("force-managed-update backs up a drifted AEO file, replaces it, and records the new hash", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const relative = ".codex/agents/aeo-explorer.toml";
        const file = path.join(target, relative);
        const custom = (await readFile(file, "utf8")).replace("model_reasoning_effort = \"low\"", "model_reasoning_effort = \"high\"");
        await writeFile(file, custom);
        const forced = await install(options(target, home, { forceManagedUpdate: true, npmCi: async () => {} }));
        assert.equal(forced.ok, true, forced.error || "");
        assert.equal((await readFile(file, "utf8")).includes("model_reasoning_effort = \"high\""), false);
        const backup = forced.backupFiles.find((item) => item.endsWith("aeo-explorer.toml"));
        assert.ok(backup);
        assert.equal(backup.startsWith(home), true);
        assert.equal(await readFile(backup, "utf8"), custom);
        const manifest = await manifestOf(target);
        assert.equal(entry(manifest, relative).sha256, hash(await readFile(file)));
    } finally {
        await cleanup(target, home);
    }
});

test("a failed owned-file write does not update the manifest hash", async () => {
    const { target, home } = await workspace();
    const preset = await alternatePreset(async (root) => {
        const file = path.join(root, "presets", "codex", "agents", "aeo-explorer.toml");
        const text = await readFile(file, "utf8");
        await writeFile(file, text.replace("model = \"gpt-6-luna\"", "model = \"gpt-6-luna-next\""));
    });
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const relative = ".codex/agents/aeo-explorer.toml";
        const beforeBytes = await readFile(path.join(target, relative));
        const beforeHash = entry(await manifestOf(target), relative).sha256;
        const failed = await install(options(target, home, {
            repoRoot: preset,
            npmCi: async () => {},
            writeFile: async (file, contents) => {
                if (String(file).includes("aeo-explorer.toml.aeo-tmp")) {
                    throw new Error("simulated write failure");
                }
                await writeFile(file, contents);
            }
        }));
        assert.equal(failed.ok, false);
        assert.match(failed.error, /simulated write failure/);
        assert.deepEqual(await readFile(path.join(target, relative)), beforeBytes);
        assert.equal(entry(await manifestOf(target), relative).sha256, beforeHash);
    } finally {
        await cleanup(target, home, preset);
    }
});

test("a failed manifest write leaves the previous hash and a later install reconciles it", async () => {
    const { target, home } = await workspace();
    const preset = await alternatePreset(async (root) => {
        const file = path.join(root, "presets", "codex", "agents", "aeo-explorer.toml");
        const text = await readFile(file, "utf8");
        await writeFile(file, text.replace("model = \"gpt-6-luna\"", "model = \"gpt-6-luna-next\""));
    });
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const relative = ".codex/agents/aeo-explorer.toml";
        const beforeHash = entry(await manifestOf(target), relative).sha256;
        const failed = await install(options(target, home, {
            repoRoot: preset,
            npmCi: async () => {},
            writeFile: async (file, contents) => {
                if (String(file).includes("install-manifest.json.aeo-tmp")) {
                    throw new Error("simulated manifest failure");
                }
                await writeFile(file, contents);
            }
        }));
        assert.equal(failed.ok, false);
        assert.match(failed.error, /incomplete/);
        assert.match(await readFile(path.join(target, relative), "utf8"), /gpt-6-luna-next/);
        assert.equal(entry(await manifestOf(target), relative).sha256, beforeHash);
        const recovered = await install(options(target, home, { repoRoot: preset, npmCi: async () => {} }));
        assert.equal(recovered.ok, true, recovered.error || "");
        const bytes = await readFile(path.join(target, relative));
        assert.match(bytes.toString("utf8"), /gpt-6-luna-next/);
        assert.equal(entry(await manifestOf(target), relative).sha256, hash(bytes));
    } finally {
        await cleanup(target, home, preset);
    }
});

test("uninstall removes an unchanged AEO file and preserves a user-modified one", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const custom = path.join(target, ".codex", "agents", "aeo-architect.toml");
        const unchanged = path.join(target, ".codex", "agents", "aeo-explorer.toml");
        const customText = `${await readFile(custom, "utf8")}\n# local model\n`;
        await writeFile(custom, customText);
        const removed = await uninstall({ target, repoRoot });
        assert.equal(removed.ok, true, removed.error || "");
        assert.equal(await readFile(custom, "utf8"), customText);
        assert.ok(removed.preserved.includes(".codex/agents/aeo-architect.toml"));
        assert.equal(await readFile(path.join(target, ".codex", "agents", "explorer.toml"), "utf8"), "USER CODEX AGENT\n");
        try {
            await readFile(unchanged);
            assert.fail("unchanged AEO agent should have been removed");
        } catch (error) {
            assert.equal(error.code, "ENOENT");
        }
        const again = await install(options(target, home));
        assert.equal(again.ok, false);
        assert.match(again.conflicts.join("\n"), /does not own it/);
        assert.equal(await readFile(custom, "utf8"), customText);
    } finally {
        await cleanup(target, home);
    }
});

test("old manifests without hashes migrate conservatively", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const current = await manifestOf(target);
        const legacy = {
            schemaVersion: 1,
            aeoVersion: current.aeoVersion,
            projectId: current.projectId,
            targets: current.targets,
            createdFiles: current.createdFiles,
            installedFiles: current.installedFiles.map((item) => item.path),
            managedBlocks: current.managedBlocks.map((block) => ({ file: block.file, id: block.id })),
            mergedEntries: current.mergedEntries
        };
        legacy.installedFiles.push(".aeo/bridge/antigravity-mcp");
        await writeFile(path.join(target, ".aeo", "install-manifest.json"), `${JSON.stringify(legacy, null, 2)}\n`);
        const reviewer = path.join(target, ".codex", "agents", "aeo-reviewer.toml");
        const explorer = path.join(target, ".codex", "agents", "aeo-explorer.toml");
        const reviewerBefore = await readFile(reviewer);
        const explorerBefore = await readFile(explorer);
        const custom = Buffer.concat([explorerBefore, Buffer.from("\n# edited\n")]);
        await writeFile(explorer, custom);
        const second = await install(options(target, home, { npmCi: async () => {} }));
        assert.equal(second.ok, true, second.error || "");
        assert.deepEqual(await readFile(explorer), custom);
        assert.deepEqual(await readFile(reviewer), reviewerBefore);
        assert.ok(second.userModified.includes(".codex/agents/aeo-explorer.toml"));
        const migrated = await manifestOf(target);
        assert.equal(migrated.schemaVersion, 2);
        assert.equal(entry(migrated, ".codex/agents/aeo-explorer.toml").sha256, undefined);
        assert.equal(entry(migrated, ".codex/agents/aeo-reviewer.toml").sha256, hash(reviewerBefore));
        const forced = await install(options(target, home, { forceManagedUpdate: true, npmCi: async () => {} }));
        assert.equal(forced.ok, true, forced.error || "");
        assert.deepEqual(await readFile(explorer), explorerBefore);
        assert.equal(entry(await manifestOf(target), ".codex/agents/aeo-explorer.toml").sha256, hash(explorerBefore));
    } finally {
        await cleanup(target, home);
    }
});

test("dry-run reports drifted files and writes nothing", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const relative = ".claude/rules/aeo-orchestration.md";
        const file = path.join(target, relative);
        const custom = `${await readFile(file, "utf8")}\nLocal policy.\n`;
        await writeFile(file, custom);
        const files = [
            relative,
            "AGENTS.md",
            "CLAUDE.md",
            ".mcp.json",
            path.join(".codex", "agents", "explorer.toml")
        ];
        const before = new Map(await Promise.all(files.map(async (item) => [item, await readFile(path.join(target, item))])));
        const dry = await install(options(target, home, { dryRun: true, npmCi: async () => { throw new Error("npm should not run"); } }));
        assert.equal(dry.ok, true, dry.error || "");
        assert.equal(dry.wrote, false);
        assert.ok(dry.userModified.includes(relative));
        const rendered = (await import("../lib/installer.mjs")).formatPlan(dry);
        assert.match(rendered, /Dry run/);
        assert.match(rendered, /USER MODIFIED — PRESERVED: \.claude\/rules\/aeo-orchestration\.md/);
        assert.match(rendered, /WOULD OVERWRITE WITH --force-managed-update: \.claude\/rules\/aeo-orchestration\.md/);
        for (const item of files) {
            assert.deepEqual(await readFile(path.join(target, item)), before.get(item));
        }
        const cliResult = spawnSync(process.execPath, [cli, "update", "--target", target, "--codex", "--claude", "--dry-run"], { encoding: "utf8" });
        assert.equal(cliResult.status, 0, cliResult.stderr);
        assert.match(cliResult.stdout, /USER MODIFIED — PRESERVED/);
        assert.equal(await readFile(file, "utf8"), custom);
    } finally {
        await cleanup(target, home);
    }
});

test("hash comparison uses file bytes, including a one-byte change", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const relative = ".codex/agents/aeo-fast-worker.toml";
        const file = path.join(target, relative);
        const bytes = await readFile(file);
        const manifest = await manifestOf(target);
        assert.equal(entry(manifest, relative).sha256, hash(bytes));
        const mutated = Buffer.from(bytes);
        const index = mutated.indexOf(0x61);
        mutated[index] = mutated[index] ^ 0x01;
        await writeFile(file, mutated);
        const second = await install(options(target, home, { npmCi: async () => {} }));
        assert.equal(second.ok, true, second.error || "");
        assert.deepEqual(await readFile(file), mutated);
        assert.ok(second.userModified.includes(relative));
    } finally {
        await cleanup(target, home);
    }
});

test("a missing manifest-owned file is recreated and an unowned file is not replaced by force", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const missing = path.join(target, ".codex", "agents", "aeo-fast-worker.toml");
        await rm(missing);
        const dry = await install(options(target, home, { dryRun: true }));
        assert.ok(dry.recreate.includes(".codex/agents/aeo-fast-worker.toml"));
        assert.equal(dry.wrote, false);
        const second = await install(options(target, home, { npmCi: async () => {} }));
        assert.equal(second.ok, true, second.error || "");
        const restored = await readFile(missing);
        const preset = await readFile(path.join(repoRoot, "presets", "codex", "agents", "aeo-fast-worker.toml"));
        assert.deepEqual(restored, preset);
        await uninstall({ target, repoRoot, forceRemoveModified: true });
        const foreign = path.join(target, ".codex", "agents", "aeo-explorer.toml");
        await mkdir(path.dirname(foreign), { recursive: true });
        await writeFile(foreign, "name = \"aeo_explorer\"\nUSER OWNED\n");
        const blocked = await install(options(target, home, { forceManagedUpdate: true }));
        assert.equal(blocked.ok, false);
        assert.match(blocked.conflicts.join("\n"), /does not own it/);
        assert.equal(await readFile(foreign, "utf8"), "name = \"aeo_explorer\"\nUSER OWNED\n");
    } finally {
        await cleanup(target, home);
    }
});

test("drifted bridge runtime and a drifted managed block are preserved unless force is set", async () => {
    const { target, home } = await workspace();
    try {
        const first = await install(options(target, home));
        assert.equal(first.ok, true, first.error || "");
        const bridge = path.join(target, ".aeo", "bridge", "antigravity-mcp", "index.js");
        const bridgeText = `${await readFile(bridge, "utf8")}\n// local bridge note\n`;
        await writeFile(bridge, bridgeText);
        const agentsPath = path.join(target, "AGENTS.md");
        const agents = await readFile(agentsPath, "utf8");
        const editedAgents = agents.replace(AGENTS_BEGIN, `${AGENTS_BEGIN}\nUSER BLOCK EDIT`);
        await writeFile(agentsPath, editedAgents);
        const second = await install(options(target, home, { npmCi: async () => {} }));
        assert.equal(second.ok, true, second.error || "");
        assert.equal(await readFile(bridge, "utf8"), bridgeText);
        assert.match(await readFile(agentsPath, "utf8"), /USER BLOCK EDIT/);
        assert.match(await readFile(agentsPath, "utf8"), /billing schema/);
        const forced = await install(options(target, home, { forceManagedUpdate: true, npmCi: fakeNpmCi }));
        assert.equal(forced.ok, true, forced.error || "");
        assert.equal((await readFile(bridge, "utf8")).includes("local bridge note"), false);
        const agentsAfter = await readFile(agentsPath, "utf8");
        assert.equal(agentsAfter.includes("USER BLOCK EDIT"), false);
        assert.match(agentsAfter, /billing schema/);
        assert.equal((agentsAfter.match(new RegExp(AGENTS_BEGIN, "g")) || []).length, 1);
        assert.equal((agentsAfter.match(new RegExp(AGENTS_END, "g")) || []).length, 1);
        const backup = forced.backupFiles.find((item) => item.endsWith("AGENTS.md"));
        assert.match(await readFile(backup, "utf8"), /USER BLOCK EDIT/);
        const removed = await uninstall({ target, repoRoot });
        assert.equal(removed.ok, true, removed.error || "");
        assert.equal(await readFile(agentsPath, "utf8").then((text) => text.includes("AEO:BEGIN")), false);
    } finally {
        await cleanup(target, home);
    }
});
