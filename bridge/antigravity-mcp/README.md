# Antigravity MCP bridge

This process lets a Team Lead call the Antigravity CLI as an Implementation Engineer. It is an MCP stdio server with three tools: `delegate_antigravity`, `apply_delegation`, and `discard_delegation`.

The tool is the capability. The policy that decides when the call is mandatory is the Codex orchestration block or the Claude rule installed by [the AEO installer](../../docs/install.md).

The bridge does not approve work, measure cost, or choose a fallback model.

## What the tool does

`delegate_antigravity` takes:

| Argument | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | The implementation contract. Maximum 24,000 characters. |
| `cwd` | yes | Absolute path of the repository to inspect and edit. |
| `model` | no | Antigravity model slug. Leave it unset to use the configured default model. |
| `effort` | no | `low`, `medium`, or `high`. Any other value is rejected before `agy` starts. |
| `isolation` | no | `none` or `worktree`. Default `none` edits `cwd` in place. `worktree` runs the engineer in a bridge-owned detached git worktree. |
| `delegationId` | no | 10-character hexadecimal ID (`/^[a-f0-9]{10}$/`). With isolation `worktree`, revise an existing isolated delegation in its existing worktree. |

The bridge rejects a relative path, a missing path, and a path that is not a directory. It then starts:

```text
agy --mode accept-edits --output-format json --print-timeout 15m -p <wrapped prompt>
```

The executable is `AGY_BIN` when that environment variable is set, otherwise `agy`. Arguments are passed without a shell. The bridge sets `--print-timeout <N>m` (default `15m`) and kills the process at `N+1` minutes (default 16 minutes), configurable via `AEO_AGY_TIMEOUT_MINUTES`. Client timeouts must be longer than the hard timeout. The Codex example uses 1200 seconds. The explicit limit is intentional: `agy --help` on a current build shows a default of `0s`, which waits until the turn finishes.

The wrapped prompt tells the engineer to inspect the repository, stay inside the contract, run allowed verification, avoid git history changes, and return a seven-part report. The Team Lead still has to read the diff.

Stdout of this process is MCP only. Diagnostics, including `antigravity-mcp: stdio server ready`, go to stderr.

## Worktree isolation and new tools

Parallel delegations must use `isolation: "worktree"` with non-overlapping file scopes so delegations do not touch the main working tree or each other.

- **`apply_delegation`**: takes `cwd` and `delegationId`. Applies the patch of a worktree-isolated delegation to the main working tree as unstaged changes after a `git apply --check`. Applying the same delegation twice returns `apply_conflict`. The Team Lead must review the diff and re-run tests in the main tree after each apply. Apply one delegation at a time.
- **`discard_delegation`**: takes `cwd` and `delegationId`. Removes the bridge-owned worktree and patch for a delegation. Call after apply or to abandon it. It never touches the main working tree.
- **Storage**: Worktrees live under `AEO_WORKTREE_ROOT` or `<os tmpdir>/aeo-antigravity`.
- **Dependencies and verification**: Untracked dependencies like `node_modules` are not present in the worktree so engineer-side test runs may not work there — the authoritative verification happens in the main tree after apply.
- **Conflicts**: If the main tree moved or overlaps, `apply_delegation` returns `apply_conflict` without changing anything. An `apply_conflict` is not a revision; discard and re-delegate against current HEAD or reconcile manually.
- **Busy guard**: A worktree delegation is marked busy while its engineer is running; concurrent revisions, applies, or discards for the same delegation ID return `validation_failure` until the run completes.
- **Manual recovery**: Manual recovery for abandoned worktrees is `git worktree list` and `git worktree prune`.

## Results

| Outcome | Meaning |
| --- | --- |
| `agent_success` | The CLI exited 0 with status `SUCCESS` and a response. Evidence, not approval. |
| `agent_failure` | The CLI exited 0 and the agent status was not a usable success. |
| `cli_failure` | The process did not complete a run. Includes a missing `agy`, a non-zero exit, or invalid JSON. |
| `timeout` | The 16-minute bridge limit stopped the process. |
| `validation_failure` | The arguments were rejected before starting. |
| `applied` | Delegation patch applied to the main working tree as unstaged changes. |
| `no_changes` | The isolated delegation produced no file changes to apply. |
| `apply_conflict` | The patch failed `git apply --check` against the main working tree. |
| `apply_error` | Failed to check or apply the patch. |
| `discarded` | The worktree and patch were removed. |
| `discard_error` | Failed to remove the worktree or clean up delegation resources. |

Token counts in the metadata are copied from the CLI payload when it sends them. This bridge does not price tokens.

## Install

Requires Node.js 20 or newer.

```bash
cd bridge/antigravity-mcp
npm install
npm test
```

`npm test` does not need an Antigravity login. It checks argument building, working-directory checks, result classification, and that the server answers an MCP `initialize` plus `tools/list` on stdio.

## Manual CLI check

This needs a logged-in `agy`. It does not use the bridge:

```bash
agy -p "Reply with the single word ready." --mode accept-edits --output-format json --print-timeout 2m
```

A successful check prints one JSON object with `"status": "SUCCESS"`. Authentication errors mean you need an interactive `agy` login first. See [troubleshooting](../../docs/troubleshooting.md).

## Environment

Set `AGY_BIN` only when `agy` is not on `PATH`:

```bash
# Windows
set AGY_BIN=C:\Users\<USER>\AppData\Local\agy\bin\agy.exe

# macOS or Linux
export AGY_BIN=/usr/local/bin/agy
```

Do not commit that path. Export it in the environment of the process that starts the server. The default install does not write it into Codex or Claude config.

Set `AEO_AGY_TIMEOUT_MINUTES` to customize the delegation timeout in minutes:

```bash
# Windows
set AEO_AGY_TIMEOUT_MINUTES=15

# macOS or Linux
export AEO_AGY_TIMEOUT_MINUTES=15
```

`AEO_AGY_TIMEOUT_MINUTES` must be an integer. It defaults to 15 minutes and is clamped to 1..18 minutes. The CLI print timeout is set to $N$ minutes (`${N}m`) and the bridge hard timeout is set to $N+1$ minutes. The 18-minute cap guarantees the hard timeout (19 minutes) finishes before the Codex client timeout (`tool_timeout_sec = 1200`, 20 minutes) can abort the MCP call. Invalid values fall back to 15 with a warning on stderr.

## Codex registration

Prefer the project installer. It registers the server as `aeo-antigravity` inside `<project>/.codex/config.toml` and does not edit `~/.codex/config.toml`.

The managed block looks like this. Merge it. Do not replace the file. Replace `<PROJECT>` with the project path, using forward slashes. The full fragment is [config-block.example.toml](../../presets/codex/config-block.example.toml).

```toml
[mcp_servers.aeo-antigravity]
command = "node"
args = ["<PROJECT>/.aeo/bridge/antigravity-mcp/index.js"]
enabled = true
enabled_tools = ["delegate_antigravity", "apply_delegation", "discard_delegation"]
startup_timeout_sec = 30
tool_timeout_sec = 1200
default_tools_approval_mode = "approve"
```

Open a new Codex session after the project config changes. Codex loads that file only when the project is trusted. AEO does not change trust.

The policy is appended to the project `AGENTS.md` between `<!-- AEO:BEGIN ORCHESTRATION -->` and `<!-- AEO:END ORCHESTRATION -->`. Do not copy it over an existing `AGENTS.md` or over `~/.codex/AGENTS.md`.

## Claude registration

The server name is `aeo-antigravity`. The permission string is `mcp__aeo-antigravity__delegate_antigravity`.

Add this key to the project's `.mcp.json` and keep every other server. Do not replace the file. The fragment is [mcp-entry.example.json](../../presets/claude/mcp-entry.example.json).

```json
{
  "mcpServers": {
    "aeo-antigravity": {
      "type": "stdio",
      "command": "node",
      "args": ["<PROJECT>/.aeo/bridge/antigravity-mcp/index.js"]
    }
  }
}
```

Copy [aeo-orchestration.md](../../presets/claude/rules/aeo-orchestration.md) to `.claude/rules/aeo-orchestration.md`. Do not replace `CLAUDE.md`. Append the permission string in [settings-permission.example.json](../../presets/claude/settings-permission.example.json) to `.claude/settings.local.json` only if it is missing. Do not replace the permissions object. Start a new session so the tool list reloads.

To pass `AGY_BIN` through the MCP server instead of the parent environment, add an `env` object on `aeo-antigravity` yourself. Omit it when `agy` is already on `PATH`. The installer does not add that object.

## Layout

- `index.js` starts the stdio server.
- `lib/delegate.js` validates arguments, spawns `agy`, manages worktrees and patches, and classifies results.
- `lib/worktree.js` creates, patches, applies, and removes bridge-owned git worktrees.
- `lib/server.js` registers the tools.
- `test/` is the automated check. It does not call a live model.

## Troubleshooting

- Server missing in the client: new session, correct path, server name `aeo-antigravity`.
- `agy` not found: install it or set `AGY_BIN`.
- Prompt rejected: shorten it below 24,000 characters and do not paste the repository.
- Client timeout: set it above 16 minutes.
- Command denied inside the run: see [permissions](../../docs/permissions.md). The bridge does not pass `--dangerously-skip-permissions`.

More cases are in [troubleshooting](../../docs/troubleshooting.md).
