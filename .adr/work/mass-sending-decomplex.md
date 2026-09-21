# Decomplex review: Mass sending — open recipient set and paced dispatch

## Overall status

Three potential findings, none touching the user's decisions. The plan's core machinery (per-recipient rows, conditional transitions on state and run token, the DynamoDB `RateLimiterStore` with its reset path, the standard queue with a dead-letter queue, the daily budget pause, the throttle retry) is proportionate to at-least-once delivery over an irreversible side effect. What does not earn its place is one task outside the problem statement (T8), one public error shape that contradicts the plan's own `send` semantics (`CampaignNotPaused`), and one unrequested constant change in the CLI (the request timeout).

## Review contract

| Axis                          | Selection                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode                          | Prevention                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Target                        | [`mass-sending.md`](mass-sending.md) (Ready for implementation, 2026-09-15) and [ADR-0011](../0011-open-recipient-set-and-paced-dispatch.md) (Proposed)                                                                                                                                                                                                                                                                                       |
| Authority / required behavior | ADR-0011 Authority line: no allowlist, open lists, simulator-only testing, Effect `RateLimiter` with a shared DynamoDB store, standard SQS queue. Accepted ADRs 0001–0009. Required behaviour is the plan's Outcome section: a campaign to a list of any size is accepted immediately, worked in pages by a dispatcher, paced against the account's real SES rate across all runners, recorded per recipient, observable as progress counters |
| Scope                         | Structural choices, machinery, task count, tests and validation machinery, configuration surface, operational burden. Defects and plan compliance are routed to the separate reviewer (see Limitations)                                                                                                                                                                                                                                       |
| Report                        | `.adr/work/mass-sending-decomplex.md` (explicit path; the repository uses `.adr/`, not `adrs/`)                                                                                                                                                                                                                                                                                                                                               |

## Coverage

### Inspected

- The full plan and ADR-0011; accepted ADRs 0001–0009 in full; the memory records the plan cites (`open-recipient-list-roadmap`, `rate-limiter-as-pacing-primitive`, `rewrite-over-bolt-on`).
- `apps/backend/src/Storage/Campaigns.ts` (current META/`SEND#` shapes, claim and finalize transactions, PutItem-free `CampaignStoreLive`), `Storage/Primitives.ts` (`updateRecord` discards output; `runTransaction` reports condition failures), `Storage/Feedback.ts` (PutItem-only capability and its stated rationale), `Storage/Addresses.ts` (`addressStatus`), `Storage/Membership.ts` (`listMembers`, `readAudience`), `Storage/Audience.ts`.
- `apps/backend/src/Campaigns.ts`, `Feedback.ts` and `Feedback.test.ts` (handler and Function class in one module, tested directly), `Mailer.ts` (rejection-code map, `Retry.none`, 8 s submission timeout), `Api.ts` (60 s timeout), `Diagnostics.ts` (`reportedAndFatal`), `alchemy.run.ts` (alarm shapes).
- `apps/cli/src/Commands.ts` (`requestTimeout` and its rationale), `apps/backend/test/IntegrationSupport.ts`, `Api.integration.test.ts`, `packages/api/src/Schemas.ts` (submission union, error classes).
- `node_modules/effect/src/unstable/persistence/RateLimiter.ts` (delay-mode arithmetic, `sleep`, the `fixedWindow` contract, memory and Redis store algorithms), `node_modules/alchemy/src/AWS/SQS/QueueEventSource.ts`, `AWS/Lambda/QueueEventSource.ts`, `AWS/SQS/Queue.ts`.
- `wiki/aws/sqs.md`, `wiki/aws/dynamodb-outbox.md`, `wiki/aws/deliverability.md`, `wiki/aws/ses.md` (quota and simulator rows), `.env.example`, the README sections the plan edits, and the two prior decomplex reports for precedent.

### Skipped or partial

- `Storage/Testing.ts` (`scriptedTable`) and the existing unit suites were not read beyond their import shape; test-volume judgements rest on the plan's descriptions and the established exact-request assertion style.
- `GetAccount.ts` and the `sesv2` quota types were taken from the plan's citations, not re-read.
- No deployment, test run or SES call was made; all reachability claims are static.

## Potential findings

### DEX-001 — T8 transient-bounce escalation is a separate reputation feature riding on the dispatch slice

- **Evidence:** Confirmed
- **Recommendation:** Ask user
- **Surface and location / authority:** Plan Outcome (in-scope bullet "Transient-bounce escalation in the feedback Lambda"), T8, ADR-0011 Decision ("Transient bounces escalate") and Consequences. Not in the ADR's Authority line; the user's recorded decisions cover the allowlist, open lists, simulator testing, the limiter store and the queue type.
- **Current-need evidence:** The problem statement is a synchronous single-recipient send that must become a paced, resumable, per-recipient dispatch. Nothing in it needs a transient-bounce policy, and no transient-bounce volume has been observed (the account has sent a handful of test messages). ADR-0003's confirmed live behaviour is that `Transient` and `Undetermined` bounces "record without suppressing"; `wiki/aws/deliverability.md:36` asks for soft bounces to be _classified_ and warns that application resending duplicates SES's own retries — it does not ask for escalation to suppression.
- **Added burden:** A new address-keyed item type (`BOUNCES#<mailbox>/TRANSIENT`), a new `updateRecord` variant returning `ALL_NEW` in `Primitives.ts`, `UpdateItem` added to `FeedbackStoreLive` (the capability `Storage/Feedback.ts:162-171` deliberately keeps to `PutItem` so the consumer "can neither read the audience nor delete what it has written"; ADR-0008's table is superseded for it), a counting branch in `Feedback.record`, two unit suites, a README row, and a clause in ADR-0011 that must document two known inaccuracies (no reset, double count on redelivery).
- **Reachable practical impact:** An address that soft-bounces three times over any span (mailbox full, greylisting, a receiver's transient DNS trouble) is suppressed locally and permanently: there is no delivery event to reset the count, redelivered feedback events over-count, and un-suppression is explicitly out of scope. Recovery is a hand-written DynamoDB delete of a `SUPPRESSION#` item. The direction is conservative, but the plan installs a permanent, operator-invisible loss of mailable contacts on a heuristic it admits is inexact.
- **Smallest simpler alternative:** Delete T8 and the "Transient bounces escalate" clause and consequence from ADR-0011; `FeedbackStore` keeps `PutItem` alone; T10's README module text loses the counter row. Revisit alongside the reputation-alarm lane the plan already defers, once transient bounce volume from real sending exists to size a threshold against.
- **Exception / boundary check:** No trust boundary, invariant or external contract depends on it. Suppression of permanent bounces and complaints (ADR-0003) is untouched. It is not a user decision recorded in ADR-0011's Authority line.
- **Required behavior and simplification risk:** The Outcome section lists the escalation in scope, so cutting it changes the plan's stated scope rather than its target behaviour; every other Outcome sentence is unaffected. Risk of cutting: none to the dispatch path; the only lost behaviour is the heuristic itself.
- **Bounded next step or user question:** "T8 adds transient-bounce escalation, which is outside the mass-sending problem, widens the feedback consumer's write surface, and can permanently suppress a mailable address on an admittedly inexact count. Keep it in this lane, or defer it to the reputation lane?"
- **Acceptance signal:** If cut: T8 absent from the plan, `FeedbackStoreLive` still binds only `PutItem`, ADR-0011 carries no transient-bounce clause, and ADR-0008's `FeedbackStore` row stays as is. If kept: no change; the user has decided.

### DEX-002 — `CampaignNotPaused` contradicts the plan's own idempotent `send` and adds a public error shape for a no-op

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** Plan T1 (`packages/api/src/Schemas.ts`: add `CampaignNotPaused { campaignId, state }`, HTTP 409; `resume` route errors), T6 (`resume` → `not-paused` → `CampaignNotPaused`), T7 (CLI: "a 409 on `resume` → nonzero with the error on stderr"), ADR-0011 Consequences ("gains one (`CampaignNotPaused`)"). Not a user decision.
- **Current-need evidence:** In the same task, `send` is specified as "any other state → return the campaign": sending a `sending`, `paused` or `completed` campaign is a no-op that reports the state. Nothing explains why `resume` on a non-paused campaign should be a 409 instead. The plan deletes four error shapes for being unneeded; this one is added in their place for the same kind of case.
- **Added burden:** One tagged error class in the shared contract (sticky once published; the CLI and any MCP consumer must model it), one 409 mapping on the `resume` route, a `CampaignNotPaused` branch in `Campaigns.resume`, a CLI stderr/exit-code path and its test, an `Api.test.ts` case, and a Schemas test case.
- **Reachable practical impact:** An operator who runs `resume` twice, or on a campaign that finished while they were looking, gets a failing command and a non-zero exit rather than the campaign's state; scripts wrapping the CLI must special-case it. That is friction rather than harm, but it is friction the plan's `send` deliberately avoids.
- **Smallest simpler alternative:** `resume` mirrors `send`: `resumeCampaign` → `not-paused` → return `get(campaignId)` with no error; the route's errors are `BadRequestNoContent, NotFound, StorageUnavailable`; `CampaignNotPaused` is not created; the CLI `resume` command prints the campaign and exits 0 like `send`. ADR-0011's "gains one" becomes "gains none".
- **Exception / boundary check:** No authorization or data invariant hinges on the 409: `resumeCampaign`'s conditional write already guarantees that only a `paused` campaign is moved to `queued`. The response body shows the state either way.
- **Required behavior and simplification risk:** The Outcome's "a `resume` endpoint and CLI command" is preserved. Risk: an operator who meant `send` and typed `resume` on a draft sees a `draft` campaign printed instead of an error — the same signal `send` on a `completed` campaign gives today.
- **Bounded next step or user question:** Amend T1, T6, T7 and the ADR consequence as above before implementation.
- **Acceptance signal:** `grep -rn CampaignNotPaused packages apps` is empty; `Campaigns.test.ts` asserts that `resume` on a non-paused campaign enqueues nothing and returns the unchanged campaign; `Commands.test.ts` has no 409 case for `resume`.

### DEX-003 — Lowering the CLI request timeout replaces one documented rule with a second unrelated number

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** Plan T7: "Lower `requestTimeout` to 30 s (no request runs a send)". `apps/cli/src/Commands.ts:10-16` sets 70 s with the rule "sits above the API function's sixty seconds so that a send which runs long is answered by the service rather than abandoned by the caller". T6 keeps the API's 60 s (`Api.ts:33`, "the 60 s timeout stays").
- **Current-need evidence:** Nothing in the plan needs a shorter CLI deadline; the change is justified only by the send no longer running in-request. The rule the constant encodes is not send-specific: a deadline above the function's own timeout guarantees every request is answered by the service, not abandoned mid-flight by the client.
- **Added burden:** The comment must be rewritten to explain a number with no relation to the function timeout, and future readers must reason about two independent deadlines (30 s client, 60 s function) instead of one ordering rule.
- **Reachable practical impact:** A list delete cascade or a bulk import that runs between 30 and 60 s (ADR-0005 Consequences: "a cascade over a very large list can exhaust the request") is abandoned by the CLI while the function completes it. The operation is resumable, so the cost is a confusing error rather than data loss — but it is exactly the situation the current comment exists to prevent, reintroduced for no gain.
- **Smallest simpler alternative:** Delete that sentence from T7; `requestTimeout` and its comment stay untouched. If a shorter deadline is ever wanted, lower the function timeout first and keep the CLI above it.
- **Exception / boundary check:** No external contract depends on the CLI's timeout. The 70 s value costs nothing on fast requests.
- **Required behavior and simplification risk:** None affected; `send` returns as soon as the campaign is `queued` under either value.
- **Bounded next step or user question:** Remove the line from T7.
- **Acceptance signal:** `Commands.ts:10-16` is byte-identical after T7; T7's README edit does not mention a timeout.

## User-decision queue

| DEX ID  | Material decision                                                           | Evidence and options                                                                                                                                                                                                                                          | Recommendation |
| ------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| DEX-001 | Whether transient-bounce escalation belongs in the mass-sending lane at all | Outside the problem statement; widens the PutItem-only feedback capability; admittedly inexact count with no un-suppress path. Options: (a) cut T8 and the ADR clause, revisit with the reputation lane; (b) keep as planned, recording it as a user decision | Ask user       |

## Confirmed proportionate areas

- **Nine conditional transitions in T2.** They map one-to-one onto the state edges the at-least-once model needs (enqueue, resume, begin, claim, skip, settle, checkpoint, complete, pause), each with a distinct condition. Folding `enqueue`/`resume` or `complete`/`pause` into a parameterised operation is an implementer's call, not a complexity finding; the exact-request assertion style is the established one in `Storage/*.test.ts`.
- **Per-recipient skip rows plus a counter.** A counter alone double-counts on a redelivered page; the row's absence condition is what makes `skipped` exact under standard-queue redelivery (ADR-0011 Consequences). Keep.
- **`uncertain` as a settled state and counter.** `SubmissionUncertain` is a real outcome today (8 s timeout, transport, malformed response in `Mailer.ts`), and the plan keeps the rule that an uncertain row is never re-attempted. One more `ADD` slot in the same transaction is the whole cost.
- **`paused` with a reason, and the daily budget pause.** `daily-quota` and `sending-paused` call for different operator actions (wait versus fix the account), so the reason is a useful operator decision. Pause-and-resume needs no member count, unlike an up-front refusal (ADR alternative 8).
- **`EMAILER_DAILY_SEND_CEILING`.** Optional, one config read, one `min`. `wiki/aws/deliverability.md` calls for starting new domains small and increasing gradually; the ceiling is the smallest control that does it. Safe ops control, kept.
- **The DynamoDB `RateLimiterStore` and its compare-and-set reset.** The user chose the shared store. The library's contract resets the counter after an idle gap; a store that never reset would leave `expiresAt` in the past after a pause, the delay-mode arithmetic would compute zero delay, and the limiter would effectively be off until `count × refill` caught up with wall time. DynamoDB cannot express `max(expiresAt, now)` in one update, so the second conditional write on the observed `expiresAt` is the minimum; a bound of three calls then failing the slice (which SQS redelivers) is proportionate.
- **Three retries on `rate-limited`.** A throttle is a provably-unsent submission; settling it `rejected` at once loses a recipient to the other workload's burst. Three re-entries into the limiter is a small bounded loop; the count is a constant, not configuration.
- **`SendBudget.ts` as its own module.** A pure function over `GetAccount` with its own stubbed test. Whether it lives in its own file or beside the loop is style.
- **`Dispatch.ts` / `Dispatcher.ts` / `Dispatching.ts`.** The leaf module is forced by the bundle boundary in ADR-0004:47 (the API must import the queue without pulling the dispatcher's handler). Splitting the loop from the Function mirrors `Api.ts` + `Campaigns.ts`; keeping them together would mirror `Feedback.ts`. Both precedents exist, so the choice is style. The three near-identical names are worth a second look by the implementer, nothing more.
- **Feedback counts read by query in `get`.** The alternative — counters on META maintained by the feedback Lambda — would give that consumer `UpdateItem` on campaign items across a capability boundary. A bounded query on read is the smaller design.
- **Dead-letter queue and its alarm.** There is a concrete operator action: fix the cause and redrive, which re-delivers the wake-up that `beginRun` accepts for a `queued` or `sending` campaign with the same run token. Without the DLQ a poisoned message retries every 30 minutes for four days and then vanishes with no signal. Retention and `maxReceiveCount` follow `wiki/aws/sqs.md`; the alarm copies an existing declaration.
- **The 60-contact live gate.** The member page is 50, so two pages need at least 51 members; 60 costs three `lists import` calls and under a minute of simulator sends, and it is the only thing that proves cursor checkpointing against real `LastEvaluatedKey` values. A test-only page size would add configuration to save a few sends.
- **Visibility 30 min for a 5 min function; batch size 1; standard queue.** Per the wiki's 6× rule and the user's queue decision.

## Limitations

- Static review only: no deployment, unit run or SES quota read. The limiter arithmetic was traced in `RateLimiter.ts` source, not executed.
- The parent decides every disposition; DEX-002 and DEX-003 are advisory and small, and the parent may reasonably keep either.
- Routed to the defect/compliance reviewer, not judged here:
  - ADR-0011 says claimed-but-unsettled rows from a crashed slice "stay `uncertain`", but T2 settles `uncertain` only through `settleRecipient`; a crash leaves rows `unconfirmed`, so "counters equal the row states" does not hold after a crash.
  - A campaign whose wake-up dead-letters while `sending` has no API-level recovery: `send` returns the campaign without a wake-up and `resume` refuses (or, under DEX-002, returns). SQS redrive is the only path; the README should say so.
  - T9 imports 60 contacts through three `lists import` calls; the import cap of 20 and the plan's page size of 50 are unrelated numbers, which is fine, but the test's page-boundary assumption should be stated.
