# Simplify the codebase

## Outcome and boundaries

The codebase reads as if it had been built this way from the start: one concept per job, library primitives instead of hand-rolled equivalents, and no layer that only forwards. Every change is subtractive. Nothing adds a guard, an edge case or a feature.

- **Unchanged:** the HTTP and CLI contract, except that `pnpm feedback:replay` and the stack outputs `feedbackFunctionArn` and `feedbackFailureQueueUrl` go (T6). Stored DynamoDB items and keys. The send-once invariant: at most one SES submission per campaign and contact.
- **Source of the items:** five read-only review lanes on 2026-09-24 (storage; sending and campaigns; feedback, consent, identity and the stacks; contract and CLI; cross-cutting). Items an earlier plan already rejected stay out unless their premise changed.
- **Out of scope:** merging the capability stores or the primitive factories; an alarm helper; merging the unsubscribe and preview pages; `Items.ts` into `Table.ts`; dropping the import result's `member` field; trimming the test fakes' domain rules; removing `check:imports`.

## Decisions

The user decided these on 2026-09-24:

- **Feedback recovery goes through SQS.** Feedback events reach the feedback Lambda through an SQS queue with a dead-letter queue. Recovery is the native redrive the dispatcher already uses, and the replay tool is deleted. This reverses ADR-0003 in part.
- **Storage fails with the contract's expected errors.** `NotFound`, `EmailAlreadyUsed` and `AddressOptedOut` come straight from storage. The audience translation layer is deleted, and the API calls the stores directly for plain reads and writes. This reverses ADR-0008's "Storage errors do not depend on public HTTP schemas" for expected outcomes; `StorageFailure` stays internal.
- **Outdated schedules are never deleted.** They fire once, are discarded as stale and delete themselves. This reverses ADR-0015's delete on cancel and ADR-0016's cleanup rules.
- **The unit tests use `@effect/vitest`.**

## Tasks

Each task is one commit, in this order, with `pnpm check` green after each.

### T1 — Storage reads decode to the API shape

- Decoded items become domain values with `Struct.omit(stored, ["v"])`. Pages hydrate with `Effect.forEach`. `contactOf` stays only where a contact is built.
- Import candidates are `Schemas.Contact` values; `ImportCandidate` and `ImportedContact` go. `Contacts.create` builds its contact the same way.
- ~~`runTransaction` reads Distilled's typed `CancellationReasons` instead of re-decoding them.~~ Dropped: the installed package's compiled declarations (`lib/services/dynamodb.d.ts`) type `CancellationReasons` as `any`, so the existing decode from `unknown` is the only lint-clean read.
- Small cleanups:
  - drop the `undefined` checks that come before a struct decode, in `beginRun` and the rate-limit store;
  - look address rows up by sort key and derive the status once;
  - `nextCursorOf` returns `string | undefined`.
- One schema per enum, shared by the contract and storage: campaign state, address status (the skip reasons are a `pick`), suppression reason, and the `SendingPaused` reason (a `pick` of `PauseReason`).

### T2 — Storage writes: one shape per job

- The contact update writes the whole item as one conditional `Put`, plus the reservation move when the mailbox changes. The field-wise `SET`/`REMOVE` builder and the second write path go. Two concurrent edits to different fields of one contact end last-writer-wins, as draft edits already do.
- `renameList` is one `updateIf` with `ReturnValues: "ALL_NEW"`. The pre-read and the `updateRecord` primitive go.
- Enqueue, schedule and resume are one lifecycle write. Each keeps its own `operationId`, so a 503 body is unchanged.

### T3 — Storage fails with the contract's expected errors

- Store reads fail with `Schemas.NotFound` instead of returning `Option.none`. Conflicts fail with `EmailAlreadyUsed` or `AddressOptedOut` at the condition slot that detects them.
- The domain functions that only translate go: contacts `get`, `list`, `getByEmail`, `update` and `remove`; lists `get`, `list`, `listMembers`, `rename`, `remove` and `removeContact`; `readControl`. The API handlers call the stores.
- Domain functions stay where they add something: minting identifiers and timestamps, and the campaign lifecycle.
- Storage builds the list page's exact-optional `nextCursor` once.
- The dispatcher and the preview page handle a missing entity with `catchTag("NotFound", …)`.
- ADR-0008 is amended.

### T4 — The send path: one outcome, one admission service

- `Mailer.send` returns `accepted | rejected | uncertain` as a value. `RecipientSettlement`, `outcomeOf`, both `Effect.result` wraps and the exported `SubmissionUncertain` go.
- `SendGuard` is the one admission service. It answers `{ limit, refusal? }` and owns the pacing slot (`slot(limit)`), so senders no longer need `RateLimiter` or `SendPacingLive`. Both senders map the refusal the same way.
- Small trims:
  - `Campaigns.create` spreads the decoded payload;
  - the two unused scheduled-token checks go;
  - `PreviewSender` is derived from `senderSettings`.

### T5 — Outdated schedules delete themselves

- `CampaignSchedule.remove`, its `DeleteSchedule` binding and grant, and every `schedules.remove` in `send`, `schedule` and `cancel` go. So do the post-create recheck and cancel's cleanup retries.
- Generation-named schedules and run-token retention stay.
- ADR-0015 and ADR-0016 are amended.

### T6 — Feedback through SQS, recovered by native redrive

- SES events reach a `FeedbackEvents` queue through a named default-bus rule, with a queue policy for that rule's ARN. `AWS.EventBridge.events(...).toQueue(...)` was the first choice, but its policy waits on the rule's ARN while the rule waits on the queue, a cycle Alchemy beta.79 cannot create on a fresh stage (the first live deploy stopped with `UnsatisfiedResourceCycle`). The feedback Lambda consumes the queue with `consumeQueueMessages` at batch size 1. Its redrive policy dead-letters into `FeedbackFailures` after five receives.
- Deleted:
  - `ReplayFeedback.ts` and its test;
  - the `feedback:replay` script;
  - the event-invoke `OnFailure` destination and its unused `SendMessage` grant;
  - the `FeedbackDestinationDeliveryFailures` alarm;
  - the two stack outputs.
- The feedback summary log line carries the classification instead of re-derived counters.
- ADR-0003 is amended, with clerical fixes to ADR-0008 and ADR-0012. The README runbook uses the same redrive command as the dispatcher.
- **Before the next prod deploy:** prod's `FeedbackFailures` queue must be empty. The old failure records cannot be redriven by the new path.

### T7 — Contract and services

- `Api.ts` declares the errors every endpoint shares once, and applies `Authorization` once, to the whole API.
- The `Schema.refine` calls that narrow nothing become `Schema.makeFilter` checks. One rule rejects duplicate addresses for both the import and test-send payloads.
- Services whose shape their `make` already states are declared with `Context.Service`'s `make` form: `AccountSuppression`, `SendGuard`, `CampaignSchedule`, `Mailer` and `CampaignWake`. This applies only if lint accepts the inferred types; it is all five or none.

### T8 — Tooling

- The vitest options that are defaults or dead go.
- The lint options move into `oxlint.config.ts`, and the scripts no longer repeat them. `hookTimeout` stays where `@effect/vitest` layers need it.
- ADR-0021's wording follows.

### T9 — Tests on `@effect/vitest`, consolidated

- `it.effect`, `it.live` and `layer(...)` replace the hand-written `Effect.runPromise` wrappers, and `onTestClock` goes.
- Consolidations that keep every behaviour covered:
  - table-driven guard, breaker, condition-failure and rejection cases;
  - shared seed fixtures and one SES request fixture;
  - one recorder in `scriptedTable`;
  - suite-level timeouts in the CLI tests;
  - Effect `FileSystem` temp files and `Stream` text collection in the CLI harness;
  - the SDK's own paging in the integration support.
- Deleted:
  - negative assertions that repeat an exact match;
  - the reserved-name sweep repeated per case;
  - unsubscribe forgery rows `SignedToken.test.ts` already covers (its two unique rows move there);
  - the duplicate `Api.test.ts` credential case;
  - the handler echo cases the classifier tests already pin;
  - the duplicate CLI diagnostics case;
  - the synchronous schema checks wrapped in effects.

### T10 — Docs, live gate, handoff

- The README and ADRs describe the result.
- The live integration suite passes on an ephemeral `--stage test` deploy, and the stage is destroyed.

## Final acceptance

- `pnpm check` passes.
- The live suite passes on the ephemeral stage.
- The leak check is clean on the branch and the PR body.
- Every item above is done, or its removal is recorded here with the reason.

## Handoff

(Filled in on completion.)
