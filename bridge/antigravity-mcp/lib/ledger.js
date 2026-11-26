// Project ledger: durable, immutable, per-repository delegation records under
// <repoRoot>/.aeo/memory/tasks/. Deterministic, no LLM calls, best-effort.
//
// NOTE: this file is duplicated byte-for-byte in bridge/antigravity-mcp/lib and
// bridge/cursor-mcp/lib (enforced by cursor-mcp/test/worktree-sync.test.js).
// Only `node:` imports are allowed; the caller passes repoRoot.

import crypto from "node:crypto";
import { link, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const MEMORY_MODES = ["auto", "on", "off"];
export const DEFAULT_MAX_RECORDS = 300;
export const MAX_RECORD_BYTES = 8 * 1024;
export const CONTRACT_EXCERPT_CHARS = 600;
export const SUMMARY_EXCERPT_CHARS = 1200;
export const MAX_DIFFSTAT_LINES = 40;
export const MAX_BASELINE_LINES = 40;
export const BASELINE_HEADING = "## Baseline (git status --short before the run)";
const MAX_NAME_ATTEMPTS = 5;
const RECORD_NAME = /^\d{8}T\d{9}Z-(delegation|apply)-[^/\\]+\.md$/;

let memoryModeWarned = false;
let maxRecordsWarned = false;

/** AEO_MEMORY: auto (default) | on | off. Invalid -> auto with a one-time warning. */
export function resolveMemoryMode(env = process.env) {
    const raw = env?.AEO_MEMORY;
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
        return "auto";
    }
    const value = String(raw).trim().toLowerCase();
    if (MEMORY_MODES.includes(value)) {
        return value;
    }
    if (!memoryModeWarned) {
        memoryModeWarned = true;
        console.error(`Invalid AEO_MEMORY "${raw}". Falling back to auto.`);
    }
    return "auto";
}

/** AEO_MEMORY_MAX_RECORDS: positive integer, default 300. Invalid -> default with a one-time warning. */
export function resolveMaxRecords(env = process.env) {
    const raw = env?.AEO_MEMORY_MAX_RECORDS;
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
        return DEFAULT_MAX_RECORDS;
    }
    const trimmed = String(raw).trim();
    if (/^\d+$/.test(trimmed)) {
        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    if (!maxRecordsWarned) {
        maxRecordsWarned = true;
        console.error(
            `Invalid AEO_MEMORY_MAX_RECORDS "${raw}". Falling back to ${DEFAULT_MAX_RECORDS}.`
        );
    }
    return DEFAULT_MAX_RECORDS;
}

/** Replace well-known secret shapes with [REDACTED]. */
export function redactSecrets(text) {
    if (typeof text !== "string" || !text) {
        return "";
    }
    return text
        .replace(
            /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
            "[REDACTED]"
        )
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
        .replace(/\bctx7sk[A-Za-z0-9_-]*/g, "[REDACTED]")
        .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
        .replace(
            /\b((?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*)(?!\[REDACTED\])\S+/gi,
            "$1[REDACTED]"
        );
}

function pad(value, width) {
    return String(value).padStart(width, "0");
}

function compactTimestamp(date) {
    return (
        `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}` +
        `T${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}` +
        `${pad(date.getUTCMilliseconds(), 3)}Z`
    );
}

function comparable(p) {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(child, parent) {
    const c = comparable(child);
    const p = comparable(parent);
    return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function oneLine(value) {
    return String(value).replace(/[\r\n]+/g, " ").trim();
}

function frontMatterValue(value) {
    if (Array.isArray(value)) {
        return oneLine(value.join(", "));
    }
    return oneLine(value);
}

function excerpt(text, limit) {
    if (typeof text !== "string") {
        return "";
    }
    const trimmed = text.trim();
    const cut = trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
    return redactSecrets(cut);
}

function isPresent(value) {
    return value !== undefined && value !== null && value !== "";
}

/** Build the record text (front matter + body), capped at MAX_RECORD_BYTES. */
export function buildRecordContent(record, createdDate, runRef) {
    const contract = typeof record.contract === "string" ? record.contract : "";
    const fields = [
        ["schema", "1"],
        ["kind", "delegation"],
        ["engineer", record.engineer ?? "antigravity"],
        ["outcome", record.outcome ?? "unknown"],
        ["model", isPresent(record.model) ? record.model : "default"]
    ];
    if (isPresent(record.attempts) && (!Array.isArray(record.attempts) || record.attempts.length)) {
        fields.push(["attempts", record.attempts]);
    }
    fields.push(
        ["isolation", record.isolation ?? "none"],
        ["delegation_id", isPresent(record.delegationId) ? record.delegationId : "-"],
        ["revision", record.revision ? "true" : "false"],
        ["run_id", isPresent(record.runId) ? record.runId : runRef],
        ["report_path", isPresent(record.reportPath) ? record.reportPath : "-"]
    );
    if (isPresent(record.baseCommit)) {
        fields.push(["base_commit", record.baseCommit]);
    }
    const baselineLines = typeof record.baseline === "string"
        ? record.baseline.split(/\r?\n/).filter((l) => l.trim() !== "")
        : null;
    if (baselineLines) {
        fields.push(["baseline_lines", baselineLines.length]);
    }
    fields.push(
        ["duration_seconds", isPresent(record.durationSeconds) ? record.durationSeconds : "-"],
        ["turns", isPresent(record.turns) ? record.turns : "-"],
        ["contract_sha256", crypto.createHash("sha256").update(contract).digest("hex")],
        ["contract_chars", contract.length],
        ["created", createdDate.toISOString()]
    );

    const head = ["---", ...fields.map(([k, v]) => `${k}: ${frontMatterValue(v)}`), "---", ""].join("\n");

    const sections = [];
    if (baselineLines) {
        const shown = baselineLines.slice(0, MAX_BASELINE_LINES);
        const more = baselineLines.length - shown.length;
        const lines = shown.length ? shown : ["(clean)"];
        if (more > 0) {
            lines.push(`... (${more} more)`);
        }
        sections.push(`${BASELINE_HEADING}\n\n\`\`\`text\n${lines.join("\n")}\n\`\`\`\n`);
    }
    const contractExcerpt = excerpt(contract, CONTRACT_EXCERPT_CHARS);
    if (contractExcerpt) {
        sections.push(`## Contract (excerpt)\n\n${contractExcerpt}\n`);
    }
    const summaryExcerpt = excerpt(record.response, SUMMARY_EXCERPT_CHARS);
    if (summaryExcerpt) {
        sections.push(`## Engineer summary (excerpt)\n\n${summaryExcerpt}\n`);
    }
    if (typeof record.diffstat === "string" && record.diffstat.trim()) {
        const lines = record.diffstat.trim().split(/\r?\n/).slice(0, MAX_DIFFSTAT_LINES);
        sections.push(`## Diffstat\n\n${lines.join("\n")}\n`);
    }

    let body = sections.length ? `\n${sections.join("\n")}` : "";
    let content = head + body;
    if (Buffer.byteLength(content, "utf8") > MAX_RECORD_BYTES) {
        const marker = "\n[truncated]\n";
        let budget = MAX_RECORD_BYTES - Buffer.byteLength(head + marker, "utf8");
        body = body.slice(0, Math.max(0, budget));
        while (Buffer.byteLength(head + body + marker, "utf8") > MAX_RECORD_BYTES && body.length > 0) {
            body = body.slice(0, Math.max(0, body.length - 64));
        }
        content = head + body + marker;
    }
    return content;
}

async function pruneRecords(tasksDir, max) {
    try {
        const names = (await readdir(tasksDir)).filter((n) => RECORD_NAME.test(n)).sort();
        const excess = names.length - max;
        for (let i = 0; i < excess; i++) {
            try {
                await unlink(path.join(tasksDir, names[i]));
            } catch {
                // ignore delete errors
            }
        }
    } catch {
        // ignore prune errors
    }
}

/**
 * Write one immutable delegation record. Never throws.
 * @returns {Promise<{written:true, relativePath:string}|{written:false, reason:string}>}
 */
async function writeRecord({
    kind = "delegation",
    repoRoot,
    worktreeRoot,
    worktreeRoots,
    env = process.env,
    record = {},
    now = () => new Date(),
    randomBytes = crypto.randomBytes
} = {}) {
    try {
        const mode = resolveMemoryMode(env);
        if (mode === "off") {
            return { written: false, reason: "memory disabled (AEO_MEMORY=off)" };
        }
        if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
            return { written: false, reason: "no repository root" };
        }

        const memoryDir = path.join(path.resolve(repoRoot), ".aeo", "memory");
        const guardRoots = [worktreeRoot, ...(Array.isArray(worktreeRoots) ? worktreeRoots : [])];
        for (const root of guardRoots) {
            if (typeof root === "string" && root && isInside(memoryDir, root)) {
                return { written: false, reason: "memory directory resolves inside the worktree" };
            }
        }

        if (mode === "auto") {
            let info = null;
            try {
                info = await stat(memoryDir);
            } catch {
                info = null;
            }
            if (!info || !info.isDirectory()) {
                return { written: false, reason: "memory directory does not exist (auto mode)" };
            }
        }

        const tasksDir = path.join(memoryDir, "tasks");
        await mkdir(tasksDir, { recursive: true });

        const gitignorePath = path.join(memoryDir, ".gitignore");
        try {
            await writeFile(gitignorePath, "*\n", { encoding: "utf8", flag: "wx" });
        } catch (error) {
            if (error?.code !== "EEXIST") {
                throw error;
            }
        }

        const created = typeof now === "function" ? now() : now;
        const createdDate = created instanceof Date ? created : new Date(created);
        const stamp = compactTimestamp(createdDate);
        const runIdText = isPresent(record.runId) ? String(record.runId) : "";
        const runSuffix = runIdText.split("-").pop() ?? "";
        const hexPrefix = /^[0-9a-f]+$/i.test(runSuffix) ? runSuffix.slice(0, 8).toLowerCase() : "";
        const runRef = `r${hexPrefix || randomBytes(4).toString("hex")}`;
        let ref = isPresent(record.delegationId) ? String(record.delegationId) : runRef;
        let content;
        if (kind === "apply") {
            content = buildEventContent(record, createdDate);
        } else if (kind === "decision") {
            ref = sanitizeSlug(record.task) || "task";
            content = buildDecisionContent(record, createdDate);
        } else {
            content = buildRecordContent(record, createdDate, runRef);
        }

        for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
            const nonce = randomBytes(2).toString("hex");
            const fileName = `${stamp}-${kind}-${ref}-${nonce}.md`;
            const finalPath = path.join(tasksDir, fileName);
            const tmpPath = path.join(tasksDir, `.tmp-${randomBytes(4).toString("hex")}-${nonce}`);
            await writeFile(tmpPath, content, { encoding: "utf8", flag: "wx" });
            try {
                try {
                    await link(tmpPath, finalPath);
                } catch (error) {
                    if (error?.code === "EEXIST") {
                        continue;
                    }
                    // Hard links unsupported: fall back to rename (re-check existence first).
                    let exists = true;
                    try {
                        await stat(finalPath);
                    } catch {
                        exists = false;
                    }
                    if (exists) {
                        continue;
                    }
                    await rename(tmpPath, finalPath);
                }
            } finally {
                try {
                    await unlink(tmpPath);
                } catch {
                    // already renamed or removed
                }
            }

            await pruneRecords(tasksDir, resolveMaxRecords(env));
            return {
                written: true,
                relativePath: [".aeo", "memory", "tasks", fileName].join("/")
            };
        }
        return { written: false, reason: "could not find a free record file name" };
    } catch (error) {
        return {
            written: false,
            reason: error instanceof Error ? error.message : String(error)
        };
    }
}


/** Build an apply/discard event record (front matter + optional diffstat body). */
export function buildEventContent(record, createdDate) {
    const fields = [
        ["schema", "1"],
        ["kind", "apply"],
        ["engineer", record.engineer ?? "antigravity"],
        ["delegation_id", isPresent(record.delegationId) ? record.delegationId : "-"],
        ["outcome", record.outcome ?? "unknown"]
    ];
    if (isPresent(record.baseCommit)) {
        fields.push(["base_commit", record.baseCommit]);
    }
    fields.push(["created", createdDate.toISOString()]);
    const head = [
        "---",
        ...fields.map(([k, v]) => `${k}: ${frontMatterValue(v)}`),
        "---",
        ""
    ].join("\n");
    if (record.outcome === "applied" && typeof record.diffstat === "string" && record.diffstat.trim()) {
        const lines = record.diffstat.trim().split(/\r?\n/).slice(0, MAX_DIFFSTAT_LINES);
        return `${head}\n## Diffstat\n\n${lines.join("\n")}\n`;
    }
    return head;
}

/**
 * Write one immutable apply/discard event record (kind: apply). Never throws.
 * @returns {Promise<{written:true, relativePath:string}|{written:false, reason:string}>}
 */
export async function writeEventRecord(options = {}) {
    return writeRecord({ ...options, kind: "apply" });
}

/** True when a record write would happen: mode on, or mode auto with an existing memory dir. */
export async function memoryWillWrite(repoRoot, env = process.env) {
    const mode = resolveMemoryMode(env);
    if (mode === "off" || typeof repoRoot !== "string" || repoRoot.trim() === "") {
        return false;
    }
    if (mode === "on") {
        return true;
    }
    try {
        return (await stat(path.join(path.resolve(repoRoot), ".aeo", "memory"))).isDirectory();
    } catch {
        return false;
    }
}

/** `git status --short` output without ledger paths; "" for a clean tree. */
export function filterBaseline(statusText) {
    if (typeof statusText !== "string") {
        return "";
    }
    return statusText
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line !== "")
        .filter((line) => !line.slice(3).replace(/^"/, "").startsWith(".aeo/memory/"))
        .join("\n");
}

/** Write one immutable delegation record. Never throws. */
export async function writeDelegationRecord(options = {}) {
    return writeRecord({ ...options, kind: "delegation" });
}

export const DECISIONS = ["APPROVED", "CHANGES_REQUIRED"];
const MAX_SLUG_CHARS = 40;
export const MAX_DECISION_SUMMARY_CHARS = 300;
export const MAX_DECISION_DELEGATIONS = 20;
const MAX_DELEGATION_REF_CHARS = 80;

/** Lowercase [a-z0-9-] slug, at most 40 characters, no leading/trailing dashes. */
export function sanitizeSlug(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_SLUG_CHARS)
        .replace(/-+$/g, "");
}

/** Build a Team Lead decision record (front matter + optional findings). */
export function buildDecisionContent(record, createdDate) {
    const delegations = Array.isArray(record.delegations)
        ? record.delegations
            .filter((d) => isPresent(d))
            .slice(0, MAX_DECISION_DELEGATIONS)
            .map((d) => redactSecrets(oneLine(d)).replace(/,/g, " ").slice(0, MAX_DELEGATION_REF_CHARS))
        : [];
    const summary = isPresent(record.summary)
        ? excerpt(oneLine(record.summary), MAX_DECISION_SUMMARY_CHARS)
        : "";
    const fields = [
        ["schema", "1"],
        ["kind", "decision"],
        ["task", sanitizeSlug(record.task) || "task"],
        ["decision", record.decision ?? "unknown"],
        ["delegations", delegations.length ? delegations : "-"],
        ["summary", summary || "-"],
        ["created", createdDate.toISOString()]
    ];
    const head = ["---", ...fields.map(([k, v]) => `${k}: ${frontMatterValue(v)}`), "---", ""].join("\n");
    let content = head;
    if (isPresent(record.findings) && String(record.findings).trim()) {
        content = `${head}\n## Findings\n\n${redactSecrets(String(record.findings).trim())}\n`;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_RECORD_BYTES) {
        const marker = "\n[truncated]\n";
        let body = content.slice(head.length);
        while (Buffer.byteLength(head + body + marker, "utf8") > MAX_RECORD_BYTES && body.length > 0) {
            body = body.slice(0, Math.max(0, body.length - 64));
        }
        content = head + body + marker;
    }
    return content;
}

/** Write one immutable Team Lead decision record (kind: decision; never pruned). Never throws. */
export async function writeDecisionRecord(options = {}) {
    return writeRecord({ ...options, kind: "decision" });
}

/** Parse flat `key: value` front matter between the first two `---` lines. Returns null when absent. */
export function parseFrontMatter(text) {
    if (typeof text !== "string") {
        return null;
    }
    const lines = text.split(/\r?\n/);
    if (lines[0] !== "---") {
        return null;
    }
    const fields = {};
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === "---") {
            return fields;
        }
        const match = /^([A-Za-z0-9_]+):\s?(.*)$/.exec(lines[i]);
        if (match) {
            fields[match[1]] = match[2];
        }
    }
    return null;
}

/** Compact per-file +/- summary of a unified git patch, excluding .aeo/memory. */
export function summarizePatch(patchText) {
    if (typeof patchText !== "string" || !patchText) {
        return "";
    }
    const files = [];
    let current = null;
    let inHunk = false;
    for (const line of patchText.split(/\r?\n/)) {
        const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        if (header) {
            current = { name: header[2], add: 0, del: 0, binary: false };
            files.push(current);
            inHunk = false;
            continue;
        }
        if (!current) {
            continue;
        }
        if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
            current.binary = true;
            inHunk = false;
        } else if (line.startsWith("@@")) {
            inHunk = true;
        } else if (inHunk && line.startsWith("+")) {
            current.add++;
        } else if (inHunk && line.startsWith("-")) {
            current.del++;
        }
    }
    return files
        .filter((f) => !f.name.startsWith(".aeo/memory/"))
        .map((f) => (f.binary ? `${f.name} | binary` : `${f.name} | +${f.add} -${f.del}`))
        .join("\n");
}

const INTEGRITY_NAMES = ["INDEX.md", "docs.md", ".gitignore"];

/** Fingerprint the engineer-forbidden ledger files (not tasks/). Returns null without a repo root. */
export async function fingerprintMemory(repoRoot) {
    if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
        return null;
    }
    const result = {};
    for (const name of INTEGRITY_NAMES) {
        try {
            const info = await stat(path.join(path.resolve(repoRoot), ".aeo", "memory", name));
            result[name] = `${info.size}:${info.mtimeMs}`;
        } catch {
            result[name] = "missing";
        }
    }
    return result;
}

/** Names whose fingerprint differs between two snapshots. */
export function changedMemoryNames(before, after) {
    if (!before || !after) {
        return [];
    }
    return INTEGRITY_NAMES.filter((name) => before[name] !== after[name]);
}
