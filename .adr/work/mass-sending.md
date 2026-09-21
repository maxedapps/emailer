# Mass sending: open recipient set and paced dispatch

> **Status:** Complete
> **ADRs:** [0011 — Open recipient set with a paced, resumable dispatcher](../0011-open-recipient-set-and-paced-dispatch.md) (Accepted); supersedes parts of [0001](../0001-resource-owning-effect-services.md), [0002](../0002-domain-sending-identity.md), [0004](../0004-sender-owned-one-click-unsubscribe.md), [0005](../0005-contact-identity-and-membership-access-paths.md), [0008](../0008-storage-capabilities-and-error-boundaries.md)
> **Updated:** 2026-09-15
> **Lane:** independent of the deliverability lane. Own worktree, own Emailer stage name `test-b`. Does not touch `stacks/sending-identity.ts`, the ADR-0009/0010 bodies, or `wiki/aws/deliverability.md`. See Merge notes for the four shared files.
> **Worktree:** `~/worktrees/emailer/mass-sending` on branch `mass-sending`, forked from `main` at `cb73c3a`

## Outcome and boundaries

- **Problem and target:** A campaign is refused unless its list has exactly one allowlisted member, and the send runs synchronously inside one API request. **Target:** a campaign to a list of any size is accepted immediately, worked through by a dispatcher Lambda one page per invocation, paced against the account's real SES send rate through a store shared by every runner of the stage, recorded per recipient, and observable as progress counters. The allowlist is gone; tests send only to labelled SES simulator addresses.
- **In scope:**
  - Campaign contract: states `draft`, `queued`, `sending`, `paused`, `completed`, progress counters, a `resume` endpoint and CLI command
  - Storage: per-recipient rows as the unit of work, conditional transitions on state and run token, cursor checkpoints, a DynamoDB `RateLimiterStore`
  - A dispatcher Lambda on a standard SQS queue with a dead-letter queue and alarm; one member page per invocation, continuation by message
  - Pacing through Effect's `RateLimiter` with the limit read from `GetAccount`, a daily budget pause, throttle backoff and pause
  - Allowlist removal everywhere: code, tests, `.env.example`, README
  - Integration suite on labelled simulator addresses with a test-side simulator guard, a live gate on stage `test-b`, ADR-0011, ADR supersession notes, README and wiki
- **Out of scope:**
  - HTML bodies, templates, personalisation, segmentation
  - Snapshotting the audience; list-version conflicts
  - Feedback counts in `campaigns get` and transient-bounce escalation (both moved to the reputation lane, decided by the user on 2026-09-15)
  - Automatic un-suppression, resubscribe, double opt-in
  - Reputation alarms and a notification channel (separate lane), automatic sending pause
  - Reconciling rows claimed by a crashed slice (accepted residual, see ADR-0011)
  - Bulk SES APIs (`SendBulkEmail` is template-only)
  - Concurrency caps on the dispatcher; `RateLimiter` token-bucket or adaptive modes
  - Real recipients: none until this lane and the deliverability lane are both merged
- **Approach:** Keep the storage model and reuse what already fits: the per-recipient `SEND#` row with its absence condition, the per-address consent and suppression reads, the paginating member listing. Replace the synchronous single-recipient send with a `queued` transition plus one wake-up message; a dispatcher owns the loop, processes exactly one page of members per invocation, and continues by enqueuing the same wake-up after a won checkpoint. Every dispatcher write is conditional, so at-least-once delivery is harmless and a duplicate runner stops at its first failed checkpoint. Pacing is one limiter `consume` before every submission against a store item in the stage's table.

```text
CLI ── POST /campaigns/:id/send ── API: draft→queued (+runToken) ── SQS "Dispatch" {campaignId, runToken}
                                                                          │
   Dispatcher (batch 1, 5 min): beginRun (returns META) ── GetAccount (limit, daily budget) ── one page of members (50)
      per member: addressStatus → skip row | claim row → limiter consume + sleep → SendEmail → settle row + ADD counter
      end of page: checkpoint(prev → next, conditional) ── won: enqueue continuation | completeRun ── lost: return
```

## Key files, evidence, and decisions

| File or source                                                                                                   | Why it matters                                                                                                                                                          | Decision or plan impact                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src/Campaigns.ts:52-183`                                                                           | The synchronous send: probe, guards, allowlist (`:97-99`), claim, submit, finalize                                                                                      | T6 reduces `send` to a `queued` transition plus one `SendMessage`; the loop moves to the dispatcher                                                       |
| `apps/backend/src/Storage/Campaigns.ts:33-56, 141-257, 262-306`                                                  | META and `SEND#` shapes; claim (`#state = :draft`, membership check) and finalize transactions; the store deliberately lacks `UpdateItem`                               | T2 rewrites the model and transitions; `CampaignStoreLive` gains `UpdateItem`                                                                             |
| `apps/backend/src/Storage/Membership.ts:26, 213-271, 580-609`                                                    | `listMembers` pages by contact id with a `MEMBER#` cursor built from any contact id, hydrates via `BatchGetItem`; `readAudience` is a two-member probe                  | The dispatcher reads `listMembers(listId, 50, cursor)`; the probe and `audienceProbeLimit` are deleted                                                    |
| `apps/backend/src/Storage/Primitives.ts:87-93, 100-117, 306-341`                                                 | `recordOnce` swallows a condition failure; `updateRecord` discards output and maps a condition failure to `unavailable`; `runTransaction` reports `conditionFailures`   | T2 adds `updateIf`, a conditional `UpdateItem` returning `updated                                                                                         | condition-failed`, with `ReturnValues` honoured |
| DynamoDB reserved words                                                                                          | `COUNT`, `STATE`, `CURSOR`, `TEXT` are reserved; the unit table double evaluates no expressions, so a bare reserved word is invisible until the first live request      | Every expression aliases `#count`, `#state`, `#cursor`; T2's tests assert no bare reserved word in any recorded expression                                |
| `apps/backend/src/Storage/Addresses.ts:95-105`; `Storage/Feedback.ts:32-40, 167-187`                             | `addressStatus` is two `GetItem`s; `FeedbackStore` holds `PutItem` only                                                                                                 | Per-recipient skip check as is; no new feedback writes in this lane                                                                                       |
| `apps/backend/src/Feedback.ts:38, 89-106, 224-252`                                                               | Bounce/complaint classification (`Permanent` suppresses, transient records only); the inline Function form with `consumeEmailEvents` and `SendMessage` grant            | T5 mirrors the function shape                                                                                                                             |
| `apps/backend/src/Mailer.ts:17, 37-47, 53, 72-75, 101, 153, 185, 189`                                            | `submissionTimeout` 8 s; `rate-limited` and `sending-paused` codes; the allowlist field and config; `Retry.none`; `MailerLive` grants `ses:SendEmail`                   | T6 deletes the allowlist and removes `MailerLive` from the API; the dispatcher treats `rate-limited` with backoff then pause, `sending-paused` as a pause |
| `apps/backend/src/Api.ts:33, 72, 96-126, 162-186`                                                                | 60 s timeout, the `send` route, function props, the Layer merge including `MailerLive`                                                                                  | T6 adds the `SendMessage` binding and `resume` route and drops the mailer; the API role loses `ses:SendEmail`                                             |
| `node_modules/effect/src/unstable/persistence/RateLimiter.ts:97-167, 322-365, 618-627, 721-737, 1019-1047`       | Delay-mode arithmetic (`refillRate = window / limit`; delay until the token's window opens); `consume` returns the delay, `sleep` performs it; `fixedWindow` contract   | T3 implements `fixedWindow` to that contract; the dispatcher calls `consume` in delay mode, checks its budget, then sleeps itself                         |
| `node_modules/alchemy/src/AWS/SES/GetAccount.ts:27-36`; `@distilled.cloud/aws` `sesv2.d.ts:865-869, 927-937`     | `GetAccount()` binding, IAM `ses:GetAccount` on `*`; `SendQuota { Max24HourSend?, MaxSendRate?, SentLast24Hours? }`, all optional                                       | T3 reads the quota per run; `MaxSendRate` undefined → limit 1; `Max24HourSend` undefined → no daily pause                                                 |
| `node_modules/alchemy/src/AWS/SQS/QueueEventSource.ts:54-73, 113-126`; `AWS/Lambda/QueueEventSource.ts:44-81`    | `consumeQueueMessages(queue, { batchSize }, process)`; `process` returns `Effect<void, never>` and runs under `orDie`; IAM receive/delete/get-attributes                | T5 uses batch size 1: any failure, including a failed continuation `SendMessage`, dies and redelivers the one message                                     |
| `node_modules/alchemy/src/AWS/SQS/Queue.ts:57-85`; `SQS/BindingHttp.ts:43-71`; `Resource.ts:370-395`             | `visibilityTimeout`, `redrivePolicy`; `SendMessage` injects the bound `QueueUrl`; a module-level resource re-yielded across modules registers once                      | Queues live in a handler-free leaf module imported by both the API and the dispatcher                                                                     |
| `node_modules/alchemy/src/AWS/Lambda/Function.ts:78-81, 262-268, 1045-1062`                                      | `HandlerContext` exposes the Lambda context per invocation; `timeout` is a `Duration`, capped by AWS at 15 min                                                          | T5 uses the Effect `Clock` plus the configured timeout for its deadline (testable with `TestClock`)                                                       |
| `.adr/0004-sender-owned-one-click-unsubscribe.md:47`                                                             | Importing a module whose default export is an inline Function class pulls its handler into the importer's bundle                                                        | `Dispatch.ts` (queues, message schema) is a leaf; `Dispatcher.ts` holds the handler                                                                       |
| `.adr/0008-storage-capabilities-and-error-boundaries.md:15-26`                                                   | One service per cohesive capability; each live Layer constructs only its bindings                                                                                       | `RateLimitStore` is a fifth capability with one `UpdateItem` binding; `CampaignStore` gains `UpdateItem`; the API no longer constructs the mailer         |
| `apps/backend/test/IntegrationSupport.ts:38-45, 150-186, 195-207, 217`; `apps/backend/src/*.integration.test.ts` | The suite reads a deployed stage from env, picks simulator addresses from the allowlist, reuses contacts, polls address status, mints `@example.invalid` probes         | T9 replaces the allowlist helpers with labelled simulator addresses, a simulator guard before every send, and `awaitCampaignState`                        |
| `apps/backend/src/Campaigns.test.ts:55-330`; `Storage/Testing.ts:55-119`                                         | World/hook fixtures with a recording mailer double; `scriptedTable` replies by call order and records every request                                                     | Unit tests for T2, T3, T5 follow these patterns                                                                                                           |
| `wiki/aws/dynamodb-outbox.md:7-9, 27, 31-35, 51-57`; `wiki/aws/sqs.md:35-40, 62`                                 | Outbox gap and wake-up semantics; 100-action transactions; bounded pages with stable child ids; visibility ≥ 6× timeout; DLQ retention longer than source               | One transaction per recipient, never per page; `send` on `queued` re-sends the wake-up; visibility 30 min for a 5 min function                            |
| `README.md:3, 65, 80-81, 131-146, 164-166, 222, 231, 234-235, 246, 250-275`                                      | First-slice framing, what checks prove, CLI examples, output contract, allowlist guard, three Lambdas, once-per-stage feedback rule, teardown inventory, replay section | T10 rewrites each; the teardown sentence is also touched by the deliverability lane                                                                       |
| Memory `open-recipient-list-roadmap`, `rate-limiter-as-pacing-primitive`                                         | The user's decisions on the allowlist, simulator-only testing and the limiter                                                                                           | Baseline for ADR-0011                                                                                                                                     |

- **Open gate:** none. The account's send quota is read at run time by the dispatcher, so the plan does not depend on knowing it; the implementer reads it once before T9 to size the live gate's timing.

## Research

Decision-relevant results beyond the table:

- **Delay-mode limiter semantics.** `consume` with `onExceeded: "delay"` calls the store with `limit: undefined` and returns `{ delay, remaining, resetAfter }`, where the delay is the time until this token's window opens; `sleep` is `consume` plus `Effect.sleep`. Each token extends the item's `expiresAt` by one refill interval (`window / limit`), so `count` only accumulates while consumes arrive faster than that interval; a sequential sender at typical quotas resets the item on nearly every consume, which is correct and means the live limiter is rarely binding. With N concurrent runners each waits about `N / limit` seconds per token, so the budget check must include the delay the limiter just computed.
- **Store contract.** `fixedWindow`: if the item is absent or expired, start at `count = 0, expiresAt = now`; add `tokens` to `count` and `refill × tokens` to `expiresAt`; return `[count, expiresAt − now]`. DynamoDB cannot branch server-side, so the common path is one conditional `UpdateItem` (`attribute_not_exists(pk) OR #expiresAt > :now`, `SET #count = if_not_exists(#count, :zero) + :tokens, #expiresAt = if_not_exists(#expiresAt, :now) + :extend`, `ReturnValues: UPDATED_NEW`), and the reset after an idle gap is a second `UpdateItem` conditioned on `attribute_exists(pk) AND #expiresAt <= :now` (`SET #count = :tokens, #expiresAt = :nowPlusExtend`); if that also fails a peer moved first and the common path is retried, at most three calls in total. No failed-item decoding is needed. `extend = max(1, ceil(refillMs × tokens))` matches the Redis store's integer TTL.
- **Quota fields** are all optional. `SentLast24Hours` includes the other workload on the account and is the right input for the daily budget; `MaxSendRate` is per second. Simulator sends are rate-limited but do not count toward the daily quota, so the daily pause is unit-tested only.
- **The limiter item is per stage**, because the table is per stage. It coordinates every runner of one stage; two stages sending at volume in the same account each pace at their own 80 percent. Only one stage may send at volume per account (ADR-0011 Consequences).
- **Throttle under contention.** A `rate-limited` rejection provably never sent, but re-entering the limiter yields no meaningful delay for the runner that was throttled (the delay is relative to its own slot). Retries therefore back off explicitly (1 s, 2 s, 4 s) and exhaustion pauses the campaign with reason `rate-limited`, so a co-tenant's burst never silently rejects an audience.
- **Alchemy wiring.** The convenience consumer creates the mapping, grants receive/delete/get-attributes and runs `process` under `orDie`; `SendMessage` to the same queue from the same function is two grants on one ARN. `Config` reads inside a function constructor are deploy-time captures, which is what the daily ceiling wants. The Lambda context is available as `AWS.Lambda.HandlerContext`, superseding the first slice's note.
- **Stage isolation.** Every physical name carries the stage; `test-b` collides with nothing.
- **Simulator addresses** at `simulator.amazonses.com` accept `+label` variants for every kind, and are rate-limited and billed like real sends, so the live gate exercises the limiter for real.
- **Crashed slices.** A row claimed by an invocation that died before settling stays `unconfirmed`; nothing settles it later and the counters do not sum to the member count. Accepted residual: the rows show it, and one page per invocation keeps the exposure to one page.

## Tasks

#### T1 — Campaign contract

- **Change:**
  - In `packages/api/src/Schemas.ts`: add `CampaignProgress = { accepted, rejected, uncertain, skipped }` (non-negative integers) and `PauseReason = "sending-paused" | "daily-quota" | "rate-limited"`. Replace `CampaignSubmission` with the union `draft` · `queued { queuedAt }` · `sending { queuedAt, startedAt, progress }` · `paused { queuedAt, startedAt, progress, reason }` · `completed { queuedAt, startedAt, finishedAt, progress }`.
  - Delete `AudienceProblem`, `InvalidAudience`, `MembershipConflict`, `SendUnconfirmed`, `SendStatusUnrecorded`. `RejectionCode` keeps `rate-limited`.
  - In `packages/api/src/Api.ts`: `send` errors become `BadRequestNoContent, NotFound, StorageUnavailable`; add `POST /:id/resume` returning `Campaign` with the same errors. `resume` on a campaign that is not `paused` returns the campaign unchanged, as `send` does for states it cannot act on.
- **Starts at:** `packages/api/src/Schemas.ts:146-190, 320-383`, `packages/api/src/Api.ts:157-189`
- **Depends on:** none
- **Status:** Verified
- **Evidence:** `packages/api/src/Schemas.ts` has `CampaignProgress`, `PauseReason`, and the `draft|queued|sending|paused|completed` union; deleted `AudienceProblem`, `InvalidAudience`, `MembershipConflict`, `SendUnconfirmed`, `SendStatusUnrecorded`. `packages/api/src/Api.ts` `send` errors are `BadRequestNoContent, NotFound, StorageUnavailable`; `POST /:id/resume` added. Parent reran `pnpm exec vitest run --project unit packages/api` — 77 passed.
- **Tests:** `packages/api/src/Schemas.test.ts` (`unit`) protects the status table and the submission union: replace the deleted-error and `AudienceProblem` cases with the new union members, the three pause reasons and a `progress` decode round trip.
- **Verify:**
  - Run `pnpm exec vitest run --project unit packages/api`; expect green with the new cases.
  - Run `pnpm typecheck`; expect failures only in the backend and CLI files that T2, T6 and T7 rewrite.
- **Risk/recovery:** Contract-only; no runtime until T6.

#### T2 — Campaign storage: per-recipient rows, conditional transitions, checkpoints

- **Change:**
  - `Storage/Primitives.ts`: add `updateIf(operationId, request)` to `updatePrimitives`: one `UpdateItem` under the 5 s deadline, `ReturnValues` honoured, `ConditionalCheckFailedException` returned as `{ applied: false }`, any other error `unavailable`. `updateRecord` stays for existing callers.
  - `Storage/Campaigns.ts` META: `state` literals `draft|queued|sending|paused|completed`; `queuedAt?`, `startedAt?`, `finishedAt?`, `pausedReason?`; counters `accepted`, `rejected`, `uncertain`, `skipped` written as `0` at create; `cursor?` (contact id, same encoding as `listMembers.nextCursor`); `runToken`. Remove `sendId`, `messageId`, `rejectionCode` from META. Every expression aliases `#state`, `#cursor`, `#count`.
  - `SEND#<contactId>` row: `sendId`, `contactId`, `recipient`, `state: unconfirmed|accepted|rejected|uncertain|skipped`, `startedAt`, `finishedAt?`, `messageId?`, `rejectionCode?`, `skipReason?: unsubscribed|suppressed`. Drop the frozen `sender`, `subject`, `text`.
  - Operations, each conditional and returning an outcome, never `unavailable` for a condition failure:
    - `enqueueCampaign(id, runToken, now)`: `#state = :draft` → `queued | not-draft`.
    - `resumeCampaign(id, runToken, now)`: `#state = :paused` → `queued | not-paused`.
    - `beginRun(id, runToken, now)`: `runToken = :run AND #state IN (:queued, :sending)` → sets `sending`, `startedAt = if_not_exists`, `ReturnValues: ALL_NEW` → `{ outcome: "running", campaign }` (the decoded META: `listId`, `subject`, `text`, `cursor`) `| stale`.
    - `claimRecipient(id, runToken, contactId, recipient, sendId, now)`: transaction `ConditionCheck META (#state = :sending AND runToken = :run)` + `Put SEND# attribute_not_exists(pk)` → `claimed | already-claimed | stale`.
    - `skipRecipient(id, runToken, contactId, recipient, reason, now)`: transaction `Put SEND# state skipped, attribute_not_exists(pk)` + `Update META ADD skipped :one` conditioned on state and run token → `skipped | already-claimed | stale`.
    - `settleRecipient(id, sendId, contactId, outcome, now)`: transaction `Update SEND#` (`#state = :unconfirmed AND sendId = :sendId`) to `accepted|rejected|uncertain` + `Update META ADD <counter> :one` (`attribute_exists(pk)`) → `settled | not-current`. Deliberately not conditioned on the run token: a stale slice settles the rows it claimed.
    - `checkpoint(id, runToken, previous, next)`: `updateIf` with `#state = :sending AND runToken = :run AND` either `attribute_not_exists(#cursor)` (first page) or `#cursor = :previous`; `SET #cursor = :next` → `updated | condition-failed`.
    - `completeRun(id, runToken, now)` and `pauseRun(id, runToken, reason, cursor, now)`: same two condition shapes; complete sets `finishedAt` and `REMOVE #cursor`; pause sets `pausedReason` and the cursor to resume from.
    - `getCampaign`: decode the new shape into `Schemas.CampaignSubmission`.
  - Delete `claimCampaign`, `finalizeCampaign`, `readAudience`, `audienceProbeLimit` and their `AudienceStore` surface.
  - `CampaignStoreLive` binds `GetItem, PutItem, Query, TransactWriteItems, UpdateItem`.
- **Starts at:** `apps/backend/src/Storage/Campaigns.ts`, `Storage/Primitives.ts:100-117`, `Storage/Membership.ts:26, 580-609`, `Storage/Audience.ts`
- **Depends on:** T1
- **Status:** Verified
- **Evidence:** `updateIf` in Primitives; Campaigns META/SEND rewrite with enqueue/resume/beginRun/claim/skip/settle/checkpoint/complete/pause; `readAudience` deleted. Parent reran `pnpm exec vitest run --project unit apps/backend/src/Storage` — 162 passed. Leftover `claimCampaign`/`readAudience` matches are T6/T9 callers only.
- **Tests:** `apps/backend/src/Storage/Campaigns.test.ts` and `Storage/Primitives.test.ts` (`unit`, `scriptedTable`) protect the conditional expressions and outcome mapping: each operation's exact `ConditionExpression`, slot order and `ADD` counters; both checkpoint condition shapes; `condition-failed`, `stale` and `not-current` from `cancelled(...)` and `conditionFailed`; `beginRun` returning the decoded META; `getCampaign` decoding every state; and one assertion over every recorded campaign request that no `ConditionExpression`/`UpdateExpression` contains a bare `count`, `state`, `cursor` or `text`. `Membership.test.ts` loses the `readAudience` suite.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Storage`; expect green.
  - Run `grep -rn "readAudience\|audienceProbeLimit\|claimCampaign\|finalizeCampaign" apps packages`; expect no matches.
- **Risk/recovery:** Storage-only; nothing calls the new operations until T5 and T6. The table schema is unchanged, so no migration.

#### T3 — Send budget: DynamoDB `RateLimiterStore` and quota reads

- **Change:**
  - Add `apps/backend/src/Storage/RateLimit.ts`, a fifth capability per ADR-0008: `RateLimitStoreLive` constructs one `AWS.DynamoDB.UpdateItem` binding on the data table and provides Effect's `RateLimiterStore` service.
    - `fixedWindow`: item `pk = RATELIMIT#<key>`, `sk = RATELIMIT`, `v`, `count` (aliased `#count`), `expiresAt` (epoch ms from the Effect `Clock`). Common path: the conditional `UpdateItem` from Research; on a condition failure, the reset `UpdateItem` conditioned on `#expiresAt <= :now`; if that fails too, the common path once more; then `RateLimitStoreError`. Return `[count, expiresAt − now]`.
    - `tokenBucket`, `adaptiveConsume`, `adaptiveFeedback`: fail with `RateLimitStoreError("… not supported")`.
    - Map `StorageFailure` to `RateLimiterError({ reason: RateLimitStoreError })` as the Redis store does.
  - Add `apps/backend/src/SendBudget.ts`: `sendBudget` reads `AWS.SES.GetAccount()` once per run and returns `{ limit: max(1, floor(MaxSendRate × 0.8)), dailyExhausted: SentLast24Hours ≥ min(Max24HourSend × 0.9, ceiling) }`, where `ceiling` is the optional `EMAILER_DAILY_SEND_CEILING` config (positive integer). Undefined `MaxSendRate` → `1`; undefined `Max24HourSend` → never exhausted. The binding is constructed in the dispatcher's init and called only inside the handler.
  - Export the limiter Layer for the dispatcher: `RateLimiter.layer` over `RateLimitStoreLive`; key `ses-send`, window one second, `algorithm: "fixed-window"`, `onExceeded: "delay"`.
- **Starts at:** `apps/backend/src/Storage/Campaigns.ts:284-306` (Layer shape), `Storage/Addresses.ts:9-17` (key style), `node_modules/effect/src/unstable/persistence/RateLimiter.ts:618-627, 918-1047`
- **Depends on:** T2 (`updateIf`)
- **Status:** Verified
- **Evidence:** `Storage/RateLimit.ts` DynamoDB `fixedWindow` (common path, expired reset, one retry); unsupported methods fail; `sendBudget(getAccount, ceiling)` arithmetic. Parent reran `pnpm exec vitest run --project unit apps/backend/src/Storage/RateLimit.test.ts apps/backend/src/SendBudget.test.ts` — 10 passed. `SendPacingLive` exported for T5.
- **Tests:** `apps/backend/src/Storage/RateLimit.test.ts` (`unit`, `scriptedTable` + `TestClock`) protects the store contract: exact `UpdateExpression`/`ConditionExpression`/`ReturnValues` of the common call; the fresh-item result `[tokens, extend]`; the expired-item path issuing the reset conditioned on `#expiresAt <= :now`; a lost reset retrying the common path once and then failing; the unsupported methods failing with `RateLimitStoreError`. One test drives the real `RateLimiter.consume` over the store with scripted counts and asserts the returned delay. `apps/backend/src/SendBudget.test.ts` protects the arithmetic and the undefined-field rules with a stubbed `GetAccount`.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Storage/RateLimit.test.ts apps/backend/src/SendBudget.test.ts`; expect green.
  - Run `pnpm lint`; expect clean.
- **Risk/recovery:** No caller until T5. A clock skewed ahead by more than one refill interval can win the reset against a peer's fresh reset and undercount by a token; harmless.

#### T4 — Dispatch queue and message

- **Change:**
  - Add `apps/backend/src/Dispatch.ts`, a handler-free leaf: `dispatchFailures = AWS.SQS.Queue("DispatchFailures", { messageRetentionPeriod: 14 days, sqsManagedSseEnabled })` and `dispatchQueue = AWS.SQS.Queue("Dispatch", { visibilityTimeout: 30 min, redrivePolicy: { deadLetterTargetArn, maxReceiveCount: 5 }, sqsManagedSseEnabled, messageRetentionPeriod: 4 days })`, plus `DispatchMessage = Schema.Struct({ campaignId: EntityId, runToken: EntityId })` with JSON encode/decode helpers.
  - In `alchemy.run.ts`: an alarm `DispatchFailuresVisible` on the dead-letter queue, copied from `FeedbackFailuresVisible`.
- **Starts at:** `apps/backend/src/Feedback.ts:28-32`, `alchemy.run.ts:35-46`
- **Depends on:** none
- **Status:** Verified
- **Evidence:** `apps/backend/src/Dispatch.ts` is a handler-free leaf: `dispatchFailures` (14-day retention, SSE), `dispatchQueue` (30 min visibility, maxReceiveCount 5, 4-day retention, DLQ ARN from yielded failures), `DispatchMessage` JSON helpers. `alchemy.run.ts` yields the DLQ for `DispatchFailuresVisible`. Parent reran `pnpm exec vitest run --project unit apps/backend/src/Dispatch.test.ts` — 2 passed. Source queue is registered in T5.
- **Tests:** `apps/backend/src/Dispatch.test.ts` (`unit`) protects the message round trip and the rejection of a malformed body. The queue declarations are checked by `tsc` and by the plan in T9.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Dispatch.test.ts`; expect green.
- **Risk/recovery:** Declarations only.

#### T5 — Dispatcher Lambda: one page per invocation

- **Change:**
  - Add `apps/backend/src/Dispatcher.ts` in the inline Function form: `emailer-<stage>-dispatcher`, `nodejs24.x`, `arm64`, 512 MB, `timeout: 5 min`, `functionUrl: false`, its own log group, env for the unsubscribe link as in `Api.ts:120-124`, no `eventInvokeConfig`. Init provides `MailerLive`, `CampaignStoreLive`, `AudienceStoreLive`, `RateLimitStoreLive` + `RateLimiter.layer`, `AWS.Lambda.QueueEventSource`, `AWS.SQS.SendMessageHttp`, `AWS.SES.GetAccountHttp`; constructs `SendMessage(dispatchQueue)` and `GetAccount()`; registers `consumeQueueMessages(dispatchQueue, { batchSize: 1 }, …)`.
  - Add `apps/backend/src/Dispatching.ts` with the pure slice `runSlice(message, deadline)` over the capability services, unit-testable without Lambda. Exactly one member page per invocation:
    - `beginRun` → `stale` → return (acknowledge). Otherwise the returned META supplies `listId`, `subject`, `text` and `cursor` (`previous`).
    - `sendBudget` → `dailyExhausted` → `pauseRun("daily-quota", previous)` → return.
    - `listMembers(listId, 50, previous)`; a missing list → `completeRun` → return.
    - Per member, in order: `addressStatus` → not mailable → `skipRecipient`; `claimRecipient` → `already-claimed` → continue, `stale` → return; `unsubscribeLink`; `limiter.consume({ key: "ses-send", window: "1 second", limit, onExceeded: "delay" })`; if `delay + submissionTimeout + 2 × operationTimeout` exceeds the remaining budget → `checkpoint(previous, lastProcessed)` → won → enqueue `{campaignId, runToken}` → return (a consumed unused slot is harmless); otherwise `Effect.sleep(delay)` then `mailer.submit`.
    - Outcomes: `accepted` → settle accepted; rejected `rate-limited` → back off 1 s, 2 s, 4 s with a fresh `consume` before each retry; after the third failure settle rejected and `pauseRun("rate-limited", lastProcessed)` → return; rejected `sending-paused` → settle rejected, `pauseRun("sending-paused", lastProcessed)` → return; other rejections → settle rejected; `SubmissionUncertain` → settle uncertain, continue.
    - End of page: `checkpoint(previous, next)` → `condition-failed` → return; no `next` → `completeRun` → return; else enqueue the continuation `{campaignId, runToken}` → return.
    - A slice that made no progress (the first member's delay already exceeds the budget) must not return normally, because a normal return acknowledges and deletes the message; it dies through `reportedAndFatal` like every other failure, so SQS redelivers after the visibility timeout.
    - Every storage failure, and a failed continuation `SendMessage` after a won checkpoint, dies through `reportedAndFatal`; the message is redelivered and the run resumes from the persisted cursor.
  - Register `DispatcherFunction` in `alchemy.run.ts`.
- **Starts at:** `apps/backend/src/Feedback.ts:193-252` (shape), `apps/backend/src/Campaigns.ts:101-165` (submit and link logic to move), `apps/backend/src/Diagnostics.ts:145-151`
- **Depends on:** T2, T3, T4
- **Status:** Verified
- **Evidence:** `Dispatching.runSlice` one page per invocation; `Dispatcher.ts` Lambda; parent reran `pnpm exec vitest run --project unit apps/backend/src/Dispatching.test.ts` — 13 passed. No-progress fails `SliceOverrun` so SQS redelivers. Rate-limited retries 4 attempts (1s/2s/4s backoffs) then pauses. Leftover typecheck is integration files (T9).
- **Tests:** `apps/backend/src/Dispatching.test.ts` (`unit`, World/hook fixtures as in `Campaigns.test.ts`, `TestClock` for the deadline, a fake `RateLimiter` recording calls and returning scripted delays) protects the slice's observable behaviour: a full page yields one settled row and one counter increment per member and exactly one continuation message; the last page completes the campaign and enqueues nothing; unsubscribed and suppressed members get `skipped` rows; a redelivered slice (rows already present) claims nothing, submits nothing and still checkpoints or completes; a stale run token submits nothing; a limiter delay that would overrun the budget checkpoints at the last processed member and enqueues one continuation; a delay that overruns the budget before the first member fails the invocation instead of returning; a lost checkpoint enqueues nothing; `rate-limited` retries with 1 s, 2 s, 4 s backoff then settles rejected and pauses with `rate-limited`; `sending-paused` pauses; `dailyExhausted` pauses before any claim; a missing list completes; the limiter is consumed exactly once per attempt with the run's limit.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Dispatching.test.ts`; expect green.
  - Run `pnpm check`; expect green.
- **Risk/recovery:** The live SQS mapping and the continuation round trip are proven in T9 on every run, because a two-page campaign needs one continuation.

#### T6 — API and Mailer

- **Change:**
  - `apps/backend/src/Campaigns.ts`: `send` = `get` → `NotFound`; `draft` → `enqueueCampaign` then `SendMessage`; `queued` → `SendMessage` again (wake-up is idempotent); any other state → return the campaign. `resume` = `resumeCampaign` → `queued` → `SendMessage`; `not-paused` → return the campaign. A failed `SendMessage` in either is logged and mapped to `StorageUnavailable({ operationId: "dispatch" })`, so the CLI's existing nonzero-and-retry contract covers it and the retry re-sends the wake-up. Delete the per-recipient logic.
  - `apps/backend/src/Api.ts`: `resume` route; `SendMessage(dispatchQueue)` binding in init; `AWS.SQS.SendMessageHttp` in the Layer merge; remove `MailerLive` and the `Mailer` service from the API (it never sends again, and its role loses `ses:SendEmail`); delete `publiclySent`.
  - `apps/backend/src/Diagnostics.ts`: delete `SendFailure` and `publiclySent` if nothing else uses them.
  - `apps/backend/src/Mailer.ts`: delete `allowedRecipients` (service field, config, `mailerAddresses` output, `MailerLive` wiring).
  - `.env.example`: delete `EMAILER_ALLOWED_RECIPIENTS` and its comment; add the optional `EMAILER_DAILY_SEND_CEILING` with a one-line comment. Delete the key from the local `.env.test` too.
- **Starts at:** `apps/backend/src/Campaigns.ts:52-183`, `Api.ts:72, 162-186`, `Mailer.ts:53, 72-75, 87, 101, 189`, `.env.example:19-32`
- **Depends on:** T2, T4
- **Status:** Verified
- **Evidence:** API send/resume enqueue via CampaignWake + SQS; Mailer removed from API; allowlist deleted. Parent reran `pnpm exec vitest run --project unit apps/backend` — 370 passed. `getCampaignRun` reads runToken for queued re-wake. IntegrationSupport still mentions the allowlist (T9).
- **Tests:** `apps/backend/src/Campaigns.test.ts` (`unit`) shrinks to: `send` on `draft` enqueues once and returns `queued`; `send` on `queued` re-enqueues; `send` on `sending`/`completed` enqueues nothing; a failed enqueue after the `queued` write fails `StorageUnavailable`; `resume` on `paused` enqueues and returns `queued`; `resume` elsewhere returns the campaign unchanged. `apps/backend/src/Api.test.ts` (`unit`) protects the routes and statuses: 200 with `queued`, 503 on a failed enqueue, and that the API has no mailer at all. `Mailer.test.ts` loses the allowlist cases.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend`; expect green.
  - Run `grep -rn "allowedRecipients\|EMAILER_ALLOWED_RECIPIENTS\|recipient-not-allowed\|MailerLive" apps/backend/src/Api.ts apps packages .env.example`; expect no matches outside `Mailer.ts`, `Dispatcher.ts` and their tests.
- **Risk/recovery:** After this task the API can enqueue; without T5 deployed a campaign would sit `queued`. Both land before the live gate.

#### T7 — CLI

- **Change:**
  - `apps/cli/src/Commands.ts`: `campaigns send` prints the campaign and exits 0 whenever `submission.state` is not `draft`; delete `SendNotAccepted`. Add `campaigns resume <campaignId>`. `requestTimeout` stays at 70 s (the documented rule is a client deadline above the function timeout).
  - README output contract (`:131-146`): exits zero when the campaign is queued; poll `campaigns get` for `progress` and a `paused` reason; `resume` for a paused campaign; "never retried automatically" now refers to individual recipients.
- **Starts at:** `apps/cli/src/Commands.ts:412-456`, `apps/cli/src/Diagnostics.ts:8-13`, `README.md:80-81, 131-146`
- **Depends on:** T1
- **Status:** Verified
- **Evidence:** `campaigns send` prints JSON and exits 0 on HTTP success; `campaigns resume` added; `SendNotAccepted` deleted. Parent reran `pnpm exec vitest run --project unit apps/cli` — 29 passed. README output contract updated.
- **Tests:** `apps/cli/src/Commands.test.ts` (`unit`, in-memory handlers) protects the exit-code contract: `send` → `queued` → exit 0 with JSON on stdout; `resume` round trip; a 503 → nonzero with the error on stderr.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/cli`; expect green.
- **Risk/recovery:** None beyond the contract change.

#### T9 — Integration suite and live gate on `test-b`

- **Change:**
  - `apps/backend/test/IntegrationSupport.ts`: delete the allowlist reads and `simulatorAddress`; add `simulator(kind, runId, n?)` producing `success+<runId>-<n>@`, `bounce+<runId>@`, `complaint+<runId>@simulator.amazonses.com`; `contactFor` becomes plain create; add `sendToSimulatorList(client, listId, campaignId)` that pages the list's members and throws if any address does not end with `@simulator.amazonses.com` before calling `send`, used by every send in the suite; add `awaitCampaignState(id, state, timeout)` polling `campaigns get`, with the timeout derived at suite start from `members / floor(MaxSendRate × 0.8)` (quota read through `aws sesv2 get-account` or the SES client) plus 30 s; add `sendRows(campaignId)` and `rateLimitItem()` reading the physical table (`EMAILER_TEST_TABLE_NAME`). Delete `uniqueAddress`'s use as a list member anywhere.
  - `apps/backend/src/Api.integration.test.ts`: the flow imports 60 `success+` contacts (three `lists import` calls), sends, awaits `completed`, asserts `progress.accepted === 60`, 60 `SEND#` rows all `accepted`, the `RATELIMIT#ses-send` item exists with `expiresAt` at or after the run's start (an unwired limiter cannot pass; `count` is not asserted, because the item resets whenever a refill interval passes between consumes), and, bucketing rows by `finishedAt` second, no bucket exceeds `floor(MaxSendRate × 0.8)`; at typical quotas the sequential pace never approaches the limit, so the live gate proves wiring and the ceiling while the pacing arithmetic stays proven by the T3 store test and the T5 fake-limiter test; the two-concurrent-sends case asserts both return `queued` and, after `completed`, exactly one row per member (rows, not counters); the empty-list case asserts `completed` with all counters 0; delete the `claimCampaign` outcome cases.
  - `Feedback.integration.test.ts`: bounce and complaint labelled addresses, await suppression, then a second campaign to the same two completes with `skipped: 2`, `accepted: 0`, and two `skipped` rows.
  - `Unsubscribe.integration.test.ts`: after opt-out, the next campaign completes with `skipped: 1`.
  - Add a dead-letter assertion at the end of the API flow: `DispatchFailures` has no visible messages.
  - Live run: deploy `--stage test-b`, `pnpm test:integration`, destroy `test-b`. Record the account's `SendQuota` and the observed per-second maximum.
- **Starts at:** `apps/backend/test/IntegrationSupport.ts`, `apps/backend/src/*.integration.test.ts`, `README.md:192-248`
- **Depends on:** T5, T6, T7
- **Status:** Verified
- **Evidence:** Deployed `--stage test-b` 2026-09-15. SendQuota MaxSendRate=26, Max24HourSend=50000, SentLast24Hours=19; paced limit 20. 60 success+ recipients completed with accepted=60, 60 SEND# rows, limiter expiresAt after run start, 19 finishedAt-second buckets none > 20. Concurrent sends both succeeded (one already `sending`); one row per member. Empty list completed counters 0. Simulator guard refused `@example.invalid`. Bounce+complaint second campaign skipped:2. Unsubscribe second campaign skipped:1. DispatchFailures visible=0. No labelled SES suppressions. Destroy 21 succeeded; no `emailer-test-b-*` functions or `Emailer-*-test-b-*` queues; Alchemy `Emailer` state path gone.
- **Tests:** The integration suite (`integration`) is the gate. It protects: end-to-end enqueue → dispatch → continuation message → settle across two member pages; per-recipient skipping of suppressed and unsubscribed addresses; no second submission per recipient under concurrent sends; every submission consulting the shared limiter store and the per-second ceiling holding; an empty dead-letter queue; the simulator guard refusing a non-simulator member (one negative case with a local list).
- **Verify:**
  - Run `pnpm exec alchemy plan --config alchemy.run.ts --stage test-b --env-file .env.test --profile emailer-test`; expect the dispatcher function, two queues, the mapping, the DLQ alarm, `ses:SendEmail` and `ses:GetAccount` on the dispatcher role only, and no `EmailIdentity` create.
  - Run `node --env-file=.env.test $(pnpm bin)/vitest run --project integration`; expect green.
  - Run `aws sqs get-queue-attributes --queue-url <DispatchFailures> --attribute-names ApproximateNumberOfMessages`; expect `0`.
  - Run `aws sesv2 list-suppressed-destinations`; remove any labelled simulator entry the run created, using the exact address string.
  - After destroy: no `emailer-test-b-*` functions, no `Emailer-*-test-b-*` queues, tables or alarms; `alchemy state list Emailer` shows no `test-b`.
- **Risk/recovery:** If the flow stalls `queued`, read the dispatcher log group before anything else; a decode failure lands in the DLQ after five receives. If the limiter item is absent after a run, the dispatcher is not consulting the store: check the Layer wiring. Destroy `test-b` before investigating.

#### T10 — Records, README and wiki

- **Change:**
  - ADR-0011: `Status: Accepted` with date after T9 passes and the user accepts.
  - Lifecycle lines: ADR-0001 (`:34`), ADR-0002 (`:36`), ADR-0004 (`:11, :27, :44`), ADR-0005 (`:12`), ADR-0008 (`:20`) each get a `Superseded in part: [ADR-0011]` header line naming the clause; bodies unchanged. ADR-0003 `:44` gets a clerical note that the refusal became a per-recipient skip.
  - README: module table rows for `Dispatch.ts`, `Dispatcher.ts`, `Dispatching.ts`, `SendBudget.ts`, `Storage/RateLimit.ts`; `:3` first-slice framing; `:65` what local checks prove (the slice loop, the pacing arithmetic and the store contract; the queue, the limiter wiring and the per-second ceiling are live-only); CLI examples with `resume`; delete the allowlist guard paragraph (`:164-166`); four Lambdas and their IAM (`:222`), the API without `ses:SendEmail`; delete the once-per-stage feedback rule (`:231`); teardown inventory (`:246`) adds the two queues, mapping, log group, role and alarm; a "Testing recipients" paragraph stating the simulator-only rule, the labelled-address convention and the test-side guard; in the replay section, how a campaign stuck `sending` after a dead-lettered wake-up is recovered by an SQS redrive of that message.
  - `wiki/aws/ses.md`: `GetAccount`/`SendQuota` fields and their optionality, which error names were observed for per-second throttling in T9, simulator label addressing. `wiki/effect/retries-and-concurrency.md`: `RateLimiter` lives under `unstable/persistence`, delay-mode semantics, custom store shape, the reserved-word trap. `wiki/alchemy/events-and-sinks.md` and `runtime-and-bindings.md`: `HandlerContext` is available; batch size 1 pattern; consume and send on one queue.
- **Starts at:** the paths above
- **Depends on:** T9
- **Status:** Verified
- **Evidence:** ADR lifecycle lines, README module table / four Lambdas / testing-recipients / redrive recovery, wiki SES/RateLimiter/SQS notes. Parent `pnpm check` green (489 unit tests). Live gate on test-b passed then destroyed.
- **Tests:** Documentation; no automation. Validated by the link check and by reading T9's evidence into the text.
- **Verify:**
  - Run `pnpm format:check`; expect clean.
  - Run the relative-link check over `README.md`, `.adr/**/*.md`, `wiki/**/*.md`; expect none broken.
  - Run `grep -n "allowlist\|allowed recipient\|once per deployment" README.md`; expect no stale match.

## Final acceptance

- **Checks:**
  - `pnpm check` green; unit count up by the new suites; no reference to the allowlist, `readAudience`, `claimCampaign` or the deleted error classes anywhere.
  - T9 passes on `test-b`: 60 accepted rows over two pages and one continuation message, counters equal to row states, the limiter item written during the run, no second exceeding the ceiling, skips for suppressed and unsubscribed addresses, empty dead-letter queue, no second submission under concurrent sends.
  - Link checks clean; ADR-0011 Accepted; the six lifecycle lines in place.
- **End state:**
  - The API enqueues; the dispatcher sends one page per invocation; every campaign recipient has exactly one row.
  - No Emailer `test-b` stage exists. The account holds no new long-lived resources.
- **Operator steps:** Read `aws sesv2 get-account --query SendQuota` once before T9. Inspect the account suppression list after T9.
- **Deferrals or blockers:**
  - Real recipients wait for the deliverability lane's merge.
  - Transient-bounce escalation, feedback counts in `campaigns get`, reputation alarms and a notification channel belong to the reputation lane; automatic sending pause follows them.
  - Rows claimed by a crashed slice stay `unconfirmed` and uncounted; visible in the rows.
  - A DynamoDB-backed `tokenBucket` and the adaptive limiter modes are not implemented.
  - The limiter coordinates one stage; a second stage sending at volume in the same account is not paced against the first.

## Handoff

- **Next action:** None.
- **Deviations:** Concurrent `send` HTTP bodies may already be `sending` when the dispatcher begins the run before the API re-reads. Both calls still succeed and still produce one row per member. The live assertion was loosened to `queued|sending`; the 60-recipient, skip, empty-list, limiter, and DLQ assertions held. No SES account-suppression entries were created for labelled simulator addresses. Per-second throttle was not observed (MaxSendRate 26, paced 20).
- **Resources:** Worktree `~/worktrees/emailer/mass-sending` (workflow-owned, retained until the PR is open). Stage `test-b` was deployed for T9 and destroyed the same day (21 resources). Parallel deliverability worktree `~/worktrees/emailer/deliverability` is not owned by this lane.
- **Merge notes:** Files shared with the deliverability lane, all on different lines: `README.md` (teardown inventory sentence; that lane also rewrites the Sending identity section), `wiki/aws/ses.md`, `.env.example`, and ADR-0002's header (one lifecycle line each). If this lane merges first, the deliverability lane's T3 send returns `queued` instead of `accepted`: that gate must then poll `campaigns get` to `completed` before reading the delivered headers.
- **Reviews:**
  - [Independent plan review](mass-sending-review.md), 2026-09-15: fourteen findings, all accepted. R1 aliased `#cursor` and added the reserved-word assertion. R2 added 1/2/4 s backoff and a `rate-limited` pause reason. R3 replaced the spread assertion with the limiter-count and per-second-ceiling assertions. R4 made one page per invocation the only loop shape, so every two-page run proves the continuation. R5 corrected the ADR: crashed-slice rows stay `unconfirmed`, an accepted residual. R6 corrected the ADR: the limiter is per stage. R7 `beginRun` returns the META; both checkpoint shapes specified. R7's suggested "just return" for a no-progress slice was wrong for the convenience consumer (a normal return acknowledges the message); such a slice dies so SQS redelivers, a fix-exposed correction. R8 `consume` then budget check then sleep; a failed continuation send dies. R9 the API drops the mailer; enqueue failure maps to `StorageUnavailable`. R10 cut feedback counts in `get` and `CampaignNotPaused`, kept the CLI timeout, simplified the store reset condition; transient-bounce escalation raised to the user, who moved it to the reputation lane. R11 merge notes list three shared files and the sequencing note. R12 test-side simulator guard; local `.env.test` key deleted. R13 paths, `awaitCampaignState` sizing, rows-not-counters in the concurrency case. R14 ADR wording corrected; DLQ redrive recorded as the recovery for a stuck `sending`.
  - [Follow-up round 2](mass-sending-review.md), 2026-09-15: R1–R14 resolved (R10 withdrawn in part with T8), the T5 no-progress correction verified against the consumer source; closure `Changes required` on R15 (S2, fix-caused: the R3 replacement assertion `count === submissions` cannot pass live, because each token extends the item by one refill interval only). R15 accepted and applied: T9, the T9 risk note, Final acceptance, T10 and ADR-0011's Confirmation now assert that the limiter item was written during the run plus the per-second ceiling. Closed without a further round; the change is wording only.
  - [Decomplex prevention review](mass-sending-decomplex.md), 2026-09-15: DEX-001 (transient-bounce escalation) → Ask user; the user moved it to the reputation lane; DEX-002 (`CampaignNotPaused`) → Act, cut; DEX-003 (CLI timeout) → Act, left at 70 s.
  - [Implementation review](mass-sending-implementation-review.md), 2026-09-15: MS-1 (S2, claim-then-overrun dropped recipient N) → Fix now; consume/budget-check moved before claim. Round 2 Clear.
  - PR review (report not retained), 2026-09-15: live gate reproduced on a fresh `test-c` stage (19 integration tests, 60 accepted rows over two pages, empty dead-letter queue, API role without SES). MS-R1 (S2, client retries turning an applied conditional write into a lost race) → Fix now: `updateIf` and `runTransaction` opt out of client retries with `Retry.none`, proven by `Storage/Primitives.transport.test.ts`. Format failure on the implementation review report, the ADR-0011 sentence about ADR-0008's table, and the vitest allowlist comment corrected in the same commit.
