import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { unsupportedNodeMessage } from "../lib/node-version.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts", "aeo.mjs");

const usage = [
    "Usage:",
    "  aeo <install|update|uninstall|status|doctor>",
    "    --target <project>",
    "    [--codex]",
    "    [--claude]",
    "    [--dry-run]",
    "    [--force-managed-update]",
    "    [--force-remove-modified]"
].join("\n");

test("node 20 and newer pass the version gate", () => {
    assert.equal(unsupportedNodeMessage("20.0.0"), null);
    assert.equal(unsupportedNodeMessage("22.14.0"), null);
    assert.equal(unsupportedNodeMessage(process.versions.node), null);
});

test("node older than 20 is rejected with the running version", () => {
    for (const version of ["18.20.4", "19.9.0", "0.10.0"]) {
        const message = unsupportedNodeMessage(version);
        assert.match(message, /AEO requires Node\.js 20 or newer\./);
        assert.match(message, new RegExp(`Current version: ${version.replaceAll(".", "\\.")}`));
        assert.match(message, /Upgrade Node\.js before continuing\./);
    }
    assert.match(unsupportedNodeMessage(""), /Current version: unknown/);
    assert.match(unsupportedNodeMessage("not-a-version"), /Current version: not-a-version/);
});

test("help lists every supported flag", () => {
    for (const args of [[], ["--help"], ["-h"]]) {
        const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(usage), result.stdout);
        assert.match(result.stdout, /--force-remove-modified/);
        assert.equal(result.stderr, "");
    }
    const unknown = spawnSync(process.execPath, [cli, "nope"], { encoding: "utf8" });
    assert.equal(unknown.status, 1);
    assert.ok(unknown.stdout.includes(usage), unknown.stdout);
});

test("node 18 exits before any command writes the target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aeo-node-gate-"));
    const target = path.join(root, "project");
    const preload = path.join(root, "force-node-18.cjs");
    await mkdir(target);
    await writeFile(path.join(target, "sentinel.txt"), "keep\n");
    await writeFile(preload, [
        "Object.defineProperty(process.versions, \"node\", {",
        "    value: \"18.20.4\",",
        "    configurable: true,",
        "    enumerable: true",
        "});",
        ""
    ].join("\n"));
    const commands = [
        ["install", "--target", target, "--codex", "--claude"],
        ["update", "--target", target, "--codex"],
        ["uninstall", "--target", target, "--force-remove-modified"],
        ["status", "--target", target],
        ["doctor", "--target", target]
    ];
    try {
        for (const args of commands) {
            const result = spawnSync(process.execPath, ["--require", preload, cli, ...args], { encoding: "utf8" });
            assert.notEqual(result.status, 0, result.stdout);
            assert.match(result.stderr, /AEO requires Node\.js 20 or newer\./);
            assert.match(result.stderr, /Current version: 18\.20\.4/);
            assert.match(result.stderr, /Upgrade Node\.js before continuing\./);
            assert.equal(result.stdout, "");
        }
        assert.equal(await readFile(path.join(target, "sentinel.txt"), "utf8"), "keep\n");
        assert.deepEqual(await readdir(target), ["sentinel.txt"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
