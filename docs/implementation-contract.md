# Implementation contract

A contract is the assignment the Team Lead sends to Antigravity. It states the outcome and the boundaries. It does not narrate every function the engineer should type, and it does not paste the repository into the prompt.

Pass the absolute repository path as `cwd`. The engineer inspects the code itself.

## What to include

Use the lines that change the result. Omit the rest.

- objective;
- current behavior;
- expected behavior;
- non-goals;
- file scope (required for parallel delegations: explicit list of files or directories);
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

File scope:
<explicit list of permitted files or directories; required for parallel delegations>

Constraints:
- follow the existing architecture
- preserve <public API or stored data> unless this assignment changes it
- do not edit unrelated user changes already in the tree
- stay within the specified file scope

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

## Worktree isolation and dependencies

When using `isolation: "worktree"` for parallel delegations, the engineer works in a detached git worktree created from committed HEAD. The worktree does not inherit uncommitted changes from the main working tree, nor does it contain untracked dependencies such as `node_modules`.

As a result, engineer-side test or build runs in an isolated worktree may be incomplete or fail due to missing dependencies. In the contract, name which verification commands the engineer may attempt, and expect blocked or partial results. Authoritative verification takes place in the main tree after the delegation patch is applied.

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

## A real contract

The contract below produced the Test B run excerpted in the [README](../README.md#see-it-work): a refresh-token lifecycle fix in a Laravel project, October 2026. Wording is unchanged except that the project's command prefix is generalized to `app:` and the `cwd` line is omitted. The engineer ran it in one turn; all four defects were fixed, eight regression tests were added, and the full suite passed.

What makes it work, against the checklist above: each defect states current behavior with the file and symbol, then the required behavior including the edge case; the non-goals fence off the SPA, migrations, and auth flows the fix must not touch; the regression tests are named as observable outcomes, not implementations; and verification lists the exact commands the engineer may run, with the instruction to report anything blocked instead of improvising.

```text
Fix the admin refresh-token lifecycle in the Laravel API (api/). Keep the
existing architecture (AdminCookieAuthService + Actions + AdminRefreshToken
model + sanctum PersonalAccessToken). Production-ready, minimal, no unrelated
edits. Do not touch anything outside api/. Do not run git write commands.

Relevant files (inspect them first):
- api/app/Domain/Admin/Services/AdminCookieAuthService.php (rotateSession,
  revokeAllSessions, revokeFamily, storeRefreshToken)
- api/app/Domain/Admin/Actions/LogoutAdminAction.php
- api/app/Domain/Admin/Actions/RevokeAdminSessionsAction.php
- api/app/Domain/Admin/Models/AdminRefreshToken.php
- api/config/admin_auth.php
- api/routes/console.php (scheduler conventions: Schedule::... ->name()
  ->withoutOverlapping() ->onSuccess/onFailure heartbeat)
- api/app/Console/Commands/* (command conventions, signature prefix `app:`)
- api/tests/Feature/Auth/AdminCookieAuthIntegrationTest.php and
  api/tests/Concerns/MakesAdminCookieSession.php (test helpers to reuse)
- api/app/Http/Controllers/Api/V1/Admin/Auth/AdminAuthController.php
  (refresh / sessions / revokeSession / revokeOtherSessions endpoints;
  routes in api/routes/api.php ~line 383 and 405-407)

DEFECTS TO FIX

1. Logout kills every device. LogoutAdminAction revokes ALL of the admin's
   refresh tokens (`where admin_id`), so logging out on device A silently ends
   device B's session once its 15-minute access token expires. Required:
   logout revokes only the refresh token(s) whose access_token_id equals the
   current access token (the token resolved by resolveAccessTokenId). Keep the
   existing fallback: when no access token can be resolved, revoke everything
   as today. Prefer reusing/aligning with
   AdminCookieAuthService::revokeCurrentSession rather than duplicating logic
   (it is currently unused; either use it or delete it—no two copies).

2. Session revocation is bypassable via refresh.
   RevokeAdminSessionsAction::execute and ::revokeToken delete only
   PersonalAccessTokens; the matching refresh tokens stay active, so a
   "revoked" session can mint a new access token at POST /admin/auth/refresh.
   Required: both methods also set revoked_at on AdminRefreshToken rows whose
   access_token_id is among the deleted token ids (revoked_at = now(), only
   where currently null). execute()'s return value (count of revoked access
   tokens) must remain the same.

3. Rotation is neither atomic nor tolerant of concurrent legitimate use.
   rotateSession does read-then-write without a transaction or lock, so two
   simultaneous requests with the same refresh token can both succeed, and the
   multi-tab case is worse: tab 1 rotates, tab 2 (same browser, same cookie,
   same moment) presents the now-rotated token, hits the
   `revoked_at !== null` branch, and revokeFamily() kills the session tab 1
   just received, logging the admin out of every tab. Required:
   a. Wrap the rotation in DB::transaction and read the record with
      lockForUpdate(). Revoke the consumed record via a conditional update
      (`whereKey(id)->whereNull('revoked_at')->update([...])`); if 0 rows were
      affected treat it like the reused path (another request consumed it
      first).
   b. Add a reuse-grace window: new config key `refresh_reuse_grace_seconds`
      => (int) env('ADMIN_REFRESH_REUSE_GRACE_SECONDS', 30). A token that was
      consumed BY ROTATION (revoked_at set AND last_used_at set — rotation is
      the only code path that sets last_used_at; document this on the model)
      and whose revoked_at is within the grace window and whose expires_at is
      still in the future is accepted: mint a new access token + new refresh
      token in the SAME family_id, do NOT revoke the family, do not modify the
      old record. Tokens revoked for any other reason (logout, session
      revocation, revokeAllSessions, family revocation — all leave
      last_used_at null) are rejected with reuse detection as today, even
      inside the grace window. Outside the grace window a rotated token
      triggers reuse detection (family revoked, 'refresh_reused') as today.
      Grace of 0 disables it.
   c. Keep AdminSessionException reasons and the 401 + cleared-cookies
      behaviour of the controller unchanged.

4. Nothing is ever pruned. admin_refresh_tokens rows (expired/revoked) and
   expired sanctum personal_access_tokens accumulate forever. Required: new
   artisan command `app:admin:prune-refresh-tokens`
   (api/app/Console/Commands/, follow sibling conventions) that deletes
   AdminRefreshToken rows where expires_at < now() - retention OR
   revoked_at < now() - retention; retention from new config key
   `refresh_prune_retention_days` => (int)
   env('ADMIN_REFRESH_PRUNE_RETENTION_DAYS', 30). Print the deleted count.
   Schedule it daily in routes/console.php with the same
   name/withoutOverlapping/heartbeat pattern as the other entries, and also
   schedule `sanctum:prune-expired --hours=24` daily the same way.

Non-goals: no changes to the admin SPA (apps/admin), no new migration (use
existing columns), no changes to login/2FA flows, no changes to cookie
formats, no changes to CSRF.

REGRESSION TESTS (add to
api/tests/Feature/Auth/AdminCookieAuthIntegrationTest.php or a new test class
in the same folder, reusing MakesAdminCookieSession; use Carbon test time
travel `$this->travel(...)` where needed):
- logout on session A leaves session B's refresh token usable (two logins for
  the same admin; logout with A's cookies; refresh with B's refresh cookie →
  200; refresh with A's → 401).
- DELETE /admin/auth/sessions/{token} from session A for B's token → B's
  refresh cookie → 401; A still refreshes fine.
- POST /admin/auth/sessions/revoke-others from A → B's refresh → 401, A's
  refresh → 200.
- rotated token reused within grace → 200 with a new refresh cookie; the
  first successor token still refreshes afterwards (family not revoked).
- rotated token reused after grace (travel past 30s) → 401 and the successor
  token is then also rejected (family revoked).
- token revoked by logout, presented within grace → 401 (no grace for
  non-rotation revocations).
- grace set to 0 via config() → immediate reuse → 401 (existing
  test_refresh_rotates_token_family may be adapted to set the config to 0, or
  keep it and add the new one).
- prune command: create rows (active, expired-long-ago, revoked-long-ago,
  revoked-recently) → only the two old ones are deleted.
Keep the existing tests passing. The existing
test_concurrent_refresh_only_one_succeeds asserts one 200 and one 401 for
sequential reuse; adjust it to set grace to 0 (its intent is reuse detection)
rather than deleting it.

VERIFICATION you may run: `cd api && php artisan test --filter
AdminCookieAuth`, `php artisan test --filter AdminTwoFactor`, `php artisan
test --filter Admin` (sqlite, fast), `./vendor/bin/pint --test` on changed
files if pint exists. Report exactly which commands ran and their actual
results; report anything blocked.

Report: summary, files changed, important decisions, tests/validation
executed with actual results, blocked commands, remaining risks.
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
