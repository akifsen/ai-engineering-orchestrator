import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
    buildClaudeArgs,
    compareResults,
    parseArgs,
    stopDecision,
    summarizeChain,
    transcriptDirName
} from "../bench/run-memory-ab.mjs";

const SCRIPT = path.resolve("scripts/bench/run-memory-ab.mjs");
const tmp = () => mkdtempSync(path.join(tmpdir(), "memab-"));
const abs = (p) => path.resolve(p);

const runArgv = (extra = []) => [
    "run", "--repo", abs("/r"), "--commit", "abc1234", "--config-dir", abs("/c"), "--arm", "on", "--run", "1",
    "--sessions", abs("/s.json"), "--out", abs("/o"), ...extra
];

test("parseArgs run: defaults and flags", () => {
    const a = parseArgs(runArgv(["--dry-run", "--force", "--max-budget-usd", "2"]));
    assert.equal(a.arm, "on");
    assert.equal(a.run, 1);
    assert.equal(a.claude, "claude");
    assert.equal(a.maxBudgetUsd, 2);
    assert.equal(a.dryRun, true);
    assert.equal(a.force, true);
    assert.equal(a.memoryCli, path.join(abs("/r"), ".aeo", "bridge", "antigravity-mcp", "memory.js"));
    assert.equal(parseArgs(runArgv()).maxBudgetUsd, 5);
});

test("parseArgs validation errors", () => {
    assert.throws(() => parseArgs([]), /command/);
    assert.throws(() => parseArgs(["run"]), /Missing required --repo/);
    assert.throws(() => parseArgs(runArgv(["--bogus"])), /Unknown option/);
    assert.throws(() => parseArgs(runArgv()).arm === "x" || parseArgs(runArgv().map((v) => (v === "on" ? "maybe" : v))), /--arm/);
    assert.throws(() => parseArgs(runArgv().map((v) => (v === "1" ? "0" : v))), /--run/);
    assert.throws(() => parseArgs(runArgv().map((v) => (v === abs("/r") ? "rel" : v))), /absolute/);
    assert.throws(() => parseArgs(runArgv(["--max-budget-usd", "-1"])), /max-budget/);
    assert.throws(() => parseArgs(["compare"]), /--out/);
    assert.throws(() => parseArgs(["compare", "--out", "x", "--noise-pct", "abc"]), /noise-pct/);
    assert.deepEqual(parseArgs(["compare", "--out", "x", "--json"]), { command: "compare", out: "x", noisePct: 15, json: true });
});

test("buildClaudeArgs with and without .mcp.json", () => {
    const without = buildClaudeArgs({ sessionId: "id1", maxBudgetUsd: 5 });
    assert.deepEqual(without, [
        "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
        "--session-id", "id1", "--max-budget-usd", "5"
    ]);
    const withMcp = buildClaudeArgs({ sessionId: "id1", maxBudgetUsd: 5, mcpConfigPath: "/r/.mcp.json" });
    assert.deepEqual(withMcp.slice(-2), ["--mcp-config", "/r/.mcp.json"]);
});

test("transcriptDirName replaces non-alphanumerics", () => {
    assert.equal(transcriptDirName("C:/bench/kimlik-k2"), "C--bench-kimlik-k2");
    assert.equal(transcriptDirName("C:\\bench\\kimlik_k2"), "C--bench-kimlik-k2");
});

function transcript(id, tools, usage) {
    const lines = [{ type: "user", sessionId: id, timestamp: "2026-01-01T00:00:00Z", message: { content: "hi" } }];
    tools.forEach((t, i) => {
        lines.push({
            type: "assistant",
            message: { id: `m${id}${i}`, usage, content: [{ type: "tool_use", id: `t${id}${i}`, name: t, input: { file_path: "/x" } }] }
        });
        lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${id}${i}`, content: "abcd" }] } });
    });
    return lines.map((l) => JSON.stringify(l)).join("\n");
}

test("summarizeChain totals from synthetic transcripts", () => {
    const dir = tmp();
    try {
        const u = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 };
        const p1 = path.join(dir, "a.jsonl");
        const p2 = path.join(dir, "b.jsonl");
        writeFileSync(p1, transcript("a", ["Read", "Grep"], u));
        writeFileSync(p2, transcript("b", ["Read"], u));
        const doc = summarizeChain(
            { arm: "on", run: 1, date: "d", commit: "c", repo: "/repo" },
            [
                { index: 1, sessionId: "a", transcriptPath: p1, exitCode: 0, wallClockSeconds: 10, costUsd: 0.5, numTurns: 3, indexChars: 0, hookInjections: 1 },
                { index: 2, sessionId: "b", transcriptPath: p2, exitCode: 0, wallClockSeconds: 5, costUsd: 0.25, numTurns: 2, indexChars: 100, hookInjections: 2 },
                { index: 3, sessionId: "c", transcriptPath: null, exitCode: 1, wallClockSeconds: 1, costUsd: null, numTurns: null, indexChars: 0, hookInjections: 2 }
            ]
        );
        assert.equal(doc.sessions[0].discoveryCalls, 2);
        assert.equal(doc.sessions[0].teamLead.input_tokens, 20);
        assert.equal(doc.sessions[2].teamLead, null);
        assert.equal(doc.totals.discoveryCalls, 3);
        assert.equal(doc.totals.teamLeadInputEquivalent, 20 + 40 + 60 + 10 + 20 + 30);
        assert.equal(doc.totals.outputTokens, 15);
        assert.equal(doc.totals.costUsd, 0.75);
        assert.equal(doc.totals.wallClockSeconds, 16);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

const mk = (arm, tl2, tl3, cost = 1) => ({
    arm,
    run: 1,
    sessions: [1, 2, 3].map((i) => ({
        index: i,
        teamLead: { input_tokens: i === 1 ? 100 : i === 2 ? tl2 : tl3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
        discoveryCalls: i,
        costUsd: cost
    })),
    totals: { costUsd: 3 * cost, teamLeadInputEquivalent: 100 + tl2 + tl3, outputTokens: 3, discoveryCalls: 6, wallClockSeconds: 30 }
});

test("compare: within noise stops, above noise continues, two runs done", () => {
    const within = compareResults([mk("on", 95, 100), mk("off", 100, 100)]);
    assert.ok(Math.abs(within.late23DiffPct.teamLeadInputEquivalent + 2.5) < 1e-9);
    assert.match(stopDecision(within, 15), /^Stop: difference within noise \(2\.5% < 15%\); second repetition not needed\.$/);
    const above = compareResults([mk("on", 50, 50), mk("off", 100, 100)]);
    assert.equal(above.late23DiffPct.teamLeadInputEquivalent, -50);
    assert.equal(stopDecision(above, 15), "Continue: run repetition 2.");
    const two = compareResults([mk("on", 50, 50), mk("on", 60, 60), mk("off", 100, 100), mk("off", 100, 100)]);
    assert.equal(two.arms.on.runs, 2);
    assert.equal(two.arms.on.perSession[1].teamLeadInputEquivalent, 55);
    assert.equal(stopDecision(two, 15), "Done: 2 runs per arm.");
});

function hasGit() {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

test("run --dry-run resets and launches nothing", { skip: !hasGit() && "git not on PATH" }, () => {
    const dir = tmp();
    try {
        const repo = path.join(dir, "repo");
        mkdirSync(repo);
        const g = (...a) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
        assert.equal(g("init").status, 0);
        writeFileSync(path.join(repo, "f.txt"), "one");
        g("add", ".");
        assert.equal(g("commit", "-m", "c1").status, 0);
        const sha = g("rev-parse", "HEAD").stdout.trim();
        // dirty state + memory dir that a real reset would remove
        writeFileSync(path.join(repo, "f.txt"), "dirty");
        writeFileSync(path.join(repo, "untracked.txt"), "x");
        mkdirSync(path.join(repo, ".aeo", "memory"), { recursive: true });
        const sessions = path.join(dir, "s.json");
        writeFileSync(sessions, JSON.stringify(["p1", "p2", "p3"]));
        const out = path.join(dir, "out");
        const r = spawnSync(
            process.execPath,
            [SCRIPT, "run", "--repo", repo, "--commit", sha, "--config-dir", path.join(dir, "cfg"), "--arm", "on", "--run", "1",
                "--sessions", sessions, "--out", out, "--claude", "definitely-not-claude", "--dry-run"],
            { encoding: "utf8" }
        );
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /session 3:/);
        assert.match(r.stdout, /dry-run: nothing executed/);
        assert.equal(readFileSync(path.join(repo, "f.txt"), "utf8"), "dirty");
        assert.ok(existsSync(path.join(repo, "untracked.txt")));
        assert.ok(existsSync(path.join(repo, ".aeo", "memory")));
        assert.ok(!existsSync(out));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("parseStreamResult flags errored and missing results", async () => {
    const { parseStreamResult } = await import("../bench/run-memory-ab.mjs");
    const ok = parseStreamResult('{"type":"system"}\n{"type":"result","is_error":false,"total_cost_usd":0.5,"num_turns":4}\n');
    assert.deepEqual(ok, { costUsd: 0.5, numTurns: 4, isError: false, errorText: null });
    const bad = parseStreamResult('{"type":"result","is_error":true,"total_cost_usd":0,"num_turns":1,"result":"Failed to authenticate"}\n');
    assert.equal(bad.isError, true);
    assert.equal(bad.errorText, "Failed to authenticate");
    assert.equal(parseStreamResult("").isError, true);
});

test("parseArgs accepts --config-dir default", async () => {
    const { parseArgs } = await import("../bench/run-memory-ab.mjs");
    const abs = path.resolve("/tmp/x");
    const a = parseArgs(["run", "--repo", abs, "--commit", "abc1234", "--config-dir", "default", "--arm", "on", "--run", "1", "--sessions", abs, "--out", abs]);
    assert.equal(a.useDefaultConfig, true);
    assert.ok(a.configDir.endsWith(".claude"));
});
