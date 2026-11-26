# Project memory

Project memory is a per-repository ledger under `<repo>/.aeo/memory/`. It keeps a short project index, a dependency docs registry, and one record per delegation, apply, and Team Lead decision. Its purpose is to let a later session start from a summary instead of rediscovering the repository.

All writes are deterministic file writes. Nothing calls a model to summarize.

## Layout

```text
.aeo/memory/
  .gitignore   "*" by default, so the whole directory is ignored by git
  INDEX.md     hand-written project index plus a generated "Recent tasks" block
  docs.md      dependency docs registry (one row per library)
  tasks/       immutable records, one file per event
```

Record files are named `<UTC timestamp>-<kind>-<ref>-<nonce>.md`, so they sort by time and parallel delegations never write the same file. Each record starts with flat front matter (`schema: 1`, `kind: ...`).

| Kind | Written by | Contents |
| --- | --- | --- |
| `delegation` | Both bridges, at the end of every delegation run | engineer, outcome, model, isolation, delegation ID, run ID, report path, contract hash, redacted contract and summary excerpts, diffstat for isolated runs |
| `apply` | Both bridges, on `apply_delegation` and `discard_delegation` | delegation ID, outcome, diffstat for applied patches |
| `decision` | The Team Lead, through `memory.js decide` | task slug, APPROVED or CHANGES_REQUIRED, linked delegations, one-line summary, findings |

When a bridge writes a record, its tool result ends with a `Ledger: .aeo/memory/tasks/<file>` line. Use that path or the delegation ID to link the decision.

Excerpts and findings pass through a secret redaction filter (API keys, bearer tokens, private keys, `password=`/`token=`-style values). It is a safety net, not a guarantee.

## Switches

| Variable | Values | Default |
| --- | --- | --- |
| `AEO_MEMORY` | `auto`: write only when `.aeo/memory/` already exists. `on`: create it on first write. `off`: never write. | `auto` |
| `AEO_MEMORY_MAX_RECORDS` | Positive integer. The oldest `delegation` and `apply` records beyond it are deleted. `decision` records are never pruned. | `300` |

With the default `auto`, nothing is written until you run `memory.js init` in a repository.

## The memory.js CLI

The CLI ships next to the installed Antigravity bridge:

- project install: `node .aeo/bridge/antigravity-mcp/memory.js <command>`
- global install: `node ~/.aeo/bridge/antigravity-mcp/memory.js <command>`

It finds the repository with `git rev-parse --show-toplevel`; pass `--repo <path>` to override.

```bash
# create .aeo/memory with INDEX.md, docs.md and .gitignore; never overwrites existing files
node .aeo/bridge/antigravity-mcp/memory.js init

# same, then fill the empty Modules and Test commands sections from git (also: memory.js seed)
node .aeo/bridge/antigravity-mcp/memory.js init --seed

# record the final decision of a task and refresh the Recent tasks block
node .aeo/bridge/antigravity-mcp/memory.js decide --task fix-login-retry \
  --decision APPROVED --delegations 3fa9c01b2e --summary "Retry on 503 only"

# rebuild the Recent tasks block from decision records
node .aeo/bridge/antigravity-mcp/memory.js reindex

# show mode, record counts, newest decision and INDEX.md size
node .aeo/bridge/antigravity-mcp/memory.js status
```

`reindex` changes only the text between `<!-- aeo:recent-tasks:start -->` and `<!-- aeo:recent-tasks:end -->`, each standing alone on its own line. Everything else in `INDEX.md` is kept as is (the file is read and written as UTF-8). It lists the newest 8 decisions, one line each. If neither marker exists, a new block is appended. If only one marker exists, or they are duplicated or out of order, the command fails and leaves the file untouched; repair the markers by hand. A short-lived `.aeo/memory/.lock` directory serializes concurrent runs; one older than 60 seconds is taken over. `status` warns when `INDEX.md` grows past 6000 characters; keep the hand-written sections short, because a later phase injects this file at session start.

## Keeping the engineer out

- The engineer prompt tells it not to touch `.aeo/memory`.
- Isolated runs: patches are applied with `--exclude=.aeo/memory/*`, so engineer edits there never reach the main tree.
- In-place runs: the bridge compares `INDEX.md`, `docs.md`, and `.gitignore` before and after the run and appends `Ledger integrity: .aeo/memory changed during the run (...)` when one changed. It does not revert the change. The check compares size and modification time, and it does not cover `tasks/`, which bridges write to during runs; an in-place engineer that edits `tasks/` is not detected.

## Git

The directory ignores itself by default. Contracts and reports can contain sensitive text, records change on every delegation, and ignored files keep the Team Lead's `git status --short` baseline clean.

To share a curated `INDEX.md` and `docs.md` with a team, replace the content of `.aeo/memory/.gitignore` with these lines, so records, the lock, stats, and temporary files stay ignored:

```text
tasks/
stats/
.lock/
*.tmp-*
```

 `INDEX.md` then shows up in `git status`; exclude `.aeo/memory/` paths from the baseline and attribute ledger changes by the `Ledger:` lines, not by `git status`.

Uninstalling AEO leaves `.aeo/memory/` in place.

## Session start hook

`memory.js hook session-start` injects a summary of the memory into a new Claude Code session, so the Team Lead does not rescan the repository. `memory.js context [--source <s>] [--repo <path>]` prints the same text for manual use (source defaults to `manual`).

What is injected (at most 9000 characters, nothing is written to the memory except the stats line):

- every source: `INDEX.md` (cut at 6000 characters with a truncation note), the number of libraries in `docs.md`, and an Open task section listing up to 8 delegation and apply records newer than the newest decision record, newest first.
- `compact` and `resume` only: additionally the baseline and the contract excerpt of the newest open delegation, so the Team Lead can restore the task after compaction.

Register the hook in `.claude/settings.json`:

```json
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node \"$CLAUDE_PROJECT_DIR/.aeo/bridge/antigravity-mcp/memory.js\" hook session-start"}]}]}}
```

`$CLAUDE_PROJECT_DIR` keeps the path independent of the directory the hook runs in.

A global install uses the absolute path to `~/.aeo/bridge/antigravity-mcp/memory.js`; write it as `node C:/Users/<you>/.aeo/bridge/antigravity-mcp/memory.js hook session-start` on Windows, because `~` is not expanded.

The hook never blocks a session: it always exits 0, prints nothing when `AEO_MEMORY=off`, when there is no repository or no `.aeo/memory/`, or when the input is invalid, and reports errors as one line on stderr. Registration is manual; the installer does not add it.

Codex has no equivalent hook; its policy asks it to read `INDEX.md`.

Each injection appends one JSON line `{"ts","source","chars","open"}` to `.aeo/memory/stats/session-start.jsonl`. It is a passive counter for later measurement; failures to write it are ignored.

## Docs registry

`docs.md` records, per dependency, which documentation source to use for the installed version. It is a markdown table:

```text
| library | ecosystem | version | source | verified | notes |
```

- `ecosystem` is `npm` (checked against `package-lock.json`) or `composer` (checked against `composer.lock`). Append `@<relative dir>` for a lockfile in a subdirectory, e.g. `composer@platform` reads `platform/composer.lock`. Absolute paths and `..` are rejected and the row is reported as `unchecked`. Other ecosystems are kept and reported as `unchecked`.
- Versions are compared as exact strings after dropping a leading `v`. Only top-level npm packages are read (`package-lock.json` v1, v2, v3). No network, no model.

```bash
# compare registry versions with the lockfiles (exit 0; exit 1 only when .aeo/memory is missing)
node .aeo/bridge/antigravity-mcp/memory.js docs check

# add or update a row by (library, ecosystem); version defaults to the lockfile version
node .aeo/bridge/antigravity-mcp/memory.js docs set --library react --ecosystem npm \
  --source "node_modules/react/README.md" --notes "hooks API"
```

`docs set` stamps `verified` with today's date, caps notes at 200 characters, escapes `|` in cells, keeps every other line of `docs.md` byte-for-byte, recreates the header if the file is missing, and refuses when `AEO_MEMORY=off` or `.aeo/memory` is missing. It fails when no version is given and none is found in the lockfile.

The session start block lists only problems: up to 10 lines for rows whose version differs from the lockfile or that are no longer in it (plus `(+n more)`). Otherwise it keeps the one-line library count, with a note that all checked versions match. The stats line gains `docsMismatches`.

## INDEX freshness

Each hand-written `INDEX.md` section can carry a marker on the line directly under its `## <Heading>`:

```text
<!-- verified: <sha|none> -->
<!-- verified: <sha> paths: src, lib/util.js -->
```

`paths` are repo-relative files or directories with forward slashes; without `paths` the whole repository counts. The generated `Recent tasks` heading never gets a marker. A section is `stale` when `git diff --name-only <sha> HEAD -- <paths>` or `git status --porcelain -- <paths>` lists files (`.aeo/memory/` is excluded). It is `unverified` without a marker or with `none`, and `unknown commit` when the sha is not in the repository. Local git only; no network, no model.

```bash
# record that the section matches the code at the current HEAD (keeps existing paths)
node .aeo/bridge/antigravity-mcp/memory.js verify --section "Modules" --paths src,lib

# --paths "" clears the paths; the heading match is exact but case-insensitive
node .aeo/bridge/antigravity-mcp/memory.js verify --section "Modules" --paths ""

# one line per section: fresh, stale: 7 files changed since a1b2c3d (...), unverified, unknown commit a1b2c3d
node .aeo/bridge/antigravity-mcp/memory.js freshness
```

`verify` inserts the marker when the heading has none, keeps every other byte (CRLF too), uses the same lock as `reindex`, and refuses when `AEO_MEMORY=off`, `.aeo/memory` is missing, or there is no git HEAD. `freshness` exits 0 (1 only when `.aeo/memory` is missing).

`seed` (or `init --seed`) is deterministic and only fills sections whose body is empty: `Modules` gets a directory map from `git ls-files` (depth 1-3 with file counts, dot directories and `.aeo/` skipped, at most 40 lines), and `Test commands` gets `test*` scripts from `package.json` and `composer.json`, `php artisan test`, `vendor/bin/phpunit` or `pytest` found in manifests at most one directory deep (at most 10 lines). Each seeded section is stamped with the current HEAD (`Test commands` with the manifest paths). Other sections are never seeded; it needs a git HEAD and refuses when `AEO_MEMORY=off`.

The session start block gains an `## INDEX freshness` section right after `INDEX.md`. An empty unverified section is listed as `empty; after this task add at most 5 lines ... then run ... verify --section "<heading>"`, so the model fills it from what it learned. Otherwise the section shows `All verified sections are fresh.` when nothing needs attention, otherwise one line (max 8) per stale, unverified, or unknown-commit section with up to 5 changed files, or `INDEX freshness unknown (git unavailable).` The stats line gains `staleSections` (stale plus unknown-commit).

## What it does not do yet

Hook registration is manual, and Codex has no hook.
