import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
    DELEGATION_ID,
    applyPatch,
    buildPatch,
    createWorktree,
    delegationPaths,
    isValidDelegationId,
    loadDelegation,
    newDelegationId,
    normalizeRepoRoot,
    removeWorktree,
    repoKey,
    repoLocks,
    resolveRepoRoot,
    resolveWorktreeRoot,
    runGit,
    withRepoLock
} from "../lib/worktree.js";

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

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

// 1. runGit
test("runGit prepends -c core.longpaths=true and sets safe spawn options", async () => {
    const { spawnImpl, calls } = mockGitSpawn({ stdout: "git version 2.45.0\n", code: 0 });

    const result = await runGit(["version"], { cwd: "/my/repo", spawnImpl });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "git");
    assert.deepEqual(calls[0].args, ["-c", "core.longpaths=true", "version"]);
    assert.equal(calls[0].options.cwd, "/my/repo");
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, true);
    assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "git version 2.45.0\n");
    assert.equal(result.stderr, "");
});

test("runGit resolves instead of throwing when spawn emits error (e.g. ENOENT)", async () => {
    const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const { spawnImpl } = mockGitSpawn({ error: enoent });

    const result = await runGit(["status"], { cwd: "/my/repo", spawnImpl });
    assert.equal(result.code, null);
    assert.ok(result.error);
    assert.equal(result.error.code, "ENOENT");
});

test("runGit resolves instead of throwing when spawn throws synchronously", async () => {
    const { spawnImpl } = mockGitSpawn({ syncThrow: new Error("spawnSync blocked") });

    const result = await runGit(["status"], { cwd: "/my/repo", spawnImpl });
    assert.equal(result.code, null);
    assert.ok(result.error);
    assert.equal(result.error.message, "spawnSync blocked");
});

test("runGit decodes multi-byte UTF-8 character split across data chunks correctly", async () => {
    // "🚀" in UTF-8 is 4 bytes: 0xf0 0x9f 0x9a 0x80
    // Emitting [0xf0, 0x9f] in chunk 1 and [0x9a, 0x80] in chunk 2
    // would be corrupted if decoded per-chunk with chunk.toString()
    const chunk1 = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xf0, 0x9f]); // "hello " + first 2 bytes of 🚀
    const chunk2 = Buffer.from([0x9a, 0x80, 0x21, 0x0a]); // last 2 bytes of 🚀 + "!\n"
    const expected = "hello 🚀!\n";

    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();

        queueMicrotask(() => {
            child.stdout.emit("data", chunk1);
            child.stdout.emit("data", chunk2);
            child.emit("close", 0);
        });

        return child;
    };

    const result = await runGit(["log"], { spawnImpl });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, expected);
    assert.ok(!result.stdout.includes("\uFFFD"), "stdout must not contain U+FFFD replacement characters");
});

// 2. withRepoLock
test("withRepoLock serializes calls for the same key", async () => {
    const log = [];
    const repo = path.resolve("/repo/test/serialized");
    const d1 = deferred();

    const p1 = withRepoLock(repo, async () => {
        log.push("p1:start");
        await d1.promise;
        log.push("p1:end");
        return "r1";
    });

    const p2 = withRepoLock(repo, async () => {
        log.push("p2:start");
        log.push("p2:end");
        return "r2";
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(log, ["p1:start"], "p2 should not start while p1 is running");

    d1.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, "r1");
    assert.equal(r2, "r2");
    assert.deepEqual(log, ["p1:start", "p1:end", "p2:start", "p2:end"]);
});

test("withRepoLock runs different keys concurrently", async () => {
    const log = [];
    const repoA = path.resolve("/repo/test/concurrent-a");
    const repoB = path.resolve("/repo/test/concurrent-b");
    const dA = deferred();
    const dB = deferred();

    const pA = withRepoLock(repoA, async () => {
        log.push("a:start");
        await dA.promise;
        log.push("a:end");
        return "a";
    });

    const pB = withRepoLock(repoB, async () => {
        log.push("b:start");
        await dB.promise;
        log.push("b:end");
        return "b";
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(log.includes("a:start") && log.includes("b:start"), "both keys should run concurrently");

    dA.resolve();
    dB.resolve();
    await Promise.all([pA, pB]);
    assert.ok(log.includes("a:end") && log.includes("b:end"));
});

test("withRepoLock: a rejecting fn does not block the next call", async () => {
    const repo = path.resolve("/repo/test/rejection");

    const p1 = withRepoLock(repo, async () => {
        throw new Error("lock holder failed");
    });

    const p2 = withRepoLock(repo, async () => {
        return "subsequent call ok";
    });

    await assert.rejects(p1, /lock holder failed/);
    const r2 = await p2;
    assert.equal(r2, "subsequent call ok");
});

test("withRepoLock: map drains after chain completes", async () => {
    const repo = path.resolve("/repo/test/drain");
    const key = normalizeRepoRoot(repo);

    const p1 = withRepoLock(repo, async () => "p1");
    const p2 = withRepoLock(repo, async () => "p2");
    await Promise.all([p1, p2]);

    assert.equal(repoLocks.has(key), false, "repoLocks map should not retain drained keys");
});

// 3. resolveWorktreeRoot
test("resolveWorktreeRoot: default, absolute override, relative override ignored", () => {
    const defaultRoot = path.join(os.tmpdir(), "aeo-antigravity");
    assert.equal(resolveWorktreeRoot({}), defaultRoot);
    assert.equal(resolveWorktreeRoot({ AEO_WORKTREE_ROOT: "" }), defaultRoot);
    assert.equal(resolveWorktreeRoot({ AEO_WORKTREE_ROOT: "   " }), defaultRoot);
    assert.equal(resolveWorktreeRoot({ AEO_WORKTREE_ROOT: "relative/path" }), defaultRoot);

    const absOverride = path.resolve("/custom/aeo/worktrees");
    assert.equal(
        resolveWorktreeRoot({ AEO_WORKTREE_ROOT: `   ${absOverride}   ` }),
        absOverride
    );
});

// 4. newDelegationId, DELEGATION_ID, isValidDelegationId
test("newDelegationId generates 10 lowercase hex chars matching DELEGATION_ID", () => {
    const id = newDelegationId();
    assert.equal(typeof id, "string");
    assert.equal(id.length, 10);
    assert.match(id, DELEGATION_ID);
    assert.ok(isValidDelegationId(id));

    // Custom randomBytes injection
    const custom = newDelegationId(() => Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee]));
    assert.equal(custom, "aabbccddee");
    assert.ok(isValidDelegationId(custom));
});

// 5. repoKey
test("repoKey produces 12 lowercase hex characters and normalizes path", () => {
    const k1 = repoKey("/some/repo/path");
    assert.equal(k1.length, 12);
    assert.match(k1, /^[a-f0-9]{12}$/);

    if (process.platform === "win32") {
        assert.equal(repoKey("C:\\MyRepo"), repoKey("c:\\myrepo"));
    }
});

// 6. delegationPaths
test("delegationPaths rejects ../x, uppercase, wrong length", () => {
    const wtRoot = path.resolve("/tmp/aeo");
    const repo = path.resolve("/repo");

    assert.throws(() => delegationPaths(wtRoot, repo, "../x"), /Invalid delegation ID/);
    assert.throws(() => delegationPaths(wtRoot, repo, "012345678A"), /Invalid delegation ID/);
    assert.throws(() => delegationPaths(wtRoot, repo, "012345678"), /Invalid delegation ID/);
    assert.throws(() => delegationPaths(wtRoot, repo, "0123456789a"), /Invalid delegation ID/);
    assert.throws(() => delegationPaths(wtRoot, repo, "invalid-id"), /Invalid delegation ID/);
});

test("delegationPaths returns expected layout for valid delegationId", () => {
    const wtRoot = path.resolve("/tmp/aeo");
    const repo = path.resolve("/repo");
    const id = "0123456789";

    const paths = delegationPaths(wtRoot, repo, id);
    const expectedDir = path.join(wtRoot, repoKey(repo), id);
    assert.equal(paths.dir, expectedDir);
    assert.equal(paths.worktreePath, path.join(expectedDir, "wt"));
    assert.equal(paths.metaPath, path.join(expectedDir, "meta.json"));
    assert.equal(paths.patchPath, path.join(expectedDir, "delegation.patch"));
});

// 7. resolveRepoRoot
test("resolveRepoRoot: success", async () => {
    const expectedRepo = path.resolve("/work/my-project");
    const { spawnImpl, calls } = mockGitSpawn({ stdout: `${expectedRepo}\n`, code: 0 });

    const result = await resolveRepoRoot("/work/my-project/packages/lib", { spawnImpl });
    assert.equal(result.ok, true);
    assert.equal(result.repoRoot, expectedRepo);
    assert.deepEqual(calls[0].args, ["-c", "core.longpaths=true", "rev-parse", "--show-toplevel"]);
});

test("resolveRepoRoot: not a repo", async () => {
    const { spawnImpl } = mockGitSpawn({
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
        code: 128
    });

    const result = await resolveRepoRoot("/tmp", { spawnImpl });
    assert.equal(result.ok, false);
    assert.match(result.error, /not inside a git repository/i);
});

test("resolveRepoRoot: git missing", async () => {
    const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const { spawnImpl } = mockGitSpawn({ error: enoent });

    const result = await resolveRepoRoot("/tmp", { spawnImpl });
    assert.equal(result.ok, false);
    assert.match(result.error, /git executable not found/i);
});

// 8. createWorktree
test("createWorktree executes exact git arg sequence with cwd=repoRoot and writes meta.json", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-test-"));
    const repoRoot = path.resolve("/mock/repo");
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const delegationId = "abcdef0123";

    const { spawnImpl, calls } = mockGitSpawn((args) => {
        const sub = args.slice(2);
        if (sub[0] === "rev-parse" && sub[1] === "--show-toplevel") {
            return { stdout: `${repoRoot}\n`, code: 0 };
        }
        if (sub[0] === "rev-parse" && sub[1] === "HEAD") {
            return { stdout: `${sha}\n`, code: 0 };
        }
        if (sub[0] === "status" && sub[1] === "--short") {
            return { stdout: " M lib/foo.js\n?? newfile.js\n", code: 0 };
        }
        if (sub[0] === "worktree" && sub[1] === "add") {
            return { code: 0 };
        }
        return { code: 0 };
    });

    try {
        const result = await createWorktree({
            cwd: path.join(repoRoot, "subdir"),
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl,
            randomBytesImpl: () => Buffer.from([0xab, 0xcd, 0xef, 0x01, 0x23])
        });

        assert.equal(result.ok, true);
        assert.equal(result.delegationId, delegationId);
        assert.equal(result.repoRoot, repoRoot);
        assert.equal(result.baseCommit, sha);
        assert.equal(result.mainTreeStatus, "M lib/foo.js\n?? newfile.js");

        // Verify git call sequence
        assert.equal(calls.length, 4);
        assert.deepEqual(calls[0].args.slice(2), ["rev-parse", "--show-toplevel"]);
        assert.deepEqual(calls[1].args.slice(2), ["rev-parse", "HEAD"]);
        assert.equal(calls[1].options.cwd, repoRoot);
        assert.deepEqual(calls[2].args.slice(2), ["status", "--short"]);
        assert.equal(calls[2].options.cwd, repoRoot);
        assert.deepEqual(calls[3].args.slice(2), [
            "worktree",
            "add",
            "--detach",
            "--",
            result.worktreePath,
            sha
        ]);
        assert.equal(calls[3].options.cwd, repoRoot);

        // Verify meta.json content
        const metaContent = await readFile(result.metaPath, "utf8");
        const meta = JSON.parse(metaContent);
        assert.equal(meta.delegationId, delegationId);
        assert.equal(meta.repoRoot, repoRoot);
        assert.equal(meta.baseCommit, sha);
        assert.equal(meta.worktreePath, result.worktreePath);
        assert.equal(meta.patchPath, result.patchPath);
        assert.ok(meta.createdAt);
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("createWorktree fails cleanly when repo has no commits", async () => {
    const repoRoot = path.resolve("/mock/empty-repo");
    const { spawnImpl } = mockGitSpawn((args) => {
        const sub = args.slice(2);
        if (sub[0] === "rev-parse" && sub[1] === "--show-toplevel") {
            return { stdout: `${repoRoot}\n`, code: 0 };
        }
        if (sub[0] === "rev-parse" && sub[1] === "HEAD") {
            return { stderr: "fatal: ambiguous argument 'HEAD': unknown revision\n", code: 128 };
        }
        return { code: 0 };
    });

    const result = await createWorktree({ cwd: repoRoot, spawnImpl });
    assert.equal(result.ok, false);
    assert.match(result.error, /Repository has no commits/i);
});

test("createWorktree fails cleanly when worktree add exits non-zero", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-fail-"));
    const repoRoot = path.resolve("/mock/repo");

    const { spawnImpl } = mockGitSpawn((args) => {
        const sub = args.slice(2);
        if (sub[0] === "rev-parse" && sub[1] === "--show-toplevel") {
            return { stdout: `${repoRoot}\n`, code: 0 };
        }
        if (sub[0] === "rev-parse" && sub[1] === "HEAD") {
            return { stdout: "1111111111222222222233333333334444444444\n", code: 0 };
        }
        if (sub[0] === "status" && sub[1] === "--short") {
            return { stdout: "", code: 0 };
        }
        if (sub[0] === "worktree" && sub[1] === "add") {
            return { stderr: "fatal: unable to create worktree: permission denied\n", code: 128 };
        }
        return { code: 0 };
    });

    try {
        const result = await createWorktree({
            cwd: repoRoot,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl
        });
        assert.equal(result.ok, false);
        assert.match(result.error, /git worktree add failed/i);
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("two concurrent createWorktree calls on the same repo do not interleave their git calls", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-race-"));
    const repoRoot = path.resolve("/mock/repo/serial-worktrees");
    const gitLog = [];

    let count = 0;
    const { spawnImpl } = mockGitSpawn((args) => {
        const sub = args.slice(2);
        const cmdName = sub.join(" ");
        gitLog.push(cmdName);

        if (sub[0] === "rev-parse" && sub[1] === "--show-toplevel") {
            return { stdout: `${repoRoot}\n`, code: 0 };
        }
        if (sub[0] === "rev-parse" && sub[1] === "HEAD") {
            return { stdout: "commit1234567890abcdef1234567890abcdef12\n", code: 0 };
        }
        if (sub[0] === "status" && sub[1] === "--short") {
            return { stdout: "", code: 0 };
        }
        if (sub[0] === "worktree" && sub[1] === "add") {
            return { code: 0 };
        }
        return { code: 0 };
    });

    try {
        const p1 = createWorktree({
            cwd: repoRoot,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl,
            randomBytesImpl: () => Buffer.from([0x11, 0x11, 0x11, 0x11, 0x11])
        });

        const p2 = createWorktree({
            cwd: repoRoot,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl,
            randomBytesImpl: () => Buffer.from([0x22, 0x22, 0x22, 0x22, 0x22])
        });

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1.ok, true);
        assert.equal(r2.ok, true);

        // Filter for git operations run inside withRepoLock
        const lockedGitOps = gitLog.filter((cmd) => !cmd.includes("--show-toplevel"));
        // Each call should run HEAD, status --short, worktree add in exact succession without interleaving
        assert.equal(lockedGitOps.length, 6);
        assert.equal(lockedGitOps[0], "rev-parse HEAD");
        assert.equal(lockedGitOps[1], "status --short");
        assert.ok(lockedGitOps[2].startsWith("worktree add --detach --"));

        assert.equal(lockedGitOps[3], "rev-parse HEAD");
        assert.equal(lockedGitOps[4], "status --short");
        assert.ok(lockedGitOps[5].startsWith("worktree add --detach --"));
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

// 9. loadDelegation
test("loadDelegation: round trip success", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-load-"));
    const repoRoot = path.resolve("/mock/repo/load");
    const delegationId = "1234567890";

    const { spawnImpl } = mockGitSpawn({ stdout: `${repoRoot}\n`, code: 0 });

    const paths = delegationPaths(tmpWorktreeRoot, repoRoot, delegationId);
    await mkdir(paths.worktreePath, { recursive: true });

    const expectedMeta = {
        delegationId,
        repoRoot,
        baseCommit: "abcdef1234567890abcdef1234567890abcdef12",
        worktreePath: paths.worktreePath,
        patchPath: paths.patchPath,
        createdAt: new Date().toISOString()
    };
    await writeFile(paths.metaPath, JSON.stringify(expectedMeta), "utf8");

    try {
        const result = await loadDelegation({
            cwd: repoRoot,
            delegationId,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl
        });

        assert.equal(result.ok, true);
        assert.equal(result.delegationId, delegationId);
        assert.equal(result.repoRoot, repoRoot);
        assert.equal(result.baseCommit, expectedMeta.baseCommit);
        assert.equal(result.worktreePath, paths.worktreePath);
        assert.equal(result.patchPath, paths.patchPath);
        assert.equal(result.metaPath, paths.metaPath);
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("loadDelegation: returns authoritative paths and ignores foreign paths in meta.json", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-foreign-"));
    const repoRoot = path.resolve("/mock/repo/foreign");
    const delegationId = "aabbcc1122";

    const { spawnImpl } = mockGitSpawn({ stdout: `${repoRoot}\n`, code: 0 });

    const paths = delegationPaths(tmpWorktreeRoot, repoRoot, delegationId);
    await mkdir(paths.worktreePath, { recursive: true });

    const foreignMeta = {
        delegationId,
        repoRoot,
        baseCommit: "commit1234567890abcdef1234567890abcdef12",
        worktreePath: "/foreign/malicious/worktree",
        patchPath: "/foreign/malicious/delegation.patch",
        metaPath: "/foreign/malicious/meta.json",
        extraField: "ignored",
        createdAt: new Date().toISOString()
    };
    await writeFile(paths.metaPath, JSON.stringify(foreignMeta), "utf8");

    try {
        const result = await loadDelegation({
            cwd: repoRoot,
            delegationId,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl
        });

        assert.equal(result.ok, true);
        assert.equal(result.delegationId, delegationId);
        assert.equal(result.repoRoot, repoRoot);
        assert.equal(result.baseCommit, foreignMeta.baseCommit);
        assert.equal(result.createdAt, foreignMeta.createdAt);
        assert.equal(result.worktreePath, paths.worktreePath);
        assert.equal(result.patchPath, paths.patchPath);
        assert.equal(result.metaPath, paths.metaPath);
        assert.equal(result.extraField, undefined);
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("loadDelegation: invalid id", async () => {
    const result = await loadDelegation({ cwd: "/mock/repo", delegationId: "not-valid" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_id");
    assert.match(result.error, /Invalid delegation ID/);
});

test("loadDelegation: unknown id", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-unknown-"));
    const repoRoot = path.resolve("/mock/repo");
    const { spawnImpl } = mockGitSpawn({ stdout: `${repoRoot}\n`, code: 0 });

    try {
        const result = await loadDelegation({
            cwd: repoRoot,
            delegationId: "0000000000",
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "unknown_id");
        assert.match(result.error, /Unknown delegation ID/);
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("loadDelegation: corrupt meta", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-corrupt-"));
    const repoRoot = path.resolve("/mock/repo/corrupt");
    const delegationId = "1122334455";

    const { spawnImpl } = mockGitSpawn({ stdout: `${repoRoot}\n`, code: 0 });
    const paths = delegationPaths(tmpWorktreeRoot, repoRoot, delegationId);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.metaPath, "NOT_VALID_JSON{", "utf8");

    try {
        const result = await loadDelegation({
            cwd: repoRoot,
            delegationId,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "corrupt_meta");
        assert.match(result.error, /Corrupt delegation metadata/);
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("loadDelegation: missing worktree directory", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-missing-"));
    const repoRoot = path.resolve("/mock/repo");
    const delegationId = "9988776655";
    const { spawnImpl } = mockGitSpawn({ stdout: `${repoRoot}\n`, code: 0 });

    const paths = delegationPaths(tmpWorktreeRoot, repoRoot, delegationId);
    await mkdir(paths.dir, { recursive: true });

    const meta = {
        delegationId,
        repoRoot,
        baseCommit: "123456",
        worktreePath: paths.worktreePath,
        patchPath: paths.patchPath,
        createdAt: new Date().toISOString()
    };
    await writeFile(paths.metaPath, JSON.stringify(meta), "utf8");

    try {
        const result = await loadDelegation({
            cwd: repoRoot,
            delegationId,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "missing_worktree");
        assert.match(result.error, /Missing worktree directory/);
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("loadDelegation: repo mismatch", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-mismatch-"));
    const currentRepo = path.resolve("/mock/current-repo");
    const storedRepo = path.resolve("/mock/other-repo");
    const delegationId = "5544332211";
    const { spawnImpl } = mockGitSpawn({ stdout: `${currentRepo}\n`, code: 0 });

    const paths = delegationPaths(tmpWorktreeRoot, currentRepo, delegationId);
    await mkdir(paths.worktreePath, { recursive: true });

    const meta = {
        delegationId,
        repoRoot: storedRepo,
        baseCommit: "123456",
        worktreePath: paths.worktreePath,
        patchPath: paths.patchPath,
        createdAt: new Date().toISOString()
    };
    await writeFile(paths.metaPath, JSON.stringify(meta), "utf8");

    try {
        const result = await loadDelegation({
            cwd: currentRepo,
            delegationId,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "repo_mismatch");
        assert.match(result.error, /Repository mismatch/);
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

// 10. removeWorktree
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
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args.slice(2), [
            "worktree",
            "remove",
            "--force",
            "--",
            paths.worktreePath
        ]);
        assert.equal(calls[0].options.cwd, repoRoot);

        // Verify directory was removed
        await assert.rejects(stat(paths.dir), { code: "ENOENT" });
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
    const customRm = async (p, opts) => {
        order.push("rm");
        return await rm(p, opts);
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
            rmImpl: customRm
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

        // Verify order: rm delegation dir before worktree prune
        assert.deepEqual(order, ["remove", "rm", "prune"]);

        // Directory was still removed
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

    // Injected rmImpl that throws
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

// 11. createWorktree cleanup corrections (C2)
test("createWorktree cleans up delegation directory when worktree add fails", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-add-fail-"));
    const repoRoot = path.resolve("/mock/repo/add-fail");
    let rmCalledWith = null;

    const customRm = async (target, options) => {
        rmCalledWith = target;
        return await rm(target, options);
    };

    const { spawnImpl } = mockGitSpawn((args) => {
        const sub = args.slice(2);
        if (sub[0] === "rev-parse" && sub[1] === "--show-toplevel") {
            return { stdout: `${repoRoot}\n`, code: 0 };
        }
        if (sub[0] === "rev-parse" && sub[1] === "HEAD") {
            return { stdout: "1111111111222222222233333333334444444444\n", code: 0 };
        }
        if (sub[0] === "status" && sub[1] === "--short") {
            return { stdout: "", code: 0 };
        }
        if (sub[0] === "worktree" && sub[1] === "add") {
            return { stderr: "fatal: unable to create worktree: permission denied\n", code: 128 };
        }
        return { code: 0 };
    });

    try {
        const result = await createWorktree({
            cwd: repoRoot,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl,
            rmImpl: customRm
        });

        assert.equal(result.ok, false);
        assert.match(result.error, /git worktree add failed/i);
        assert.ok(rmCalledWith, "rmImpl should have been called to clean up delegation dir");
        await assert.rejects(stat(rmCalledWith), { code: "ENOENT" });
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

test("createWorktree removes worktree and cleans up delegation directory when meta write fails", async () => {
    const tmpWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-meta-fail-"));
    const repoRoot = path.resolve("/mock/repo/meta-fail");
    let rmCalledWith = null;

    const customRm = async (target, options) => {
        rmCalledWith = target;
        return await rm(target, options);
    };

    const { spawnImpl, calls } = mockGitSpawn((args) => {
        const sub = args.slice(2);
        if (sub[0] === "rev-parse" && sub[1] === "--show-toplevel") {
            return { stdout: `${repoRoot}\n`, code: 0 };
        }
        if (sub[0] === "rev-parse" && sub[1] === "HEAD") {
            return { stdout: "1111111111222222222233333333334444444444\n", code: 0 };
        }
        if (sub[0] === "status" && sub[1] === "--short") {
            return { stdout: "", code: 0 };
        }
        if (sub[0] === "worktree" && sub[1] === "add") {
            return { code: 0 };
        }
        if (sub[0] === "worktree" && sub[1] === "remove") {
            return { code: 0 };
        }
        return { code: 0 };
    });

    try {
        const result = await createWorktree({
            cwd: repoRoot,
            env: { AEO_WORKTREE_ROOT: tmpWorktreeRoot },
            spawnImpl,
            writeFileImpl: async () => {
                throw new Error("disk full");
            },
            rmImpl: customRm
        });

        assert.equal(result.ok, false);
        assert.match(result.error, /Failed to write delegation metadata: disk full/i);

        // Verify git call sequence included worktree remove --force inside the lock
        assert.equal(calls.length, 5);
        assert.deepEqual(calls[4].args.slice(2, 5), ["worktree", "remove", "--force"]);
        assert.equal(calls[4].options.cwd, repoRoot);

        // Verify delegation directory was removed
        assert.ok(rmCalledWith, "rmImpl should have been called to clean up delegation dir");
        await assert.rejects(stat(rmCalledWith), { code: "ENOENT" });
    } finally {
        await rm(tmpWorktreeRoot, { recursive: true, force: true });
    }
});

// 12. buildPatch
test("buildPatch: exact git call sequence with cwd=worktreePath, writes patch, and returns hasChanges=true", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-build-patch-"));
    const worktreePath = path.join(tmpDir, "wt");
    const patchPath = path.join(tmpDir, "delegation.patch");
    const diffOutput = "diff --git a/file.txt b/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1 @@\n+hello\n";
    const statOutput = " file.txt | 1 +\n 1 file changed, 1 insertion(+)\n";

    const { spawnImpl, calls } = mockGitSpawn((args) => {
        const sub = args.slice(2);
        if (sub[0] === "add" && sub[1] === "-A") {
            return { code: 0 };
        }
        if (sub[0] === "diff" && sub[1] === "--cached" && sub[2] === "--binary" && sub[3] === `--output=${patchPath}` && sub[4] === "HEAD") {
            writeFileSync(patchPath, diffOutput);
            return { code: 0 };
        }
        if (sub[0] === "diff" && sub[1] === "--cached" && sub[2] === "--stat" && sub[3] === "HEAD") {
            return { stdout: statOutput, code: 0 };
        }
        return { code: 0 };
    });

    try {
        const result = await buildPatch({
            worktreePath,
            patchPath,
            spawnImpl
        });

        assert.equal(result.ok, true);
        assert.equal(result.hasChanges, true);
        assert.equal(result.patchPath, patchPath);
        assert.equal(result.diffstat, statOutput.trim());

        // Verify git call sequence and cwd for all three calls
        assert.equal(calls.length, 3);
        assert.deepEqual(calls[0].args.slice(2), ["add", "-A"]);
        assert.equal(calls[0].options.cwd, worktreePath);
        assert.deepEqual(calls[1].args, [
            "-c",
            "core.longpaths=true",
            "diff",
            "--cached",
            "--binary",
            `--output=${patchPath}`,
            "HEAD"
        ]);
        assert.equal(calls[1].options.cwd, worktreePath);
        assert.deepEqual(calls[2].args.slice(2), ["diff", "--cached", "--stat", "HEAD"]);
        assert.equal(calls[2].options.cwd, worktreePath);

        // Verify patch file content
        const writtenPatch = await readFile(patchPath, "utf8");
        assert.equal(writtenPatch, diffOutput);
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("buildPatch: when diff is empty writes empty patch file, diffstat is empty string, and hasChanges=false", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-build-patch-empty-"));
    const worktreePath = path.join(tmpDir, "wt");
    const patchPath = path.join(tmpDir, "delegation.patch");

    const { spawnImpl, calls } = mockGitSpawn((args) => {
        const sub = args.slice(2);
        if (sub[0] === "add") {
            return { code: 0 };
        }
        if (sub[0] === "diff" && sub[2] === "--binary") {
            writeFileSync(patchPath, "");
            return { code: 0 };
        }
        if (sub[0] === "diff" && sub[2] === "--stat") {
            return { stdout: "", code: 0 };
        }
        return { code: 0 };
    });

    try {
        const result = await buildPatch({
            worktreePath,
            patchPath,
            spawnImpl
        });

        assert.equal(result.ok, true);
        assert.equal(result.hasChanges, false);
        assert.equal(result.patchPath, patchPath);
        assert.equal(result.diffstat, "");

        assert.equal(calls.length, 3);
        assert.deepEqual(calls[1].args, [
            "-c",
            "core.longpaths=true",
            "diff",
            "--cached",
            "--binary",
            `--output=${patchPath}`,
            "HEAD"
        ]);
        assert.equal(calls[0].options.cwd, worktreePath);
        assert.equal(calls[1].options.cwd, worktreePath);
        assert.equal(calls[2].options.cwd, worktreePath);

        const writtenPatch = await readFile(patchPath, "utf8");
        assert.equal(writtenPatch, "");
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("buildPatch: hasChanges true/false driven by statImpl size", async () => {
    const { spawnImpl } = mockGitSpawn({ code: 0 });

    const resTrue = await buildPatch({
        worktreePath: "/mock/wt",
        patchPath: "/mock/patch",
        spawnImpl,
        statImpl: async () => ({ size: 50 })
    });
    assert.equal(resTrue.ok, true);
    assert.equal(resTrue.hasChanges, true);

    const resFalse = await buildPatch({
        worktreePath: "/mock/wt",
        patchPath: "/mock/patch",
        spawnImpl,
        statImpl: async () => ({ size: 0 })
    });
    assert.equal(resFalse.ok, true);
    assert.equal(resFalse.hasChanges, false);
});

test("buildPatch: failure at git add returns ok:false naming the failing step", async () => {
    const { spawnImpl, calls } = mockGitSpawn([
        { stderr: "fatal: pathspec 'foo' did not match any files\n", code: 128 }
    ]);

    const result = await buildPatch({
        worktreePath: "/mock/wt",
        patchPath: "/mock/patch.patch",
        spawnImpl
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /git add failed/i);
    assert.equal(calls.length, 1);
});

test("buildPatch: failure at git diff returns ok:false naming the failing step", async () => {
    const { spawnImpl, calls } = mockGitSpawn([
        { code: 0 },
        { stderr: "fatal: bad revision 'HEAD'\n", code: 128 }
    ]);

    const result = await buildPatch({
        worktreePath: "/mock/wt",
        patchPath: "/mock/patch.patch",
        spawnImpl
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /git diff failed/i);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, [
        "-c",
        "core.longpaths=true",
        "diff",
        "--cached",
        "--binary",
        "--output=/mock/patch.patch",
        "HEAD"
    ]);
});

test("buildPatch: failure at git diff --stat returns ok:false naming the failing step", async () => {
    const { spawnImpl, calls } = mockGitSpawn([
        { code: 0 },
        { code: 0 },
        { stderr: "fatal: stat failed\n", code: 128 }
    ]);

    const result = await buildPatch({
        worktreePath: "/mock/wt",
        patchPath: "/mock/patch.patch",
        spawnImpl,
        statImpl: async () => ({ size: 0 })
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /git diff --stat failed/i);
    assert.equal(calls.length, 3);
});

test("buildPatch: invalid inputs or stat error returns ok:false cleanly", async () => {
    const resNoWt = await buildPatch({ patchPath: "/mock/patch" });
    assert.equal(resNoWt.ok, false);
    assert.match(resNoWt.error, /worktreePath is required/);

    const resNoPatch = await buildPatch({ worktreePath: "/mock/wt" });
    assert.equal(resNoPatch.ok, false);
    assert.match(resNoPatch.error, /patchPath is required/);

    const { spawnImpl } = mockGitSpawn({ code: 0 });
    const resStatErr = await buildPatch({
        worktreePath: "/mock/wt",
        patchPath: "/mock/patch",
        spawnImpl,
        statImpl: () => {
            throw new Error("EACCES: permission denied");
        }
    });
    assert.equal(resStatErr.ok, false);
    assert.match(resStatErr.error, /permission denied/);
    assert.match(resStatErr.error, /stat failed/i);
});

// 13. applyPatch
test("applyPatch: check-then-apply order with exact args and cwd=repoRoot, no --index or --3way", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-apply-success-"));
    const repoRoot = path.resolve("/mock/repo/apply-ok");
    const patchPath = path.join(tmpDir, "changes.patch");
    await writeFile(patchPath, "patch content here\n");

    const { spawnImpl, calls } = mockGitSpawn({ code: 0 });

    try {
        const result = await applyPatch({
            repoRoot,
            patchPath,
            spawnImpl
        });

        assert.equal(result.ok, true);
        assert.equal(result.applied, true);

        assert.equal(calls.length, 2);
        // Call 1: check
        assert.deepEqual(calls[0].args.slice(2), [
            "apply",
            "--check",
            "--binary",
            "--whitespace=nowarn",
            "--",
            patchPath
        ]);
        assert.equal(calls[0].options.cwd, repoRoot);

        // Call 2: apply
        assert.deepEqual(calls[1].args.slice(2), [
            "apply",
            "--binary",
            "--whitespace=nowarn",
            "--",
            patchPath
        ]);
        assert.equal(calls[1].options.cwd, repoRoot);

        // Verify neither call contains --index or --3way
        for (const call of calls) {
            assert.ok(!call.args.includes("--index"), "should not include --index");
            assert.ok(!call.args.includes("--3way"), "should not include --3way");
        }
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("applyPatch: --check failure returns apply_conflict and no second apply call", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-apply-conflict-"));
    const repoRoot = path.resolve("/mock/repo/apply-conflict");
    const patchPath = path.join(tmpDir, "conflict.patch");
    await writeFile(patchPath, "patch content\n");

    const conflictErr = "error: patch failed: lib/index.js:5\nerror: lib/index.js: patch does not apply";
    const { spawnImpl, calls } = mockGitSpawn([
        { stderr: `${conflictErr}\n`, code: 1 }
    ]);

    try {
        const result = await applyPatch({
            repoRoot,
            patchPath,
            spawnImpl
        });

        assert.equal(result.ok, false);
        assert.equal(result.outcome, "apply_conflict");
        assert.equal(result.error, conflictErr);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args.slice(2), [
            "apply",
            "--check",
            "--binary",
            "--whitespace=nowarn",
            "--",
            patchPath
        ]);
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("applyPatch: apply failure returns apply_error", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-apply-fail-"));
    const repoRoot = path.resolve("/mock/repo/apply-fail");
    const patchPath = path.join(tmpDir, "changes.patch");
    await writeFile(patchPath, "patch content\n");

    const { spawnImpl, calls } = mockGitSpawn([
        { code: 0 },
        { stderr: "error: cannot apply binary patch to lib/asset.png without full index line\n", code: 1 }
    ]);

    try {
        const result = await applyPatch({
            repoRoot,
            patchPath,
            spawnImpl
        });

        assert.equal(result.ok, false);
        assert.equal(result.outcome, "apply_error");
        assert.match(result.error, /cannot apply binary patch/);
        assert.equal(calls.length, 2);
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("applyPatch: empty patch (size 0) returns applied:false with reason 'no changes' and no git calls", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-apply-empty-"));
    const repoRoot = path.resolve("/mock/repo/apply-empty");
    const patchPath = path.join(tmpDir, "empty.patch");
    await writeFile(patchPath, ""); // 0 bytes

    const { spawnImpl, calls } = mockGitSpawn({ code: 0 });

    try {
        const result = await applyPatch({
            repoRoot,
            patchPath,
            spawnImpl
        });

        assert.equal(result.ok, true);
        assert.equal(result.applied, false);
        assert.equal(result.reason, "no changes");
        assert.equal(calls.length, 0);
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("applyPatch: missing patch returns apply_error and no git calls", async () => {
    const repoRoot = path.resolve("/mock/repo/apply-missing");
    const patchPath = path.resolve("/nonexistent/file.patch");

    const { spawnImpl, calls } = mockGitSpawn({ code: 0 });

    const result = await applyPatch({
        repoRoot,
        patchPath,
        spawnImpl
    });

    assert.equal(result.ok, false);
    assert.equal(result.outcome, "apply_error");
    assert.match(result.error, /Patch file missing or inaccessible/);
    assert.equal(calls.length, 0);
});

test("applyPatch: git spawn error (ENOENT) returns apply_error", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-apply-enoent-"));
    const repoRoot = path.resolve("/mock/repo/apply-enoent");
    const patchPath = path.join(tmpDir, "changes.patch");
    await writeFile(patchPath, "some patch\n");

    const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const { spawnImpl } = mockGitSpawn({ error: enoent });

    try {
        const result = await applyPatch({
            repoRoot,
            patchPath,
            spawnImpl
        });

        assert.equal(result.ok, false);
        assert.equal(result.outcome, "apply_error");
        assert.match(result.error, /git apply --check execution failed/);
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("two concurrent applyPatch calls on the same repoRoot do not interleave", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aeo-wt-apply-concurrent-"));
    const repoRoot = path.resolve("/mock/repo/apply-serialized");
    const patch1 = path.join(tmpDir, "1.patch");
    const patch2 = path.join(tmpDir, "2.patch");
    await writeFile(patch1, "patch 1 content\n");
    await writeFile(patch2, "patch 2 content\n");

    const callLog = [];
    const { spawnImpl } = mockGitSpawn((args) => {
        const sub = args.slice(2);
        callLog.push({ cmd: sub[0], flag: sub[1], patch: sub[sub.length - 1] });
        return { code: 0 };
    });

    try {
        const p1 = applyPatch({
            repoRoot,
            patchPath: patch1,
            spawnImpl
        });

        const p2 = applyPatch({
            repoRoot,
            patchPath: patch2,
            spawnImpl
        });

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1.ok, true);
        assert.equal(r2.ok, true);

        assert.equal(callLog.length, 4);
        // The first patch's check and apply must finish before the second patch's check starts
        const firstPatch = callLog[0].patch;
        assert.equal(callLog[0].patch, firstPatch);
        assert.equal(callLog[0].flag, "--check");
        assert.equal(callLog[1].patch, firstPatch);
        assert.equal(callLog[1].flag, "--binary");

        const secondPatch = firstPatch === patch1 ? patch2 : patch1;
        assert.equal(callLog[2].patch, secondPatch);
        assert.equal(callLog[2].flag, "--check");
        assert.equal(callLog[3].patch, secondPatch);
        assert.equal(callLog[3].flag, "--binary");
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});

test("applyPatch: missing repoRoot or patchPath returns outcome: apply_error", async () => {
    const resNoRepo = await applyPatch({ patchPath: "/mock/patch" });
    assert.equal(resNoRepo.ok, false);
    assert.equal(resNoRepo.outcome, "apply_error");
    assert.match(resNoRepo.error, /repoRoot is required/);

    const resNoPatch = await applyPatch({ repoRoot: "/mock/repo" });
    assert.equal(resNoPatch.ok, false);
    assert.equal(resNoPatch.outcome, "apply_error");
    assert.match(resNoPatch.error, /patchPath is required/);
});

