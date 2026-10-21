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

import { delegateToAntigravity, persistEngineerReport } from "../lib/delegate.js";

function mockSpawn(behavior = {}) {
    const calls = [];
    const children = [];
    const spawnImpl = (bin, args, options) => {
        calls.push({ bin, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 4242;
        child.killed = false;
        child.kill = () => {
            child.killed = true;
            queueMicrotask(() => {
                child.emit("close", null);
            });
        };

        if (bin === "taskkill") {
            const pidIdx = args?.indexOf("/PID");
            if (pidIdx !== -1 && pidIdx + 1 < args.length) {
                const targetPid = Number(args[pidIdx + 1]);
                for (const spawned of children) {
                    if (spawned.pid === targetPid) {
                        spawned.killed = true;
                        queueMicrotask(() => spawned.emit("close", null));
                    }
                }
            }
        } else {
            children.push(child);
        }

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

    return { spawnImpl, calls };
}

async function tempDirectory() {
    return mkdtemp(path.join(tmpdir(), "agy-report-test-"));
}

test("agent_failure with non-empty response persists report and announces Full report", async () => {
    const directory = await tempDirectory();
    const reportRoot = await tempDirectory();
    const failureBody = "partial work";
    const envelope = {
        status: "ERROR",
        error: "agent stopped",
        response: failureBody
    };
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                env: {
                    AEO_WORKTREE_ROOT: reportRoot,
                    AEO_AGY_FALLBACK_MODELS: "none"
                },
                randomBytesImpl: () => Buffer.from("abcd1234", "hex")
            }
        );

        assert.equal(result.outcome, "agent_failure");
        assert.match(result.text, /Full report:/);

        const reportDir = path.join(reportRoot, "runs");
        const runDirs = await readdir(reportDir);
        assert.equal(runDirs.length, 1);
        const saved = await readFile(path.join(reportDir, runDirs[0], "report.md"), "utf8");
        assert.equal(saved, failureBody);
    } finally {
        await rm(directory, { recursive: true, force: true });
        await rm(reportRoot, { recursive: true, force: true });
    }
});

test("cap from process.env when dependencies.env is absent", async () => {
    const directory = await tempDirectory();
    const reportRoot = await tempDirectory();
    const fullBody = "B".repeat(5000);
    const envelope = {
        status: "SUCCESS",
        response: fullBody
    };
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`
    });

    const prevMax = process.env.AEO_MAX_REPORT_CHARS;
    const prevRoot = process.env.AEO_WORKTREE_ROOT;
    const prevFallback = process.env.AEO_AGY_FALLBACK_MODELS;

    process.env.AEO_MAX_REPORT_CHARS = "4000";
    process.env.AEO_WORKTREE_ROOT = reportRoot;
    process.env.AEO_AGY_FALLBACK_MODELS = "none";

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            { spawnImpl }
        );

        assert.equal(result.outcome, "agent_success");
        assert.match(result.text, /\[Output truncated by the Antigravity MCP bridge\]/);
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
        if (prevFallback === undefined) {
            delete process.env.AEO_AGY_FALLBACK_MODELS;
        } else {
            process.env.AEO_AGY_FALLBACK_MODELS = prevFallback;
        }
        await rm(directory, { recursive: true, force: true });
        await rm(reportRoot, { recursive: true, force: true });
    }
});

test("mkdirImpl throw on save still yields agent_success with could not be saved line", async () => {
    const directory = await tempDirectory();
    const fullBody = "Short completion report.";
    const envelope = {
        status: "SUCCESS",
        response: fullBody
    };
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                mkdirImpl: async () => {
                    throw new Error("mkdir failed");
                },
                env: {
                    AEO_WORKTREE_ROOT: sharedWorktreeRoot,
                    AEO_AGY_FALLBACK_MODELS: "none"
                }
            }
        );

        assert.equal(result.outcome, "agent_success");
        assert.match(result.text, /Full report could not be saved:/);
    } finally {
        await rm(directory, { recursive: true, force: true });
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
