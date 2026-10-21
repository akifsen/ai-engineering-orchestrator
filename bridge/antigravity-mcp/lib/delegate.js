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
    resolveRepoRoot,
    resolveWorktreeTtlMs,
    sweepStaleDelegations,
    touchDelegation
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
export const DEFAULT_FALLBACK_MODELS = ["gemini-3.8-flash-high"];
const MODEL_ENCODES_EFFORT_REGEX = /-(low|medium|high|xhigh|max)$/i;

export function modelEncodesEffort(slug) {
    if (typeof slug !== "string") {
        return false;
    }
    return MODEL_ENCODES_EFFORT_REGEX.test(slug.trim());
}
const QUOTA_REGEX = /quota (reached|exceeded)|resource_exhausted|\b429\b|rate[ -]limit/i;
const AUTH_REGEX = /not logged in(to)?|login required|authentication (required|failed)|unauthenticated/i;

export const FALLBACK_DIRTY_WORKSPACE_NOTE =
    "Note: a previous attempt with another model may have partially edited this working tree before hitting a quota limit. Inspect git status and the files first and continue from the current state; do not redo completed work.";

function stdoutNonJsonText(stdoutText) {
    if (typeof stdoutText !== "string" || !stdoutText.trim()) {
        return "";
    }

    const lines = [];
    for (const line of stdoutText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                JSON.parse(trimmed);
                continue;
            } catch {
                // not a JSON line — include for classification
            }
        }
        lines.push(trimmed);
    }

    return lines.join("\n");
}

let firstFallbackWarned = false;

function warnInvalidFallbackSlug(slug) {
    if (!firstFallbackWarned) {
        firstFallbackWarned = true;
        console.error(`Invalid model slug in AEO_AGY_FALLBACK_MODELS "${slug}". Dropping entry.`);
    }
}

export function resolveFallbackModels(env = process.env) {
    const raw = env?.AEO_AGY_FALLBACK_MODELS;
    if (raw === undefined || raw === null) {
        return [...DEFAULT_FALLBACK_MODELS];
    }

    const trimmed = typeof raw === "string" ? raw.trim() : String(raw);
    if (trimmed === "" || trimmed.toLowerCase() === "none") {
        return [];
    }

    const entries = trimmed.split(",").map((entry) => entry.trim()).filter(Boolean);
    const valid = [];
    for (const entry of entries) {
        if (MODEL_SLUG.test(entry)) {
            valid.push(entry);
        } else {
            warnInvalidFallbackSlug(entry);
        }
    }

    return valid;
}

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

export function parseAgyErrorLine(stderr) {
    if (typeof stderr !== "string" || !stderr.trim()) {
        return null;
    }

    const lines = stderr.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        const match = /^AGY_ERROR:\s*(.+)$/.exec(line);
        if (match) {
            try {
                const parsed = JSON.parse(match[1].trim());
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    return parsed;
                }
            } catch {
                // try earlier AGY_ERROR lines
            }
        }
    }

    return null;
}

export function extractResetHint(text) {
    if (typeof text !== "string" || !text) {
        return null;
    }
    const match = /(Resets in [^\r\n.;",]+)/i.exec(text);
    return match ? match[1].trim() : null;
}

export function classifyAgyFailure({ stderr, stdout, payload } = {}) {
    const stderrText = typeof stderr === "string" ? stderr : "";
    const payloadErrorText = payload && payload.error ? String(payload.error) : "";
    const stdoutFallbackText = payload == null ? stdoutNonJsonText(stdout) : "";

    const agyError = parseAgyErrorLine(stderrText);

    const isAgyQuota = Boolean(
        agyError && (
            agyError.status === "RESOURCE_EXHAUSTED" ||
            agyError.error_code === 429 ||
            agyError.error_code === "429"
        )
    );

    const isTextQuota = Boolean(
        QUOTA_REGEX.test(stderrText) ||
        QUOTA_REGEX.test(payloadErrorText) ||
        (stdoutFallbackText && QUOTA_REGEX.test(stdoutFallbackText))
    );

    if (isAgyQuota || isTextQuota) {
        return "quota";
    }

    const isAgyAuth = Boolean(
        agyError && (
            agyError.status === "UNAUTHENTICATED" ||
            agyError.status === "PERMISSION_DENIED"
        )
    );

    const isTextAuth = Boolean(
        AUTH_REGEX.test(stderrText) ||
        AUTH_REGEX.test(payloadErrorText) ||
        (stdoutFallbackText && AUTH_REGEX.test(stdoutFallbackText))
    );

    if (isAgyAuth || isTextAuth) {
        return "auth";
    }

    return null;
}

function extractCliErrorMessage({ payload, stderr, stdout }) {
    if (payload && payload.error) {
        return truncate(String(payload.error), 4000);
    }
    const agyError = parseAgyErrorLine(stderr);
    if (agyError && agyError.short_error) {
        return truncate(String(agyError.short_error), 4000);
    }
    if (typeof stderr === "string" && stderr.trim()) {
        const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const errLine = lines.find((l) => /^error:\s*/i.test(l));
        if (errLine) {
            return truncate(errLine.replace(/^error:\s*/i, ""), 4000);
        }
        const nonAgy = lines.find((l) => !l.startsWith("AGY_ERROR:"));
        if (nonAgy) {
            return truncate(nonAgy, 4000);
        }
    }
    if (typeof stdout === "string" && stdout.trim()) {
        const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0) {
            return truncate(lines[0], 4000);
        }
    }
    return null;
}

function insertLinesAfterOutcome(text, linesToInsert) {
    if (!linesToInsert || linesToInsert.length === 0) {
        return text;
    }
    const lines = text.split(/\r?\n/);
    const outcomeIdx = lines.findIndex((l) => l.startsWith("Outcome:"));
    if (outcomeIdx === -1) {
        return [...linesToInsert, text].join("\n");
    }
    lines.splice(outcomeIdx + 1, 0, ...linesToInsert);
    return lines.join("\n");
}

export function formatMetadata(payload, model = null) {
    const metadata = {
        model: model ?? null,
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
            if (!result.attempts) {
                result.modelUsed = model ?? null;
                result.attempts = [
                    {
                        model: model ?? null,
                        outcome: result.outcome,
                        failureKind: result.failureKind ?? null
                    }
                ];
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

            const timeoutOutcome = outcome({
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
            });
            if (!confirmedExit) {
                timeoutOutcome.exitUnconfirmed = true;
            }
            finish(timeoutOutcome);
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

                const overflowOutcome = cliFailure([
                    "Antigravity produced more output than the bridge will collect.",
                    "The process was terminated. Treat the implementation as not completed.",
                    unconfirmedLine,
                    diagnosticBlock("Partial CLI diagnostics", stderr).trim()
                ].filter(Boolean));
                if (!confirmedExit) {
                    overflowOutcome.exitUnconfirmed = true;
                }
                finish(overflowOutcome);
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
            const payloadCandidate = parsed.ok ? parsed.value : null;

            const isFailure = code !== 0 || (code === 0 && (!parsed.ok || payloadCandidate?.status !== "SUCCESS"));
            if (isFailure) {
                const failureKind = classifyAgyFailure({ stderr, stdout, payload: payloadCandidate });
                if (failureKind === "quota" || failureKind === "auth") {
                    const cliErrorMessage = extractCliErrorMessage({ payload: payloadCandidate, stderr, stdout });
                    const resetHint = extractResetHint(payloadCandidate?.error) || extractResetHint(stderr) || extractResetHint(stdout);

                    const textParts = [
                        "Outcome: quota_or_auth_failure",
                        `Kind: ${failureKind}`,
                        `Model: ${model ?? "default"}`
                    ];

                    if (cliErrorMessage) {
                        textParts.push(cliErrorMessage);
                    }

                    if (resetHint) {
                        textParts.push(resetHint.endsWith(".") ? resetHint : `${resetHint}.`);
                    }

                    if (diagnostics) {
                        textParts.push(diagnosticBlock("CLI diagnostics", diagnostics).trim());
                    }

                    if (payloadCandidate) {
                        textParts.push("");
                        textParts.push("Execution metadata:");
                        textParts.push(formatMetadata(payloadCandidate, model));
                    }

                    const failureOutcome = outcome({
                        outcomeName: "quota_or_auth_failure",
                        isError: true,
                        text: textParts.filter(Boolean).join("\n")
                    });
                    failureOutcome.failureKind = failureKind;
                    failureOutcome.resetHint = resetHint;
                    failureOutcome.modelUsed = model ?? null;
                    failureOutcome.attempts = [
                        {
                            model: model ?? null,
                            outcome: "quota_or_auth_failure",
                            failureKind
                        }
                    ];

                    finish(failureOutcome);
                    return;
                }
            }

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
                        formatMetadata(payload, model)
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
                        formatMetadata(payload, model),
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
                    formatMetadata(payload, model),
                    diagnostics
                        ? diagnosticBlock("CLI diagnostics", diagnostics).trim()
                        : ""
                ].filter(Boolean).join("\n")
            }));
        });
    });
}

export async function runWithModelFallback({
    prompt,
    cwd,
    model: initialModel,
    effort,
    bin,
    cliTimeout: initialCliTimeout,
    hardTimeoutMs: initialHardTimeoutMs,
    terminateGraceMs,
    ...dependencies
}) {
    const env = dependencies.env ?? process.env;
    const log = dependencies.log ?? (() => {});
    const hardTimeoutMs = initialHardTimeoutMs ?? HARD_TIMEOUT_MS;
    const cliTimeout = initialCliTimeout ?? CLI_TIMEOUT;
    const fallbackList = resolveFallbackModels(env);

    const candidateFallbacks = [];
    for (const fb of fallbackList) {
        if (fb === initialModel) {
            continue;
        }
        if (!candidateFallbacks.includes(fb)) {
            candidateFallbacks.push(fb);
        }
    }

    const attempts = [];
    const fallbackLines = [];
    let currentModel = initialModel;
    let currentHardTimeoutMs = hardTimeoutMs;
    let currentCliTimeout = cliTimeout;
    const startTime = (dependencies.now ?? Date.now)();

    const modelsToTry = [initialModel, ...candidateFallbacks];
    let lastResult = null;

    for (let i = 0; i < modelsToTry.length; i++) {
        currentModel = modelsToTry[i];
        const isFallback = i > 0;
        const attemptEffort = (isFallback && modelEncodesEffort(currentModel)) ? undefined : effort;
        const attemptPrompt = isFallback
            ? `${FALLBACK_DIRTY_WORKSPACE_NOTE}\n\n${prompt}`
            : prompt;

        const result = await runAntigravity({
            prompt: attemptPrompt,
            cwd,
            model: currentModel,
            effort: attemptEffort,
            bin,
            cliTimeout: currentCliTimeout,
            hardTimeoutMs: currentHardTimeoutMs,
            terminateGraceMs,
            ...dependencies,
            log
        });

        lastResult = result;
        attempts.push({
            model: currentModel ?? null,
            outcome: result.outcome,
            failureKind: result.failureKind ?? null
        });

        if (result.outcome !== "quota_or_auth_failure" || result.failureKind !== "quota") {
            break;
        }

        if (i + 1 >= modelsToTry.length) {
            break;
        }

        const nextModel = modelsToTry[i + 1];
        const now = (dependencies.now ?? Date.now)();
        const elapsed = now - startTime;
        const remaining = hardTimeoutMs - elapsed;

        if (remaining < 2 * 60 * 1000) {
            const skipLine = "Model fallback skipped: not enough time left in the delegation budget.";
            lastResult.text = insertLinesAfterOutcome(lastResult.text, [...fallbackLines, skipLine]);
            lastResult.modelUsed = currentModel ?? null;
            lastResult.attempts = attempts;
            return lastResult;
        }

        currentHardTimeoutMs = remaining;
        const nextCliMinutes = Math.max(1, Math.floor((remaining - 60000) / 60000));
        currentCliTimeout = `${nextCliMinutes}m`;

        const fromSlug = currentModel ?? "default";
        const toSlug = nextModel;
        const cleanResetHint = result.resetHint ? result.resetHint.replace(/[.;]+$/, "") : null;
        const resetSuffix = cleanResetHint ? `; ${cleanResetHint}` : "";
        const effortOmitted = Boolean(effort) && modelEncodesEffort(toSlug);
        const effortSuffix = effortOmitted ? " (effort omitted: encoded in model slug)" : "";
        const fallbackLine = `Model fallback: ${fromSlug} -> ${toSlug} (quota exhausted${resetSuffix})${effortSuffix}`;
        fallbackLines.push(fallbackLine);

        log(`antigravity-mcp: model fallback ${fromSlug} -> ${toSlug} (quota)`);
    }

    const extraLines = [...fallbackLines];

    if (
        lastResult.outcome === "quota_or_auth_failure" &&
        lastResult.failureKind === "quota" &&
        attempts.length > 1 &&
        attempts.every((a) => a.outcome === "quota_or_auth_failure" && a.failureKind === "quota")
    ) {
        const modelsList = attempts.map((a) => a.model ?? "default").join(", ");
        extraLines.push(`All configured models hit quota: ${modelsList}.`);
    }

    if (extraLines.length > 0) {
        lastResult.text = insertLinesAfterOutcome(lastResult.text, extraLines);
    }

    lastResult.modelUsed = currentModel ?? null;
    lastResult.attempts = attempts;

    return lastResult;
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
            return await runWithModelFallback({
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
        const removeWorktreeImpl = worktreeDeps.removeWorktree ?? removeWorktree;
        const sweepStaleDelegationsImpl = worktreeDeps.sweepStaleDelegations ?? sweepStaleDelegations;
        const touchDelegationImpl = worktreeDeps.touchDelegation ?? touchDelegation;
        const log = dependencies.log ?? (() => {});

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

            try {
                await touchDelegationImpl({ metaPath: loadRes.metaPath });
            } catch {
                // best-effort activity timestamp
            }

            delegationContext = {
                delegationId: loadRes.delegationId,
                repoRoot: loadRes.repoRoot,
                worktreePath: loadRes.worktreePath,
                baseCommit: loadRes.baseCommit,
                patchPath: loadRes.patchPath,
                metaPath: loadRes.metaPath,
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

            const staleSweepLines = [];
            try {
                const sweepRes = await sweepStaleDelegationsImpl({
                    repoRoot: creation.repoRoot,
                    env,
                    maxAgeMs: resolveWorktreeTtlMs(env),
                    isBusy: (id) => busyDelegations.has(makeBusyKey(creation.repoRoot, id)),
                    spawnImpl: gitSpawnImpl
                });
                if (sweepRes.removed?.length) {
                    staleSweepLines.push(
                        `Stale delegations removed: ${sweepRes.removed.join(", ")}`
                    );
                }
                for (const entry of sweepRes.failed ?? []) {
                    log(`antigravity-mcp: stale sweep failed id=${entry.id}: ${entry.error}`);
                    staleSweepLines.push(`Stale sweep failures: ${entry.id} (${entry.error})`);
                }
            } catch (error) {
                log(`antigravity-mcp: stale sweep failed id=*: ${errorText(error)}`);
            }

            delegationContext = {
                delegationId: creation.delegationId,
                repoRoot: creation.repoRoot,
                worktreePath: creation.worktreePath,
                baseCommit: creation.baseCommit,
                patchPath: creation.patchPath,
                metaPath: creation.metaPath,
                mainTreeStatus: creation.mainTreeStatus,
                staleSweepLines
            };
        }

        try {
            const agyResult = await runWithModelFallback({
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

            if (delegationContext.metaPath) {
                try {
                    await touchDelegationImpl({ metaPath: delegationContext.metaPath });
                } catch {
                    // best-effort activity timestamp
                }
            }

            let worktreeRemoved = false;
            const shouldAutoRemoveWorktree = Boolean(
                patchRes.ok &&
                !patchRes.hasChanges &&
                agyResult.outcome !== "timeout" &&
                !agyResult.exitUnconfirmed
            );

            if (shouldAutoRemoveWorktree) {
                try {
                    const removeRes = await removeWorktreeImpl({
                        repoRoot: delegationContext.repoRoot,
                        delegationId: delegationContext.delegationId,
                        env,
                        spawnImpl: gitSpawnImpl
                    });
                    if (removeRes.ok) {
                        worktreeRemoved = true;
                    }
                } catch {
                    // auto-remove is best-effort
                }
            }

            const isolationLines = [
                "---",
                "Isolation: worktree",
                `Delegation ID: ${delegationContext.delegationId}`,
                worktreeRemoved
                    ? `Worktree: ${delegationContext.worktreePath} (removed)`
                    : `Worktree: ${delegationContext.worktreePath}`,
                `Base commit: ${delegationContext.baseCommit}`,
                worktreeRemoved
                    ? `Patch: ${delegationContext.patchPath} (removed)`
                    : `Patch: ${delegationContext.patchPath}`
            ];

            if (!worktreeRemoved) {
                isolationLines.push(
                    "Main tree was not modified by this run. Nothing lands in the main tree until apply_delegation."
                );
            }

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

            if (delegationContext.staleSweepLines?.length) {
                isolationLines.push(...delegationContext.staleSweepLines);
            }

            if (worktreeRemoved) {
                isolationLines.push(
                    "Worktree removed automatically: the run produced no changes."
                );
                isolationLines.push(
                    "Revision with this delegation ID is no longer possible; delegate again for follow-up work."
                );
            } else {
                isolationLines.push(
                    "Next: review with the patch/worktree, then call apply_delegation or discard_delegation with this delegation ID."
                );
            }

            const isError = !patchRes.ok ? true : agyResult.isError;
            const text = `${agyResult.text}\n\n${isolationLines.join("\n")}`;

            return {
                outcome: agyResult.outcome,
                isError,
                text,
                modelUsed: agyResult.modelUsed,
                attempts: agyResult.attempts,
                ...(agyResult.failureKind ? { failureKind: agyResult.failureKind } : {}),
                delegation: {
                    delegationId: delegationContext.delegationId,
                    worktreePath: delegationContext.worktreePath,
                    baseCommit: delegationContext.baseCommit,
                    patchPath: delegationContext.patchPath,
                    hasChanges: Boolean(patchRes.ok && patchRes.hasChanges),
                    ...(worktreeRemoved ? { worktreeRemoved: true } : {})
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
        const removeWorktreeImpl = worktreeDeps.removeWorktree ?? removeWorktree;
        const keepWorktree = input?.keepWorktree === true;

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

        busyDelegations.add(busyKey);
        try {
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
            const lines = [
                "Outcome: no_changes",
                `Delegation ${delegationId} has no changes to apply.`
            ];
            if (!keepWorktree) {
                const removeRes = await removeWorktreeImpl({
                    repoRoot: loadRes.repoRoot,
                    delegationId,
                    env,
                    spawnImpl: gitSpawnImpl
                });
                if (removeRes.ok) {
                    lines.push("Worktree removed.");
                } else {
                    lines.push(
                        `Worktree cleanup failed: ${removeRes.error}; call discard_delegation.`
                    );
                }
            }
            return outcome({
                outcomeName: "no_changes",
                isError: false,
                text: lines.join("\n")
            });
        }

        const appliedLines = [
            "Outcome: applied",
            `Delegation ${delegationId} applied successfully.`,
            "Changes are now unstaged in the main working tree.",
            "Team Lead must diff and re-run tests."
        ];
        if (!keepWorktree) {
            const removeRes = await removeWorktreeImpl({
                repoRoot: loadRes.repoRoot,
                delegationId,
                env,
                spawnImpl: gitSpawnImpl
            });
            if (removeRes.ok) {
                appliedLines.push("Worktree removed.");
            } else {
                appliedLines.push(
                    `Worktree cleanup failed: ${removeRes.error}; call discard_delegation.`
                );
            }
        }

        return outcome({
            outcomeName: "applied",
            isError: false,
            text: appliedLines.join("\n")
        });
        } finally {
            busyDelegations.delete(busyKey);
        }
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

        busyDelegations.add(busyKey);
        try {
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
        } finally {
            busyDelegations.delete(busyKey);
        }
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
