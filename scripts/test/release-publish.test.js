import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
    assertTagMatchesCanonicalVersions,
    classifyRegistryLookup,
    decideReleasePublish,
    publishArguments
} from "../lib/release-publish.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const artifact = {
    name: "ai-engineering-orchestrator",
    version: "1.2.0",
    filename: "ai-engineering-orchestrator-1.2.0.tgz",
    integrity: "sha512-local",
    shasum: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    size: 100,
    unpackedSize: 200,
    entryCount: 3
};

function decisionFor(lookup) {
    return decideReleasePublish({
        artifact,
        registry: classifyRegistryLookup(lookup)
    });
}

test("a 404 means the packed artifact should be published", () => {
    const decision = decisionFor({
        status: 1,
        stdout: "",
        stderr: "npm error code E404\n404 Not Found - GET https://registry.npmjs.org/ai-engineering-orchestrator"
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.shouldPublish, true);
    assert.equal(decision.alreadyPublished, false);
});

test("an identical integrity and shasum is a successful no-op", () => {
    const decision = decisionFor({
        status: 0,
        stdout: JSON.stringify({
            integrity: artifact.integrity,
            shasum: artifact.shasum,
            tarball: "https://registry.npmjs.org/ai-engineering-orchestrator/-/ai-engineering-orchestrator-1.2.0.tgz"
        })
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.shouldPublish, false);
    assert.equal(decision.alreadyPublished, true);
    assert.match(decision.message, /ai-engineering-orchestrator@1\.2\.0 already exists and matches the exact packed artifact\./);
    assert.match(decision.message, /Nothing to publish\./);
});

test("an existing version with a different integrity fails", () => {
    const decision = decisionFor({
        status: 0,
        stdout: JSON.stringify({
            integrity: "sha512-other",
            shasum: artifact.shasum
        })
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.shouldPublish, false);
    assert.match(decision.message, /SECURITY ERROR:/);
    assert.match(decision.message, /does not match this release/);
});

test("an existing version with a different shasum fails", () => {
    const decision = decisionFor({
        status: 0,
        stdout: JSON.stringify({
            integrity: artifact.integrity,
            shasum: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        })
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.shouldPublish, false);
    assert.match(decision.message, /SECURITY ERROR:/);
});

test("registry and network failures are not treated as a missing package", () => {
    for (const lookup of [
        { status: 1, stderr: "npm error code ECONNRESET" },
        { status: 1, stderr: "npm error code E500\nInternal Server Error" },
        { status: null, error: new Error("spawn npm ENOENT") },
        { status: 0, stdout: "not-json" }
    ]) {
        const decision = decisionFor(lookup);
        assert.equal(decision.ok, false, decision.message);
        assert.equal(decision.shouldPublish, false);
        assert.equal(decision.alreadyPublished, false);
    }
});

test("a tag that does not match the canonical versions fails", () => {
    const mismatch = assertTagMatchesCanonicalVersions("v1.2.0", {
        "package.json": "1.2.1",
        AEO_VERSION: "1.2.0"
    });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.message, /tag v1\.2\.0 requires 1\.2\.0/);
    const unstable = assertTagMatchesCanonicalVersions("v1.2.0-rc.1", { "package.json": "1.2.0" });
    assert.equal(unstable.ok, false);
});

test("the current repository versions match tag v1.2.0", () => {
    const root = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const versions = { "package.json": root.version };
    for (const directory of ["bridge/antigravity-mcp", "bridge/cursor-mcp"]) {
        const pkg = JSON.parse(readFileSync(path.join(repoRoot, directory, "package.json"), "utf8"));
        versions[directory] = pkg.version;
    }
    const result = assertTagMatchesCanonicalVersions("v1.2.0", versions);
    assert.equal(result.ok, true);
    assert.equal(result.version, "1.2.0");
});

test("publication uses the packed tarball and does not request provenance", () => {
    const args = publishArguments("/tmp/aeo-npm-pack/ai-engineering-orchestrator-1.2.0.tgz");
    assert.deepEqual(args, ["publish", "/tmp/aeo-npm-pack/ai-engineering-orchestrator-1.2.0.tgz", "--access", "public"]);
    const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");
    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /contents:\s*read/);
    assert.match(workflow, /runs-on:\s*ubuntu-latest/);
    assert.match(workflow, /pack-release-artifact\.mjs/);
    assert.match(workflow, /publish-packed-release\.mjs/);
    assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|--provenance/);
});
