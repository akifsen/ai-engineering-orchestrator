# Benchmark Run Protocol

## Purpose

Implements section 4 of docs/proposals/context-hygiene-analysis.tr.md to measure context usage and delegation efficiency across three baseline conditions: K0 (plain Claude Code without AEO), K1 (AEO v1.3.0 baseline), and K2 (current AEO checkout with context hygiene improvements). The difference between K0 and K1 quantifies the benefit of AEO orchestration, while the difference between K1 and K2 quantifies the benefit of context hygiene; the two comparisons must be analyzed and reported separately.

## Target repository

The benchmark runs against pinned commits of a user-chosen local checkout; any pinned git repository works. The first series (October 2026) uses clones of the `kimlik` Laravel project under `C:\bench\kimlik-k0` and `C:\bench\kimlik-k2`, one clone per condition so the K2 project-scoped AEO install never leaks into K0. Keep the clones outside the home directory: Claude Code loads `.claude/rules` from every ancestor of the cwd, so a clone under `C:\Users\<you>` inherits the user-scope AEO rule as a project rule. Each task pins its own base commit (the parent of the historical fix it was derived from). Five evaluation tasks are executed against those pinned states:
- T1: Behavioral bug fix (a historical commit is reverted, symptoms described to the agent, and that commit's tests serve as hidden acceptance tests).
- T2: Small feature (new configuration parameter and associated test).
- T3: Multi-file refactor (internal structure updated, external behavior fixed, existing tests unchanged).
- T4: Trivial fix (single typo and doc comment; AEO delegation overhead is expected to be more expensive here, reported honestly).
- T5: Bug fix with a pre-dirtied working tree (tests baseline cleanliness enforcement; validated using `--expect-dirty`).

Prompts must be written as natural requests following the style of `examples/smoke-test.md` Test B without naming roles, agents, or internal tool names.

## Conditions and config dirs

Maintain an isolated Claude configuration directory per condition, for example:
- `~/.claude-bench/K0`
- `~/.claude-bench/K1`
- `~/.claude-bench/K2`

Configuration rules:
- K0: Neither `aeo-antigravity` nor `aeo-cursor` is configured in `.claude.json` or `.mcp.json`, and `<repo>/.claude/rules/aeo-orchestration.md` must not exist.
- K1: Installs the `v1.3.0` tag; both `aeo-antigravity` and `aeo-cursor` must be configured, and `<repo>/.claude/rules/aeo-orchestration.md` must exist.
- K2: Installs the current AEO checkout; both servers configured and orchestration rules file present.

Verify cell readiness before every run using `preflight.mjs`:

```bash
node scripts/bench/preflight.mjs \
  --repo "C:/bench/kimlik-k2" \
  --commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b \
  --condition K1 \
  --config-dir ~/.claude-bench/K1
```

For T5 (pre-dirtied tree) add one `--expect-dirty <relative-path>` per file that the task deliberately leaves modified; preflight then fails on any extra or missing dirty path.

## Hook setup

Register a `PreCompact` hook in `<config-dir>/settings.json` (the per-condition config dir, so each condition carries the same hook). Claude Code hooks take no per-hook environment block, so the counter file is named through the top-level `env` map of the same settings file, or exported in the shell that launches `claude` for the run:

```json
{
  "env": {
    "AEO_BENCH_COMPACT_LOG": "<runs-dir>/<task>-<condition>-<run>.compactions.log"
  },
  "hooks": {
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node <abs path>/scripts/bench/hooks/count-compactions.mjs"
          }
        ]
      }
    ]
  }
}
```

Change the `AEO_BENCH_COMPACT_LOG` value (or the exported variable) before every run so each run gets its own counter file; the hook appends one line per compaction and `compactions` in the run JSON is that file's line count (0 when the file does not exist). The hook always exits 0 and never writes to stdout, so it cannot block compaction.

Manual compaction via `/compact` is strictly forbidden during benchmark runs.

## Per-run protocol

1. Run `preflight.mjs` with the target repo, pinned commit, condition, and config dir.
2. Launch a new Claude Code session (`CLAUDE_CONFIG_DIR=... claude`); never use `/clear` to reset state.
3. Paste the unadorned task prompt into the session.
4. Let the session run until complete without manual intervention.
5. Record the transcript path (`<CLAUDE_CONFIG_DIR>/projects/<encoded repo path>/<session>.jsonl`) and run `collect-claude-usage.mjs` on it.
6. Copy the hidden acceptance tests into the repo and execute them to verify task correctness.
7. Inspect `git status --short --untracked-files=all` and compare with the task baseline to detect dirty-file violations.
8. Check for policy violations (Team Lead wrote substantive implementation code itself in K1/K2); if violated, mark `policyViolation: true` and keep the run.
9. Inspect delegation outcomes; if any delegation reports `quotaFallback: true` or used an unexpected model, mark `quotaFallback: true`.
10. Write the run result JSON to `<runs-dir>/<task>-<condition>-<run>.json` matching the schema below.
11. Reset the repo to the pinned commit before the next run: `git reset --hard <pinned-sha>` and `git clean -fd` (without `-x`, so ignored dependency directories such as `node_modules` survive; use `-x` only if a task's hidden tests need a pristine tree).

### Run JSON schema and example

```json
{
  "task": "T1",
  "condition": "K1",
  "run": 1,
  "date": "2026-10-23",
  "teamLeadModel": "claude-fable-5-1",
  "teamLead": {
    "input_tokens": 1800,
    "output_tokens": 350,
    "cache_creation_input_tokens": 80,
    "cache_read_input_tokens": 40
  },
  "engineer": {
    "tokens": 6830,
    "models": [
      "gemini-3.8-flash-high"
    ]
  },
  "delegationCount": 1,
  "compactions": 0,
  "wallClockSeconds": 90.0,
  "acceptance": "pass",
  "revisions": 0,
  "dirtyFileViolation": false,
  "policyViolation": false,
  "quotaFallback": false,
  "notes": "initial clean run"
}
```

## Repetition

Execute at least 3 runs per task and condition combination. The initial run is kept and not discarded as cache warm-up, reflecting authentic cold-start conditions. If the Claude model id changes mid-series, restart the entire series for that condition (date and model IDs are recorded in every run file).

## Reporting

Aggregate run files using `report.mjs`:

```bash
node scripts/bench/report.mjs <runs-dir> --out <dir>
```

The script reports medians and ranges only (no arithmetic means). Numbers reported in documentation must always carry the explicit qualification: "in this environment, on this date, with this task set".

## Known limits

- Engineer `model` field is null in bridge metadata when delegations do not provide an explicit model identifier (older installed bridges).
- Cursor usage payloads use camelCase (`inputTokens`, `outputTokens`, `cacheReadTokens`).
- The transcript collector deduplicates assistant entries by message identifier.

## Re-scan analysis

Offline, zero-cost analysis of how much each Claude Code session re-discovers the project, using transcripts already on disk (no network, no LLM calls):

```
node scripts/bench/analyze-rescans.mjs <dir-or-file> [<file>...] [--project-root <abs path>]
```

A directory means every `*.jsonl` directly inside it (not recursive; subagent transcripts in subfolders are excluded). Sessions are ordered by earliest timestamp. Sidechain lines are skipped. Output is one JSON object:

- `sessions[]`: `session`, `firstTimestamp`, `lastTimestamp`, `teamLead` tokens, `discovery` and `startupDiscovery` (`calls`, `byCategory`, `resultChars`, `approxTokens` = ceil(chars / 4)), `filesRead` (normalized, repo-relative with `--project-root`), `rereadRatio` (share of this session's files already read in earlier sessions; `null` for the first).
- `crossSession`: `totalSessions`, `uniqueFilesRead`, `rereadFiles` (`{path, sessions}`, top 50), `rereadFilesTotal`, `overallRereadRatio`, `rereadChars`, `rereadApproxTokens`.

Per session, additionally:

- `filesReadVia`: `{ Read, shell }`, the number of file-read calls by source (the `Read` tool vs. shell commands).
- `repeatReadsInSession`: read calls (Read or shell) on a file already read earlier in the same session; `repeatReadChars`: result characters of those repeat reads.

Files read through Bash/PowerShell (`cat`, `type`, `head`, `tail`, `less`, `sed -n '<range>p' <file>`, `Get-Content`/`gc`) count as files read, with the same path normalization as `Read`. Shell-read parsing is best effort, not a full shell parser: flags and their values are skipped, text after the first `|`, `;`, `&&`, `||` or `>` is ignored, paths containing `*` or `$` are ignored, and relative paths resolve against `--project-root` when given. If one command reads several files, its result characters are attributed to the first file only.

Startup discovery counts discovery calls before the first Edit/Write/NotebookEdit or delegate call.

## Memory A/B (Phase 5)

One small A/B for project memory: a chain of consecutive headless sessions on one repository, memory on vs off. The repository needs a project install of the current AEO checkout (for `.aeo/bridge/antigravity-mcp/memory.js`), and the config dir must register the SessionStart hook; with `AEO_MEMORY=off` it prints nothing, so one config dir serves both arms:

```json
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node \"$CLAUDE_PROJECT_DIR/.aeo/bridge/antigravity-mcp/memory.js\" hook session-start"}]}]}}
```

```
node scripts/bench/run-memory-ab.mjs run --repo <abs> --commit <sha> --config-dir <abs> --arm on|off --run <n> \
  --sessions <json array of prompts> --out <abs dir> [--max-budget-usd 5] [--dry-run] [--force]
node scripts/bench/run-memory-ab.mjs compare --out <dir> [--noise-pct 15] [--json]
```

`run` resets the repository to the commit, removes `.aeo/memory`, runs `memory.js init` for arm `on`, then runs one session per prompt without resetting in between, and writes `mem-<arm>-<run>.json` (per-session Team Lead tokens, discovery calls, cost, INDEX size, hook injections). `compare` prints per-arm means and the sessions 2+3 difference, then the stop rule: with one run per arm, a difference below the noise threshold means the second repetition is skipped.
