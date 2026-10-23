import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { collectConfiguredServers, normalizePath, runPreflight } from "../bench/preflight.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const preflightScript = path.join(repoRoot, "scripts", "bench", "preflight.mjs");

test("ok for K1 with both servers in top-level mcpServers and the rules file present", async () => {
    const tempRepo = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-repo-"));
    const tempConfig = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-cfg-"));
    try {
        await mkdir(path.join(tempRepo, ".claude", "rules"), { recursive: true });
        await writeFile(path.join(tempRepo, ".claude", "rules", "aeo-orchestration.md"), "# Rules\n");
        await writeFile(
            path.join(tempConfig, ".claude.json"),
            JSON.stringify({
                mcpServers: {
                    "aeo-antigravity": { command: "node" },
                    "aeo-cursor": { command: "node" }
                }
            })
        );

        const git = (args) => {
            if (args.includes("rev-parse")) {
                return { status: 0, stdout: "abcdef1234567890\n", stderr: "" };
            }
            if (args.includes("status")) {
                return { status: 0, stdout: "", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
        };

        const res = runPreflight({
            repo: tempRepo,
            commit: "abcdef1",
            condition: "K1",
            configDir: tempConfig,
            expectDirty: [],
            env: { CLAUDE_CONFIG_DIR: tempConfig },
            git
        });

        assert.equal(res.ok, true, res.failures.join("; "));
        assert.equal(res.failures.length, 0);
        assert.equal(res.warnings.length, 0);
    } finally {
        await rm(tempRepo, { recursive: true, force: true });
        await rm(tempConfig, { recursive: true, force: true });
    }
});

test("K0 fails when servers present", async () => {
    const tempRepo = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-repo-"));
    const tempConfig = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-cfg-"));
    try {
        await writeFile(
            path.join(tempConfig, ".claude.json"),
            JSON.stringify({
                mcpServers: {
                    "aeo-antigravity": { command: "node" }
                }
            })
        );

        const git = (args) => {
            if (args.includes("rev-parse")) return { status: 0, stdout: "abcdef1234567890\n", stderr: "" };
            if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };
            return { status: 0, stdout: "", stderr: "" };
        };

        const res = runPreflight({
            repo: tempRepo,
            commit: "abcdef1",
            condition: "K0",
            configDir: tempConfig,
            expectDirty: [],
            env: { CLAUDE_CONFIG_DIR: tempConfig },
            git
        });

        assert.equal(res.ok, false);
        assert.ok(res.failures.some((f) => f.includes("condition K0 forbids configured servers")));
    } finally {
        await rm(tempRepo, { recursive: true, force: true });
        await rm(tempConfig, { recursive: true, force: true });
    }
});

test("K0 fails when rules file present", async () => {
    const tempRepo = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-repo-"));
    const tempConfig = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-cfg-"));
    try {
        await mkdir(path.join(tempRepo, ".claude", "rules"), { recursive: true });
        await writeFile(path.join(tempRepo, ".claude", "rules", "aeo-orchestration.md"), "# Rules\n");
        await writeFile(path.join(tempConfig, ".claude.json"), JSON.stringify({ mcpServers: {} }));

        const git = (args) => {
            if (args.includes("rev-parse")) return { status: 0, stdout: "abcdef1234567890\n", stderr: "" };
            if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };
            return { status: 0, stdout: "", stderr: "" };
        };

        const res = runPreflight({
            repo: tempRepo,
            commit: "abcdef1",
            condition: "K0",
            configDir: tempConfig,
            expectDirty: [],
            env: { CLAUDE_CONFIG_DIR: tempConfig },
            git
        });

        assert.equal(res.ok, false);
        assert.ok(
            res.failures.some((f) => f.includes("condition K0 requires .claude/rules/aeo-orchestration.md to NOT exist"))
        );
    } finally {
        await rm(tempRepo, { recursive: true, force: true });
        await rm(tempConfig, { recursive: true, force: true });
    }
});

test("commit mismatch fails", async () => {
    const tempRepo = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-repo-"));
    const tempConfig = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-cfg-"));
    try {
        const git = (args) => {
            if (args.includes("rev-parse")) return { status: 0, stdout: "11111112222222\n", stderr: "" };
            if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };
            return { status: 0, stdout: "", stderr: "" };
        };

        const res = runPreflight({
            repo: tempRepo,
            commit: "abcdef1",
            condition: "K0",
            configDir: tempConfig,
            expectDirty: [],
            env: { CLAUDE_CONFIG_DIR: tempConfig },
            git
        });

        assert.equal(res.ok, false);
        assert.ok(res.failures.some((f) => f.includes("commit mismatch")));
    } finally {
        await rm(tempRepo, { recursive: true, force: true });
        await rm(tempConfig, { recursive: true, force: true });
    }
});

test("dirty tree without --expect-dirty fails and lists the path", async () => {
    const tempRepo = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-repo-"));
    const tempConfig = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-cfg-"));
    try {
        const git = (args) => {
            if (args.includes("rev-parse")) return { status: 0, stdout: "abcdef1234567890\n", stderr: "" };
            if (args.includes("status")) return { status: 0, stdout: " M src/index.js\n?? untracked.txt\n", stderr: "" };
            return { status: 0, stdout: "", stderr: "" };
        };

        const res = runPreflight({
            repo: tempRepo,
            commit: "abcdef1",
            condition: "K0",
            configDir: tempConfig,
            expectDirty: [],
            env: { CLAUDE_CONFIG_DIR: tempConfig },
            git
        });

        assert.equal(res.ok, false);
        assert.ok(
            res.failures.some(
                (f) => f.includes("extra unexpected") && f.includes("src/index.js") && f.includes("untracked.txt")
            )
        );
    } finally {
        await rm(tempRepo, { recursive: true, force: true });
        await rm(tempConfig, { recursive: true, force: true });
    }
});

test("--expect-dirty satisfied passes", async () => {
    const tempRepo = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-repo-"));
    const tempConfig = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-cfg-"));
    try {
        const git = (args) => {
            if (args.includes("rev-parse")) return { status: 0, stdout: "abcdef1234567890\n", stderr: "" };
            if (args.includes("status")) return { status: 0, stdout: " M src/index.js\n?? extra/file.txt\n", stderr: "" };
            return { status: 0, stdout: "", stderr: "" };
        };

        const res = runPreflight({
            repo: tempRepo,
            commit: "abcdef1",
            condition: "K0",
            configDir: tempConfig,
            expectDirty: ["src/index.js", "extra/file.txt"],
            env: { CLAUDE_CONFIG_DIR: tempConfig },
            git
        });

        assert.equal(res.ok, true, res.failures.join("; "));
        assert.equal(res.failures.length, 0);
    } finally {
        await rm(tempRepo, { recursive: true, force: true });
        await rm(tempConfig, { recursive: true, force: true });
    }
});

test('servers found via projects["c:/Some/Repo"] key with different slash/case than --repo', async () => {
    const tempRepo = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-repo-"));
    const tempConfig = await mkdtemp(path.join(os.tmpdir(), "aeo-bench-cfg-"));
    try {
        await mkdir(path.join(tempRepo, ".claude", "rules"), { recursive: true });
        await writeFile(path.join(tempRepo, ".claude", "rules", "aeo-orchestration.md"), "# Rules\n");

        const alteredKey = tempRepo.includes("/")
            ? tempRepo.replaceAll("/", "\\").toUpperCase()
            : tempRepo.replaceAll("\\", "/").toUpperCase();

        await writeFile(
            path.join(tempConfig, ".claude.json"),
            JSON.stringify({
                projects: {
                    [alteredKey]: {
                        mcpServers: {
                            "aeo-antigravity": { command: "node" },
                            "aeo-cursor": { command: "node" }
                        }
                    }
                }
            })
        );

        const git = (args) => {
            if (args.includes("rev-parse")) return { status: 0, stdout: "abcdef1234567890\n", stderr: "" };
            if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };
            return { status: 0, stdout: "", stderr: "" };
        };

        const res = runPreflight({
            repo: tempRepo,
            commit: "abcdef1",
            condition: "K1",
            configDir: tempConfig,
            expectDirty: [],
            env: { CLAUDE_CONFIG_DIR: tempConfig },
            git
        });

        assert.equal(res.ok, true, res.failures.join("; "));
        assert.equal(res.failures.length, 0);
    } finally {
        await rm(tempRepo, { recursive: true, force: true });
        await rm(tempConfig, { recursive: true, force: true });
    }
});

test("CLI invocation with missing flags exits 1", () => {
    const res = spawnSync(process.execPath, [preflightScript], { encoding: "utf8" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /preflight:/);
    assert.match(res.stderr, /missing required arguments/);
});
