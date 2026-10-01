import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const REQUIRED = [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/scripts/aeo.mjs",
    "package/scripts/lib/installer.mjs",
    "package/scripts/lib/npm-ci.mjs",
    "package/scripts/lib/node-version.mjs",
    "package/presets/codex/orchestration-block.md",
    "package/presets/codex/agents/aeo-explorer.toml",
    "package/presets/codex/agents/aeo-architect.toml",
    "package/presets/codex/agents/aeo-reviewer.toml",
    "package/presets/codex/agents/aeo-fast-worker.toml",
    "package/presets/claude/rules/aeo-orchestration.md",
    "package/presets/claude/agents/aeo-explorer.md",
    "package/presets/claude/agents/aeo-architect.md",
    "package/presets/claude/agents/aeo-reviewer.md",
    "package/presets/claude/agents/aeo-fast-worker.md",
    "package/bridge/antigravity-mcp/package.json",
    "package/bridge/antigravity-mcp/package-lock.json",
    "package/bridge/antigravity-mcp/index.js",
    "package/bridge/antigravity-mcp/lib/delegate.js",
    "package/bridge/antigravity-mcp/lib/server.js",
    "package/bridge/antigravity-mcp/lib/worktree.js",
    "package/bridge/cursor-mcp/package.json",
    "package/bridge/cursor-mcp/package-lock.json",
    "package/bridge/cursor-mcp/index.js",
    "package/bridge/cursor-mcp/lib/delegate.js",
    "package/bridge/cursor-mcp/lib/server.js",
    "package/bridge/cursor-mcp/lib/worktree.js",
    "package/docs/install.md",
    "package/antigravity/settings.example.json",
    "package/SECURITY.md"
];

const SECRET_PATTERNS = [
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /npm_[A-Za-z0-9]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /sk-(?:proj-|ant-)?[A-Za-z0-9]{20,}/
];

function npmJsCli(command) {
    if (command !== "npm" && command !== "npx") {
        return null;
    }
    const candidates = [
        path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", `${command}-cli.js`),
        path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", `${command}-cli.js`),
        path.resolve(path.dirname(process.execPath), "..", "node_modules", "npm", "bin", `${command}-cli.js`)
    ];
    return candidates.find((candidate) => existsSync(candidate)) || null;
}

function run(command, args, options = {}) {
    const spawnOptions = {
        encoding: "utf8",
        windowsHide: true,
        ...options
    };
    const cli = npmJsCli(command);
    if (cli) {
        return spawnSync(process.execPath, [cli, ...args], spawnOptions);
    }
    const executable = process.platform === "win32" && command === "tar" ? "tar.exe" : command;
    return spawnSync(executable, args, spawnOptions);
}

function assertRan(result, label) {
    const detail = `${label}\nstatus=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    assert.equal(result.error, undefined, detail);
    assert.equal(result.status, 0, detail);
    return detail;
}

function parsePack(stdout) {
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    assert.ok(start >= 0 && end > start, stdout);
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    assert.equal(parsed.length, 1);
    return parsed[0];
}

function forbiddenEntry(entry) {
    const name = entry.replaceAll("\\", "/");
    if (name.includes("/node_modules/") || name.endsWith("/node_modules")) {
        return true;
    }
    if (name.includes("/scripts/test/")) {
        return true;
    }
    if (name.includes("/bridge/antigravity-mcp/test/") || name.includes("/bridge/cursor-mcp/test/")) {
        return true;
    }
    if (name.includes("/.github/") || name.includes("/.git/")) {
        return true;
    }
    if (name.endsWith("/.env") || name.includes("/.env.") || name.endsWith(".npmrc")) {
        return true;
    }
    if (name.includes("/.codex/") || name.includes("/.claude/") || name.includes("/.gemini/")) {
        return true;
    }
    if (name.endsWith("/id_rsa") || name.endsWith("/credentials.json") || name.endsWith("/auth.json")) {
        return true;
    }
    if (/(^|\/)package-lock\.json$/.test(name) && !name.includes("/bridge/")) {
        return true;
    }
    return false;
}

async function fileStamp(file) {
    try {
        const info = await stat(file);
        return `${info.size}:${info.mtimeMs}`;
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

function isolatedEnv(parent) {
    const home = path.join(parent, "home");
    const env = { ...process.env };
    env.HOME = home;
    env.USERPROFILE = home;
    env.APPDATA = path.join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(home, "AppData", "Local");
    env.npm_config_cache = path.join(parent, "npm-cache");
    env.npm_config_update_notifier = "false";
    delete env.AGY_BIN;
    delete env.NPM_TOKEN;
    delete env.NODE_AUTH_TOKEN;
    delete env.NPM_CONFIG_TOKEN;
    return { env, home };
}

async function packArtifact(destination) {
    await mkdir(destination, { recursive: true });
    const packed = run("npm", ["pack", "--json", "--pack-destination", destination], { cwd: repoRoot });
    assertRan(packed, "npm pack");
    const info = parsePack(packed.stdout);
    const tarball = path.join(destination, info.filename);
    assert.equal(existsSync(tarball), true, tarball);
    return { info, tarball };
}

test("packed tarball contains the runtime files and omits development files", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "aeo-npm-pack-"));
    try {
        const { info, tarball } = await packArtifact(path.join(parent, "pack"));
        console.log(`tarball ${info.filename} bytes=${info.size} unpacked=${info.unpackedSize} files=${info.entryCount}`);
        assert.equal(info.name, "ai-engineering-orchestrator");
        assert.equal(info.filename, `ai-engineering-orchestrator-${info.version}.tgz`);
        assert.ok(info.unpackedSize > 20_000, `unpacked ${info.unpackedSize}`);
        assert.ok(info.unpackedSize < 5_000_000, `unpacked ${info.unpackedSize}`);
        assert.ok(info.size < 2_000_000, `tarball ${info.size}`);
        assert.ok(info.entryCount < 300, `entries ${info.entryCount}`);
        const listed = run("tar", ["-tzf", tarball]);
        assertRan(listed, "tar -tzf");
        const entries = listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const required of REQUIRED) {
            assert.ok(entries.includes(required), `missing ${required}`);
        }
        const unexpected = entries.filter(forbiddenEntry);
        assert.deepEqual(unexpected, []);
        const extract = path.join(parent, "extract");
        await mkdir(extract);
        assertRan(run("tar", ["-xzf", tarball, "-C", extract]), "tar -xzf");
        const pkg = JSON.parse(await readFile(path.join(extract, "package", "package.json"), "utf8"));
        assert.equal(pkg.name, "ai-engineering-orchestrator");
        assert.equal(pkg.bin.aeo, "./scripts/aeo.mjs");
        for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
            assert.equal(pkg.scripts?.[name], undefined, name);
        }
        const entry = await readFile(path.join(extract, "package", "scripts", "aeo.mjs"), "utf8");
        assert.ok(entry.startsWith("#!/usr/bin/env node"));
        const home = os.homedir();
        for (const relative of entries) {
            const file = path.join(extract, relative);
            const bytes = await readFile(file);
            if (bytes.includes(0)) {
                continue;
            }
            const text = bytes.toString("utf8");
            assert.equal(text.includes(home), false, relative);
            const patterns = relative.endsWith("package-lock.json")
                ? SECRET_PATTERNS.filter((pattern) => !pattern.source.startsWith("sk-"))
                : SECRET_PATTERNS;
            for (const pattern of patterns) {
                assert.equal(pattern.test(text), false, `${relative} matched ${pattern}`);
            }
        }
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("installed tarball runs through npm outside the source checkout", { timeout: 420_000 }, async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "aeo-npm-smoke-"));
    const consumer = path.join(parent, "consumer app");
    const target = path.join(parent, "target project");
    const { env, home } = isolatedEnv(parent);
    const realPaths = [
        path.join(os.homedir(), ".codex", "config.toml"),
        path.join(os.homedir(), ".codex", "AGENTS.md"),
        path.join(os.homedir(), ".claude.json"),
        path.join(os.homedir(), ".claude", "settings.json"),
        path.join(os.homedir(), ".aeo")
    ];
    const before = new Map();
    for (const file of realPaths) {
        before.set(file, await fileStamp(file));
    }
    try {
        await mkdir(home, { recursive: true });
        await mkdir(consumer, { recursive: true });
        await mkdir(target, { recursive: true });
        const { tarball } = await packArtifact(path.join(parent, "pack"));
        await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({
            name: "aeo-smoke-consumer",
            private: true,
            version: "0.0.0"
        }, null, 2)}\n`);
        assertRan(run("npm", ["install", "--no-fund", "--no-audit", tarball], { cwd: consumer, env }), "npm install tarball");
        const shim = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "aeo.cmd" : "aeo");
        assert.equal(existsSync(shim), true, shim);
        if (process.platform !== "win32") {
            const mode = (await stat(shim)).mode;
            assert.ok((mode & 0o111) !== 0, `shim mode ${mode.toString(8)}`);
        }
        const packagedBridge = path.join(consumer, "node_modules", "ai-engineering-orchestrator", "bridge", "antigravity-mcp");
        assert.equal(existsSync(path.join(packagedBridge, "node_modules")), false);
        assert.equal(existsSync(path.join(packagedBridge, "package-lock.json")), true);

        const help = run("npx", ["--no-install", "aeo", "--help"], { cwd: consumer, env });
        assertRan(help, "npx aeo --help");
        assert.match(help.stdout, /aeo <install\|update\|uninstall\|status\|doctor>/);
        assert.doesNotMatch(help.stdout, /node scripts\/aeo\.mjs/);

        const dryRun = run("npx", ["--no-install", "aeo", "install", "--target", target, "--codex", "--dry-run"], { cwd: consumer, env });
        assertRan(dryRun, "dry-run");
        assert.match(dryRun.stdout, /Dry run\. No files were written\./);
        assert.equal(existsSync(path.join(target, ".aeo")), false);

        const installed = run("npx", ["--no-install", "aeo", "install", "--target", target, "--codex"], { cwd: consumer, env });
        assertRan(installed, "install");
        assert.match(installed.stdout, /Install finished\./);
        const bridge = path.join(target, ".aeo", "bridge", "antigravity-mcp");
        assert.equal(existsSync(path.join(bridge, "lib", "worktree.js")), true);
        assert.equal(existsSync(path.join(bridge, "node_modules")), true);
        assert.equal(existsSync(path.join(bridge, "test")), false);
        assert.equal(existsSync(path.join(target, ".aeo", "bridge", "cursor-mcp")), false);
        assert.equal(existsSync(path.join(packagedBridge, "node_modules")), false);
        const loaded = run(process.execPath, [
            "--input-type=module",
            "-e",
            "import { createServer } from './lib/server.js'; if (!createServer()) process.exit(2);"
        ], { cwd: bridge, env });
        assertRan(loaded, "load copied bridge");

        const status = run("npx", ["--no-install", "aeo", "status", "--target", target], { cwd: consumer, env });
        assertRan(status, "status");
        const report = JSON.parse(status.stdout);
        assert.equal(report.installed, true);
        assert.equal(report.bridge.filesPresent, true);
        assert.equal(report.bridge.dependenciesInstalled, true);

        const doctor = run("npx", ["--no-install", "aeo", "doctor", "--target", target], { cwd: consumer, env });
        assertRan(doctor, "doctor");
        assert.match(doctor.stdout, /Doctor found no problems\./);

        const removed = run("npx", ["--no-install", "aeo", "uninstall", "--target", target], { cwd: consumer, env });
        assertRan(removed, "uninstall");
    } finally {
        for (const file of realPaths) {
            assert.equal(await fileStamp(file), before.get(file), file);
        }
        await rm(parent, { recursive: true, force: true });
    }
});
