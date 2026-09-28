# Quality gate

After Antigravity returns, the Team Lead decides. The decision is APPROVED or CHANGES REQUIRED. There is no third state that means "the engineer said it was done."

## Before the decision

Record `git status --short` before substantive work. After the run, compare that baseline with the current status and diff.

For worktree-isolated delegations, the bridge's base commit and patch serve as that delegation's baseline. The main-tree `git status --short` baseline still applies and must be re-read before the first apply and after every apply. Changes that appear in the main tree after an apply are attributed to that delegation only when they match its patch/diffstat.

Apply isolated delegations one at a time using `apply_delegation`. After each apply:

- read `git status --short` and the diff in the main tree;
- read the files that materially changed;
- check the implementation contract and the acceptance criteria;
- look for unrelated edits;
- read the tests that should have changed;
- run, or independently confirm, the most relevant verification in the main tree;
- treat a command the engineer could not run as not run;
- decide APPROVED or CHANGES REQUIRED before applying the next delegation.

An `agent_success` or `applied` label means the CLI finished or the patch applied. It does not mean tests passed or that the work is approved. An `apply_conflict` outcome means the patch could not apply because the main tree moved or overlaps; it is not approval and not a revision. A permission denial in the CLI diagnostics is a blocked command.

Do not attribute a dirty file to Antigravity, the user, or another agent without the baseline. The baseline section in the Team Lead policy shows the rule with a generic diff: a reviewer sentence is not ownership evidence.

## APPROVED

Approve only when all of these hold:

- the requested behavior is present in the diff;
- the contract is satisfied;
- quality is acceptable for the codebase;
- architecture constraints from the contract still hold;
- the relevant verification succeeded, or you ran it yourself and it succeeded;
- important edge cases in the contract are handled;
- you do not see an unacceptable regression;
- unrelated user work is untouched;
- no important requirement is still open.

Approval is allowed to be brief. It still has to be true of the repository, not of the report.

## CHANGES REQUIRED

Require changes when any of these hold:

- behavior is missing or wrong;
- acceptance criteria are unmet;
- a required test is missing or failing;
- a security or concurrency concern in scope is unresolved;
- the diff violates the architecture constraint;
- unrelated files were modified;
- the engineer treated a blocked command as a pass;
- the result is below the standard of the surrounding code.

Do not approve in order to stop the loop. Send the correction back through `delegate_antigravity` as a [revision](revision-loop.md).

## Who does not approve

Antigravity does not approve its own work. `aeo_reviewer` / `aeo-reviewer` does not approve. `aeo_explorer` / `aeo-explorer`, `aeo_architect` / `aeo-architect`, and `aeo_fast_worker` / `aeo-fast-worker` do not approve. The Team Lead approves.

Reviewer is optional. Use it when a second reading could change the decision: security, concurrency, persistence, or a wide blast radius. If reviewer is wrong about authorship and right about a defect, keep the defect and discard the authorship claim.
