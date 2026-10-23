import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { formatLine } from "../bench/hooks/count-compactions.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts", "bench", "hooks", "count-compactions.mjs");

test("formatLine formats timestamp, session_id, and trigger with tabs and trailing newline", () => {
    const fixedDate = new Date("2026-10-23T12:00:00.000Z");
    const line = formatLine({ session_id: "sess-123", trigger: "auto" }, fixedDate);
    assert.equal(line, "2026-10-23T12:00:00.000Z\tsess-123\tauto\n");
});

test("formatLine defaults missing session_id and trigger to dash", () => {
    const fixedDate = new Date("2026-10-23T12:00:00.000Z");
    assert.equal(formatLine({}, fixedDate), "2026-10-23T12:00:00.000Z\t-\t-\n");
    assert.equal(formatLine(null, fixedDate), "2026-10-23T12:00:00.000Z\t-\t-\n");
    assert.equal(formatLine({ session_id: "   ", trigger: "" }, fixedDate), "2026-10-23T12:00:00.000Z\t-\t-\n");
});

test("formatLine supports camelCase sessionId as fallback", () => {
    const fixedDate = new Date("2026-10-23T12:00:00.000Z");
    assert.equal(
        formatLine({ sessionId: "sess-456", trigger: "manual" }, fixedDate),
        "2026-10-23T12:00:00.000Z\tsess-456\tmanual\n"
    );
});

test("running hook via spawnSync with AEO_BENCH_COMPACT_LOG appends one line per run (run twice -> 2 lines)", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-hook-"));
    const logFile = path.join(tempDir, "nested", "compact.log");

    try {
        const run1 = spawnSync(
            process.execPath,
            [script],
            {
                input: JSON.stringify({ session_id: "session-alpha", trigger: "auto" }),
                env: { ...process.env, AEO_BENCH_COMPACT_LOG: logFile },
                encoding: "utf8"
            }
        );
        assert.equal(run1.status, 0, run1.stderr);
        assert.equal(run1.stdout, "");

        const run2 = spawnSync(
            process.execPath,
            [script],
            {
                input: JSON.stringify({ session_id: "session-beta", trigger: "manual" }),
                env: { ...process.env, AEO_BENCH_COMPACT_LOG: logFile },
                encoding: "utf8"
            }
        );
        assert.equal(run2.status, 0, run2.stderr);
        assert.equal(run2.stdout, "");

        const content = await readFile(logFile, "utf8");
        const lines = content.split(/\r?\n/).filter(Boolean);
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^\S+\tsession-alpha\tauto$/);
        assert.match(lines[1], /^\S+\tsession-beta\tmanual$/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("running hook with AEO_BENCH_COMPACT_LOG unset exits 0 and writes nothing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-hook-unset-"));
    const logFile = path.join(tempDir, "should-not-exist.log");

    const env = { ...process.env };
    delete env.AEO_BENCH_COMPACT_LOG;

    try {
        const res = spawnSync(
            process.execPath,
            [script],
            {
                input: JSON.stringify({ session_id: "session-gamma", trigger: "auto" }),
                env,
                encoding: "utf8"
            }
        );
        assert.equal(res.status, 0, res.stderr);
        assert.equal(res.stdout, "");
        assert.equal(existsSync(logFile), false);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("running hook tolerantly handles empty or non-JSON stdin", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-hook-corrupt-"));
    const logFile = path.join(tempDir, "compact.log");

    try {
        const res = spawnSync(
            process.execPath,
            [script],
            {
                input: "this is not json at all",
                env: { ...process.env, AEO_BENCH_COMPACT_LOG: logFile },
                encoding: "utf8"
            }
        );
        assert.equal(res.status, 0, res.stderr);
        assert.equal(res.stdout, "");

        const content = await readFile(logFile, "utf8");
        const lines = content.split(/\r?\n/).filter(Boolean);
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^\S+\t-\t-$/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});
