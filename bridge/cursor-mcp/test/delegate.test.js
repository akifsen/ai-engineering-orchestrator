import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_MINUTES,
    TERMINATE_GRACE_MS,
    buildCursorCliArgs,
    buildCursorSpawnArgs,
    buildImplementationPrompt,
    defaultTerminateProcess,
    delegateToCursor,
    indicatesQuotaOrAuthFailure,
    parseCursorEnvelope,
    pickNewestCursorVersionDir,
    resolveCursorSpawnTarget,
    resolveDefaultModel,
    resolveTimeouts,
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

    return { spawnImpl, calls, children };
}

async function tempDirectory() {
    return mkdtemp(path.join(tmpdir(), "cursor-bridge-"));
}

test("default timeout is 30 minutes with a one-minute grace window", () => {
    const resolved = resolveTimeouts({});
    assert.equal(resolved.minutes, DEFAULT_TIMEOUT_MINUTES);
    assert.equal(resolved.hardTimeoutMs, (DEFAULT_TIMEOUT_MINUTES + 1) * 60 * 1000);
});

test("AEO_CURSOR_TIMEOUT_MINUTES overrides the default", () => {
    const resolved = resolveTimeouts({ AEO_CURSOR_TIMEOUT_MINUTES: "45" });
    assert.equal(resolved.minutes, 45);
    assert.equal(resolved.hardTimeoutMs, 46 * 60 * 1000);
});

test("per-call timeoutMinutes overrides env default", () => {
    const resolved = resolveTimeouts({ AEO_CURSOR_TIMEOUT_MINUTES: "45" }, 10);
    assert.equal(resolved.minutes, 10);
    assert.equal(resolved.hardTimeoutMs, 11 * 60 * 1000);
});

test("AEO_CURSOR_MODEL overrides the default model slug", () => {
    assert.equal(resolveDefaultModel({}), DEFAULT_MODEL);
    assert.equal(resolveDefaultModel({ AEO_CURSOR_MODEL: "composer-2.5-fast" }), "composer-2.5-fast");
});

test("implementation prompt carries the engineer rules and the assignment", () => {
    const prompt = buildImplementationPrompt("Add a health check.");
    assert.ok(prompt.includes("Do not commit, push, reset, rebase, merge, switch branches, stash, clean, or rewrite Git history."));
    assert.ok(prompt.endsWith("Add a health check."));
});

test("CLI arguments use stdin prompt and headless flags", () => {
    const args = buildCursorCliArgs({
        cwd: "C:/repo",
        model: "composer-2.5"
    });

    assert.deepEqual(args, [
        "-p",
        "--output-format",
        "json",
        "--model",
        "composer-2.5",
        "--trust",
        "--force",
        "--workspace",
        "C:/repo"
    ]);
    assert.equal(args.includes("-p"), true);
    assert.equal(args.some((part) => part.includes("Assignment:")), false);
});

test("spawn args prepend index.js when using a version directory layout", () => {
    const args = buildCursorSpawnArgs({
        cwd: "/repo",
        model: "composer-2.5",
        spawnTarget: {
            executable: "C:/cursor/node.exe",
            args: ["C:/cursor/index.js"]
        }
    });
    assert.equal(args[0], "C:/cursor/index.js");
    assert.ok(args.includes("--workspace"));
});

test("rejects a relative cwd before spawning", async () => {
    const { spawnImpl, calls } = mockSpawn();
    const result = await delegateToCursor(
        { prompt: "Edit the file.", cwd: "relative/repo" },
        { spawnImpl }
    );
    assert.equal(result.outcome, "validation_failure");
    assert.equal(calls.length, 0);
});

test("successful agent execution classifies agent_success", async () => {
    const directory = await tempDirectory();
    const envelope = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 100,
        result: "1. Summary\nUpdated the parser.\n",
        session_id: "sess-1",
        usage: { inputTokens: 1, outputTokens: 2 }
    };
    const { spawnImpl, calls } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`
    });

    const spawnTarget = {
        executable: "C:/cursor/node.exe",
        args: ["C:/cursor/index.js"]
    };

    try {
        const result = await delegateToCursor(
            {
                prompt: "Update the parser.",
                cwd: directory,
                model: "composer-2.5-fast"
            },
            { spawnImpl, spawnTarget }
        );

        assert.equal(result.outcome, "agent_success");
        assert.match(result.text, /Updated the parser/);
        assert.match(result.text, /sess-1/);
        assert.equal(calls[0].options.shell, false);
        assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
        assert.ok(calls[0].args.includes("--force"));
        assert.ok(calls[0].args.includes("--trust"));
        assert.ok(calls[0].args.includes("composer-2.5-fast"));
        assert.equal(calls.length, 1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("stdin receives the wrapped implementation prompt", async () => {
    const directory = await tempDirectory();
    const envelope = {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s"
    };
    const { spawnImpl, children } = mockSpawn({
        code: 0,
        stdout: JSON.stringify(envelope)
    });
    const spawnTarget = { executable: "node", args: ["index.js"] };

    try {
        await delegateToCursor(
            { prompt: "Ship it.", cwd: directory },
            { spawnImpl, spawnTarget }
        );
        assert.ok(children[0].stdin.written.includes("Ship it."));
        assert.ok(children[0].stdin.written.includes("Implementation Engineer"));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("non-zero exit with quota hints is quota_or_auth_failure", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        code: 1,
        stderr: "Error: rate limit exceeded (429)\n"
    });

    try {
        const result = await delegateToCursor(
            { prompt: "Update.", cwd: directory },
            { spawnImpl, spawnTarget: { executable: "cursor-agent", args: [] } }
        );
        assert.equal(result.outcome, "quota_or_auth_failure");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("exit 0 with is_error is agent_failure", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: JSON.stringify({
            type: "result",
            subtype: "error",
            is_error: true,
            result: "tool failed"
        })
    });

    try {
        const result = await delegateToCursor(
            { prompt: "Update.", cwd: directory },
            { spawnImpl, spawnTarget: { executable: "cursor-agent", args: [] } }
        );
        assert.equal(result.outcome, "agent_failure");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("parses the last JSON result line after log noise", () => {
    const parsed = parseCursorEnvelope(
        "log line\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ok\"}\n"
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.result, "ok");
});

test("indicatesQuotaOrAuthFailure detects common patterns", () => {
    assert.equal(indicatesQuotaOrAuthFailure("HTTP 429"), true);
    assert.equal(indicatesQuotaOrAuthFailure("You are not logged in"), true);
    assert.equal(indicatesQuotaOrAuthFailure("quota exceeded"), true);
    assert.equal(indicatesQuotaOrAuthFailure("all good"), false);
});

test("bridge hard timeout terminates a hung process", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({ hang: true });
    let terminated = false;

    try {
        const result = await delegateToCursor(
            { prompt: "Update.", cwd: directory },
            {
                spawnImpl,
                spawnTarget: { executable: "cursor-agent", args: [] },
                hardTimeoutMs: 20,
                terminateGraceMs: 50,
                terminateProcess: (child) => {
                    terminated = true;
                    child?.emit?.("close", null);
                }
            }
        );
        assert.equal(result.outcome, "timeout");
        assert.equal(terminated, true);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("pickNewestCursorVersionDir chooses the latest dated folder", async () => {
    const dir = await pickNewestCursorVersionDir("/versions", async () => [
        { name: "2024.1.1-abc", isDirectory: () => true },
        { name: "2025.9.30-01-02-03-deadbeef", isDirectory: () => true },
        { name: "not-a-version", isDirectory: () => true }
    ]);
    assert.equal(dir, path.join("/versions", "2025.9.30-01-02-03-deadbeef"));
});

test("CURSOR_AGENT_BIN js path uses node next to the script", async () => {
    const target = await resolveCursorSpawnTarget(
        { CURSOR_AGENT_BIN: "C:/agent/index.js" },
        {
            platform: "win32",
            access: async () => {}
        }
    );
    assert.equal(
        target.executable.replaceAll("\\", "/"),
        "C:/agent/node.exe"
    );
    assert.deepEqual(target.args, ["C:/agent/index.js"]);
});

test("rejects invalid timeoutMinutes", async () => {
    const directory = await tempDirectory();
    const { spawnImpl, calls } = mockSpawn();
    try {
        const result = await delegateToCursor(
            { prompt: "x", cwd: directory, timeoutMinutes: 200 },
            { spawnImpl }
        );
        assert.equal(result.outcome, "validation_failure");
        assert.equal(calls.length, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("rejects a missing directory and a file path", async () => {
    const { spawnImpl, calls } = mockSpawn();
    const missing = path.join(tmpdir(), "cursor-bridge-missing");
    const missingResult = await delegateToCursor(
        { prompt: "Edit.", cwd: missing },
        { spawnImpl }
    );
    assert.match(missingResult.text, /not accessible/);

    const directory = await tempDirectory();
    const filePath = path.join(directory, "file.txt");
    await writeFile(filePath, "x");
    try {
        const fileResult = await delegateToCursor(
            { prompt: "Edit.", cwd: filePath },
            { spawnImpl }
        );
        assert.match(fileResult.text, /not a directory/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }

    assert.equal(calls.length, 0);
});

test("truncates pathological report text", () => {
    const text = truncate("x".repeat(50), 10);
    assert.match(text, /\[Output truncated by the Cursor MCP bridge\]/);
});

test("defaultTerminateProcess issues taskkill on Windows", () => {
    if (process.platform !== "win32") {
        return;
    }

    const child = { pid: 99, killed: false };
    const calls = [];
    defaultTerminateProcess(child, (bin, args) => {
        calls.push({ bin, args });
        return { unref() {} };
    });
    assert.equal(calls[0].bin, "taskkill");
    assert.deepEqual(calls[0].args, ["/PID", "99", "/T", "/F"]);
});
