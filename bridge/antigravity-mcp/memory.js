#!/usr/bin/env node
/**
 * Project ledger CLI for the Team Lead.
 *
 *   node memory.js init     [--repo <path>]
 *   node memory.js decide   --task <slug> --decision APPROVED|CHANGES_REQUIRED
 *                           [--delegations <a,b>] [--summary "<line>"] [--findings "<text>"] [--repo <path>]
 *   node memory.js reindex  [--repo <path>]
 *   node memory.js status   [--repo <path>]
 *
 * Node 20+. ESM. Zero package dependencies. Deterministic, no network, no LLM calls.
 * The bridge writes delegation/apply records; this CLI writes decision records and
 * regenerates only the recent-tasks block of INDEX.md.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
    BASELINE_HEADING,
    DECISIONS,
    parseFrontMatter,
    resolveMemoryMode,
    sanitizeSlug,
    writeDecisionRecord
} from "./lib/ledger.js";

export const USAGE_TEXT = [
    "Usage:",
    "  node memory.js init    [--seed] [--repo <path>]",
    "  node memory.js seed    [--repo <path>]   (fill empty Modules / Test commands from git)",
    "  node memory.js decide  --task <slug> --decision APPROVED|CHANGES_REQUIRED",
    "                         [--delegations <a,b>] [--summary \"<line>\"] [--findings \"<text>\"] [--repo <path>]",
    "  node memory.js reindex [--repo <path>]",
    "  node memory.js status  [--repo <path>]",
    "  node memory.js context [--source <s>] [--repo <path>]",
    "  node memory.js verify  --section <heading> [--paths <a,b>] [--repo <path>]",
    "  node memory.js freshness [--repo <path>]",
    "  node memory.js docs check [--repo <path>]",
    "  node memory.js docs set --library <name> --ecosystem <eco> --source <src>",
    "                         [--notes <text>] [--version <v>] [--repo <path>]",
    "  node memory.js hook session-start   (reads the hook JSON from stdin)"
].join("\n");

export const RECENT_START = "<!-- aeo:recent-tasks:start -->";
export const RECENT_END = "<!-- aeo:recent-tasks:end -->";
export const RECENT_LIMIT = 8;
export const RECENT_LINE_CHARS = 160;
export const INDEX_WARN_CHARS = 6000;
export const LOCK_STALE_MS = 60_000;

export const INDEX_SKELETON = [
    "# Project index",
    "",
    "Sections outside the generated block are hand-written; memory.js only fills empty Modules and Test commands sections when seeded.",
    "",
    "## Modules",
    "<!-- verified: none -->",
    "",
    "## Conventions",
    "<!-- verified: none -->",
    "",
    "## Test commands",
    "<!-- verified: none -->",
    "",
    "## Open decisions",
    "<!-- verified: none -->",
    "",
    "## Recent tasks",
    "",
    RECENT_START,
    "- (no decisions recorded yet)",
    RECENT_END,
    ""
].join("\n");

export const DOCS_SKELETON = [
    "# Dependency docs registry",
    "",
    "Each source must match the version in the lockfile; prefer the installed package source, then versioned official docs.",
    "",
    "| library | ecosystem | version | source | verified | notes |",
    "| --- | --- | --- | --- | --- | --- |",
    ""
].join("\n");

const VALUE_FLAGS = new Set([
    "repo", "task", "decision", "delegations", "summary", "findings", "source",
    "library", "ecosystem", "notes", "version", "section", "paths"
]);
const BOOL_FLAGS = new Set(["seed"]);

export function parseArgs(argv) {
    const args = { command: null, flags: {}, errors: [] };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (typeof token !== "string") {
            continue;
        }
        if (token.startsWith("--")) {
            const eq = token.indexOf("=");
            const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
            if (BOOL_FLAGS.has(name) && eq === -1) {
                args.flags[name] = true;
                continue;
            }
            if (!VALUE_FLAGS.has(name)) {
                args.errors.push(`Unknown option --${name}`);
                continue;
            }
            const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
            if (value === undefined) {
                args.errors.push(`Option --${name} needs a value`);
                continue;
            }
            args.flags[name] = value;
        } else if (args.command === null) {
            args.command = token;
        } else {
            args.errors.push(`Unexpected argument ${token}`);
        }
    }
    return args;
}

export function gitTopLevel(cwd) {
    try {
        const res = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
        if (res.status === 0 && typeof res.stdout === "string" && res.stdout.trim()) {
            return path.resolve(res.stdout.trim());
        }
    } catch {
        // fall through
    }
    return null;
}

function memoryPaths(repoRoot) {
    const dir = path.join(repoRoot, ".aeo", "memory");
    return {
        dir,
        tasks: path.join(dir, "tasks"),
        index: path.join(dir, "INDEX.md"),
        docs: path.join(dir, "docs.md"),
        gitignore: path.join(dir, ".gitignore"),
        lock: path.join(dir, ".lock")
    };
}

async function isDirectory(target) {
    try {
        return (await stat(target)).isDirectory();
    } catch {
        return false;
    }
}

async function createIfAbsent(file, content) {
    try {
        await writeFile(file, content, { encoding: "utf8", flag: "wx" });
        return true;
    } catch (error) {
        if (error?.code === "EEXIST") {
            return false;
        }
        throw error;
    }
}

export async function initMemory(repoRoot) {
    const p = memoryPaths(repoRoot);
    await mkdir(p.tasks, { recursive: true });
    const created = [];
    const kept = [];
    for (const [file, content] of [
        [p.gitignore, "*\n"],
        [p.index, INDEX_SKELETON],
        [p.docs, DOCS_SKELETON]
    ]) {
        (await createIfAbsent(file, content) ? created : kept).push(path.basename(file));
    }
    return { created, kept, dir: p.dir };
}

/** Read every valid decision record, newest first. */
export async function readDecisions(repoRoot) {
    const p = memoryPaths(repoRoot);
    let names = [];
    try {
        names = await readdir(p.tasks);
    } catch {
        return [];
    }
    const decisions = [];
    for (const name of names.filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort().reverse()) {
        let text;
        try {
            text = await readFile(path.join(p.tasks, name), "utf8");
        } catch {
            continue;
        }
        const fields = parseFrontMatter(text);
        if (!fields || fields.schema !== "1" || fields.kind !== "decision") {
            continue;
        }
        decisions.push({ ...fields, stem: name.slice(0, -3) });
    }
    return decisions;
}

export async function countRecords(repoRoot) {
    const p = memoryPaths(repoRoot);
    const counts = {};
    let names = [];
    try {
        names = await readdir(p.tasks);
    } catch {
        return counts;
    }
    for (const name of names.filter((n) => n.endsWith(".md") && !n.startsWith("."))) {
        try {
            const fields = parseFrontMatter(await readFile(path.join(p.tasks, name), "utf8"));
            if (fields && fields.schema === "1" && fields.kind) {
                counts[fields.kind] = (counts[fields.kind] ?? 0) + 1;
            }
        } catch {
            // unreadable record: skip
        }
    }
    return counts;
}

/** Remove HTML comment delimiters so record text can never forge a block marker. */
function inert(value) {
    return String(value ?? "").replace(/<!--|-->/g, "").replace(/[\r\n]+/g, " ");
}

export function formatRecentLine(decision) {
    const date = typeof decision.created === "string" ? inert(decision.created.slice(0, 10)) : "????-??-??";
    const delegations = !decision.delegations || decision.delegations === "-"
        ? 0
        : decision.delegations.split(",").map((d) => d.trim()).filter(Boolean).length;
    const noun = delegations === 1 ? "delegation" : "delegations";
    const base = `- ${date} ${inert(decision.task ?? "task")} — ${inert(decision.decision ?? "unknown")} (${delegations} ${noun}) [${inert(decision.stem)}]`;
    const summary = decision.summary && decision.summary !== "-" ? `: ${inert(decision.summary)}` : "";
    if (summary && base.length + summary.length <= RECENT_LINE_CHARS) {
        return base + summary;
    }
    return base.length <= RECENT_LINE_CHARS ? base : `${base.slice(0, RECENT_LINE_CHARS - 3)}...`;
}

/** Offsets of a marker that stands alone on its own line (ignores markers embedded in text). */
function findMarkerLines(text, marker) {
    const offsets = [];
    let from = 0;
    while (true) {
        const at = text.indexOf(marker, from);
        if (at === -1) {
            return offsets;
        }
        const startsLine = at === 0 || text[at - 1] === "\n";
        const after = text.slice(at + marker.length, at + marker.length + 2);
        const endsLine = after === "" || after.startsWith("\n") || after === "\r\n";
        if (startsLine && endsLine) {
            offsets.push(at);
        }
        from = at + marker.length;
    }
}

/**
 * Replace the recent-tasks block; bytes outside the markers are preserved exactly.
 * Appends a block only when neither marker exists; throws on a damaged pair so a
 * later run can never swallow hand-written text.
 */
export function renderIndex(indexText, lines) {
    const eol = indexText.includes("\r\n") ? "\r\n" : "\n";
    const block = (lines.length ? lines : ["- (no decisions recorded yet)"]).join(eol);
    const starts = findMarkerLines(indexText, RECENT_START);
    const ends = findMarkerLines(indexText, RECENT_END);
    if (starts.length === 0 && ends.length === 0) {
        const separator = indexText.length === 0 || indexText.endsWith("\n") ? "" : eol;
        return `${indexText}${separator}${eol}## Recent tasks${eol}${eol}${RECENT_START}${eol}${block}${eol}${RECENT_END}${eol}`;
    }
    if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
        throw new Error(
            `INDEX.md has a damaged recent-tasks block (${starts.length} start, ${ends.length} end marker lines). ` +
            `Repair it so "${RECENT_START}" and "${RECENT_END}" each appear once, in order, on their own lines.`
        );
    }
    const start = starts[0];
    const end = ends[0];
    return `${indexText.slice(0, start + RECENT_START.length)}${eol}${block}${eol}${indexText.slice(end)}`;
}

const LOCKED_MESSAGE = (lockDir) => `INDEX.md is locked by another memory.js run (${lockDir}); retry shortly.`;

async function readOwner(lockDir) {
    try {
        return await readFile(path.join(lockDir, "owner"), "utf8");
    } catch {
        return null;
    }
}

/**
 * Take the INDEX.md lock: an exclusive directory holding an owner token. A lock
 * older than staleMs is taken over only if its owner token is unchanged since it
 * was judged stale, so two takers cannot both win silently.
 */
async function acquireLock(lockDir, { now, staleMs }) {
    const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await mkdir(lockDir);
            await writeFile(path.join(lockDir, "owner"), token, "utf8");
            return token;
        } catch (error) {
            if (error?.code !== "EEXIST") {
                throw error;
            }
            let age = 0;
            try {
                age = now() - (await stat(lockDir)).mtimeMs;
            } catch {
                continue; // lock vanished between mkdir and stat: retry
            }
            if (age <= staleMs || attempt > 0) {
                throw new Error(LOCKED_MESSAGE(lockDir));
            }
            const staleOwner = await readOwner(lockDir);
            // Re-check right before removal: if someone else took over meanwhile, back off.
            if ((await readOwner(lockDir)) !== staleOwner) {
                throw new Error(LOCKED_MESSAGE(lockDir));
            }
            await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        }
    }
    throw new Error(LOCKED_MESSAGE(lockDir));
}

/** Release only a lock this run still owns (a takeover after a stall must not be undone). */
async function releaseLock(lockDir, token) {
    if ((await readOwner(lockDir)) === token) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** rename with a short backoff for Windows sharing violations (editor, antivirus, indexer). */
export async function renameWithRetry(from, to, { renameImpl = rename, attempts = 5, delayMs = 50 } = {}) {
    for (let i = 0; ; i++) {
        try {
            return await renameImpl(from, to);
        } catch (error) {
            if (!RENAME_RETRY_CODES.has(error?.code) || i >= attempts - 1) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
        }
    }
}

export async function reindex(repoRoot, { now = () => Date.now(), staleMs = LOCK_STALE_MS, renameImpl } = {}) {
    const p = memoryPaths(repoRoot);
    if (!(await isDirectory(p.dir))) {
        throw new Error(`No project memory at ${p.dir}. Run "memory.js init" first.`);
    }
    const token = await acquireLock(p.lock, { now, staleMs });
    try {
        let indexText;
        try {
            indexText = await readFile(p.index, "utf8");
        } catch {
            throw new Error(`No ${p.index}. Run "memory.js init" first.`);
        }
        const decisions = (await readDecisions(repoRoot)).slice(0, RECENT_LIMIT);
        const lines = decisions.map(formatRecentLine);
        const next = renderIndex(indexText, lines);
        if (next !== indexText) {
            const tmp = `${p.index}.tmp-${process.pid}`;
            await writeFile(tmp, next, "utf8");
            try {
                await renameWithRetry(tmp, p.index, renameImpl ? { renameImpl } : {});
            } catch (error) {
                await unlink(tmp).catch(() => {});
                throw error;
            }
        }
        return { changed: next !== indexText, entries: lines.length };
    } finally {
        await releaseLock(p.lock, token);
    }
}

/* ---------- docs registry ---------- */

const DOCS_NOTES_MAX = 200;
const DOCS_CONTEXT_LINES = 10;

/** "npm" | "composer", optional "@<dir>". Returns null for unsupported or unsafe values. */
function parseEcosystem(ecosystem) {
    const raw = String(ecosystem ?? "").trim();
    const at = raw.indexOf("@");
    const kind = (at === -1 ? raw : raw.slice(0, at)).trim();
    if (kind !== "npm" && kind !== "composer") {
        return null;
    }
    let dir = "";
    if (at !== -1) {
        dir = raw.slice(at + 1).trim();
        if (
            !dir ||
            path.isAbsolute(dir) ||
            path.win32.isAbsolute(dir) ||
            path.posix.isAbsolute(dir) ||
            dir.split(/[\\/]+/).includes("..")
        ) {
            return null;
        }
    }
    return { kind, dir };
}

function readJsonFile(file) {
    try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        return data && typeof data === "object" ? data : null;
    } catch {
        return null;
    }
}

/** Map name -> installed version from a lockfile, or null when missing/unparseable/unsupported. */
export function readLockVersions(repoRoot, ecosystem, cache = new Map()) {
    const eco = parseEcosystem(ecosystem);
    if (!eco) {
        return null;
    }
    const file = path.join(repoRoot, eco.dir, eco.kind === "npm" ? "package-lock.json" : "composer.lock");
    if (cache.has(file)) {
        return cache.get(file);
    }
    const data = readJsonFile(file);
    let result = null;
    if (data) {
        result = new Map();
        if (eco.kind === "npm") {
            if (data.packages && typeof data.packages === "object") {
                for (const [key, value] of Object.entries(data.packages)) {
                    if (!key.startsWith("node_modules/") || key.indexOf("node_modules/", 1) !== -1) {
                        continue;
                    }
                    if (value && typeof value.version === "string") {
                        result.set(key.slice("node_modules/".length), value.version);
                    }
                }
            } else if (data.dependencies && typeof data.dependencies === "object") {
                for (const [name, value] of Object.entries(data.dependencies)) {
                    if (value && typeof value.version === "string") {
                        result.set(name, value.version);
                    }
                }
            }
        } else {
            for (const list of [data.packages, data["packages-dev"]]) {
                if (!Array.isArray(list)) {
                    continue;
                }
                for (const item of list) {
                    if (item && typeof item.name === "string" && typeof item.version === "string") {
                        result.set(item.name, item.version);
                    }
                }
            }
        }
    }
    cache.set(file, result);
    return result;
}

function splitCells(line) {
    let body = line.trim();
    body = body.slice(1);
    if (/(^|[^\\])\|$/.test(body)) {
        body = body.slice(0, -1);
    }
    return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Rows of the docs registry table; lineIndex indexes text.split("\n"). */
export function parseDocsRegistry(text) {
    const rows = [];
    const lines = String(text ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, "");
        if (!line.trim().startsWith("|")) {
            continue;
        }
        const cells = splitCells(line);
        if (cells.length < 6) {
            continue;
        }
        const [library, ecosystem, version, source, verified, ...rest] = cells;
        if (!library || library.toLowerCase() === "library" || cells.every((c) => /^:?-{3,}:?$/.test(c))) {
            continue;
        }
        rows.push({ library, ecosystem, version, source, verified, notes: rest.join(" | "), lineIndex: i });
    }
    return rows;
}

const stripV = (v) => String(v ?? "").trim().replace(/^v/, "");

export function checkDocsRegistry(repoRoot) {
    const result = { rows: [], mismatches: [], missing: [], unchecked: [], noLockfile: [], checked: 0 };
    let text = "";
    try {
        text = readFileSync(memoryPaths(repoRoot).docs, "utf8");
    } catch {
        return result;
    }
    result.rows = parseDocsRegistry(text);
    const cache = new Map();
    for (const row of result.rows) {
        const { library, ecosystem } = row;
        if (!parseEcosystem(ecosystem)) {
            result.unchecked.push({ library, ecosystem });
            continue;
        }
        const locks = readLockVersions(repoRoot, ecosystem, cache);
        if (!locks) {
            if (!result.noLockfile.includes(ecosystem)) {
                result.noLockfile.push(ecosystem);
            }
            continue;
        }
        result.checked++;
        if (!locks.has(library)) {
            result.missing.push({ library, ecosystem });
        } else if (stripV(locks.get(library)) !== stripV(row.version)) {
            result.mismatches.push({ library, ecosystem, registry: row.version, lockfile: locks.get(library) });
        }
    }
    return result;
}

const cell = (value, max) => {
    let v = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
    if (max) {
        v = v.slice(0, max);
    }
    return v.replace(/\|/g, "\\|");
};

export async function upsertDocsRow(repoRoot, fields, { now = () => Date.now(), staleMs = LOCK_STALE_MS, renameImpl } = {}) {
    const p = memoryPaths(repoRoot);
    if (!(await isDirectory(p.dir))) {
        throw new Error(`No project memory at ${p.dir}. Run "memory.js init" first.`);
    }
    const library = String(fields.library ?? "").replace(/[\r\n]+/g, " ").trim();
    const ecosystem = String(fields.ecosystem ?? "").replace(/[\r\n]+/g, " ").trim();
    const source = String(fields.source ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!library || !ecosystem || !source) {
        throw new Error("docs set needs --library, --ecosystem and --source.");
    }
    let version = String(fields.version ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!version) {
        version = readLockVersions(repoRoot, ecosystem)?.get(library) ?? "";
    }
    if (!version) {
        throw new Error(`No version for ${library} (${ecosystem}): not in the lockfile; pass --version <v>.`);
    }
    const verified = new Date(now()).toISOString().slice(0, 10);
    const token = await acquireLock(p.lock, { now, staleMs });
    try {
        let text;
        try {
            text = await readFile(p.docs, "utf8");
        } catch {
            text = DOCS_SKELETON;
        }
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        const row = `| ${cell(library)} | ${cell(ecosystem)} | ${cell(version)} | ${cell(source)} | ${verified} | ${cell(fields.notes, DOCS_NOTES_MAX)} |`;
        const existing = parseDocsRegistry(text).find((r) => r.library === library && r.ecosystem === ecosystem);
        let next;
        let action;
        if (existing) {
            const lines = text.split("\n");
            const cr = lines[existing.lineIndex].endsWith("\r") ? "\r" : "";
            lines[existing.lineIndex] = row + cr;
            next = lines.join("\n");
            action = "updated";
        } else {
            const sep = text.length === 0 || text.endsWith("\n") ? "" : eol;
            next = `${text}${sep}${row}${eol}`;
            action = "added";
        }
        const tmp = `${p.docs}.tmp-${process.pid}`;
        await writeFile(tmp, next, "utf8");
        try {
            await renameWithRetry(tmp, p.docs, renameImpl ? { renameImpl } : {});
        } catch (error) {
            await unlink(tmp).catch(() => {});
            throw error;
        }
        return { action, version, verified };
    } finally {
        await releaseLock(p.lock, token);
    }
}

/* ---------- INDEX section freshness ---------- */

const MARKER_RE = /^<!--\s*verified:\s*(\S+)(?:\s+paths:\s*(.*?))?\s*-->\s*$/;
const HEADING_RE = /^##\s+(.+?)\s*$/;
const RECENT_HEADING = "recent tasks";
const FRESHNESS_FILES_SHOWN = 5;
const FRESHNESS_CONTEXT_LINES = 8;

export function defaultGit(args, cwd) {
    try {
        const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 5000 });
        return { status: typeof res.status === "number" ? res.status : -1, stdout: typeof res.stdout === "string" ? res.stdout : "" };
    } catch {
        return { status: -1, stdout: "" };
    }
}

function runGit(git, args, cwd) {
    try {
        const res = git(args, cwd);
        return { status: typeof res?.status === "number" ? res.status : -1, stdout: String(res?.stdout ?? "") };
    } catch {
        return { status: -1, stdout: "" };
    }
}

/** Hand-written sections of INDEX.md with their verified markers. markerLine/headingLine index text.split("\n"). */
export function parseIndexSections(text) {
    const lines = String(text ?? "").split("\n").map((l) => l.replace(/\r$/, ""));
    const sections = [];
    const boundaries = []; // every heading or recent-block start, for section body ends
    let inRecent = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!inRecent && (HEADING_RE.test(line) || line.trim() === RECENT_START)) {
            boundaries.push(i);
        }
        if (line.trim() === RECENT_START) {
            inRecent = true;
            continue;
        }
        if (line.trim() === RECENT_END) {
            inRecent = false;
            continue;
        }
        if (inRecent) {
            continue;
        }
        const m = HEADING_RE.exec(line);
        if (!m || m[1].trim().toLowerCase() === RECENT_HEADING) {
            continue;
        }
        const section = { heading: m[1].trim(), headingLine: i, markerLine: -1, sha: null, paths: [] };
        const mk = i + 1 < lines.length ? MARKER_RE.exec(lines[i + 1]) : null;
        if (mk) {
            section.markerLine = i + 1;
            section.sha = mk[1].toLowerCase() === "none" ? null : mk[1];
            section.paths = (mk[2] ?? "").split(",").map((p) => p.trim()).filter(Boolean);
        }
        sections.push(section);
    }
    for (const s of sections) {
        const start = (s.markerLine === -1 ? s.headingLine : s.markerLine) + 1;
        const end = boundaries.find((b) => b > s.headingLine) ?? lines.length;
        s.bodyEnd = end;
        s.empty = lines.slice(start, end).every((l) => l.trim() === "");
    }
    return sections;
}

const notMemory = (file) => !file.startsWith(".aeo/memory/") && file !== ".aeo/memory";

function unquoteGitPath(p) {
    const t = p.trim();
    return t.length >= 2 && t.startsWith("\"") && t.endsWith("\"") ? t.slice(1, -1) : t;
}

/** Per section freshness. Never throws. */
export function checkFreshness(repoRoot, { git = defaultGit } = {}) {
    let sections = [];
    try {
        sections = parseIndexSections(readFileSync(memoryPaths(repoRoot).index, "utf8"));
    } catch {
        return [];
    }
    const head = runGit(git, ["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
    const hasGit = head.status === 0 && head.stdout.trim() !== "";
    return sections.map((s) => {
        const base = { heading: s.heading, sha: s.sha, paths: s.paths, empty: s.empty };
        try {
            if (!s.sha) {
                return { ...base, status: "unverified" };
            }
            if (!hasGit) {
                return { ...base, status: "no-git" };
            }
            if (!/^[0-9a-fA-F]{4,64}$/.test(s.sha) ||
                runGit(git, ["rev-parse", "--verify", `${s.sha}^{commit}`], repoRoot).status !== 0) {
                return { ...base, status: "unknown-commit" };
            }
            const diff = runGit(git, ["diff", "--name-only", s.sha, "HEAD", "--", ...s.paths], repoRoot);
            const stat = runGit(git, ["status", "--porcelain", "--untracked-files=all", "--", ...s.paths], repoRoot);
            if (diff.status !== 0 || stat.status !== 0) {
                return { ...base, status: "no-git" };
            }
            const files = new Set();
            for (const l of diff.stdout.split(/\r?\n/)) {
                if (l.trim()) {
                    files.add(unquoteGitPath(l));
                }
            }
            for (const l of stat.stdout.split(/\r?\n/)) {
                if (l.length > 3) {
                    const rest = l.slice(3);
                    const arrow = rest.lastIndexOf(" -> ");
                    files.add(unquoteGitPath(arrow === -1 ? rest : rest.slice(arrow + 4)));
                }
            }
            const changedFiles = [...files].filter(notMemory);
            return changedFiles.length
                ? { ...base, status: "stale", changedFiles, total: changedFiles.length }
                : { ...base, status: "fresh" };
        } catch {
            return { ...base, status: "no-git" };
        }
    });
}

const short = (sha) => String(sha ?? "").slice(0, 7);

function freshnessLine(s) {
    switch (s.status) {
        case "stale":
            return `stale: ${s.total} files changed since ${short(s.sha)} (${s.changedFiles.slice(0, FRESHNESS_FILES_SHOWN).join(", ")}${s.total > FRESHNESS_FILES_SHOWN ? ", ..." : ""})`;
        case "unknown-commit":
            return `unknown commit ${short(s.sha)}`;
        case "no-git":
            return "git unavailable";
        default:
            return s.status;
    }
}

function freshnessContextLines(sections) {
    if (sections.length > 0 && sections.every((s) => s.status === "no-git")) {
        return ["INDEX freshness unknown (git unavailable)."];
    }
    const bad = sections.filter((s) => s.status !== "fresh");
    if (bad.length === 0) {
        return ["All verified sections are fresh."];
    }
    return bad.slice(0, FRESHNESS_CONTEXT_LINES).map((s) => {
        const cmd = `memory.js verify --section "${s.heading}"`;
        switch (s.status) {
            case "stale":
                return `- ${s.heading}: stale, ${s.total} files changed since ${short(s.sha)} (${s.changedFiles.slice(0, FRESHNESS_FILES_SHOWN).join(", ")}${s.total > FRESHNESS_FILES_SHOWN ? ", ..." : ""}); rescan only these, then run ${cmd}`;
            case "unknown-commit":
                return `- ${s.heading}: unknown commit ${short(s.sha)}; recheck it against the code, then run ${cmd}`;
            case "no-git":
                return `- ${s.heading}: freshness unknown (git unavailable)`;
            default:
                return s.empty
                    ? `- ${s.heading}: empty; after this task add at most 5 lines from what you learned (entry points, key files, commands), then run node .aeo/bridge/antigravity-mcp/memory.js verify --section "${s.heading}"`
                    : `- ${s.heading}: unverified; verify it after checking it against the code`;
        }
    });
}

function normalizePaths(value) {
    const out = [];
    for (const raw of String(value ?? "").split(",")) {
        const p = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
        if (!p) {
            continue;
        }
        if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || p.split("/").includes("..")) {
            throw new Error(`Invalid path "${raw.trim()}": paths must be repo-relative without "..".`);
        }
        out.push(p);
    }
    return out;
}

/** Set a section's verified marker to the current HEAD. Other bytes are preserved. */
export async function verifySection(repoRoot, { section, paths }, { git = defaultGit, now = () => Date.now(), staleMs = LOCK_STALE_MS, renameImpl } = {}) {
    const p = memoryPaths(repoRoot);
    if (!(await isDirectory(p.dir))) {
        throw new Error(`No project memory at ${p.dir}. Run "memory.js init" first.`);
    }
    const wanted = String(section ?? "").trim();
    if (!wanted) {
        throw new Error("verify needs --section <heading>.");
    }
    if (wanted.toLowerCase() === RECENT_HEADING) {
        throw new Error('"Recent tasks" is generated and has no verified marker.');
    }
    const newPaths = paths === undefined ? null : normalizePaths(paths);
    const headRes = runGit(git, ["rev-parse", "HEAD"], repoRoot);
    const sha = headRes.stdout.trim();
    if (headRes.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(sha)) {
        throw new Error("No git HEAD commit to verify against.");
    }
    const token = await acquireLock(p.lock, { now, staleMs });
    try {
        let text;
        try {
            text = await readFile(p.index, "utf8");
        } catch {
            throw new Error(`No ${p.index}. Run "memory.js init" first.`);
        }
        const sections = parseIndexSections(text);
        const target = sections.find((s) => s.heading.toLowerCase() === wanted.toLowerCase());
        if (!target) {
            throw new Error(`Unknown section "${wanted}". Sections: ${sections.map((s) => s.heading).join(", ") || "(none)"}`);
        }
        const finalPaths = newPaths ?? target.paths;
        const lines = text.split("\n");
        const cr = lines[target.headingLine].endsWith("\r") ? "\r" : "";
        const marker = `<!-- verified: ${sha}${finalPaths.length ? ` paths: ${finalPaths.join(", ")}` : ""} -->${cr}`;
        if (target.markerLine === -1) {
            lines.splice(target.headingLine + 1, 0, marker);
        } else {
            lines[target.markerLine] = marker;
        }
        const next = lines.join("\n");
        if (next !== text) {
            const tmp = `${p.index}.tmp-${process.pid}`;
            await writeFile(tmp, next, "utf8");
            try {
                await renameWithRetry(tmp, p.index, renameImpl ? { renameImpl } : {});
            } catch (error) {
                await unlink(tmp).catch(() => {});
                throw error;
            }
        }
        return { heading: target.heading, sha, paths: finalPaths };
    } finally {
        await releaseLock(p.lock, token);
    }
}

/* ---------- deterministic INDEX seeding ---------- */

export const SEED_MODULE_LINES = 40;
export const SEED_TEST_LINES = 10;

/** Directory map lines from tracked files: "- dir/ (n files)", depth 1-3, pruned to maxLines. */
export function buildModuleLines(files, maxLines = SEED_MODULE_LINES) {
    const counts = new Map();
    for (const f of files) {
        if (!f || f.startsWith(".aeo/")) {
            continue;
        }
        const dirs = f.split("/").slice(0, -1);
        if (dirs.some((d) => d.startsWith("."))) {
            continue;
        }
        for (let depth = 1; depth <= Math.min(3, dirs.length); depth++) {
            const key = dirs.slice(0, depth).join("/");
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    const all = [...counts.keys()];
    let keys = all;
    // Over the limit: keep shallow levels whole, then fill the remaining lines with the
    // largest directories of the next level (deepest level dropped first).
    for (const maxDepth of [2, 1]) {
        if (keys.length <= maxLines) {
            break;
        }
        const shallow = all.filter((k) => k.split("/").length <= maxDepth);
        const next = all
            .filter((k) => k.split("/").length === maxDepth + 1)
            .sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : 1));
        keys = shallow.length <= maxLines ? [...shallow, ...next.slice(0, maxLines - shallow.length)] : shallow;
    }
    const omitted = all.length - Math.min(keys.length, maxLines);
    const lines = keys.sort().slice(0, maxLines).map((k) => `- ${k}/ (${counts.get(k)} files)`);
    if (omitted > 0) {
        lines.push(`- ... (${omitted} more directories)`);
    }
    return lines;
}

/** Test command lines from tracked manifests at depth <= 2. readText(rel) returns file text or null. */
export function buildTestLines(files, readText, maxLines = SEED_TEST_LINES) {
    const tracked = new Set(files);
    const lines = [];
    const used = [];
    const dirOf = (f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".");
    const at = (dir, name) => (dir === "." ? name : `${dir}/${name}`);
    const scriptsOf = (rel) => {
        try {
            const scripts = JSON.parse(readText(rel) ?? "null")?.scripts;
            return scripts && typeof scripts === "object" ? Object.keys(scripts).filter((n) => n.startsWith("test")) : [];
        } catch {
            return [];
        }
    };
    const dirs = [...new Set(files.filter((f) => f.split("/").length <= 2).map(dirOf))].sort();
    for (const dir of dirs) {
        const add = (line, manifest) => {
            lines.push(`- ${dir}: ${line}`);
            if (!used.includes(manifest)) {
                used.push(manifest);
            }
        };
        const pkg = at(dir, "package.json");
        if (tracked.has(pkg)) {
            for (const n of scriptsOf(pkg)) {
                add(n === "test" ? "npm test" : `npm run ${n}`, pkg);
            }
        }
        const composer = at(dir, "composer.json");
        if (tracked.has(composer)) {
            for (const n of scriptsOf(composer)) {
                add(`composer ${n}`, composer);
            }
        }
        if (tracked.has(at(dir, "artisan"))) {
            add("php artisan test", at(dir, "artisan"));
        } else {
            const phpunit = ["phpunit.xml", "phpunit.xml.dist"].map((n) => at(dir, n)).find((f) => tracked.has(f));
            if (phpunit) {
                add("vendor/bin/phpunit", phpunit);
            }
        }
        const pytestIni = at(dir, "pytest.ini");
        const pyproject = at(dir, "pyproject.toml");
        if (tracked.has(pytestIni)) {
            add("pytest", pytestIni);
        } else if (tracked.has(pyproject) && (readText(pyproject) ?? "").includes("[tool.pytest")) {
            add("pytest", pyproject);
        }
    }
    return { lines: lines.slice(0, maxLines), manifests: used };
}

const SEEDABLE = ["modules", "test commands"];

/** Fill empty Modules / Test commands sections from git; other bytes are preserved. */
export async function seedIndex(repoRoot, { git = defaultGit, now = () => Date.now(), staleMs = LOCK_STALE_MS, renameImpl } = {}) {
    const p = memoryPaths(repoRoot);
    if (!(await isDirectory(p.dir))) {
        throw new Error(`No project memory at ${p.dir}. Run "memory.js init" first.`);
    }
    const headRes = runGit(git, ["rev-parse", "HEAD"], repoRoot);
    const sha = headRes.stdout.trim();
    if (headRes.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(sha)) {
        throw new Error("No git HEAD commit to seed from.");
    }
    const ls = runGit(git, ["ls-files", "-z"], repoRoot);
    if (ls.status !== 0) {
        throw new Error("git ls-files failed.");
    }
    const files = ls.stdout.split("\0").filter(Boolean);
    const readText = (rel) => {
        try {
            return readFileSync(path.join(repoRoot, rel), "utf8");
        } catch {
            return null;
        }
    };
    const token = await acquireLock(p.lock, { now, staleMs });
    try {
        let text;
        try {
            text = await readFile(p.index, "utf8");
        } catch {
            throw new Error(`No ${p.index}. Run "memory.js init" first.`);
        }
        const lines = text.split("\n");
        const report = [];
        const edits = [];
        for (const s of parseIndexSections(text)) {
            const key = s.heading.toLowerCase();
            if (!SEEDABLE.includes(key)) {
                report.push(`skipped ${s.heading} (not seedable)`);
                continue;
            }
            if (!s.empty) {
                report.push(`skipped ${s.heading} (not empty)`);
                continue;
            }
            const seeded = key === "modules" ? { lines: buildModuleLines(files), manifests: [] } : buildTestLines(files, readText);
            if (seeded.lines.length === 0) {
                report.push(`skipped ${s.heading} (nothing found)`);
                continue;
            }
            edits.push({ s, seeded });
            report.push(`seeded ${s.heading} (${seeded.lines.length} lines)`);
        }
        // Apply bottom-up so earlier line indexes stay valid.
        for (const { s, seeded } of edits.sort((a, b) => b.s.headingLine - a.s.headingLine)) {
            const cr = lines[s.headingLine].endsWith("\r") ? "\r" : "";
            const marker = `<!-- verified: ${sha}${seeded.manifests.length ? ` paths: ${seeded.manifests.join(", ")}` : ""} -->${cr}`;
            const body = seeded.lines.map((l) => `${l}${cr}`);
            if (s.markerLine === -1) {
                lines.splice(s.headingLine + 1, 0, marker, ...body);
            } else {
                lines[s.markerLine] = marker;
                lines.splice(s.markerLine + 1, 0, ...body);
            }
        }
        const next = lines.join("\n");
        if (next !== text) {
            const tmp = `${p.index}.tmp-${process.pid}`;
            await writeFile(tmp, next, "utf8");
            try {
                await renameWithRetry(tmp, p.index, renameImpl ? { renameImpl } : {});
            } catch (error) {
                await unlink(tmp).catch(() => {});
                throw error;
            }
        }
        return { sha, report };
    } finally {
        await releaseLock(p.lock, token);
    }
}

export const CONTEXT_MAX_CHARS = 9000;
export const CONTEXT_INDEX_CHARS = 6000;
export const CONTEXT_OPEN_LIMIT = 8;

function sectionBody(text, headingLine) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === headingLine);
    if (start === -1) {
        return "";
    }
    const body = [];
    for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
        body.push(lines[i]);
    }
    return body.join("\n").trim();
}

async function gatherContext(repoRoot, { source = "manual", git = defaultGit } = {}) {
    const p = memoryPaths(repoRoot);
    const parts = [
        "# AEO project memory",
        "",
        `Summary from .aeo/memory (source: ${source}). Open the files only for detail it does not cover.`,
        "",
        "## INDEX.md",
        ""
    ];
    try {
        const index = await readFile(p.index, "utf8");
        if (index.length > CONTEXT_INDEX_CHARS) {
            parts.push(
                index.slice(0, CONTEXT_INDEX_CHARS),
                `[truncated: ${index.length - CONTEXT_INDEX_CHARS} chars omitted; open .aeo/memory/INDEX.md]`
            );
        } else {
            parts.push(index.replace(/\s+$/, ""));
        }
    } catch {
        parts.push("(missing; run memory.js init)");
    }

    parts.push("", "## INDEX freshness", "");
    let staleSections = 0;
    try {
        const sections = checkFreshness(repoRoot, { git });
        staleSections = sections.filter((s) => s.status === "stale" || s.status === "unknown-commit").length;
        parts.push(...freshnessContextLines(sections));
    } catch {
        parts.push("INDEX freshness unknown (git unavailable).");
    }

    let rows = 0;
    try {
        const lines = (await readFile(p.docs, "utf8")).split(/\r?\n/);
        const header = lines.findIndex((l) => l.trim().startsWith("|"));
        if (header !== -1) {
            rows = lines.slice(header + 2).filter((l) => l.trim().startsWith("|")).length;
        }
    } catch {
        rows = 0;
    }
    parts.push("", "## Docs registry", "");
    let docsMismatches = 0;
    let docsLines = null;
    let allMatch = false;
    try {
        const check = checkDocsRegistry(repoRoot);
        docsMismatches = check.mismatches.length + check.missing.length;
        allMatch = check.checked > 0;
        if (docsMismatches > 0) {
            const all = [
                ...check.mismatches.map((m) =>
                    `- ${m.library} (${m.ecosystem}): registry ${m.registry} -> lockfile ${m.lockfile}; re-resolve the source and notes, then run memory.js docs set`),
                ...check.missing.map((m) =>
                    `- ${m.library} (${m.ecosystem}): registry row not in the lockfile any more; remove or update the row`)
            ];
            docsLines = all.slice(0, DOCS_CONTEXT_LINES);
            if (all.length > DOCS_CONTEXT_LINES) {
                docsLines.push(`(+${all.length - DOCS_CONTEXT_LINES} more)`);
            }
        }
    } catch {
        docsMismatches = 0;
        docsLines = null;
        allMatch = false;
    }
    if (docsLines) {
        parts.push(...docsLines);
    } else {
        parts.push(
            (rows > 0
                ? `docs.md lists ${rows} libraries; read .aeo/memory/docs.md before consulting library documentation.`
                : "docs.md is empty (no libraries registered).") +
            (allMatch ? " All checked versions match the lockfiles." : "")
        );
    }

    let names = [];
    try {
        names = (await readdir(p.tasks)).filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort();
    } catch {
        names = [];
    }
    const records = [];
    for (const name of names) {
        try {
            const text = await readFile(path.join(p.tasks, name), "utf8");
            const fields = parseFrontMatter(text);
            if (fields && fields.schema === "1" && ["delegation", "apply", "decision"].includes(fields.kind)) {
                records.push({ name, fields, text });
            }
        } catch {
            // unreadable record: skip
        }
    }
    const lastDecision = records.filter((r) => r.fields.kind === "decision").map((r) => r.name).pop() ?? "";
    const open = records
        .filter((r) => r.fields.kind !== "decision" && r.name > lastDecision)
        .reverse();
    const shown = open.slice(0, CONTEXT_OPEN_LIMIT);

    parts.push("", "## Open task", "");
    if (shown.length === 0) {
        parts.push("- (no open delegations since the last decision)");
    }
    for (const r of shown) {
        const f = r.fields;
        const ref = f.kind === "delegation" && f.delegation_id && f.delegation_id !== "-"
            ? f.delegation_id
            : (f.delegation_id && f.delegation_id !== "-" ? f.delegation_id : f.run_id ?? "-");
        const created = typeof f.created === "string" ? f.created.slice(0, 19) : "????-??-??T??:??:??";
        parts.push(
            `- ${created} ${f.kind} ${ref} ${f.outcome ?? "unknown"} (${f.engineer ?? "unknown"}) [.aeo/memory/tasks/${r.name}]`
        );
    }
    if (source === "compact" || source === "resume") {
        const newest = open.find((r) => r.fields.kind === "delegation");
        if (newest) {
            const baseline = sectionBody(newest.text, BASELINE_HEADING);
            const contract = sectionBody(newest.text, "## Contract (excerpt)");
            if (baseline) {
                parts.push("", `### Baseline before ${newest.name.slice(0, -3)}`, "", baseline);
            }
            if (contract) {
                parts.push("", "### Contract excerpt", "", contract);
            }
        }
    }
    let text = parts.join("\n") + "\n";
    if (text.length > CONTEXT_MAX_CHARS) {
        text = text.slice(0, CONTEXT_MAX_CHARS);
    }
    return { text, open: open.length, docsMismatches, staleSections };
}

/** Markdown summary of the project memory for session injection. Reads only; never writes. */
export async function buildContext(repoRoot, { source = "manual", git } = {}) {
    return (await gatherContext(repoRoot, { source, git })).text;
}

async function readStdin() {
    let data = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
        data += chunk;
    }
    return data;
}

async function sessionStartHook(options, { env, cwd, out, err, resolveRoot }) {
    try {
        const raw = typeof options.stdin === "string" ? options.stdin : await readStdin();
        const input = JSON.parse(raw);
        if (!input || typeof input !== "object") {
            return 0;
        }
        if (resolveMemoryMode(env) === "off") {
            return 0;
        }
        const hookCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : cwd;
        const repoRoot = resolveRoot(hookCwd);
        if (!repoRoot || !(await isDirectory(memoryPaths(repoRoot).dir))) {
            return 0;
        }
        const source = typeof input.source === "string" && input.source ? input.source : "startup";
        const { text, open, docsMismatches, staleSections } = await gatherContext(repoRoot, { source, git: options.git });
        out(JSON.stringify({
            hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text }
        }));
        try {
            const dir = path.join(memoryPaths(repoRoot).dir, "stats");
            await mkdir(dir, { recursive: true });
            const line = JSON.stringify({ ts: new Date().toISOString(), source, chars: text.length, open, docsMismatches, staleSections });
            await writeFile(path.join(dir, "session-start.jsonl"), `${line}\n`, { encoding: "utf8", flag: "a" });
        } catch {
            // passive counter: never fail
        }
    } catch (error) {
        try {
            err(`aeo session-start hook: ${(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ")}`);
        } catch {
            // ignore
        }
    }
    return 0;
}

function normalizeDecision(value) {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
    return DECISIONS.includes(normalized) ? normalized : null;
}

export async function main(argv = process.argv.slice(2), options = {}) {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const out = options.stdout ?? ((text) => process.stdout.write(`${text}\n`));
    const err = options.stderr ?? ((text) => process.stderr.write(`${text}\n`));
    const now = options.now ?? (() => Date.now());
    const resolveRoot = options.resolveRoot ?? gitTopLevel;

    const fail = (message) => {
        err(message);
        return 1;
    };

    if ((argv ?? [])[0] === "docs" && ["check", "set"].includes((argv ?? [])[1])) {
        const sub = argv[1];
        const dargs = parseArgs(argv.slice(2));
        if (dargs.errors.length || dargs.command !== null) {
            return fail([...dargs.errors, ...(dargs.command !== null ? [`Unexpected argument ${dargs.command}`] : []), USAGE_TEXT].join("\n"));
        }
        const root = dargs.flags.repo ? path.resolve(cwd, dargs.flags.repo) : resolveRoot(cwd);
        if (!root) {
            return fail(`Could not determine the repository root from ${cwd}. Pass --repo <path>.`);
        }
        const dp = memoryPaths(root);
        try {
            if (sub === "check") {
                if (!(await isDirectory(dp.dir))) {
                    return fail(`No project memory at ${dp.dir}. Run "memory.js init" first.`);
                }
                const c = checkDocsRegistry(root);
                for (const m of c.mismatches) {
                    out(`mismatch: ${m.library} (${m.ecosystem}): registry ${m.registry} -> lockfile ${m.lockfile}`);
                }
                for (const m of c.missing) {
                    out(`missing: ${m.library} (${m.ecosystem}): not in the lockfile`);
                }
                for (const u of c.unchecked) {
                    out(`unchecked: ${u.library} (${u.ecosystem})`);
                }
                for (const e of c.noLockfile) {
                    out(`no lockfile: ${e}`);
                }
                out(`Docs registry: ${c.rows.length} rows, ${c.checked} checked, ${c.mismatches.length} mismatched, ${c.missing.length} missing, ${c.unchecked.length} unchecked.`);
                return 0;
            }
            if (resolveMemoryMode(env) === "off") {
                return fail("Project memory is disabled (AEO_MEMORY=off). Nothing was written.");
            }
            if (!(await isDirectory(dp.dir))) {
                return fail(`No project memory at ${dp.dir}. Run "memory.js init" first.`);
            }
            const r = await upsertDocsRow(root, dargs.flags, { now });
            out(`Docs registry row ${r.action}: ${dargs.flags.library} (${dargs.flags.ecosystem}) ${r.version}, verified ${r.verified}.`);
            return 0;
        } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
        }
    }
    if ((argv ?? [])[0] === "hook" && (argv ?? [])[1] === "session-start") {
        return sessionStartHook(options, { env, cwd, out, err, resolveRoot });
    }

    const args = parseArgs(argv ?? []);
    if (args.errors.length || !["init", "seed", "decide", "reindex", "status", "context", "verify", "freshness"].includes(args.command) ||
        (args.flags.seed && args.command !== "init")) {
        return fail([...args.errors, USAGE_TEXT].join("\n"));
    }

    const repoRoot = args.flags.repo ? path.resolve(cwd, args.flags.repo) : resolveRoot(cwd);
    if (!repoRoot) {
        return fail(`Could not determine the repository root from ${cwd}. Pass --repo <path>.`);
    }
    const p = memoryPaths(repoRoot);

    try {
        if (args.command === "context") {
            if (!(await isDirectory(p.dir))) {
                return fail(`No project memory at ${p.dir}. Run "memory.js init" first.`);
            }
            out((await buildContext(repoRoot, { source: args.flags.source ?? "manual" })).replace(/\n$/, ""));
            return 0;
        }

        if (args.command === "freshness") {
            if (!(await isDirectory(p.dir))) {
                return fail(`No project memory at ${p.dir}. Run "memory.js init" first.`);
            }
            for (const s of checkFreshness(repoRoot, { git: options.git })) {
                out(`${s.heading}: ${freshnessLine(s)}`);
            }
            return 0;
        }

        if (args.command === "verify") {
            if (resolveMemoryMode(env) === "off") {
                return fail("Project memory is disabled (AEO_MEMORY=off). Nothing was written.");
            }
            if (!(await isDirectory(p.dir))) {
                return fail(`No project memory at ${p.dir}. Run "memory.js init" first.`);
            }
            const r = await verifySection(repoRoot, { section: args.flags.section, paths: args.flags.paths }, { git: options.git, now });
            out(`Section "${r.heading}" verified at ${short(r.sha)}${r.paths.length ? ` (paths: ${r.paths.join(", ")})` : ""}.`);
            return 0;
        }

        if (args.command === "init") {
            const result = await initMemory(repoRoot);
            out(`Project memory: ${result.dir}`);
            out(`Created: ${result.created.length ? result.created.join(", ") : "(nothing)"}`);
            out(`Kept: ${result.kept.length ? result.kept.join(", ") : "(nothing)"}`);
            if (!args.flags.seed) {
                return 0;
            }
        }

        if (args.command === "seed" || (args.command === "init" && args.flags.seed)) {
            if (resolveMemoryMode(env) === "off") {
                return fail("Project memory is disabled (AEO_MEMORY=off). Nothing was written.");
            }
            if (!(await isDirectory(p.dir))) {
                return fail(`No project memory at ${p.dir}. Run "memory.js init" first.`);
            }
            const r = await seedIndex(repoRoot, { git: options.git, now });
            for (const line of r.report) {
                out(line);
            }
            out(`Seeded from ${short(r.sha)}.`);
            return 0;
        }

        if (args.command === "status") {
            const mode = resolveMemoryMode(env);
            const exists = await isDirectory(p.dir);
            out(`Memory mode: ${mode}`);
            out(`Memory directory: ${p.dir} (${exists ? "exists" : "missing"})`);
            if (!exists) {
                return 0;
            }
            const counts = await countRecords(repoRoot);
            const kinds = Object.keys(counts).sort();
            out(`Records: ${kinds.length ? kinds.map((k) => `${k} ${counts[k]}`).join(", ") : "none"}`);
            const newest = (await readDecisions(repoRoot))[0];
            out(`Newest decision: ${newest ? formatRecentLine(newest).slice(2) : "none"}`);
            try {
                const size = (await readFile(p.index, "utf8")).length;
                out(`INDEX.md: ${size} chars`);
                if (size > INDEX_WARN_CHARS) {
                    out(`Warning: INDEX.md exceeds ${INDEX_WARN_CHARS} chars; shorten the hand-written sections.`);
                }
            } catch {
                out("INDEX.md: missing");
            }
            return 0;
        }

        if (args.command === "reindex") {
            const result = await reindex(repoRoot, { now });
            out(`INDEX.md ${result.changed ? "updated" : "unchanged"} (${result.entries} recent tasks).`);
            return 0;
        }

        // decide
        const task = sanitizeSlug(args.flags.task ?? "");
        if (!task) {
            return fail(`decide needs --task <slug>.\n${USAGE_TEXT}`);
        }
        const decision = normalizeDecision(args.flags.decision);
        if (!decision) {
            return fail(`decide needs --decision ${DECISIONS.join("|")}.\n${USAGE_TEXT}`);
        }
        if (resolveMemoryMode(env) === "off") {
            return fail("Project memory is disabled (AEO_MEMORY=off). Nothing was written.");
        }
        if (!(await isDirectory(p.dir))) {
            return fail(`No project memory at ${p.dir}. Run "memory.js init" first.`);
        }
        const delegations = (args.flags.delegations ?? "")
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean);
        const written = await writeDecisionRecord({
            repoRoot,
            env,
            now: () => new Date(now()),
            record: {
                task,
                decision,
                delegations,
                summary: args.flags.summary,
                findings: args.flags.findings
            }
        });
        if (!written.written) {
            return fail(`Decision not recorded: ${written.reason}`);
        }
        out(`Decision recorded: ${written.relativePath}`);
        const result = await reindex(repoRoot, { now });
        out(`INDEX.md ${result.changed ? "updated" : "unchanged"} (${result.entries} recent tasks).`);
        return 0;
    } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}

function canonical(file) {
    let resolved = path.resolve(file);
    try {
        resolved = realpathSync.native(resolved);
    } catch {
        try {
            resolved = realpathSync.native(`${resolved}.js`);
        } catch {
            // keep the resolved path
        }
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isEntrypoint() {
    if (!process.argv[1]) {
        return false;
    }
    return canonical(fileURLToPath(import.meta.url)) === canonical(process.argv[1]);
}

if (isEntrypoint()) {
    main().then((code) => {
        process.exitCode = code;
    });
}
