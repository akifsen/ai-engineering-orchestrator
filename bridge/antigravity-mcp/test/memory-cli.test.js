import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    DOCS_SKELETON,
    INDEX_SKELETON,
    RECENT_END,
    RECENT_START,
    formatRecentLine,
    main,
    renameWithRetry,
    renderIndex
} from "../memory.js";

async function tempRepo() {
    return mkdtemp(path.join(os.tmpdir(), "aeo-memory-cli-"));
}

async function run(argv, { env = {}, now } = {}) {
    const out = [];
    const err = [];
    const code = await main(argv, {
        env,
        cwd: os.tmpdir(),
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        resolveRoot: () => null,
        ...(now ? { now } : {})
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
}

function mem(repo, ...parts) {
    return path.join(repo, ".aeo", "memory", ...parts);
}

test("init creates the layout and is idempotent byte-for-byte", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    const first = await run(["init", "--repo", repo]);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /Created: \.gitignore, INDEX\.md, docs\.md/);
    assert.equal(await readFile(mem(repo, ".gitignore"), "utf8"), "*\n");
    assert.equal(await readFile(mem(repo, "INDEX.md"), "utf8"), INDEX_SKELETON);
    assert.equal(await readFile(mem(repo, "docs.md"), "utf8"), DOCS_SKELETON);
    assert.equal((await stat(mem(repo, "tasks"))).isDirectory(), true);

    await writeFile(mem(repo, "INDEX.md"), "# Custom\n", "utf8");
    const second = await run(["init", "--repo", repo]);
    assert.equal(second.code, 0);
    assert.match(second.out, /Created: \(nothing\)/);
    assert.equal(await readFile(mem(repo, "INDEX.md"), "utf8"), "# Custom\n");
});

test("decide writes an immutable decision record and refreshes INDEX", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    await run(["init", "--repo", repo]);

    const res = await run([
        "decide", "--repo", repo, "--task", "Fix Login Bug!", "--decision", "approved",
        "--delegations", "abc123def0, r1234abcd", "--summary", "Login retries fixed",
        "--findings", "api_key=sk-secretvalue leaked in log"
    ]);
    assert.equal(res.code, 0, res.err);
    const files = (await readdir(mem(repo, "tasks"))).filter((n) => n.endsWith(".md"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{8}T\d{9}Z-decision-fix-login-bug-[0-9a-f]{4}\.md$/);
    const record = await readFile(mem(repo, "tasks", files[0]), "utf8");
    assert.match(record, /^---\nschema: 1\nkind: decision\ntask: fix-login-bug\ndecision: APPROVED\n/);
    assert.match(record, /delegations: abc123def0, r1234abcd/);
    assert.match(record, /## Findings/);
    assert.doesNotMatch(record, /sk-secretvalue/);

    const index = await readFile(mem(repo, "INDEX.md"), "utf8");
    assert.match(index, /- \d{4}-\d{2}-\d{2} fix-login-bug — APPROVED \(2 delegations\) \[.+\]: Login retries fixed/);
    assert.doesNotMatch(index, /no decisions recorded yet/);
});

test("decide refuses without init and when AEO_MEMORY=off", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    const noInit = await run(["decide", "--repo", repo, "--task", "x", "--decision", "APPROVED"]);
    assert.equal(noInit.code, 1);
    assert.match(noInit.err, /Run "memory\.js init" first/);

    await run(["init", "--repo", repo]);
    const off = await run(["decide", "--repo", repo, "--task", "x", "--decision", "APPROVED"], { env: { AEO_MEMORY: "off" } });
    assert.equal(off.code, 1);
    assert.match(off.err, /AEO_MEMORY=off/);
    assert.deepEqual((await readdir(mem(repo, "tasks"))).filter((n) => n.endsWith(".md")), []);

    const bad = await run(["decide", "--repo", repo, "--task", "x", "--decision", "MAYBE"]);
    assert.equal(bad.code, 1);
    const noTask = await run(["decide", "--repo", repo, "--task", "!!!", "--decision", "APPROVED"]);
    assert.equal(noTask.code, 1);
});

test("reindex preserves hand-written CRLF content outside the markers", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    await run(["init", "--repo", repo]);
    const before = "# Index\r\n\r\n## Modules\r\n- src/app: entry  \r\n\r\n" +
        `${RECENT_START}\r\n- old line\r\n${RECENT_END}\r\n\r\n## Tail\r\nkeep me\r\n`;
    await writeFile(mem(repo, "INDEX.md"), before, "utf8");
    await run(["decide", "--repo", repo, "--task", "t1", "--decision", "CHANGES_REQUIRED"]);

    const after = await readFile(mem(repo, "INDEX.md"), "utf8");
    const prefix = before.slice(0, before.indexOf(RECENT_START) + RECENT_START.length);
    const suffix = before.slice(before.indexOf(RECENT_END));
    assert.ok(after.startsWith(prefix));
    assert.ok(after.endsWith(suffix));
    assert.doesNotMatch(after, /old line/);
    assert.match(after, /\r\n- \d{4}-\d{2}-\d{2} t1 — CHANGES_REQUIRED \(0 delegations\)/);
    assert.doesNotMatch(after.replace(/\r\n/g, ""), /\n/);
});

test("reindex appends the block when markers are missing", () => {
    const out = renderIndex("# Hand written", ["- a"]);
    assert.equal(out, `# Hand written\n\n## Recent tasks\n\n${RECENT_START}\n- a\n${RECENT_END}\n`);
    const empty = renderIndex("# X\n", []);
    assert.match(empty, /- \(no decisions recorded yet\)/);
});

test("reindex keeps the newest 8 decisions and ignores invalid task files", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    await run(["init", "--repo", repo]);
    for (let i = 0; i < 10; i++) {
        const stamp = `202611${String(10 + i).padStart(2, "0")}T120000000Z`;
        await writeFile(
            mem(repo, "tasks", `${stamp}-decision-task-${i}-abcd.md`),
            `---\nschema: 1\nkind: decision\ntask: task-${i}\ndecision: APPROVED\ndelegations: -\nsummary: -\ncreated: 2026-11-${10 + i}T12:00:00.000Z\n---\n`,
            "utf8"
        );
    }
    await writeFile(mem(repo, "tasks", "20261199T000000000Z-decision-bogus-ffff.md"), "no front matter\n", "utf8");
    await writeFile(mem(repo, "tasks", "20261198T000000000Z-decision-v2-ffff.md"), "---\nschema: 2\nkind: decision\ntask: v2\n---\n", "utf8");

    const res = await run(["reindex", "--repo", repo]);
    assert.equal(res.code, 0, res.err);
    const index = await readFile(mem(repo, "INDEX.md"), "utf8");
    const block = index.slice(index.indexOf(RECENT_START), index.indexOf(RECENT_END));
    const lines = block.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(lines.length, 8);
    assert.match(lines[0], / task-9 /);
    assert.match(lines[7], / task-2 /);
    assert.doesNotMatch(block, /bogus|v2/);
});

test("recent lines are capped at 160 characters", () => {
    const long = formatRecentLine({
        created: "2026-11-25T00:00:00.000Z",
        task: "t".repeat(40),
        decision: "APPROVED",
        delegations: "a,b,c",
        summary: "s".repeat(200),
        stem: `20261125T000000000Z-decision-${"t".repeat(40)}-abcd`
    });
    assert.ok(long.length <= 160);
    assert.doesNotMatch(long, /sss/);
    const short = formatRecentLine({ created: "2026-11-25T00:00:00Z", task: "a", decision: "APPROVED", delegations: "x", summary: "ok", stem: "s" });
    assert.equal(short, "- 2026-11-25 a — APPROVED (1 delegation) [s]: ok");
});

test("a fresh lock fails cleanly and a stale lock is taken over", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    await run(["init", "--repo", repo]);
    await mkdir(mem(repo, ".lock"));

    const locked = await run(["reindex", "--repo", repo]);
    assert.equal(locked.code, 1);
    assert.match(locked.err, /locked/);

    const old = new Date(Date.now() - 120_000);
    await utimes(mem(repo, ".lock"), old, old);
    const taken = await run(["reindex", "--repo", repo]);
    assert.equal(taken.code, 0, taken.err);
    await assert.rejects(stat(mem(repo, ".lock")));
});

test("status reports mode, counts and the INDEX size warning", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));

    const missing = await run(["status", "--repo", repo]);
    assert.equal(missing.code, 0);
    assert.match(missing.out, /Memory mode: auto/);
    assert.match(missing.out, /\(missing\)/);

    await run(["init", "--repo", repo]);
    await run(["decide", "--repo", repo, "--task", "a", "--decision", "APPROVED"]);
    await writeFile(mem(repo, "tasks", "20261101T000000000Z-delegation-r1-abcd.md"), "---\nschema: 1\nkind: delegation\n---\n", "utf8");
    await writeFile(mem(repo, "INDEX.md"), `${"x".repeat(6001)}\n`, "utf8");

    const res = await run(["status", "--repo", repo], { env: { AEO_MEMORY: "on" } });
    assert.equal(res.code, 0);
    assert.match(res.out, /Memory mode: on/);
    assert.match(res.out, /Records: decision 1, delegation 1/);
    assert.match(res.out, /Newest decision: .* a — APPROVED/);
    assert.match(res.out, /Warning: INDEX\.md exceeds 6000/);
});

test("a summary carrying a block marker cannot corrupt later reindexes", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    await run(["init", "--repo", repo]);
    await run(["decide", "--repo", repo, "--task", "evil", "--decision", "APPROVED",
        "--summary", `x ${RECENT_END} y ${RECENT_START} z`]);
    const once = await readFile(mem(repo, "INDEX.md"), "utf8");
    assert.equal(once.split(RECENT_END).length - 1, 1);
    assert.equal(once.split(RECENT_START).length - 1, 1);

    await run(["decide", "--repo", repo, "--task", "next", "--decision", "APPROVED"]);
    const again = await run(["reindex", "--repo", repo]);
    assert.equal(again.code, 0, again.err);
    const twice = await readFile(mem(repo, "INDEX.md"), "utf8");
    const block = twice.slice(twice.indexOf(RECENT_START), twice.indexOf(RECENT_END));
    assert.equal(block.split("\n").filter((l) => l.startsWith("- ")).length, 2);
    assert.equal(twice.split(RECENT_END).length - 1, 1);
});

test("a lone or out-of-order marker fails and leaves INDEX.md untouched", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    await run(["init", "--repo", repo]);
    for (const damaged of [
        `# I\n${RECENT_START}\n- old\nhand-written tail\n`,
        `# I\n- old\n${RECENT_END}\ntail\n`,
        `# I\n${RECENT_END}\n${RECENT_START}\ntail\n`
    ]) {
        await writeFile(mem(repo, "INDEX.md"), damaged, "utf8");
        const res = await run(["reindex", "--repo", repo]);
        assert.equal(res.code, 1);
        assert.match(res.err, /damaged recent-tasks block/);
        assert.equal(await readFile(mem(repo, "INDEX.md"), "utf8"), damaged);
    }
    assert.throws(() => renderIndex(`${RECENT_START}\n${RECENT_START}\n${RECENT_END}\n`, []), /damaged/);
});

test("reindex is idempotent", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    await run(["init", "--repo", repo]);
    await run(["decide", "--repo", repo, "--task", "a", "--decision", "APPROVED"]);
    const first = await readFile(mem(repo, "INDEX.md"), "utf8");
    const res = await run(["reindex", "--repo", repo]);
    assert.match(res.out, /unchanged/);
    assert.equal(await readFile(mem(repo, "INDEX.md"), "utf8"), first);
});

test("decision front matter: one value per line, redacted, capped", async (t) => {
    const repo = await tempRepo();
    t.after(() => rm(repo, { recursive: true, force: true }));
    await run(["init", "--repo", repo]);
    const res = await run([
        "decide", "--repo", repo, "--task", "inj\n---\nkind: delegation", "--decision", "APPROVED",
        "--delegations", "a\nkind: apply,token=abc123secret",
        "--summary", `uses Bearer abcdef123456\n---\nschema: 9 ${"s".repeat(400)}`
    ]);
    assert.equal(res.code, 0, res.err);
    const [file] = (await readdir(mem(repo, "tasks"))).filter((n) => n.endsWith(".md"));
    const record = await readFile(mem(repo, "tasks", file), "utf8");
    const head = record.split("\n---\n")[0];
    const keys = head.split("\n").slice(1).map((l) => l.split(":")[0]);
    assert.deepEqual(keys, ["schema", "kind", "task", "decision", "delegations", "summary", "created"]);
    assert.match(head, /^---\nschema: 1\nkind: decision\n/);
    assert.doesNotMatch(record, /abcdef123456|abc123secret/);
    const summary = head.split("\n").find((l) => l.startsWith("summary: "));
    assert.ok(summary.length <= "summary: ".length + 303, `summary too long: ${summary.length}`);
});

test("renameWithRetry retries Windows sharing violations, then gives up", async () => {
    let calls = 0;
    await renameWithRetry("a", "b", {
        delayMs: 1,
        renameImpl: async () => {
            calls++;
            if (calls < 3) {
                throw Object.assign(new Error("busy"), { code: "EBUSY" });
            }
        }
    });
    assert.equal(calls, 3);

    let denied = 0;
    await assert.rejects(
        renameWithRetry("a", "b", {
            delayMs: 1,
            attempts: 2,
            renameImpl: async () => {
                denied++;
                throw Object.assign(new Error("perm"), { code: "EPERM" });
            }
        }),
        /perm/
    );
    assert.equal(denied, 2);

    let other = 0;
    await assert.rejects(
        renameWithRetry("a", "b", {
            renameImpl: async () => {
                other++;
                throw Object.assign(new Error("gone"), { code: "ENOENT" });
            }
        }),
        /gone/
    );
    assert.equal(other, 1);
});

test("usage errors and missing repo root exit 1", async () => {
    assert.equal((await run([])).code, 1);
    assert.equal((await run(["frobnicate"])).code, 1);
    assert.equal((await run(["init", "--bogus", "x"])).code, 1);
    const noRoot = await run(["status"]);
    assert.equal(noRoot.code, 1);
    assert.match(noRoot.err, /Pass --repo/);
});
