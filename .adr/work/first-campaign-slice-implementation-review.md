# First campaign slice — final implementation review

Independent adversarial review of the complete uncommitted implementation, run after the AWS verification and teardown. Scope: the shared contract, the backend capabilities, the CLI, the Stack and every test, judged against the [plan](first-campaign-slice.md) and [ADR-0001](../0001-resource-owning-effect-services.md). The reviewer changed no file and ran no cloud command.

## Verdict

**Clear** after re-review. The first pass returned **Changes required**. The load-bearing invariant — no second application submission after a durable claim — was found **Clear**, traced exit by exit from `claimCampaign` returning `"claimed"`. `Storage.runTransaction`, the request-size-before-auth ordering, the 401 challenge, per-request capability provision, `tokensMatch` and the complexity profile were each Clear with reasoning. One code finding and four test findings were raised; all five are now fixed.

## Findings and dispositions

| ID  | Severity | Subject                                             | Disposition                    |
| --- | -------- | --------------------------------------------------- | ------------------------------ |
| F1  | Moderate | `ThrottlingException` missing from `rejectionCodes` | **Fixed**                      |
| F2  | Low      | Live concurrency assertion could pass vacuously     | **Fixed by a new direct test** |
| F3  | Moderate | "Lost claim acknowledgement" was mis-modelled       | **Fixed**                      |
| F4  | Moderate | No test asserted the 409/503 status mappings        | **Fixed**                      |
| F5  | Moderate | CLI "exit zero only for acceptance" was untested    | **Fixed**                      |

### F1 — `ThrottlingException` was classified as uncertain

`rejectionCodes` mapped `TooManyRequestsException` but not `ThrottlingException`, which reaches the same union through `CommonAwsError`. A throttled submission that provably never sent would have been recorded `unconfirmed` forever, which the operator must treat as possibly delivered. Verified against the installed SDK source: `errors.ts` defines `ThrottlingException`, and `SendEmailError` includes `CommonErrors`. Mapped to `rate-limited`, with a test that drives a real HTTP 400 carrying that error type through the real codec.

### F2 — the live concurrency test could pass with nothing sent

`expect(new Set(sendIds).size).toBeLessThanOrEqual(1)` over a list built by filtering out failures also passes when **zero** requests succeed. Tightened to require at least one success, to require the successful sendIds to equal exactly the durable sendId, and to check the accepted record carries a `messageId`.

**Recorded limit, deliberately not "fixed":** the reviewer proposed asserting that both requests succeed. That would be flaky — a real `TransactWriteItems` race can legitimately return `TransactionConflict`, which correctly surfaces as 503. More importantly, **no black-box assertion can detect a second submission here.** The send record's key is `SEND#<contactId>`, not `SEND#<sendId>`, so two claims write the same item and the count stays 1 either way. One-message-per-campaign rests on two condition expressions — `#state = :draft` on the campaign update and `attribute_not_exists(pk)` on the send record, items 1 and 2 of the claim transaction.

Checking which live test reached those conditions exposed a gap the review had not found: **none did.** The stale-membership-version test fails item 0 (the list `ConditionCheck`), so items 1 and 2 still pass; the duplicate-membership test exercises `attribute_not_exists(pk)` on the `MEMBER#` record, not the `SEND#` one. A direct test was added: claim a draft campaign, then claim it again with a fresh `sendId` and request token. The second attempt fails items 1 and 2 while item 0 passes, which is deterministically `already-attempted`, and the campaign keeps the first `sendId`. That is the live proof of the invariant; the convergence test proves convergence only, and is no longer described as if it were the invariant's proof.

Two limits stand, both confirmed on re-review. The tightened convergence assertions still would not catch the counterfactual where both conditions are dropped: both requests claim and submit, the loser's finalisation fails its `sendId` condition and its response is filtered out, and the winner's sendId matches the stored one — so two emails would ship with the assertions green. And the new claim test proves the **conjunction** of items 1 and 2, not each alone: dropping either one still yields `already-attempted` because the other still fails. Acceptable, because either condition alone suffices for the same-contact case and a changed audience is caught by item 0.

The fresh `ClientRequestToken` in that test is required for a sharper reason than the idempotency window: because the `sendId` also differs, reusing the token would raise `IdempotentParameterMismatchException` rather than replay the first result, and the test would fail confusingly instead of exercising the conditions.

### F3 — the lost claim acknowledgement was not what the test said it was

The `claimFailure` hook short-circuited _before_ the double mutated its world, so `submission.state === "draft"` was guaranteed by the double's construction rather than by the code. The plan's actual hazard is the opposite: the claim **commits** and its acknowledgement is lost. Added a `claimAckLost` hook that commits and then fails, asserting 503, zero submissions, a durable `unconfirmed` state, and a replay that returns the unconfirmed campaign without submitting. T4's evidence line has been corrected — it previously overstated this coverage.

### F4 — the status mappings had no test

Changing `MembershipConflict` from 409 to 500, or any 503 to 200, left every test green, while the CLI would then fail to decode the response. This defect class had already occurred once (contract review F2 shipped `SendStatusUnrecorded` as 500). Two complementary tests now cover it: a table in `Schemas.test.ts` freezing the declared status of all eight public errors, and a boundary test in `Api.test.ts` proving a real 503 with a typed `SendUnconfirmed` body reaches the wire. The latter also asserts that replaying an `unconfirmed` campaign returns 200 and submits nothing.

### F5 — the CLI's exit contract was untested

The test server always returned `accepted`, so deleting the non-accepted branch — the headline of the documented output contract — passed all eight CLI tests. The service double now takes the submission it should return; a new test sends an `unconfirmed` campaign and asserts a nonzero exit, the result still on stdout, and the warning on stderr. Mutation-checked: inverting the guard fails the test.

## Also addressed

- `Auth.test.ts` asserted `Config.redacted`'s own behaviour without calling `apiToken`. Deleted — `apiToken`'s success and no-leak properties were already covered.
- `Commands.test.ts` asserted `Option.isSome(Option.fromUndefinedOr(result.stderr))` on a value that is always a string. Replaced with an assertion on the content.
- `Api.integration.test.ts` accepted _any_ failure as invalid-token denial, so a DNS error would have satisfied it. Now asserts `Unauthorized`.

## Rejected, with reasons

- **Testing every `Effect.timeout` budget.** Removing all of them keeps the suite green, but asserting them needs a clock seam threaded through the storage doubles for little gain; the budgets are structural and were exercised live. Accepted risk.
- **`createList`/`getList` codec tests in `Storage.test.ts`.** Both run against the real deployed table in the live suite. Adding doubles-based codec tests would duplicate that coverage.
- **Sharing the two in-memory Storage doubles.** The reviewer independently reached the same conclusion: they are not near-identical. `Campaigns.test.ts` enforces the real conditions; `Api.test.ts` deliberately omits them and counts reads/writes for wiring assertions. Sharing would weaken one or over-build the other.

## Unrecorded deviations surfaced by the review

Now recorded in the plan's Deviations section: `Auth.ts` hand-rolls a constant-time comparison instead of `timingSafeEqual` (the lint rule forbids importing `node:crypto`), and `Api.ts` buffers the body before measuring it against the size cap rather than refusing mid-stream (bounded in practice by the Function URL's 6 MB payload limit).

## Re-review

The same reviewer verified every fix against the working tree and re-ran `pnpm check` independently: format, type-aware lint, `tsc --noEmit`, 9 files / **156 tests**, import smoke. All five findings confirmed closed, the three rejections accepted, no new tautology, and no new source comment — exactly three comments remain repo-wide, all load-bearing for the lint gate. Verdict: **Clear**.

Two claims were upgraded on re-review. F1's reachability is now confirmed at the codec level rather than argued from the type union: the test would report `SubmissionUncertain` if the parser produced `UnknownAwsError` instead of the tag, and it does not. And the new claim test's opening `"claimed"` assertion is the first live positive proof that all three transaction items commit together.

## Post-fix state

`pnpm check` green: format, type-aware lint, typecheck, **156 unit tests**, import smoke. The live suite was not re-run — the test stage is destroyed — so the three integration-test changes, including the new claim test, are typechecked and linted but not executed. The reviewer inspected the new test for the runtime hazards it could not exercise: `yield*` inside the object literal is legal, `toMatchObject` on an absent campaign throws rather than passing, and the test writes only to the ephemeral table and never reaches `Mailer`, so it sends no email. It runs on the next deployment.
