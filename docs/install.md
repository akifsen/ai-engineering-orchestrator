# Installation

AEO owns only configuration that is namespaced as AEO. Existing project instructions, global Codex config, global Claude config, MCP servers, custom agents, model settings, sandbox settings, and approval settings stay in place. Global config is not modified unless `--global`.

The installer never edits these unless `--global`:

- `~/.codex/config.toml`
- `~/.codex/AGENTS.md`
- `~/.claude/CLAUDE.md`
- `~/.claude/settings.json`
- `~/.claude.json`

It also does not mark a Codex project trusted. Codex loads `<project>/.codex/config.toml` only for a trusted project. Trust the project in the normal Codex UX if that file does not take effect. Codex CLI and Codex IDE share the same configuration layers.

## Installer

From this repository:

```bash
node scripts/aeo.mjs install --target C:/path/to/project --codex --claude --dry-run
node scripts/aeo.mjs install --target C:/path/to/project --codex --claude
node scripts/aeo.mjs update --target C:/path/to/project --codex --claude
node scripts/aeo.mjs update --target C:/path/to/project --codex --claude --force-managed-update
node scripts/aeo.mjs status --target C:/path/to/project
node scripts/aeo.mjs doctor --target C:/path/to/project
node scripts/aeo.mjs uninstall --target C:/path/to/project
node scripts/aeo.mjs uninstall --target C:/path/to/project --force-remove-modified
```

`--dry-run` prints creates, preserved files, managed-block merges, JSON merges, unchanged files, safe updates, user-modified files, conflicts, and backups. It writes nothing. Use it first.

Pass `--codex`, `--claude`, or both. The command stops if you pass neither.

`install.ps1` and `install.sh` forward arguments to `node scripts/aeo.mjs`.

Before AEO changes a shared file that already exists, it copies that file to `~/.aeo/backups/<project-id>/<timestamp>/`. A forced replacement of a drifted AEO-owned file is backed up there too. Unchanged files are not backed up. The project id is a hash of the project path, not the path itself. Uninstall does not copy a backup back over the project. Recovery from a backup is manual.

If `npm ci` fails while installing the bridge, MCP configuration is not activated.

## Global install

AEO supports a user-scope `--global` mode for configuring user-level Codex and Claude environments across projects:

```bash
node scripts/aeo.mjs install --global --codex --claude --dry-run
node scripts/aeo.mjs install --global --codex --claude
node scripts/aeo.mjs update --global --codex --claude
node scripts/aeo.mjs doctor --global
node scripts/aeo.mjs uninstall --global
```

Pass either `--target <project>` or `--global`, not both.

### Global layout

| Path | Purpose |
| --- | --- |
| `~/.codex/config.toml` | User tables, plus one AEO config block |
| `~/.codex/AGENTS.md` | User text, plus one AEO orchestration block (or replaced with `--replace-codex-agents-md`) |
| `~/.codex/agents/aeo-*.toml` | Namespaced Codex agent definitions |
| `~/.claude.json` | Existing servers, plus `mcpServers["aeo-antigravity"]` |
| `~/.claude/settings.json` | Existing permissions, plus one allow entry |
| `~/.claude/rules/aeo-orchestration.md` | Orchestration rule |
| `~/.claude/agents/aeo-*.md` | Namespaced Claude agent definitions |
| `~/.aeo/bridge/antigravity-mcp/` | Runtime bridge files and installed dependencies |
| `~/.aeo/global-install-manifest.json` | Global install manifest |
| `~/.aeo/backups/global/<timestamp>/` | Backups of pre-existing modified files |

### Flags

- `--adopt`: Claims pre-existing exact-matching preset files, permissions, or matching `aeo-antigravity` MCP server entries into the global manifest instead of reporting a collision. If pre-existing files or MCP command/args differ, `--adopt` refuses to claim them.
- `--replace-codex-agents-md`: In global mode, replaces the entire `~/.codex/AGENTS.md` with the AEO orchestration block instead of appending to it, backing up pre-existing content to `~/.aeo/backups/global/<timestamp>/` when written. Whole-file ownership in the manifest is sticky: subsequent installs or updates keep whole-file mode without needing the flag. Unchanged runs write no backup and report no changes for it. On uninstall, the file is deleted if unchanged from the install, or preserved if modified.

### Coexistence

When both a global AEO installation (`~/.aeo/global-install-manifest.json`) and a project AEO installation (`<project>/.aeo/install-manifest.json`) exist, running `doctor` on the project produces a warning that both configure the same agent and MCP server names.

## Update safety

Even AEO-owned files become user-controlled once you edit them. AEO records the version it installed and refuses to silently overwrite drifted files.

You may customize agent model settings. AEO tracks installed file hashes, so normal updates preserve modified agent files instead of silently replacing them. That includes `model`, `model_reasoning_effort`, and `developer_instructions` in `.codex/agents/aeo-*.toml`, and `model`, `effort`, `tools`, and the instructions in `.claude/agents/aeo-*.md`. The same protection applies to `.claude/rules/aeo-orchestration.md` and to bridge source files copied into `.aeo/bridge/antigravity-mcp/`. `node_modules` is not hashed and is not listed in the manifest.

`install` and `update` are the same reconcile. There is no separate release channel.

On first install, AEO writes the files it owns, hashes the bytes that landed on disk with SHA-256, and stores those hashes in `.aeo/install-manifest.json`. The hash means "this is the exact content AEO last successfully installed." The manifest does not store file contents or secrets. If installation stops before the manifest is saved, the copied files are not owned. The next install treats each of them as a collision, even when the bytes match the preset. Inspect those files, remove them yourself when that is safe, and run install again. AEO will not adopt them because the content matches. A manifest write that fails after a file update is reported as incomplete; the previous manifest still owns those files, and the previous hash stays on disk until a later successful run.

Matching AEO content is not proof of ownership. A file may already exist from a manual copy, an older setup, or an install that stopped before the manifest was written. Equal bytes do not give AEO permission to record or later delete that file.

A later install checks manifest ownership before it compares bytes.

- The file exists and the active manifest does not own it: collision. AEO preserves the file and does not record it. This applies when the bytes differ and when they exactly match the preset. `--force-managed-update` does not take ownership of it.
- The manifest owns the file and the current bytes equal the preset: the file is unchanged. AEO stores that hash if the manifest did not already have it, and does not rewrite the file.
- The manifest owns the file, the current bytes still match the installed hash, and the preset differs: AEO writes the preset and stores the new hash.
- The manifest owns the file and the current bytes differ from the installed hash: AEO leaves the file alone and reports `USER MODIFIED — PRESERVED`.
- The file is missing, and the manifest shows AEO owns that path: AEO recreates it. A name alone is not ownership.

`--force-managed-update` replaces drifted manifest-owned files and drifted text inside a manifest-owned AEO block. It writes a backup first, reports the overwrite, and updates the hash after the write succeeds. It does not replace unrelated user files, unowned MCP servers, an `aeo-*` file that was never in the manifest, or an AEO block the manifest does not own.

Shared files stay surgical. `AGENTS.md`, `.codex/config.toml`, `.mcp.json`, and `.claude/settings.local.json` are not replaced as whole files. AEO updates only a block or JSON entry that the active install manifest owns. Text outside the markers stays.

AEO markers are not ownership. Ownership is a managed-block record in the active `.aeo/install-manifest.json`. When that record includes `sha256`, the hash is the interior AEO last installed, not the hash of the preset about to be written. If a well-formed AEO block is already in the file and the manifest has no record for it, installation stops. The block stays byte-for-byte. AEO does not adopt it, does not write a second block, and does not treat a matching preset as proof of ownership. `--force-managed-update` does not claim it.

That includes a preserved orphaned AEO block. Uninstall keeps a customized block, then deletes the manifest. Deleting the manifest abandons ownership on purpose. The markers remain as user-controlled configuration. A later install will not take the block back.

When the manifest does own the block:

- The interior hash equals the hash AEO last installed, and the preset differs: AEO updates that interior and stores the new hash.
- The interior differs from the installed hash: AEO leaves it and reports `USER MODIFIED — PRESERVED` until you pass `--force-managed-update`.
- An older manifest lists the block but has no hash. That record is still ownership. A matching interior is hashed. A different interior is preserved.

An older manifest without file hashes is schema 1. Schema 2 adds `sha256` on each installed file and on each managed block. A missing hash does not mean the file is unchanged. If the current bytes match the preset being installed, AEO records the hash. If they differ, AEO preserves the file until `--force-managed-update`.

Dry-run reports the same decisions, including `UNCHANGED`, `SAFE UPDATE`, `USER MODIFIED — PRESERVED`, `OWNERSHIP UNKNOWN — PRESERVED`, `UNOWNED EXISTING FILE — COLLISION`, `WOULD OVERWRITE WITH --force-managed-update`, and `RECREATE MISSING`. `UNCHANGED` is used only when the manifest owns the file. It does not write files, backups, or the manifest. A dry run that finds an unowned AEO block or an unowned AEO file reports the collision and does not report a successful install.

Uninstall deletes an owned file only when its bytes still match the stored hash, or, for a schema 1 manifest, when they still match the current preset. A drifted file or a drifted managed-block interior is reported and kept. MCP entries and other unchanged AEO config are still removed, so a kept agent file is no longer tracked. The next install stops rather than overwrite that orphan file. Move or delete that agent file before installing again if you want AEO to recreate it. A kept managed block is a preserved orphaned AEO block: uninstall removed its ownership record on purpose, and the next install leaves the block unchanged. Review it yourself if you want a fresh managed copy. `--force-managed-update` does not apply to a file or block that is no longer in the manifest. `--force-remove-modified` deletes drifted AEO files and drifted block interiors during uninstall. Without a manifest, uninstall refuses to guess.

`.aeo/install-manifest.json` records AEO-owned files, the SHA-256 of the bytes AEO installed, managed blocks, and merged entries. Uninstall uses that manifest.

## Names

| Job | Codex role | Claude agent | MCP |
| --- | --- | --- | --- |
| Discover | `aeo_explorer` | `aeo-explorer` | |
| Design | `aeo_architect` | `aeo-architect` | |
| Implement | Antigravity | Antigravity | server `aeo-antigravity`, tool `delegate_antigravity` |
| Review | `aeo_reviewer` | `aeo-reviewer` | |
| Trivial edit | `aeo_fast_worker` | `aeo-fast-worker` | |

Generic names such as `explorer`, `architect`, `reviewer`, `fast_worker`, `Explore`, and `antigravity` are not installed. You may already be using them.

## What a project looks like after install

```text
<project>/
├── AGENTS.md                         user text, plus one AEO block
├── CLAUDE.md                         unchanged
├── .mcp.json                         existing servers, plus aeo-antigravity
├── .aeo/
│   ├── install-manifest.json
│   └── bridge/antigravity-mcp/
├── .codex/
│   ├── config.toml                   user tables, plus one AEO block
│   └── agents/aeo-*.toml
└── .claude/
    ├── settings.local.json           existing permissions, plus one allow entry
    ├── rules/aeo-orchestration.md
    └── agents/aeo-*.md
```

The Codex block does not set `model`, `model_reasoning_effort`, `service_tier`, `sandbox_mode`, `approval_policy`, `notify`, or `trust_level`. Multi-agent support is already on in current Codex versions, so AEO does not add a generic `[agents]` table.

## Manual Codex install

Do not replace `AGENTS.md` or `~/.codex/AGENTS.md`. Do not replace `~/.codex/config.toml` or an existing `.codex/config.toml`.

1. Copy [presets/codex/agents/](../presets/codex/agents/) to `<project>/.codex/agents/`. The filenames are already namespaced.
2. If `AGENTS.md` has no AEO markers, append [presets/codex/orchestration-block.md](../presets/codex/orchestration-block.md) between these lines:

```text
<!-- AEO:BEGIN ORCHESTRATION -->
<!-- AEO:END ORCHESTRATION -->
```

If the markers already exist, replace the interior only when you mean to discard it. A preserved orphaned AEO block — markers left after uninstall kept your edits and removed the manifest — is user-controlled configuration. Do not replace it just because the markers are present. The installer stops instead of replacing it. If a marker is missing or repeated, stop. Do not rewrite the file. See [Update safety](#update-safety).

3. Append [presets/codex/config-block.example.toml](../presets/codex/config-block.example.toml) to `<project>/.codex/config.toml`, inside the `AEO MANAGED CONFIG` markers. Replace `<PROJECT>` with the project path using forward slashes. If those markers already exist, do not replace the interior unless you mean to discard it. The installer will not replace an unowned block. If `[mcp_servers.aeo-antigravity]` or an `[agents.aeo_*]` table already exists outside that block, stop. Do not declare the same table twice.
4. Copy the runtime bridge files (`package.json`, `package-lock.json`, `index.js`, `README.md`, and `lib/`) to `<project>/.aeo/bridge/antigravity-mcp/` and run `npm ci` there. Do not copy `node_modules` from this repository. The installer stops `npm ci` after 180 seconds. If it times out or fails, do not point Codex or Claude at that bridge. Point the MCP args at that project's `index.js` only after dependencies are installed.
5. Trust the project in Codex yourself if project config does not load.

The orchestration block says existing repository instructions still apply. If those instructions and this policy cannot both be followed, the Team Lead should surface the conflict.

## Manual Claude install

Do not replace `CLAUDE.md`, `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, or `.claude/settings.json`.

1. Copy [presets/claude/rules/aeo-orchestration.md](../presets/claude/rules/aeo-orchestration.md) to `<project>/.claude/rules/aeo-orchestration.md`.
2. Copy [presets/claude/agents/](../presets/claude/agents/) to `<project>/.claude/agents/`. Leave every other agent file alone.
3. If `.mcp.json` does not exist, you can start from [presets/claude/mcp-entry.example.json](../presets/claude/mcp-entry.example.json) and replace `<PROJECT>`. If it exists, add only `mcpServers["aeo-antigravity"]`. Keep every other server. If that key already exists and you did not add it with AEO, stop.
4. In `<project>/.claude/settings.local.json`, append this allow entry only when it is absent:

```text
mcp__aeo-antigravity__delegate_antigravity
```

[presets/claude/settings-permission.example.json](../presets/claude/settings-permission.example.json) shows that single entry. It is not a replacement for your permissions object. Do not remove or reorder unrelated allow or deny rules.

Git allow and deny examples you may merge yourself are in [permissions](permissions.md). The installer does not write them.

## Uninstall by hand

Remove only:

- the text between the AEO markers in `AGENTS.md` and `.codex/config.toml`, including the markers
- `.codex/agents/aeo-explorer.toml`, `aeo-architect.toml`, `aeo-reviewer.toml`, and `aeo-fast-worker.toml`
- `.claude/rules/aeo-orchestration.md`
- `.claude/agents/aeo-explorer.md`, `aeo-architect.md`, `aeo-reviewer.md`, and `aeo-fast-worker.md`
- `mcpServers["aeo-antigravity"]`
- the single allow string `mcp__aeo-antigravity__delegate_antigravity`
- `<project>/.aeo/` if you created it for this install

Leave the rest of each file. If you customized a managed block and want to keep that text, leave the block in place. Markers without an install manifest are not a reason to delete it. Delete `AGENTS.md`, `.codex/config.toml`, `.mcp.json`, or `settings.local.json` only when AEO created that file and no user-owned content remains. If you edited an AEO agent, rule, or bridge source file, keep that file unless you mean to discard the edit. The `uninstall` command does that unless you pass `--force-remove-modified`.

## Conflicts

Installation stops, and writes nothing, when it finds:

- a partial or repeated AEO marker pair
- a well-formed AEO block in `AGENTS.md` or `.codex/config.toml` that the active manifest does not own, including a preserved orphaned AEO block
- an AEO Codex table outside the managed block
- `mcpServers["aeo-antigravity"]` that this install does not already own
- an AEO agent, rule, or bridge runtime file that already exists and is not in the active manifest, including when its bytes exactly match the current preset
- invalid JSON in `.mcp.json` or `.claude/settings.local.json`
- a manifest from a different project path

A permission string that was already present before AEO is left alone and is not removed on uninstall.

A drifted file that the manifest already owns does not stop the install. AEO preserves it. See [Update safety](#update-safety).

## Source archive

A working tree may contain `node_modules`. That directory is local. It stays out of a source archive when Git is not tracking it.

Pack the tracked files:

```bash
git archive --format=zip --prefix=ai-engineering-orchestrator/ -o aeo-source.zip HEAD
```

`git archive` does not delete local dependencies. It includes only files Git tracks, so the archive leaves out ignored `node_modules/`, `.env` files, logs, temporary files, local credentials and auth, and IDE or runtime junk such as `.idea/`, `.vscode/`, and editor swap files. Recovery backups live under `~/.aeo/backups/` and are outside this repository. Keep `package.json` and `package-lock.json`. There is no separate packaging script.
