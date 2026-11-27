#!/usr/bin/env node
/**
 * Benchmark cell preflight verification.
 *
 * Verifies repository commit, dirty-state baseline, Claude configuration,
 * and orchestration rules for benchmark conditions (K0, K1, K2).
 *
 * Node 20+. ESM. Zero package dependencies.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

export const USAGE_TEXT = [
    "Usage:",
    "  node scripts/bench/preflight.mjs --repo <path> --commit <sha> --condition <K0|K1|K2> --config-dir <path> [--expect-dirty <relative-path>]...",
    "",
    "Verifies a benchmark cell is set up correctly for the given condition."
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

export function normalizePath(p) {
    if (!p || typeof p !== "string") {
        return "";
    }
    let normalized = p.replaceAll("\\", "/");
    normalized = normalized.replace(/\/+$/, "");
    return normalized.toLowerCase();
}

export function defaultGit(args) {
    try {
        const res = spawnSync("git", args, { encoding: "utf8" });
        return {
            status: res.status ?? 1,
            stdout: res.stdout || "",
            stderr: res.stderr || ""
        };
    } catch (err) {
        return {
            status: 1,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err)
        };
    }
}

export function collectConfiguredServers(configDir, repo) {
    const servers = new Set();

    if (configDir) {
        const claudeJsonPath = path.join(configDir, ".claude.json");
        if (existsSync(claudeJsonPath)) {
            try {
                const parsed = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
                if (parsed && typeof parsed === "object") {
                    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
                        for (const key of Object.keys(parsed.mcpServers)) {
                            servers.add(key);
                        }
                    }
                    if (parsed.projects && typeof parsed.projects === "object" && repo) {
                        const normRepo = normalizePath(repo);
                        for (const [projectKey, projectObj] of Object.entries(parsed.projects)) {
                            if (normalizePath(projectKey) === normRepo) {
                                if (
                                    projectObj &&
                                    typeof projectObj === "object" &&
                                    projectObj.mcpServers &&
                                    typeof projectObj.mcpServers === "object"
                                ) {
                                    for (const key of Object.keys(projectObj.mcpServers)) {
                                        servers.add(key);
                                    }
                                }
                            }
                        }
                    }
                }
            } catch {
                // missing or unparsable counts as no servers
            }
        }
    }

    if (repo) {
        const mcpJsonPath = path.join(repo, ".mcp.json");
        if (existsSync(mcpJsonPath)) {
            try {
                const parsed = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
                if (
                    parsed &&
                    typeof parsed === "object" &&
                    parsed.mcpServers &&
                    typeof parsed.mcpServers === "object"
                ) {
                    for (const key of Object.keys(parsed.mcpServers)) {
                        servers.add(key);
                    }
                }
            } catch {
                // missing or unparsable counts as no servers
            }
        }
    }

    servers.includes = (val) => servers.has(val);
    return servers;
}

export function runPreflight({
    repo,
    commit,
    condition,
    configDir,
    expectDirty = [],
    env = process.env,
    git = defaultGit
}) {
    const failures = [];
    const warnings = [];
    let shortSha = "";

    // a. --repo is a directory and git -C <repo> rev-parse HEAD succeeds
    let isRepoDir = false;
    try {
        isRepoDir = repo ? statSync(repo).isDirectory() : false;
    } catch {
        isRepoDir = false;
    }

    if (!isRepoDir) {
        failures.push(`--repo is not a directory: ${repo}`);
    } else {
        const revResult = git(["-C", repo, "rev-parse", "HEAD"]);
        if (revResult.status !== 0 || !revResult.stdout) {
            failures.push(`git rev-parse HEAD failed: ${revResult.stderr?.trim() || "status " + revResult.status}`);
        } else {
            const head = revResult.stdout.trim();
            shortSha = head.slice(0, 7);
            const trimmedCommit = typeof commit === "string" ? commit.trim() : "";
            if (!/^[0-9a-fA-F]{7,}$/.test(trimmedCommit)) {
                failures.push(`--commit must be a SHA prefix of at least 7 hex characters: got "${commit}"`);
            } else if (!head.toLowerCase().startsWith(trimmedCommit.toLowerCase())) {
                failures.push(`commit mismatch: HEAD (${head.slice(0, 7)}) does not match expected commit (${trimmedCommit})`);
            }
        }
    }

    // b. git -C <repo> status --short --untracked-files=all
    if (isRepoDir) {
        const statusResult = git(["-C", repo, "status", "--short", "--untracked-files=all"]);
        if (statusResult.status !== 0) {
            failures.push(`git status failed: ${statusResult.stderr?.trim() || "status " + statusResult.status}`);
        } else {
            const rawLines = (statusResult.stdout || "")
                .split(/\r?\n/)
                .filter((l) => l.trim().length > 0);

            const actualDirty = [];
            for (const line of rawLines) {
                let pathPart = line.length >= 3 ? line.slice(3).trim() : line.trim();
                pathPart = pathPart.replace(/^"|"$/g, "");
                actualDirty.push(pathPart.replaceAll("\\", "/"));
            }

            const expectedDirty = (Array.isArray(expectDirty) ? expectDirty : [expectDirty])
                .map((p) => (typeof p === "string" ? p.trim().replaceAll("\\", "/") : ""))
                .filter(Boolean);

            const actualSet = new Set(actualDirty);
            const expectedSet = new Set(expectedDirty);

            const extra = [...actualSet].filter((p) => !expectedSet.has(p)).sort();
            const missing = [...expectedSet].filter((p) => !actualSet.has(p)).sort();

            if (extra.length > 0) {
                failures.push(`dirty working tree: extra unexpected modified/untracked files: ${extra.join(", ")}`);
            }
            if (missing.length > 0) {
                failures.push(`dirty working tree: missing expected dirty files: ${missing.join(", ")}`);
            }
        }
    }

    // c. --config-dir must be a directory
    let isConfigDir = false;
    try {
        isConfigDir = configDir ? statSync(configDir).isDirectory() : false;
    } catch {
        isConfigDir = false;
    }

    if (!isConfigDir) {
        failures.push(`--config-dir is not a directory: ${configDir}`);
    }

    // Collect servers
    const servers = collectConfiguredServers(configDir, repo);

    // d. Condition rules
    const rulesFileExists = repo ? existsSync(path.join(repo, ".claude", "rules", "aeo-orchestration.md")) : false;

    if (condition === "K0") {
        const forbiddenServers = ["aeo-antigravity", "aeo-cursor"].filter((s) => servers.has(s));
        if (forbiddenServers.length > 0) {
            failures.push(`condition K0 forbids configured servers: ${forbiddenServers.join(", ")}`);
        }
        if (rulesFileExists) {
            failures.push("condition K0 requires .claude/rules/aeo-orchestration.md to NOT exist");
        }
    } else if (condition === "K1" || condition === "K2") {
        const missingServers = ["aeo-antigravity", "aeo-cursor"].filter((s) => !servers.has(s));
        if (missingServers.length > 0) {
            failures.push(`condition ${condition} requires configured servers: ${missingServers.join(", ")}`);
        }
        if (!rulesFileExists) {
            failures.push(`condition ${condition} requires .claude/rules/aeo-orchestration.md to exist`);
        }
    } else {
        failures.push(`unknown condition: ${condition} (must be K0, K1, or K2)`);
    }

    // e. Warn on CLAUDE_CONFIG_DIR
    const envClaudeConfigDir = env?.CLAUDE_CONFIG_DIR;
    if (!envClaudeConfigDir) {
        warnings.push("CLAUDE_CONFIG_DIR in the current environment is unset");
    } else if (normalizePath(envClaudeConfigDir) !== normalizePath(configDir)) {
        warnings.push(`CLAUDE_CONFIG_DIR ("${envClaudeConfigDir}") differs from --config-dir ("${configDir}")`);
    }

    return {
        ok: failures.length === 0,
        failures,
        warnings,
        shortSha
    };
}

export function main(argv = process.argv.slice(2)) {
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                repo: { type: "string" },
                commit: { type: "string" },
                condition: { type: "string" },
                "config-dir": { type: "string" },
                "expect-dirty": { type: "string", multiple: true, default: [] },
                help: { type: "boolean", default: false }
            },
            strict: true,
            allowPositionals: false
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`preflight: ${message}\n${USAGE_TEXT}\n`);
        process.exitCode = 1;
        return 1;
    }

    if (values.help) {
        process.stdout.write(`${USAGE_TEXT}\n`);
        return 0;
    }

    const missing = [];
    if (!values.repo) missing.push("--repo");
    if (!values.commit) missing.push("--commit");
    if (!values.condition) missing.push("--condition");
    if (!values["config-dir"]) missing.push("--config-dir");

    if (missing.length > 0) {
        process.stderr.write(`preflight: missing required arguments: ${missing.join(", ")}\n${USAGE_TEXT}\n`);
        process.exitCode = 1;
        return 1;
    }

    const result = runPreflight({
        repo: values.repo,
        commit: values.commit,
        condition: values.condition,
        configDir: values["config-dir"],
        expectDirty: values["expect-dirty"],
        env: process.env,
        git: defaultGit
    });

    for (const w of result.warnings) {
        process.stderr.write(`preflight: warning: ${w}\n`);
    }

    if (!result.ok) {
        for (const f of result.failures) {
            process.stderr.write(`preflight: ${f}\n`);
        }
        process.exitCode = 1;
        return 1;
    }

    const shaDisplay = result.shortSha || values.commit.slice(0, 7);
    process.stdout.write(`preflight: ok (${values.condition}, ${shaDisplay})\n`);
    return 0;
}

if (isEntrypoint()) {
    const exitCode = main();
    if (exitCode) {
        process.exitCode = exitCode;
    }
}
