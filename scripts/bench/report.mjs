#!/usr/bin/env node
/**
 * Benchmark report generator.
 *
 * Reads run result JSON files, groups them by (task, condition),
 * computes median and range statistics, and outputs a formatted
 * Markdown summary and optional CSV report.
 *
 * Node 20+. ESM. Zero package dependencies.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

export const USAGE_TEXT = [
    "Usage:",
    "  node scripts/bench/report.mjs <runs-dir> [--out <dir>]",
    "",
    "Aggregates benchmark run JSON files and produces a Markdown summary and CSV."
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

export const METRIC_FIELDS = [
    {
        id: "tl_input_tokens",
        label: "TL input",
        get: (r) => (typeof r.teamLead?.input_tokens === "number" ? r.teamLead.input_tokens : null)
    },
    {
        id: "tl_output_tokens",
        label: "TL output",
        get: (r) => (typeof r.teamLead?.output_tokens === "number" ? r.teamLead.output_tokens : null)
    },
    {
        id: "tl_cache_creation_input_tokens",
        label: "TL cache creation",
        get: (r) => (typeof r.teamLead?.cache_creation_input_tokens === "number" ? r.teamLead.cache_creation_input_tokens : null)
    },
    {
        id: "tl_cache_read_input_tokens",
        label: "TL cache read",
        get: (r) => (typeof r.teamLead?.cache_read_input_tokens === "number" ? r.teamLead.cache_read_input_tokens : null)
    },
    {
        id: "tl_fresh",
        label: "TL fresh",
        get: (r) => {
            const tl = r.teamLead;
            if (!tl) return null;
            const hasInput = typeof tl.input_tokens === "number";
            const hasCc = typeof tl.cache_creation_input_tokens === "number";
            const hasOut = typeof tl.output_tokens === "number";
            if (!hasInput && !hasCc && !hasOut) return null;
            return (tl.input_tokens ?? 0) + (tl.cache_creation_input_tokens ?? 0) + (tl.output_tokens ?? 0);
        }
    },
    {
        id: "engineer_tokens",
        label: "Engineer tokens",
        get: (r) => (typeof r.engineer?.tokens === "number" ? r.engineer.tokens : null)
    },
    {
        id: "delegation_count",
        label: "Delegation count",
        get: (r) => (typeof r.delegationCount === "number" ? r.delegationCount : null)
    },
    {
        id: "compactions",
        label: "Compactions",
        get: (r) => (typeof r.compactions === "number" ? r.compactions : null)
    },
    {
        id: "wall_clock_seconds",
        label: "Wall-clock seconds",
        get: (r) => (typeof r.wallClockSeconds === "number" ? r.wallClockSeconds : null)
    },
    {
        id: "revisions",
        label: "Revisions",
        get: (r) => (typeof r.revisions === "number" ? r.revisions : null)
    }
];

export function median(numbers) {
    if (!numbers || !Array.isArray(numbers)) {
        return null;
    }
    const valid = numbers.filter((n) => typeof n === "number" && Number.isFinite(n));
    if (valid.length === 0) {
        return null;
    }
    const sorted = [...valid].sort((a, b) => a - b);
    const len = sorted.length;
    if (len % 2 === 1) {
        return sorted[Math.floor(len / 2)];
    }
    const mid1 = len / 2 - 1;
    const mid2 = len / 2;
    return (sorted[mid1] + sorted[mid2]) / 2;
}

export function range(numbers) {
    if (!numbers || !Array.isArray(numbers)) {
        return null;
    }
    const valid = numbers.filter((n) => typeof n === "number" && Number.isFinite(n));
    if (valid.length === 0) {
        return null;
    }
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    return `${min}\u2013${max}`;
}

export function aggregateRuns(runs) {
    if (!runs || !Array.isArray(runs)) {
        return { groups: [], quotaFallbackRuns: [], totalRuns: 0 };
    }

    const groupMap = new Map();
    const quotaFallbackRuns = [];

    for (const run of runs) {
        if (!run || typeof run !== "object") {
            continue;
        }
        const task = String(run.task || "");
        const condition = String(run.condition || "");
        const key = `${task}\t${condition}`;

        if (!groupMap.has(key)) {
            groupMap.set(key, {
                task,
                condition,
                runs: [],
                quotaFallbackRuns: []
            });
        }

        const g = groupMap.get(key);
        if (run.quotaFallback === true) {
            g.quotaFallbackRuns.push(run);
            quotaFallbackRuns.push(run);
        } else {
            g.runs.push(run);
        }
    }

    const groups = [];
    for (const g of groupMap.values()) {
        const validRuns = g.runs;
        const n = validRuns.length;
        let acceptancePass = 0;
        let policyViolations = 0;
        let dirtyViolations = 0;

        for (const r of validRuns) {
            if (r.acceptance === "pass") {
                acceptancePass++;
            }
            if (r.policyViolation === true) {
                policyViolations++;
            }
            if (r.dirtyFileViolation === true) {
                dirtyViolations++;
            }
        }

        const metrics = {};
        for (const field of METRIC_FIELDS) {
            const values = validRuns
                .map((r) => field.get(r))
                .filter((v) => typeof v === "number" && Number.isFinite(v));

            const med = median(values);
            const rng = range(values);
            const min = values.length > 0 ? Math.min(...values) : null;
            const max = values.length > 0 ? Math.max(...values) : null;

            metrics[field.id] = {
                median: med,
                range: rng,
                min,
                max
            };
        }

        groups.push({
            task: g.task,
            condition: g.condition,
            n,
            metrics,
            acceptancePass,
            acceptanceTotal: n,
            policyViolations,
            dirtyViolations,
            quotaFallbackRuns: g.quotaFallbackRuns.length
        });
    }

    groups.sort((a, b) => {
        if (a.task !== b.task) {
            return a.task.localeCompare(b.task, undefined, { numeric: true });
        }
        return a.condition.localeCompare(b.condition, undefined, { numeric: true });
    });

    quotaFallbackRuns.sort((a, b) => {
        if (a.task !== b.task) {
            return String(a.task).localeCompare(String(b.task), undefined, { numeric: true });
        }
        if (a.condition !== b.condition) {
            return String(a.condition).localeCompare(String(b.condition), undefined, { numeric: true });
        }
        return (a.run ?? 0) - (b.run ?? 0);
    });

    return {
        groups,
        quotaFallbackRuns,
        totalRuns: runs.length
    };
}

export function renderMarkdown(agg, meta = {}) {
    const isoDate = meta.date || new Date().toISOString();
    const runsDir = meta.runsDir || "<runs-dir>";
    const totalRuns = agg?.totalRuns ?? 0;

    const lines = [];
    lines.push(`Benchmark report \u2014 generated ${isoDate}, ${totalRuns} runs in ${runsDir}`);
    lines.push("");
    lines.push(
        "| Task | Condition | n | TL fresh median | TL fresh range | TL output median | TL cache_read median | Engineer tokens median | Engineer range | Compactions median | Wall-clock s median | Revisions median | Acceptance | Policy viol. | Dirty viol. |"
    );
    lines.push(
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    );

    function fmt(val) {
        if (val === null || val === undefined) return "-";
        return String(val);
    }

    for (const g of agg?.groups || []) {
        const m = g.metrics;
        const row = [
            g.task,
            g.condition,
            g.n,
            fmt(m.tl_fresh?.median),
            m.tl_fresh?.range ?? "-",
            fmt(m.tl_output_tokens?.median),
            fmt(m.tl_cache_read_input_tokens?.median),
            fmt(m.engineer_tokens?.median),
            m.engineer_tokens?.range ?? "-",
            fmt(m.compactions?.median),
            fmt(m.wall_clock_seconds?.median),
            fmt(m.revisions?.median),
            `${g.acceptancePass}/${g.acceptanceTotal}`,
            g.policyViolations,
            g.dirtyViolations
        ];
        lines.push(`| ${row.join(" | ")} |`);
    }

    lines.push("");
    lines.push("### Quota-fallback runs (excluded from the main table)");
    lines.push("");
    lines.push("| Task | Condition | Run | Engineer models | Acceptance |");
    lines.push("| --- | --- | --- | --- | --- |");

    const fallback = agg?.quotaFallbackRuns || [];
    if (fallback.length === 0) {
        lines.push("| (none) | - | - | - | - |");
    } else {
        for (const r of fallback) {
            const models =
                Array.isArray(r.engineer?.models) && r.engineer.models.length > 0
                    ? r.engineer.models.join(", ")
                    : "-";
            lines.push(`| ${r.task} | ${r.condition} | ${r.run ?? "-"} | ${models} | ${r.acceptance ?? "-"} |`);
        }
    }

    lines.push("");
    lines.push(
        "Median and range only; no means. Cells show numbers for this environment, date and task set, not a general claim."
    );
    lines.push("");

    return lines.join("\n");
}

export function renderCsv(agg) {
    const headers = ["task", "condition", "n"];

    for (const field of METRIC_FIELDS) {
        headers.push(`${field.id}_median`, `${field.id}_min`, `${field.id}_max`);
    }

    headers.push(
        "acceptance_pass",
        "acceptance_total",
        "policy_violations",
        "dirty_violations",
        "quota_fallback_runs"
    );

    const rows = [headers.join(",")];

    function fmtCsv(val) {
        if (val === null || val === undefined) return "";
        return String(val);
    }

    for (const g of agg?.groups || []) {
        const row = [g.task, g.condition, g.n];

        for (const field of METRIC_FIELDS) {
            const stat = g.metrics?.[field.id];
            row.push(fmtCsv(stat?.median), fmtCsv(stat?.min), fmtCsv(stat?.max));
        }

        row.push(
            g.acceptancePass,
            g.acceptanceTotal,
            g.policyViolations,
            g.dirtyViolations,
            g.quotaFallbackRuns
        );

        rows.push(row.join(","));
    }

    return `${rows.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)) {
    let values;
    let positionals;
    try {
        ({ values, positionals } = parseArgs({
            args: argv,
            options: {
                out: { type: "string" },
                help: { type: "boolean", default: false }
            },
            strict: true,
            allowPositionals: true
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`report: ${message}\n${USAGE_TEXT}\n`);
        process.exitCode = 1;
        return 1;
    }

    if (values.help) {
        process.stdout.write(`${USAGE_TEXT}\n`);
        return 0;
    }

    if (!positionals || positionals.length === 0 || !positionals[0]) {
        process.stderr.write(`report: missing runs directory\n${USAGE_TEXT}\n`);
        process.exitCode = 1;
        return 1;
    }

    const runsDir = positionals[0];
    if (!existsSync(runsDir) || !statSync(runsDir).isDirectory()) {
        process.stderr.write(`report: runs directory does not exist or is not a directory: ${runsDir}\n`);
        process.exitCode = 1;
        return 1;
    }

    const entries = readdirSync(runsDir);
    const jsonFiles = entries.filter((e) => e.toLowerCase().endsWith(".json")).sort();

    const runs = [];
    for (const file of jsonFiles) {
        const fullPath = path.join(runsDir, file);
        try {
            const raw = readFileSync(fullPath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                runs.push(parsed);
            } else {
                process.stderr.write(`report: warning: ignoring non-object JSON in ${file}\n`);
            }
        } catch {
            process.stderr.write(`report: warning: failed to parse JSON in ${file}\n`);
        }
    }

    const agg = aggregateRuns(runs);
    const markdown = renderMarkdown(agg, { runsDir });
    process.stdout.write(markdown);

    if (values.out) {
        const outDir = path.resolve(values.out);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "report.md"), markdown, "utf8");
        writeFileSync(path.join(outDir, "report.csv"), renderCsv(agg), "utf8");
    }

    return 0;
}

if (isEntrypoint()) {
    const exitCode = main();
    if (exitCode) {
        process.exitCode = exitCode;
    }
}
