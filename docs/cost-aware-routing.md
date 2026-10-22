# Cost-aware routing

This project exists to spend expensive reasoning where it changes the outcome, and to stop spending it on routine implementation.

A strong coding model is costly in tokens, latency, and attention. Using it to type a multi-file change, then also using it to review that same change, spends the expensive context twice. The useful split is:

- expensive reasoning for the objective, the design, the contract, the review, and the approval;
- a cost-efficient implementation model for the edit, the tests, and the revision.

That is the meaning of cost-aware AI engineering orchestration here. It is not a claim that several models are wiser than one, and it is not a measured savings guarantee. This repository does not measure or guarantee a savings number. This repository does not benchmark vendors or bill tokens.

Independent review and a maker/checker split are useful consequences. They are not the primary reason for the split.

## Cheaper is user-relative

Cheaper is user-relative, not provider-absolute.

Do not optimize for a specific vendor. Optimize for the cheapest sufficiently capable implementation path available to you.

A model can be the cost-efficient execution path for one person and a poor deal for someone else. The difference usually comes from how that person already pays for access:

- subscription bundling;
- student or education pricing;
- enterprise pricing;
- promotional pricing;
- regional pricing;
- higher included usage;
- a lower marginal API cost;
- unused capacity on a subscription they already pay for.

Another user may get better economics from a different implementation provider. Gemini via Antigravity is the current reference implementation in this repository. It is not a permanent economic assumption, and it is not a claim that Gemini is always cheaper than Codex or Claude.

## Where the expensive model stays

Keep the Team Lead on:

- what the user actually asked for;
- whether the change is trivial or substantive;
- architecture and decomposition;
- the implementation contract;
- conflicts between a report, a diff, and a test;
- the final APPROVED or CHANGES REQUIRED decision.

## Where implementation goes

In these presets, substantive implementation goes to the Implementation Engineer. The default path is Gemini through Antigravity (`delegate_antigravity`). The Antigravity bridge itself retries across configured Gemini model families when a model hits quota (`AEO_AGY_FALLBACK_MODELS`). The policy routes the same contract to Cursor through `delegate_cursor` on `aeo-cursor` only when the bridge returns `quota_or_auth_failure`, `cli_failure`, or is otherwise unavailable, instead of keeping the work on the Team Lead model. For parallel work on independent, non-overlapping scopes, the Team Lead can split delegations between both engineers with worktree isolation.

That covers:

- features and behavioral bug fixes;
- refactors and multi-file edits;
- integrations and migrations;
- tests that lock behavior;
- revisions after review.

CHANGES REQUIRED returns to Antigravity.

The policy file names the tools. This repository ships bridges for `delegate_antigravity` and `delegate_cursor`.

Discovery can stay on a lower-effort path. Explorer is a read-only lookup. Architect is reserved for a design decision that would be expensive to get wrong. Reviewer is reserved for a challenge that might change the decision. fast-worker is only a trivial mechanical edit. If fast-worker starts making product decisions, that path has been stretched into the wrong job. Stop and delegate to the Implementation Engineer.

## Ceremony has a cost too

A four-agent workflow on a typo spends more than it saves. The policy allows the Team Lead, or fast-worker, to make a trivial edit directly.

The failure mode this repository is built to resist is the opposite one: the expensive Team Lead implements a feature because the tool is available and the delegation feels like overhead. For substantive work, the current presets still require Antigravity even when the Team Lead could write the code. That requirement is the reference routing policy. Whether it also saves money depends on the implementation path being economically favorable for your account. Rules for keeping Team Lead context small during substantive tasks are in [docs/context-hygiene.md](context-hygiene.md).

## What routing is not

Routing is not an escalation ladder from a lower-effort agent up to an expensive one. Explorer does not get promoted into architect, and fast-worker does not get promoted into the Implementation Engineer. Each one is chosen for a job. See [architecture](architecture.md) for the role map and [policy versus capability](policy-vs-capability.md) for why the policy file, not the MCP tool, enforces the split.

## How to measure your own savings

Use `scripts/measure-delegation.mjs` to print a markdown table row in the format used by the README measured-example table.

Collect these yourself:

- Team Lead tokens from your provider's usage view. The bridge does not capture Team Lead tokens.
- Engineer tokens from an `agy` JSON envelope or from the bridge metadata JSON block. Both carry a `usage` object. The `agy` usage schema is not documented in this repository.
- Your own per-token rates (USD per 1M tokens) for the Team Lead and the engineer.
- Your own estimate of Team Lead tokens had that model typed the change without delegation (`--without-delegation-tokens`).

The script prices nothing unless you pass rates. Results are account-specific. This repository does not measure or guarantee a savings number.

Example:

```bash
node scripts/measure-delegation.mjs --task "<task-name>" --team-lead-tokens <N> --agy-json <agy-json-path> --team-lead-rate <N> --engineer-rate <N> --without-delegation-tokens <N> --header
```

## Unmeasured costs

The measurement script exists to help answer two open questions, not to close them.

A review and revision loop can consume more Team Lead tokens than direct implementation would have. Delegation round-trips add latency: the bridge waits up to the configured timeout per call. Whether the split still saves money on a given task depends on those costs as well as the token rates you pass in.

One measured pair so far, the README's [measured example](../README.md#measured-example), gives a first partial answer to both. On that task the review pass did not erase the saving: Team Lead cost was 17 percent lower with delegation, and Team Lead API time 59 percent lower — the stronger effect on a usage-limited subscription. The latency question resolved against delegation: wall-clock time was about 30 percent longer. One run per arm; treat it as a data point, not a conclusion.

## Personal example

Point-in-time personal example, not repository logic. This is not proof that Gemini is universally cheaper.

As of September 2026, the author's current student Google AI Pro plan costs ₺179.99/month under the applicable education promotion. Pricing may change. Eligibility may differ. Regional pricing may differ. A reader on a different plan, in a different region, or without that promotion may not see the same gap.

## Cost note

Reusable wording if you describe this setup elsewhere:

> Cost note: In my current setup, Gemini is especially economical because I use a discounted student Google AI Pro plan. Your cost advantage may differ. The general principle is to delegate implementation to whichever sufficiently capable model is cheaper for your own subscription and usage profile.
