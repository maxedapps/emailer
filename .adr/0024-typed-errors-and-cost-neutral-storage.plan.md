# Plan: Typed errors, one item codec and cost-neutral storage

- Status: In progress
- Decision: [ADR-0024](0024-typed-errors-and-cost-neutral-storage.md)

## Goal

**Done when:**

- every failure has its own error class, classified once where it happens;
- each endpoint declares exactly the errors it can return;
- `ErrorReporter` does all failure reporting, and no cause reaches a log;
- stored items are read and written through one codec;
- conditional writes fail with typed errors;
- one address item per mailbox replaces three rows;
- retries are Schedules;
- delivery-delay events are no longer subscribed;
- the live gate passes, and prod runs the result.

**Out of scope, deliberately unchanged:**

- the listing index;
- the `LISTOF#` reverse rows and both cascades;
- the sequential dispatcher;
- the counters on the campaign item, the claim/settle transactions and the rate-limit item;
- the feedback queue;
- the per-operation capability split;
- the two public pages and the alarm declarations;
- `check:imports` and the vendored lint rules;
- the cold-start config checks;
- the CLI's error rendering, apart from the new error names.

## Rules for every task

- One commit per task, with `pnpm check` green.
- The task removes more source lines than it adds, and its commit body lists what it deleted. The one-off migration script is the exception: T6 adds it, and T11 deletes it.
- The task states its running-cost effect. A task that would raise cost does not ship.
- New helpers support only what the code uses today: no options, no extra attribute kinds, no extra write actions.
- knip reports nothing left over.

## Tasks

### T1 — Repository hygiene

Status: Done

- **`CLAUDE.md`** is a symlink to `AGENTS.md`. It already was one, so nothing changed.
- **`.adr/work/`** is deleted: 83 finished plans and reviews, in git history.
  - The 74 links into it from 22 ADRs become plain text that names the plan, for example: "the cleanup plan (`work/codebase-cleanup.md`, in git history)".
  - No repository URLs are added.
- **`lambdaBasics` (`apps/backend/src/Lambda.ts`)** gets one comment saying that `EMAILER_LOG_GROUP` exists only so each function's log group is created before the function.

**Verify:**

- `git grep "](work/" .adr` finds nothing;
- `readlink CLAUDE.md` prints `AGENTS.md`;
- `pnpm check` passes.

**Cost:** none.

### T2 — Error model and reporting

Status: Done. As built:

- Only `SliceOverrun` carries a severity (`Warn`). The reporter logs every other failure that reaches it at `Error`, so the dependency errors need no severity annotation.
- The HTTP boundary answers what Effect's own boundary answers (`causeResponse`): a router's 404 for an unknown path, 499 for a client abort, an empty 500 otherwise.
- An authenticated request the API cannot decode is logged once, by its tag (`HttpApiSchemaError`). Authorization runs before decoding, so unauthenticated requests log nothing. Today's code logged the same case through Alchemy's boundary, with the schema issue.
- The task adds 154 production lines net: sixteen error classes and exact per-endpoint declarations. The deletions come in T3–T5.

- **`packages/api/src/Errors.ts`** holds every public error. They move out of `Schemas.ts`, along with `Unauthorized` from `Api.ts`.
  - Business errors carry `[ErrorReporter.ignore] = true`:
    - `ContactNotFound`, `ListNotFound` and `CampaignNotFound` (404), replacing `NotFound{entity}`;
    - `EmailAlreadyUsed`, `AddressOptedOut`, `CampaignStateConflict`, `SendAtNotInFuture` and `TestAudienceTooLarge` (409);
    - `SendingPaused` (503) and `Unauthorized` (401).
  - Dependency errors (503) have the fields `{ operation, failure }`, severity `Error`, and those two fields as reporter attributes:
    - `StorageUnavailable`;
    - `EmailServiceUnavailable`;
    - `QueueUnavailable`;
    - `SchedulerUnavailable`;
    - `AlarmsUnavailable`.
- **Classified once where they happen,** with `failure` taken from `describeCause`:

  | Where | Error |
  |---|---|
  | Storage primitives, including timeouts | `StorageUnavailable` |
  | Rate-limit pacing (`SendGuard.makeSlot`) | `StorageUnavailable` (`operation: "pacing"`) |
  | SES suppression calls (`audience/Addresses.ts`), including an unrecognised reason | `EmailServiceUnavailable` |
  | `GetAccount` (`SendGuard.ts`) | `EmailServiceUnavailable` |
  | `DescribeAlarms` (`SendGuard.ts`) | `AlarmsUnavailable` |
  | Enqueue (`sending/Dispatch.ts`) | `QueueUnavailable` |
  | Schedule creation (`campaigns/CampaignSchedule.ts`) | `SchedulerUnavailable` |

  A stored item that fails to decode dies with the internal defect `CorruptItem{operation}`, which is reported without the item's values.
- **`SendGuard.ts`** imports the SDK's `GetAccount` and `DescribeAlarms` response types instead of redefining them (`SendQuota`, `AccountStatus`, `AlarmStates`).
- **The store reads** fail with the three new `NotFound` classes.
- **The contract:**
  - each endpoint declares exactly its errors, from small shared lists per group of dependencies (for example storage only; storage plus queue);
  - the dispatcher's and the preview page's `catchTag("NotFound", …)` become the specific classes.
- **`apps/backend/src/Reporting.ts`** replaces `Diagnostics.ts`:
  - the reporter logs one structured line (tag, severity, declared attributes), and never an error's message or cause;
  - one HTTP boundary reports a cause and answers an empty 500;
  - one consumer boundary reports a cause and dies with a fixed `InvocationFailed`;
  - each Lambda's service layer provides the reporter.

  The boundaries wrap the API's handler, the unsubscribe and preview routers, and the dispatcher and feedback consumers. Their shape was proven by an experiment in the review session.
- **Deleted:**
  - `storage/Errors.ts` (`StorageFailure`, `unavailable`, `corrupt`);
  - `Diagnostics.ts` and its test (`publicly`, `reportedAndFatal`, `reportStorageFailure`); `describeCause` moves to the backend's error module;
  - the 28 `publicly(...)` wraps in `api/Api.ts`;
  - `failureOf` in `storage/Testing.ts`;
  - `NotFound`.
- **The CLI's tests** switch to the new error names. Its production code does not reference them.

**Verify:**

- `Reporting.test.ts`:
  - a defect whose message holds an address answers 500, and no reported or logged line contains the address;
  - a business error is not reported;
  - each dependency error is reported with its operation and failure.
- `api/Api.test.ts`: one mapping case per dependency error, each answering 503 with its tag.
- `pnpm check` passes.

**Cost:** none. One report per failure, as today, and business errors stay unlogged.

### T3 — API handlers and the contract

Status: Done. As built:

- The preview link reads the campaign's control item instead of the whole campaign, since it only needs to know the campaign exists: one read unit instead of two or more.
- `Api.test.ts` (2,410 → 1,040 lines) stubs every service per test, and a service a test does not name dies if reached. The in-memory copy of the stores is gone.
- `audience/Addresses.test.ts` takes over the address status and unsuppress cases, which only the API suite covered.
- `Schemas.test.ts` takes over the test-send payload's limits.

- **Handlers get their services up front,** as in Effect's reference service.
  - Pattern: `HttpApiBuilder.group(EmailerApi, "contacts", Effect.fn(function* (handlers) { const audience = yield* AudienceStore; … }))`.
  - `makeApiHandler` builds the API layer with `ApiLive` once per instance.
  - The `AudienceStore.use(...)` / `CampaignStore.use(...)` pattern and its explanatory comment go.
- **Drop the hand-written 413 check:**
  - `oversizedBody` and `tooLarge` (`api/Api.ts`);
  - `PayloadTooLarge` and `maxRequestBytes` (`packages/api/src/Schemas.ts`);
  - the 8 endpoint declarations and their tests.

  `utf8ByteLength` stays, because the field limits use it.
- **Reshape `api/Api.test.ts` (2,212 lines):**
  - stub layers replace `provideContext`;
  - keep, per endpoint, the contract round trip, the routing and auth cases (401 with `www-authenticate`) and one mapping case per error;
  - a behaviour assertion that no storage or domain test covers moves into that test instead of being deleted.

**Verify:**

- every endpoint still has a round-trip case;
- an oversized `text` answers 400;
- `pnpm check` passes.

**Cost:** none.

### T4 — Item codec and the campaign record by state

Status: Done except the prod decode scan, which waits for the user's go-ahead. As built:

- `itemReader(record)` and `itemWriter(record)` take the contract schema as it is. The codec checks the version when it reads and stamps it when it writes, so no record declares `v`.
- There is no `values()`. The codec is effectful, because the lint rules forbid synchronous schema calls, and building every expression through it would make every request builder effectful. Expression values keep `str`, `num`, `strMap` and `strSet`.
- Reading decodes every attribute on the item. An attribute of a kind the table never stores (a boolean, a list, a binary value) makes the item corrupt.
- The address rows and the helpers only they use stay until T6, so this task adds 70 production lines for now.
- The rate-limit claims return `ALL_NEW` (free) instead of `UPDATED_NEW`, so the window decodes with its version.
- Send rows are written through the codec but never read. The prod scan decodes only the items the code reads.

- **`storage/Items.ts`** gets the generic codec:
  - DynamoDB attribute values ⇄ plain values, for strings, numbers, string maps and string sets only;
  - `item(record)` decodes only the record's declared attributes and refuses to encode an empty set;
  - `values({...})` encodes expression values;
  - the key and index helpers stay.
- **Records** are the contract schema plus `v`. They cover contacts, reservations, lists, member rows, campaign bodies, send rows, feedback history and the rate-limit window.
- **The campaign record** becomes a union by state:
  - `draft` may still carry `runToken` and the run baselines, because cancel keeps them;
  - `scheduled` and `queued` carry `runToken`;
  - `sending`, `paused` and `completed` carry what the submission shows.
- **Every read and write** goes through the codec. A decode failure is `CorruptItem`. The address rows are left to T6.
- **Deleted:**
  - the mirror decode schemas;
  - `attributeOf`, `StringAttribute`, `NumberAttribute`, `StringMapAttribute` and `StoredVersionAttribute`;
  - `contactItem`, `bodyItem`, `withOptional` and `strMap`, and most `str`/`num`;
  - `submissionOf` with its re-decode through the contract schema;
  - `requireRunToken`.

**Verify:**

- **Unit tests:**
  - a round trip per record;
  - a wrong attribute kind dies as `CorruptItem`;
  - key and index attributes are ignored on decode;
  - an empty set is refused.
- **The storage suites' exact assertions on written items stay unchanged.** That proves the items, and so their write units, are identical.
- **Before merging, and with the user's go-ahead,** a read-only scratch script (not committed) decodes every item in prod's table with the new records, with zero failures. That is one scan, costing cents.

**Cost:** identical items, identical units.

### T5 — Typed conditional writes

Status: Done. As built:

- A refusal returns its error as an effect, so it can decode the item it was given. A tagged error is itself such an effect, so a simple refusal is still `() => new ListNotFound()`.
- `ContactChanged` also covers `deleteContact`'s final condition and an import that raced a contact change: all three retry twice from a fresh read, then answer 409. `contacts.remove` and `lists.import` declare it too.
- `addMember` joins both directions with the same idempotent update as an import, so adding a member twice is no longer a cancelled transaction. The billed write units are the same.
- `transact` keeps one cast, on its actions array: it narrows the array to the union of the errors its actions declare.

- **Primitives:**
  - `transact(operation, actions)` supports only Put, Update, Delete and ConditionCheck. Each action may declare `refused: (current) => E`.
  - `updateIf(operation, request, refused)` works the same way for single-item updates.
  - A refusal that needs the stored item sets `ReturnValuesOnConditionCheckFailure: "ALL_OLD"`.
  - The first refused action in declaration order decides. A failed condition without a refusal is a defect.
  - The conflict retry is unchanged.
- **The slot-index reads and string results become typed errors:**
  - **`RunSuperseded`** comes from `beginRun`, the campaign check in `claimRecipient`, `skipRecipient`, `checkpoint`, `completeRun` and `pauseRun`. `runSlice` catches it once and logs "stale wake discarded". An already-claimed recipient stays a value.
  - **`SettlementNotApplied`** comes from `settleRecipient`. The dispatcher logs a warning and continues; today the result is ignored.
  - **`CampaignChanged{current}`** comes from `newRun` and `cancelCampaign`.
    - `send`, `resume` and `schedule` return the current campaign.
    - `cancel` decides from `current` and no longer reads again. `cancellationReachedDestination` stays as a pure check.
  - **`updateDraft` / `deleteDraft`** fail with `CampaignStateConflict{state}` or `CampaignNotFound` from the returned item. `draftConflict` goes.
  - **`updateContact`** fails with `ContactChanged`. The update retries twice with a Schedule, then answers the new public 409 `ContactChanged`, declared on the endpoint.
  - **`recordFeedback`** fails with `FeedbackAlreadyRecorded` or `CampaignNotFound`. The consumer logs them at debug and warning level.
  - **`addMember`** answers `void`.
  - **Impossible condition failures,** such as an identifier collision in `createContact`, are defects.
- **Deleted:**
  - `TransactionOutcome` and `UpdateIfResult`;
  - every `conditionFailures.has(n)` read;
  - the string results.

**Verify:**

- **Unit tests:**
  - refusal selection: declaration order decides;
  - a missing refusal is a defect;
  - the returned item reaches the refusal.
- **Storage suites:** the 32 scripted cancellations assert typed errors.
- **Dispatcher suites:**
  - every stale path ends the slice through `RunSuperseded`;
  - an unapplied settle logs and continues.
- **Cancel:** a conflict no longer reads the campaign's control state again. The response still reads the campaign once.

**Cost:** the returned item consumes no read capacity (AWS `UpdateItem` reference). The re-reads on conflict paths go, and the contact retry replaces a manual CLI re-run.

### T6 — One address item per mailbox

Status: Done except the rehearsal, which is T10's. As built:

- Every write is an update that may be the item's first, so each also sets `v = if_not_exists(v, :v), email = if_not_exists(email, :email)`. `updatePrimitives` gains an unconditional `update` for the unsubscribe and suppression writes.
- The status reads `unsubscribedAt` and `suppression` by presence only; `addresses status` still decodes them in full.
- `unsuppress` clears only what the item holds; a mailbox with no item is left without one.
- The migration reads each old row strictly, so a row it cannot read stops it before anything is merged. `--verify` re-reads every address item strongly consistently, and `--delete-old` verifies again in the same run before it deletes.
- After the deploy, the second pass waits until invocations of the old code have drained: at least the dispatcher's five-minute timeout.
- The now unused `writePrimitives` export goes; `recordOnce` stays for campaign and list creation.

- **The item:** `ADDRESS#<mailbox>` / `ADDRESS` holds `{ v, email, unsubscribedAt?, suppression?, transientBounces? }`. `suppression` is the current suppression fields as a string map; `transientBounces` is a string set.
- **Writes:**

  | Write | Expression |
  |---|---|
  | Unsubscribe | `SET unsubscribedAt = if_not_exists(unsubscribedAt, :at)` |
  | Suppression | `SET suppression = if_not_exists(suppression, :s)` |
  | Transient bounce | `ADD transientBounces`, inside the existing feedback transaction |
  | `unsuppress` | `REMOVE suppression, transientBounces`, conditioned on the item existing |

- **Reads:**
  - the status is one strongly consistent GetItem;
  - an opt-out or suppression counts by presence, so a malformed one still blocks mail, as today;
  - only the transient window is decoded.
- **The opt-out check in `updateContact`** becomes `attribute_not_exists(unsubscribedAt)` on the old address's item.
- **Bindings:**
  - `UnsubscribeStore` binds `UpdateItem` instead of `PutItem`;
  - `FeedbackStore` binds `UpdateItem` and `TransactWriteItems`, and drops `PutItem`.
- **`apps/backend/scripts/MigrateAddressItems.ts`** handles the one-off migration. It is a knip entry while it exists.
  - It reads `EMAILER_TABLE_NAME`.
  - It pages a scan for `UNSUBSCRIBE#` and `SUPPRESSION#` rows and merges each mailbox into its address item with `if_not_exists`. It never overwrites newer data and is safe to repeat.
  - It prints counts.
  - `--verify` compares old and new per mailbox.
  - `--delete-old` removes the old rows, and only after a clean verify.
  - The merge logic is a pure function with its own unit test.
  - The order at a switch closes the gap between old and new code:
    1. run it before the deploy;
    2. run it again once the old code's invocations have drained;
    3. `--verify`;
    4. `--delete-old`.

    Anything old code wrote between the two runs is merged by the second.
- **Deleted:**
  - `unsubscribeKey`, `suppressionKey` and `transientKey`;
  - the three stored schemas;
  - `loadAddressItems`' map by sort key;
  - the three-key batch read.

**Verify:**

- status for each combination of opt-out, suppression and transient window;
- `unsuppress` on an existing and on a missing item;
- the opt-out condition in `updateContact`;
- the merge function;
- the rehearsal in T10.

**Cost:**

- the status check drops from 3 read units to 1 per recipient;
- `unsuppress` drops from 4 write units to 1;
- writes otherwise stay 1 unit while the item is under 1 KB (bouncing addresses stop receiving mail, which bounds the window);
- the migration is one scan, costing cents.

### T7 — Send errors and retries as Schedules

Status: Done. As built:

- **The retry budget is not `upTo({ duration })`.** `upTo` compares only the elapsed time at a step with the limit, so the step at about 3.8 s still granted a further 4 s wait, and a persistent 500 ended as `TimeoutError`; the transport test showed it. The policy instead stops when the next delay would end past 4 s: `Schedule.while(({ elapsed, duration }) => elapsed + duration <= 4 s)`. That also gives up at once on a server retry-after hint longer than the budget.
- The retry layer and `ReportingLive` are one `FunctionServicesLive` in `Lambda.ts`, which every function provides to each invocation; the client reads the policy from the calling fiber, so no binding layer needs it.
- The mailer logs why an outcome is unknown where it classifies it, as before; `SubmissionUncertain` carries only the reason.
- `accepted` and the `failureOutcomes` handlers map a send to what a send row or a test report records; the dispatcher and test sends share them. A handler object rather than one function, because `Effect.catchTags` cannot be typed over a generic error channel, and the dispatcher's attempt can also fail with the pacing slot's `StorageUnavailable`.
- The throttle schedule reads the error with `Predicate.isTagged`, so it needs no input type.

- **`Mailer.send`** answers the message ID, or fails with one of:
  - `SendRejected{code}`;
  - `SendThrottled`;
  - `SendingSuspended`;
  - `SubmissionUncertain{reason}`.

  It keeps `Retry.none`.
- **Dispatcher.** One attempt reserves its pacing slot, sleeps and sends. On the first attempt the slot is the one already checked against the time budget (`Schedule.CurrentMetadata.attempt === 0`). The attempt retries while `SendThrottled`:

  ```ts
  Schedule.exponential("1 second").pipe(
    Schedule.upTo({ times: 3 }),
    Schedule.while(({ input }) => input._tag === "SendThrottled"),
  )
  ```

  - `catchTags` produces the settlement values. The recorded `RejectionCode`s are unchanged: suspended is `"sending-paused"`, throttled is `"rate-limited"`.
  - Still throttled after the retries, or suspended, pauses the run with that reason.
  - `rateLimitedBackoffs` and the attempt loop go.
- **Test sends** make one attempt and map each error to its outcome.
- **BatchGetItem's unprocessed keys** fail with `UnprocessedKeys` and retry with `Schedule.exponential("100 millis")`, jittered, `upTo({ times: 3 })`. The hand-written loop and its jitter maths go; the operation deadline stays.
- **One AWS retry layer** provides the client's `Retry` policy.
  - It is built from the client's own default factory (`Retry.makeDefault`), which honours server retry-after hints and waits at least 500 ms after a throttle.
  - Its schedule is only capped with `Schedule.upTo({ duration: "4 seconds" })`, so it ends inside the 5 s operation timeout.
  - It goes in every Lambda's services, and the mailer overrides it with `Retry.none`.
  - This wiring is untested; the transport test below verifies it.

**Verify:**

- **Test-clock unit test:**
  - the order is send, back off 1 s, reserve, send;
  - the run pauses as `rate-limited` after the third retry;
  - a suspension pauses at once.
- **Test sends** map each error.
- **Transport test (`storage/Primitives.transport.test.ts`):**
  - a persistent 500 is retried within the budget and fails with the SDK's error, not `TimeoutError`;
  - the existing same-token case still passes.

**Cost:** the send and batch retries make the same calls at the same times. The capped client policy makes at most as many attempts as today's 5 s timeout allows.

### T8 — Stop subscribing to delivery delays

Status: Not started

- **Remove:**
  - `DELIVERY_DELAY` from `feedbackPublishing`'s `matchingEventTypes` (`sending/Mailer.ts`);
  - `"Email Delivery Delayed"` from the rule (`feedback/Feedback.ts`);
  - the `DeliveryDelay` variant and `ClassifiedDelay` (`feedback/FeedbackClassification.ts`);
  - the delay branch in `record`;
  - their tests.

**Verify:**

- `pnpm check` passes;
- on the T10 stage, the deploy plan changes only the event destination and the rule.

**Cost:** lower, with no SQS requests, invocations or log lines per delay.

### T9 — Docs and ADRs

Status: Not started

- **README:**
  - the error names in "What commands print" and "Behavior": 404 per entity, 503 per dependency, 409 `ContactChanged`, 400 for an oversized body;
  - the address migration in the deploy notes.
- **ADRs:**
  - ADR-0004, ADR-0006, ADR-0007, ADR-0008, ADR-0012, ADR-0013 and ADR-0020 get "Superseded in part by ADR-0024" lines, naming the parts ADR-0024 lists;
  - ADR-0024 becomes Accepted with the user's approval.

**Verify:**

- every relative link in `.adr/` and the README resolves;
- the leak check against `~/.config/emailer/leak-pattern.txt` is clean on the branch.

### T10 — Live gate

Status: Not started

- **Migration rehearsal:**
  - deploy an ephemeral stage from `main`;
  - opt out a labelled simulator address through its link, and suppress one with a bounce-simulator test send;
  - seed one transient row in the old shape directly in the table;
  - run the migration from the branch;
  - deploy the branch to the same stage with `--force`;
  - run the migration again, then `--verify`, then `--delete-old`;
  - `addresses status` shows the same three states, and a campaign skips those addresses.
- **Full suite:** the live suite passes on the branch deployment.
- **Manual privacy check:**
  - write a corrupt contact whose `email` holds a marker address;
  - `GET /contacts/:id` answers 500;
  - CloudWatch holds the reporter's line and no marker.
- **Teardown:** destroy the stage; the inventory shows no leftovers.

### T11 — Prod rollout (after merge, with the user's go-ahead)

Status: Not started

- **Preconditions:**
  - no campaign is `sending`, `queued` or `scheduled`;
  - no API use during the switch: no test sends and no contact updates;
  - `FeedbackFailures` and `DispatchFailures` are empty.
- **Migrate first:** run the migration against prod.
- **Deploy** with `--force`, and confirm every function's `CodeSha256` changed.
- **Migrate again:** run the migration, then `--verify`, then `--delete-old`. Spot-check `addresses status` for a known opted-out and a known suppressed address.
- **Clean up:** delete the migration script and its knip entry in a follow-up commit.

## Open questions

None. The user approved ADR-0024 and this plan on 2026-09-24.
