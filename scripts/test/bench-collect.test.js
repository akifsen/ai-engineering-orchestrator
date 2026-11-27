import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
    collectClaudeUsage,
    engineerTokensFromUsage,
    extractExecutionMetadata,
    extractOutcome,
    extractToolResultText,
    hasQuotaFallback
} from "../bench/collect-claude-usage.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts", "bench", "collect-claude-usage.mjs");
const fixtureWithDelegations = path.join(
    repoRoot,
    "scripts",
    "test",
    "fixtures",
    "bench",
    "session-with-delegations.jsonl"
);
const fixturePlain = path.join(
    repoRoot,
    "scripts",
    "test",
    "fixtures",
    "bench",
    "session-plain.jsonl"
);

test("collects usage from session with delegations (token sums, model list, wall-clock seconds)", async () => {
    const raw = await readFile(fixtureWithDelegations, "utf8");
    const result = collectClaudeUsage(raw);

    assert.equal(result.session, "session-bench-with-delegations");
    assert.equal(result.assistantMessages, 3);
    assert.equal(result.assistantLines, 5);
    assert.ok(result.assistantMessages < result.assistantLines);

    // token sums
    assert.equal(result.teamLead.input_tokens, 1800);
    assert.equal(result.teamLead.output_tokens, 350);
    assert.equal(result.teamLead.cache_creation_input_tokens, 80);
    assert.equal(result.teamLead.cache_read_input_tokens, 40);

    // model list
    assert.deepEqual(result.teamLead.model, ["claude-fable-5-1"]);

    // wall-clock seconds
    assert.equal(result.wallClock.firstTimestamp, "2026-10-23T10:00:00.000Z");
    assert.equal(result.wallClock.lastTimestamp, "2026-10-23T10:01:30.000Z");
    assert.equal(result.wallClock.seconds, 90);

    // delegation count 2
    assert.equal(result.delegationCount, 2);
    assert.equal(result.delegations.length, 2);

    // first delegation parsed (outcome, model, engineerTokens 6830, quotaFallback true)
    const d0 = result.delegations[0];
    assert.equal(d0.tool, "delegate_antigravity");
    assert.equal(d0.toolUseId, "toolu_agy_1");
    assert.equal(d0.outcome, "agent_success");
    assert.equal(d0.model, "gemini-3.8-flash-high");
    assert.equal(d0.engineerTokens, 6830);
    assert.equal(d0.quotaFallback, true);
    assert.deepEqual(d0.usage, {
        input_tokens: 6804,
        output_tokens: 26,
        thinking_tokens: 25,
        cache_read_tokens: 0,
        total_tokens: 6830
    });

    // second delegation (engineerTokens 83294 from camelCase usage, model composer-2.5, quotaFallback false)
    const d1 = result.delegations[1];
    assert.equal(d1.tool, "delegate_cursor");
    assert.equal(d1.toolUseId, "toolu_cur_1");
    assert.equal(d1.outcome, "agent_success");
    assert.equal(d1.model, "composer-2.5");
    assert.equal(d1.engineerTokens, 83294);
    assert.deepEqual(d1.usage, {
        inputTokens: 69406,
        outputTokens: 13888,
        cacheReadTokens: 681301,
        cacheWriteTokens: 0
    });
    assert.equal(d1.quotaFallback, false);

    assert.equal(result.engineerTokensTotal, 90124);
});

test("plain session has delegationCount 0 and engineerTokensTotal null", async () => {
    const raw = await readFile(fixturePlain, "utf8");
    const result = collectClaudeUsage(raw);

    assert.equal(result.session, "session-bench-plain");
    assert.equal(result.assistantMessages, 2);
    assert.equal(result.assistantLines, 2);
    assert.equal(result.delegationCount, 0);
    assert.equal(result.engineerTokensTotal, null);
    assert.deepEqual(result.delegations, []);
    assert.equal(result.wallClock.seconds, 15);
    assert.equal(result.teamLead.input_tokens, 300);
    assert.equal(result.teamLead.output_tokens, 75);
    assert.equal(result.teamLead.cache_creation_input_tokens, 0);
    assert.equal(result.teamLead.cache_read_input_tokens, 0);
});

test("engineerTokensFromUsage handles camelCase Cursor shape, total_tokens, and empty usage", () => {
    const cursorUsage = {
        inputTokens: 69406,
        outputTokens: 13888,
        cacheReadTokens: 681301,
        cacheWriteTokens: 0
    };
    assert.equal(engineerTokensFromUsage(cursorUsage), 83294);
    assert.equal(engineerTokensFromUsage({ total_tokens: 10 }), 10);
    assert.equal(engineerTokensFromUsage({}), null);
    assert.equal(engineerTokensFromUsage(null), null);
    assert.equal(engineerTokensFromUsage({ inputTokens: 50 }), null);
});

test("deduplicates assistant lines by requestId fallback or uuid individual count", () => {
    const lines = [
        // requestId fallback
        JSON.stringify({
            type: "assistant",
            requestId: "req_shared",
            message: { usage: { input_tokens: 100, output_tokens: 10 } }
        }),
        JSON.stringify({
            type: "assistant",
            requestId: "req_shared",
            message: { usage: { input_tokens: 100, output_tokens: 10 } }
        }),
        // uuid individual lines
        JSON.stringify({
            type: "assistant",
            uuid: "u_1",
            message: { usage: { input_tokens: 50, output_tokens: 5 } }
        }),
        JSON.stringify({
            type: "assistant",
            uuid: "u_2",
            message: { usage: { input_tokens: 50, output_tokens: 5 } }
        })
    ].join("\n");

    const result = collectClaudeUsage(lines);
    assert.equal(result.assistantLines, 4);
    assert.equal(result.assistantMessages, 3);
    assert.equal(result.teamLead.input_tokens, 200);
    assert.equal(result.teamLead.output_tokens, 20);
});

test("helper extractToolResultText handles missing text in content array", () => {
    const content = [
        { type: "image", source: { type: "base64", data: "..." } },
        { type: "text", text: "Outcome: agent_success" },
        null,
        { text: 123 },
        { type: "text", text: "Execution metadata:\n{ \"model\": \"foo\" }" }
    ];
    const text = extractToolResultText(content);
    assert.ok(text.includes("Outcome: agent_success"));
    assert.ok(text.includes('Execution metadata:\n{ "model": "foo" }'));
    assert.equal(extractOutcome(text), "agent_success");
    const meta = extractExecutionMetadata(text);
    assert.equal(meta?.model, "foo");
});

test("helper extractOutcome handles empty, missing, and matched lines", () => {
    assert.equal(extractOutcome(""), null);
    assert.equal(extractOutcome(null), null);
    assert.equal(extractOutcome("No outcome marker here"), null);
    assert.equal(extractOutcome("Outcome:   custom_outcome  \nMore details"), "custom_outcome");
});

test("helper hasQuotaFallback detects model fallback lines", () => {
    assert.equal(hasQuotaFallback(""), false);
    assert.equal(hasQuotaFallback("Model fallback: model-a -> model-b"), true);
    assert.equal(hasQuotaFallback("No fallback here"), false);
});

test("helper extractExecutionMetadata extracts balanced JSON object after marker", () => {
    const text = [
        "Some prefix text",
        "Execution metadata:",
        "{",
        '  "model": "gemini-3.8-flash-high",',
        '  "nested": { "a": 1, "b": 2 },',
        '  "usage": { "total_tokens": 100 }',
        "}",
        "Some trailing text"
    ].join("\n");
    const meta = extractExecutionMetadata(text);
    assert.ok(meta);
    assert.equal(meta.model, "gemini-3.8-flash-high");
    assert.equal(meta.usage.total_tokens, 100);
});

test("cli invocation via spawnSync prints valid JSON", () => {
    const result = spawnSync(process.execPath, [script, fixtureWithDelegations], {
        encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.session, "session-bench-with-delegations");
    assert.equal(parsed.assistantMessages, 3);
    assert.equal(parsed.assistantLines, 5);
    assert.ok(parsed.assistantMessages < parsed.assistantLines);
    assert.equal(parsed.delegationCount, 2);
    assert.equal(parsed.engineerTokensTotal, 90124);
    assert.equal(parsed.teamLead.input_tokens, 1800);
    assert.equal(parsed.wallClock.seconds, 90);
    assert.equal(parsed.delegations[0].engineerTokens, 6830);
    assert.equal(parsed.delegations[0].quotaFallback, true);
    assert.equal(parsed.delegations[1].engineerTokens, 83294);
    assert.equal(parsed.delegations[1].model, "composer-2.5");
    assert.equal(parsed.delegations[1].quotaFallback, false);
});

test("cli invocation with missing arg exits with code 1", () => {
    const result = spawnSync(process.execPath, [script], {
        encoding: "utf8"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
});

test("cli invocation with non-existent file exits with code 1", () => {
    const result = spawnSync(process.execPath, [script, path.join(repoRoot, "non-existent-session.jsonl")], {
        encoding: "utf8"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not read session file/);
    assert.match(result.stderr, /Usage:/);
});
