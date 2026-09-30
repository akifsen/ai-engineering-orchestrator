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

Parallel delegations must use `isolation: "worktree"` with non-overlapping file scopes so delegations do not touch the main working tree or each other. Cursor runs with spawn `cwd` and `--workspace` set to the bridge-owned worktree path (same layout and default root as the Antigravity bridge under `%TEMP%\\aeo-antigravity` or `AEO_WORKTREE_ROOT`).

- **`apply_delegation`**: takes `cwd` and `delegationId`. Applies the patch to the main working tree as unstaged changes after `git apply --check`. Call it on **`aeo-cursor`** for delegations created with `delegate_cursor` on that server.
- **`discard_delegation`**: removes the bridge-owned worktree and patch. Never touches the main working tree.
- **Busy guard**: concurrent revisions, applies, or discards for the same delegation ID return `validation_failure` while a delegation run is in progress.
- **Manual recovery**: `git worktree list` and `git worktree prune` for abandoned entries.

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
