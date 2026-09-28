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
    buildAgyArgs,
    buildImplementationPrompt,
    defaultTerminateProcess,
    delegateToAntigravity,
    parseAgentEnvelope,
    parseDurationMs,
    resolveAgyBin,
    resolveTimeouts,
    truncate
} from "../lib/delegate.js";

function mockSpawn(behavior = {}) {
    const calls = [];
    const spawnImpl = (bin, args, options) => {
        calls.push({ bin, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 4242;
        child.killed = false;
        child.kill = () => {
            child.killed = true;
        };

        queueMicrotask(() => {
            if (behavior.error) {
                child.emit("error", behavior.error);
                return;
            }

            if (behavior.hang) {
                return;
            }

            if (behavior.stdout) {
                child.stdout.emit("data", behavior.stdout);
            }

            if (behavior.stderr) {
                child.stderr.emit("data", behavior.stderr);
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
                terminateProcess: () => {
                    terminated = true;
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

test("pathological stdout is stopped before it is returned in full", async () => {
    const directory = await tempDirectory();
    const { spawnImpl } = mockSpawn({
        stdout: "y".repeat(100)
    });
    let terminated = false;

    try {
        const result = await delegateToAntigravity(
            { prompt: "Update the parser.", cwd: directory },
            {
                spawnImpl,
                maxCollectChars: 20,
                terminateProcess: () => {
                    terminated = true;
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

