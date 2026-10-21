#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const COMMAND_PREFIX = /(?:^\s*|\|\|\s*|&&\s*|;\s*|\|\s*)/;
const COMMAND_PATTERN = new RegExp(
    `${COMMAND_PREFIX.source}(?:` +
        `(npm|pnpm|yarn)\\s+(?:run\\s+)?test\\b|` +
        `node\\s+--test\\b|` +
        `pytest\\b|` +
        `go\\s+test\\b|` +
        `cargo\\s+test\\b` +
        `)`
);
const LINE_MATCH = /^not ok|FAIL|failed|Error|error:|AssertionError|✗|✖|# (tests|pass|fail|skipped)|passed|failing/;
const TRIGGER_FOLLOWING = /^not ok|FAIL|Error/;

export function filterStdout(stdout) {
    if (typeof stdout !== "string" || stdout.length === 0) {
        return stdout;
    }
    const lines = stdout.split(/\r?\n/);
    if (lines.length <= 5) {
        return stdout;
    }

    const keep = new Set();
    for (let i = 0; i < lines.length; i++) {
        if (LINE_MATCH.test(lines[i])) {
            keep.add(i);
            if (TRIGGER_FOLLOWING.test(lines[i])) {
                for (let j = 1; j <= 8 && i + j < lines.length; j++) {
                    keep.add(i + j);
                }
            }
        }
    }

    const startLast5 = Math.max(0, lines.length - 5);
    for (let i = startLast5; i < lines.length; i++) {
        keep.add(i);
    }

    if (keep.size === lines.length) {
        return stdout;
    }

    return lines.filter((_, i) => keep.has(i)).join("\n");
}

const SAMPLE_OUTPUT = `> test-suite@1.0.0 test
> node --test

✔ passing test 1 (10ms)
✔ passing test 2 (8ms)
ℹ diagnostic verbose log line that should be filtered
ℹ another unnecessary log line
✖ failing test 3 (25ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 500
  - 200
      at TestContext.<anonymous> (test/example.test.js:15:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
✔ passing test 4 (5ms)
ℹ extra debug information
# tests 4
# pass 3
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 85.2`;

async function main() {
    try {
        if (process.argv.includes("--self-test")) {
            const filtered = filterStdout(SAMPLE_OUTPUT);
            process.stdout.write(filtered + "\n");
            process.exitCode = 0;
            return;
        }

        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
            process.exitCode = 0;
            return;
        }

        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            process.exitCode = 0;
            return;
        }

        if (data?.tool_name !== "Bash") {
            process.exitCode = 0;
            return;
        }

        const command = data?.tool_input?.command;
        if (typeof command !== "string" || !COMMAND_PATTERN.test(command)) {
            process.exitCode = 0;
            return;
        }

        const toolResponse = data?.tool_response;
        if (!toolResponse || typeof toolResponse.stdout !== "string") {
            process.exitCode = 0;
            return;
        }

        const originalStdout = toolResponse.stdout;
        const filteredStdout = filterStdout(originalStdout);

        if (filteredStdout.length < originalStdout.length) {
            const output = {
                hookSpecificOutput: {
                    hookEventName: "PostToolUse",
                    updatedToolOutput: {
                        stdout: filteredStdout,
                        stderr: toolResponse.stderr ?? "",
                        interrupted: Boolean(toolResponse.interrupted),
                        isImage: false
                    }
                }
            };
            process.stdout.write(JSON.stringify(output) + "\n");
        }

        process.exitCode = 0;
        return;
    } catch {
        process.exitCode = 0;
        return;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
