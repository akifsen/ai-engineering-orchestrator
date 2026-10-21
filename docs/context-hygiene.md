# Context hygiene

The Team Lead runs on the expensive model. Its context window is the primary cost driver of an orchestration run. Automatic context compaction can silently drop the `git status --short` baseline that attribution rules need. Without that baseline, the Team Lead cannot separate pre-existing user work from engineer edits.

## What the bridge does

The Antigravity bridge caps the inline engineer report returned to the Team Lead model to `AEO_MAX_REPORT_CHARS` (default 32000 characters).

The full un-truncated engineer report is written to disk at:
- `<AEO_WORKTREE_ROOT>/runs/<run-id>/report.md`, or
- `<os tmpdir>/aeo-antigravity/runs/<run-id>/report.md` when `AEO_WORKTREE_ROOT` is unset.

The bridge announces the file path in the tool result as `Full report: <path>`. Run reports are not auto-cleaned by the bridge.

## What the policy asks of the Team Lead

The Team Lead policy enforces five context rules:

1. **Task boundary**: when a task reaches its final APPROVED or CHANGES REQUIRED decision and the next request does not build on it, start from a clean context (Claude Code: `/clear`; Codex: a new session). Never clear or compact in the middle of a task: the baseline, the contract, and open review findings are lost.
2. **Surviving compaction**: if context is compacted anyway, the summary must keep five items: the baseline `git status --short`, the active contract, each delegation ID and its outcome, open review findings, and the latest decision. Restate those five items briefly in your own reply at each delegation boundary (before delegating, after reviewing) so compaction summaries retain them.
3. **Delegation reports**: read the full report file only when the inline report is insufficient for the decision. Read only the specific sections needed, not the whole file into context. The diff and the tests remain the evidence; the report is not.
4. **Verification output**: do not paste full test output into the context. Run the narrowest relevant test command, and prefer a quiet reporter or a filter that keeps failures only.
5. **Small contracts**: keep contracts bounded (the bridge limit is 24000 characters). Do not paste repository files into the contract prompt.

## Claude Code specifics

Add the following section to your project `CLAUDE.md`:

```markdown
# Compact instructions

When compacting context, always preserve:
1. Baseline `git status --short` recorded before substantive delegations.
2. Active implementation contract and scope boundaries.
3. Each delegation ID and its outcome (e.g., agent_success, applied, CHANGES REQUIRED).
4. Open review findings and unverified claims.
5. Latest Team Lead gate decision (APPROVED or CHANGES REQUIRED).
```

### Clearing versus compaction

Running `/clear` re-reads `CLAUDE.md`, rules, agent definitions, and MCP tool schemas as fresh tokens, and resets the prompt cache. Clearing inside a task costs more tokens and latency than it saves. Use `/clear` only at task boundaries after a final decision.

## Optional hook for Claude Code

The repository provides an optional example hook script at `presets/claude/hooks/filter-test-output.example.mjs`.

The AEO installer does not install this hook. You copy the script and configure the hook manually.

To use it:
1. Copy `presets/claude/hooks/filter-test-output.example.mjs` to `.claude/hooks/filter-test-output.example.mjs` in your project.
2. Add the following hook definition to your project `.claude/settings.json`. Register it under `PostToolUse`. If your Claude Code version delivers failing commands to `PostToolUseFailure` instead, register the same command entry under that event as well — this repository does not verify which event fires.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/filter-test-output.example.mjs"
          }
        ]
      }
    ]
  }
}
```

The script runs after the `Bash` tool executes. It acts only when the command matches common test runners (`npm test`, `pnpm test`, `yarn test`, `node --test`, `pytest`, `go test`, `cargo test`). When run, it keeps lines matching error patterns (`not ok`, `FAIL`, `failed`, `Error`, `error:`, `AssertionError`, etc.), up to 8 lines following each failure for stack traces, and the last 5 lines of output for summary counts. It drops passing test lines and verbose diagnostics.

The hook changes only what the model sees in its context. Full test output remains visible in your terminal.

## Codex

AEO ships no hook for Codex. The same policy rules apply: run targeted test commands, use quiet flags, and start a new session at task boundaries.

## What this does not do

Context hygiene prevents context inflation and baseline loss. It does not make a measured savings guarantee. Actual token and cost impacts depend on project size, test output verbosity, and provider pricing. See [cost-aware routing](cost-aware-routing.md).
