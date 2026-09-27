# Smoke test

Use these after the bridge is installed and the Team Lead preset is loaded. Test A forces every role so you can see the tools fire. Test B does not name a role. Test B is the real policy test.

Codex agent ids are `aeo_explorer`, `aeo_architect`, `aeo_reviewer`, and `aeo_fast_worker`. Claude Code uses `aeo-explorer`, `aeo-architect`, `aeo-reviewer`, and `aeo-fast-worker` for the same jobs. Test A uses the Codex spelling; on Claude Code, call `aeo-explorer` where it says `aeo_explorer`.

Neither test needs a private repository. Point the Team Lead at a project you trust, with the baseline recorded first.

## Test A — forced integration

Paste this to the Team Lead:

```text
Run a forced orchestration smoke test. Do not skip a required step.

1. Use aeo_explorer to find the narrowest public input that currently accepts an empty identifier, or the closest existing validation gap if that input does not exist.
2. Use aeo_architect only if closing that gap crosses a module boundary the repository has not already decided. If it does not, skip aeo_architect and say why.
3. Delegate the implementation to Antigravity. Do not write it yourself. Add a regression test and the smallest production change that rejects the empty identifier without changing valid input. Do not satisfy this with a comment, a log line, or an unrelated refactor.
4. Verify the diff and the test yourself. Compare them with the git status you recorded before delegation.
5. Use aeo_reviewer on the resulting diff.
6. If aeo_reviewer or your own check finds a material issue, send the revision to Antigravity and review again.
7. Say APPROVED only after that verification. Otherwise say CHANGES REQUIRED.

Record which tools ran. Do not claim a test passed unless it ran.
```

Pass condition:

- aeo_explorer ran;
- aeo_architect ran only with a stated design reason, or was explicitly skipped;
- `delegate_antigravity` ran for the implementation;
- the Team Lead compared the diff with the baseline and checked the test;
- aeo_reviewer ran;
- a material finding produced an Antigravity revision;
- APPROVED was not declared from the implementation report alone.

## Test B — natural routing

Do not mention aeo_explorer, aeo_architect, aeo_reviewer, aeo-fast-worker, Antigravity, or `delegate_antigravity` in the prompt.

```text
Inspect the refresh-token lifecycle problem, implement the necessary
production-ready correction, add appropriate regression coverage, and verify
the result without unnecessarily changing the architecture.
```

Use a repository that actually has a refresh-token path. If it does not, name a real behavioral bug in that repository in the same shape: inspect, implement, add regression coverage, verify, do not widen the architecture.

Pass condition:

- the Team Lead delegates the substantive implementation through `delegate_antigravity` without being told the tool name;
- trivial files are not used as an excuse to keep the behavioral fix in the Team Lead session;
- the final answer is based on the diff and an actual verification result;
- unrelated dirty files from before the task are not rewritten or attributed to the engineer without a baseline.

If the Team Lead writes the behavioral fix itself, the policy is not in effect. Installing the MCP server is not enough. See [policy versus capability](../docs/policy-vs-capability.md).

## What this cannot prove

A smoke test on one repository does not measure token savings. It shows whether the route and the quality gate happened.
