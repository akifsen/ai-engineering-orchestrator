# Feature task

Paste this to the Team Lead in a repository that has an authenticated HTTP API. Adjust the module names to that repository. Do not name agents in the prompt if you want to see natural routing.

```text
Add an account audit export.

Operators need a CSV of account events for one account and a closed date
range. Include timestamp, actor, event type, and a stable event id.
Reject an inverted range and an unknown account with the API's existing
error style.

Do not change authentication, add a second storage backend, or export
events for every account in one call.

Cover:
- a normal range
- an empty range
- an inverted range
- an unknown account

Run the relevant tests. Leave unrelated local edits alone.
```

What the Team Lead should do:

1. Record `git status --short`.
2. Find the existing account-event read path. Use `aeo_explorer` or `aeo-explorer` if that location is not already known.
3. Skip architect unless the export would cut across storage, auth, and the public API in a way the current structure does not already answer.
4. Write a contract with the CSV columns, the error cases, and the non-goals above.
5. Delegate the implementation and the tests to Antigravity.
6. Read the diff against the baseline and run the new tests, or confirm they ran.
7. Approve only if the four cases exist and auth is untouched.

`aeo_fast_worker` / `aeo-fast-worker` is the wrong owner. This feature decides behavior and needs tests.
