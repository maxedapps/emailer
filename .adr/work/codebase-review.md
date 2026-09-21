# Code review: entire codebase (send-safety, cost traps, correctness)

## Review constraints

| Axis | Selection |
|---|---|
| Target | Whole repository at current `main` (ahead of origin by 3 commits); not a diff |
| Baseline | Generic, adversarial review against accepted ADRs (especially 0003, 0004, 0006, 0007, 0008, 0011–0016) |
| Scope | Full: send path, consent/suppression/reputation, storage/idempotency, API/auth/CLI, Alchemy stack |
| Invocation | Standalone |
| Output | `.adr/work/codebase-review.md` |
| Dimensions | Correctness (duplicate send / spam), security and data safety, performance and scale (cost), APIs/operations, tests/validation; simplicity only where it would hide a send or cost defect |
| Validation/tools | Four read-only review lanes; parent re-trace of claim/settle/checkpoint/mailer retry; `pnpm test` (unit) 728 passed. No AWS, no deploy, no source edits |
| Writes/artifacts | This report only |

## Summary

No material findings. The send-once invariant holds: one SES submission per `(campaign, contact)` under at-least-once SQS and Scheduler delivery. Consent, suppression, and reputation rails match the accepted ADRs. Happy-path cost is SES-dominated (~$0.10/1k) with DynamoDB/Lambda in the noise.

The review hunted specifically for duplicate mail, accidental extra sends, and cost runaways. Those paths are designed around claim-then-submit, `Retry.none` on `SendEmail`, and skip-before-claim. Residuals that remain are the ones the ADRs already accepted (unconfirmed rows never retried, in-flight opt-out of a few seconds, unbounded dispatcher concurrency). They are recorded below as context, not as defects to fix.

## Related decomplex review

- **Report:** not requested; simplicity was applied as a review dimension only
- **Owner disposition summary:** n/a

## Coverage

### Inspected

- Send lifecycle: `Dispatching.ts`, `Dispatcher.ts`, `Dispatch.ts`, `Mailer.ts`, `SendGuard.ts`, `Campaigns.ts`, `CampaignSchedule.ts`, `Storage/Campaigns.ts`, `Storage/Primitives.ts`, `Storage/RateLimit.ts`
- Audience and consent: `Storage/{Contacts,Membership,Addresses,Audience,Feedback,Unsubscribe}.ts`, `Unsubscribe.ts`, `UnsubscribePage.ts`, `Feedback.ts`, `FeedbackClassification.ts`, `Reputation.ts`, `Addresses.ts`
- Front door: `Api.ts`, `Auth.ts`, `Diagnostics.ts`, `packages/api`, `apps/cli`, `ReplayFeedback.ts`
- Stack: `alchemy.run.ts`, `SendingIdentity.ts`, `Storage/Table.ts`
- ADRs 0003, 0004, 0006, 0007, 0008, 0011, 0012, 0013, 0015, 0016
- Installed Distilled retry (`Retry.none`) and Alchemy `consumeEmailEvents` event pattern
- Unit tests that pin claim, checkpoint, mailer attempts, skip/stale mapping, unsubscribe, feedback classification

### Skipped or partial

- Live AWS, ephemeral deploy, IAM CloudTrail, leftover-stage inventory
- `pnpm lint` / `pnpm check` (unit suite only)
- Delivered MIME `h=` one-click header on a live message (pinned in unit `Mailer.test.ts` and historically in ADR-0004)
- Empty `apps/mcp/src` (not in the stack; cannot run in prod)

### Required boundaries

- SES `SendEmail` at most once per campaign/contact, including SQS redelivery, duplicate wakes, overlapping slices, rate-limit retries, timeouts
- Opt-out, local suppression, and bouncing skips before claim; one-click headers and postal footer on every submission
- API cannot send mail; unsubscribe cannot read or query the table
- Writes safe to repeat (ADR-0013); Scheduler fires are the same wake as `send`

## Validation

- **Run:** `pnpm test` (unit) — 30 files, **728 passed**, exit 0
- **Skipped/unavailable:** live SES/DynamoDB/SQS, `pnpm check`, IAM policy documents on a deployed stage. Send-once claims were challenged against source, unit oracles, and ADR-0011’s recorded live gate (two concurrent `send`s, one row per member), not re-run live here.

## Plan-backed verdicts

Not applicable. This is a generic whole-codebase review, not a plan-compliance review.

## Plan compliance matrix

Not applicable.

### Approvals and conflicts

- **Approved deviation:** none
- **Authority conflict:** none. Implementation matches the accepted ADRs on send-once, repeat-safe writes, consent keying, and reputation pauses.

## Follow-up closure

- **Round and material delta:** initial standalone review
- **Closure state:** Clear
- **Resolved or withdrawn:** n/a
- **Still material:** none
- **New fix-caused or fix-exposed findings:** n/a

## Findings

None admitted.

Candidate failures that were investigated and rejected at the admission gate are listed under context-dependent concerns and confirmed-good, not as findings.

## Context-dependent concerns

- **Concern:** Dispatcher Lambda bills `Effect.sleep` from delay-mode `RateLimiter` at 512 MB with no `reservedConcurrentExecutions`. One campaign at ~20/s is negligible (~50 ms sleep/send). N concurrent campaigns each wait about `N/limit` seconds per send while holding 0.5 GB; at N ≈ 100 that is minutes of billed GB-s per slice and can consume unreserved account concurrency. Unsubscribe already caps reserved concurrency at 10; the dispatcher does not.
  **Disposition:** Accepted ADR-0011 residual (“No concurrency cap is set; if that ever changes, the dispatcher’s reserved concurrency is the knob”). Implementation is not worse than the decision. Not a duplicate-send bug. Cap the dispatcher only if concurrent campaigns become an operator pattern.

- **Concern:** API Function URL is `authType: "NONE"`. Unauthenticated requests still invoke the 512 MB / 60 s function and can omit `Content-Length` so `oversizedBody` reads the body before 401. Wiki `http-token-authentication.md` states this explicitly.
  **Disposition:** Chosen auth model for a small trusted-caller API. Not a missing bearer check. WAF/CloudFront or reserved concurrency is a product choice, not a code defect.

- **Concern:** `consumeEmailEvents` omits `configurationSets` (Alchemy `matchValue` array bug, ADR-0003). The EventBridge rule matches all `aws.ses` bounce/complaint/delivery-delay events on the default bus; the handler filters by tag. Extra invokes occur only if another configuration set also publishes those types to the default bus.
  **Disposition:** Documented workaround. No evidence a co-tenant SES sender publishes those events to EventBridge. Handler is a cheap filter.

- **Concern:** CreateSchedule does not set `Target.RetryPolicy`, so AWS’s default (up to 185 retries / 24 h) applies, while ADR-0015 said “no Scheduler retry policy”. Duplicate fires are stale-discarded or already-claimed.
  **Disposition:** Does not create a second SES send. Setting `MaximumRetryAttempts: 0` would match the ADR literally and make a failed fire an operator `campaigns send`; leaving the default self-heals a transient `SendMessage` failure.

## Confirmed-good areas

**Send-once.** `runSlice` claims `SEND#<contactId>` with `attribute_not_exists(pk)` and `sending`+`runToken` before any `Mailer.submit`. `already-claimed` and `stale` never submit. Rows are never deleted, so a later slice cannot reclaim. `Mailer.makeSubmit` applies Distilled `Retry.none` then an 8 s timeout; 429 is one HTTP attempt (unit-pinned); without `Retry.none` Distilled retries. Application retries of `rate-limited` are only for errors ADR-0011 treats as never accepted. `SubmissionUncertain` settles and does not resubmit. `settleRecipient` returning `not-current` cannot re-enter SES.

**Overlapping runners.** Standard SQS and Scheduler are at-least-once. `beginRun` admits the same token in `queued|sending|scheduled`. Two runners may walk the same page; only the Put winner sends. Checkpoint is conditional on the previous cursor **or** this slice’s own `(cursor, sliceId)`, so a lost response re-enqueues once and a concurrent duplicate starts no second chain. Cancel vs `beginRun` compete on META; a cancelled draft/paused wake is stale.

**Audience uniqueness.** One `EMAIL#` reservation per mailbox; membership is `MEMBER#<contactId>`; import reuses the holder and rejects duplicate addresses in one payload at the schema. A second campaign to the same list is a new campaign, not a retry of the first.

**Consent and suppression.** Live `addressStatus` (unsubscribe > suppression > bouncing) before claim. Opt-out is mailbox-keyed and blocks moving a contact off that address. Unsubscribe links carry the mailbox, HMAC-then-decode, GET is read-only, POST succeeds only after a durable write. `List-Unsubscribe` and `List-Unsubscribe-Post` plus postal footer on every submission. `unsuppress` never deletes `UNSUBSCRIBE#`. Configuration set `suppressedReasons` is BOUNCE/COMPLAINT; OPEN/CLICK tracking and VDM are off.

**Reputation.** Slice-start `GetAccount` + `DescribeAlarms`; breaker uses integer run deltas with ADR-0012 thresholds; feedback history is conditional so a redelivered event does not double-count.

**Auth and IAM.** Bearer `timingSafeEqual` after length check; token stays redacted. API does not construct `SES.SendEmail`. Unsubscribe IAM is `PutItem` only. Replay invokes the configured function ARN, never the ARN in the parked record.

**Storage.** Cursors come from `LastEvaluatedKey` (corrupt if unreadable). `BatchGet` retries `UnprocessedKeys` and fails closed on a short page. Claim vs skip `conditionFailures` indexes are swapped with `TransactItems` order on purpose; both-fail on claim is stale (no send); both-fail on skip cannot reach `Mailer.submit`.

## Limitations and caveats

- ADR-accepted residuals, not findings: crashed-slice `unconfirmed` rows are never retried; an in-flight submit after a just-clicked opt-out cannot be recalled (seconds, inside CAN-SPAM’s window); Gmail has no FBL to SES; EventBridge publication is best-effort; live membership can mail a contact added behind the cursor.
- ADR-0016’s live cancellation gate was previously unverifiable in its implementation review. Unit and integration tests for cancel vs `beginRun` exist; this review did not re-run them live.
- Cost model figures are from code paths and public list prices, not a bill.

## Next steps

1. No code changes required from this review.
2. Optional operator choice: set dispatcher `reservedConcurrentExecutions` if several campaigns will run at once (ADR-0011’s named knob).
3. Keep using `--stage test` ephemerally; leftover stages remain the main avoidable AWS bill outside SES itself.
