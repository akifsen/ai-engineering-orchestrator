#!/usr/bin/env node
/**
 * Claude Code PreCompact hook to log compaction events for benchmarking.
 *
 * Reads the hook payload from stdin and appends a single tab-separated line
 * to the file specified by AEO_BENCH_COMPACT_LOG.
 *
 * Node 20+. ESM. Zero package dependencies.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function isEntrypoint() {
    const invoked = process.argv[1];
    if (!invoked) {
        return false;
    }
    const invokedUrl = invoked.replaceAll("\\", "/");
    const self = import.meta.url.replaceAll("\\", "/");
    return self.endsWith(invokedUrl) || self.endsWith(`/${invokedUrl.split("/").pop()}`);
}

export function formatLine(payload, now = new Date()) {
    const date = now instanceof Date ? now : (now ? new Date(now) : new Date());
    const timestamp = date.toISOString();

    let sessionId = "-";
    let trigger = "-";

    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const rawSession = payload.session_id ?? payload.sessionId;
        if (rawSession !== undefined && rawSession !== null && String(rawSession).trim() !== "") {
            sessionId = String(rawSession).trim();
        }

        const rawTrigger = payload.trigger;
        if (rawTrigger !== undefined && rawTrigger !== null && String(rawTrigger).trim() !== "") {
            trigger = String(rawTrigger).trim();
        }
    }

    return `${timestamp}\t${sessionId}\t${trigger}\n`;
}

export function readStdinSync() {
    try {
        if (process.stdin.isTTY) {
            return "";
        }
        return readFileSync(0, "utf8");
    } catch {
        return "";
    }
}

export function parseHookPayload(raw) {
    if (!raw || typeof raw !== "string" || !raw.trim()) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw.trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch {
        // tolerant parsing
    }
    return null;
}

export function main(env = process.env) {
    try {
        const logPath = env?.AEO_BENCH_COMPACT_LOG;
        if (!logPath || typeof logPath !== "string" || !logPath.trim()) {
            return 0;
        }

        const raw = readStdinSync();
        const payload = parseHookPayload(raw);
        const line = formatLine(payload);

        const resolvedPath = path.resolve(logPath.trim());
        mkdirSync(path.dirname(resolvedPath), { recursive: true });
        appendFileSync(resolvedPath, line, "utf8");
    } catch {
        // Never throw to stdout; always exit 0 so it cannot block compaction
    }
    return 0;
}

if (isEntrypoint()) {
    process.exitCode = main();
}
