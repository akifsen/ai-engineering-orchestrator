# Permissions

Autonomous editing is useful only inside a repository you trust. The examples in this project allow a narrow set of actions and deny destructive Git operations. They do not turn every permission check off.

Allowing more commands increases how much the engineer can do without you. Enable that only in a controlled working copy.

## Least privilege

| Surface | Intent |
| --- | --- |
| Team Lead | Read git state, run validation, call `delegate_antigravity`, `apply_delegation`, and `discard_delegation`. Deny push, reset, clean, rebase, merge, and commit. |
| Antigravity | Accept file edits in the workspace. Allow read-only git and the project's test or build commands. Deny history changes and `.git` writes. |
| Bridge | Spawn `agy` without a shell. Do not pass `--dangerously-skip-permissions`. |

The bridge asks Antigravity to run in `accept-edits` mode so headless file edits are not blocked on an interactive diff review. Shell commands are a separate decision. In headless mode, a command that still requires approval is soft-denied: the process can exit successfully while the command did not run. The Team Lead must treat that as not run.

## Files

The installer adds three Claude allow entries (`mcp__aeo-antigravity__delegate_antigravity`, `mcp__aeo-antigravity__apply_delegation`, and `mcp__aeo-antigravity__discard_delegation`) to the project's `.claude/settings.local.json` when those strings are missing. It does not replace the permissions object, and it does not copy the lists below. See [installation](install.md).

- [AEO permission fragment](../presets/claude/settings-permission.example.json). Merge those three strings. The server name is `aeo-antigravity`.
- [Antigravity permissions example](../antigravity/settings.example.json). This is the Antigravity CLI profile, not Claude or Codex config. It is not a file the installer owns. Antigravity authentication remains in your native user settings. The example is merged into `~/.gemini/antigravity-cli/settings.json`. If `~/.gemini/antigravity-cli/settings.json` does not exist, the example can be a starting point after you replace `C:\path\to\development` with the parent directory of the repositories you trust. On macOS or Linux, use a path such as `/path/to/development`. If that settings file already exists, preserve it and merge only the fields you intend to change, such as `agentMode`, `toolPermission`, `artifactReviewPolicy`, `trustedWorkspaces`, and `permissions` into `~/.gemini/antigravity-cli/settings.json`. Do not replace the entire file, and do not replace existing choices with the example values. Adapt the permission policy to your trust model. AEO does not write this file.
- [Codex MCP fragment](../presets/codex/config-block.example.toml). Merge the marked block into `<project>/.codex/config.toml`. Do not replace `~/.codex/config.toml`. `enabled_tools = ["delegate_antigravity", "apply_delegation", "discard_delegation"]` and `default_tools_approval_mode = "approve"` on the AEO server let the Team Lead call the bridge without a prompt on every delegation. It does not approve Antigravity's shell commands, and it does not change the global approval policy.

You can merge these Team Lead command rules yourself. Bash rules cover macOS and Linux. PowerShell rules cover Windows. Delete the family you do not use. The installer will not write them.

Allow:

- `Bash(git status*)`, `Bash(git diff*)`, `Bash(git log*)`, `Bash(git show*)`
- `Bash(npm test*)`, `Bash(npm run test*)`, `Bash(npm run lint*)`, `Bash(npm run typecheck*)`, `Bash(npm run build*)`
- the same commands with a `PowerShell(` prefix on Windows

Deny:

- `Bash(git push*)`, `Bash(git reset*)`, `Bash(git clean*)`, `Bash(git rebase*)`, `Bash(git merge*)`, `Bash(git commit*)`
- the same commands with a `PowerShell(` prefix on Windows

`toolPermission` in the Antigravity example stays `request-review`. Combined with the allow list, headless runs can execute the listed git and test commands as well as read-only inspection rules (`command(regex:git ls-files.*)` and `command(regex:^(ls|dir|Get-ChildItem|Get-Content|Select-String|cat|type|rg|findstr)( .*)?$)`) and are denied the listed destructive ones. Other commands fall through to ask, which headless mode cannot answer, so they are soft-denied. That is the intended default.

`allowNonWorkspaceAccess` is false. The engineer should not read or write outside the trusted workspace. The bridge also rejects a `cwd` that is not an absolute directory.

Do not set a global "always proceed" or skip-permissions flag as the recommended setup. Those flags exist in the CLI for a fully trusted prompt. This repository does not use them in the bridge.

## Git

Destructive Git commands are denied in the Antigravity example and in the manual Team Lead list above: push, reset, clean, rebase, merge, and commit. The Antigravity example also denies checkout and writes under `.git`. The policy tells both the Team Lead and the engineer not to rewrite history unless the user explicitly asks. The installer does not write those deny rules into Claude settings.

The `git worktree add`, `git worktree remove`, and `git apply` operations run only inside the bridge tools for worktree isolation. They do not commit, push, reset, rebase, merge, or rewrite history, and because they run internally within the bridge process, they need no Team Lead shell allow rule. The Team Lead still must not execute git worktree or git apply commands directly in its shell.

Deny rules are not a substitute for reading the diff. An allowed edit can still change the wrong file. The baseline check is what catches that.

## Workspace trust

`trustedWorkspaces` is the directory you are willing to let the agent treat as a development workspace. Use a dedicated development folder. Do not point it at your home directory.

If the CLI rejects a key in the example, your installed Antigravity version uses a different settings schema. Keep the permission intent and adjust the key names to that version's documentation. Do not respond to a schema error by removing the deny list.

## What still requires judgment

Permissions cannot tell a correct patch from a wrong one. They reduce the chance that a headless run pushes code or deletes the worktree. The Team Lead still reviews the diff. See [troubleshooting](troubleshooting.md) when a command is denied or a delegation never starts.
