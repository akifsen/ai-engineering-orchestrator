import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BASELINE_HEADING } from "../lib/ledger.js";
import { DOCS_SKELETON, INDEX_SKELETON, buildContext, main } from "../memory.js";

async function tempRepo(t, { init = true } = {}) {
    const repo = await mkdtemp(path.join(os.tmpdir(), "aeo-memory-ctx-"));
    t.after(() => rm(repo, { recursive: true, force: true }));
    if (init) {
        await mkdir(mem(repo, "tasks"), { recursive: true });
        await writeFile(mem(repo, "INDEX.md"), INDEX_SKELETON, "utf8");
        await writeFile(mem(repo, "docs.md"), DOCS_SKELETON, "utf8");
    }
    return repo;
}

function mem(repo, ...parts) {
    return path.join(repo, ".aeo", "memory", ...parts);
}

async function record(repo, stamp, kind, ref, fields, body = "") {
    const name = `${stamp}-${kind}-${ref}-abcd.md`;
    const head = ["---", "schema: 1", `kind: ${kind}`, ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "---", ""].join("\n");
    await writeFile(mem(repo, "tasks", name), head + body, "utf8");
    return name;
}

const T1 = "20260101T100000000Z";
const T2 = "20260102T100000000Z";
const T3 = "20260103T100000000Z";
const T4 = "20260104T100000000Z";

async function runMain(argv, { repo, env = {}, stdin, resolveRoot } = {}) {
    const out = [];
    const err = [];
    const code = await main(argv, {
        env,
        cwd: os.tmpdir(),
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        resolveRoot: resolveRoot ?? (() => repo ?? null),
        ...(stdin !== undefined ? { stdin } : {})
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
}

test("context has all sections and respects caps", async (t) => {
    const repo = await tempRepo(t);
    await writeFile(mem(repo, "INDEX.md"), "x".repeat(7000), "utf8");
    const text = await buildContext(repo, { source: "startup" });
    assert.match(text, /^# AEO project memory\n/);
    assert.match(text, /\(source: startup\)\. Open the files only for detail it does not cover\./);
    assert.match(text, /## INDEX\.md/);
    assert.match(text, /\[truncated: 1000 chars omitted; open \.aeo\/memory\/INDEX\.md\]/);
    assert.match(text, /## Docs registry/);
    assert.match(text, /## Open task/);
    assert.ok(text.length <= 9000);
});

test("missing INDEX.md is reported", async (t) => {
    const repo = await tempRepo(t);
    await rm(mem(repo, "INDEX.md"));
    assert.match(await buildContext(repo, { source: "startup" }), /\(missing; run memory\.js init\)/);
});

test("docs registry counts table rows", async (t) => {
    const repo = await tempRepo(t);
    assert.match(await buildContext(repo, { source: "startup" }), /docs\.md is empty/);
    await writeFile(
        mem(repo, "docs.md"),
        `${DOCS_SKELETON}| a | npm | 1 | src | 2026 | - |\n| b | npm | 2 | src | 2026 | - |\n`,
        "utf8"
    );
    assert.match(await buildContext(repo, { source: "startup" }), /docs\.md lists 2 libraries; read \.aeo\/memory\/docs\.md/);
    await rm(mem(repo, "docs.md"));
    assert.match(await buildContext(repo, { source: "startup" }), /docs\.md is empty/);
});

test("open task lists records after the newest decision", async (t) => {
    const repo = await tempRepo(t);
    await record(repo, T1, "delegation", "old1", { engineer: "antigravity", outcome: "success", delegation_id: "old1", created: "2026-01-01T10:00:00.000Z" });
    await record(repo, T2, "decision", "task", { task: "task", decision: "APPROVED", created: "2026-01-02T10:00:00.000Z" });
    await record(repo, T3, "delegation", "new1", { engineer: "antigravity", outcome: "success", delegation_id: "new1", run_id: "r1", created: "2026-01-03T10:00:00.000Z" });
    await record(repo, T4, "apply", "new1", { engineer: "antigravity", outcome: "applied", delegation_id: "new1", created: "2026-01-04T10:00:00.000Z" });
    await writeFile(mem(repo, "tasks", "junk.md"), "not a record", "utf8");

    const text = await buildContext(repo, { source: "startup" });
    assert.ok(!text.includes("old1"));
    assert.match(text, /- 2026-01-04T10:00:00 apply new1 applied \(antigravity\) \[\.aeo\/memory\/tasks\/20260104T100000000Z-apply-new1-abcd\.md\]/);
    assert.ok(text.indexOf("apply new1") < text.indexOf("delegation new1"));
});

test("open task without any open records", async (t) => {
    const repo = await tempRepo(t);
    await record(repo, T1, "delegation", "d1", { engineer: "antigravity", outcome: "success", delegation_id: "d1", created: "2026-01-01T10:00:00.000Z" });
    await record(repo, T2, "decision", "task", { task: "task", decision: "APPROVED", created: "2026-01-02T10:00:00.000Z" });
    assert.match(await buildContext(repo, { source: "startup" }), /- \(no open delegations since the last decision\)/);
});

test("compact adds baseline and contract excerpt, startup does not", async (t) => {
    const repo = await tempRepo(t);
    const body = `\n${BASELINE_HEADING}\n\n\`\`\`text\n M src/a.js\n\`\`\`\n\n## Contract (excerpt)\n\nDo the thing.\n\n## Diffstat\n\nsecret-diff\n`;
    const name = await record(repo, T3, "delegation", "new1", { engineer: "antigravity", outcome: "success", delegation_id: "new1", created: "2026-01-03T10:00:00.000Z" }, body);
    const stem = name.slice(0, -3);

    const compact = await buildContext(repo, { source: "compact" });
    assert.ok(compact.includes(`### Baseline before ${stem}`));
    assert.ok(compact.includes(" M src/a.js"));
    assert.match(compact, /### Contract excerpt\n\nDo the thing\./);
    assert.ok(!compact.includes("secret-diff"));

    const startup = await buildContext(repo, { source: "startup" });
    assert.ok(!startup.includes("### Baseline before"));
    assert.ok(!startup.includes("### Contract excerpt"));
});

test("hook prints SessionStart JSON and writes a stats line", async (t) => {
    const repo = await tempRepo(t);
    const res = await runMain(["hook", "session-start"], { repo, stdin: JSON.stringify({ cwd: repo, source: "startup" }) });
    assert.equal(res.code, 0, res.err);
    const lines = res.out.split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /# AEO project memory/);
    const stat = JSON.parse((await readFile(mem(repo, "stats", "session-start.jsonl"), "utf8")).trim());
    assert.equal(stat.source, "startup");
    assert.equal(stat.chars, parsed.hookSpecificOutput.additionalContext.length);
    assert.equal(stat.open, 0);
    assert.ok(stat.ts);
});

test("hook prints nothing and exits 0 when it cannot or must not inject", async (t) => {
    const repo = await tempRepo(t);
    const empty = await tempRepo(t, { init: false });
    const good = JSON.stringify({ cwd: repo, source: "startup" });

    const off = await runMain(["hook", "session-start"], { repo, env: { AEO_MEMORY: "off" }, stdin: good });
    assert.deepEqual([off.code, off.out], [0, ""]);

    const missing = await runMain(["hook", "session-start"], { repo: empty, stdin: good });
    assert.deepEqual([missing.code, missing.out], [0, ""]);

    const invalid = await runMain(["hook", "session-start"], { repo, stdin: "{not json" });
    assert.deepEqual([invalid.code, invalid.out], [0, ""]);
    assert.ok(invalid.err.length > 0);

    const noRoot = await runMain(["hook", "session-start"], { stdin: good, resolveRoot: () => null });
    assert.deepEqual([noRoot.code, noRoot.out], [0, ""]);
});

test("context command prints and exits 1 when memory is missing", async (t) => {
    const repo = await tempRepo(t);
    const empty = await tempRepo(t, { init: false });
    const ok = await runMain(["context", "--source", "resume", "--repo", repo]);
    assert.equal(ok.code, 0);
    assert.match(ok.out, /source: resume/);
    const bad = await runMain(["context", "--repo", empty]);
    assert.equal(bad.code, 1);
});
