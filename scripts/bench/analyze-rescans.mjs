#!/usr/bin/env node
/**
 * Offline analyzer: measures how much each Claude Code session re-discovers a
 * project (discovery calls, result size, cross-session re-reads).
 *
 * Node 20+. ESM. Zero package dependencies. No network, no LLM calls.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
    collectClaudeUsage,
    extractToolResultText,
    parseSessionTranscript
} from "./collect-claude-usage.mjs";

export const USAGE_TEXT =
    "Usage:\n  node scripts/bench/analyze-rescans.mjs <dir-or-file> [<file>...] [--project-root <abs path>]";

const MAX_REREAD_FILES = 50;
const BASH_DISCOVERY_RE =
    /^(?:ls|dir|Get-ChildItem|find|rg|grep|cat|type|head|tail|less|gc|sed\s+-n|git\s+ls-files|git\s+log|git\s+show|Select-String|Get-Content)(?:\s|$)/i;

// Shell file-read parsing (best effort, not a full shell parser).
const READER_VALUE_FLAGS = {
    cat: [],
    type: [],
    less: [],
    head: ["-n", "-c"],
    tail: ["-n", "-c"],
    sed: ["-e", "-f"],
    "get-content": ["-totalcount", "-tail", "-head", "-first", "-last", "-encoding", "-readcount", "-delimiter", "-filter", "-include", "-exclude", "-stream"]
};
READER_VALUE_FLAGS.gc = READER_VALUE_FLAGS["get-content"];
const PATH_FLAGS = new Set(["-path", "-literalpath"]);

function tokenizeCommand(command) {
    const tokens = [];
    let cur = null;
    let quote = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else {
                cur += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            cur = cur ?? "";
        } else if (ch === "|" || ch === ";" || ch === "&" || ch === ">") {
            if (ch === ">" && cur !== null && /^\d+$/.test(cur)) {
                cur = null; // "2>/dev/null": the fd number is not an argument
            }
            break;
        } else if (/\s/.test(ch)) {
            if (cur !== null) {
                tokens.push(cur);
                cur = null;
            }
        } else {
            cur = (cur ?? "") + ch;
        }
    }
    if (cur !== null) {
        tokens.push(cur);
    }
    return tokens;
}

const ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|[\\/]|~)/;

/** Joins a relative shell path onto a base dir (absolute, or relative to projectRoot). */
function joinShellPath(base, p) {
    const b = base.replaceAll("\\", "/").replace(/\/+$/, "");
    return path.posix.normalize(`${b}/${p.replaceAll("\\", "/")}`);
}

function resolveShellPath(p, projectRoot, cwd = null) {
    if (ABSOLUTE_RE.test(p)) {
        return normalizePath(p, projectRoot);
    }
    if (cwd) {
        const base = ABSOLUTE_RE.test(cwd) || !projectRoot ? cwd : joinShellPath(projectRoot, cwd);
        return normalizePath(joinShellPath(base, p), projectRoot);
    }
    if (!projectRoot) {
        return normalizePath(p, projectRoot);
    }
    return normalizePath(joinShellPath(projectRoot, p), projectRoot);
}

/**
 * Splits a shell command into segments on unquoted ";", "&&", "||" and newlines.
 * Each segment keeps only the part before its first unquoted "|". Best effort.
 */
export function splitShellSegments(command) {
    const segments = [];
    let cur = "";
    let quote = null;
    let piped = false;
    const push = () => {
        if (cur.trim()) {
            segments.push(cur.trim());
        }
        cur = "";
        piped = false;
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            if (!piped) {
                cur += ch;
            }
            continue;
        }
        if (ch === "\n" || ch === ";" || ((ch === "&" || ch === "|") && command[i + 1] === ch)) {
            if (ch !== "\n" && ch !== ";") {
                i++;
            }
            push();
            continue;
        }
        if (ch === "|") {
            piped = true;
            continue;
        }
        if ((ch === '"' || ch === "'") && !piped) {
            quote = ch;
        }
        if (!piped) {
            cur += ch;
        }
    }
    push();
    return segments;
}

const CD_COMMANDS = new Set(["cd", "set-location", "sl", "pushd", "chdir"]);

/** Returns normalized file paths read by a shell file-read command; [] if none. Best effort. */
export function extractShellReadFiles(command, projectRoot = null) {
    if (typeof command !== "string") {
        return [];
    }
    const files = [];
    let cwd = null;
    for (const segment of splitShellSegments(command)) {
        const tokens = tokenizeCommand(segment);
        if (tokens.length === 0) {
            continue;
        }
        const name = tokens[0].toLowerCase();
        if (CD_COMMANDS.has(name)) {
            const dir = tokens.slice(1).find((t) => !t.startsWith("-"));
            if (dir && !dir.includes("$")) {
                cwd = ABSOLUTE_RE.test(dir) || !cwd ? dir : joinShellPath(cwd, dir);
            }
            continue;
        }
        files.push(...extractSegmentReadFiles(tokens, projectRoot, cwd));
    }
    return files;
}

function extractSegmentReadFiles(tokens, projectRoot, cwd) {
    const name = tokens[0].toLowerCase();
    const valueFlags = READER_VALUE_FLAGS[name];
    if (!valueFlags) {
        return [];
    }
    const isGc = name === "get-content" || name === "gc";
    const out = [];
    let scriptPending = name === "sed";
    let sedN = false;
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        const lower = t.toLowerCase();
        if (isGc && PATH_FLAGS.has(lower)) {
            if (tokens[i + 1] !== undefined) {
                out.push(...tokens[++i].split(",").filter(Boolean));
            }
        } else if (t.startsWith("-") && t.length > 1) {
            if (name === "sed" && t === "-n") {
                sedN = true;
            } else if (valueFlags.includes(lower)) {
                i++;
            }
        } else if (scriptPending) {
            scriptPending = false; // sed script/range, not a file
        } else {
            out.push(...(isGc ? t.split(",") : [t]).filter(Boolean));
        }
    }
    if (name === "sed" && !sedN) {
        return [];
    }
    const files = [];
    for (const p of out) {
        if (p.includes("*") || p.includes("$")) {
            continue;
        }
        const n = resolveShellPath(p, projectRoot, cwd);
        if (n) {
            files.push(n);
        }
    }
    return files;
}
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const SIMPLE_DISCOVERY_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function isEntrypoint() {
    const invoked = process.argv[1];
    if (!invoked) {
        return false;
    }
    const invokedUrl = invoked.replaceAll("\\", "/");
    const self = import.meta.url.replaceAll("\\", "/");
    return self.endsWith(invokedUrl) || self.endsWith(`/${invokedUrl.split("/").pop()}`);
}

export function normalizePath(filePath, projectRoot = null) {
    if (typeof filePath !== "string" || filePath.length === 0) {
        return null;
    }
    let p = filePath.replaceAll("\\", "/");
    p = p.replace(/^\/([A-Za-z])\//, (_m, d) => `${d}:/`); // Git Bash "/c/x" -> "c:/x"
    p = p.replace(/^([A-Za-z]):/, (_m, d) => `${d.toLowerCase()}:`);
    if (projectRoot) {
        let root = projectRoot.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_m, d) => `${d.toLowerCase()}:`);
        root = root.replace(/\/+$/, "");
        if (root && (p === root || p.toLowerCase().startsWith(`${root.toLowerCase()}/`))) {
            p = p.slice(root.length).replace(/^\/+/, "");
        }
    }
    return p;
}

export function categorizeToolUse(block) {
    const name = block.name;
    if (typeof name !== "string") {
        return null;
    }
    if (SIMPLE_DISCOVERY_TOOLS.has(name)) {
        return name;
    }
    if (SHELL_TOOLS.has(name)) {
        const command = block.input?.command;
        if (typeof command === "string" && splitShellSegments(command).some((s) => BASH_DISCOVERY_RE.test(s))) {
            return name;
        }
        return null;
    }
    if (name === "Agent" || name === "Task") {
        const sub = block.input?.subagent_type;
        if (typeof sub === "string" && (sub.toLowerCase().includes("explorer") || sub === "Explore")) {
            return "ExploreAgent";
        }
    }
    return null;
}

function readFilesOf(block, projectRoot) {
    if (block.name === "Read") {
        const f = normalizePath(block.input?.file_path, projectRoot);
        return f ? [f] : [];
    }
    if (SHELL_TOOLS.has(block.name)) {
        return extractShellReadFiles(block.input?.command, projectRoot);
    }
    return [];
}

function isEditLike(name) {
    return (
        typeof name === "string" &&
        (EDIT_TOOLS.has(name) || name.endsWith("delegate_antigravity") || name.endsWith("delegate_cursor"))
    );
}

export function analyzeSession(rawText, { projectRoot = null } = {}) {
    const lines = parseSessionTranscript(rawText).filter((l) => l.isSidechain !== true);
    const usage = collectClaudeUsage(rawText);

    let firstMs = Infinity;
    let firstTimestamp = null;
    let lastMs = -Infinity;
    let lastTimestamp = null;
    for (const l of lines) {
        const ms = typeof l.timestamp === "string" ? Date.parse(l.timestamp) : NaN;
        if (Number.isFinite(ms)) {
            if (ms < firstMs) {
                firstMs = ms;
                firstTimestamp = l.timestamp;
            }
            if (ms > lastMs) {
                lastMs = ms;
                lastTimestamp = l.timestamp;
            }
        }
    }

    const calls = []; // discovery calls in order
    const resultChars = new Map();
    const seenIds = new Set();
    let editSeen = false;

    for (const l of lines) {
        const content = l.message?.content;
        if (!Array.isArray(content)) {
            continue;
        }
        for (const block of content) {
            if (!block || typeof block !== "object") {
                continue;
            }
            if (l.type === "assistant" && block.type === "tool_use") {
                if (block.id) {
                    if (seenIds.has(block.id)) {
                        continue;
                    }
                    seenIds.add(block.id);
                }
                if (isEditLike(block.name)) {
                    editSeen = true;
                    continue;
                }
                const category = categorizeToolUse(block);
                if (category) {
                    calls.push({
                        id: block.id ?? null,
                        category,
                        startup: !editSeen,
                        files: readFilesOf(block, projectRoot)
                    });
                }
            } else if (l.type === "user" && block.type === "tool_result" && block.tool_use_id) {
                if (!resultChars.has(block.tool_use_id)) {
                    resultChars.set(block.tool_use_id, extractToolResultText(block.content).length);
                }
            }
        }
    }

    const byCategory = {};
    const startupByCategory = {};
    let chars = 0;
    let startupChars = 0;
    let startupCalls = 0;
    const readChars = new Map(); // path -> chars
    const filesReadVia = { Read: 0, shell: 0 };
    let repeatReadsInSession = 0;
    let repeatReadChars = 0;
    for (const c of calls) {
        const size = c.id ? (resultChars.get(c.id) ?? 0) : 0;
        byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
        chars += size;
        if (c.startup) {
            startupCalls++;
            startupChars += size;
            startupByCategory[c.category] = (startupByCategory[c.category] ?? 0) + 1;
        }
        // Result chars belong to the whole command: attribute them to the first file only.
        c.files.forEach((file, idx) => {
            const fileChars = idx === 0 ? size : 0;
            filesReadVia[c.category === "Read" ? "Read" : "shell"]++;
            if (readChars.has(file)) {
                repeatReadsInSession++;
                repeatReadChars += fileChars;
            }
            readChars.set(file, (readChars.get(file) ?? 0) + fileChars);
        });
    }

    return {
        session: usage.session,
        firstTimestamp,
        lastTimestamp,
        teamLead: usage.teamLead,
        discovery: {
            calls: calls.length,
            byCategory,
            resultChars: chars,
            approxTokens: Math.ceil(chars / 4)
        },
        startupDiscovery: {
            calls: startupCalls,
            byCategory: startupByCategory,
            resultChars: startupChars,
            approxTokens: Math.ceil(startupChars / 4)
        },
        filesReadVia,
        repeatReadsInSession,
        repeatReadChars,
        filesRead: [...readChars.keys()].sort(),
        readCharsByFile: Object.fromEntries(readChars)
    };
}

export function analyzeRescans(sessionTexts, options = {}) {
    const analyzed = sessionTexts.map((t) => analyzeSession(t, options));
    analyzed.sort((a, b) => {
        const am = a.firstTimestamp ? Date.parse(a.firstTimestamp) : Infinity;
        const bm = b.firstTimestamp ? Date.parse(b.firstTimestamp) : Infinity;
        return am - bm;
    });

    const seen = new Set();
    const fileSessions = new Map(); // path -> [session ids]
    let rereadChars = 0;
    let totalReads = 0;
    let totalReread = 0;
    const sessions = analyzed.map((s, index) => {
        let reread = 0;
        for (const f of s.filesRead) {
            const list = fileSessions.get(f) ?? [];
            list.push(s.session);
            fileSessions.set(f, list);
            if (seen.has(f)) {
                reread++;
                rereadChars += s.readCharsByFile[f] ?? 0;
            }
        }
        for (const f of s.filesRead) {
            seen.add(f);
        }
        totalReads += s.filesRead.length;
        if (index > 0) {
            totalReread += reread;
        }
        const { readCharsByFile: _drop, ...rest } = s;
        return {
            ...rest,
            rereadRatio: index === 0 ? null : s.filesRead.length === 0 ? null : reread / s.filesRead.length
        };
    });

    const rereadAll = [...fileSessions.entries()]
        .filter(([, ids]) => ids.length >= 2)
        .map(([p, ids]) => ({ path: p, sessions: ids.length }))
        .sort((a, b) => b.sessions - a.sessions || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    return {
        sessions,
        crossSession: {
            totalSessions: sessions.length,
            uniqueFilesRead: fileSessions.size,
            rereadFiles: rereadAll.slice(0, MAX_REREAD_FILES),
            rereadFilesTotal: rereadAll.length,
            overallRereadRatio: totalReads === 0 ? null : totalReread / totalReads,
            rereadChars,
            rereadApproxTokens: Math.ceil(rereadChars / 4)
        }
    };
}

export function parseArgs(argv) {
    const inputs = [];
    let projectRoot = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--project-root") {
            projectRoot = argv[++i] ?? null;
            if (!projectRoot) {
                return null;
            }
        } else if (argv[i]) {
            inputs.push(argv[i]);
        }
    }
    return inputs.length === 0 ? null : { inputs, projectRoot };
}

export function resolveInputFiles(inputs) {
    const files = [];
    for (const input of inputs) {
        if (statSync(input).isDirectory()) {
            for (const entry of readdirSync(input, { withFileTypes: true })) {
                if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
                    files.push(path.join(input, entry.name));
                }
            }
        } else {
            files.push(input);
        }
    }
    return files;
}

export function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv ?? []);
    if (!args) {
        process.stderr.write(`${USAGE_TEXT}\n`);
        process.exitCode = 1;
        return 1;
    }
    let texts;
    try {
        texts = resolveInputFiles(args.inputs).map((f) => readFileSync(f, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Could not read transcripts: ${message}\n${USAGE_TEXT}\n`);
        process.exitCode = 1;
        return 1;
    }
    const result = analyzeRescans(texts, { projectRoot: args.projectRoot });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
}

if (isEntrypoint()) {
    const exitCode = main();
    if (exitCode) {
        process.exitCode = exitCode;
    }
}
