# Bug-fix task

Paste this to the Team Lead. It is a behavioral bug, so the implementation owner is Antigravity even though the sentence is short.

```text
A reservation expires and the hold is not released, so a later purchase of
the same item fails even after the reservation is no longer valid.

Release the hold when the reservation expires, including the path that
expires during an in-flight checkout attempt. Do not release a hold that
has already been converted by a successful payment.

Add a regression test for the expired-hold purchase. Do not redesign
reservations or payments.
```

Expected route:

- record the baseline;
- locate the expiry and checkout paths;
- delegate the fix and the regression test;
- reject a patch that releases holds for successful payments;
- do not describe the tests as passed if the test command was denied.

A reviewer is useful if the expiry path shares state with payment capture. The Team Lead can require one for this bug. Reviewer still does not approve it.

The Team Lead should not keep this fix in its own session. Expired-hold behavior is substantive.
