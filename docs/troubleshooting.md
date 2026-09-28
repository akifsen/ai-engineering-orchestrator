# Troubleshooting

## The MCP server does not appear

Confirm the project MCP entry points at `<project>/.aeo/bridge/antigravity-mcp/index.js` with `node`, and that `npm ci` has been run in that directory. The server name is `aeo-antigravity`. Claude's allow entries are `mcp__aeo-antigravity__delegate_antigravity`, `mcp__aeo-antigravity__apply_delegation`, and `mcp__aeo-antigravity__discard_delegation`, shown in the [permission fragment](../presets/claude/settings-permission.example.json).

Start a new Team Lead session after changing MCP config. A session that was already open often keeps the previous tool list.

Stderr should contain `antigravity-mcp: stdio server ready`. If the client shows nothing, run `npm test` in the bridge directory. A passing stdio test means the server can speak MCP on this machine. A client that still hides the tool is a registration or session problem, not a bridge crash.

Stdout must stay empty except for protocol messages. Application logs go to stderr. If a wrapper prints a banner on stdout, the client will fail to parse the server.

## `agy` is not found

The bridge runs `process.env.AGY_BIN` or `agy`. Install the Antigravity CLI and open a new terminal so `agy` is on `PATH`, or set `AGY_BIN` to the executable. A `cli_failure` that mentions `ENOENT` and `AGY_BIN` is this case. The bridge does not guess an install path.

## Headless authentication failed

`agy -p` uses cached credentials. Sign in once with an interactive `agy` session. A non-interactive run with no cached login exits with an authentication error instead of prompting. That result is a `cli_failure`. It is not an implementation.

## Command permission denied

Headless mode cannot show an approval card. A command that is not allowed is soft-denied, and the CLI can still exit 0. The denial is on stderr and is included as CLI diagnostics. Treat that command as not run. Add a specific allow rule for the test command you trust. Do not switch the example to skip every permission check.

In headless print mode, a soft-denied command can cause Antigravity to produce an empty response (`jetski: no output produced — a tool required the "command" permission ...`), ending the run with status `SUCCESS` but leading the bridge to classify the run as `agent_failure`. The fix is to tell the engineer exactly which verification commands it may run in the assignment contract, instruct it to prefer built-in file tools over shell commands, or add narrow allow rules in `~/.gemini/antigravity-cli/settings.json` (such as the read-only inspection rules in `antigravity/settings.example.json`; see [permissions](permissions.md)).

## Print timeout

A large assignment or long-running turn can hit the CLI print timeout (stderr: `[agy] print timeout after 15m0s with turn in progress; returning partial output`), which returns partial output or an empty response (`agent_failure` or `timeout`).

Partial edits may already exist on disk when the timeout elapses. Compare `git status` against your recorded baseline before retrying to determine what was changed, and revert or preserve those changes intentionally. Split large work into smaller sequential delegations so each turn finishes well within the timeout.

The timeout can be configured via the `AEO_AGY_TIMEOUT_MINUTES` environment variable (integer, default 15). The value is clamped to a range of 1..18 minutes. The upper limit of 18 minutes ensures that the bridge's hard timeout (N+1 minutes, up to 19 minutes) always elapses before the Codex client tool timeout (`tool_timeout_sec = 1200`, i.e. 20 minutes) can cancel the bridge.

## Read or write permission denied

`cwd` must be an absolute directory. The Antigravity example sets `allowNonWorkspaceAccess` to false and trusts `C:\path\to\development` only as a placeholder. Replace that path with the real development directory. Files outside the trusted workspace stay blocked on purpose.

## MCP permission denied

Claude's allow list must include `mcp__aeo-antigravity__delegate_antigravity`, `mcp__aeo-antigravity__apply_delegation`, and `mcp__aeo-antigravity__discard_delegation`, and the server must be named `aeo-antigravity`. Codex must list `delegate_antigravity`, `apply_delegation`, and `discard_delegation` in `enabled_tools` and load the server. A denied MCP call never starts `agy`.

## Timeout mismatch

The bridge sets the CLI print timeout to 15 minutes and kills the process at 16 minutes. The Codex `tool_timeout_sec` example is 1200 seconds, which is longer than both. If the client timeout is shorter, the client cancels the tool while Antigravity is still running. If you lengthen the CLI timeout, lengthen the bridge hard timeout and the client timeout in that same order. Do not remove the print timeout to match an `agy` default of `0s`; that default waits until the turn finishes.

A `timeout` outcome means the work is not complete. Do not review a partial edit as if the report were finished. Look at the diff, and either continue with a revision or discard a partial change you do not want to keep.

## No files changed

`agent_success` with an unchanged tree means the engineer answered and did not edit. Read the report. Common causes are a contract that asked for analysis only, a permission denial on the edit, or the wrong `cwd`. Send a revision that names the file and the expected change, or fix `cwd` and the permissions first.

`validation_failure` means the bridge never started the CLI. The usual cause is a relative `cwd` or a path that is not a directory.

## The Team Lead does not delegate

The tool can be installed while the policy is absent. Codex needs the AEO block in the project [orchestration fragment](../presets/codex/orchestration-block.md). Claude needs [aeo-orchestration.md](../presets/claude/rules/aeo-orchestration.md) in `.claude/rules/`. Wording such as "prefer Antigravity" will not hold. The policy has to say substantive implementation goes to Antigravity by default. Do not replace `AGENTS.md` or `CLAUDE.md` to get there.

Check with a prompt that does not name any agent. If the feature is still written in the Team Lead session, the policy is not in effect. See [Test B](../examples/smoke-test.md).

## The Team Lead delegates trivial work

A typo, a comment, or a one-file rename does not need Antigravity. Delegating those spends a process startup on an edit the Team Lead or `aeo_fast_worker` / `aeo-fast-worker` should finish. If trivial edits are always delegated, the routing section is being ignored. Substantive work should still be delegated. The two mistakes are different.

## Tests reported as passed

If the report says tests passed and the diagnostics say the test command was denied, the tests did not pass. The quality gate stays at CHANGES REQUIRED until somebody actually runs the check.

## Bridge command line is too long

Very large prompts can exceed the Windows command-line limit. The bridge rejects a prompt over 24,000 characters and also rejects a constructed command that is still too long. Shorten the contract. Do not paste source files into the prompt. The engineer can read the repository.

## Apply conflict (`apply_conflict`)

`apply_delegation` runs `git apply --check` before applying changes to the main working tree. If the main tree has moved or accumulated edits since the delegation's base commit, or if the patch touches files modified by another applied delegation, `apply_delegation` returns `apply_conflict` without altering any files. Applying the same delegation a second time also returns `apply_conflict`.

An `apply_conflict` is not a revision. Do not ask Antigravity to rebase or merge. Discard the delegation using `discard_delegation` and re-delegate the assignment against the current HEAD, or reconcile the differences manually in the main working tree.

## Missing worktree or unknown delegation ID

If `apply_delegation`, `discard_delegation`, or an isolated revision call fails with an unknown delegation ID or missing worktree directory error, the worktree path on disk may have been deleted.

By default, worktrees reside under `<os tmpdir>/aeo-antigravity`. Operating systems or background cleanup utilities can purge temporary directories while a long session is running. If this occurs, the worktree cannot be resumed or applied. Discard any remaining reference and re-delegate from the current HEAD.

To prevent temporary directory purges or use a dedicated location, set the `AEO_WORKTREE_ROOT` environment variable to a stable directory (for example, `AEO_WORKTREE_ROOT=C:\aeo-worktrees` or `export AEO_WORKTREE_ROOT=/var/tmp/aeo-worktrees`).

## Stale or abandoned worktrees

If a delegation is abandoned without calling `discard_delegation`, or if a process exits unexpectedly, the detached worktree may remain on disk and registered with Git.

Inspect active worktrees with:

```bash
git worktree list
```

Clean up references to removed worktree directories with:

```bash
git worktree prune
```

If an unwanted worktree directory is still present on disk, remove it using `discard_delegation` with its `delegationId`, or delete the directory manually and run `git worktree prune`.

## Windows long paths

Detached git worktrees located in deeply nested temporary paths on Windows can exceed the standard 260-character path limit (`MAX_PATH`).

The bridge passes `-c core.longpaths=true` during internal git calls. However, Windows system-level long path support may also need to be enabled in the operating system registry (`LongPathsEnabled` set to 1 under `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem`).

If you encounter path-length errors on Windows, ensure `LongPathsEnabled` is enabled in Windows, or set `AEO_WORKTREE_ROOT` to a short directory path such as `C:\aeo-wt`.
