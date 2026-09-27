import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    DEFAULT_NPM_CI_TIMEOUT_MS,
    NPM_CI_STDERR_MAX_CHARS,
    defaultNpmCi,
    npmCiTimeoutMessage,
    terminateProcessTree
} from "../lib/npm-ci.mjs";

function fakeChild() {
    const child = new EventEmitter();
    child.pid = 4242;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = (signal) => {
        child.signals.push(signal ?? "SIGTERM");
        return true;
    };
    return child;
}

test("default timeout is 180 seconds", () => {
    assert.equal(DEFAULT_NPM_CI_TIMEOUT_MS, 180_000);
    assert.equal(
        npmCiTimeoutMessage(DEFAULT_NPM_CI_TIMEOUT_MS),
        "npm ci timed out after 180 seconds while installing the AEO Antigravity MCP bridge."
    );
});

test("successful npm ci resolves and clears the timeout", async () => {
    const child = fakeChild();
    const pending = [];
    const cleared = [];
    await defaultNpmCi("/tmp/bridge", {
        timeoutMs: 50_000,
        spawnImpl: () => {
            queueMicrotask(() => child.emit("close", 0));
            return child;
        },
        timers: {
            setTimeout(fn, ms) {
                const handle = { fn, ms };
                pending.push(handle);
                return handle;
            },
            clearTimeout(handle) {
                cleared.push(handle);
            }
        }
    });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].ms, 50_000);
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0], pending[0]);
});

test("non-zero npm exit rejects with stderr and clears the timeout", async () => {
    const child = fakeChild();
    const cleared = [];
    await assert.rejects(
        defaultNpmCi("/tmp/bridge", {
            timeoutMs: 50_000,
            spawnImpl: () => {
                queueMicrotask(() => {
                    child.stderr.emit("data", "registry unreachable\n");
                    child.emit("close", 1);
                });
                return child;
            },
            timers: {
                setTimeout: () => ({ id: 1 }),
                clearTimeout: (handle) => cleared.push(handle)
            }
        }),
        (error) => {
            assert.match(error.message, /npm ci failed with exit code 1\./);
            assert.match(error.message, /registry unreachable/);
            return true;
        }
    );
    assert.equal(cleared.length, 1);
});

test("spawn error rejects once when close follows", async () => {
    const child = fakeChild();
    let settlements = 0;
    const pending = defaultNpmCi("/tmp/bridge", {
        timeoutMs: 50_000,
        spawnImpl: () => child,
        timers: {
            setTimeout: () => ({ id: 2 }),
            clearTimeout: () => {}
        }
    }).then(() => {
        settlements += 1;
    }, () => {
        settlements += 1;
    });
    child.emit("error", new Error("spawn broke"));
    child.emit("close", 1);
    await pending;
    assert.equal(settlements, 1);
});

test("synchronous spawn exception rejects without arming the timeout", async () => {
    let armed = 0;
    await assert.rejects(
        defaultNpmCi("/tmp/bridge", {
            spawnImpl: () => {
                throw new Error("sync spawn failure");
            },
            timers: {
                setTimeout: () => {
                    armed += 1;
                    return { id: 3 };
                },
                clearTimeout: () => {}
            }
        }),
        /sync spawn failure/
    );
    assert.equal(armed, 0);
});

test("timeout rejects, terminates the process tree, and settles once", async () => {
    const child = fakeChild();
    let terminated = 0;
    let settlements = 0;
    const pending = defaultNpmCi("/tmp/bridge", {
        timeoutMs: DEFAULT_NPM_CI_TIMEOUT_MS,
        spawnImpl: () => child,
        terminateProcess: (target) => {
            terminated += 1;
            assert.equal(target, child);
            target.emit("close", null);
        },
        timers: {
            setTimeout: (fn) => {
                queueMicrotask(fn);
                return { id: 4 };
            },
            clearTimeout: () => {}
        }
    }).then(() => {
        settlements += 1;
    }, (error) => {
        settlements += 1;
        assert.match(error.message, /timed out after 180 seconds while installing the AEO Antigravity MCP bridge/);
    });
    await pending;
    assert.equal(terminated, 1);
    assert.equal(settlements, 1);
});

test("stderr in npm failures stays bounded", async () => {
    const child = fakeChild();
    const noise = `${"x".repeat(NPM_CI_STDERR_MAX_CHARS + 500)}TAIL_MARKER`;
    await assert.rejects(
        defaultNpmCi("/tmp/bridge", {
            spawnImpl: () => {
                queueMicrotask(() => {
                    child.stderr.emit("data", noise);
                    child.emit("close", 1);
                });
                return child;
            },
            timers: {
                setTimeout: () => ({ id: 5 }),
                clearTimeout: () => {}
            }
        }),
        (error) => {
            assert.match(error.message, /TAIL_MARKER/);
            assert.equal(error.message.includes("x".repeat(NPM_CI_STDERR_MAX_CHARS + 100)), false);
            return true;
        }
    );
});

test("Windows cleanup kills the process tree with taskkill", () => {
    const child = fakeChild();
    const calls = [];
    terminateProcessTree(child, {
        platform: "win32",
        spawnImpl: (command, args, options) => {
            calls.push({ command, args, options });
            return { unref() {} };
        }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "taskkill");
    assert.deepEqual(calls[0].args, ["/PID", "4242", "/T", "/F"]);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, true);
});

test("POSIX cleanup sends SIGTERM and escalates to SIGKILL", async () => {
    const child = fakeChild();
    terminateProcessTree(child, {
        platform: "linux",
        killGraceMs: 20
    });
    assert.deepEqual(child.signals, ["SIGTERM"]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
