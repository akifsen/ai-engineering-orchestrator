import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
    aggregateRuns,
    median,
    range,
    renderCsv,
    renderMarkdown
} from "../bench/report.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reportScript = path.join(repoRoot, "scripts", "bench", "report.mjs");
const fixtureDir = path.join(repoRoot, "scripts", "test", "fixtures", "bench", "runs");

function loadFixtureRuns() {
    const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".json")).sort();
    return files.map((f) => JSON.parse(readFileSync(path.join(fixtureDir, f), "utf8")));
}

test("median computes odd and even midpoints, handles empty array", () => {
    assert.equal(median([1, 5, 9]), 5);
    assert.equal(median([10, 20]), 15);
    assert.equal(median([1, 2, 5, 10]), 3.5);
    assert.equal(median([42]), 42);
    assert.equal(median([]), null);
    assert.equal(median(null), null);
    assert.equal(median([3, 1, 2]), 2);
});

test("range formats min-max string with en dash and handles single/empty", () => {
    assert.equal(range([5, 15]), "5\u201315");
    assert.equal(range([42]), "42\u201342");
    assert.equal(range([20, 10, 30]), "10\u201330");
    assert.equal(range([]), null);
    assert.equal(range(null), null);
});

test("aggregateRuns and renderMarkdown exclude quota-fallback runs from main stats and list in second table", () => {
    const runs = loadFixtureRuns();
    const agg = aggregateRuns(runs);

    assert.equal(agg.totalRuns, 5);

    const groupK1 = agg.groups.find((g) => g.task === "T1" && g.condition === "K1");
    assert.ok(groupK1);
    assert.equal(groupK1.n, 1);
    assert.equal(groupK1.quotaFallbackRuns, 1);

    assert.equal(agg.quotaFallbackRuns.length, 1);
    assert.equal(agg.quotaFallbackRuns[0].run, 2);
    assert.equal(agg.quotaFallbackRuns[0].quotaFallback, true);

    const md = renderMarkdown(agg, { runsDir: fixtureDir });
    assert.match(md, /### Quota-fallback runs \(excluded from the main table\)/);
    assert.match(md, /gemini-3\.8-flash-fallback/);
});

test("policyViolation runs are counted but kept in main stats", () => {
    const runs = loadFixtureRuns();
    const agg = aggregateRuns(runs);

    const groupK0 = agg.groups.find((g) => g.task === "T1" && g.condition === "K0");
    assert.ok(groupK0);
    assert.equal(groupK0.n, 3);
    assert.equal(groupK0.acceptancePass, 2);
    assert.equal(groupK0.policyViolations, 1);
    assert.equal(groupK0.dirtyViolations, 1);

    const md = renderMarkdown(agg, { runsDir: fixtureDir });
    assert.match(md, /\|\s*T1\s*\|\s*K0\s*\|\s*3\s*\|.*\|\s*2\/3\s*\|\s*1\s*\|\s*1\s*\|/);
});

test("markdown output contains no word mean", () => {
    const runs = loadFixtureRuns();
    const agg = aggregateRuns(runs);
    const md = renderMarkdown(agg, { runsDir: fixtureDir });
    assert.doesNotMatch(md, /\bmean\b/i);
});

test("renderCsv generates correct header and row count", () => {
    const runs = loadFixtureRuns();
    const agg = aggregateRuns(runs);
    const csv = renderCsv(agg);
    const lines = csv.trim().split("\n");

    assert.equal(lines.length, 3);

    const header = lines[0];
    assert.ok(header.startsWith("task,condition,n,"));
    assert.ok(header.includes("tl_input_tokens_median"));
    assert.ok(header.includes("tl_fresh_median"));
    assert.ok(header.includes("engineer_tokens_median"));
    assert.ok(
        header.endsWith("acceptance_pass,acceptance_total,policy_violations,dirty_violations,quota_fallback_runs")
    );

    const rowK0 = lines.find((l) => l.startsWith("T1,K0,"));
    assert.ok(rowK0);
    assert.ok(rowK0.endsWith("2,3,1,1,0"));
});

test("--out option writes report.md and report.csv", async () => {
    const tempOut = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-report-out-"));
    try {
        const res = spawnSync(process.execPath, [reportScript, fixtureDir, "--out", tempOut], {
            encoding: "utf8"
        });
        assert.equal(res.status, 0, res.stderr);

        const mdPath = path.join(tempOut, "report.md");
        const csvPath = path.join(tempOut, "report.csv");

        assert.equal(existsSync(mdPath), true);
        assert.equal(existsSync(csvPath), true);

        const mdContent = await readFile(mdPath, "utf8");
        const csvContent = await readFile(csvPath, "utf8");

        assert.match(mdContent, /Benchmark report/);
        assert.match(csvContent, /^task,condition,n,/);
    } finally {
        await rm(tempOut, { recursive: true, force: true });
    }
});

test("CLI run on fixture dir exits 0 and prints markdown table", () => {
    const res = spawnSync(process.execPath, [reportScript, fixtureDir], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Benchmark report \u2014 generated/);
    assert.match(res.stdout, /TL fresh median/);
    assert.match(res.stdout, /Quota-fallback runs/);
});
