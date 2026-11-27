#!/usr/bin/env node
/**
 * Phase 5 runner: chain of N consecutive headless Claude Code sessions on one
 * repository with project memory on vs off, plus a compare command.
 *
 * Node 20+. ESM. Zero package dependencies.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { analyzeSession } from "./analyze-rescans.mjs";

export const USAGE_TEXT = [
    "Usage:",
    "  node scripts/bench/run-memory-ab.mjs run --repo <abs> --commit <sha> --config-dir <abs> --arm on|off --run <n>",
    "      --sessions <json file> --out <abs dir> [--memory-cli <abs>] [--claude <cmd>] [--max-budget-usd <n>] [--seed] [--dry-run] [--force]",
    "  node scripts/bench/run-memory-ab.mjs compare --out <dir> [--noise-pct <n>] [--json]"
].join("\n");

function isEntrypoint() {
    const invoked = process.argv[1];
    if (!invoked) {
        return false;
    }
    const invokedUrl = invoked.replaceAll("\\", "/");
    const self = import.meta.url.replaceAll("\\", "/");
    return self.endsWith(invokedUrl) || self.endsWith(`/${invokedUrl.split("/").pop()}`);
}

/** Parses argv; throws Error with a message on invalid input. */
export function parseArgs(argv) {
    const [command, ...rest] = argv;
    if (command !== "run" && command !== "compare") {
        throw new Error(`Unknown or missing command: ${command ?? "(none)"}`);
    }
    const valueFlags = new Set(
        command === "run"
            ? ["repo", "commit", "config-dir", "arm", "run", "sessions", "out", "memory-cli", "claude", "max-budget-usd"]
            : ["out", "noise-pct"]
    );
    const boolFlags = new Set(command === "run" ? ["dry-run", "force", "seed"] : ["json"]);
    const raw = {};
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!a.startsWith("--")) {
            throw new Error(`Unexpected argument: ${a}`);
        }
        const name = a.slice(2);
        if (boolFlags.has(name)) {
            raw[name] = true;
        } else if (valueFlags.has(name)) {
            const v = rest[++i];
            if (v === undefined || v.startsWith("--")) {
                throw new Error(`Missing value for --${name}`);
            }
            raw[name] = v;
        } else {
            throw new Error(`Unknown option: --${a.slice(2)}`);
        }
    }
    if (command === "compare") {
        if (!raw.out) {
            throw new Error("Missing required --out");
        }
        const noisePct = raw["noise-pct"] === undefined ? 15 : Number(raw["noise-pct"]);
        if (!Number.isFinite(noisePct) || noisePct < 0) {
            throw new Error("--noise-pct must be a non-negative number");
        }
        return { command, out: raw.out, noisePct, json: raw.json === true };
    }
    for (const req of ["repo", "commit", "config-dir", "arm", "run", "sessions", "out"]) {
        if (!raw[req]) {
            throw new Error(`Missing required --${req}`);
        }
    }
    if (raw.arm !== "on" && raw.arm !== "off") {
        throw new Error("--arm must be on or off");
    }
    const runNo = Number(raw.run);
    if (!Number.isInteger(runNo) || runNo < 1) {
        throw new Error("--run must be a positive integer");
    }
    const budget = raw["max-budget-usd"] === undefined ? 5 : Number(raw["max-budget-usd"]);
    if (!Number.isFinite(budget) || budget <= 0) {
        throw new Error("--max-budget-usd must be a positive number");
    }
    for (const p of ["repo", "config-dir", "out", "sessions"]) {
        if (p === "config-dir" && raw[p] === "default") {
            continue;
        }
        if (!path.isAbsolute(raw[p])) {
            throw new Error(`--${p} must be an absolute path`);
        }
    }
    if (raw["memory-cli"] !== undefined && !path.isAbsolute(raw["memory-cli"])) {
        throw new Error("--memory-cli must be an absolute path");
    }
    return {
        command,
        repo: raw.repo,
        commit: raw.commit,
        // "default" leaves CLAUDE_CONFIG_DIR unset (the user's normal config; transcripts under ~/.claude).
        useDefaultConfig: raw["config-dir"] === "default",
        configDir: raw["config-dir"] === "default" ? path.join(os.homedir(), ".claude") : raw["config-dir"],
        arm: raw.arm,
        run: runNo,
        sessionsFile: raw.sessions,
        out: raw.out,
        memoryCli: raw["memory-cli"] ?? path.join(raw.repo, ".aeo", "bridge", "antigravity-mcp", "memory.js"),
        claude: raw.claude ?? "claude",
        maxBudgetUsd: budget,
        seed: raw.seed === true,
        dryRun: raw["dry-run"] === true,
        force: raw.force === true
    };
}

export function buildClaudeArgs({ sessionId, maxBudgetUsd, mcpConfigPath = null }) {
    const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--session-id",
        sessionId,
        "--max-budget-usd",
        String(maxBudgetUsd)
    ];
    if (mcpConfigPath) {
        args.push("--mcp-config", mcpConfigPath);
    }
    return args;
}

export function transcriptDirName(repo) {
    return repo.replace(/[^A-Za-z0-9]/g, "-");
}

export function locateTranscript(configDir, repo, sessionId) {
    const projects = path.join(configDir, "projects");
    const direct = path.join(projects, transcriptDirName(repo), `${sessionId}.jsonl`);
    if (existsSync(direct)) {
        return direct;
    }
    if (existsSync(projects)) {
        for (const entry of readdirSync(projects, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                const candidate = path.join(projects, entry.name, `${sessionId}.jsonl`);
                if (existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    }
    return null;
}

/** Reads total_cost_usd / num_turns from the last result line of a stream-json file's text. */
export function parseStreamResult(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.includes('"type":"result"') || l.includes('"type": "result"'));
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const o = JSON.parse(lines[i]);
            if (o && o.type === "result") {
                return {
                    costUsd: Number.isFinite(o.total_cost_usd) ? o.total_cost_usd : null,
                    numTurns: Number.isFinite(o.num_turns) ? o.num_turns : null,
                    isError: o.is_error === true,
                    errorText: o.is_error === true ? String(o.result ?? o.terminal_reason ?? "unknown error").slice(0, 300) : null
                };
            }
        } catch {
            // keep looking
        }
    }
    return { costUsd: null, numTurns: null, isError: true, errorText: "no result line in stream" };
}

/** Analyzes one transcript file; returns analysis fields for a session record (nulls if missing). */
export function analyzeTranscriptFile(transcriptPath, repo) {
    if (!transcriptPath || !existsSync(transcriptPath)) {
        return { teamLead: null, discoveryCalls: null, startupDiscoveryCalls: null, startupDiscoveryTokens: null };
    }
    const a = analyzeSession(readFileSync(transcriptPath, "utf8"), { projectRoot: repo });
    const t = a.teamLead;
    return {
        teamLead: {
            input_tokens: t.input_tokens,
            output_tokens: t.output_tokens,
            cache_creation_input_tokens: t.cache_creation_input_tokens,
            cache_read_input_tokens: t.cache_read_input_tokens
        },
        discoveryCalls: a.discovery.calls,
        startupDiscoveryCalls: a.startupDiscovery.calls,
        startupDiscoveryTokens: a.startupDiscovery.approxTokens
    };
}

export function inputEquivalent(teamLead) {
    if (!teamLead) {
        return 0;
    }
    return (teamLead.input_tokens ?? 0) + (teamLead.cache_creation_input_tokens ?? 0) + (teamLead.cache_read_input_tokens ?? 0);
}

/**
 * Builds the result document. Each entry of `sessions` holds run metadata
 * (index, sessionId, transcriptPath, exitCode, wallClockSeconds, costUsd, numTurns,
 * indexChars, hookInjections); analysis fields are filled from transcriptPath.
 */
export function summarizeChain({ arm, run, date, commit, repo }, sessions) {
    const full = sessions.map((s) => ({ ...s, ...analyzeTranscriptFile(s.transcriptPath, repo) }));
    const totals = { costUsd: 0, teamLeadInputEquivalent: 0, outputTokens: 0, discoveryCalls: 0, wallClockSeconds: 0 };
    for (const s of full) {
        totals.costUsd += s.costUsd ?? 0;
        totals.teamLeadInputEquivalent += inputEquivalent(s.teamLead);
        totals.outputTokens += s.teamLead?.output_tokens ?? 0;
        totals.discoveryCalls += s.discoveryCalls ?? 0;
        totals.wallClockSeconds += s.wallClockSeconds ?? 0;
    }
    return { arm, run, date, commit, repo, sessions: full, totals };
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** results: array of result documents (as written by `run`). */
export function compareResults(results) {
    const arms = {};
    for (const armName of ["on", "off"]) {
        const rs = results.filter((r) => r.arm === armName);
        const maxIdx = Math.max(0, ...rs.map((r) => r.sessions.length));
        const perSession = [];
        for (let i = 0; i < maxIdx; i++) {
            const ss = rs.map((r) => r.sessions[i]).filter(Boolean);
            perSession.push({
                index: i + 1,
                teamLeadInputEquivalent: mean(ss.map((s) => inputEquivalent(s.teamLead))),
                discoveryCalls: mean(ss.map((s) => s.discoveryCalls ?? 0)),
                costUsd: mean(ss.map((s) => s.costUsd ?? 0))
            });
        }
        const late = rs.map((r) => {
            const l = r.sessions.slice(1);
            return {
                tl: l.reduce((a, s) => a + inputEquivalent(s.teamLead), 0),
                cost: l.reduce((a, s) => a + (s.costUsd ?? 0), 0)
            };
        });
        arms[armName] = {
            runs: rs.length,
            meanTotals: {
                costUsd: mean(rs.map((r) => r.totals.costUsd)),
                teamLeadInputEquivalent: mean(rs.map((r) => r.totals.teamLeadInputEquivalent)),
                outputTokens: mean(rs.map((r) => r.totals.outputTokens)),
                discoveryCalls: mean(rs.map((r) => r.totals.discoveryCalls)),
                wallClockSeconds: mean(rs.map((r) => r.totals.wallClockSeconds))
            },
            perSession,
            late: { teamLeadInputEquivalent: mean(late.map((x) => x.tl)), costUsd: mean(late.map((x) => x.cost)) }
        };
    }
    const pct = (on, off) => (off === 0 ? null : ((on - off) / off) * 100);
    return {
        arms,
        late23DiffPct: {
            teamLeadInputEquivalent: pct(arms.on.late.teamLeadInputEquivalent, arms.off.late.teamLeadInputEquivalent),
            costUsd: pct(arms.on.late.costUsd, arms.off.late.costUsd)
        }
    };
}

export function stopDecision(comparison, noisePct = 15) {
    const runs = Math.min(comparison.arms.on.runs, comparison.arms.off.runs);
    if (runs >= 2) {
        return `Done: ${runs} runs per arm.`;
    }
    const diff = comparison.late23DiffPct.teamLeadInputEquivalent;
    if (runs === 1 && diff !== null && Math.abs(diff) < noisePct) {
        return `Stop: difference within noise (${Math.abs(diff).toFixed(1)}% < ${noisePct}%); second repetition not needed.`;
    }
    return "Continue: run repetition 2.";
}

export function readResults(outDir) {
    return readdirSync(outDir)
        .filter((f) => /^mem-.+-.+\.json$/.test(f) && !/-s\d+\./.test(f))
        .map((f) => JSON.parse(readFileSync(path.join(outDir, f), "utf8")))
        .filter((r) => r && (r.arm === "on" || r.arm === "off") && Array.isArray(r.sessions));
}

function fmt(n, d = 0) {
    return n === null || n === undefined ? "n/a" : n.toFixed(d);
}

export function renderComparison(cmp, noisePct) {
    const out = [];
    for (const armName of ["on", "off"]) {
        const a = cmp.arms[armName];
        const t = a.meanTotals;
        out.push(`Arm ${armName}: ${a.runs} run(s)`);
        out.push(
            `  mean totals: costUsd=${fmt(t.costUsd, 4)} teamLeadInputEquivalent=${fmt(t.teamLeadInputEquivalent)} outputTokens=${fmt(t.outputTokens)} discoveryCalls=${fmt(t.discoveryCalls, 1)} wallClockSeconds=${fmt(t.wallClockSeconds, 1)}`
        );
        for (const s of a.perSession) {
            out.push(
                `  session ${s.index}: teamLeadInputEquivalent=${fmt(s.teamLeadInputEquivalent)} discoveryCalls=${fmt(s.discoveryCalls, 1)} costUsd=${fmt(s.costUsd, 4)}`
            );
        }
    }
    const d = cmp.late23DiffPct;
    out.push(
        `Sessions 2+3 on vs off: teamLeadInputEquivalent ${fmt(d.teamLeadInputEquivalent, 1)}%, costUsd ${fmt(d.costUsd, 1)}%`
    );
    out.push(stopDecision(cmp, noisePct));
    return out.join("\n");
}

function git(repo, args) {
    return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function quote(s) {
    return `"${String(s).replaceAll('"', '\\"')}"`;
}

function resetRepo(repo, commit, log) {
    const steps = [
        ["reset", "--hard", commit],
        ["clean", "-fd", "-e", ".claude", "-e", ".mcp.json", "-e", ".aeo"]
    ];
    for (const s of steps) {
        const r = git(repo, s);
        if (r.status !== 0) {
            throw new Error(`git ${s.join(" ")} failed: ${r.stderr || r.error?.message || ""}`);
        }
    }
    rmSync(path.join(repo, ".aeo", "memory"), { recursive: true, force: true });
    const head = git(repo, ["rev-parse", "HEAD"]);
    if (head.status !== 0 || head.stdout.trim() !== commit.trim()) {
        const got = head.stdout.trim();
        // allow abbreviated shas
        if (!(got && commit.length >= 7 && got.startsWith(commit))) {
            throw new Error(`HEAD ${got} != expected commit ${commit}`);
        }
    }
    log(`reset repo to ${commit}`);
}

function countLines(file) {
    if (!existsSync(file)) {
        return 0;
    }
    return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
}

export function runChain(args, { log = (m) => process.stdout.write(`${m}\n`) } = {}) {
    const prompts = JSON.parse(readFileSync(args.sessionsFile, "utf8"));
    if (!Array.isArray(prompts) || prompts.length === 0 || prompts.some((p) => typeof p !== "string")) {
        throw new Error("--sessions must be a JSON array of prompt strings");
    }
    const resultPath = path.join(args.out, `mem-${args.arm}-${args.run}.json`);
    if (existsSync(resultPath) && !args.force) {
        throw new Error(`${resultPath} exists; use --force to overwrite`);
    }
    const head = git(args.repo, ["rev-parse", "HEAD"]);
    if (head.status !== 0) {
        throw new Error(`git rev-parse HEAD failed in ${args.repo}`);
    }
    const mcpPath = path.join(args.repo, ".mcp.json");
    const mcpConfigPath = existsSync(mcpPath) ? mcpPath : null;
    const isWin = process.platform === "win32";
    const env = { ...process.env, AEO_MEMORY: args.arm };
    if (args.useDefaultConfig) {
        delete env.CLAUDE_CONFIG_DIR;
    } else {
        env.CLAUDE_CONFIG_DIR = args.configDir;
    }
    const base = `mem-${args.arm}-${args.run}`;
    const statsFile = path.join(args.repo, ".aeo", "memory", "stats", "session-start.jsonl");
    const indexFile = path.join(args.repo, ".aeo", "memory", "INDEX.md");

    log(`repo=${args.repo} commit=${args.commit} arm=${args.arm} run=${args.run} out=${args.out}`);
    log(`env: CLAUDE_CONFIG_DIR=${args.useDefaultConfig ? "(unset, default config)" : args.configDir} AEO_MEMORY=${args.arm}`);
    log(`reset: git reset --hard ${args.commit}; git clean -fd -e .claude -e .mcp.json -e .aeo; rm ${path.join(args.repo, ".aeo", "memory")}`);
    if (args.arm === "on") {
        log(`init: node ${args.memoryCli} init${args.seed ? " --seed" : ""} --repo ${args.repo}`);
    }
    const plannedIds = prompts.map(() => randomUUID());
    prompts.forEach((p, i) => {
        const a = buildClaudeArgs({ sessionId: plannedIds[i], maxBudgetUsd: args.maxBudgetUsd, mcpConfigPath });
        log(`session ${i + 1}: ${args.claude} ${a.join(" ")}  (cwd=${args.repo}; stdin prompt ${p.length} chars)`);
        log(`  stdout -> ${path.join(args.out, `${base}-s${i + 1}.stream.jsonl`)}; stderr -> ${path.join(args.out, `${base}-s${i + 1}.stderr.log`)}`);
    });
    log(`result: ${resultPath}`);
    if (args.dryRun) {
        log("dry-run: nothing executed");
        return null;
    }

    mkdirSync(args.out, { recursive: true });
    resetRepo(args.repo, args.commit, log);
    if (args.arm === "on") {
        const init = spawnSync(process.execPath, [args.memoryCli, "init", ...(args.seed ? ["--seed"] : []), "--repo", args.repo], { encoding: "utf8" });
        if (init.status !== 0) {
            throw new Error(`memory init failed (exit ${init.status}): ${init.stderr || init.error?.message || ""}`);
        }
    }

    const records = [];
    for (let i = 0; i < prompts.length; i++) {
        const sessionId = plannedIds[i];
        const n = i + 1;
        const streamPath = path.join(args.out, `${base}-s${n}.stream.jsonl`);
        const errPath = path.join(args.out, `${base}-s${n}.stderr.log`);
        const cargs = buildClaudeArgs({ sessionId, maxBudgetUsd: args.maxBudgetUsd, mcpConfigPath });
        const outFd = openSync(streamPath, "w");
        const errFd = openSync(errPath, "w");
        const started = Date.now();
        let r;
        try {
            const spawnOpts = { cwd: args.repo, env, input: prompts[i], stdio: ["pipe", outFd, errFd] };
            r = isWin
                ? spawnSync([args.claude, ...cargs.map(quote)].join(" "), { ...spawnOpts, shell: true })
                : spawnSync(args.claude, cargs, spawnOpts);
        } finally {
            closeSync(outFd);
            closeSync(errFd);
        }
        const wallClockSeconds = Math.round(((Date.now() - started) / 1000) * 10) / 10;
        const transcriptPath = locateTranscript(args.configDir, args.repo, sessionId);
        const streamResult = parseStreamResult(readFileSync(streamPath, "utf8"));
        records.push({
            index: n,
            sessionId,
            transcriptPath,
            exitCode: r.status,
            wallClockSeconds,
            costUsd: streamResult.costUsd,
            numTurns: streamResult.numTurns,
            indexChars: existsSync(indexFile) ? readFileSync(indexFile, "utf8").length : 0,
            hookInjections: countLines(statsFile)
        });
        log(`session ${n} done: exit=${r.status} wall=${wallClockSeconds}s transcript=${transcriptPath ?? "NOT FOUND"}`);
        if (streamResult.isError) {
            // An errored session (auth, API, budget) makes the chain incomparable: write no result file.
            resetRepo(args.repo, args.commit, log);
            throw new Error(`session ${n} failed (${streamResult.errorText}); no result written`);
        }
    }

    const doc = summarizeChain(
        { arm: args.arm, run: args.run, date: new Date().toISOString(), commit: args.commit, repo: args.repo },
        records
    );
    writeFileSync(resultPath, `${JSON.stringify(doc, null, 2)}\n`);
    log(`wrote ${resultPath}`);
    resetRepo(args.repo, args.commit, log);
    return doc;
}

export function main(argv = process.argv.slice(2)) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (error) {
        process.stderr.write(`${error.message}\n${USAGE_TEXT}\n`);
        process.exitCode = 1;
        return 1;
    }
    try {
        if (args.command === "run") {
            runChain(args);
            return 0;
        }
        const cmp = compareResults(readResults(args.out));
        process.stdout.write(`${renderComparison(cmp, args.noisePct)}\n`);
        if (args.json) {
            process.stdout.write(`${JSON.stringify({ ...cmp, decision: stopDecision(cmp, args.noisePct) }, null, 2)}\n`);
        }
        return 0;
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
        return 1;
    }
}

if (isEntrypoint()) {
    const exitCode = main();
    if (exitCode) {
        process.exitCode = exitCode;
    }
}
