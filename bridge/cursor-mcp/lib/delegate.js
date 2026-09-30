import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MODEL = "composer-2.5";
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 120;
export const TERMINATE_GRACE_MS = 10_000;
export const MAX_PROMPT_CHARS = 24_000;
export const MAX_REPORT_CHARS = 120_000;
export const MAX_COLLECT_CHARS = 8_000_000;

const MODEL_SLUG = /^[A-Za-z0-9._:[\]=,-]+$/;
const VERSION_DIR_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i;

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

export function resolveTimeouts(env = process.env, overrideMinutes) {
    if (overrideMinutes !== undefined && overrideMinutes !== null) {
        const clamped = Math.max(
            MIN_TIMEOUT_MINUTES,
            Math.min(MAX_TIMEOUT_MINUTES, overrideMinutes)
        );
        return {
            minutes: clamped,
            hardTimeoutMs: (clamped + 1) * 60 * 1000,
            warning: null
        };
    }

    const raw = env?.AEO_CURSOR_TIMEOUT_MINUTES;
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
        return {
            minutes: DEFAULT_TIMEOUT_MINUTES,
            hardTimeoutMs: (DEFAULT_TIMEOUT_MINUTES + 1) * 60 * 1000,
            warning: null
        };
    }

    const trimmed = typeof raw === "string" ? raw.trim() : String(raw);
    if (!/^-?\d+$/.test(trimmed)) {
        return {
            minutes: DEFAULT_TIMEOUT_MINUTES,
            hardTimeoutMs: (DEFAULT_TIMEOUT_MINUTES + 1) * 60 * 1000,
            warning: `Invalid AEO_CURSOR_TIMEOUT_MINUTES "${raw}". Falling back to ${DEFAULT_TIMEOUT_MINUTES} minutes.`
        };
    }

    const parsed = Number.parseInt(trimmed, 10);
    const clamped = Math.max(MIN_TIMEOUT_MINUTES, Math.min(MAX_TIMEOUT_MINUTES, parsed));

    return {
        minutes: clamped,
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

export function resolveDefaultModel(env = process.env) {
    const configured = env?.AEO_CURSOR_MODEL;
    if (typeof configured === "string" && configured.trim()) {
        const trimmed = configured.trim();
        if (!MODEL_SLUG.test(trimmed)) {
            throw new Error(
                "AEO_CURSOR_MODEL must be a slug made of letters, numbers, dots, underscores, colons, brackets, equals, commas, or hyphens."
            );
        }
        return trimmed;
    }

    return DEFAULT_MODEL;
}

function versionDirSortKey(name) {
    const match = VERSION_DIR_RE.exec(name);
    if (!match) {
        return null;
    }

    const year = match[1];
    const month = match[2].padStart(2, "0");
    const day = match[3].padStart(2, "0");
    const suffix = match[4] ?? "";
    return `${year}-${month}-${day}${suffix}-${name}`;
}

export async function pickNewestCursorVersionDir(versionsDir, readdirImpl = readdir) {
    let entries;
    try {
        entries = await readdirImpl(versionsDir, { withFileTypes: true });
    } catch {
        return null;
    }

    const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .map((name) => ({ name, key: versionDirSortKey(name) }))
        .filter((item) => item.key !== null)
        .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

    return candidates.length > 0 ? path.join(versionsDir, candidates[0].name) : null;
}

export async function resolveCursorSpawnTarget(env = process.env, dependencies = {}) {
    const platform = dependencies.platform ?? process.platform;
    const readdirImpl = dependencies.readdir ?? readdir;
    const configured = env?.CURSOR_AGENT_BIN;

    if (typeof configured === "string" && configured.trim()) {
        const trimmed = configured.trim();
        if (trimmed.toLowerCase().endsWith(".js")) {
            const dir = path.dirname(trimmed);
            const nodeName = platform === "win32" ? "node.exe" : "node";
            const nodePath = path.join(dir, nodeName);
            const accessImpl = dependencies.access ?? access;
            let executable = nodePath;
            try {
                await accessImpl(nodePath);
            } catch {
                executable = process.execPath;
            }
            return {
                executable,
                args: [trimmed]
            };
        }

        return {
            executable: trimmed,
            args: []
        };
    }

    if (platform === "win32") {
        const localAppData = env?.LOCALAPPDATA;
        if (!localAppData) {
            return null;
        }

        const versionsDir = path.join(localAppData, "cursor-agent", "versions");
        const versionDir = await pickNewestCursorVersionDir(versionsDir, readdirImpl);
        if (!versionDir) {
            return null;
        }

        return {
            executable: path.join(versionDir, "node.exe"),
            args: [path.join(versionDir, "index.js")]
        };
    }

    return {
        executable: "cursor-agent",
        args: []
    };
}

export function buildChildEnv(env = process.env) {
    const childEnv = { ...env };

    if (
        (childEnv.NODE_COMPILE_CACHE === undefined ||
            childEnv.NODE_COMPILE_CACHE === null ||
            childEnv.NODE_COMPILE_CACHE === "") &&
        typeof env?.LOCALAPPDATA === "string" &&
        env.LOCALAPPDATA
    ) {
        childEnv.NODE_COMPILE_CACHE = path.join(env.LOCALAPPDATA, "cursor-compile-cache");
    }

    if (
        childEnv.CURSOR_INVOKED_AS === undefined ||
        childEnv.CURSOR_INVOKED_AS === null ||
        childEnv.CURSOR_INVOKED_AS === ""
    ) {
        childEnv.CURSOR_INVOKED_AS = "cursor-agent";
    }

    return childEnv;
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
        "- Do not commit, push, reset, rebase, merge, switch branches, stash, clean, or rewrite Git history.",
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

export function buildCursorCliArgs({ cwd, model }) {
    return [
        "-p",
        "--output-format",
        "json",
        "--model",
        model,
        "--trust",
        "--force",
        "--workspace",
        cwd
    ];
}

export function buildCursorSpawnArgs({ cwd, model, spawnTarget }) {
    return [...spawnTarget.args, ...buildCursorCliArgs({ cwd, model })];
}

export function truncate(text, limit = MAX_REPORT_CHARS) {
    if (!text) {
        return "";
    }

    if (text.length <= limit) {
        return text;
    }

    return `${text.slice(0, limit)}\n\n[Output truncated by the Cursor MCP bridge]`;
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

function normalizeModel(model, env) {
    if (model === undefined || model === null || model === "") {
        return resolveDefaultModel(env);
    }

    if (typeof model !== "string" || !MODEL_SLUG.test(model)) {
        throw new Error(
            "model must be a slug made of letters, numbers, dots, underscores, colons, brackets, equals, commas, or hyphens."
        );
    }

    return model;
}

function normalizeTimeoutMinutes(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error("timeoutMinutes must be an integer between 1 and 120.");
    }

    if (value < MIN_TIMEOUT_MINUTES || value > MAX_TIMEOUT_MINUTES) {
        throw new Error("timeoutMinutes must be an integer between 1 and 120.");
    }

    return value;
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

export function parseCursorEnvelope(stdout) {
    const trimmed = stdout.replace(/^\uFEFF/, "").trim();
    if (!trimmed) {
        return { ok: false, error: "Cursor returned no JSON on stdout." };
    }

    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const candidates = [...lines].reverse();

    let lastError = "Cursor returned invalid JSON.";
    for (const candidate of candidates) {
        if (!candidate.includes("\"type\":\"result\"") && !candidate.includes('"type": "result"')) {
            continue;
        }

        try {
            const value = JSON.parse(candidate);
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                lastError = "Cursor JSON was not an object.";
                continue;
            }

            if (value.type !== "result") {
                lastError = "Cursor JSON was not a result envelope.";
                continue;
            }

            return { ok: true, value };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }

    const fallback = trimmed;
    try {
        const value = JSON.parse(fallback);
        if (value && typeof value === "object" && !Array.isArray(value) && value.type === "result") {
            return { ok: true, value };
        }
    } catch {
        // fall through
    }

    return { ok: false, error: lastError };
}

export function indicatesQuotaOrAuthFailure(...texts) {
    const combined = texts.filter(Boolean).join("\n");
    const lower = combined.toLowerCase();

    if (/\b429\b/.test(combined)) {
        return true;
    }

    if (lower.includes("rate limit") || lower.includes("rate-limit")) {
        return true;
    }

    if (lower.includes("quota")) {
        return true;
    }

    if (lower.includes("not logged in")) {
        return true;
    }

    if (lower.includes("login required") || lower.includes("authentication required")) {
        return true;
    }

    return false;
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

function formatMetadata(payload, model) {
    const metadata = {
        model: model ?? null,
        duration_ms: payload.duration_ms ?? null,
        session_id: payload.session_id ?? null,
        request_id: payload.request_id ?? null,
        subtype: payload.subtype ?? null,
        is_error: payload.is_error ?? null,
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
        setTimeout(() => {
            try {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                }
            } catch {
                // The process is already gone.
            }
        }, TERMINATE_GRACE_MS).unref?.();
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

function quotaFailure(lines) {
    return outcome({
        outcomeName: "quota_or_auth_failure",
        isError: true,
        text: ["Outcome: quota_or_auth_failure", ...lines].join("\n")
    });
}

export async function runCursor({
    prompt,
    cwd,
    model,
    spawnTarget,
    hardTimeoutMs,
    terminateGraceMs = TERMINATE_GRACE_MS,
    maxCollectChars = MAX_COLLECT_CHARS,
    spawnImpl = spawn,
    terminateProcess = defaultTerminateProcess,
    env = process.env,
    log = () => {}
}) {
    const wrappedPrompt = buildImplementationPrompt(prompt);
    const args = buildCursorSpawnArgs({ cwd, model, spawnTarget });
    const childEnv = buildChildEnv(env);

    log(
        `cursor-mcp: delegation started cwd=${cwd} model=${model} executable=${spawnTarget.executable}`
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
            log(`cursor-mcp: delegation finished outcome=${result.outcome}`);
            resolve(result);
        };

        let child;
        try {
            child = spawnImpl(spawnTarget.executable, args, {
                cwd,
                env: childEnv,
                windowsHide: true,
                shell: false,
                stdio: ["pipe", "pipe", "pipe"]
            });
        } catch (error) {
            finish(cliFailure([
                "The Cursor Agent process could not be started.",
                errorText(error)
            ]));
            return;
        }

        try {
            child.stdin?.write(wrappedPrompt);
            child.stdin?.end();
        } catch (error) {
            finish(cliFailure([
                "The Cursor Agent process could not receive the prompt on stdin.",
                errorText(error)
            ]));
            return;
        }

        hardTimeout = setTimeout(async () => {
            if (settled || overflow || timedOut) {
                return;
            }
            timedOut = true;
            terminateProcess(child, spawnImpl);
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
                terminateProcess(child, spawnImpl);
                const confirmedExit = await waitForChildExit(child, terminateGraceMs);
                const unconfirmedLine = !confirmedExit
                    ? `The process did not confirm exit within ${formatGraceSeconds(terminateGraceMs)}s; files in the working directory may still change.`
                    : null;

                finish(cliFailure([
                    "Cursor produced more output than the bridge will collect.",
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
                    ? `Cursor Agent command was not found: ${spawnTarget.executable}`
                    : "The Cursor Agent process could not be started.",
                missing
                    ? "Install the Cursor Agent CLI or set CURSOR_AGENT_BIN to the agent executable or index.js."
                    : errorText(error),
                diagnosticBlock("CLI diagnostics", stderr).trim()
            ].filter(Boolean)));
        });

        child.on("close", (code) => {
            if (overflow || timedOut) {
                return;
            }

            const parsed = parseCursorEnvelope(stdout);
            const diagnostics = stderr.trim();
            const resultText = parsed.ok && typeof parsed.value.result === "string"
                ? parsed.value.result
                : "";

            if (code !== 0) {
                const lines = [
                    `Cursor Agent exited with code ${code}.`,
                    "This is a CLI or invocation failure, not a completed implementation.",
                    parsed.ok && parsed.value.is_error
                        ? `is_error: ${parsed.value.is_error}`
                        : "",
                    resultText
                        ? `Result: ${truncate(resultText, 4_000)}`
                        : "",
                    !parsed.ok
                        ? `Output parse: ${parsed.error}`
                        : "",
                    diagnosticBlock("CLI diagnostics", diagnostics).trim(),
                    !parsed.ok && stdout.trim()
                        ? diagnosticBlock("Raw stdout", stdout).trim()
                        : ""
                ].filter(Boolean);

                if (indicatesQuotaOrAuthFailure(diagnostics, resultText, stdout)) {
                    finish(quotaFailure([
                        ...lines,
                        "Antigravity fallback may also be unavailable; the Team Lead should not assume either engineer is ready."
                    ]));
                    return;
                }

                finish(cliFailure(lines));
                return;
            }

            if (!parsed.ok) {
                const lines = [
                    "Cursor Agent exited 0 but did not return a JSON result object.",
                    parsed.error,
                    diagnosticBlock("CLI diagnostics", diagnostics).trim(),
                    diagnosticBlock("Raw stdout", stdout).trim()
                ].filter(Boolean);

                if (indicatesQuotaOrAuthFailure(diagnostics, stdout)) {
                    finish(quotaFailure(lines));
                    return;
                }

                finish(cliFailure(lines));
                return;
            }

            const payload = parsed.value;
            const failed = payload.is_error === true || payload.subtype !== "success";

            if (failed) {
                const lines = [
                    "The Cursor Agent CLI exited 0 and returned structured output, so the process started.",
                    "The agent run itself did not succeed. This is not a successful implementation.",
                    `subtype: ${payload.subtype ?? "missing"}`,
                    `is_error: ${payload.is_error ?? "missing"}`,
                    resultText
                        ? `Result: ${truncate(resultText, 4_000)}`
                        : "",
                    diagnosticBlock("CLI diagnostics", diagnostics).trim(),
                    "",
                    "Execution metadata:",
                    formatMetadata(payload, model)
                ].filter(Boolean);

                if (indicatesQuotaOrAuthFailure(diagnostics, resultText)) {
                    finish(quotaFailure(lines));
                    return;
                }

                finish(outcome({
                    outcomeName: "agent_failure",
                    isError: true,
                    text: ["Outcome: agent_failure", ...lines].join("\n")
                }));
                return;
            }

            if (!resultText.trim()) {
                finish(outcome({
                    outcomeName: "agent_failure",
                    isError: true,
                    text: [
                        "Outcome: agent_failure",
                        "Cursor reported success but returned an empty result.",
                        "Treat the implementation as not completed.",
                        diagnosticBlock("CLI diagnostics", diagnostics).trim(),
                        "",
                        "Execution metadata:",
                        formatMetadata(payload, model)
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
                    truncate(resultText),
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

export async function delegateToCursor(input, dependencies = {}) {
    try {
        const prompt = normalizePrompt(input?.prompt);
        const cwd = await validateWorkingDirectory(input?.cwd);
        const env = dependencies.env ?? process.env;
        const model = normalizeModel(input?.model, env);
        const timeoutOverride = normalizeTimeoutMinutes(input?.timeoutMinutes);
        const timeouts = resolveTimeouts(env, timeoutOverride);
        warnInvalidTimeout(timeouts.warning);
        const hardTimeoutMs = dependencies.hardTimeoutMs ?? timeouts.hardTimeoutMs;
        const terminateGraceMs = dependencies.terminateGraceMs ?? TERMINATE_GRACE_MS;

        const spawnTarget = dependencies.spawnTarget
            ?? await resolveCursorSpawnTarget(env, dependencies);

        if (!spawnTarget) {
            return outcome({
                outcomeName: "cli_failure",
                isError: true,
                text: [
                    "Outcome: cli_failure",
                    "The Cursor Agent executable could not be resolved.",
                    "On Windows, install Cursor Agent under %LOCALAPPDATA%\\cursor-agent\\ or set CURSOR_AGENT_BIN.",
                    "On other platforms, put cursor-agent on PATH or set CURSOR_AGENT_BIN."
                ].join("\n")
            });
        }

        return await runCursor({
            ...dependencies,
            prompt,
            cwd,
            model,
            spawnTarget,
            hardTimeoutMs,
            terminateGraceMs,
            env
        });
    } catch (error) {
        return outcome({
            outcomeName: "validation_failure",
            isError: true,
            text: [
                "Outcome: validation_failure",
                "The bridge rejected the delegation before starting Cursor.",
                errorText(error)
            ].join("\n")
        });
    }
}
