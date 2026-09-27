# Policy versus capability

Connecting an MCP tool does not make the Team Lead use it.

| Piece | Role |
| --- | --- |
| MCP bridge | Capability. `delegate_antigravity` can start Antigravity. The installed server id is `aeo-antigravity`. |
| Policy | Codex reads an AEO block in the project `AGENTS.md`. Claude reads `.claude/rules/aeo-orchestration.md`. `CLAUDE.md` stays user-owned. The policy says when the call is mandatory. |
| Model | Reasoning. It interprets the policy and the evidence. |
| Repository and tests | Evidence. A diff and a test result outrank a completion report. |
| Team Lead | Authority. Only the Team Lead approves. |

The bridge is deliberately small. It checks `cwd`, starts `agy` in headless accept-edits mode, and returns a labeled result. It does not know whether the task was a typo or a payment bug. The Team Lead knows, because the policy file told it how to classify the work.

## Preferred is not mandatory

"Prefer Antigravity" leaves the bypass open. A Team Lead that can edit files will often do the edit itself, especially when the task looks medium-sized or the tool call needs a longer prompt. The implementation then lands in the expensive session, which is the cost this project is trying to avoid.

"Antigravity is the mandatory default Implementation Engineer for substantive work" closes that bypass. The remaining exceptions are narrow: the edit is trivial, the user explicitly asks the Team Lead to implement it, or Antigravity has actually failed as tooling and that failure is stated.

Both presets use the mandatory wording. A softer Claude policy next to a strict Codex policy would not be the same system.

## Why the tool description is not enough

The bridge instructions say that Antigravity implements and that the Team Lead must verify. That hint helps a client that reads tool descriptions. It is not loaded as the project's standing policy, and a client can ignore it. The policy file is what the Team Lead session is instructed to follow on every task.

If substantive work is implemented without `delegate_antigravity`, treat that as a policy failure, not as a bridge failure. The natural check is [Test B in the smoke test](../examples/smoke-test.md). The prompt does not name Antigravity. If the Team Lead still delegates the implementation, the policy is in effect.

## Evidence outranks the report

`agent_success` means the CLI finished a run and returned text. It does not mean the tests passed, the contract was met, or the diff is acceptable. The Team Lead reads the diff and the tests. Reviewer can challenge that reading. Neither the engineer nor the reviewer approves.

## Extending the engineer

The policy is attached to the role named Implementation Engineer. The current presets bind that role to Gemini via `delegate_antigravity`. That binding is the reference implementation, not a permanent assumption that Gemini is the cheapest provider for every user. Replacing it with another CLI or MCP-backed coding model means adding a bridge and changing the named tool in the policy. It does not mean inventing a second implementation path beside the current engineer while both are allowed to take the same substantive work.
