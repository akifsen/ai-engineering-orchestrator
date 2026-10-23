#!/usr/bin/env node
/**
 * Collect Claude Code session transcript usage and delegation statistics.
 *
 * Reads a Claude Code session transcript JSONL file, computes Team Lead
 * token usage, wall-clock duration, and delegation outcomes/engineer tokens.
 *
 * Node 20+. ESM. Zero package dependencies.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { extractEngineerTokens } from "../measure-delegation.mjs";

export const USAGE_TEXT = "Usage:\n  node scripts/bench/collect-claude-usage.mjs <session.jsonl>";

function isEntrypoint() {
    const invoked = process.argv[1];
    if (!invoked) {
        return false;
    }
    const invokedUrl = invoked.replaceAll("\\", "/");
    const self = import.meta.url.replaceAll("\\", "/");
    return self.endsWith(invokedUrl) || self.endsWith(`/${invokedUrl.split("/").pop()}`);
}

export function parseSessionTranscript(rawText) {
    const lines = rawText.split(/\r?\n/);
    const parsedLines = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            const obj = JSON.parse(trimmed);
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
                parsedLines.push(obj);
            }
        } catch {
            // skip unparsable lines
        }
    }
    return parsedLines;
}

export function extractToolResultText(content) {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter((item) => item != null && typeof item === "object" && typeof item.text === "string")
            .map((item) => item.text)
            .join("\n");
    }
    return "";
}

export function extractOutcome(text) {
    if (!text || typeof text !== "string") {
        return null;
    }
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        if (line.startsWith("Outcome:")) {
            const val = line.slice("Outcome:".length).trim();
            return val || null;
        }
    }
    return null;
}

export function hasQuotaFallback(text) {
    if (!text || typeof text !== "string") {
        return false;
    }
    const lines = text.split(/\r?\n/);
    return lines.some((line) => line.startsWith("Model fallback:"));
}

export function extractExecutionMetadata(text) {
    if (!text || typeof text !== "string") {
        return null;
    }
    const marker = "Execution metadata:";
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) {
        return null;
    }
    const startIndex = text.indexOf("{", markerIndex + marker.length);
    if (startIndex === -1) {
        return null;
    }
    let depth = 0;
    let endIndex = -1;
    for (let i = startIndex; i < text.length; i++) {
        const char = text[i];
        if (char === "{") {
            depth++;
        } else if (char === "}") {
            depth--;
            if (depth === 0) {
                endIndex = i;
                break;
            }
        }
    }
    if (endIndex === -1) {
        return null;
    }
    const jsonStr = text.slice(startIndex, endIndex + 1);
    try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch {
        return null;
    }
    return null;
}

export function engineerTokensFromUsage(usage) {
    const tokens = extractEngineerTokens(usage);
    if (tokens !== null) {
        return tokens;
    }
    if (
        usage != null &&
        typeof usage === "object" &&
        !Array.isArray(usage) &&
        Number.isFinite(usage.inputTokens) &&
        Number.isFinite(usage.outputTokens)
    ) {
        return usage.inputTokens + usage.outputTokens;
    }
    return null;
}

export function computeWallClock(parsedLines) {
    let minMs = Infinity;
    let maxMs = -Infinity;
    let firstTimestamp = null;
    let lastTimestamp = null;
    for (const line of parsedLines) {
        if (typeof line.timestamp === "string" && line.timestamp.trim().length > 0) {
            const ms = Date.parse(line.timestamp);
            if (Number.isFinite(ms)) {
                if (ms < minMs) {
                    minMs = ms;
                    firstTimestamp = line.timestamp;
                }
                if (ms > maxMs) {
                    maxMs = ms;
                    lastTimestamp = line.timestamp;
                }
            }
        }
    }

    if (firstTimestamp === null || lastTimestamp === null) {
        return {
            firstTimestamp: null,
            lastTimestamp: null,
            seconds: null
        };
    }

    const diffSeconds = (maxMs - minMs) / 1000;
    const roundedSeconds = Math.round(diffSeconds * 10) / 10;

    return {
        firstTimestamp,
        lastTimestamp,
        seconds: roundedSeconds
    };
}

export function collectClaudeUsage(rawText) {
    const parsedLines = parseSessionTranscript(rawText);

    let session = null;
    for (const line of parsedLines) {
        if (line.sessionId !== undefined && line.sessionId !== null) {
            session = line.sessionId;
            break;
        }
    }

    let assistantLines = 0;
    let assistantMessages = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationInputTokens = 0;
    let cacheReadInputTokens = 0;
    const models = [];
    const seenAssistantKeys = new Set();
    const seenUsageKeys = new Set();

    for (const line of parsedLines) {
        if (line.type === "assistant") {
            assistantLines++;
            if (typeof line.message?.model === "string" && line.message.model.length > 0) {
                if (!models.includes(line.message.model)) {
                    models.push(line.message.model);
                }
            }

            let responseKey = null;
            if (typeof line.message?.id === "string" && line.message.id.length > 0) {
                responseKey = `msg:${line.message.id}`;
            } else if (typeof line.messageId === "string" && line.messageId.length > 0) {
                responseKey = `msg:${line.messageId}`;
            } else if (typeof line.requestId === "string" && line.requestId.length > 0) {
                responseKey = `req:${line.requestId}`;
            } else if (typeof line.message?.requestId === "string" && line.message.requestId.length > 0) {
                responseKey = `req:${line.message.requestId}`;
            } else if (typeof line.uuid === "string" && line.uuid.length > 0) {
                responseKey = `uuid:${line.uuid}`;
            } else {
                responseKey = Symbol();
            }

            if (!seenAssistantKeys.has(responseKey)) {
                seenAssistantKeys.add(responseKey);
                assistantMessages++;
            }

            if (
                !seenUsageKeys.has(responseKey) &&
                line.message &&
                typeof line.message.usage === "object" &&
                line.message.usage !== null &&
                !Array.isArray(line.message.usage)
            ) {
                seenUsageKeys.add(responseKey);
                const u = line.message.usage;
                if (Number.isFinite(u.input_tokens)) {
                    inputTokens += u.input_tokens;
                }
                if (Number.isFinite(u.output_tokens)) {
                    outputTokens += u.output_tokens;
                }
                if (Number.isFinite(u.cache_creation_input_tokens)) {
                    cacheCreationInputTokens += u.cache_creation_input_tokens;
                }
                if (Number.isFinite(u.cache_read_input_tokens)) {
                    cacheReadInputTokens += u.cache_read_input_tokens;
                }
            }
        }
    }

    const teamLead = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreationInputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        model: models
    };

    const wallClock = computeWallClock(parsedLines);

    const delegations = [];
    const seenToolUseIds = new Set();
    for (let i = 0; i < parsedLines.length; i++) {
        const line = parsedLines[i];
        const content = line.message?.content;
        if (!Array.isArray(content)) {
            continue;
        }
        for (const block of content) {
            if (block && block.type === "tool_use" && typeof block.name === "string") {
                let tool = null;
                if (block.name.endsWith("delegate_antigravity")) {
                    tool = "delegate_antigravity";
                } else if (block.name.endsWith("delegate_cursor")) {
                    tool = "delegate_cursor";
                }
                if (!tool) {
                    continue;
                }
                const toolUseId = block.id;
                if (toolUseId) {
                    if (seenToolUseIds.has(toolUseId)) {
                        continue;
                    }
                    seenToolUseIds.add(toolUseId);
                }

                let toolResultBlock = null;
                for (let j = i + 1; j < parsedLines.length; j++) {
                    const nextContent = parsedLines[j].message?.content ?? parsedLines[j].content;
                    if (Array.isArray(nextContent)) {
                        const match = nextContent.find(
                            (b) => b && b.type === "tool_result" && b.tool_use_id === toolUseId
                        );
                        if (match) {
                            toolResultBlock = match;
                            break;
                        }
                    }
                }

                let outcome = null;
                let model = null;
                let usage = null;
                let engineerTokens = null;
                let quotaFallback = false;

                if (toolResultBlock) {
                    const text = extractToolResultText(toolResultBlock.content);
                    outcome = extractOutcome(text);
                    quotaFallback = hasQuotaFallback(text);
                    const metadata = extractExecutionMetadata(text);
                    if (metadata) {
                        model = metadata.model ?? null;
                        usage = metadata.usage ?? null;
                        engineerTokens = engineerTokensFromUsage(usage);
                    }
                }

                delegations.push({
                    tool,
                    toolUseId,
                    outcome,
                    model,
                    engineerTokens,
                    usage,
                    quotaFallback
                });
            }
        }
    }

    const delegationCount = delegations.length;
    let tokensSum = 0;
    let hasTokens = false;
    for (const d of delegations) {
        if (typeof d.engineerTokens === "number" && Number.isFinite(d.engineerTokens)) {
            tokensSum += d.engineerTokens;
            hasTokens = true;
        }
    }
    const engineerTokensTotal = hasTokens ? tokensSum : null;

    return {
        session,
        assistantMessages,
        assistantLines,
        teamLead,
        wallClock,
        delegations,
        delegationCount,
        engineerTokensTotal
    };
}

export function main(argv = process.argv.slice(2)) {
    if (!argv || argv.length === 0 || !argv[0]) {
        process.stderr.write(`${USAGE_TEXT}\n`);
        process.exitCode = 1;
        return 1;
    }

    const filePath = argv[0];
    let raw;
    try {
        raw = readFileSync(filePath, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Could not read session file: ${message}\n${USAGE_TEXT}\n`);
        process.exitCode = 1;
        return 1;
    }

    const result = collectClaudeUsage(raw);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
}

if (isEntrypoint()) {
    const exitCode = main();
    if (exitCode) {
        process.exitCode = exitCode;
    }
}
