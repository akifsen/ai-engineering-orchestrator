import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MAX_RECORD_BYTES, buildRecordContent, filterBaseline, memoryWillWrite } from "../lib/ledger.js";

const created = new Date("2026-11-26T00:00:00.000Z");

test("baseline section: clean tree, absent, order and front matter", () => {
    const clean = buildRecordContent({ baseline: "", contract: "Do it." }, created, "r1");
    assert.match(clean, /baseline_lines: 0\n/);
    assert.match(clean, /## Baseline \(git status --short before the run\)\n\n```text\n\(clean\)\n```\n/);
    assert.ok(clean.indexOf("## Baseline") < clean.indexOf("## Contract"));

    const absent = buildRecordContent({ contract: "Do it." }, created, "r1");
    assert.doesNotMatch(absent, /Baseline|baseline_lines/);

    const dirty = buildRecordContent({ baseline: " M src/a.js\n?? notes.md\n", response: "Summary." }, created, "r1");
    assert.match(dirty, /baseline_lines: 2\n/);
    assert.match(dirty, /```text\n M src\/a\.js\n\?\? notes\.md\n```/);
});

test("baseline section caps at 40 lines with a remainder note", () => {
    const lines = Array.from({ length: 45 }, (_, i) => ` M file${i}.js`).join("\n");
    const record = buildRecordContent({ baseline: lines }, created, "r1");
    assert.match(record, /baseline_lines: 45\n/);
    assert.match(record, / M file39\.js\n\.\.\. \(5 more\)\n```/);
    assert.doesNotMatch(record, /file40\.js/);
});

test("the 8 KB cap trims later sections and keeps the baseline intact", () => {
    const baseline = Array.from({ length: 30 }, (_, i) => ` M src/module-${i}/file.js`).join("\n");
    const record = buildRecordContent(
        { baseline, contract: "c".repeat(600), response: "r".repeat(1200), diffstat: Array.from({ length: 40 }, (_, i) => `${"d".repeat(150)}${i} | +1 -1`).join("\n") },
        created,
        "r1"
    );
    assert.ok(Buffer.byteLength(record, "utf8") <= MAX_RECORD_BYTES);
    assert.match(record, /```text\n( M src\/module-\d+\/file\.js\n){30}```\n/);
    assert.match(record, /\[truncated\]\n$/);
});

test("filterBaseline drops ledger paths, quoted or not, and blank lines", () => {
    const input = " M src/a.js\r\n?? .aeo/memory/tasks/x.md\r\n?? \".aeo/memory/INDEX.md\"\r\n\r\nA  .aeo/bridge/x.js\r\n";
    assert.equal(filterBaseline(input), " M src/a.js\nA  .aeo/bridge/x.js");
    assert.equal(filterBaseline(""), "");
    assert.equal(filterBaseline(undefined), "");
});

test("memoryWillWrite follows AEO_MEMORY and the memory directory", async (t) => {
    const repo = await mkdtemp(path.join(tmpdir(), "aeo-will-write-"));
    t.after(() => rm(repo, { recursive: true, force: true }));
    assert.equal(await memoryWillWrite(repo, { AEO_MEMORY: "off" }), false);
    assert.equal(await memoryWillWrite(repo, {}), false);
    assert.equal(await memoryWillWrite(repo, { AEO_MEMORY: "on" }), true);
    await mkdir(path.join(repo, ".aeo", "memory"), { recursive: true });
    assert.equal(await memoryWillWrite(repo, {}), true);
    assert.equal(await memoryWillWrite("", { AEO_MEMORY: "on" }), false);
});
