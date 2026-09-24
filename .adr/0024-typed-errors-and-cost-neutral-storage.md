# ADR-0024: Typed errors, one item codec and cost-neutral storage

- Status: Proposed
- Date: 2026-09-24
- Authority: On 2026-09-24 a whole-codebase review found one error type standing for every failure. The user asked for granular, type-safe error handling that embraces Effect and Alchemy, for a lean codebase, and for no change that raises running cost. They accepted the review's recommendations, including dropping delivery-delay events and keeping the feedback queue.
- Supersedes in part, once implemented:
  - [ADR-0004](0004-sender-owned-one-click-unsubscribe.md): unsubscribe as "a separate item type from suppression". The two become separate fields of one address item. Unsubscribe is still not a suppression reason, `unsuppress` never clears it, and both stay keyed by lowercased address.
  - [ADR-0006](0006-consent-survives-a-contacts-address-change.md): the opt-out check targets the address item, not `UNSUBSCRIBE#`.
  - [ADR-0007](0007-immutable-recipient-unsubscribe-links.md): the POST's `PutItem`-only capability becomes `UpdateItem`-only. The conditional first write becomes `if_not_exists`.
  - [ADR-0008](0008-storage-capabilities-and-error-boundaries.md): the internal `StorageFailure` translated at entry points, and the `UnsubscribeStore` and `FeedbackStore` bindings.
  - [ADR-0012](0012-reputation-guardrails.md): delivery delays are no longer published or logged, and the transient-bounce window moves to the address item.
  - [ADR-0013](0013-repeat-safe-writes.md): the AWS client's implicit default retry policy.
  - [ADR-0020](0020-drafts-previews-and-test-sends.md): its statement that the unsubscribe function holds `PutItem` only.
- Plan: [0024-typed-errors-and-cost-neutral-storage.plan.md](0024-typed-errors-and-cost-neutral-storage.plan.md)

## Context

- **One internal error stands for everything.** `StorageFailure` covers DynamoDB, SES, SQS, EventBridge Scheduler, CloudWatch and corrupt data alike: 24 `unavailable(...)` and 25 `corrupt(...)` call sites. As a result:
  - every endpoint can fail with every dependency, and the types cannot say otherwise;
  - an SES outage is logged as "storage operation failed" and answered as `StorageUnavailable`.
- **Storage outcomes are untyped.** Writes answer string results (`"stale"`, `"conflict"`, `"not-current"`) and sets of failed transaction slot indexes. One result is silently ignored (the settle outcome in `Dispatching.ts`).
- **Boundaries are hand-written.** `publicly` is repeated 28 times and `reportedAndFatal` covers the pages and consumers. On the unsubscribe and preview pages, a failure becomes a defect, and Alchemy's HTTP boundary logs it in full, bypassing the sanitizer.
- **Each stored item is described twice:** once as a decode schema, and once as a write built by hand.
- **The status check before each send reads three address items.** They are usually missing, yet each costs one read unit.
- **Retries are hidden or hand-written.**
  - The AWS client's default policy (8 retries, about 20 s) is cut off by the 5 s operation timeout, so a throttled call is reported as `TimeoutError`.
  - The dispatcher's throttle backoff and the batch-read retry are hand-written loops.
- **Constraints:**
  - DynamoDB stays;
  - no change may raise running cost;
  - every change removes more code than it adds;
  - the HTTP contract may change, because the CLI and the API ship together.

## Decision

1. **One error class per failure, classified once where it happens.**
   - Public business errors:
     - `ContactNotFound`, `ListNotFound` and `CampaignNotFound` replace `NotFound{entity}`;
     - the existing conflicts stay, and `ContactChanged` (409) is added.
   - Public dependency errors (503), each with the fields `{ operation, failure }`:
     - `StorageUnavailable`;
     - `EmailServiceUnavailable`;
     - `QueueUnavailable`;
     - `SchedulerUnavailable`;
     - `AlarmsUnavailable`.
   - Each endpoint declares exactly the errors it can return.
   - Internal errors steer the backend and never leave it:
     - `RunSuperseded`;
     - `CampaignChanged{current}`;
     - `FeedbackAlreadyRecorded`;
     - `SettlementNotApplied`;
     - the flat send errors `SendRejected`, `SendThrottled`, `SendingSuspended` and `SubmissionUncertain`.
   - Corrupt stored data is the defect `CorruptItem`: a 500, or a failed invocation.
   - Transient AWS failures stay typed, unlike Effect's reference service. The operator gets a retryable 503, and SQS redelivery stays explicit.
2. **Effect's `ErrorReporter` does the reporting.**
   - Errors carry their own reporting annotations. Business errors are ignored; dependency errors and defects log only their tag, severity and declared attributes.
   - Every Lambda handler reports each failure inside its own services and never fails outward. The HTTP functions answer 500; the SQS consumers fail the invocation with a fixed error. This keeps causes out of Alchemy's boundary and the Lambda runtime log.
3. **One item codec.**
   - One generic codec translates between DynamoDB attribute values and plain values. It covers only strings, numbers, string maps and string sets.
   - Each stored record is the contract schema plus `v`, and is read and written through the same codec.
   - The campaign record is a union by state.
4. **Typed conditional writes.**
   - Each transaction action names the error its failed condition means, and the error channel is inferred.
   - Failed conditions return the stored item (`ReturnValuesOnConditionCheckFailure: ALL_OLD`, which consumes no read capacity), which replaces the follow-up reads.
5. **One address item per mailbox** (`ADDRESS#<mailbox>`) holds the opt-out, the suppression and the transient-bounce window.
   - The status check becomes one read unit instead of three, and `unsuppress` one write unit instead of four.
   - Existing rows move over in a verified one-off migration.
6. **Retries are Schedules.**
   - The dispatcher's throttle backoff and the batch-read retry become `Effect.retry` with a Schedule.
   - The AWS client keeps its own default policy, which honours server retry hints and waits at least 500 ms after a throttle. It is only capped, with `Schedule.upTo`, so that it ends inside the 5 s operation timeout and the real AWS error surfaces instead of `TimeoutError`.
7. **The contract drops the hand-written 413 check.** Field-size limits already answer an oversized body with 400.
8. **SES delivery-delay events are no longer subscribed; the feedback queue stays.**

## Alternatives

- **Rename `StorageFailure` to a dependency error with a `dependency` field.** This is the simplest change. It keeps one error for everything and gives no endpoint-level type safety. Rejected: the user wants granular typed errors.
- **Treat all infrastructure failures as defects,** as Effect's reference service does. This means fewer types, but the operator loses the retryable 503 and SQS behaviour becomes implicit. Rejected.
- **One public `DependencyUnavailable{dependency}`.** Rejected in favour of a class per dependency, so each endpoint's declaration is exact.
- **Provide the reporter on each function's startup effect.** This is untested for HTTP. It cannot cover the SQS consumers, because Alchemy rethrows their failure and the Lambda runtime logs it. Rejected in favour of one boundary everywhere.
- **Drop the `LISTOF#` reverse rows and the contact cascade.** Rejected for cost: each deleted contact's orphan member rows would cost at least one read unit on every send to that list, overtaking the saved writes after about 30 reads.
- **Store full items in the listing index.** Rejected for cost: every counter update on a campaign would also write the index.
- **Send concurrently within a campaign.** Rejected for cost: concurrent settles would conflict on the campaign's counters, and cancelled transactions are billed.
- **A relational database (Aurora DSQL).** Rejected: DynamoDB stays.
- **Alchemy's `toAttributeValue` / `fromAttributeValue`.** Rejected: they are typed `any` and lossy (an empty string throws; `undefined` becomes `NULL: false`).

## Consequences

- **Contract changes:**
  - the three `NotFound` classes;
  - the per-dependency 503s;
  - `ContactChanged`;
  - 413 becoming 400.

  The CLI and the API must be deployed together.
- **A corrupt item** answers 500 instead of 503, and fails the SQS invocation as today.
- **Listings stay strongly consistent,** and the cascades are unchanged.
- **The address migration** runs before and again right after the deploy, in a window with no running or scheduled campaign and no API use.
- **Running cost is equal or lower.**
  - Status reads drop from 3 read units to 1 per recipient.
  - `unsuppress` drops from 4 write units to 1.
  - Conflict paths lose their re-reads.
  - The capped retry policy makes at most as many attempts as today's timeout allows.
  - Everything else makes the same AWS calls.
- **The feedback queue's idle polling stays.** It is an estimated 0.26–0.65 million SQS requests a month, at most about $0.26 a month beyond the free tier.
- **Delivery delays are no longer visible in the logs.**
- **The unit tests change widely:**
  - 92 references to `StorageFailure` / `failureOf` in 15 files;
  - 32 scripted transaction cancellations tied to slot positions;
  - 67 assertions on string results.

## Confirmation

- `pnpm check` passes, with unit tests for:
  - the reporter's privacy;
  - the typed refusals;
  - the throttle retry's timing on the test clock;
  - the retry policy over a stubbed transport.
- The live suite passes on an ephemeral stage.
- The address migration is rehearsed there.
- A forced corrupt item answers 500, and its values do not appear in CloudWatch.
