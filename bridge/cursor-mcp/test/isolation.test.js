import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    applyDelegation,
    busyDelegations,
    delegateToCursor,
    discardDelegation,
    makeBusyKey,
    normalizeIsolation
} from "../lib/delegate.js";

function mockSpawn(behavior = {}) {
    const calls = [];
    const children = [];
    const spawnImpl = (bin, args, options) => {
        calls.push({ bin, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = {
            written: "",
            write(chunk) {
                this.written += chunk;
                return true;
            },
            end() {}
        };
        child.pid = 4242;
        child.killed = false;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = (signal) => {
            child.killed = true;
            child.signalCode = signal ?? "SIGTERM";
            queueMicrotask(() => {
                child.emit("close", null);
            });
        };

        if (bin === "taskkill") {
            const pidIdx = args?.indexOf("/PID");
            if (pidIdx !== -1 && pidIdx + 1 < args.length) {
                const targetPid = Number(args[pidIdx + 1]);
                for (const spawned of children) {
                    if (spawned.pid === targetPid) {
                        spawned.killed = true;
                        queueMicrotask(() => spawned.emit("close", null));
                    }
                }
            }
        } else {
            children.push(child);
        }

        queueMicrotask(() => {
            if (behavior.error) {
                child.emit("error", behavior.error);
                return;
            }

            if (behavior.stdout) {
                child.stdout.emit("data", behavior.stdout);
            }

            if (behavior.stderr) {
                child.stderr.emit("data", behavior.stderr);
            }

            if (behavior.hang) {
                return;
            }

            child.emit("close", behavior.code ?? 0);
        });

        return child;
    };

    return { spawnImpl, calls, children };
}

async function tempDirectory() {
    return mkdtemp(path.join(tmpdir(), "cursor-bridge-"));
}

function successEnvelope(resultText = "Done.") {
    return JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: resultText
    });
}

const spawnTarget = {
    executable: "C:/cursor/node.exe",
    args: ["C:/cursor/index.js"]
};

function workspaceArg(args) {
    const idx = args.indexOf("--workspace");
    return idx === -1 ? undefined : args[idx + 1];
}

test("normalizeIsolation accepts valid values, defaults omitted/empty to none, and rejects invalid", () => {
    assert.equal(normalizeIsolation(), "none");
    assert.equal(normalizeIsolation(undefined), "none");
    assert.equal(normalizeIsolation(null), "none");
    assert.equal(normalizeIsolation(""), "none");
    assert.equal(normalizeIsolation("none"), "none");
    assert.equal(normalizeIsolation("worktree"), "worktree");

    assert.throws(() => normalizeIsolation("docker"), /isolation must be one of: none, worktree/);
    assert.throws(() => normalizeIsolation("container"), /isolation must be one of: none, worktree/);
    assert.throws(() => normalizeIsolation(123), /isolation must be one of: none, worktree/);
});

test("isolation omitted and 'none': cursor spawn cwd and --workspace identical to today, no worktree function called", async () => {
    const directory = await tempDirectory();
    const worktreeGuards = {
        createWorktree: () => { throw new Error("createWorktree should not be called"); },
        loadDelegation: () => { throw new Error("loadDelegation should not be called"); },
        buildPatch: () => { throw new Error("buildPatch should not be called"); },
        removeWorktree: () => { throw new Error("removeWorktree should not be called"); }
    };

    try {
        const spawn1 = mockSpawn({ code: 0, stdout: successEnvelope("All good.") });
        const res1 = await delegateToCursor(
            { prompt: "Fix bug", cwd: directory, model: "composer-2.5-fast" },
            { spawnImpl: spawn1.spawnImpl, spawnTarget, worktree: worktreeGuards }
        );
        assert.equal(res1.outcome, "agent_success");
        assert.equal("delegation" in res1, false);
        assert.equal(res1.text.includes("Isolation: worktree"), false);
        assert.equal(spawn1.calls.length, 1);
        assert.equal(spawn1.calls[0].options.cwd, path.resolve(directory));
        assert.equal(workspaceArg(spawn1.calls[0].args), path.resolve(directory));

        const spawn2 = mockSpawn({ code: 0, stdout: successEnvelope("All good.") });
        const res2 = await delegateToCursor(
            { prompt: "Fix bug", cwd: directory, isolation: "none", model: "composer-2.5-fast" },
            { spawnImpl: spawn2.spawnImpl, spawnTarget, worktree: worktreeGuards }
        );
        assert.equal(res2.outcome, "agent_success");
        assert.equal("delegation" in res2, false);
        assert.deepEqual(spawn1.calls[0].args, spawn2.calls[0].args);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("invalid isolation; delegationId without worktree isolation -> validation_failure, no spawn", async () => {
    const directory = await tempDirectory();
    const { spawnImpl, calls } = mockSpawn();

    try {
        const res1 = await delegateToCursor(
            { prompt: "Fix bug", cwd: directory, isolation: "docker" },
            { spawnImpl, spawnTarget }
        );
        assert.equal(res1.outcome, "validation_failure");
        assert.match(res1.text, /isolation must be one of: none, worktree/);
        assert.equal(calls.length, 0);

        const res2 = await delegateToCursor(
            { prompt: "Fix bug", cwd: directory, isolation: "none", delegationId: "0123456789" },
            { spawnImpl, spawnTarget }
        );
        assert.match(res2.text, /delegationId is only valid when isolation is "worktree"/);

        const res3 = await delegateToCursor(
            { prompt: "Fix bug", cwd: directory, delegationId: "0123456789" },
            { spawnImpl, spawnTarget }
        );
        assert.match(res3.text, /delegationId is only valid when isolation is "worktree"/);

        const res4 = await delegateToCursor(
            { prompt: "Fix bug", cwd: directory, isolation: "worktree", delegationId: "invalid-id" },
            { spawnImpl, spawnTarget }
        );
        assert.match(res4.text, /Invalid delegation ID/);
        assert.equal(calls.length, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("worktree happy path: spawn cwd and --workspace === worktreePath; buildPatch called; delegation field populated", async () => {
    const directory = await tempDirectory();
    const fakeWorktreePath = path.join(directory, "mock-worktree");
    const fakePatchPath = path.join(directory, "mock.patch");
    const { spawnImpl, calls } = mockSpawn({
        code: 0,
        stdout: successEnvelope("Implemented feature.")
    });

    let buildPatchArgs = null;
    const mockWorktree = {
        createWorktree: async ({ cwd }) => ({
            ok: true,
            delegationId: "abcdef0123",
            repoRoot: cwd,
            baseCommit: "deadbeef00112233445566778899aabbccddeeff",
            worktreePath: fakeWorktreePath,
            patchPath: fakePatchPath,
            mainTreeStatus: "M src/index.js\n?? newfile.txt"
        }),
        buildPatch: async (args) => {
            buildPatchArgs = args;
            return {
                ok: true,
                hasChanges: true,
                patchPath: fakePatchPath,
                diffstat: "src/index.js | 2 +-\n 1 file changed"
            };
        }
    };

    try {
        const result = await delegateToCursor(
            { prompt: "Fix bug", cwd: directory, isolation: "worktree" },
            { spawnImpl, spawnTarget, worktree: mockWorktree }
        );

        assert.equal(result.outcome, "agent_success");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.cwd, fakeWorktreePath);
        assert.equal(workspaceArg(calls[0].args), fakeWorktreePath);
        assert.ok(buildPatchArgs);
        assert.deepEqual(result.delegation, {
            delegationId: "abcdef0123",
            worktreePath: fakeWorktreePath,
            baseCommit: "deadbeef00112233445566778899aabbccddeeff",
            patchPath: fakePatchPath,
            hasChanges: true
        });
        assert.ok(result.text.includes("Isolation: worktree"));
        assert.ok(result.text.includes("Next: review with the patch/worktree, then call apply_delegation or discard_delegation with this delegation ID."));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("worktree: hasChanges false -> No changes. and clean status", async () => {
    const directory = await tempDirectory();
    const fakeWorktreePath = path.join(directory, "mock-worktree");
    const fakePatchPath = path.join(directory, "mock.patch");
    const { spawnImpl } = mockSpawn({ code: 0, stdout: successEnvelope("Inspected only.") });

    const mockWorktree = {
        createWorktree: async ({ cwd }) => ({
            ok: true,
            delegationId: "1122334455",
            repoRoot: cwd,
            baseCommit: "c0ffee00112233445566778899aabbccddeeff00",
            worktreePath: fakeWorktreePath,
            patchPath: fakePatchPath,
            mainTreeStatus: ""
        }),
        buildPatch: async () => ({
            ok: true,
            hasChanges: false,
            patchPath: fakePatchPath,
            diffstat: ""
        })
    };

    try {
        const result = await delegateToCursor(
            { prompt: "Inspect code", cwd: directory, isolation: "worktree" },
            { spawnImpl, spawnTarget, worktree: mockWorktree }
        );
        assert.equal(result.delegation.hasChanges, false);
        assert.ok(result.text.includes("Changes:\nNo changes."));
        assert.ok(result.text.includes("Main tree status at worktree creation:\nclean"));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("createWorktree failure -> validation_failure, zero cursor spawns", async () => {
    const directory = await tempDirectory();
    const { spawnImpl, calls } = mockSpawn();
    const mockWorktree = {
        createWorktree: async () => ({
            ok: false,
            error: "Not inside a git repository: fatal: not a git repository"
        })
    };

    try {
        const result = await delegateToCursor(
            { prompt: "Fix bug", cwd: directory, isolation: "worktree" },
            { spawnImpl, spawnTarget, worktree: mockWorktree }
        );
        assert.equal(result.outcome, "validation_failure");
        assert.equal(calls.length, 0);
        assert.equal("delegation" in result, false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("delegationId revision: loadDelegation used, createWorktree NOT called; unknown id -> validation_failure", async () => {
    const directory = await tempDirectory();
    const fakeWorktreePath = path.join(directory, "existing-worktree");
    const fakePatchPath = path.join(directory, "existing.patch");

    try {
        const spawn1 = mockSpawn({ code: 0, stdout: successEnvelope("Revision completed.") });
        const mockWorktreeA = {
            createWorktree: () => {
                throw new Error("createWorktree must NOT be called for a revision");
            },
            loadDelegation: async () => ({
                ok: true,
                delegationId: "9988776655",
                repoRoot: directory,
                baseCommit: "base1234567890",
                worktreePath: fakeWorktreePath,
                patchPath: fakePatchPath
            }),
            buildPatch: async () => ({
                ok: true,
                hasChanges: true,
                patchPath: fakePatchPath,
                diffstat: "revised.js | 1 +"
            })
        };

        const res1 = await delegateToCursor(
            { prompt: "Revise fix", cwd: directory, isolation: "worktree", delegationId: "9988776655" },
            { spawnImpl: spawn1.spawnImpl, spawnTarget, worktree: mockWorktreeA }
        );
        assert.equal(spawn1.calls[0].options.cwd, fakeWorktreePath);
        assert.equal(workspaceArg(spawn1.calls[0].args), fakeWorktreePath);
        assert.equal(res1.text.includes("Main tree status at worktree creation:"), false);

        const spawn2 = mockSpawn();
        const res2 = await delegateToCursor(
            { prompt: "Revise unknown", cwd: directory, isolation: "worktree", delegationId: "0000000000" },
            {
                spawnImpl: spawn2.spawnImpl,
                spawnTarget,
                worktree: {
                    loadDelegation: async () => ({
                        ok: false,
                        error: "Unknown delegation ID: 0000000000"
                    })
                }
            }
        );
        assert.equal(res2.outcome, "validation_failure");
        assert.equal(spawn2.calls.length, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("failure outcomes under isolation: buildPatch still called, removeWorktree never called", async () => {
    const directory = await tempDirectory();
    const fakeWorktreePath = path.join(directory, "mock-worktree");
    const fakePatchPath = path.join(directory, "mock.patch");

    const cases = [
        {
            name: "agent_failure",
            behavior: {
                code: 0,
                stdout: JSON.stringify({
                    type: "result",
                    subtype: "error",
                    is_error: true,
                    result: "failed"
                })
            }
        },
        {
            name: "cli_failure",
            behavior: { code: 1, stderr: "crash" }
        },
        {
            name: "timeout",
            behavior: { hang: true },
            extra: { hardTimeoutMs: 20 }
        },
        {
            name: "quota_or_auth_failure",
            behavior: { code: 1, stderr: "rate limit exceeded" }
        }
    ];

    try {
        for (const { name, behavior, extra } of cases) {
            const { spawnImpl } = mockSpawn(behavior);
            let buildPatchCalled = false;
            let removeWorktreeCalled = false;
            const mockWorktree = {
                createWorktree: async ({ cwd }) => ({
                    ok: true,
                    delegationId: "123456789a",
                    repoRoot: cwd,
                    baseCommit: "commit123",
                    worktreePath: fakeWorktreePath,
                    patchPath: fakePatchPath,
                    mainTreeStatus: "clean"
                }),
                buildPatch: async () => {
                    buildPatchCalled = true;
                    return { ok: true, hasChanges: false, patchPath: fakePatchPath, diffstat: "" };
                },
                removeWorktree: () => {
                    removeWorktreeCalled = true;
                }
            };

            const result = await delegateToCursor(
                { prompt: "Task", cwd: directory, isolation: "worktree" },
                { spawnImpl, spawnTarget, worktree: mockWorktree, ...extra }
            );

            assert.equal(buildPatchCalled, true, `${name}: buildPatch must run`);
            assert.equal(removeWorktreeCalled, false, `${name}: removeWorktree must not run`);
            assert.equal(result.outcome, name);
            assert.ok(result.text.includes("Isolation: worktree"));
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("two concurrent worktree delegations -> distinct worktrees (spawn order independent)", async () => {
    const directory = await tempDirectory();
    let counter = 0;
    const mockWorktree = {
        createWorktree: async ({ cwd }) => {
            counter++;
            const id = `000000000${counter}`;
            return {
                ok: true,
                delegationId: id,
                repoRoot: cwd,
                baseCommit: "basecommit",
                worktreePath: path.join(directory, `wt-${id}`),
                patchPath: path.join(directory, `patch-${id}`),
                mainTreeStatus: "clean"
            };
        },
        buildPatch: async ({ patchPath }) => ({
            ok: true,
            hasChanges: true,
            patchPath,
            diffstat: "file | 1 +"
        })
    };

    const calls = [];
    const spawnImpl = (bin, args, options) => {
        calls.push({ bin, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write() { return true; }, end() {} };
        child.pid = 5555;
        child.kill = () => {};
        queueMicrotask(() => {
            child.stdout.emit("data", successEnvelope("Concurrent done."));
            child.emit("close", 0);
        });
        return child;
    };

    try {
        const [res1, res2] = await Promise.all([
            delegateToCursor(
                { prompt: "Task 1", cwd: directory, isolation: "worktree" },
                { spawnImpl, spawnTarget, worktree: mockWorktree }
            ),
            delegateToCursor(
                { prompt: "Task 2", cwd: directory, isolation: "worktree" },
                { spawnImpl, spawnTarget, worktree: mockWorktree }
            )
        ]);

        assert.equal(res1.outcome, "agent_success");
        assert.equal(res2.outcome, "agent_success");
        assert.notEqual(res1.delegation.delegationId, res2.delegation.delegationId);
        assert.deepEqual(
            calls.map((call) => call.options.cwd).sort(),
            [res1.delegation.worktreePath, res2.delegation.worktreePath].sort()
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("applyDelegation and discardDelegation outcomes", async () => {
    const directory = await tempDirectory();

    try {
        const invRes = await applyDelegation({ cwd: directory, delegationId: "not-an-id" });
        assert.equal(invRes.outcome, "validation_failure");

        const mockApplied = {
            loadDelegation: async () => ({
                ok: true,
                delegationId: "aabbccddee",
                repoRoot: directory,
                baseCommit: "base1",
                worktreePath: path.join(directory, "wt"),
                patchPath: path.join(directory, "patch")
            }),
            applyPatch: async () => ({ ok: true, applied: true })
        };
        const appRes = await applyDelegation(
            { cwd: directory, delegationId: "aabbccddee" },
            { worktree: mockApplied }
        );
        assert.equal(appRes.outcome, "applied");
        assert.ok(appRes.text.includes("worktree still exists until discard_delegation"));

        const mockNoChanges = {
            loadDelegation: mockApplied.loadDelegation,
            applyPatch: async () => ({ ok: true, applied: false, reason: "no changes" })
        };
        const ncRes = await applyDelegation(
            { cwd: directory, delegationId: "aabbccddee" },
            { worktree: mockNoChanges }
        );
        assert.equal(ncRes.outcome, "no_changes");

        const mockConflict = {
            loadDelegation: mockApplied.loadDelegation,
            applyPatch: async () => ({
                ok: false,
                outcome: "apply_conflict",
                error: "patch does not apply"
            })
        };
        const confRes = await applyDelegation(
            { cwd: directory, delegationId: "aabbccddee" },
            { worktree: mockConflict }
        );
        assert.equal(confRes.outcome, "apply_conflict");

        const mockDiscard = {
            resolveRepoRoot: async () => ({ ok: true, repoRoot: directory }),
            loadDelegation: mockApplied.loadDelegation,
            removeWorktree: async () => ({ ok: true })
        };
        const discRes = await discardDelegation(
            { cwd: directory, delegationId: "aabbccddee" },
            { worktree: mockDiscard }
        );
        assert.equal(discRes.outcome, "discarded");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("busy guard: revision while delegation running returns validation_failure", async () => {
    const directory = await tempDirectory();
    const delegationId = "aabb112233";
    let releaseRun;
    const runWait = new Promise((resolve) => {
        releaseRun = resolve;
    });

    let spawnCount = 0;
    const spawnImpl = () => {
        spawnCount++;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write() { return true; }, end() {} };
        child.pid = 9999;
        child.kill = () => {};
        runWait.then(() => {
            child.stdout.emit("data", successEnvelope("Done"));
            child.emit("close", 0);
        });
        return child;
    };

    const mockWorktree = {
        createWorktree: async () => ({
            ok: true,
            delegationId,
            repoRoot: directory,
            baseCommit: "commit1",
            worktreePath: path.join(directory, "wt"),
            patchPath: path.join(directory, "patch"),
            mainTreeStatus: "clean"
        }),
        loadDelegation: async () => ({
            ok: true,
            delegationId,
            repoRoot: directory,
            baseCommit: "commit1",
            worktreePath: path.join(directory, "wt"),
            patchPath: path.join(directory, "patch")
        }),
        buildPatch: async () => ({ ok: true, hasChanges: false, diffstat: "" })
    };

    try {
        const run1Promise = delegateToCursor(
            { prompt: "Run 1", cwd: directory, isolation: "worktree" },
            { spawnImpl, spawnTarget, worktree: mockWorktree }
        );

        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(busyDelegations.has(makeBusyKey(directory, delegationId)), true);

        const revResult = await delegateToCursor(
            { prompt: "Revision while busy", cwd: directory, isolation: "worktree", delegationId },
            { spawnImpl, spawnTarget, worktree: mockWorktree }
        );
        assert.equal(revResult.outcome, "validation_failure");
        assert.equal(spawnCount, 1);

        releaseRun();
        await run1Promise;
        assert.equal(busyDelegations.has(makeBusyKey(directory, delegationId)), false);
    } finally {
        releaseRun?.();
        await rm(directory, { recursive: true, force: true });
    }
});
