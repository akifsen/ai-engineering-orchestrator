import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DELEGATION_ID = /^[a-f0-9]{10}$/;

export const repoLocks = new Map();

export function normalizeRepoRoot(repoRoot) {
    const resolved = path.resolve(repoRoot);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isValidDelegationId(id) {
    return typeof id === "string" && DELEGATION_ID.test(id);
}

export function newDelegationId(randomBytesImpl = crypto.randomBytes) {
    return randomBytesImpl(5).toString("hex").toLowerCase();
}

export function repoKey(repoRoot) {
    const normalized = normalizeRepoRoot(repoRoot);
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function resolveWorktreeRoot(env = process.env) {
    const raw = env?.AEO_WORKTREE_ROOT;
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed && path.isAbsolute(trimmed)) {
            return trimmed;
        }
    }

    return path.join(os.tmpdir(), "aeo-antigravity");
}

export function delegationPaths(worktreeRoot, repoRoot, delegationId) {
    if (!isValidDelegationId(delegationId)) {
        throw new Error(`Invalid delegation ID: ${delegationId}`);
    }

    const dir = path.join(worktreeRoot, repoKey(repoRoot), delegationId);
    return {
        dir,
        worktreePath: path.join(dir, "wt"),
        metaPath: path.join(dir, "meta.json"),
        patchPath: path.join(dir, "delegation.patch")
    };
}

export function runGit(args, { cwd, spawnImpl = spawn } = {}) {
    return new Promise((resolve) => {
        const fullArgs = ["-c", "core.longpaths=true", ...args];
        const stdoutChunks = [];
        const stderrChunks = [];
        let settled = false;

        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(result);
        };

        let child;
        try {
            child = spawnImpl("git", fullArgs, {
                cwd,
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"]
            });
        } catch (error) {
            finish({ code: null, stdout: "", stderr: "", error });
            return;
        }

        child.on?.("error", (error) => {
            finish({
                code: null,
                stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                stderr: Buffer.concat(stderrChunks).toString("utf8"),
                error
            });
        });

        child.stdout?.on?.("data", (chunk) => {
            if (chunk) {
                stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            }
        });

        child.stderr?.on?.("data", (chunk) => {
            if (chunk) {
                stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            }
        });

        child.on?.("close", (code) => {
            finish({
                code,
                stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                stderr: Buffer.concat(stderrChunks).toString("utf8")
            });
        });
    });
}

export async function withRepoLock(repoRoot, fn) {
    const key = normalizeRepoRoot(repoRoot);
    const prev = repoLocks.get(key) ?? Promise.resolve();

    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });

    repoLocks.set(key, current);

    await prev.catch(() => {});

    try {
        return await fn();
    } finally {
        release();
        if (repoLocks.get(key) === current) {
            repoLocks.delete(key);
        }
    }
}

export async function resolveRepoRoot(cwd, deps = {}) {
    const { spawnImpl = spawn } = deps || {};
    const result = await runGit(["rev-parse", "--show-toplevel"], { cwd, spawnImpl });

    if (result.error) {
        if (result.error.code === "ENOENT" || /ENOENT/i.test(result.error.message)) {
            return {
                ok: false,
                error: `git executable not found: ${result.error.message || result.error}`
            };
        }

        return {
            ok: false,
            error: `git execution failed: ${result.error.message || result.error}`
        };
    }

    if (result.code !== 0) {
        return {
            ok: false,
            error: `Not inside a git repository: ${result.stderr?.trim() || `exit code ${result.code}`}`
        };
    }

    const trimmed = result.stdout.trim();
    if (!trimmed) {
        return {
            ok: false,
            error: "Not inside a git repository: empty output from rev-parse --show-toplevel"
        };
    }

    return {
        ok: true,
        repoRoot: path.resolve(trimmed)
    };
}

export async function createWorktree({
    cwd,
    env = process.env,
    spawnImpl = spawn,
    randomBytesImpl = crypto.randomBytes,
    mkdirImpl = mkdir,
    writeFileImpl = writeFile,
    rmImpl = rm
} = {}) {
    try {
        const repoResult = await resolveRepoRoot(cwd, { spawnImpl });
        if (!repoResult.ok) {
            return { ok: false, error: repoResult.error };
        }

        const repoRoot = repoResult.repoRoot;

        return await withRepoLock(repoRoot, async () => {
            const headRes = await runGit(["rev-parse", "HEAD"], { cwd: repoRoot, spawnImpl });
            if (headRes.code !== 0 || headRes.error) {
                return {
                    ok: false,
                    error: `Repository has no commits: ${headRes.stderr?.trim() || headRes.error?.message || "HEAD resolution failed"}`
                };
            }

            const baseCommit = headRes.stdout.trim();
            if (!baseCommit) {
                return {
                    ok: false,
                    error: "Repository has no commits: rev-parse HEAD returned empty output"
                };
            }

            const statusRes = await runGit(["status", "--short"], { cwd: repoRoot, spawnImpl });
            if (statusRes.error) {
                return {
                    ok: false,
                    error: `Failed to check git status: ${statusRes.error.message || statusRes.error}`
                };
            }

            const mainTreeStatus = statusRes.stdout.trim();

            const delegationId = newDelegationId(randomBytesImpl);
            const worktreeRoot = resolveWorktreeRoot(env);
            const { dir, worktreePath, metaPath, patchPath } = delegationPaths(
                worktreeRoot,
                repoRoot,
                delegationId
            );

            await mkdirImpl(dir, { recursive: true });

            const addRes = await runGit(
                ["worktree", "add", "--detach", "--", worktreePath, baseCommit],
                { cwd: repoRoot, spawnImpl }
            );

            if (addRes.code !== 0 || addRes.error) {
                try {
                    await rmImpl(dir, { recursive: true, force: true });
                } catch {
                    // best-effort cleanup
                }
                return {
                    ok: false,
                    error: `git worktree add failed: ${addRes.stderr?.trim() || addRes.error?.message || "unknown error"}`
                };
            }

            const createdAt = new Date().toISOString();
            const meta = {
                delegationId,
                repoRoot,
                baseCommit,
                worktreePath,
                patchPath,
                createdAt
            };

            try {
                await writeFileImpl(metaPath, JSON.stringify(meta, null, 4), "utf8");
            } catch (metaError) {
                await runGit(
                    ["worktree", "remove", "--force", "--", worktreePath],
                    { cwd: repoRoot, spawnImpl }
                );
                try {
                    await rmImpl(dir, { recursive: true, force: true });
                } catch {
                    // best-effort cleanup
                }
                return {
                    ok: false,
                    error: `Failed to write delegation metadata: ${metaError instanceof Error ? metaError.message : String(metaError)}`
                };
            }

            return {
                ok: true,
                delegationId,
                repoRoot,
                baseCommit,
                worktreePath,
                patchPath,
                metaPath,
                mainTreeStatus
            };
        });
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function loadDelegation({
    cwd,
    delegationId,
    env = process.env,
    spawnImpl = spawn,
    readFileImpl = readFile,
    statImpl = stat
} = {}) {
    try {
        if (!isValidDelegationId(delegationId)) {
            return {
                ok: false,
                reason: "invalid_id",
                error: `Invalid delegation ID: ${delegationId}`
            };
        }

        const repoResult = await resolveRepoRoot(cwd, { spawnImpl });
        if (!repoResult.ok) {
            return { ok: false, error: repoResult.error };
        }

        const currentRepoRoot = repoResult.repoRoot;
        const worktreeRoot = resolveWorktreeRoot(env);
        const { worktreePath, metaPath, patchPath } = delegationPaths(
            worktreeRoot,
            currentRepoRoot,
            delegationId
        );

        let content;
        try {
            content = await readFileImpl(metaPath, "utf8");
        } catch (error) {
            if (error && typeof error === "object" && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
                return {
                    ok: false,
                    reason: "unknown_id",
                    error: `Unknown delegation ID: ${delegationId}`
                };
            }

            return {
                ok: false,
                reason: "read_error",
                error: `Failed to read delegation metadata: ${error instanceof Error ? error.message : String(error)}`
            };
        }

        let meta;
        try {
            meta = JSON.parse(content);
        } catch (error) {
            return {
                ok: false,
                reason: "corrupt_meta",
                error: `Corrupt delegation metadata: ${error instanceof Error ? error.message : String(error)}`
            };
        }

        if (normalizeRepoRoot(meta.repoRoot) !== normalizeRepoRoot(currentRepoRoot)) {
            return {
                ok: false,
                reason: "repo_mismatch",
                error: `Repository mismatch: delegation belongs to ${meta.repoRoot}, not ${currentRepoRoot}`
            };
        }

        try {
            const st = await statImpl(worktreePath);
            if (!st.isDirectory()) {
                return {
                    ok: false,
                    reason: "missing_worktree",
                    repoRoot: meta.repoRoot,
                    error: `Missing worktree directory: ${worktreePath} is not a directory`
                };
            }
        } catch {
            return {
                ok: false,
                reason: "missing_worktree",
                repoRoot: meta.repoRoot,
                error: `Missing worktree directory: ${worktreePath}`
            };
        }

        return {
            ok: true,
            delegationId,
            repoRoot: meta.repoRoot,
            baseCommit: meta.baseCommit,
            createdAt: meta.createdAt,
            worktreePath,
            patchPath,
            metaPath
        };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function removeWorktree({
    repoRoot,
    delegationId,
    env = process.env,
    spawnImpl = spawn,
    rmImpl = rm
} = {}) {
    try {
        if (!isValidDelegationId(delegationId)) {
            return {
                ok: false,
                error: `Invalid delegation ID: ${delegationId}`
            };
        }

        if (!repoRoot || typeof repoRoot !== "string") {
            return {
                ok: false,
                error: "repoRoot is required and must be a string."
            };
        }

        const resolvedRepoRoot = path.resolve(repoRoot);
        const worktreeRoot = resolveWorktreeRoot(env);
        const { dir, worktreePath } = delegationPaths(
            worktreeRoot,
            resolvedRepoRoot,
            delegationId
        );

        return await withRepoLock(resolvedRepoRoot, async () => {
            const removeRes = await runGit(
                ["worktree", "remove", "--force", "--", worktreePath],
                { cwd: resolvedRepoRoot, spawnImpl }
            );

            try {
                await rmImpl(dir, { recursive: true, force: true });
            } catch (error) {
                return {
                    ok: false,
                    error: `Failed to remove delegation directory: ${error instanceof Error ? error.message : String(error)}`
                };
            }

            if (removeRes.code !== 0 || removeRes.error) {
                await runGit(["worktree", "prune"], {
                    cwd: resolvedRepoRoot,
                    spawnImpl
                });
            }

            return { ok: true };
        });
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function buildPatch({
    worktreePath,
    patchPath,
    spawnImpl = spawn,
    statImpl = stat
} = {}) {
    try {
        if (!worktreePath || typeof worktreePath !== "string") {
            return {
                ok: false,
                error: "worktreePath is required and must be a string."
            };
        }

        if (!patchPath || typeof patchPath !== "string") {
            return {
                ok: false,
                error: "patchPath is required and must be a string."
            };
        }

        const addRes = await runGit(["add", "-A"], { cwd: worktreePath, spawnImpl });
        if (addRes.code !== 0 || addRes.error) {
            return {
                ok: false,
                error: `git add failed: ${addRes.stderr?.trim() || addRes.error?.message || `exit code ${addRes.code}`}`
            };
        }

        const diffRes = await runGit(
            ["diff", "--cached", "--binary", `--output=${patchPath}`, "HEAD"],
            { cwd: worktreePath, spawnImpl }
        );
        if (diffRes.code !== 0 || diffRes.error) {
            return {
                ok: false,
                error: `git diff failed: ${diffRes.stderr?.trim() || diffRes.error?.message || `exit code ${diffRes.code}`}`
            };
        }

        const statRes = await runGit(["diff", "--cached", "--stat", "HEAD"], { cwd: worktreePath, spawnImpl });
        if (statRes.code !== 0 || statRes.error) {
            return {
                ok: false,
                error: `git diff --stat failed: ${statRes.stderr?.trim() || statRes.error?.message || `exit code ${statRes.code}`}`
            };
        }

        let st;
        try {
            st = await statImpl(patchPath);
        } catch (error) {
            return {
                ok: false,
                error: `stat failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }

        const hasChanges = (st?.size ?? 0) > 0;
        const diffstat = hasChanges ? statRes.stdout.trim() : "";

        return {
            ok: true,
            hasChanges,
            patchPath,
            diffstat
        };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function applyPatch({
    repoRoot,
    patchPath,
    spawnImpl = spawn,
    statImpl = stat
} = {}) {
    try {
        if (!repoRoot || typeof repoRoot !== "string") {
            return {
                ok: false,
                outcome: "apply_error",
                error: "repoRoot is required and must be a string."
            };
        }

        if (!patchPath || typeof patchPath !== "string") {
            return {
                ok: false,
                outcome: "apply_error",
                error: "patchPath is required and must be a string."
            };
        }

        const resolvedRepoRoot = path.resolve(repoRoot);

        return await withRepoLock(resolvedRepoRoot, async () => {
            let st;
            try {
                st = await statImpl(patchPath);
            } catch (error) {
                return {
                    ok: false,
                    outcome: "apply_error",
                    error: `Patch file missing or inaccessible: ${error instanceof Error ? error.message : String(error)}`
                };
            }

            if (st.size === 0) {
                return {
                    ok: true,
                    applied: false,
                    reason: "no changes"
                };
            }

            const checkRes = await runGit(
                ["apply", "--check", "--binary", "--whitespace=nowarn", "--", patchPath],
                { cwd: resolvedRepoRoot, spawnImpl }
            );

            if (checkRes.error) {
                return {
                    ok: false,
                    outcome: "apply_error",
                    error: `git apply --check execution failed: ${checkRes.error.message || checkRes.error}`
                };
            }

            if (checkRes.code !== 0) {
                return {
                    ok: false,
                    outcome: "apply_conflict",
                    error: checkRes.stderr?.trim() || `git apply --check exited with code ${checkRes.code}`
                };
            }

            const applyRes = await runGit(
                ["apply", "--binary", "--whitespace=nowarn", "--", patchPath],
                { cwd: resolvedRepoRoot, spawnImpl }
            );

            if (applyRes.error) {
                return {
                    ok: false,
                    outcome: "apply_error",
                    error: `git apply execution failed: ${applyRes.error.message || applyRes.error}`
                };
            }

            if (applyRes.code !== 0) {
                return {
                    ok: false,
                    outcome: "apply_error",
                    error: applyRes.stderr?.trim() || `git apply exited with code ${applyRes.code}`
                };
            }

            return {
                ok: true,
                applied: true
            };
        });
    } catch (error) {
        return {
            ok: false,
            outcome: "apply_error",
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

