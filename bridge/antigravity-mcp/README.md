# Antigravity MCP bridge

This process lets a Team Lead call the Antigravity CLI as an Implementation Engineer. It is an MCP stdio server with one tool, `delegate_antigravity`.

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

The bridge rejects a relative path, a missing path, and a path that is not a directory. It then starts:

```text
agy --mode accept-edits --output-format json --print-timeout 15m -p <wrapped prompt>
```

The executable is `AGY_BIN` when that environment variable is set, otherwise `agy`. Arguments are passed without a shell. The bridge sets `--print-timeout 15m` and kills the process at 16 minutes. Client timeouts must be longer than 16 minutes. The Codex example uses 1200 seconds. The explicit limit is intentional: `agy --help` on a current build shows a default of `0s`, which waits until the turn finishes.

The wrapped prompt tells the engineer to inspect the repository, stay inside the contract, run allowed verification, avoid git history changes, and return a seven-part report. The Team Lead still has to read the diff.

Stdout of this process is MCP only. Diagnostics, including `antigravity-mcp: stdio server ready`, go to stderr.

## Results

| Outcome | Meaning |
| --- | --- |
| `agent_success` | The CLI exited 0 with status `SUCCESS` and a response. Evidence, not approval. |
| `agent_failure` | The CLI exited 0 and the agent status was not a usable success. |
| `cli_failure` | The process did not complete a run. Includes a missing `agy`, a non-zero exit, or invalid JSON. |
| `timeout` | The 16-minute bridge limit stopped the process. |
| `validation_failure` | The arguments were rejected before `agy` started. |

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

## Codex registration

Prefer the project installer. It registers the server as `aeo-antigravity` inside `<project>/.codex/config.toml` and does not edit `~/.codex/config.toml`.

The managed block looks like this. Merge it. Do not replace the file. Replace `<PROJECT>` with the project path, using forward slashes. The full fragment is [config-block.example.toml](../../presets/codex/config-block.example.toml).

```toml
[mcp_servers.aeo-antigravity]
command = "node"
args = ["<PROJECT>/.aeo/bridge/antigravity-mcp/index.js"]
enabled = true
enabled_tools = ["delegate_antigravity"]
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
- `lib/delegate.js` validates `cwd`, spawns `agy`, and classifies the result.
- `lib/server.js` registers the tool.
- `test/` is the automated check. It does not call a live model.

## Troubleshooting

- Server missing in the client: new session, correct path, server name `aeo-antigravity`.
- `agy` not found: install it or set `AGY_BIN`.
- Prompt rejected: shorten it below 24,000 characters and do not paste the repository.
- Client timeout: set it above 16 minutes.
- Command denied inside the run: see [permissions](../../docs/permissions.md). The bridge does not pass `--dangerously-skip-permissions`.

More cases are in [troubleshooting](../../docs/troubleshooting.md).
