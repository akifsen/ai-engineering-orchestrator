# Cursor MCP bridge

This process lets a Team Lead call the Cursor Agent CLI as a secondary Implementation Engineer and as a parallel peer for worktree-isolated delegations. It is an MCP stdio server with `delegate_cursor`, `apply_delegation`, and `discard_delegation`.

Per the orchestration policy, use it when Antigravity is unavailable (quota, auth, or CLI failure), or alongside Antigravity for parallel worktree-isolated delegations on independent scopes. The bridge does not approve work, measure cost, or choose routing by itself.

## What the tool does

`delegate_cursor` takes:

| Argument | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | The implementation contract. Maximum 24,000 characters. |
| `cwd` | yes | Absolute path of the repository to inspect and edit. |
| `model` | no | Cursor model slug. Default `composer-2.5` (overridable via `AEO_CURSOR_MODEL`). |
| `timeoutMinutes` | no | Hard timeout 1..120 minutes for this call. Default from `AEO_CURSOR_TIMEOUT_MINUTES` or 30. |
| `isolation` | no | `none` or `worktree`. Default `none` edits `cwd` in place. `worktree` runs the engineer in a bridge-owned detached git worktree. |
| `delegationId` | no | 10-character hexadecimal ID. With isolation `worktree`, revise an existing isolated delegation in its existing worktree. |

The bridge rejects a relative path, a missing path, and a path that is not a directory. It then starts the Cursor Agent without a shell, writes the wrapped prompt to the child's stdin, and passes:

```text
-p --output-format json --model <model> --trust --force --workspace <cwd>
```

Executable resolution order:

1. `CURSOR_AGENT_BIN` — path to an executable, or to `index.js` (run with `node.exe` / `node` beside that file).
2. On Windows — newest folder under `%LOCALAPPDATA%\cursor-agent\versions` matching the Cursor version layout, using that folder's `node.exe` and `index.js`.
3. Elsewhere — `cursor-agent` on `PATH`.

The bridge hard-kills the process tree at `timeoutMinutes + 1` minutes (default 31 minutes). On Windows it uses `taskkill /T /F`; elsewhere `SIGTERM` then `SIGKILL`.

The wrapped prompt matches the Antigravity bridge: inspect first, stay in contract, run allowed verification, no git history mutations, seven-part completion report. The Team Lead still reads the diff.

Stdout of this MCP process is protocol only. Diagnostics, including `cursor-mcp: stdio server ready`, go to stderr.

## Worktree isolation

Parallel delegations must use `isolation: "worktree"` with non-overlapping file scopes so delegations do not touch the main working tree or each other. Cursor runs with spawn `cwd` and `--workspace` set to the bridge-owned worktree path (same layout as the Antigravity bridge; `worktree.js` is kept in sync).

- **`apply_delegation`**: takes `cwd`, `delegationId`, and optional `keepWorktree`. Applies the patch of a worktree-isolated delegation to the main working tree as unstaged changes after a `git apply --check`. Applying the same delegation twice returns `apply_conflict`. On a successful `applied` or `no_changes` result, the bridge removes the delegation worktree automatically unless `keepWorktree: true`. Call it on **`aeo-cursor`** for delegations created with `delegate_cursor` on that server. The Team Lead must review the diff and re-run tests in the main tree after each apply. Apply one delegation at a time.
- **`discard_delegation`**: takes `cwd` and `delegationId`. Explicitly removes the bridge-owned worktree and patch for a delegation (for example after `keepWorktree`, on `apply_conflict`, or to abandon a run). It never touches the main working tree.
- **Storage**: Worktrees live under `AEO_WORKTREE_ROOT` or `<os tmpdir>/aeo-antigravity` (shared module with the Antigravity bridge).
- **Automatic cleanup**: Isolated runs that produce no file changes remove the worktree when the run finishes (except on `timeout` or when the child process exit is unconfirmed after termination, where files may still be changing). When a new isolated delegation is created, after its worktree exists and before the engineer starts, the bridge sweeps unapplied delegations older than `AEO_WORKTREE_TTL_HOURS` (default 24 hours; `0` disables the sweep). The sweep deletes stale patches and worktrees (data loss if you still needed them — apply or discard promptly, raise `AEO_WORKTREE_TTL_HOURS`, or set `0`).
- **Busy guard**: A delegation is marked busy while its engineer is running and during `apply_delegation` / `discard_delegation`; concurrent revisions, applies, or discards for the same delegation ID return `validation_failure` until the operation completes. Busy tracking is per bridge process — another process sharing `AEO_WORKTREE_ROOT` could still sweep a delegation past the TTL; use a longer TTL or `0` when delegations are reviewed for days.
- **Manual recovery**: Manual recovery for abandoned worktrees is `git worktree list` and `git worktree prune`, or set `AEO_WORKTREE_TTL_HOURS` and let the bridge sweep on the next delegation.

## Results

| Outcome | Meaning |
| --- | --- |
| `agent_success` | CLI exited 0 with a success result envelope and text. Evidence, not approval. |
| `agent_failure` | CLI exited 0 but the agent run did not succeed. |
| `quota_or_auth_failure` | Rate limit, quota, 429, or auth/login failure signals in stderr or result text. |
| `cli_failure` | Process did not complete a run (missing binary, non-zero exit, invalid JSON). |
| `timeout` | Bridge hard timeout stopped the process. |
| `validation_failure` | Arguments rejected before starting. |
| `applied` | Patch applied to the main working tree as unstaged changes. Not approval. |
| `no_changes` | Isolated delegation produced no file changes to apply. |
| `apply_conflict` | Main tree moved or overlaps since the base commit. |
| `apply_error` | Failed to apply the patch. |
| `discarded` | Worktree and patch removed. |
| `discard_error` | Failed to remove the worktree or clean up delegation resources. |

Execution metadata includes `model`, `duration_ms`, `session_id`, and `usage` when the CLI sends them.

## Install

Requires Node.js 20 or newer.

```bash
cd bridge/cursor-mcp
npm install
npm test
```

`npm test` does not need a Cursor login. It mocks process spawn and checks argument building, cwd validation, result classification, and MCP `initialize` / `tools/list`.

## Manual CLI check

Needs a logged-in Cursor Agent. This does not use the bridge:

```bash
# Windows (example — use your resolved node.exe + index.js)
echo Reply with the single word ready. | node.exe path\to\index.js -p --output-format json --model composer-2.5 --trust --force --workspace .
```

`cursor-agent status` should show logged-in state. Auth and quota errors appear as non-zero exit or `is_error` in JSON output.

## Smoke test via the bridge

From `bridge/cursor-mcp` after `npm install`:

```bash
node -e "import { delegateToCursor } from './lib/delegate.js'; ..."
```

Run a one-line delegation in a temp git repo and confirm the outcome (see project verification steps).

## Environment

| Variable | Meaning |
| --- | --- |
| `CURSOR_AGENT_BIN` | Override executable or `index.js` path. |
| `AEO_CURSOR_MODEL` | Default model slug (default `composer-2.5`). |
| `AEO_CURSOR_TIMEOUT_MINUTES` | Default timeout minutes, 1..120 (default 30). |
| `AEO_MAX_REPORT_CHARS` | Max inline engineer report characters in MCP tool results (default 32000; clamped 4000..200000). Full report is written to `<AEO_WORKTREE_ROOT>/runs/<run-id>/report.md`, or `<os tmpdir>/aeo-antigravity/runs/<run-id>/report.md` when unset; runs are not auto-cleaned. |
| `AEO_WORKTREE_TTL_HOURS` | Stale worktree sweep TTL in hours (default 24; `0` disables). Invalid or negative values fall back to 24 with a one-time stderr warning. |

Set `AEO_WORKTREE_TTL_HOURS` to control automatic removal of stale bridge worktrees:

```bash
# Windows
set AEO_WORKTREE_TTL_HOURS=24

# macOS or Linux
export AEO_WORKTREE_TTL_HOURS=24
```

`AEO_WORKTREE_TTL_HOURS` must be a non-negative integer hour count. The sweep runs best-effort when a new isolated delegation is created (after its worktree exists, before the engineer starts; not on revisions) and deletes unapplied patches and worktrees older than the TTL that are not busy in this process.

When unset, the bridge sets `NODE_COMPILE_CACHE` under `%LOCALAPPDATA%\cursor-compile-cache` on Windows and `CURSOR_INVOKED_AS=cursor-agent`, matching the shipped PowerShell launcher behavior.

Do not commit local paths. Export variables in the environment of the process that starts the server.

## Windows notes

- Do not route through `cursor-agent.cmd` — the 8191-character `cmd.exe` limit applies. This bridge spawns `node.exe` and `index.js` directly.
- Install Cursor Agent under `%LOCALAPPDATA%\cursor-agent\` or set `CURSOR_AGENT_BIN`.

## Claude registration (manual)

The installer does not register this server yet. Add an entry next to `aeo-antigravity` using [mcp-entry.cursor.example.json](../../presets/claude/mcp-entry.cursor.example.json). Server name `aeo-cursor`, permissions `mcp__aeo-cursor__delegate_cursor`, `mcp__aeo-cursor__apply_delegation`, and `mcp__aeo-cursor__discard_delegation`.

## Codex registration (manual)

Merge [mcp-entry.cursor.example.toml](../../presets/codex/mcp-entry.cursor.example.toml) into `<project>/.codex/config.toml`, outside the AEO managed block. Keep `tool_timeout_sec` above the bridge hard kill (`timeoutMinutes` + 1 minute, plus a 10 second grace).

## Layout

- `index.js` — stdio server entry.
- `lib/delegate.js` — validation, spawn, stdin prompt, worktree isolation, result classification.
- `lib/worktree.js` — bridge-owned git worktrees and patches (kept in sync with antigravity-mcp).
- `lib/server.js` — MCP tool registration.
- `test/` — automated checks without a live model.
