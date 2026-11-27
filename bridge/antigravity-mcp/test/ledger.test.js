import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    redactSecrets,
    resolveMaxRecords,
    resolveMemoryMode,
    writeDelegationRecord
} from "../lib/ledger.js";

async function tempRepo() {
    return mkdtemp(path.join(tmpdir(), "aeo-ledger-"));
}

function baseRecord(extra = {}) {
    return {
        engineer: "antigravity",
        outcome: "agent_success",
        model: "m1",
        isolation: "none",
        revision: false,
        runId: "2026-01-01T00-00-00-000Z-deadbeef",
        reportPath: "/tmp/report.md",
        durationSeconds: 3,
        turns: 2,
        contract: "Do the thing",
        response: "Done.",
        ...extra
    };
}

function parseFrontMatter(text) {
    const lines = text.split("\n");
    assert.equal(lines[0], "---");
    const end = lines.indexOf("---", 1);
    assert.ok(end > 0);
    const map = {};
    for (const line of lines.slice(1, end)) {
        const idx = line.indexOf(": ");
        map[line.slice(0, idx)] = line.slice(idx + 2);
    }
    return { map, keys: lines.slice(1, end).map((l) => l.split(":")[0]) };
}

test("resolveMemoryMode handles defaults, valid and invalid values", () => {
    assert.equal(resolveMemoryMode({}), "auto");
    assert.equal(resolveMemoryMode({ AEO_MEMORY: "on" }), "on");
    assert.equal(resolveMemoryMode({ AEO_MEMORY: "OFF" }), "off");
    assert.equal(resolveMemoryMode({ AEO_MEMORY: "bogus" }), "auto");
});

test("resolveMaxRecords handles defaults and invalid values", () => {
    assert.equal(resolveMaxRecords({}), 300);
    assert.equal(resolveMaxRecords({ AEO_MEMORY_MAX_RECORDS: "5" }), 5);
    assert.equal(resolveMaxRecords({ AEO_MEMORY_MAX_RECORDS: "0" }), 300);
    assert.equal(resolveMaxRecords({ AEO_MEMORY_MAX_RECORDS: "abc" }), 300);
});

test("auto mode writes only when the memory dir exists", async () => {
    const repo = await tempRepo();
    try {
        const env = { AEO_MEMORY: "auto" };
        const first = await writeDelegationRecord({ repoRoot: repo, env, record: baseRecord() });
        assert.equal(first.written, false);
        await mkdir(path.join(repo, ".aeo", "memory"), { recursive: true });
        const second = await writeDelegationRecord({ repoRoot: repo, env, record: baseRecord() });
        assert.equal(second.written, true);
        assert.match(second.relativePath, /^\.aeo\/memory\/tasks\/.+\.md$/);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("off mode writes nothing", async () => {
    const repo = await tempRepo();
    try {
        await mkdir(path.join(repo, ".aeo", "memory"), { recursive: true });
        const res = await writeDelegationRecord({
            repoRoot: repo,
            env: { AEO_MEMORY: "off" },
            record: baseRecord()
        });
        assert.equal(res.written, false);
        const entries = await readdir(path.join(repo, ".aeo", "memory"));
        assert.deepEqual(entries, []);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("on mode creates the dir and .gitignore, and never overwrites an existing one", async () => {
    const repo = await tempRepo();
    try {
        const res = await writeDelegationRecord({
            repoRoot: repo,
            env: { AEO_MEMORY: "on" },
            record: baseRecord()
        });
        assert.equal(res.written, true);
        const ignore = path.join(repo, ".aeo", "memory", ".gitignore");
        assert.equal(await readFile(ignore, "utf8"), "*\n");

        await writeFile(ignore, "custom\n");
        await writeDelegationRecord({ repoRoot: repo, env: { AEO_MEMORY: "on" }, record: baseRecord() });
        assert.equal(await readFile(ignore, "utf8"), "custom\n");
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("refuses to write when the memory dir is under the worktree root", async () => {
    const repo = await tempRepo();
    try {
        const res = await writeDelegationRecord({
            repoRoot: repo,
            worktreeRoot: repo,
            env: { AEO_MEMORY: "on" },
            record: baseRecord()
        });
        assert.equal(res.written, false);
        await assert.rejects(readdir(path.join(repo, ".aeo")));
        const missing = await writeDelegationRecord({ env: { AEO_MEMORY: "on" }, record: baseRecord() });
        assert.equal(missing.written, false);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("worktree guard canonicalizes symlinked worktree roots", async (t) => {
    const base = await tempRepo();
    try {
        const repo = path.join(base, "real", "repo");
        await mkdir(repo, { recursive: true });
        const alias = path.join(base, "alias");
        try {
            symlinkSync(path.join(base, "real"), alias, process.platform === "win32" ? "junction" : "dir");
        } catch {
            t.skip("cannot create symlink");
            return;
        }
        const env = { AEO_MEMORY: "on" };
        const refused = await writeDelegationRecord({
            repoRoot: repo,
            worktreeRoots: [alias],
            env,
            record: baseRecord()
        });
        assert.equal(refused.written, false);

        const sibling = path.join(base, "sibling");
        await mkdir(sibling, { recursive: true });
        const allowed = await writeDelegationRecord({
            repoRoot: repo,
            worktreeRoots: [sibling],
            env,
            record: baseRecord()
        });
        assert.equal(allowed.written, true);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test("50 concurrent writes produce 50 distinct files with the expected name format", async () => {
    const repo = await tempRepo();
    try {
        const fixed = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
        const results = await Promise.all(
            Array.from({ length: 50 }, () =>
                writeDelegationRecord({
                    repoRoot: repo,
                    env: { AEO_MEMORY: "on" },
                    now: () => fixed,
                    record: baseRecord({ delegationId: "abcdef0123" })
                })
            )
        );
        assert.ok(results.every((r) => r.written));
        assert.equal(new Set(results.map((r) => r.relativePath)).size, 50);
        const files = await readdir(path.join(repo, ".aeo", "memory", "tasks"));
        assert.equal(files.length, 50);
        for (const name of files) {
            assert.match(name, /^20260102T030405006Z-delegation-abcdef0123-[0-9a-f]{4}\.md$/);
            assert.ok(name.length < 80);
        }
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("run id fallback ref and front matter format", async () => {
    const repo = await tempRepo();
    try {
        const res = await writeDelegationRecord({
            repoRoot: repo,
            env: { AEO_MEMORY: "on" },
            record: baseRecord({ attempts: ["m1:quota_or_auth_failure", "m2:agent_success"] })
        });
        assert.match(res.relativePath, /-delegation-rdeadbeef-[0-9a-f]{4}\.md$/);
        const text = await readFile(path.join(repo, res.relativePath), "utf8");
        const { map, keys } = parseFrontMatter(text);
        assert.deepEqual(keys.slice(0, 2), ["schema", "kind"]);
        assert.equal(map.schema, "1");
        assert.equal(map.kind, "delegation");
        assert.equal(map.delegation_id, "-");
        assert.equal(map.revision, "false");
        assert.equal(map.attempts, "m1:quota_or_auth_failure, m2:agent_success");
        assert.equal(map.contract_chars, "12");
        assert.match(map.contract_sha256, /^[0-9a-f]{64}$/);
        assert.ok(text.includes("## Contract (excerpt)"));
        assert.ok(text.includes("## Engineer summary (excerpt)"));
        assert.ok(!text.includes("## Diffstat"));
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("redactSecrets covers the supported secret shapes", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
    const input = [
        "key sk-abc123DEF456",
        "ctx7sk-1234-abcd",
        "AKIAABCDEFGHIJKLMNOP",
        "Authorization: Bearer abc.def.ghi",
        "password = hunter2",
        "api_key: xyz",
        pem
    ].join("\n");
    const out = redactSecrets(input);
    for (const leaked of ["sk-abc123", "ctx7sk-1234", "AKIAABCDEF", "abc.def.ghi", "hunter2", "xyz", "BEGIN RSA"]) {
        assert.ok(!out.includes(leaked), `leaked ${leaked}`);
    }
    assert.ok(out.includes("[REDACTED]"));
});

test("record is capped at 8 KB and keeps front matter", async () => {
    const repo = await tempRepo();
    try {
        const res = await writeDelegationRecord({
            repoRoot: repo,
            env: { AEO_MEMORY: "on" },
            record: baseRecord({
                contract: "c".repeat(5000),
                response: "r".repeat(5000),
                diffstat: Array.from({ length: 100 }, (_, i) => `file${i}.js | 1 +`).join("\n")
            })
        });
        const text = await readFile(path.join(repo, res.relativePath), "utf8");
        assert.ok(Buffer.byteLength(text, "utf8") <= 8192);
        assert.equal(parseFrontMatter(text).map.schema, "1");
        assert.ok(!text.includes("file40.js"));
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("prune deletes oldest delegation records and keeps decisions", async () => {
    const repo = await tempRepo();
    try {
        const tasks = path.join(repo, ".aeo", "memory", "tasks");
        await mkdir(tasks, { recursive: true });
        const decision = "20200101T000000000Z-decision-x-aaaa.md";
        await writeFile(path.join(tasks, decision), "d");
        for (let i = 1; i <= 3; i++) {
            await writeFile(path.join(tasks, `2020010${i}T000000000Z-delegation-old${i}-aaaa.md`), "x");
        }
        const res = await writeDelegationRecord({
            repoRoot: repo,
            env: { AEO_MEMORY: "on", AEO_MEMORY_MAX_RECORDS: "2" },
            record: baseRecord()
        });
        assert.equal(res.written, true);
        const files = (await readdir(tasks)).sort();
        assert.ok(files.includes(decision));
        assert.ok(!files.some((f) => f.includes("old1") || f.includes("old2")));
        assert.ok(files.some((f) => f.includes("old3")));
        assert.equal(files.filter((f) => f.includes("-delegation-")).length, 2);
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});
