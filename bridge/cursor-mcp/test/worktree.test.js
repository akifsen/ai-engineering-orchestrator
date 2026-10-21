import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
    delegationPaths,
    removeWorktree,
    repoKey,
    resolveWorktreeTtlMs,
    sweepStaleDelegations
} from "../lib/worktree.js";

function mockGitSpawn(handler) {
    const calls = [];
    const spawnImpl = (bin, args, options) => {
        calls.push({ bin, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();

        let response;
        if (typeof handler === "function") {
            response = handler(args, options);
        } else if (Array.isArray(handler)) {
            response = handler.shift();
        } else {
            response = handler;
        }

        if (response?.syncThrow) {
            throw response.syncThrow;
        }

        queueMicrotask(() => {
            if (response?.error) {
                child.emit("error", response.error);
                return;
            }

            if (response?.stdout) {
                child.stdout.emit("data", response.stdout);
            }

            if (response?.stderr) {
                child.stderr.emit("data", response.stderr);
            }

            child.emit("close", response?.code ?? 0);
        });

        return child;
    };

    return { spawnImpl, calls };
}

test("removeWorktree: happy path", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-rm-"));
    const repoRoot = path.resolve("/mock/repo/rm");
    const delegationId = "1122334455";

    const paths = delegationPaths(tmpWorktreeRoot, repoRoot, delegationId);
    await mkdir(paths.worktreePath, { recursive: true });
    await writeFile(paths.metaPath, "{}");

    const { spawnImpl, calls } = mockGitSpawn({ code: 0 });

    try {
        const result = await removeWorktree({
            repoRoot,
            delegationId,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl
        });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0].args.slice(2), [
            "worktree",
            "remove",
            "--force",
            "--",
            paths.worktreePath
        ]);
        assert.equal(calls[0].options.cwd, repoRoot);
        assert.deepEqual(calls[1].args.slice(2), ["worktree", "prune"]);

        await assert.rejects(stat(paths.dir), { code: "ENOENT" });
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("removeWorktree: removes empty repoKey parent directory", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-rm-parent-"));
    const repoRoot = path.resolve("/mock/repo/rm-parent");
    const delegationId = "2233445566";
    const key = repoKey(repoRoot);
    const paths = delegationPaths(tmpWorktreeRoot, repoRoot, delegationId);
    await mkdir(paths.worktreePath, { recursive: true });
    await writeFile(paths.metaPath, "{}");

    const { spawnImpl } = mockGitSpawn({ code: 0 });

    try {
        const result = await removeWorktree({
            repoRoot,
            delegationId,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl
        });

        assert.equal(result.ok, true);
        const parentDir = path.join(tmpWorktreeRoot, key);
        await assert.rejects(stat(parentDir), { code: "ENOENT" });
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("removeWorktree: remove failure falls back to prune and still removes directory", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-rm-prune-"));
    const repoRoot = path.resolve("/mock/repo/rm-prune");
    const delegationId = "6677889900";

    const paths = delegationPaths(tmpWorktreeRoot, repoRoot, delegationId);
    await mkdir(paths.worktreePath, { recursive: true });
    await writeFile(paths.metaPath, "{}");

    const order = [];
    const rmPaths = [];
    const customRm = async (p, opts) => {
        order.push("rm");
        rmPaths.push(p);
        return await rm(p, opts);
    };
    const customRmdir = async (p) => {
        order.push("rmdir");
        rmPaths.push(p);
        return await rm(p, { recursive: true, force: true });
    };

    const { spawnImpl, calls } = mockGitSpawn((args) => {
        const sub = args.slice(2);
        if (sub[0] === "worktree" && sub[1] === "remove") {
            order.push("remove");
            return { stderr: "fatal: contains modified or untracked files\n", code: 128 };
        }
        if (sub[0] === "worktree" && sub[1] === "prune") {
            order.push("prune");
            return { stdout: "pruned 1 worktrees\n", code: 0 };
        }
        return { code: 0 };
    });

    try {
        const result = await removeWorktree({
            repoRoot,
            delegationId,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl,
            rmImpl: customRm,
            rmdirImpl: customRmdir
        });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0].args.slice(2), [
            "worktree",
            "remove",
            "--force",
            "--",
            paths.worktreePath
        ]);
        assert.deepEqual(calls[1].args.slice(2), ["worktree", "prune"]);

        const key = repoKey(repoRoot);
        const repoKeyDir = path.join(tmpWorktreeRoot, key);

        assert.deepEqual(order, ["remove", "rm", "rmdir", "prune"]);
        assert.equal(rmPaths[0], paths.dir);
        assert.equal(rmPaths[1], repoKeyDir);

        await assert.rejects(stat(paths.dir), { code: "ENOENT" });
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("removeWorktree: never throws on error or invalid input", async () => {
    const resInvalidId = await removeWorktree({ repoRoot: "/repo", delegationId: "invalid" });
    assert.equal(resInvalidId.ok, false);
    assert.match(resInvalidId.error, /Invalid delegation ID/);

    const resNoRepo = await removeWorktree({ delegationId: "1234567890" });
    assert.equal(resNoRepo.ok, false);
    assert.match(resNoRepo.error, /repoRoot is required/);

    const { spawnImpl } = mockGitSpawn({ code: 0 });
    const resRmError = await removeWorktree({
        repoRoot: "/repo",
        delegationId: "1234567890",
        spawnImpl,
        rmImpl: () => {
            throw new Error("EPERM: disk locked");
        }
    });
    assert.equal(resRmError.ok, false);
    assert.match(resRmError.error, /disk locked/);
});

test("resolveWorktreeTtlMs: default, valid hours, zero disables, invalid falls back", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    assert.equal(resolveWorktreeTtlMs({}), dayMs);
    assert.equal(resolveWorktreeTtlMs({ AEO_WORKTREE_TTL_HOURS: "48" }), 48 * 60 * 60 * 1000);
    assert.equal(resolveWorktreeTtlMs({ AEO_WORKTREE_TTL_HOURS: "0" }), 0);
    assert.equal(resolveWorktreeTtlMs({ AEO_WORKTREE_TTL_HOURS: "nope" }), dayMs);
    assert.equal(resolveWorktreeTtlMs({ AEO_WORKTREE_TTL_HOURS: "-3" }), dayMs);
});

test("sweepStaleDelegations: removes old, keeps fresh, skips busy, disabled when TTL 0, records failures", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-sweep-"));
    const repoRoot = path.resolve("/mock/repo/sweep");
    const key = repoKey(repoRoot);
    const keyDir = path.join(tmpWorktreeRoot, key);
    const oldId = "aaaaaaaaaa";
    const freshId = "bbbbbbbbbb";
    const busyId = "cccccccccc";
    const failId = "dddddddddd";
    const now = Date.parse("2026-01-02T12:00:00.000Z");
    const maxAgeMs = 60 * 60 * 1000;

    const setupDelegation = async (id, meta) => {
        const dir = path.join(keyDir, id);
        await mkdir(path.join(dir, "wt"), { recursive: true });
        await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
    };

    await setupDelegation(oldId, { createdAt: "2026-01-02T10:00:00.000Z" });
    await setupDelegation(freshId, {
        createdAt: "2026-01-02T09:00:00.000Z",
        lastActivityAt: "2026-01-02T11:30:00.000Z"
    });
    await setupDelegation(busyId, { createdAt: "2026-01-02T09:00:00.000Z" });
    await setupDelegation(failId, { createdAt: "2026-01-02T08:00:00.000Z" });

    const { spawnImpl } = mockGitSpawn({ code: 0 });

    const rmImpl = async (target, opts) => {
        if (String(target).includes(failId)) {
            throw new Error("simulated remove failure");
        }
        return await rm(target, opts);
    };

    try {
        const disabled = await sweepStaleDelegations({
            repoRoot,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            maxAgeMs: 0,
            now
        });
        assert.equal(disabled.disabled, true);
        assert.deepEqual(disabled.removed, []);

        const result = await sweepStaleDelegations({
            repoRoot,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            maxAgeMs,
            now,
            isBusy: (id) => id === busyId,
            spawnImpl,
            rmImpl,
            readdirImpl: readdir,
            readFileImpl: readFile,
            statImpl: stat
        });

        assert.equal(result.ok, true);
        assert.ok(result.removed.includes(oldId));
        assert.equal(result.removed.includes(freshId), false);
        assert.equal(result.removed.includes(busyId), false);
        const failEntry = result.failed.find((entry) => entry.id === failId);
        assert.ok(failEntry);
        assert.match(failEntry.error, /simulated remove failure/);

        await assert.rejects(stat(path.join(keyDir, oldId)), { code: "ENOENT" });
        await stat(path.join(keyDir, freshId));
        await stat(path.join(keyDir, busyId));
        await stat(path.join(keyDir, failId));
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("sweepStaleDelegations: uses directory mtime only when meta.json is missing", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-sweep-dir-mtime-"));
    const repoRoot = path.resolve("/mock/repo/sweep-dir-mtime");
    const keyDir = path.join(tmpWorktreeRoot, repoKey(repoRoot));
    const oldNoMetaId = "1111111111";
    const freshNoMetaId = "2222222222";
    const now = Date.parse("2026-01-02T12:00:00.000Z");
    const maxAgeMs = 60 * 60 * 1000;
    const oldDirMtime = Date.parse("2026-01-02T10:00:00.000Z");
    const freshDirMtime = Date.parse("2026-01-02T11:30:00.000Z");

    for (const id of [oldNoMetaId, freshNoMetaId]) {
        await mkdir(path.join(keyDir, id, "wt"), { recursive: true });
    }

    const statImpl = async (target) => {
        const real = await stat(target);
        const normalized = path.normalize(String(target));
        if (normalized.endsWith(oldNoMetaId)) {
            return { ...real, mtimeMs: oldDirMtime };
        }
        if (normalized.endsWith(freshNoMetaId)) {
            return { ...real, mtimeMs: freshDirMtime };
        }
        return real;
    };

    const { spawnImpl } = mockGitSpawn({ code: 0 });

    try {
        const result = await sweepStaleDelegations({
            repoRoot,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            maxAgeMs,
            now,
            spawnImpl,
            readdirImpl: readdir,
            readFileImpl: readFile,
            statImpl
        });

        assert.equal(result.ok, true);
        assert.ok(result.removed.includes(oldNoMetaId));
        assert.equal(result.removed.includes(freshNoMetaId), false);
        await assert.rejects(stat(path.join(keyDir, oldNoMetaId)), { code: "ENOENT" });
        await stat(path.join(keyDir, freshNoMetaId));
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("sweepStaleDelegations: patch mtime keeps stale meta fresh when injected via statImpl", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-sweep-patch-mtime-"));
    const repoRoot = path.resolve("/mock/repo/sweep-patch-mtime");
    const keyDir = path.join(tmpWorktreeRoot, repoKey(repoRoot));
    const patchFreshId = "3333333333";
    const now = Date.parse("2026-01-02T12:00:00.000Z");
    const maxAgeMs = 60 * 60 * 1000;
    const staleMetaTime = Date.parse("2026-01-02T09:00:00.000Z");
    const freshPatchMtime = Date.parse("2026-01-02T11:45:00.000Z");

    const dir = path.join(keyDir, patchFreshId);
    await mkdir(path.join(dir, "wt"), { recursive: true });
    await writeFile(
        path.join(dir, "meta.json"),
        JSON.stringify({ createdAt: "2026-01-02T09:00:00.000Z" }),
        "utf8"
    );
    await writeFile(path.join(dir, "delegation.patch"), "patch bytes\n", "utf8");

    const statImpl = async (target) => {
        const real = await stat(target);
        if (String(target).endsWith("delegation.patch")) {
            return { ...real, mtimeMs: freshPatchMtime };
        }
        return real;
    };

    const { spawnImpl } = mockGitSpawn({ code: 0 });

    try {
        const result = await sweepStaleDelegations({
            repoRoot,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            maxAgeMs,
            now,
            spawnImpl,
            readdirImpl: readdir,
            readFileImpl: readFile,
            statImpl
        });

        assert.equal(result.ok, true);
        assert.equal(result.removed.includes(patchFreshId), false);
        assert.ok(now - Math.max(staleMetaTime, freshPatchMtime) < maxAgeMs);
        await stat(dir);
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});
