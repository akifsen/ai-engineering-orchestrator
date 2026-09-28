import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    CLI_TIMEOUT,
    HARD_TIMEOUT_MS,
    MAX_COMMAND_CHARS,
    TERMINATE_GRACE_MS,
    applyDelegation,
    buildAgyArgs,
    buildImplementationPrompt,
    busyDelegations,
    defaultTerminateProcess,
    delegateToAntigravity,
    discardDelegation,
    makeBusyKey,
    normalizeIsolation,
    parseAgentEnvelope,
    parseDurationMs,
    resolveAgyBin,
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
    return mkdtemp(path.join(tmpdir(), "agy-bridge-"));
}

test("hard timeout is slightly longer than the CLI print timeout", () => {
    const cliMs = parseDurationMs(CLI_TIMEOUT);
    assert.equal(cliMs, 15 * 60 * 1000);
    assert.ok(HARD_TIMEOUT_MS > cliMs);
    assert.ok(HARD_TIMEOUT_MS <= cliMs + 2 * 60 * 1000);
});

test("AGY_BIN overrides the default agy command", () => {
    assert.equal(resolveAgyBin({}), "agy");
    assert.equal(resolveAgyBin({ AGY_BIN: "  C:/tools/agy.exe  " }), "C:/tools/agy.exe");
});

test("implementation prompt carries the engineer rules and the assignment", () => {
    const prompt = buildImplementationPrompt("Add a health check.");
    const required = [
        "Inspect the repository before editing.",
        "Prefer built-in file read, search, and edit tools over shell commands. In headless mode a shell command outside the allowlist can end the whole run without output.",
        "Run only the verification commands the assignment names or that are clearly allowed; do not improvise extra shell commands.",
        "Follow the existing architecture.",
        "Complete the delegated bounded scope.",
        "Avoid unrelated modifications.",
        "Preserve compatibility unless the assignment explicitly changes it.",
        "Add or update tests when the change needs coverage.",
        "Run verification where permissions allow.",
        "Report blocked or unexecuted commands.",
        "Never claim a test passed unless you actually executed it and it passed.",
        "Never claim a command ran unless it ran.",
        "Do not commit, push, reset, rebase, merge, switch branches, or rewrite Git history.",
        "Do not modify files outside the working directory.",
        "Report unresolved risks.",
        "1. Summary",
        "2. Files changed",
        "3. Important implementation decisions",
        "4. Tests / validation executed",
        "5. Actual results",
        "6. Blocked / unexecuted commands",
        "7. Remaining risks",
        "Add a health check."
    ];

    for (const phrase of required) {
        assert.ok(prompt.includes(phrase), phrase);
    }

    const inspectIndex = prompt.indexOf("Inspect the repository before editing.");
    const preferIndex = prompt.indexOf("Prefer built-in file read, search, and edit tools over shell commands.");
    const verifyIndex = prompt.indexOf("Run only the verification commands the assignment names or that are clearly allowed; do not improvise extra shell commands.");
    const followIndex = prompt.indexOf("Follow the existing architecture.");

    assert.ok(inspectIndex < preferIndex, "prefer built-in rule follows inspect rule");
    assert.ok(preferIndex < verifyIndex, "verify rule follows prefer built-in rule");
    assert.ok(verifyIndex < followIndex, "follow architecture follows verify rule");

    assert.ok(prompt.endsWith("Add a health check."));
});

test("CLI arguments request headless accept-edits JSON output", () => {
    const args = buildAgyArgs({
        prompt: "Fix the parser.",
        model: "gemini-example",
        effort: "medium"
    });

    assert.deepEqual(args.slice(0, 6), [
        "--mode",
        "accept-edits",
        "--output-format",
        "json",
        "--print-timeout",
        CLI_TIMEOUT
    ]);
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("gemini-example"));
    assert.ok(args.includes("--effort"));
    assert.ok(args.includes("medium"));
    assert.equal(args.at(-2), "-p");
    assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("an invalid effort is rejected before spawn", async () => {
    const directory = await tempDirectory();
    const { spawnImpl, calls } = mockSpawn();

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory, effort: "max" },
            { spawnImpl }
        );
        assert.equal(result.outcome, "validation_failure");
        assert.equal(result.isError, true);
        assert.match(result.text, /low, medium, high/);
        assert.equal(calls.length, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("optional model and effort are omitted when unset", () => {
    const args = buildAgyArgs({ prompt: "Rename a comment." });
    assert.equal(args.includes("--model"), false);
    assert.equal(args.includes("--effort"), false);
});

test("rejects a relative cwd before spawning", async () => {
    const { spawnImpl, calls } = mockSpawn();
    const result = await delegateToAntigravity(
        { prompt: "Edit the file.", cwd: "relative/repo" },
        { spawnImpl }
    );

    assert.equal(result.outcome, "validation_failure");
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
});

test("rejects a missing directory and a file path", async () => {
    const { spawnImpl, calls } = mockSpawn();
    const missing = path.join(tmpdir(), "agy-bridge-missing-dir");
    const missingResult = await delegateToAntigravity(
        { prompt: "Edit the file.", cwd: missing },
        { spawnImpl }
    );
    assert.match(missingResult.text, /not accessible/);

    const directory = await tempDirectory();
    const filePath = path.join(directory, "not-a-dir.txt");
    await writeFile(filePath, "x");
    try {
        const fileResult = await delegateToAntigravity(
            { prompt: "Edit the file.", cwd: filePath },
            { spawnImpl }
        );
        assert.match(fileResult.text, /not a directory/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }

    assert.equal(calls.length, 0);
});

test("successful agent execution is distinct from CLI failure", async () => {
    const directory = await tempDirectory();
    const envelope = {
        conversation_id: "conv-1",
        status: "SUCCESS",
        response: "1. Summary\nUpdated the parser.\n",
        duration_seconds: 3,
        num_turns: 2,
        usage: { total_tokens: 10 }
    };
    const { spawnImpl, calls } = mockSpawn({
        code: 0,
        stdout: `${JSON.stringify(envelope)}\n`,
        stderr: "permission denied: npm test\n"
    });

    try {
        const result = await delegateToAntigravity(
            {
                prompt: "Update the parser.",
                cwd: directory,
                model: "gemini-example",
                effort: "low"
            },
            { spawnImpl, bin: "C:/tools/agy.exe" }
        );

        assert.equal(result.outcome, "agent_success");
        assert.equal(result.isError, false);
        assert.match(result.text, /Outcome: agent_success/);
        assert.match(result.text, /Updated the parser/);
        assert.match(result.text, /conv-1/);
        assert.match(result.text, /permission denied: npm test/);
        assert.ok(calls[0].args.includes("--model"));
        assert.ok(calls[0].args.includes("gemini-example"));
        assert.ok(calls[0].args.includes("--effort"));
        assert.ok(calls[0].args.includes("low"));
        assert.equal(calls[0].bin, "C:/tools/agy.exe");
        assert.equal(calls[0].options.shell, false);
        assert.equal(calls[0].options.windowsHide, true);
        assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
        assert.equal(calls[0].options.cwd, path.resolve(directory));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("non-zero exit is a CLI failure even when JSON status is ERROR", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        code: 1,
        stdout: JSON.stringify({
            status: "ERROR",
            error: "invalid model selection",
            response: ""
        })
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            { spawnImpl }
        );
        assert.equal(result.outcome, "cli_failure");
        assert.match(result.text, /exited with code 1/);
        assert.match(result.text, /not a completed implementation/);
        assert.match(result.text, /invalid model selection/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("exit 0 with a non-success status is an agent failure", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: JSON.stringify({
            status: "ERROR",
            error: "tool cascade failed",
            response: ""
        })
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            { spawnImpl }
        );
        assert.equal(result.outcome, "agent_failure");
        assert.match(result.text, /process started/);
        assert.match(result.text, /did not succeed/);
        assert.match(result.text, /tool cascade failed/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("a missing executable is a CLI failure that mentions AGY_BIN", async () => {
    const directory = await tempDirectory();
    const error = new Error("spawn agy ENOENT");
    error.code = "ENOENT";
    const { spawnImpl } = mockSpawn({ error });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            { spawnImpl, env: {} }
        );
        assert.equal(result.outcome, "cli_failure");
        assert.match(result.text, /not found/);
        assert.match(result.text, /AGY_BIN/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("a synchronous spawn failure is a CLI failure and does not hang", async () => {
    const directory = await tempDirectory();

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl: () => {
                    throw new Error("sync spawn failure");
                },
                hardTimeoutMs: 50
            }
        );
        assert.equal(result.outcome, "cli_failure");
        assert.equal(result.isError, true);
        assert.match(result.text, /could not be started/);
        assert.match(result.text, /sync spawn failure/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("empty stdout is a CLI failure", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: ""
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            { spawnImpl }
        );
        assert.equal(result.outcome, "cli_failure");
        assert.match(result.text, /did not return a JSON object/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("invalid JSON is a CLI failure", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: "not-json"
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            { spawnImpl }
        );
        assert.equal(result.outcome, "cli_failure");
        assert.match(result.text, /did not return a JSON object/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("parses a JSON envelope after a non-JSON stdout banner", () => {
    const parsed = parseAgentEnvelope("warming up\n{\"status\":\"SUCCESS\",\"response\":\"ok\"}\n");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.response, "ok");
});

test("truncates pathological report text", () => {
    const text = truncate("x".repeat(50), 10);
    assert.match(text, /\[Output truncated by the Antigravity MCP bridge\]/);
    assert.ok(text.startsWith("xxxxxxxxxx"));
});

test("bridge hard timeout terminates a hung process", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({ hang: true });
    let terminated = false;

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
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
        assert.match(result.text, /not completed/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("hard timeout waits for child close event before finishing", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({ hang: true });
    let closedAt = 0;
    let finishedAt = 0;

    try {
        const start = Date.now();
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                hardTimeoutMs: 20,
                terminateGraceMs: 1000,
                terminateProcess: (child) => {
                    setTimeout(() => {
                        closedAt = Date.now();
                        child.emit("close", null);
                    }, 40);
                }
            }
        );
        finishedAt = Date.now();
        assert.equal(result.outcome, "timeout");
        assert.ok(closedAt > 0, "child close event must have been emitted");
        assert.ok(finishedAt >= closedAt, "finish must happen after close event");
        assert.equal(result.text.includes("did not confirm exit within"), false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("hard timeout adds warning line when child does not exit within grace period", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({ hang: true });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                hardTimeoutMs: 20,
                terminateGraceMs: 50,
                terminateProcess: () => {
                    // intentionally do not emit close/exit
                }
            }
        );
        assert.equal(result.outcome, "timeout");
        assert.ok(result.text.includes("The process did not confirm exit within 0.05s; files in the working directory may still change."));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("pathological stdout is stopped before it is returned in full", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        stdout: "y".repeat(100),
        hang: true
    });
    let terminated = false;

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                maxCollectChars: 20,
                terminateGraceMs: 50,
                terminateProcess: (child) => {
                    terminated = true;
                    child?.emit?.("close", null);
                }
            }
        );
        assert.equal(result.outcome, "cli_failure");
        assert.equal(terminated, true);
        assert.equal(result.text.includes("y".repeat(100)), false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("stdout overflow waits for child close event before finishing", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        stdout: "y".repeat(100),
        hang: true
    });
    let closedAt = 0;
    let finishedAt = 0;

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                maxCollectChars: 20,
                terminateGraceMs: 1000,
                terminateProcess: (child) => {
                    setTimeout(() => {
                        closedAt = Date.now();
                        child.emit("close", null);
                    }, 40);
                }
            }
        );
        finishedAt = Date.now();
        assert.equal(result.outcome, "cli_failure");
        assert.ok(closedAt > 0, "child close event must have been emitted");
        assert.ok(finishedAt >= closedAt, "finish must happen after close event");
        assert.equal(result.text.includes("did not confirm exit within"), false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("stdout overflow adds warning line when child does not exit within grace period", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        stdout: "y".repeat(100),
        hang: true
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                maxCollectChars: 20,
                terminateGraceMs: 50,
                terminateProcess: () => {
                    // intentionally do not emit close/exit
                }
            }
        );
        assert.equal(result.outcome, "cli_failure");
        assert.ok(result.text.includes("The process did not confirm exit within 0.05s; files in the working directory may still change."));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("an oversized prompt is rejected before spawn", async () => {
    const directory = await tempDirectory();
    const { spawnImpl, calls } = mockSpawn();

    try {
        const result = await delegateToAntigravity(
            { prompt: "a".repeat(MAX_COMMAND_CHARS), cwd: directory },
            { spawnImpl }
        );
        assert.equal(result.outcome, "validation_failure");
        assert.equal(calls.length, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("Windows process termination does not use a shell", () => {
    if (process.platform !== "win32") {
        return;
    }

    const calls = [];
    defaultTerminateProcess(
        { pid: 4242, killed: false },
        (bin, args, options) => {
            calls.push({ bin, args, options });
            return { unref() {} };
        }
    );

    assert.equal(calls[0].bin, "taskkill");
    assert.deepEqual(calls[0].args, ["/PID", "4242", "/T", "/F"]);
    assert.equal(calls[0].options.shell, false);
});

test("resolveTimeouts resolves default, valid, clamped, and invalid timeout values", () => {
    // default
    const def = resolveTimeouts({});
    assert.equal(def.minutes, 15);
    assert.equal(def.cliTimeout, "15m");
    assert.equal(def.hardTimeoutMs, 16 * 60 * 1000);
    assert.equal(def.warning, null);

    const empty = resolveTimeouts({ AEO_AGY_TIMEOUT_MINUTES: "   " });
    assert.equal(empty.minutes, 15);
    assert.equal(empty.cliTimeout, "15m");
    assert.equal(empty.hardTimeoutMs, 16 * 60 * 1000);
    assert.equal(empty.warning, null);

    // valid
    const valid = resolveTimeouts({ AEO_AGY_TIMEOUT_MINUTES: "10" });
    assert.equal(valid.minutes, 10);
    assert.equal(valid.cliTimeout, "10m");
    assert.equal(valid.hardTimeoutMs, 11 * 60 * 1000);
    assert.equal(valid.warning, null);

    const validMax = resolveTimeouts({ AEO_AGY_TIMEOUT_MINUTES: "18" });
    assert.equal(validMax.minutes, 18);
    assert.equal(validMax.cliTimeout, "18m");
    assert.equal(validMax.hardTimeoutMs, 19 * 60 * 1000);
    assert.equal(validMax.warning, null);

    const validMin = resolveTimeouts({ AEO_AGY_TIMEOUT_MINUTES: "1" });
    assert.equal(validMin.minutes, 1);
    assert.equal(validMin.cliTimeout, "1m");
    assert.equal(validMin.hardTimeoutMs, 2 * 60 * 1000);
    assert.equal(validMin.warning, null);

    // clamped
    const clampedHigh = resolveTimeouts({ AEO_AGY_TIMEOUT_MINUTES: "25" });
    assert.equal(clampedHigh.minutes, 18);
    assert.equal(clampedHigh.cliTimeout, "18m");
    assert.equal(clampedHigh.hardTimeoutMs, 19 * 60 * 1000);
    assert.equal(clampedHigh.warning, null);

    const clampedLow = resolveTimeouts({ AEO_AGY_TIMEOUT_MINUTES: "0" });
    assert.equal(clampedLow.minutes, 1);
    assert.equal(clampedLow.cliTimeout, "1m");
    assert.equal(clampedLow.hardTimeoutMs, 2 * 60 * 1000);
    assert.equal(clampedLow.warning, null);

    const clampedNegative = resolveTimeouts({ AEO_AGY_TIMEOUT_MINUTES: "-5" });
    assert.equal(clampedNegative.minutes, 1);
    assert.equal(clampedNegative.cliTimeout, "1m");
    assert.equal(clampedNegative.hardTimeoutMs, 2 * 60 * 1000);
    assert.equal(clampedNegative.warning, null);

    // invalid
    const invalidText = resolveTimeouts({ AEO_AGY_TIMEOUT_MINUTES: "abc" });
    assert.equal(invalidText.minutes, 15);
    assert.equal(invalidText.cliTimeout, "15m");
    assert.equal(invalidText.hardTimeoutMs, 16 * 60 * 1000);
    assert.match(invalidText.warning, /Invalid AEO_AGY_TIMEOUT_MINUTES/);

    const invalidFloat = resolveTimeouts({ AEO_AGY_TIMEOUT_MINUTES: "12.5" });
    assert.equal(invalidFloat.minutes, 15);
    assert.equal(invalidFloat.cliTimeout, "15m");
    assert.equal(invalidFloat.hardTimeoutMs, 16 * 60 * 1000);
    assert.match(invalidFloat.warning, /Invalid AEO_AGY_TIMEOUT_MINUTES/);

    const invalidUnit = resolveTimeouts({ AEO_AGY_TIMEOUT_MINUTES: "15m" });
    assert.equal(invalidUnit.minutes, 15);
    assert.equal(invalidUnit.cliTimeout, "15m");
    assert.equal(invalidUnit.hardTimeoutMs, 16 * 60 * 1000);
    assert.match(invalidUnit.warning, /Invalid AEO_AGY_TIMEOUT_MINUTES/);
});

test("empty-response with permission diagnostics includes the permission next step", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: JSON.stringify({
            status: "SUCCESS",
            response: ""
        }),
        stderr: 'jetski: no output produced — a tool required the "command" permission\n'
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            { spawnImpl }
        );
        assert.equal(result.outcome, "agent_failure");
        assert.equal(result.isError, true);
        assert.match(result.text, /^Outcome: agent_failure\nAntigravity reported SUCCESS but returned an empty response\.\nTreat the implementation as not completed\./);
        assert.match(result.text, /Likely cause:\nA shell command was denied by the Antigravity permission policy\./);
        assert.match(result.text, /Next step:\nTell the engineer exactly which commands it may run, or add a narrow allow rule in ~[/\\]\.gemini[/\\]antigravity-cli[/\\]settings\.json \(docs\/permissions\.md\)\./);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("empty-response with soft-deny diagnostics includes the permission next step", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: JSON.stringify({
            status: "SUCCESS",
            response: ""
        }),
        stderr: "command resulted in soft-deny by policy\n"
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            { spawnImpl }
        );
        assert.equal(result.outcome, "agent_failure");
        assert.equal(result.isError, true);
        assert.match(result.text, /Likely cause:\nA shell command was denied by the Antigravity permission policy\./);
        assert.match(result.text, /Next step:\nTell the engineer exactly which commands it may run, or add a narrow allow rule in ~[/\\]\.gemini[/\\]antigravity-cli[/\\]settings\.json \(docs\/permissions\.md\)\./);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("empty-response with print-timeout diagnostics includes the split and baseline next step", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: JSON.stringify({
            status: "SUCCESS",
            response: ""
        }),
        stderr: "[agy] print timeout after 15m0s with turn in progress; returning partial output\n"
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            { spawnImpl }
        );
        assert.equal(result.outcome, "agent_failure");
        assert.equal(result.isError, true);
        assert.match(result.text, /^Outcome: agent_failure\nAntigravity reported SUCCESS but returned an empty response\.\nTreat the implementation as not completed\./);
        assert.match(result.text, /Likely cause:\nThe print timeout elapsed; partial edits may exist on disk — compare git status with the baseline before retrying\./);
        assert.match(result.text, /Next step:\nSplit the assignment into smaller sequential delegations\./);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("empty-response without permission or timeout diagnostics includes no extra advice section", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        code: 0,
        stdout: JSON.stringify({
            status: "SUCCESS",
            response: ""
        }),
        stderr: "normal diagnostics\n"
    });

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            { spawnImpl }
        );
        assert.equal(result.outcome, "agent_failure");
        assert.equal(result.isError, true);
        assert.equal(result.text.includes("Likely cause:"), false);
        assert.equal(result.text.includes("Next step:"), false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("normalizeIsolation accepts valid values, defaults omitted/empty to none, and rejects invalid", () => {
    assert.equal(normalizeIsolation(), "none");
    assert.equal(normalizeIsolation(undefined), "none");
    assert.equal(normalizeIsolation(null), "none");
    assert.equal(normalizeIsolation(""), "none");
    assert.equal(normalizeIsolation("none"), "none");
    assert.equal(normalizeIsolation("worktree"), "worktree");

    assert.throws(() => normalizeIsolation("docker"), /isolation must be one of: none, worktree/);
    assert.throws(() => normalizeIsolation("container"), /isolation must be one of: none, worktree/);
    assert.throws(() => normalizeIsolation(123), /isolation must be one of: none, worktree/);
});

test("isolation omitted and 'none': agy spawn cwd and args identical to today (regression guard), no worktree function called", async () => {
    const directory = await tempDirectory();
    const envelope = {
        conversation_id: "conv-reg",
        status: "SUCCESS",
        response: "All good.\n"
    };

    const worktreeGuards = {
        createWorktree: () => { throw new Error("createWorktree should not be called"); },
        loadDelegation: () => { throw new Error("loadDelegation should not be called"); },
        buildPatch: () => { throw new Error("buildPatch should not be called"); },
        removeWorktree: () => { throw new Error("removeWorktree should not be called"); }
    };

    try {
        // 1. Omitted isolation
        const spawn1 = mockSpawn({ code: 0, stdout: JSON.stringify(envelope) });
        const res1 = await delegateToAntigravity(
            { prompt: "Fix bug", cwd: directory, model: "gemini-test", effort: "low" },
            { spawnImpl: spawn1.spawnImpl, worktree: worktreeGuards }
        );
        assert.equal(res1.outcome, "agent_success");
        assert.equal(res1.isError, false);
        assert.equal("delegation" in res1, false);
        assert.equal(res1.text.includes("Isolation: worktree"), false);
        assert.equal(spawn1.calls.length, 1);
        assert.equal(spawn1.calls[0].options.cwd, path.resolve(directory));
        assert.ok(spawn1.calls[0].args.includes("--model"));
        assert.ok(spawn1.calls[0].args.includes("gemini-test"));
        assert.ok(spawn1.calls[0].args.includes("--effort"));
        assert.ok(spawn1.calls[0].args.includes("low"));

        // 2. Explicit "none"
        const spawn2 = mockSpawn({ code: 0, stdout: JSON.stringify(envelope) });
        const res2 = await delegateToAntigravity(
            { prompt: "Fix bug", cwd: directory, isolation: "none", model: "gemini-test", effort: "low" },
            { spawnImpl: spawn2.spawnImpl, worktree: worktreeGuards }
        );
        assert.equal(res2.outcome, "agent_success");
        assert.equal(res2.isError, false);
        assert.equal("delegation" in res2, false);
        assert.equal(res2.text.includes("Isolation: worktree"), false);
        assert.equal(spawn2.calls.length, 1);
        assert.equal(spawn2.calls[0].options.cwd, path.resolve(directory));
        assert.deepEqual(spawn1.calls[0].args, spawn2.calls[0].args);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("invalid isolation; delegationId without worktree isolation -> validation_failure, no spawn", async () => {
    const directory = await tempDirectory();
    const { spawnImpl, calls } = mockSpawn();

    try {
        // Invalid isolation
        const res1 = await delegateToAntigravity(
            { prompt: "Fix bug", cwd: directory, isolation: "docker" },
            { spawnImpl }
        );
        assert.equal(res1.outcome, "validation_failure");
        assert.equal(res1.isError, true);
        assert.match(res1.text, /isolation must be one of: none, worktree/);
        assert.equal(calls.length, 0);

        // delegationId with isolation "none"
        const res2 = await delegateToAntigravity(
            { prompt: "Fix bug", cwd: directory, isolation: "none", delegationId: "0123456789" },
            { spawnImpl }
        );
        assert.equal(res2.outcome, "validation_failure");
        assert.equal(res2.isError, true);
        assert.match(res2.text, /delegationId is only valid when isolation is "worktree"/);
        assert.equal(calls.length, 0);

        // delegationId with omitted isolation
        const res3 = await delegateToAntigravity(
            { prompt: "Fix bug", cwd: directory, delegationId: "0123456789" },
            { spawnImpl }
        );
        assert.equal(res3.outcome, "validation_failure");
        assert.equal(res3.isError, true);
        assert.match(res3.text, /delegationId is only valid when isolation is "worktree"/);
        assert.equal(calls.length, 0);

        // invalid delegationId with isolation "worktree"
        const res4 = await delegateToAntigravity(
            { prompt: "Fix bug", cwd: directory, isolation: "worktree", delegationId: "invalid-id" },
            { spawnImpl }
        );
        assert.equal(res4.outcome, "validation_failure");
        assert.equal(res4.isError, true);
        assert.match(res4.text, /Invalid delegation ID/);
        assert.equal(calls.length, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("worktree happy path: agy spawn cwd === worktreePath (not input cwd); buildPatch called; text contains required isolation lines; delegation field populated; outcome agent_success", async () => {
    const directory = await tempDirectory();
    const fakeWorktreePath = path.join(directory, "mock-worktree");
    const fakePatchPath = path.join(directory, "mock.patch");
    const envelope = {
        conversation_id: "conv-wt-happy",
        status: "SUCCESS",
        response: "Implemented feature."
    };
    const { spawnImpl, calls } = mockSpawn({ code: 0, stdout: JSON.stringify(envelope) });

    let createCalled = false;
    let buildPatchArgs = null;
    let gitSpawnUsed = null;

    const mockWorktree = {
        createWorktree: async ({ cwd, env, spawnImpl: gitSpawn }) => {
            createCalled = true;
            gitSpawnUsed = gitSpawn;
            return {
                ok: true,
                delegationId: "abcdef0123",
                repoRoot: cwd,
                baseCommit: "deadbeef00112233445566778899aabbccddeeff",
                worktreePath: fakeWorktreePath,
                patchPath: fakePatchPath,
                metaPath: path.join(directory, "meta.json"),
                mainTreeStatus: "M src/index.js\n?? newfile.txt"
            };
        },
        buildPatch: async (args) => {
            buildPatchArgs = args;
            return {
                ok: true,
                hasChanges: true,
                patchPath: fakePatchPath,
                diffstat: "src/index.js | 2 +-\n 1 file changed"
            };
        }
    };

    const dummyGitSpawn = () => {};

    try {
        const result = await delegateToAntigravity(
            { prompt: "Fix bug", cwd: directory, isolation: "worktree" },
            {
                spawnImpl,
                gitSpawnImpl: dummyGitSpawn,
                worktree: mockWorktree
            }
        );

        assert.equal(result.outcome, "agent_success");
        assert.equal(result.isError, false);
        assert.equal(createCalled, true);
        assert.equal(gitSpawnUsed, dummyGitSpawn);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.cwd, fakeWorktreePath);
        assert.notEqual(calls[0].options.cwd, path.resolve(directory));

        assert.ok(buildPatchArgs);
        assert.equal(buildPatchArgs.worktreePath, fakeWorktreePath);
        assert.equal(buildPatchArgs.patchPath, fakePatchPath);
        assert.equal(buildPatchArgs.spawnImpl, dummyGitSpawn);

        // Assert delegation field
        assert.deepEqual(result.delegation, {
            delegationId: "abcdef0123",
            worktreePath: fakeWorktreePath,
            baseCommit: "deadbeef00112233445566778899aabbccddeeff",
            patchPath: fakePatchPath,
            hasChanges: true
        });

        // Assert text contents
        assert.ok(result.text.includes("Outcome: agent_success"));
        assert.ok(result.text.includes("Implemented feature."));
        assert.ok(result.text.includes("Isolation: worktree"));
        assert.ok(result.text.includes("Delegation ID: abcdef0123"));
        assert.ok(result.text.includes(`Worktree: ${fakeWorktreePath}`));
        assert.ok(result.text.includes("Base commit: deadbeef00112233445566778899aabbccddeeff"));
        assert.ok(result.text.includes(`Patch: ${fakePatchPath}`));
        assert.ok(result.text.includes("Main tree was not modified by this run. Nothing lands in the main tree until apply_delegation."));
        assert.ok(result.text.includes("Changes:\nsrc/index.js | 2 +-\n 1 file changed"));
        assert.ok(result.text.includes("Main tree status at worktree creation:\nM src/index.js\n?? newfile.txt"));
        assert.ok(result.text.includes("Next: review with the patch/worktree, then call apply_delegation or discard_delegation with this delegation ID."));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("worktree: hasChanges false -> 'No changes.' and clean status", async () => {
    const directory = await tempDirectory();
    const fakeWorktreePath = path.join(directory, "mock-worktree");
    const fakePatchPath = path.join(directory, "mock.patch");
    const envelope = {
        conversation_id: "conv-no-changes",
        status: "SUCCESS",
        response: "Inspected only."
    };
    const { spawnImpl } = mockSpawn({ code: 0, stdout: JSON.stringify(envelope) });

    const mockWorktree = {
        createWorktree: async ({ cwd }) => ({
            ok: true,
            delegationId: "1122334455",
            repoRoot: cwd,
            baseCommit: "c0ffee00112233445566778899aabbccddeeff00",
            worktreePath: fakeWorktreePath,
            patchPath: fakePatchPath,
            metaPath: path.join(directory, "meta.json"),
            mainTreeStatus: ""
        }),
        buildPatch: async () => ({
            ok: true,
            hasChanges: false,
            patchPath: fakePatchPath,
            diffstat: ""
        })
    };

    try {
        const result = await delegateToAntigravity(
            { prompt: "Inspect code", cwd: directory, isolation: "worktree" },
            { spawnImpl, worktree: mockWorktree }
        );

        assert.equal(result.outcome, "agent_success");
        assert.equal(result.isError, false);
        assert.equal(result.delegation.hasChanges, false);
        assert.ok(result.text.includes("Changes:\nNo changes."));
        assert.ok(result.text.includes("Main tree status at worktree creation:\nclean"));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("createWorktree failure -> validation_failure, zero agy spawns", async () => {
    const directory = await tempDirectory();
    const { spawnImpl, calls } = mockSpawn();

    const mockWorktree = {
        createWorktree: async () => ({
            ok: false,
            error: "Not inside a git repository: fatal: not a git repository"
        })
    };

    try {
        const result = await delegateToAntigravity(
            { prompt: "Fix bug", cwd: directory, isolation: "worktree" },
            { spawnImpl, worktree: mockWorktree }
        );

        assert.equal(result.outcome, "validation_failure");
        assert.equal(result.isError, true);
        assert.ok(result.text.includes("Outcome: validation_failure"));
        assert.ok(result.text.includes("Not inside a git repository: fatal: not a git repository"));
        assert.equal(calls.length, 0);
        assert.equal("delegation" in result, false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("delegationId revision: loadDelegation used, createWorktree NOT called, agy cwd = loaded worktree; unknown id -> validation_failure, no spawn", async () => {
    const directory = await tempDirectory();
    const fakeWorktreePath = path.join(directory, "existing-worktree");
    const fakePatchPath = path.join(directory, "existing.patch");

    try {
        // Part A: Valid revision
        const envelope = {
            conversation_id: "conv-rev",
            status: "SUCCESS",
            response: "Revision completed."
        };
        const spawn1 = mockSpawn({ code: 0, stdout: JSON.stringify(envelope) });

        let loadDelegationCalledWith = null;
        const mockWorktreeA = {
            createWorktree: () => {
                throw new Error("createWorktree must NOT be called for a revision");
            },
            loadDelegation: async (args) => {
                loadDelegationCalledWith = args;
                return {
                    ok: true,
                    delegationId: "9988776655",
                    repoRoot: directory,
                    baseCommit: "base1234567890",
                    worktreePath: fakeWorktreePath,
                    patchPath: fakePatchPath
                };
            },
            buildPatch: async () => ({
                ok: true,
                hasChanges: true,
                patchPath: fakePatchPath,
                diffstat: "revised.js | 1 +"
            })
        };

        const res1 = await delegateToAntigravity(
            { prompt: "Revise fix", cwd: directory, isolation: "worktree", delegationId: "9988776655" },
            { spawnImpl: spawn1.spawnImpl, worktree: mockWorktreeA }
        );

        assert.equal(res1.outcome, "agent_success");
        assert.equal(res1.isError, false);
        assert.ok(loadDelegationCalledWith);
        assert.equal(loadDelegationCalledWith.delegationId, "9988776655");
        assert.equal(spawn1.calls.length, 1);
        assert.equal(spawn1.calls[0].options.cwd, fakeWorktreePath);

        assert.deepEqual(res1.delegation, {
            delegationId: "9988776655",
            worktreePath: fakeWorktreePath,
            baseCommit: "base1234567890",
            patchPath: fakePatchPath,
            hasChanges: true
        });

        assert.ok(res1.text.includes("Delegation ID: 9988776655"));
        assert.ok(res1.text.includes(`Worktree: ${fakeWorktreePath}`));
        assert.ok(res1.text.includes("Base commit: base1234567890"));
        // Omits mainTreeStatus for revision
        assert.equal(res1.text.includes("Main tree status at worktree creation:"), false);

        // Part B: Unknown delegation id
        const spawn2 = mockSpawn();
        const mockWorktreeB = {
            loadDelegation: async () => ({
                ok: false,
                error: "Unknown delegation ID: 0000000000"
            })
        };

        const res2 = await delegateToAntigravity(
            { prompt: "Revise unknown", cwd: directory, isolation: "worktree", delegationId: "0000000000" },
            { spawnImpl: spawn2.spawnImpl, worktree: mockWorktreeB }
        );

        assert.equal(res2.outcome, "validation_failure");
        assert.equal(res2.isError, true);
        assert.ok(res2.text.includes("Unknown delegation ID: 0000000000"));
        assert.equal(spawn2.calls.length, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("timeout / agent_failure / cli_failure under isolation: buildPatch still called, removeWorktree never called, outcome name preserved", async () => {
    const directory = await tempDirectory();
    const fakeWorktreePath = path.join(directory, "mock-worktree");
    const fakePatchPath = path.join(directory, "mock.patch");

    const outcomes = [
        {
            name: "agent_failure",
            spawnBehavior: {
                code: 0,
                stdout: JSON.stringify({ status: "ERROR", error: "agent error" })
            },
            extraOpts: {}
        },
        {
            name: "cli_failure",
            spawnBehavior: {
                code: 1,
                stderr: "crash"
            },
            extraOpts: {}
        },
        {
            name: "timeout",
            spawnBehavior: {
                hang: true
            },
            extraOpts: { hardTimeoutMs: 20 }
        }
    ];

    try {
        for (const { name, spawnBehavior, extraOpts } of outcomes) {
            const { spawnImpl } = mockSpawn(spawnBehavior);
            let buildPatchCalled = false;
            let removeWorktreeCalled = false;

            const mockWorktree = {
                createWorktree: async ({ cwd }) => ({
                    ok: true,
                    delegationId: "123456789a",
                    repoRoot: cwd,
                    baseCommit: "commit123",
                    worktreePath: fakeWorktreePath,
                    patchPath: fakePatchPath,
                    mainTreeStatus: "clean"
                }),
                buildPatch: async () => {
                    buildPatchCalled = true;
                    return {
                        ok: true,
                        hasChanges: false,
                        patchPath: fakePatchPath,
                        diffstat: ""
                    };
                },
                removeWorktree: () => {
                    removeWorktreeCalled = true;
                }
            };

            const result = await delegateToAntigravity(
                { prompt: "Task", cwd: directory, isolation: "worktree" },
                {
                    spawnImpl,
                    worktree: mockWorktree,
                    ...extraOpts
                }
            );

            assert.equal(result.outcome, name);
            assert.equal(result.isError, true);
            assert.equal(buildPatchCalled, true, `buildPatch must be called on ${name}`);
            assert.equal(removeWorktreeCalled, false, `removeWorktree must NEVER be called on ${name}`);
            assert.ok(result.delegation);
            assert.equal(result.delegation.delegationId, "123456789a");
            assert.ok(result.text.includes("Isolation: worktree"));
            assert.ok(result.text.includes(`Outcome: ${name}`));
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("buildPatch failure under isolation -> isError true, message included, original outcome name preserved", async () => {
    const directory = await tempDirectory();
    const fakeWorktreePath = path.join(directory, "mock-worktree");
    const fakePatchPath = path.join(directory, "mock.patch");
    const envelope = {
        conversation_id: "conv-bp-fail",
        status: "SUCCESS",
        response: "Done."
    };
    const { spawnImpl } = mockSpawn({ code: 0, stdout: JSON.stringify(envelope) });

    const mockWorktree = {
        createWorktree: async ({ cwd }) => ({
            ok: true,
            delegationId: "aabb112233",
            repoRoot: cwd,
            baseCommit: "basecommit123",
            worktreePath: fakeWorktreePath,
            patchPath: fakePatchPath,
            mainTreeStatus: "clean"
        }),
        buildPatch: async () => ({
            ok: false,
            error: "git diff failed: disk read error"
        })
    };

    try {
        const result = await delegateToAntigravity(
            { prompt: "Fix bug", cwd: directory, isolation: "worktree" },
            { spawnImpl, worktree: mockWorktree }
        );

        assert.equal(result.outcome, "agent_success");
        assert.equal(result.isError, true);
        assert.ok(result.text.includes("Patch generation failed: git diff failed: disk read error"));
        assert.equal(result.text.includes("Changes:"), false);
        assert.equal(result.delegation.hasChanges, false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("two concurrent worktree delegations with same cwd -> distinct delegation ids and distinct agy cwds", async () => {
    const directory = await tempDirectory();
    let counter = 0;

    const mockWorktree = {
        createWorktree: async ({ cwd }) => {
            counter++;
            const id = `000000000${counter}`;
            return {
                ok: true,
                delegationId: id,
                repoRoot: cwd,
                baseCommit: "basecommit",
                worktreePath: path.join(directory, `wt-${id}`),
                patchPath: path.join(directory, `patch-${id}`),
                mainTreeStatus: "clean"
            };
        },
        buildPatch: async ({ patchPath }) => ({
            ok: true,
            hasChanges: true,
            patchPath,
            diffstat: "file | 1 +"
        })
    };

    const envelope = {
        conversation_id: "conv-concurrent",
        status: "SUCCESS",
        response: "Concurrent done."
    };

    const calls = [];
    const spawnImpl = (bin, args, options) => {
        calls.push({ bin, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 5555;
        child.killed = false;
        child.kill = () => { child.killed = true; };
        queueMicrotask(() => {
            child.stdout.emit("data", JSON.stringify(envelope));
            child.emit("close", 0);
        });
        return child;
    };

    try {
        const [res1, res2] = await Promise.all([
            delegateToAntigravity(
                { prompt: "Task 1", cwd: directory, isolation: "worktree" },
                { spawnImpl, worktree: mockWorktree }
            ),
            delegateToAntigravity(
                { prompt: "Task 2", cwd: directory, isolation: "worktree" },
                { spawnImpl, worktree: mockWorktree }
            )
        ]);

        assert.equal(res1.outcome, "agent_success");
        assert.equal(res2.outcome, "agent_success");
        assert.notEqual(res1.delegation.delegationId, res2.delegation.delegationId);
        assert.notEqual(res1.delegation.worktreePath, res2.delegation.worktreePath);
        assert.equal(calls.length, 2);
        assert.notEqual(calls[0].options.cwd, calls[1].options.cwd);
        assert.equal(calls[0].options.cwd, res1.delegation.worktreePath);
        assert.equal(calls[1].options.cwd, res2.delegation.worktreePath);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("applyDelegation: applied / no_changes / apply_conflict / apply_error / invalid id", async () => {
    const directory = await tempDirectory();

    try {
        // 1. Invalid id
        const invRes = await applyDelegation({ cwd: directory, delegationId: "not-an-id" });
        assert.equal(invRes.outcome, "validation_failure");
        assert.equal(invRes.isError, true);
        assert.match(invRes.text, /Invalid delegation ID/);

        // 2. Validation failure from loadDelegation (unknown id)
        const mockUnknown = {
            loadDelegation: async () => ({ ok: false, error: "Unknown delegation ID: 1234567890" })
        };
        const unkRes = await applyDelegation(
            { cwd: directory, delegationId: "1234567890" },
            { worktree: mockUnknown }
        );
        assert.equal(unkRes.outcome, "validation_failure");
        assert.equal(unkRes.isError, true);
        assert.match(unkRes.text, /Unknown delegation ID/);

        // Helper mock for successful load
        const loadOk = async () => ({
            ok: true,
            delegationId: "abcdef1234",
            repoRoot: directory,
            baseCommit: "commitsha999",
            patchPath: path.join(directory, "patch.diff"),
            worktreePath: path.join(directory, "wt")
        });

        // 3. Applied
        const mockApplied = {
            loadDelegation: loadOk,
            applyPatch: async () => ({ ok: true, applied: true })
        };
        const appRes = await applyDelegation(
            { cwd: directory, delegationId: "abcdef1234" },
            { worktree: mockApplied }
        );
        assert.equal(appRes.outcome, "applied");
        assert.equal(appRes.isError, false);
        assert.ok(appRes.text.includes("abcdef1234"));
        assert.ok(appRes.text.includes("unstaged in the main working tree"));
        assert.ok(appRes.text.includes("Team Lead must diff and re-run tests"));
        assert.ok(appRes.text.includes("worktree still exists until discard_delegation"));

        // 4. No changes
        const mockNoChanges = {
            loadDelegation: loadOk,
            applyPatch: async () => ({ ok: true, applied: false, reason: "no changes" })
        };
        const ncRes = await applyDelegation(
            { cwd: directory, delegationId: "abcdef1234" },
            { worktree: mockNoChanges }
        );
        assert.equal(ncRes.outcome, "no_changes");
        assert.equal(ncRes.isError, false);
        assert.ok(ncRes.text.includes("no changes to apply"));

        // 5. Apply conflict
        const mockConflict = {
            loadDelegation: loadOk,
            applyPatch: async () => ({
                ok: false,
                outcome: "apply_conflict",
                error: "error: patch failed: index.js:10\nerror: index.js: patch does not apply"
            })
        };
        const confRes = await applyDelegation(
            { cwd: directory, delegationId: "abcdef1234" },
            { worktree: mockConflict }
        );
        assert.equal(confRes.outcome, "apply_conflict");
        assert.equal(confRes.isError, true);
        assert.ok(confRes.text.includes("main tree moved or overlaps since base commit commitsha999"));
        assert.ok(confRes.text.includes("This is not a revision; discard and re-delegate against the current HEAD or reconcile manually."));
        assert.ok(confRes.text.includes("error: patch failed: index.js:10"));

        // 6. Apply error
        const mockError = {
            loadDelegation: loadOk,
            applyPatch: async () => ({
                ok: false,
                outcome: "apply_error",
                error: "patch binary corrupted"
            })
        };
        const errRes = await applyDelegation(
            { cwd: directory, delegationId: "abcdef1234" },
            { worktree: mockError }
        );
        assert.equal(errRes.outcome, "apply_error");
        assert.equal(errRes.isError, true);
        assert.ok(errRes.text.includes("Failed to apply delegation abcdef1234"));
        assert.ok(errRes.text.includes("patch binary corrupted"));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("discardDelegation: discarded / missing worktree still calls removeWorktree / invalid id", async () => {
    const directory = await tempDirectory();

    try {
        // 1. Invalid id
        const invRes = await discardDelegation({ cwd: directory, delegationId: "bad-id" });
        assert.equal(invRes.outcome, "validation_failure");
        assert.equal(invRes.isError, true);
        assert.match(invRes.text, /Invalid delegation ID/);

        // 2. Discarded (happy path)
        let removeArgs = null;
        const mockHappy = {
            resolveRepoRoot: async () => ({ ok: true, repoRoot: directory }),
            loadDelegation: async () => ({ ok: true, delegationId: "1234567890", repoRoot: directory }),
            removeWorktree: async (args) => {
                removeArgs = args;
                return { ok: true };
            }
        };

        const discRes = await discardDelegation(
            { cwd: directory, delegationId: "1234567890" },
            { worktree: mockHappy }
        );
        assert.equal(discRes.outcome, "discarded");
        assert.equal(discRes.isError, false);
        assert.ok(discRes.text.includes("Delegation 1234567890 discarded."));
        assert.ok(removeArgs);
        assert.equal(removeArgs.repoRoot, directory);
        assert.equal(removeArgs.delegationId, "1234567890");

        // 3. Missing worktree still calls removeWorktree
        let removeCalledOnMissing = false;
        const mockMissing = {
            resolveRepoRoot: async () => ({ ok: true, repoRoot: directory }),
            loadDelegation: async () => ({
                ok: false,
                error: "Missing worktree directory: /tmp/missing-wt"
            }),
            removeWorktree: async () => {
                removeCalledOnMissing = true;
                return { ok: true };
            }
        };

        const missRes = await discardDelegation(
            { cwd: directory, delegationId: "1234567890" },
            { worktree: mockMissing }
        );
        assert.equal(missRes.outcome, "discarded");
        assert.equal(missRes.isError, false);
        assert.equal(removeCalledOnMissing, true, "removeWorktree must be called even when worktree dir is missing");

        // 4. removeWorktree failure -> discard_error
        const mockFail = {
            resolveRepoRoot: async () => ({ ok: true, repoRoot: directory }),
            loadDelegation: async () => ({ ok: true, delegationId: "1234567890", repoRoot: directory }),
            removeWorktree: async () => ({
                ok: false,
                error: "Failed to remove delegation directory: EACCES"
            })
        };

        const failRes = await discardDelegation(
            { cwd: directory, delegationId: "1234567890" },
            { worktree: mockFail }
        );
        assert.equal(failRes.outcome, "discard_error");
        assert.equal(failRes.isError, true);
        assert.ok(failRes.text.includes("Failed to discard delegation 1234567890"));
        assert.ok(failRes.text.includes("EACCES"));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("discardDelegation: unknown delegation id returns validation_failure without calling removeWorktree", async () => {
    const directory = await tempDirectory();
    let removeCalled = false;
    const mockUnknown = {
        resolveRepoRoot: async () => ({ ok: true, repoRoot: directory }),
        loadDelegation: async () => ({
            ok: false,
            reason: "unknown_id",
            error: "Unknown delegation ID: 9999999999"
        }),
        removeWorktree: async () => {
            removeCalled = true;
            return { ok: true };
        }
    };

    try {
        const result = await discardDelegation(
            { cwd: directory, delegationId: "9999999999" },
            { worktree: mockUnknown }
        );
        assert.equal(result.outcome, "validation_failure");
        assert.equal(result.isError, true);
        assert.ok(result.text.includes("Unknown delegation ID: 9999999999"));
        assert.equal(removeCalled, false, "removeWorktree must NOT be called for an unknown delegation ID");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("busy guard: revision on a running id returns validation_failure without spawning", async () => {
    const directory = await tempDirectory();
    const delegationId = "aabb112233";
    let releaseRun;
    const runWait = new Promise((resolve) => {
        releaseRun = resolve;
    });

    let spawnCount = 0;
    const spawnImpl = () => {
        spawnCount++;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 9999;
        child.kill = () => {};
        runWait.then(() => {
            child.stdout.emit("data", JSON.stringify({ status: "SUCCESS", response: "Done" }));
            child.emit("close", 0);
        });
        return child;
    };

    const mockWorktree = {
        createWorktree: async () => ({
            ok: true,
            delegationId,
            repoRoot: directory,
            baseCommit: "commit1",
            worktreePath: path.join(directory, "wt"),
            patchPath: path.join(directory, "patch"),
            mainTreeStatus: "clean"
        }),
        loadDelegation: async () => ({
            ok: true,
            delegationId,
            repoRoot: directory,
            baseCommit: "commit1",
            worktreePath: path.join(directory, "wt"),
            patchPath: path.join(directory, "patch")
        }),
        buildPatch: async () => ({ ok: true, hasChanges: false, diffstat: "" })
    };

    try {
        const run1Promise = delegateToAntigravity(
            { prompt: "Run 1", cwd: directory, isolation: "worktree" },
            { spawnImpl, worktree: mockWorktree }
        );

        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(busyDelegations.has(makeBusyKey(directory, delegationId)), true);

        const revResult = await delegateToAntigravity(
            { prompt: "Revision while busy", cwd: directory, isolation: "worktree", delegationId },
            { spawnImpl, worktree: mockWorktree }
        );

        assert.equal(revResult.outcome, "validation_failure");
        assert.equal(revResult.isError, true);
        assert.ok(revResult.text.includes(`Delegation ${delegationId} is already running; wait for it to finish before revising it.`));
        assert.equal(spawnCount, 1, "second agy process must NOT be spawned");

        releaseRun();
        const run1Result = await run1Promise;
        assert.equal(run1Result.outcome, "agent_success");
        assert.equal(busyDelegations.has(makeBusyKey(directory, delegationId)), false);
    } finally {
        releaseRun?.();
        await rm(directory, { recursive: true, force: true });
    }
});

test("busy guard: apply and discard on a running id return validation_failure", async () => {
    const directory = await tempDirectory();
    const delegationId = "ccdd445566";
    let releaseRun;
    const runWait = new Promise((resolve) => {
        releaseRun = resolve;
    });

    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 9998;
        child.kill = () => {};
        runWait.then(() => {
            child.stdout.emit("data", JSON.stringify({ status: "SUCCESS", response: "Done" }));
            child.emit("close", 0);
        });
        return child;
    };

    let applyPatchCalled = false;
    let removeWorktreeCalled = false;

    const mockWorktree = {
        resolveRepoRoot: async () => ({ ok: true, repoRoot: directory }),
        createWorktree: async () => ({
            ok: true,
            delegationId,
            repoRoot: directory,
            baseCommit: "commit1",
            worktreePath: path.join(directory, "wt"),
            patchPath: path.join(directory, "patch"),
            mainTreeStatus: "clean"
        }),
        loadDelegation: async () => ({
            ok: true,
            delegationId,
            repoRoot: directory,
            baseCommit: "commit1",
            worktreePath: path.join(directory, "wt"),
            patchPath: path.join(directory, "patch")
        }),
        buildPatch: async () => ({ ok: true, hasChanges: false, diffstat: "" }),
        applyPatch: async () => {
            applyPatchCalled = true;
            return { ok: true, applied: true };
        },
        removeWorktree: async () => {
            removeWorktreeCalled = true;
            return { ok: true };
        }
    };

    try {
        const runPromise = delegateToAntigravity(
            { prompt: "Task", cwd: directory, isolation: "worktree" },
            { spawnImpl, worktree: mockWorktree }
        );

        await new Promise((resolve) => setTimeout(resolve, 10));

        const applyRes = await applyDelegation(
            { cwd: directory, delegationId },
            { worktree: mockWorktree }
        );
        assert.equal(applyRes.outcome, "validation_failure");
        assert.equal(applyRes.isError, true);
        assert.ok(applyRes.text.includes(`Delegation ${delegationId} is already running; wait for it to finish before applying it.`));
        assert.equal(applyPatchCalled, false, "applyPatch must NOT be called while busy");

        const discardRes = await discardDelegation(
            { cwd: directory, delegationId },
            { worktree: mockWorktree }
        );
        assert.equal(discardRes.outcome, "validation_failure");
        assert.equal(discardRes.isError, true);
        assert.ok(discardRes.text.includes(`Delegation ${delegationId} is already running; wait for it to finish before discarding it.`));
        assert.equal(removeWorktreeCalled, false, "removeWorktree must NOT be called while busy");

        releaseRun();
        await runPromise;
    } finally {
        releaseRun?.();
        await rm(directory, { recursive: true, force: true });
    }
});

test("busy guard: guard is released after success, failure, and thrown errors", async () => {
    const directory = await tempDirectory();
    const key = makeBusyKey(directory, "eeff778899");

    const makeMockWorktree = ({ buildPatchError, buildPatchThrows } = {}) => ({
        createWorktree: async () => ({
            ok: true,
            delegationId: "eeff778899",
            repoRoot: directory,
            baseCommit: "commit1",
            worktreePath: path.join(directory, "wt"),
            patchPath: path.join(directory, "patch"),
            mainTreeStatus: "clean"
        }),
        buildPatch: async () => {
            if (buildPatchThrows) {
                throw new Error("Disk read failure");
            }
            if (buildPatchError) {
                return { ok: false, error: "diff error" };
            }
            return { ok: true, hasChanges: false, diffstat: "" };
        }
    });

    try {
        const { spawnImpl: spawnSuccess } = mockSpawn({
            stdout: JSON.stringify({ status: "SUCCESS", response: "Done" })
        });
        assert.equal(busyDelegations.has(key), false);
        await delegateToAntigravity(
            { prompt: "Task", cwd: directory, isolation: "worktree" },
            { spawnImpl: spawnSuccess, worktree: makeMockWorktree() }
        );
        assert.equal(busyDelegations.has(key), false);

        const { spawnImpl: spawnFail } = mockSpawn({ code: 1, stderr: "error" });
        await delegateToAntigravity(
            { prompt: "Task", cwd: directory, isolation: "worktree" },
            { spawnImpl: spawnFail, worktree: makeMockWorktree() }
        );
        assert.equal(busyDelegations.has(key), false);

        await delegateToAntigravity(
            { prompt: "Task", cwd: directory, isolation: "worktree" },
            { spawnImpl: spawnSuccess, worktree: makeMockWorktree({ buildPatchError: true }) }
        );
        assert.equal(busyDelegations.has(key), false);

        await delegateToAntigravity(
            { prompt: "Task", cwd: directory, isolation: "worktree" },
            { spawnImpl: spawnSuccess, worktree: makeMockWorktree({ buildPatchThrows: true }) }
        );
        assert.equal(busyDelegations.has(key), false);
    } finally {
        busyDelegations.delete(key);
        await rm(directory, { recursive: true, force: true });
    }
});

