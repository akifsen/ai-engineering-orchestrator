# Contributing

This repository is a reference implementation of cost-aware AI engineering orchestration. Changes should keep that story true.

## Policy

The Team Lead decides and approves. The Implementation Engineer implements substantive work and does not approve itself. `aeo_reviewer` / `aeo-reviewer` challenges and does not approve. `aeo_fast_worker` / `aeo-fast-worker` stays limited to trivial deterministic edits.

A policy change in `presets/codex/orchestration-block.md` needs the same rule in `presets/claude/rules/aeo-orchestration.md`, in the product's own wording. Do not leave one preset on "prefer Antigravity" and the other on mandatory delegation.

If you change what the trivial-edit role is allowed to do, update both `presets/codex/agents/aeo-fast-worker.toml` and `presets/claude/agents/aeo-fast-worker.md`, plus the description in `presets/codex/config-block.example.toml`. That role must not become a second implementation engineer.

## Providers

A new implementation backend needs a real bridge and a named tool in the policy. Do not hardcode a personal home directory, a machine-specific runtime path, or a private project list. Examples stay generic: `C:/path/to/...`, `C:/Users/<USER>/...`, `~/.codex/...`, `~/.claude/...`.

Document the role as Implementation Engineer, and say which tool currently fills it. Do not add a vague abstraction that hides the Antigravity command users actually run.

## Secrets and local files

Do not commit API keys, OAuth state, or a filled-in `settings.json`. Example fragments (`*.example.json`, `*.example.toml`) are the files that belong in git. Do not add instructions that replace `~/.codex/config.toml`, `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, or a project's `.mcp.json`.

## Tests

Bridge behavior is covered by `npm test` in `bridge/antigravity-mcp`. Installer preservation is covered by `node --test scripts/test` from the repository root. Run the bridge tests when you change spawn flags, timeouts, result classification, or the MCP schema. Run the installer tests when you change install, uninstall, or config merging.

A routing change is a documentation change plus a policy change. Update the affected doc, the diagram if the flow changed, and the smoke test if the pass condition changed. Do not claim cost numbers, failover, or telemetry that the code does not implement.

## Diffs

Keep a change focused. A preset wording fix does not need a bridge rewrite. A bridge fix should not rewrite the policy unless the outcome labels changed and the docs would otherwise lie.
