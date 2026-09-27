# High-risk task

Use this shape for auth, payment, or concurrency work. The routing is the same mandatory implementation path, with a stricter review.

```text
Payment capture can run twice for one order when two requests arrive
together. The second capture must not charge the customer again, and both
callers must observe the same final order state.

Keep the current payment provider and the public capture API.
Do not add a new order status unless the existing states cannot represent
"capture in progress" safely.

Add tests for:
- two overlapping capture calls
- a capture that fails after the provider accepts it
- a repeated capture after success

Call out any remaining race you could not close.
```

What changes compared with an ordinary feature:

- architect is justified if the codebase has no single owner for the charge record, the idempotency key, or the transaction boundary;
- the contract must name the idempotency key, the lock or unique constraint, and the state both callers return;
- Antigravity still writes the code and the tests;
- reviewer should read the diff for double charge, lost updates, and tests that serialize the two calls so heavily that they no longer overlap;
- APPROVED waits on that review plus the Team Lead's own reading of the diff;
- a remaining race in the report is CHANGES REQUIRED unless the contract explicitly left that race out of scope.

Do not ask `aeo_fast_worker` or `aeo-fast-worker` to "add the lock." That is concurrency work.

Provenance still applies. If `git status` was already dirty in a billing file before delegation, do not fold that file into the capture fix or attribute it to the engineer without evidence.
