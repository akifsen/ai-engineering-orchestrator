#!/usr/bin/env node
/**
 * Print one markdown table row for a delegation cost comparison.
 *
 * The agy `usage` schema is not documented in this repository. The bridge
 * copies `usage` through when present; it does not define the fields.
 * Team Lead token counts are not captured anywhere here. Supply them from
 * your provider's usage page.
 *
 * This script prices nothing unless you pass rates. Results are
 * account-specific. AEO ships no cost meter.
 *
 * Node 20+. ESM. Zero package dependencies.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";

const USAGE_TEXT = [
    "Usage:",
    "  node scripts/measure-delegation.mjs --task \"<name>\" --team-lead-tokens <int> [--agy-json <path>|-] [--engineer-tokens <int>] [--team-lead-rate <usd per 1M tokens>] [--engineer-rate <usd per 1M tokens>] [--without-delegation-tokens <int>] [--header]",
    "",
    "Prints one markdown row:",
    "  | <task> | <tl tokens> | <eng tokens> | <cost with> | <cost without> |",
    "",
    "Missing values print as TODO. Team Lead tokens come from your provider's",
    "usage page. Engineer tokens come from --engineer-tokens or from usage in",
    "--agy-json (an agy envelope or the bridge metadata JSON block)."
].join("\n");

export const TABLE_HEADER_LINES = [
    "| Task | Team Lead tokens | Engineer tokens | Total cost with delegation | Estimated cost without delegation |",
    "| --- | --- | --- | --- | --- |"
];

function isEntrypoint() {
    const invoked = process.argv[1];
    if (!invoked) {
        return false;
    }
    const invokedUrl = invoked.replaceAll("\\", "/");
    const self = import.meta.url.replaceAll("\\", "/");
    return self.endsWith(invokedUrl) || self.endsWith(`/${invokedUrl.split("/").pop()}`);
}

export function extractEngineerTokens(usage) {
    if (usage == null || typeof usage !== "object" || Array.isArray(usage)) {
        return null;
    }
    if (Number.isFinite(usage.total_tokens)) {
        return usage.total_tokens;
    }
    if (Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)) {
        return usage.input_tokens + usage.output_tokens;
    }
    if (Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)) {
        return usage.prompt_tokens + usage.completion_tokens;
    }
    if (Number.isFinite(usage.totalTokens)) {
        return usage.totalTokens;
    }
    return null;
}

export function computeCosts({
    teamLeadTokens,
    engineerTokens,
    teamLeadRate,
    engineerRate,
    withoutDelegationTokens
}) {
    const withDelegation =
        Number.isFinite(teamLeadTokens)
        && Number.isFinite(engineerTokens)
        && Number.isFinite(teamLeadRate)
        && Number.isFinite(engineerRate)
            ? (teamLeadTokens * teamLeadRate / 1e6) + (engineerTokens * engineerRate / 1e6)
            : null;
    const withoutDelegation =
        Number.isFinite(withoutDelegationTokens) && Number.isFinite(teamLeadRate)
            ? withoutDelegationTokens * teamLeadRate / 1e6
            : null;
    return { withDelegation, withoutDelegation };
}

function formatCell(value, kind) {
    if (value === null || value === undefined) {
        return "TODO";
    }
    if (kind === "usd") {
        return `$${Number(value).toFixed(4)}`;
    }
    return String(value);
}

export function formatRow({
    task,
    teamLeadTokens,
    engineerTokens,
    costWith,
    costWithout
}) {
    const escapedTask = String(task).replaceAll("|", "\\|");
    return `| ${escapedTask} | ${formatCell(teamLeadTokens)} | ${formatCell(engineerTokens)} | ${formatCell(costWith, "usd")} | ${formatCell(costWithout, "usd")} |`;
}

function usage() {
    return USAGE_TEXT;
}

function parseNonNegativeInt(raw, flag) {
    if (!/^\d+$/.test(String(raw))) {
        throw new Error(`${flag} must be a non-negative integer.`);
    }
    return Number(raw);
}

function parseNonNegativeNumber(raw, flag) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${flag} must be a non-negative number.`);
    }
    return value;
}

function readJson(source) {
    let raw;
    try {
        raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read --agy-json: ${message}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON in --agy-json: ${message}`);
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid JSON in --agy-json: expected an object.");
    }
    return parsed;
}

function warnMissing(flag) {
    process.stderr.write(`Missing ${flag}; that cell is TODO.\n`);
}

function warnEngineerFromUsage(usage) {
    if (usage == null || typeof usage !== "object" || Array.isArray(usage)) {
        process.stderr.write(
            "Could not extract engineer tokens from usage. Keys found: (none). Pass --engineer-tokens.\n"
        );
        return;
    }
    const keys = Object.keys(usage);
    const listed = keys.length > 0 ? keys.join(", ") : "(none)";
    process.stderr.write(
        `Could not extract engineer tokens from usage. Keys found: ${listed}. Pass --engineer-tokens.\n`
    );
}

export function main(argv = process.argv.slice(2)) {
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                task: { type: "string" },
                "team-lead-tokens": { type: "string" },
                "agy-json": { type: "string" },
                "engineer-tokens": { type: "string" },
                "team-lead-rate": { type: "string" },
                "engineer-rate": { type: "string" },
                "without-delegation-tokens": { type: "string" },
                header: { type: "boolean", default: false },
                help: { type: "boolean", default: false }
            },
            strict: true,
            allowPositionals: false
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n${usage()}\n`);
        return 1;
    }

    if (values.help) {
        process.stdout.write(`${usage()}\n`);
        return 0;
    }

    if (values.task === undefined || values.task === "") {
        process.stderr.write(`Missing --task.\n${usage()}\n`);
        return 1;
    }
    if (values["team-lead-tokens"] === undefined) {
        process.stderr.write(`Missing --team-lead-tokens.\n${usage()}\n`);
        return 1;
    }

    let teamLeadTokens;
    let engineerTokensOverride;
    let withoutDelegationTokens;
    let teamLeadRate;
    let engineerRate;
    try {
        teamLeadTokens = parseNonNegativeInt(values["team-lead-tokens"], "--team-lead-tokens");
        if (values["engineer-tokens"] !== undefined) {
            engineerTokensOverride = parseNonNegativeInt(values["engineer-tokens"], "--engineer-tokens");
        }
        if (values["without-delegation-tokens"] !== undefined) {
            withoutDelegationTokens = parseNonNegativeInt(
                values["without-delegation-tokens"],
                "--without-delegation-tokens"
            );
        }
        if (values["team-lead-rate"] !== undefined) {
            teamLeadRate = parseNonNegativeNumber(values["team-lead-rate"], "--team-lead-rate");
        }
        if (values["engineer-rate"] !== undefined) {
            engineerRate = parseNonNegativeNumber(values["engineer-rate"], "--engineer-rate");
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n${usage()}\n`);
        return 1;
    }

    let usagePayload;
    if (values["agy-json"] !== undefined) {
        try {
            const parsed = readJson(values["agy-json"]);
            usagePayload = parsed.usage;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`${message}\n${usage()}\n`);
            return 1;
        }
    }

    let engineerTokens = engineerTokensOverride;
    if (engineerTokens === undefined) {
        engineerTokens = extractEngineerTokens(usagePayload);
        if (engineerTokens === null) {
            if (values["agy-json"] !== undefined) {
                warnEngineerFromUsage(usagePayload);
            } else {
                warnMissing("--engineer-tokens or --agy-json");
            }
        }
    }

    if (!Number.isFinite(teamLeadRate)) {
        warnMissing("--team-lead-rate");
    }
    if (!Number.isFinite(engineerRate)) {
        warnMissing("--engineer-rate");
    }
    if (!Number.isFinite(withoutDelegationTokens)) {
        warnMissing("--without-delegation-tokens");
    }

    const { withDelegation, withoutDelegation } = computeCosts({
        teamLeadTokens,
        engineerTokens,
        teamLeadRate,
        engineerRate,
        withoutDelegationTokens
    });

    const lines = [];
    if (values.header) {
        lines.push(...TABLE_HEADER_LINES);
    }
    lines.push(formatRow({
        task: values.task,
        teamLeadTokens,
        engineerTokens,
        costWith: withDelegation,
        costWithout: withoutDelegation
    }));
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
}

if (isEntrypoint()) {
    process.exit(main());
}
