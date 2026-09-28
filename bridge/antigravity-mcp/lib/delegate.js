import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
    applyPatch,
    buildPatch,
    createWorktree,
    isValidDelegationId,
    loadDelegation,
    normalizeRepoRoot,
    removeWorktree,
    resolveRepoRoot
} from "./worktree.js";

export const DEFAULT_TIMEOUT_MINUTES = 15;
export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 18;
export const CLI_TIMEOUT = "15m";
export const HARD_TIMEOUT_MS = 16 * 60 * 1000;
export const TERMINATE_GRACE_MS = 10_000;
export const MAX_PROMPT_CHARS = 24_000;
export const MAX_REPORT_CHARS = 120_000;
export const MAX_COLLECT_CHARS = 8_000_000;
export const MAX_COMMAND_CHARS = 30_000;

export const busyDelegations = new Set();

export function makeBusyKey(repoRoot, delegationId) {
    return `${normalizeRepoRoot(repoRoot)}:${delegationId}`;
}

export function formatGraceSeconds(ms) {
    if (ms < 1000) {
        return String(ms / 1000);
    }
    return String(Math.round(ms / 1000));
}

function waitForChildExit(child, graceMs) {
    return new Promise((resolve) => {
        if (!child) {
            resolve(true);
            return;
        }

        if (child.exitCode !== null && child.exitCode !== undefined) {
            resolve(true);
            return;
        }

        let timer = null;
        let cleaned = false;

        const cleanup = (confirmed) => {
            if (cleaned) {
                return;
            }
            cleaned = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            child.removeListener?.("close", onClose);
            child.removeListener?.("exit", onClose);
            resolve(confirmed);
        };

        const onClose = () => cleanup(true);

        child.once?.("close", onClose);
        child.once?.("exit", onClose);

        timer = setTimeout(() => {
            cleanup(false);
        }, graceMs);
    });
}

const EFFORTS = new Set(["low", "medium", "high"]);
const MODEL_SLUG = /^[A-Za-z0-9._:-]+$/;

export function parseDurationMs(value) {
    const match = /^(\d+)(ms|s|m|h)$/.exec(value);
    if (!match) {
        throw new Error(`Unsupported duration: ${value}`);
    }

    const amount = Number(match[1]);
    const unit = match[2];
    const scale = {
        ms: 1,
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000
    };

    return amount * scale[unit];
}

export function resolveTimeouts(env = process.env) {
    const raw = env?.AEO_AGY_TIMEOUT_MINUTES;
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
        return {
            minutes: DEFAULT_TIMEOUT_MINUTES,
            cliTimeout: CLI_TIMEOUT,
            hardTimeoutMs: HARD_TIMEOUT_MS,
            warning: null
        };
    }

    const trimmed = typeof raw === "string" ? raw.trim() : String(raw);
    if (!/^-?\d+$/.test(trimmed)) {
        return {
            minutes: DEFAULT_TIMEOUT_MINUTES,
            cliTimeout: CLI_TIMEOUT,
            hardTimeoutMs: HARD_TIMEOUT_MS,
            warning: `Invalid AEO_AGY_TIMEOUT_MINUTES "${raw}". Falling back to ${DEFAULT_TIMEOUT_MINUTES} minutes.`
        };
    }

    const parsed = Number.parseInt(trimmed, 10);
    const clamped = Math.max(MIN_TIMEOUT_MINUTES, Math.min(MAX_TIMEOUT_MINUTES, parsed));

    return {
        minutes: clamped,
        cliTimeout: `${clamped}m`,
        hardTimeoutMs: (clamped + 1) * 60 * 1000,
        warning: null
    };
}

const startupTimeouts = resolveTimeouts(process.env);
if (startupTimeouts.warning) {
    console.error(startupTimeouts.warning);
}

let firstUseWarned = false;

function warnInvalidTimeout(warning) {
    if (warning && !firstUseWarned) {
        firstUseWarned = true;
        console.error(warning);
    }
}

export function resolveAgyBin(env = process.env) {
    const configured = env.AGY_BIN;
    if (typeof configured === "string" && configured.trim()) {
        return configured.trim();
    }

    return "agy";
}

export function buildImplementationPrompt(prompt) {
    return [
        "You are the Implementation Engineer for this repository.",
        "You are not the Team Lead, and you do not approve your own work.",
        "",
        "Rules:",
        "- Inspect the repository before editing.",
        "- Prefer built-in file read, search, and edit tools over shell commands. In headless mode a shell command outside the allowlist can end the whole run without output.",
        "- Run only the verification commands the assignment names or that are clearly allowed; do not improvise extra shell commands.",
        "- Follow the existing architecture.",
        "- Complete the delegated bounded scope.",
        "- Avoid unrelated modifications.",
        "- Preserve compatibility unless the assignment explicitly changes it.",
        "- Add or update tests when the change needs coverage.",
        "- Run verification where permissions allow.",
        "- Report blocked or unexecuted commands.",
        "- Never claim a test passed unless you actually executed it and it passed.",
        "- Never claim a command ran unless it ran.",
        "- Do not commit, push, reset, rebase, merge, switch branches, or rewrite Git history.",
        "- Do not modify files outside the working directory.",
        "- Report unresolved risks.",
        "",
        "Completion report:",
        "1. Summary",
        "2. Files changed",
        "3. Important implementation decisions",
        "4. Tests / validation executed",
        "5. Actual results",
        "6. Blocked / unexecuted commands",
        "7. Remaining risks",
        "",
        "Assignment:",
        prompt.trim()
    ].join("\n");
}

export function buildAgyArgs({
    prompt,
    model,
    effort,
    cliTimeout = CLI_TIMEOUT
}) {
    const args = [
        "--mode",
        "accept-edits",
        "--output-format",
        "json",
        "--print-timeout",
        cliTimeout
    ];

    if (model) {
        args.push("--model", model);
    }

    if (effort) {
        args.push("--effort", effort);
    }

    args.push("-p", buildImplementationPrompt(prompt));
    return args;
}

export function truncate(text, limit = MAX_REPORT_CHARS) {
    if (!text) {
        return "";
    }

    if (text.length <= limit) {
        return text;
    }

    return `${text.slice(0, limit)}\n\n[Output truncated by the Antigravity MCP bridge]`;
}

export async function validateWorkingDirectory(cwd) {
    if (typeof cwd !== "string" || cwd.trim() === "") {
        throw new Error("cwd is required and must be an absolute directory path.");
    }

    const trimmed = cwd.trim();
    if (!path.isAbsolute(trimmed)) {
        throw new Error(`cwd must be an absolute path. Received: ${trimmed}`);
    }

    let info;
    try {
        info = await stat(trimmed);
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error
            ? error.code
            : "unknown";
        throw new Error(`cwd is not accessible (${code}): ${trimmed}`);
    }

    if (!info.isDirectory()) {
        throw new Error(`cwd is not a directory: ${trimmed}`);
    }

    return path.resolve(trimmed);
}

function normalizeModel(model) {
    if (model === undefined || model === null || model === "") {
        return undefined;
    }

    if (typeof model !== "string" || !MODEL_SLUG.test(model)) {
        throw new Error(
            "model must be a slug made of letters, numbers, dots, underscores, colons, or hyphens."
        );
    }

    return model;
}

function normalizeEffort(effort) {
    if (effort === undefined || effort === null || effort === "") {
        return undefined;
    }

    if (typeof effort !== "string" || !EFFORTS.has(effort)) {
        throw new Error("effort must be one of: low, medium, high.");
    }

    return effort;
}

const ISOLATIONS = new Set(["none", "worktree"]);

export function normalizeIsolation(isolation) {
    if (isolation === undefined || isolation === null || isolation === "") {
        return "none";
    }

    if (typeof isolation !== "string" || !ISOLATIONS.has(isolation)) {
        throw new Error("isolation must be one of: none, worktree.");
    }

    return isolation;
}

function normalizeDelegationId(delegationId, isolation) {
    if (delegationId === undefined || delegationId === null) {
        return undefined;
    }

    if (isolation !== "worktree") {
        throw new Error("delegationId is only valid when isolation is \"worktree\".");
    }

    if (typeof delegationId !== "string" || !isValidDelegationId(delegationId)) {
        throw new Error(`Invalid delegation ID: ${delegationId}`);
    }

    return delegationId;
}

function normalizePrompt(prompt) {
    if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error("prompt is required.");
    }

    const trimmed = prompt.trim();
    if (trimmed.length > MAX_PROMPT_CHARS) {
        throw new Error(
            `prompt exceeds ${MAX_PROMPT_CHARS} characters. Shorten the implementation contract before delegating.`
        );
    }

    return trimmed;
}

function estimateCommandLength(bin, args) {
    const parts = [bin, ...args].map((part) => {
        if (/[\s"]/u.test(part)) {
            return `"${part.replaceAll("\"", "\\\"")}"`;
        }

        return part;
    });

    return parts.join(" ").length;
}

export function parseAgentEnvelope(stdout) {
    const trimmed = stdout.replace(/^\uFEFF/, "").trim();
    if (!trimmed) {
        return { ok: false, error: "Antigravity returned no JSON on stdout." };
    }

    const candidates = [trimmed];
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1) {
        candidates.push(lines[lines.length - 1]);
    }

    let lastError = "Antigravity returned invalid JSON.";
    for (const candidate of candidates) {
        try {
            const value = JSON.parse(candidate);
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                lastError = "Antigravity JSON was not an object.";
                continue;
            }

            return { ok: true, value };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }

    return { ok: false, error: lastError };
}

function outcome({
    outcomeName,
    isError,
    text
}) {
    return {
        outcome: outcomeName,
        isError,
        text
    };
}

function diagnosticBlock(title, body) {
    if (!body) {
        return "";
    }

    return `\n\n---\n${title}:\n${truncate(body)}`;
}

function formatMetadata(payload) {
    const metadata = {
        conversation_id: payload.conversation_id ?? null,
        status: payload.status ?? null,
        duration_seconds: payload.duration_seconds ?? null,
        num_turns: payload.num_turns ?? null,
        usage: payload.usage ?? null
    };

    return JSON.stringify(metadata, null, 2);
}

export function defaultTerminateProcess(child, spawnImpl = spawn) {
    if (!child || child.killed || !child.pid) {
        return;
    }

    try {
        if (process.platform === "win32") {
            const killer = spawnImpl(
                "taskkill",
                ["/PID", String(child.pid), "/T", "/F"],
                {
                    windowsHide: true,
                    stdio: "ignore",
                    shell: false
                }
            );
            killer.unref?.();
            return;
        }

        child.kill("SIGTERM");
    } catch {
        try {
            child.kill();
        } catch {
            // The process is already gone.
        }
    }
}

function errorText(error) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function cliFailure(lines) {
    return outcome({
        outcomeName: "cli_failure",
        isError: true,
        text: ["Outcome: cli_failure", ...lines].join("\n")
    });
}

export function runAntigravity({
    prompt,
    cwd,
    model,
    effort,
    bin,
    cliTimeout = CLI_TIMEOUT,
    hardTimeoutMs = HARD_TIMEOUT_MS,
    terminateGraceMs = TERMINATE_GRACE_MS,
    maxCollectChars = MAX_COLLECT_CHARS,
    spawnImpl = spawn,
    terminateProcess = defaultTerminateProcess,
    log = () => {}
}) {
    const args = buildAgyArgs({
        prompt,
        model,
        effort,
        cliTimeout
    });

    const commandLength = estimateCommandLength(bin, args);
    if (commandLength > MAX_COMMAND_CHARS) {
        return Promise.resolve(cliFailure([
            "The constructed Antigravity command exceeds the safe command-line length.",
            "Shorten the implementation contract and delegate again.",
            `Estimated length: ${commandLength}`,
            `Limit: ${MAX_COMMAND_CHARS}`
        ]));
    }

    log(
        `antigravity-mcp: delegation started cwd=${cwd} model=${model ?? "default"} effort=${effort ?? "default"}`
    );

    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let overflow = false;
        let timedOut = false;
        let hardTimeout = null;

        const finish = (result) => {
            if (settled) {
                return;
            }

            settled = true;
            if (hardTimeout !== null) {
                clearTimeout(hardTimeout);
                hardTimeout = null;
            }
            log(`antigravity-mcp: delegation finished outcome=${result.outcome}`);
            resolve(result);
        };

        let child;
        try {
            child = spawnImpl(bin, args, {
                cwd,
                env: process.env,
                windowsHide: true,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"]
            });
        } catch (error) {
            finish(cliFailure([
                "The Antigravity process could not be started.",
                errorText(error)
            ]));
            return;
        }

        hardTimeout = setTimeout(async () => {
            if (settled || overflow || timedOut) {
                return;
            }
            timedOut = true;
            terminateProcess(child);
            const confirmedExit = await waitForChildExit(child, terminateGraceMs);
            const unconfirmedLine = !confirmedExit
                ? `The process did not confirm exit within ${formatGraceSeconds(terminateGraceMs)}s; files in the working directory may still change.`
                : null;

            finish(outcome({
                outcomeName: "timeout",
                isError: true,
                text: [
                    "Outcome: timeout",
                    `The bridge hard timeout (${Math.round(hardTimeoutMs / 60000)} minutes) elapsed.`,
                    `The CLI print timeout for this run was ${cliTimeout}.`,
                    "The process was terminated. Treat the implementation as not completed.",
                    unconfirmedLine,
                    diagnosticBlock("CLI diagnostics", stderr).trim()
                ].filter(Boolean).join("\n")
            }));
        }, hardTimeoutMs);

        child.stdout?.on("data", async (chunk) => {
            if (settled || overflow || timedOut) {
                return;
            }
            const next = stdout + chunk.toString();
            if (next.length > maxCollectChars) {
                overflow = true;
                if (hardTimeout !== null) {
                    clearTimeout(hardTimeout);
                    hardTimeout = null;
                }
                stdout = next.slice(0, maxCollectChars);
                terminateProcess(child);
                const confirmedExit = await waitForChildExit(child, terminateGraceMs);
                const unconfirmedLine = !confirmedExit
                    ? `The process did not confirm exit within ${formatGraceSeconds(terminateGraceMs)}s; files in the working directory may still change.`
                    : null;

                finish(cliFailure([
                    "Antigravity produced more output than the bridge will collect.",
                    "The process was terminated. Treat the implementation as not completed.",
                    unconfirmedLine,
                    diagnosticBlock("Partial CLI diagnostics", stderr).trim()
                ].filter(Boolean)));
                return;
            }

            stdout = next;
        });

        child.stderr?.on("data", (chunk) => {
            const next = stderr + chunk.toString();
            stderr = next.length > maxCollectChars
                ? next.slice(0, maxCollectChars)
                : next;
        });

        child.on("error", (error) => {
            if (overflow || timedOut) {
                return;
            }
            const missing = error && error.code === "ENOENT";
            finish(cliFailure([
                missing
                    ? `Antigravity command was not found: ${bin}`
                    : "The Antigravity process could not be started.",
                missing
                    ? "Install the Antigravity CLI or set AGY_BIN to the agy executable."
                    : errorText(error),
                diagnosticBlock("CLI diagnostics", stderr).trim()
            ].filter(Boolean)));
        });

        child.on("close", (code) => {
            if (overflow || timedOut) {
                return;
            }

            const parsed = parseAgentEnvelope(stdout);
            const diagnostics = stderr.trim();

            if (code !== 0) {
                finish(cliFailure([
                    `Antigravity exited with code ${code}.`,
                    "This is a CLI or invocation failure, not a completed implementation.",
                    parsed.ok && parsed.value.status
                        ? `Status: ${parsed.value.status}`
                        : "",
                    parsed.ok && parsed.value.error
                        ? `Error: ${truncate(String(parsed.value.error), 4_000)}`
                        : "",
                    !parsed.ok
                        ? `Output parse: ${parsed.error}`
                        : "",
                    diagnosticBlock("CLI diagnostics", diagnostics).trim(),
                    !parsed.ok && stdout.trim()
                        ? diagnosticBlock("Raw stdout", stdout).trim()
                        : ""
                ].filter(Boolean)));
                return;
            }

            if (!parsed.ok) {
                finish(cliFailure([
                    "Antigravity exited 0 but did not return a JSON object.",
                    parsed.error,
                    diagnosticBlock("CLI diagnostics", diagnostics).trim(),
                    diagnosticBlock("Raw stdout", stdout).trim()
                ].filter(Boolean)));
                return;
            }

            const payload = parsed.value;
            if (payload.status !== "SUCCESS") {
                finish(outcome({
                    outcomeName: "agent_failure",
                    isError: true,
                    text: [
                        "Outcome: agent_failure",
                        "The Antigravity CLI exited 0 and returned structured output, so the process started.",
                        "The agent run itself did not succeed. This is not a successful implementation.",
                        `Status: ${payload.status ?? "missing"}`,
                        payload.error
                            ? `Error: ${truncate(String(payload.error), 4_000)}`
                            : "",
                        diagnosticBlock("CLI diagnostics", diagnostics).trim(),
                        "",
                        "Execution metadata:",
                        formatMetadata(payload)
                    ].filter(Boolean).join("\n")
                }));
                return;
            }

            const response = typeof payload.response === "string"
                ? payload.response.trim()
                : "";

            if (!response) {
                let advice = "";
                if (
                    diagnostics.includes('required the "command" permission') ||
                    diagnostics.includes("soft-deny") ||
                    diagnostics.includes("soft-denied")
                ) {
                    advice = [
                        "",
                        "Likely cause:",
                        "A shell command was denied by the Antigravity permission policy.",
                        "",
                        "Next step:",
                        "Tell the engineer exactly which commands it may run, or add a narrow allow rule in ~/.gemini/antigravity-cli/settings.json (docs/permissions.md)."
                    ].join("\n");
                } else if (diagnostics.includes("print timeout")) {
                    advice = [
                        "",
                        "Likely cause:",
                        "The print timeout elapsed; partial edits may exist on disk — compare git status with the baseline before retrying.",
                        "",
                        "Next step:",
                        "Split the assignment into smaller sequential delegations."
                    ].join("\n");
                }

                finish(outcome({
                    outcomeName: "agent_failure",
                    isError: true,
                    text: [
                        "Outcome: agent_failure",
                        "Antigravity reported SUCCESS but returned an empty response.",
                        "Treat the implementation as not completed.",
                        diagnosticBlock("CLI diagnostics", diagnostics).trim(),
                        "",
                        "Execution metadata:",
                        formatMetadata(payload),
                        advice
                    ].filter(Boolean).join("\n")
                }));
                return;
            }

            finish(outcome({
                outcomeName: "agent_success",
                isError: false,
                text: [
                    "Outcome: agent_success",
                    "The implementation engineer finished a run. This report is evidence for the Team Lead. It is not approval.",
                    "",
                    truncate(response),
                    "",
                    "---",
                    "Execution metadata:",
                    formatMetadata(payload),
                    diagnostics
                        ? diagnosticBlock("CLI diagnostics", diagnostics).trim()
                        : ""
                ].filter(Boolean).join("\n")
            }));
        });
    });
}

export async function delegateToAntigravity(input, dependencies = {}) {
    try {
        const prompt = normalizePrompt(input?.prompt);
        const cwd = await validateWorkingDirectory(input?.cwd);
        const model = normalizeModel(input?.model);
        const effort = normalizeEffort(input?.effort);
        const isolation = normalizeIsolation(input?.isolation);
        const delegationId = normalizeDelegationId(input?.delegationId, isolation);
        const bin = dependencies.bin ?? resolveAgyBin(dependencies.env);
        const timeouts = resolveTimeouts(dependencies.env);
        warnInvalidTimeout(timeouts.warning);
        const cliTimeout = dependencies.cliTimeout ?? timeouts.cliTimeout;
        const hardTimeoutMs = dependencies.hardTimeoutMs ?? timeouts.hardTimeoutMs;
        const terminateGraceMs = dependencies.terminateGraceMs ?? TERMINATE_GRACE_MS;

        if (isolation === "none") {
            return await runAntigravity({
                cliTimeout,
                hardTimeoutMs,
                terminateGraceMs,
                ...dependencies,
                prompt,
                cwd,
                model,
                effort,
                bin
            });
        }

        const gitSpawnImpl = dependencies.gitSpawnImpl ?? spawn;
        const env = dependencies.env ?? process.env;
        const worktreeDeps = dependencies.worktree ?? {};
        const createWorktreeImpl = worktreeDeps.createWorktree ?? createWorktree;
        const loadDelegationImpl = worktreeDeps.loadDelegation ?? loadDelegation;
        const buildPatchImpl = worktreeDeps.buildPatch ?? buildPatch;

        let delegationContext;
        const isRevision = Boolean(delegationId);
        let busyKey = null;

        if (isRevision) {
            const loadRes = await loadDelegationImpl({
                cwd,
                delegationId,
                env,
                spawnImpl: gitSpawnImpl
            });

            if (!loadRes.ok) {
                return outcome({
                    outcomeName: "validation_failure",
                    isError: true,
                    text: [
                        "Outcome: validation_failure",
                        "The bridge rejected the delegation before starting Antigravity.",
                        loadRes.error
                    ].join("\n")
                });
            }

            const candidateKey = makeBusyKey(loadRes.repoRoot, delegationId);
            if (busyDelegations.has(candidateKey)) {
                return outcome({
                    outcomeName: "validation_failure",
                    isError: true,
                    text: [
                        "Outcome: validation_failure",
                        "The bridge rejected the delegation before starting Antigravity.",
                        `Delegation ${delegationId} is already running; wait for it to finish before revising it.`
                    ].join("\n")
                });
            }

            busyKey = candidateKey;
            busyDelegations.add(busyKey);

            delegationContext = {
                delegationId: loadRes.delegationId,
                repoRoot: loadRes.repoRoot,
                worktreePath: loadRes.worktreePath,
                baseCommit: loadRes.baseCommit,
                patchPath: loadRes.patchPath,
                mainTreeStatus: null
            };
        } else {
            const creation = await createWorktreeImpl({
                cwd,
                env,
                spawnImpl: gitSpawnImpl
            });

            if (!creation.ok) {
                return outcome({
                    outcomeName: "validation_failure",
                    isError: true,
                    text: [
                        "Outcome: validation_failure",
                        "The bridge rejected the delegation before starting Antigravity.",
                        creation.error
                    ].join("\n")
                });
            }

            busyKey = makeBusyKey(creation.repoRoot, creation.delegationId);
            busyDelegations.add(busyKey);

            delegationContext = {
                delegationId: creation.delegationId,
                repoRoot: creation.repoRoot,
                worktreePath: creation.worktreePath,
                baseCommit: creation.baseCommit,
                patchPath: creation.patchPath,
                mainTreeStatus: creation.mainTreeStatus
            };
        }

        try {
            const agyResult = await runAntigravity({
                cliTimeout,
                hardTimeoutMs,
                terminateGraceMs,
                ...dependencies,
                prompt,
                cwd: delegationContext.worktreePath,
                model,
                effort,
                bin
            });

            let patchRes;
            try {
                patchRes = await buildPatchImpl({
                    worktreePath: delegationContext.worktreePath,
                    patchPath: delegationContext.patchPath,
                    spawnImpl: gitSpawnImpl
                });
            } catch (error) {
                patchRes = { ok: false, error: errorText(error) };
            }

            const isolationLines = [
                "---",
                "Isolation: worktree",
                `Delegation ID: ${delegationContext.delegationId}`,
                `Worktree: ${delegationContext.worktreePath}`,
                `Base commit: ${delegationContext.baseCommit}`,
                `Patch: ${delegationContext.patchPath}`,
                "Main tree was not modified by this run. Nothing lands in the main tree until apply_delegation."
            ];

            if (patchRes.ok) {
                isolationLines.push("Changes:");
                isolationLines.push(patchRes.hasChanges ? (patchRes.diffstat || "No changes.") : "No changes.");
            } else {
                isolationLines.push(`Patch generation failed: ${patchRes.error}`);
            }

            if (!isRevision) {
                isolationLines.push("Main tree status at worktree creation:");
                isolationLines.push(delegationContext.mainTreeStatus ? delegationContext.mainTreeStatus : "clean");
            }

            isolationLines.push("Next: review with the patch/worktree, then call apply_delegation or discard_delegation with this delegation ID.");

            const isError = !patchRes.ok ? true : agyResult.isError;
            const text = `${agyResult.text}\n\n${isolationLines.join("\n")}`;

            return {
                outcome: agyResult.outcome,
                isError,
                text,
                delegation: {
                    delegationId: delegationContext.delegationId,
                    worktreePath: delegationContext.worktreePath,
                    baseCommit: delegationContext.baseCommit,
                    patchPath: delegationContext.patchPath,
                    hasChanges: Boolean(patchRes.ok && patchRes.hasChanges)
                }
            };
        } finally {
            if (busyKey !== null) {
                busyDelegations.delete(busyKey);
            }
        }
    } catch (error) {
        return outcome({
            outcomeName: "validation_failure",
            isError: true,
            text: [
                "Outcome: validation_failure",
                "The bridge rejected the delegation before starting Antigravity.",
                errorText(error)
            ].join("\n")
        });
    }
}

export async function applyDelegation(input, dependencies = {}) {
    try {
        const delegationId = input?.delegationId;
        if (!isValidDelegationId(delegationId)) {
            return outcome({
                outcomeName: "validation_failure",
                isError: true,
                text: [
                    "Outcome: validation_failure",
                    "The bridge rejected the delegation request.",
                    `Invalid delegation ID: ${delegationId}`
                ].join("\n")
            });
        }

        let validatedCwd;
        try {
            validatedCwd = await validateWorkingDirectory(input?.cwd);
        } catch (error) {
            return outcome({
                outcomeName: "validation_failure",
                isError: true,
                text: [
                    "Outcome: validation_failure",
                    "The bridge rejected the delegation request.",
                    errorText(error)
                ].join("\n")
            });
        }

        const gitSpawnImpl = dependencies.gitSpawnImpl ?? spawn;
        const env = dependencies.env ?? process.env;
        const worktreeDeps = dependencies.worktree ?? {};
        const loadDelegationImpl = worktreeDeps.loadDelegation ?? loadDelegation;
        const applyPatchImpl = worktreeDeps.applyPatch ?? applyPatch;

        const loadRes = await loadDelegationImpl({
            cwd: validatedCwd,
            delegationId,
            env,
            spawnImpl: gitSpawnImpl
        });

        if (!loadRes.ok) {
            return outcome({
                outcomeName: "validation_failure",
                isError: true,
                text: [
                    "Outcome: validation_failure",
                    "The bridge rejected the delegation request.",
                    loadRes.error
                ].join("\n")
            });
        }

        const busyKey = makeBusyKey(loadRes.repoRoot, delegationId);
        if (busyDelegations.has(busyKey)) {
            return outcome({
                outcomeName: "validation_failure",
                isError: true,
                text: [
                    "Outcome: validation_failure",
                    "The bridge rejected the delegation request.",
                    `Delegation ${delegationId} is already running; wait for it to finish before applying it.`
                ].join("\n")
            });
        }

        const applyRes = await applyPatchImpl({
            repoRoot: loadRes.repoRoot,
            patchPath: loadRes.patchPath,
            spawnImpl: gitSpawnImpl
        });

        if (applyRes.outcome === "apply_conflict") {
            return outcome({
                outcomeName: "apply_conflict",
                isError: true,
                text: [
                    "Outcome: apply_conflict",
                    `The main tree moved or overlaps since base commit ${loadRes.baseCommit}.`,
                    "This is not a revision; discard and re-delegate against the current HEAD or reconcile manually.",
                    "",
                    "Git diagnostics:",
                    applyRes.error
                ].filter(Boolean).join("\n")
            });
        }

        if (applyRes.outcome === "apply_error" || !applyRes.ok) {
            return outcome({
                outcomeName: "apply_error",
                isError: true,
                text: [
                    "Outcome: apply_error",
                    `Failed to apply delegation ${delegationId}:`,
                    applyRes.error
                ].filter(Boolean).join("\n")
            });
        }

        if (applyRes.applied === false || applyRes.reason === "no changes") {
            return outcome({
                outcomeName: "no_changes",
                isError: false,
                text: [
                    "Outcome: no_changes",
                    `Delegation ${delegationId} has no changes to apply.`
                ].join("\n")
            });
        }

        return outcome({
            outcomeName: "applied",
            isError: false,
            text: [
                "Outcome: applied",
                `Delegation ${delegationId} applied successfully.`,
                "Changes are now unstaged in the main working tree.",
                "Team Lead must diff and re-run tests.",
                "The worktree still exists until discard_delegation."
            ].join("\n")
        });
    } catch (error) {
        return outcome({
            outcomeName: "apply_error",
            isError: true,
            text: [
                "Outcome: apply_error",
                "An unexpected error occurred while applying the delegation.",
                errorText(error)
            ].join("\n")
        });
    }
}

export async function discardDelegation(input, dependencies = {}) {
    try {
        const delegationId = input?.delegationId;
        if (!isValidDelegationId(delegationId)) {
            return outcome({
                outcomeName: "validation_failure",
                isError: true,
                text: [
                    "Outcome: validation_failure",
                    "The bridge rejected the discard request.",
                    `Invalid delegation ID: ${delegationId}`
                ].join("\n")
            });
        }

        let validatedCwd;
        try {
            validatedCwd = await validateWorkingDirectory(input?.cwd);
        } catch (error) {
            return outcome({
                outcomeName: "validation_failure",
                isError: true,
                text: [
                    "Outcome: validation_failure",
                    "The bridge rejected the discard request.",
                    errorText(error)
                ].join("\n")
            });
        }

        const gitSpawnImpl = dependencies.gitSpawnImpl ?? spawn;
        const env = dependencies.env ?? process.env;
        const worktreeDeps = dependencies.worktree ?? {};
        const resolveRepoRootImpl = worktreeDeps.resolveRepoRoot ?? resolveRepoRoot;
        const loadDelegationImpl = worktreeDeps.loadDelegation ?? loadDelegation;
        const removeWorktreeImpl = worktreeDeps.removeWorktree ?? removeWorktree;

        const repoRes = await resolveRepoRootImpl(validatedCwd, { spawnImpl: gitSpawnImpl });
        if (!repoRes.ok) {
            return outcome({
                outcomeName: "validation_failure",
                isError: true,
                text: [
                    "Outcome: validation_failure",
                    "The bridge rejected the discard request.",
                    repoRes.error
                ].join("\n")
            });
        }

        let repoRoot = repoRes.repoRoot;
        const busyKey = makeBusyKey(repoRoot, delegationId);
        if (busyDelegations.has(busyKey)) {
            return outcome({
                outcomeName: "validation_failure",
                isError: true,
                text: [
                    "Outcome: validation_failure",
                    "The bridge rejected the discard request.",
                    `Delegation ${delegationId} is already running; wait for it to finish before discarding it.`
                ].join("\n")
            });
        }

        const loadRes = await loadDelegationImpl({
            cwd: validatedCwd,
            delegationId,
            env,
            spawnImpl: gitSpawnImpl
        });

        if (loadRes.ok) {
            repoRoot = loadRes.repoRoot;
        } else if (
            loadRes.reason === "missing_worktree" ||
            (!loadRes.reason && loadRes.error && loadRes.error.startsWith("Missing worktree directory"))
        ) {
            if (loadRes.repoRoot) {
                repoRoot = loadRes.repoRoot;
            }
        } else {
            return outcome({
                outcomeName: "validation_failure",
                isError: true,
                text: [
                    "Outcome: validation_failure",
                    "The bridge rejected the discard request.",
                    loadRes.error
                ].join("\n")
            });
        }

        const removeRes = await removeWorktreeImpl({
            repoRoot,
            delegationId,
            env,
            spawnImpl: gitSpawnImpl
        });

        if (!removeRes.ok) {
            return outcome({
                outcomeName: "discard_error",
                isError: true,
                text: [
                    "Outcome: discard_error",
                    `Failed to discard delegation ${delegationId}:`,
                    removeRes.error
                ].filter(Boolean).join("\n")
            });
        }

        return outcome({
            outcomeName: "discarded",
            isError: false,
            text: [
                "Outcome: discarded",
                `Delegation ${delegationId} discarded.`
            ].join("\n")
        });
    } catch (error) {
        return outcome({
            outcomeName: "discard_error",
            isError: true,
            text: [
                "Outcome: discard_error",
                "An unexpected error occurred while discarding the delegation.",
                errorText(error)
            ].join("\n")
        });
    }
}
