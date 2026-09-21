# Repeat-safe writes

> **Status:** Complete; ADR-0013 accepted 2026-09-16

## Outcome and boundaries

- **Outcome:** a transient DynamoDB answer during a campaign costs a retry, not a 30-minute stall and an uncounted recipient; a lost response on any write cannot leave a campaign stuck.
- **In scope:** the storage primitives' retry policy, transaction tokens, the single-item conditions that must hold after the write, the two creates, the resume handler, the Crypto service on the store layers, tests, ADR-0013, the DynamoDB wiki page.
- **Non-goals:** API-level idempotency for human retries (ADR-0005); reconciling rows a genuine crash leaves unconfirmed (ADR-0011); the dispatch queue lease; the SES send, which has no token and keeps its single attempt.
- **Authority:** [ADR-0013](../0013-repeat-safe-writes.md); the user's request on 2026-09-16.

## Key files, evidence, and decisions

| Path | Why it matters | Decision |
| --- | --- | --- |
| `apps/backend/src/Storage/Primitives.ts` | owned `Retry.none` on `updateIf` and `runTransaction`, a duplicate conflict retry on `updateIf`, and `createRecord` | delete all four; `runTransaction` takes a token source and adds one token per logical call |
| `apps/backend/src/Storage/Campaigns.ts` | enqueue, resume and checkpoint conditions read as a lost race after a lost response | identity-based conditions; checkpoint records `sliceId`; `completeRun` removes it |
| `apps/backend/src/Storage/Contacts.ts`, `Membership.ts` | carried caller tokens the single-attempt policy made inert | tokens removed; the plain update accepts either spelling of the address |
| `apps/backend/src/Storage/Lists.ts` | `createList` under a fresh identifier | `recordOnce` |
| `apps/backend/src/Campaigns.ts` | `resume` returned early on a queued campaign | re-sends the wake-up, as `send` does |
| `apps/backend/src/Dispatching.ts` | the checkpoint needs the slice's identity | one `sliceId` per slice |
| `apps/backend/src/Api.ts`, `Dispatcher.ts`, `Feedback.ts` | the store layers now require the Crypto service | `NodeCrypto.layer` provided to the store layers |
| `@distilled.cloud/aws` `client/generate-idempotency-tokens.ts`, `protocol.ts`, `core/api.ts` | the client fills `ClientRequestToken` inside `encode`, which the retry loop re-runs per attempt | the store supplies the token itself |
| `@distilled.cloud/aws` `services/dynamodb.ts:613-634` | `TransactionCanceledException` has no retryable trait; `TransactionConflictException` and `TransactionInProgressException` do | the store keeps only the cancellation retry |
| AWS `API_TransactWriteItems` | token idempotent for ten minutes; same token with other parameters is rejected | one token per logical call, never reused across calls |

## Research

- **Which writes misread a repeat today.** Enqueue and resume (queued with no wake), checkpoint (acknowledged with no continuation, nothing in any queue), the contact update when only the spelling changes (503 despite success), campaign and list creation (503 despite success). Claim, skip, settle and feedback rows are transactions and already read a repeat correctly; the token makes their retries return success instead.
- **Duplicate wake-ups are already safe**: standard SQS is at-least-once, claims are conditional, and only a won checkpoint enqueues a continuation. The slice identifier keeps that property: a concurrent duplicate on the same page carries a different identifier and loses.
- **The rate-limiter item** cannot be made repeat-safe without a token it does not have; an over-count only slows sending.

## Tasks

#### T1 — Primitives

- **Change:** delete `Retry.none`, the `updateIf` conflict retry and `createRecord`; `transactionPrimitives(operations, tokens)` adds `ClientRequestToken` per logical call and strips it from `TransactionRequest`; comments state the rule.
- **Tests:** `Primitives.test.ts`: one token per call, a new token per conflict retry, condition-only and mixed cancellations unchanged, seven conflicts unavailable, `updateIf` leaves a `TransactionConflictException` to the client. `Primitives.transport.test.ts`: a 500 then a 200 sends two identical requests including the token; a conflict cancellation then a 200 sends two requests with different tokens.
- **Status:** Done

#### T2 — Conditions and creates

- **Change:** enqueue and resume accept `queued` under the same run token; checkpoint writes and accepts its `sliceId`; `completeRun` removes it; `createCampaign` and `createList` use `recordOnce`; the contact update accepts the new spelling; caller tokens removed from contacts and membership.
- **Tests:** `Storage/Campaigns.test.ts`, `Storage/Contacts.test.ts`, `Storage/Membership.test.ts` pin the exact expressions.
- **Status:** Done

#### T3 — Domain, dispatcher and layers

- **Change:** `resume` re-wakes a queued campaign; `runSlice` mints a `sliceId`; the three functions provide `NodeCrypto.layer` to the store layers; the integration support builds tokens from the Crypto service.
- **Tests:** `Campaigns.test.ts` (resume re-sends the wake-up), `Api.test.ts` (a repeated resume sends a second wake-up under the same run token), `Dispatching.test.ts` (checkpoints carry the slice id).
- **Status:** Done

#### T4 — Live gate

- **Change:** deploy `--stage test-f` from the branch, run the integration project, destroy, inventory.
- **Verify:** every case green; no `test-f` resource left.
- **Evidence:** 2026-09-16, stage `test-f` deployed from `1e35119`; the integration project passed all 22 cases on the first run in 196 s; stage destroyed afterwards and the account inventoried.
- **Status:** Done

#### T5 — Docs and decision lifecycle

- **Change:** ADR-0013; `Superseded in part` headers on ADR-0011 and ADR-0012; `wiki/aws/dynamodb.md` rewritten for the two mechanisms by write shape.
- **Status:** Done

## Final acceptance

- `pnpm check` green.
- The transport tests prove identical resends and new-call retries.
- The integration project green on an ephemeral stage, destroyed afterwards.
- ADR-0013 accepted by the user.

## Handoff

- **Next action:** none; merged through [PR #6](https://github.com/maxedapps/emailer/pull/6).
- **Resources:** worktree `~/worktrees/emailer/repeat-safe-writes` on branch `repeat-safe-writes` from `main` at `90c7235`.
