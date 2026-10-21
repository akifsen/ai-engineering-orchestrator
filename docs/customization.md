# Customizing Codex and Claude files

Do not copy a preset over `AGENTS.md`, `CLAUDE.md`, `config.toml`, or `.mcp.json`. The fragments in `presets/` are what the installer merges.

Model names inside the AEO agent files are examples. Change these fields when your account uses different slugs:

- `.codex/agents/aeo-*.toml`: `model`, `model_reasoning_effort`, or `developer_instructions`
- `.claude/agents/aeo-*.md`: `model`, `effort`, `tools`, or the instructions
- `.claude/rules/aeo-orchestration.md`: the same kind of local edit

AEO tracks installed file hashes, so a normal update preserves those edits. That does not change the model in your user Codex config.

See [installation](install.md) for ownership, update, and `--force-managed-update`.
