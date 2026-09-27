# Security

## Secrets

Do not commit API keys, tokens, OAuth files, or machine-specific credential paths. The Antigravity CLI keeps its own login cache outside this repository. Example configs use placeholders such as `C:/path/to/...` and `C:/Users/<USER>/...`.

If a secret lands in a commit, revoke it at the provider. Do not open a public issue that contains the secret.

## Agent permissions

The example permission files allow repository edits and a short list of read-only git and test commands. They deny push, reset, clean, rebase, merge, and commit. The Antigravity example also denies checkout and writes under `.git`.

Review those rules before you enable them. Widening them, trusting your home directory, or skipping permission checks gives the implementation engineer more room to change the machine. The bridge does not pass a skip-permissions flag. Headless command execution should stay limited to repositories you control.

`default_tools_approval_mode = "approve"` in the Codex example only skips a confirmation on the MCP call itself. It does not approve shell commands inside Antigravity.

## Destructive Git

History-changing git commands are denied on purpose. A user who wants a commit or a push asks for that explicitly. An agent report that claims it pushed is a defect in the setup, not a feature.

## Reporting a vulnerability

Please report vulnerabilities privately. Use the GitHub Security Advisories flow for this repository rather than a public issue. Include the affected file, the version or commit, and a way to reproduce the problem without live credentials if you can.

There is no hosted service in this repository. The practical risks are local: an over-broad permission file, a prompt that sends secrets to a model provider, and a diff that is approved without being read.
