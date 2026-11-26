import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    applyDelegation,
    buildImplementationPrompt,
    delegateToAntigravity,
    discardDelegation
} from "../lib/delegate.js";
import { writeEventRecord } from "../lib/ledger.js";
import { applyPatch } from "../lib/worktree.js";

const successStdout = JSON.stringify({
    conversation_id: "conv-events",
    status: "SUCCESS",
    response: "Implemented the ledger.",
    duration_seconds: 1,
    num_turns: 2
});

function fakeSpawn(stdout, onRun) {
    return () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write() { return true; }, end() {} };
        child.pid = 4243;
        child.kill = () => {};
        queueMicrotask(async () => {
            if (onRun) {
                await onRun();
            }
            child.stdout.emit("data", stdout);
            child.emit("close", 0);
        });
        return child;
    };
}

async function tempDir() {
    return mkdtemp(path.join(tmpdir(), "agy-ledger-"));
}

function git(cwd, ...args) {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        encoding: "utf8"
    });
}

const onEnv = () => ({ ...process.env, AEO_MEMORY: "on" });

test("ledger disabled leaves the tool result untouched", async () => {
    const directory = await tempDir();
    try {
        git(directory, "init", "-q");
        const result = await delegateToAntigravity(
            { prompt: "Add a ledger.", cwd: directory },
            { spawnImpl: fakeSpawn(successStdout), env: { ...process.env, AEO_MEMORY: "off" } }
        );
        assert.ok(!result.text.includes("Ledger"));
        await assert.rejects(readdir(path.join(directory, ".aeo")));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("apply and discard write apply records; disabled mode adds nothing", async () => {
    const directory = await tempDir();
    const patchPath = path.join(directory, "patch.diff");
    await writeFile(
        patchPath,
        [
            "diff --git a/src/x.js b/src/x.js",
            "--- a/src/x.js",
            "+++ b/src/x.js",
            "@@ -1 +1 @@",
            "-a",
            "+b",
            "diff --git a/.aeo/memory/INDEX.md b/.aeo/memory/INDEX.md",
            "@@ -0,0 +1 @@",
            "+x",
            ""
        ].join("\n")
    );
    const loadDelegation = async () => ({
        ok: true,
        delegationId: "aabbccddee",
        repoRoot: directory,
        baseCommit: "base1",
        worktreePath: path.join(directory, "wt"),
        patchPath
    });
    const input = { cwd: directory, delegationId: "aabbccddee" };
    const env = onEnv();
    const read = async (res) => {
        const last = res.text.split("\n").at(-1);
        assert.match(last, /^Ledger: \.aeo\/memory\/tasks\/.+-apply-aabbccddee-[0-9a-f]{4}\.md$/);
        return readFile(path.join(directory, last.slice("Ledger: ".length)), "utf8");
    };
    try {
        const applied = await applyDelegation(input, {
            env,
            worktree: { loadDelegation, applyPatch: async () => ({ ok: true, applied: true }), removeWorktree: async () => ({ ok: true }) }
        });
        assert.equal(applied.outcome, "applied");
        assert.equal(applied.isError, false);
        const appliedRecord = await read(applied);
        assert.match(appliedRecord, /^---\nschema: 1\nkind: apply\nengineer: antigravity\ndelegation_id: aabbccddee\noutcome: applied\nbase_commit: base1\ncreated: /);
        assert.match(appliedRecord, /## Diffstat\n\nsrc\/x\.js \| \+1 -1\n$/);

        const noChanges = await applyDelegation(input, {
            env,
            worktree: { loadDelegation, applyPatch: async () => ({ ok: true, applied: false, reason: "no changes" }), removeWorktree: async () => ({ ok: true }) }
        });
        assert.equal(noChanges.outcome, "no_changes");
        const ncRecord = await read(noChanges);
        assert.match(ncRecord, /outcome: no_changes/);
        assert.ok(!ncRecord.includes("## Diffstat"));

        const conflict = await applyDelegation(input, {
            env,
            worktree: { loadDelegation, applyPatch: async () => ({ ok: false, outcome: "apply_conflict", error: "nope" }) }
        });
        assert.equal(conflict.outcome, "apply_conflict");
        assert.equal(conflict.isError, true);
        assert.match(await read(conflict), /outcome: apply_conflict/);

        const discarded = await discardDelegation(input, {
            env,
            worktree: {
                resolveRepoRoot: async () => ({ ok: true, repoRoot: directory }),
                loadDelegation,
                removeWorktree: async () => ({ ok: true })
            }
        });
        assert.equal(discarded.outcome, "discarded");
        assert.match(await read(discarded), /outcome: discarded/);

        const off = await discardDelegation(input, {
            env: { ...process.env, AEO_MEMORY: "off" },
            worktree: {
                resolveRepoRoot: async () => ({ ok: true, repoRoot: directory }),
                loadDelegation,
                removeWorktree: async () => ({ ok: true })
            }
        });
        assert.equal(off.text, "Outcome: discarded\nDelegation aabbccddee discarded.");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("worktree-root guard refuses when the repo sits under the bridge worktree root", async () => {
    const parent = await tempDir();
    const repo = path.join(parent, "repo");
    try {
        await mkdir(repo);
        git(repo, "init", "-q");
        const env = { ...process.env, AEO_MEMORY: "on", AEO_WORKTREE_ROOT: parent };
        const result = await delegateToAntigravity(
            { prompt: "Add a ledger.", cwd: repo },
            { spawnImpl: fakeSpawn(successStdout), env }
        );
        assert.equal(result.outcome, "agent_success");
        assert.ok(!result.text.includes("Ledger: "));
        await assert.rejects(readdir(path.join(repo, ".aeo")));

        const direct = await writeEventRecord({
            repoRoot: repo,
            worktreeRoots: [parent],
            env,
            record: { engineer: "antigravity", outcome: "discarded", delegationId: "aabbccddee" }
        });
        assert.equal(direct.written, false);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("integrity warning appears only when .aeo/memory control files change during an in-place run", async () => {
    const directory = await tempDir();
    try {
        git(directory, "init", "-q");
        const memory = path.join(directory, ".aeo", "memory");
        await mkdir(memory, { recursive: true });
        await writeFile(path.join(memory, "INDEX.md"), "old\n");

        const clean = await delegateToAntigravity(
            { prompt: "Do nothing.", cwd: directory },
            { spawnImpl: fakeSpawn(successStdout), env: onEnv() }
        );
        assert.ok(!clean.text.includes("Ledger integrity"));
        assert.ok(clean.text.split("\n").at(-1).startsWith("Ledger: "));

        const dirty = await delegateToAntigravity(
            { prompt: "Touch the index.", cwd: directory },
            {
                spawnImpl: fakeSpawn(successStdout, () => writeFile(path.join(memory, "INDEX.md"), "changed by the engineer\n")),
                env: onEnv()
            }
        );
        const lines = dirty.text.split("\n");
        assert.equal(lines.at(-2), "Ledger integrity: .aeo/memory changed during the run (INDEX.md)");
        assert.ok(lines.at(-1).startsWith("Ledger: "));
        assert.equal(await readFile(path.join(memory, "INDEX.md"), "utf8"), "changed by the engineer\n");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("applyPatch excludes .aeo/memory paths", async () => {
    const repo = await tempDir();
    try {
        git(repo, "init", "-q");
        await mkdir(path.join(repo, "src"), { recursive: true });
        await writeFile(path.join(repo, "src", "x.js"), "a\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "init");

        await writeFile(path.join(repo, "src", "x.js"), "b\n");
        await mkdir(path.join(repo, ".aeo", "memory"), { recursive: true });
        await writeFile(path.join(repo, ".aeo", "memory", "INDEX.md"), "engineer index\n");
        git(repo, "add", "-A", "-f");
        const patch = git(repo, "diff", "--cached", "--binary");
        assert.match(patch, /\.aeo\/memory\/INDEX\.md/);
        git(repo, "reset", "-q", "--hard");
        await rm(path.join(repo, ".aeo"), { recursive: true, force: true });

        const patchPath = path.join(repo, "..", `${path.basename(repo)}.patch`);
        await writeFile(patchPath, patch);
        try {
            const res = await applyPatch({ repoRoot: repo, patchPath });
            assert.equal(res.ok, true, res.error);
            assert.equal((await readFile(path.join(repo, "src", "x.js"), "utf8")).replace(/\r\n/g, "\n"), "b\n");
            await assert.rejects(readFile(path.join(repo, ".aeo", "memory", "INDEX.md"), "utf8"));
        } finally {
            await rm(patchPath, { force: true });
        }
    } finally {
        await rm(repo, { recursive: true, force: true });
    }
});

test("implementation prompt forbids touching .aeo/memory", () => {
    assert.ok(
        buildImplementationPrompt("x").includes(
            "- Do not create, modify, or delete anything under .aeo/memory; the bridge and the Team Lead own it."
        )
    );
});
