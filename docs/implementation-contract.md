# Implementation contract

A contract is the assignment the Team Lead sends to Antigravity. It states the outcome and the boundaries. It does not narrate every function the engineer should type, and it does not paste the repository into the prompt.

Pass the absolute repository path as `cwd`. The engineer inspects the code itself.

## What to include

Use the lines that change the result. Omit the rest.

- objective;
- current behavior;
- expected behavior;
- non-goals;
- architecture or compatibility constraints;
- behavior that must remain unchanged;
- acceptance criteria;
- tests or other verification;
- definition of done.

## Template

```text
Objective:
<what must be true when this assignment is done>

Current behavior:
<what the code does now, with the file or symbol if you know it>

Expected behavior:
<what should happen, including the important edge case>

Non-goals:
<what not to redesign>

Constraints:
- follow the existing architecture
- preserve <public API or stored data> unless this assignment changes it
- do not edit unrelated user changes already in the tree

Acceptance:
- <observable outcome>
- <regression that must keep passing>

Verification:
- run <specific test command> if permissions allow
- if a command is blocked, report it as not run

Done when:
- the acceptance lines are implemented
- the completion report lists files, decisions, commands actually run, results, blocked commands, and remaining risks
```

## Example

```text
Objective:
A failed payment capture must keep the inventory reservation.

Current behavior:
captureFailure in checkout releases the reservation, so the item can be sold twice.

Expected behavior:
A declined capture leaves the reservation held until its existing expiry.
A successful capture still converts the reservation exactly once.

Non-goals:
Do not redesign checkout, change the payment provider, or add a new reservation state.

Constraints:
- keep the public checkout API
- do not edit src/billing/invoice.ts if it is already dirty and outside this bug

Acceptance:
- a declined capture does not release the hold
- a successful capture still releases or converts it exactly once
- the existing successful-payment test still passes

Verification:
- run the checkout test file if the test command is permitted
- report any command you could not run

Done when:
- the regression test exists and you have reported its actual result
```

## Revision contract

A revision is still a contract. Point at the current code and the failed check. Do not tell the engineer to start over unless the approach cannot be repaired.

```text
Revision required.

Original objective:
<objective>

Review findings:
1. <what is wrong>
   Evidence:
   <file, test name, or command output>
   Required correction:
   <expected behavior>

Acceptance criteria:
- <criterion>
- relevant tests pass
- unrelated behavior stays unchanged

Inspect the current implementation and revise it.
```

The Team Lead writes the contract. Antigravity does not get to redefine the task by skipping a line and reporting success. The [quality gate](quality-gate.md) checks the contract against the diff.
