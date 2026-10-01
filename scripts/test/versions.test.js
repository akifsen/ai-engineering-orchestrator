import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AEO_VERSION } from "../lib/installer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(relative) {
    return JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));
}

test("root package version is the canonical AEO version", () => {
    const root = readJson("package.json");
    assert.equal(root.name, "ai-engineering-orchestrator");
    assert.equal(root.name.startsWith("@"), false);
    assert.equal(root.private, undefined);
    assert.equal(root.license, "MIT");
    assert.equal(root.type, "module");
    assert.equal(root.engines.node, ">=20");
    assert.equal(root.bin.aeo, "./scripts/aeo.mjs");
    assert.equal(root.version, AEO_VERSION);
    assert.equal(root.publishConfig.access, "public");
    for (const name of ["preinstall", "install", "postinstall", "prepack", "postpack", "prepare"]) {
        assert.equal(root.scripts[name], undefined, name);
    }
});

test("bridge package versions stay aligned and private", () => {
    const root = readJson("package.json");
    for (const directory of ["bridge/antigravity-mcp", "bridge/cursor-mcp"]) {
        const pkg = readJson(path.posix.join(directory, "package.json"));
        const lock = readJson(path.posix.join(directory, "package-lock.json"));
        const server = readFileSync(path.join(repoRoot, directory, "lib", "server.js"), "utf8");
        assert.equal(pkg.private, true, directory);
        assert.equal(pkg.version, root.version, directory);
        assert.equal(lock.version, pkg.version, directory);
        assert.equal(lock.packages[""].version, pkg.version, directory);
        assert.match(server, /version:\s*packageVersion/);
        assert.doesNotMatch(server, /version:\s*"\d+\.\d+\.\d+"/);
    }
});
