import { spawn } from "node:child_process";

export const DEFAULT_NPM_CI_TIMEOUT_MS = 180_000;
export const NPM_CI_STDERR_MAX_CHARS = 4_000;
export const POSIX_KILL_GRACE_MS = 2_000;

export function terminateProcessTree(child, options = {}) {
    if (!child || !child.pid) {
        return;
    }
    const platform = options.platform ?? process.platform;
    const spawnImpl = options.spawnImpl ?? spawn;
    const graceMs = options.killGraceMs ?? POSIX_KILL_GRACE_MS;
    if (platform === "win32") {
        try {
            const killer = spawnImpl(
                "taskkill",
                ["/PID", String(child.pid), "/T", "/F"],
                {
                    windowsHide: true,
                    stdio: "ignore",
                    shell: false
                }
            );
            killer?.unref?.();
        } catch {
            try {
                child.kill();
            } catch {
                // The process is already gone.
            }
        }
        return;
    }
    try {
        child.kill("SIGTERM");
    } catch {
        return;
    }
    const timer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode) {
            return;
        }
        try {
            child.kill("SIGKILL");
        } catch {
            // The process is already gone.
        }
    }, graceMs);
    timer.unref?.();
    if (typeof child.once === "function") {
        child.once("exit", () => {
            clearTimeout(timer);
        });
    }
}

function timeoutLabel(timeoutMs) {
    const seconds = timeoutMs / 1000;
    if (Number.isInteger(seconds)) {
        return String(seconds);
    }
    return seconds.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function npmCiTimeoutMessage(timeoutMs) {
    return `npm ci timed out after ${timeoutLabel(timeoutMs)} seconds while installing the AEO Antigravity MCP bridge.`;
}

function rememberStderr(current, chunk) {
    const next = current + chunk.toString();
    if (next.length <= NPM_CI_STDERR_MAX_CHARS) {
        return next;
    }
    return next.slice(-NPM_CI_STDERR_MAX_CHARS);
}

export function defaultNpmCi(cwd, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_NPM_CI_TIMEOUT_MS;
    const spawnImpl = options.spawnImpl ?? spawn;
    const terminateProcess = options.terminateProcess ?? ((child) => terminateProcessTree(child, options));
    const schedule = options.timers?.setTimeout ?? setTimeout;
    const cancel = options.timers?.clearTimeout ?? clearTimeout;
    const command = process.platform === "win32" ? "cmd.exe" : "npm";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm ci"] : ["ci"];

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let timedOut = false;
        let stderr = "";

        const finish = (settle, value) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer !== null) {
                cancel(timer);
                timer = null;
            }
            settle(value);
        };

        let child;
        try {
            child = spawnImpl(command, args, {
                cwd,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                shell: false
            });
        } catch (error) {
            finish(reject, error instanceof Error ? error : new Error(String(error)));
            return;
        }

        const failTimeout = () => {
            timedOut = true;
            try {
                terminateProcess(child);
            } catch {
                // Still report the timeout if cleanup itself fails.
            }
            finish(reject, new Error(npmCiTimeoutMessage(timeoutMs)));
        };

        timer = schedule(failTimeout, timeoutMs);

        child.stderr?.on("data", (chunk) => {
            stderr = rememberStderr(stderr, chunk);
        });
        child.on("error", (error) => {
            finish(reject, error instanceof Error ? error : new Error(String(error)));
        });
        child.on("close", (code) => {
            if (timedOut) {
                finish(reject, new Error(npmCiTimeoutMessage(timeoutMs)));
                return;
            }
            if (code === 0) {
                finish(resolve, undefined);
                return;
            }
            const detail = stderr.trim();
            const message = detail
                ? `npm ci failed with exit code ${code}.\n${detail}`
                : `npm ci failed with exit code ${code}.`;
            finish(reject, new Error(message));
        });
    });
}
