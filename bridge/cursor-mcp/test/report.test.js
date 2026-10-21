import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const sharedWorktreeRoot = mkdtempSync(path.join(tmpdir(), "aeo-test-worktree-"));
process.env.AEO_WORKTREE_ROOT = sharedWorktreeRoot;

after(() => {
    try {
        rmSync(sharedWorktreeRoot, { recursive: true, force: true });
    } catch {
        // ignore
    }
});
import assert from "node:assert/strict";

import {
    MIN_REPORT_CHARS,
    MAX_REPORT_CHARS_LIMIT,
    MAX_REPORT_CHARS,
    delegateToCursor,
    persistEngineerReport,
    resolveMaxReportChars,
    truncate
} from "../lib/delegate.js";

function mockSpawn(behavior = {}) {
    const calls = [];
    const children = [];
    const spawnImpl = (bin, args, options) => {
        calls.push({ bin, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = {
            written: "",
            write(chunk) {
                this.written += chunk;
                return true;
            },
            end() {}
        };
        child.pid = 4242;
        child.killed = false;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = (signal) => {
            child.killed = true;
            child.signalCode = signal ?? "SIGTERM";
            queueMicrotask(() => {
                child.emit("close", null);
            });
        };

        children.push(child);

        queueMicrotask(() => {
            if (behavior.error) {
                child.emit("error", behavior.error);
                return;
            }

            if (behavior.stdout) {
                child.stdout.emit("data", behavior.stdout);
            }

            if (behavior.stderr) {
                child.stderr.emit("data", behavior.stderr);
            }

            if (behavior.hang) {
                return;
            }

            child.emit("close", behavior.code ?? 0);
        });

        return child;
    };

    return { spawnImpl, calls, children };
}

async function tempDirectory() {
    return mkdtemp(path.join(tmpdir(), "cursor-report-test-"));
}

test("resolveMaxReportChars resolves default, valid, invalid, and clamped values", () => {
    assert.equal(MIN_REPORT_CHARS, 4_000);
    assert.equal(MAX_REPORT_CHARS_LIMIT, 200_000);
    assert.equal(MAX_REPORT_CHARS, 32_000);

    const def = resolveMaxReportChars({});
    assert.equal(def.limit, MAX_REPORT_CHARS);
    assert.equal(def.warning, null);

    const defOmitted = resolveMaxReportChars();
    assert.equal(defOmitted.limit, MAX_REPORT_CHARS);
    assert.equal(defOmitted.warning, null);

    const empty = resolveMaxReportChars({ AEO_MAX_REPORT_CHARS: "   " });
    assert.equal(empty.limit, MAX_REPORT_CHARS);
    assert.equal(empty.warning, null);

    const valid = resolveMaxReportChars({ AEO_MAX_REPORT_CHARS: "50000" });
    assert.equal(valid.limit, 50_000);
    assert.equal(valid.warning, null);

    const clampedLow = resolveMaxReportChars({ AEO_MAX_REPORT_CHARS: "10" });
    assert.equal(clampedLow.limit, MIN_REPORT_CHARS);
    assert.equal(clampedLow.warning, null);

    const clampedHigh = resolveMaxReportChars({ AEO_MAX_REPORT_CHARS: "999999" });
    assert.equal(clampedHigh.limit, MAX_REPORT_CHARS_LIMIT);
    assert.equal(clampedHigh.warning, null);

    const invalid = resolveMaxReportChars({ AEO_MAX_REPORT_CHARS: "abc" });
    assert.equal(invalid.limit, MAX_REPORT_CHARS);
    assert.match(invalid.warning, /Invalid AEO_MAX_REPORT_CHARS "abc"/);

    const invalidFloat = resolveMaxReportChars({ AEO_MAX_REPORT_CHARS: "32000.5" });
    assert.equal(invalidFloat.limit, MAX_REPORT_CHARS);
    assert.match(invalidFloat.warning, /Invalid AEO_MAX_REPORT_CHARS "32000.5"/);
});

test("agent_success over the cap writes the file and includes the truncation note and marker and not the full body", async () => {
    const directory = await tempDirectory();
    const reportRoot = await tempDirectory();
    const fullBody = `BODY-${"z".repeat(500)}`;
    const envelope = {
        type: "result",
        subtype: "success",
        is_error: false,
        result: fullBody,
        session_id: "conv-report-cap"
    };
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`
    });

    try {
        const result = await delegateToCursor(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                spawnTarget: { executable: "cursor-agent", args: [] },
                maxReportChars: 80,
                env: {
                    AEO_WORKTREE_ROOT: reportRoot
                },
                randomBytesImpl: () => Buffer.from("abcd1234", "hex")
            }
        );

        assert.equal(result.outcome, "agent_success");
        assert.equal(result.isError, false);
        assert.match(result.text, /Full report:/);
        assert.match(
            result.text,
            /Inline report truncated to 80 characters; read the file for the rest\./
        );
        assert.match(result.text, /\[Output truncated by the Cursor MCP bridge\]/);
        assert.equal(result.text.includes(fullBody), false);

        const reportDir = path.join(reportRoot, "runs");
        const runDirs = await readdir(reportDir);
        assert.equal(runDirs.length, 1);
        assert.ok(runDirs[0].endsWith("abcd1234"));
        const saved = await readFile(path.join(reportDir, runDirs[0], "report.md"), "utf8");
        assert.equal(saved, fullBody);
    } finally {
        await rm(directory, { recursive: true, force: true });
        await rm(reportRoot, { recursive: true, force: true });
    }
});

test("agent_success under the cap writes the file and has no truncation note", async () => {
    const directory = await tempDirectory();
    const reportRoot = await tempDirectory();
    const fullBody = "Short completion report.";
    const envelope = {
        type: "result",
        subtype: "success",
        is_error: false,
        result: fullBody,
        session_id: "conv-report-short"
    };
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`
    });

    try {
        const result = await delegateToCursor(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                spawnTarget: { executable: "cursor-agent", args: [] },
                env: {
                    AEO_WORKTREE_ROOT: reportRoot
                },
                randomBytesImpl: () => Buffer.from("feedbeef", "hex")
            }
        );

        assert.equal(result.outcome, "agent_success");
        assert.equal(result.isError, false);
        assert.match(result.text, /Full report:/);
        assert.equal(
            result.text.includes("Inline report truncated to"),
            false
        );
        assert.ok(result.text.includes(fullBody));

        const reportDir = path.join(reportRoot, "runs");
        const runDirs = await readdir(reportDir);
        assert.equal(runDirs.length, 1);
        assert.ok(runDirs[0].endsWith("feedbeef"));
        const saved = await readFile(path.join(reportDir, runDirs[0], "report.md"), "utf8");
        assert.equal(saved, fullBody);
    } finally {
        await rm(directory, { recursive: true, force: true });
        await rm(reportRoot, { recursive: true, force: true });
    }
});

test("save failure (writeFileImpl throws) yields the \"could not be saved\" line and still agent_success", async () => {
    const directory = await tempDirectory();
    const fullBody = `BODY-${"z".repeat(500)}`;
    const envelope = {
        type: "result",
        subtype: "success",
        is_error: false,
        result: fullBody
    };
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`
    });

    try {
        const result = await delegateToCursor(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                spawnTarget: { executable: "cursor-agent", args: [] },
                maxReportChars: 80,
                writeFileImpl: async () => {
                    throw new Error("disk full");
                }
            }
        );

        assert.equal(result.outcome, "agent_success");
        assert.equal(result.isError, false);
        assert.match(result.text, /Full report could not be saved: disk full/);
        assert.match(
            result.text,
            /Inline report truncated to 80 characters; the full report could not be saved, so the rest is lost\./
        );
        assert.equal(
            result.text.includes("read the file for the rest"),
            false
        );
        assert.match(result.text, /\[Output truncated by the Cursor MCP bridge\]/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("dependencies.maxReportChars override wins over env", async () => {
    const directory = await tempDirectory();
    const reportRoot = await tempDirectory();
    const fullBody = `BODY-${"x".repeat(300)}`;
    const envelope = {
        type: "result",
        subtype: "success",
        is_error: false,
        result: fullBody
    };
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`
    });

    try {
        const result = await delegateToCursor(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                spawnTarget: { executable: "cursor-agent", args: [] },
                maxReportChars: 60,
                env: {
                    AEO_MAX_REPORT_CHARS: "50000",
                    AEO_WORKTREE_ROOT: reportRoot
                }
            }
        );

        assert.equal(result.outcome, "agent_success");
        assert.match(
            result.text,
            /Inline report truncated to 60 characters; read the file for the rest\./
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
        await rm(reportRoot, { recursive: true, force: true });
    }
});

test("agent_failure with non-empty response persists report and announces Full report", async () => {
    const directory = await tempDirectory();
    const reportRoot = await tempDirectory();
    const failureBody = "Detailed agent failure traceback.";
    const envelope = {
        type: "result",
        subtype: "error",
        is_error: true,
        result: failureBody
    };
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`
    });

    try {
        const result = await delegateToCursor(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                spawnTarget: { executable: "cursor-agent", args: [] },
                env: {
                    AEO_WORKTREE_ROOT: reportRoot
                },
                randomBytesImpl: () => Buffer.from("deadbeef", "hex")
            }
        );

        assert.equal(result.outcome, "agent_failure");
        assert.equal(result.isError, true);
        assert.match(result.text, /Full report:/);

        const reportDir = path.join(reportRoot, "runs");
        const runDirs = await readdir(reportDir);
        assert.equal(runDirs.length, 1);
        assert.ok(runDirs[0].endsWith("deadbeef"));
        const saved = await readFile(path.join(reportDir, runDirs[0], "report.md"), "utf8");
        assert.equal(saved, failureBody);
    } finally {
        await rm(directory, { recursive: true, force: true });
        await rm(reportRoot, { recursive: true, force: true });
    }
});

test("persistEngineerReport returns ok false when resolveWorktreeRootImpl throws", async () => {
    const result = await persistEngineerReport({
        response: "report body",
        resolveWorktreeRootImpl: () => {
            throw new Error("worktree root unavailable");
        }
    });

    assert.equal(result.ok, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0);
});

test("cap from process.env when dependencies.env is absent", async () => {
    const directory = await tempDirectory();
    const reportRoot = await tempDirectory();
    const fullBody = "B".repeat(5000);
    const envelope = {
        type: "result",
        subtype: "success",
        is_error: false,
        result: fullBody
    };
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`
    });

    const prevMax = process.env.AEO_MAX_REPORT_CHARS;
    const prevRoot = process.env.AEO_WORKTREE_ROOT;

    process.env.AEO_MAX_REPORT_CHARS = "4000";
    process.env.AEO_WORKTREE_ROOT = reportRoot;

    try {
        const result = await delegateToCursor(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                spawnTarget: { executable: "cursor-agent", args: [] }
            }
        );

        assert.equal(result.outcome, "agent_success");
        assert.match(result.text, /\[Output truncated by the Cursor MCP bridge\]/);
        assert.match(
            result.text,
            /Inline report truncated to 4000 characters; read the file for the rest\./
        );
    } finally {
        if (prevMax === undefined) {
            delete process.env.AEO_MAX_REPORT_CHARS;
        } else {
            process.env.AEO_MAX_REPORT_CHARS = prevMax;
        }
        if (prevRoot === undefined) {
            delete process.env.AEO_WORKTREE_ROOT;
        } else {
            process.env.AEO_WORKTREE_ROOT = prevRoot;
        }
        await rm(directory, { recursive: true, force: true });
        await rm(reportRoot, { recursive: true, force: true });
    }
});
