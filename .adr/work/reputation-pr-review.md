# Code review: PR #5 — Reputation guardrails (alerts, breaker, operator address tools)

## Review constraints

| Axis             | Selection                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target           | PR #5, branch `reputation` at `771b67d`, base `main` at `fe6d59e`; worktree `~/worktrees/emailer/reputation`                                                          |
| Baseline         | Plan-backed: [`reputation.md`](reputation.md) T1–T9 and Final acceptance; [ADR-0012](../0012-reputation-guardrails.md) Decision, Consequences, Confirmation           |
| Scope            | Full plan and implementation, 48 files                                                                                                                                |
| Invocation       | Standalone, requested by the user on 2026-09-15                                                                                                                       |
| Output           | This report; no source edits                                                                                                                                          |
| Dimensions       | Correctness, Alchemy and Effect usage, runtime safety, IAM, tests and validation, docs, plan compliance                                                               |
| Validation/tools | `pnpm check`, `pnpm lint`, `pnpm typecheck`, `pnpm check:imports`, unit project, read-only AWS inventory (`example` profile), Alchemy beta.77 and distilled sources |
| Writes/artifacts | This file only; worktree and PR untouched                                                                                                                             |

## Summary

The implementation matches the plan and ADR-0012 in every decision that carries risk: the alarms, the bare topic, the cold-start-safe leaf module, the dispatcher guard ordering, the transactional counters with echo exclusion, the bounded conflict retry, the derived transient window, the SES-first un-suppress order and the IAM shape were all verified against the Alchemy and distilled sources. 541 unit tests pass; lint, typecheck and import checks pass. The live gate was run on `test-d` and the account holds no leftover `test-d` resource and no seed suppression entry.

Round 2 closed every finding (see Follow-up closure). The paragraph below records round 1 as delivered. Four things needed to change before merge: the repository check is red on a committed markdown file while the plan and PR claim it green; four unit tests cannot fail for the behaviour they name, one of which guards the production halt rule; the echo and ignored classification is computed twice from two copies of the same constants; and the extra `Retry.none` on `updateRecord` removes the client's transient retries from contact and list updates for no gain, since the client already retries conflicts there. The plan itself owned two of the defects (the `updateRecord` change and the simulator seed that SES rejects).

## Related decomplex review

- **Report:** none requested. The duplicated classification (F2) is the only complexity finding and is a deletion.
- **Owner disposition summary:** pending.

## Coverage

### Inspected

- Every source file in the diff, directly: `Reputation.ts`, `SendGuard.ts`, `Dispatching.ts`, `Dispatcher.ts`, `alchemy.run.ts`, `Mailer.ts`, `Feedback.ts`, `Addresses.ts`, `Api.ts`, `Storage/{Primitives,Feedback,Campaigns,Addresses,Audience,Items}.ts`, `packages/api/src/{Api,Schemas}.ts`, `apps/cli/src/Commands.ts`.
- Every test file in the diff and `Storage/Testing.ts`; the three integration cases and `IntegrationSupport.ts`.
- Alchemy beta.77 sources for `SNS/Topic`, `SNS/Subscription`, `CloudWatch/Alarm`, `CloudWatch/DescribeAlarms(+Http)`, `SES/ConfigurationSet`, `SES/ConfigurationSetEventDestination`, `SES/EmailEventSource`, `SES/BindingHttp`, `DynamoDB/TransactWriteItemsHttp`, `Runtime/Bootstrap/Lambda`; distilled `dynamodb` error classes and retry categories; Effect `Schedule.max`, `Config.option`.
- README, `.env.example`, wiki pages, the three `Superseded in part` headers, the plan and ADR text, the committed implementation review.

### Skipped or partial

- The live gate itself was not re-run; the stage is destroyed. Evidence is the implementer's record in the plan and PR plus the empty inventory below.
- `alchemy plan` output (IAM statements, resource diff) was not reproduced; grants were verified from the binding sources instead.

### Required boundaries

- Dispatcher cold start: the constructor now yields four alarms and the topic; verified that their props read only outputs and that `configurationSet` was already yielded there on `main`.
- Shared SES account: account-level alarms and `unsuppress` act on shared state by ADR decision.
- Simulator-only recipients: the only send path in the integration tree is `sendToSimulatorList`, which refuses non-simulator members; `seed+<runId>@example.com` is placed on the suppression list and never mailed.

## Validation

- **Run:** `pnpm exec vitest run --project unit` → 28 files, 541 passed. `pnpm lint` → 0. `pnpm typecheck` → 0. `pnpm check:imports` → 0. `pnpm check` → **fails** at `oxfmt --check` on `.adr/work/reputation-implementation-review.md`. Stale-term greps (`no notification channel`, `both alarms`, `readCampaignFeedback`, `SendBudget`, `DispatchBudget`, `SuppressionListUnavailable`, `PutItem\` and nothing else`) → no matches. `Schedule.max` verified empirically: exactly seven attempts on persistent conflicts.
- **Read-only AWS inventory** (`example` profile): no alarm, topic, function or table containing `test-d`; no `seed+` entry on the account suppression list.
- **Skipped/unavailable:** integration project (needs a deployed stage); `alchemy plan`.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** Good with two defects the implementation exposed. The plan prescribed `Retry.none` on `updateRecord`, which was unnecessary (F4), and a simulator seed address that SES refuses on `PutSuppressedDestination` (the implementer substituted `example.com`, recorded in the Handoff and ADR, but T8's Change text still names the simulator seed). The plan also split one classification rule across T2 and T5, which produced the duplication in F2. Everything else the plan named was exact and implementable.
2. **Implementation compliance:** 45 of 49 matrix rows Complete. T9.5 and Final-acceptance `pnpm check` are Incorrect (red at HEAD, claimed green). T7.1 Partial: the README promises the address reaches SES exactly as given, but the contract's `EmailAddress` schema lowercases the domain first. T8.5 is an approved deviation at agent level only (seed address); the user has not ratified it. Live-gate rows are supported by the implementer's record and the empty inventory, not by a re-run.
3. **Implementation quality beyond the baseline:** High. Runtime safety at cold start, grant shapes, error-class names, retry ordering (`Retry.none` innermost, business classification before the retry predicate, timeout outermost), integer breaker arithmetic, pause cursors and un-suppress ordering are all correct. The one structural weakness is F2.
4. **Test and validation quality:** Strong on storage and consumer boundaries (exact `TransactItems`, real `TestClock` windows, retry request counts). Four cases are false-green or tautological (F1); the `HEALTHY` gap is the one that matters, because it guards the rule that would otherwise pause every production campaign.

## Plan compliance matrix

Condensed; the full 49-row matrix with `path:line` evidence was produced in the compliance lane and is summarised by task here.

| Authority item / implied requirement                                                                                                                                                               | Expected evidence          | Implementation evidence                                                                                                                                                                            | Validation / test evidence                                                                                                                      | Status                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| T1 contract: pause reasons, `CampaignFeedback`, `AddressStatus`, `AddressRecord`, `AddressesGroup` with `[BadRequestNoContent, StorageUnavailable]`                                                | Schemas and group          | `packages/api/src/Schemas.ts:165-178, 193-261`; `Api.ts:188-208`                                                                                                                                   | `Schemas.test.ts:246-282, 391-480`; `Api.test.ts:1432-1454`                                                                                     | Complete                                                       |
| T2 storage: `campaignKey`/`strSet` in Items; conflict retry schedule and order; counters and baselines; transactional feedback ops; transient window; `unsuppress`; `readCampaignFeedback` deleted | Exact expressions          | `Storage/Items.ts:22-29`; `Primitives.ts:44-64, 157-192, 395-428`; `Campaigns.ts:63-67, 199-203, 257, 279, 331-335`; `Storage/Feedback.ts:117-263`; `Storage/Addresses.ts:29-34, 104-117, 177-313` | `Primitives.test.ts:416-527`; `Campaigns.test.ts:165, 307-355, 462-496`; `Storage/Feedback.test.ts:70-298`; `Storage/Addresses.test.ts:201-415` | Complete (see F4 for `updateRecord`)                           |
| T3 `Reputation.ts`: bare topic, thresholds, four alarms with exact props, `reputationAlarms`; Mailer `reputationMetricsEnabled`, `DELIVERY_DELAY`                                                  | Props exact, outputs only  | `Reputation.ts:16-122`; `Mailer.ts:15, 104`                                                                                                                                                        | Alarm props verified against `CloudWatch/Alarm.ts`; runtime services against `Bootstrap/Lambda.ts`                                              | Complete                                                       |
| T4 stack: topic, optional subscription, actions on three alarms, output, `.env.example`                                                                                                            | Stack wiring               | `alchemy.run.ts:10, 33-44, 64-65, 79-80, 94-95, 103`; `.env.example:22-24`                                                                                                                         | `Config.option` and `Subscription` props verified in sources                                                                                    | Complete                                                       |
| T5 consumer: `DeliveryDelay` member, `kinds`, six classifications, suppress-then-store, delay log, summary counts                                                                                  | Mapping and order          | `Feedback.ts:36-38, 70-79, 118-170, 218-285, 362`                                                                                                                                                  | `Feedback.test.ts:233-670`                                                                                                                      | Complete (see F2)                                              |
| T6 guard and breaker: `SendGuard`, `DispatchGuard`, order halted → daily → breaker, constants, `bouncing` skip, `DescribeAlarms` binding                                                           | Order and constants        | `SendGuard.ts:12-68`; `Dispatching.ts:25-28, 98-137, 168-187`; `Dispatcher.ts:63-65, 84-86, 112`                                                                                                   | `SendGuard.test.ts:19-150`; `Dispatching.test.ts:774-889`                                                                                       | Complete (see F1)                                              |
| T7 address module, API handlers, CLI                                                                                                                                                               | Domain, handlers, commands | `Addresses.ts:55-93`; `Api.ts:77-82, 179-218`; `Commands.ts:461-501`                                                                                                                               | `Api.test.ts:1347-1454`; `Commands.test.ts:861-897`                                                                                             | Partial: README exact-match promise vs normalising schema (F3) |
| T8 live gate: helpers, three cases, simulator-only sends, seed                                                                                                                                     | Cases as specified         | `IntegrationSupport.ts:68-77, 238-404`; `Api.integration.test.ts:241-450`                                                                                                                          | Implementer's run; inventory empty                                                                                                              | Approved deviation (seed `example.com`, agent-level)           |
| T9 docs and lifecycle: README sections, wiki, ADR headers, `pnpm format:check` clean                                                                                                               | Sections and commands      | `README.md:70-361`; wiki rows; ADR-0003/0008/0011 headers                                                                                                                                          | Greps clean; **format check red**                                                                                                               | Incorrect (F3)                                                 |
| ADR-0012 decisions D1–D9 and consequences C1–C2                                                                                                                                                    | As above                   | As above                                                                                                                                                                                           | As above                                                                                                                                        | Complete                                                       |
| ADR-0012 Confirmation: gate observed, stage destroyed                                                                                                                                              | Observed run               | ADR `:61`, plan Handoff, PR body                                                                                                                                                                   | Inventory empty for `test-d` and `seed+`                                                                                                        | Complete on record; not re-run                                 |

### Approvals and conflicts

- **Approved deviation:** seed address `seed+<runId>@example.com` instead of a simulator address, because SES rejects simulator addresses on `PutSuppressedDestination`. Never mailed. Approval is the implementing agent's; recorded in the plan Handoff, the PR body and ADR-0012 `:61`. The user should ratify it.
- **Authority conflict:** plan T8 Change text (`reputation.md:196`) still names the simulator seed; the Handoff and the test use `example.com`. Plan tasks T2–T9 each carry both `Status: Verified` and a stale `Status: Pending`. The committed implementation review (`reputation-implementation-review.md:91`) says the Handoff "still says then destroy" while the Handoff in the same commit says destroyed. ADR-0012 was accepted on `main` before the observed-run paragraph existed.

## Follow-up closure

- **Round and material delta:** round 2, 2026-09-15, after the user's decisions: `.adr` is not formatted, and every other finding is fixed for the cleanest result rather than the smallest patch. Branch `reputation` gained six commits on top of `771b67d`.
- **Closure state:** Clear
- **Resolved or withdrawn:**
  - F1 (four tests that could not fail) → resolved in `ed541f1`: `HEALTHY` → not halted; alarm before enforcement; the tautological resumed-baseline case deleted and replaced by two precedence cases (halt over quota, quota over breaker); CLI fakes answer `status` and `unsuppress` differently; API cases for a present BOUNCE entry, the exact address reaching SES, NotFound on delete, and a 503 naming the delete.
  - F2 (two owners for the classification) → resolved in `670536e`: `apps/backend/src/FeedbackClassification.ts` owns the event schema and one decision table (classification, suppress, history outcome, write); the store's two operations became `recordFeedback(row, write)` and its copies of the subtype sets are gone. The consumer and the store derive nothing. `FeedbackClassification.test.ts` pins the table; the consumer and store suites test wiring and `TransactItems` respectively.
  - F3 (check red, documents contradict the tree) → the formatter part withdrawn by the user's decision and implemented as `.adr/**` in the formatter's ignore list (`8dd357c`); the plan's T8 seed text, the stale `Pending` lines, the implementation review's teardown line and the Handoff updated in `adcd913`. The README exact-match sentence stays: it was right, the code was wrong (see below).
  - F4 (`Retry.none` on `updateRecord`) → resolved in `8dd357c`: the primitive is back to its `main` shape; the plan, ADR-0012 and the DynamoDB wiki page describe the retry on the two conditional primitives only.
  - T7.1 (address case) → reclassified from a docs note to a code defect and resolved in `d57d38e`: AWS documents that suppression-list management calls require an exact case match, so the address endpoints and CLI flags decode through the new `Schemas.ListedEmailAddress`, which trims but never changes case. The wiki SES page records the rule and the simulator restriction on `PutSuppressedDestination`.
  - Guard reads run concurrently (`ed541f1`), as suggested in the review's optional item.
- **Still material:** none.
- **New fix-caused or fix-exposed findings:**
  - The live run exposed two racy assertions in the pre-existing integration suite: the API re-reads the campaign after enqueueing it, so a two-member campaign can already be `sending` or `completed` in the send response. Fixed in `77d0ed7`; not caused by this lane.
  - Observed once during the live run, not fixed, for the user to decide: a DynamoDB `InternalServerError` on `settleRecipient` killed a dispatcher invocation, and the campaign then waited for the dispatch queue's 30-minute visibility lease before SQS redelivered it. That is ADR-0011's documented recovery path, but a real AWS 500 costs a 30-minute stall. A repeated settle is safe to retry: its condition (`unconfirmed` with the same `sendId`) can only fail because the earlier attempt applied, since no other writer settles a claimed row. Treating that condition failure as success would let `settleRecipient` keep the client's transient retries. Out of this PR's scope; belongs to the mass-sending lane.
- **Live verification (round 2):** stage `test-e` deployed from `77d0ed7` with `EMAILER_ALERT_EMAIL` unset; the integration project ran with 22 cases: 19 passed on the first run, the breaker and concurrency cases passed on rerun after the stall above, the feedback case passed after the assertion fix. Every case that sends used labelled simulator addresses; the un-suppress case seeded and removed `seed+<runId>@example.com`. Stage destroyed afterwards (26 resources); a read-only inventory found no `test-e` alarm, topic, function, table, queue, log group, rule or role, and no `seed+` entry on the account suppression list.

## Findings

### S2 — Four unit tests cannot fail for the behaviour they name

- **Dimension / authority:** tests; plan T6 Tests, T7 Tests
- **Location:** `apps/backend/src/SendGuard.test.ts:122-147`; `apps/backend/src/Dispatching.test.ts:875-888`; `apps/cli/src/Commands.test.ts:320-337, 860-898`; `apps/backend/src/Api.test.ts:1409-1428`
- **Impact:** the guard rule `EnforcementStatus !== undefined && !== "HEALTHY"` has no case with `"HEALTHY"`; change it to `!== undefined` and all eight guard tests stay green while every real campaign pauses `reputation`. The "resumed run whose baseline equals the counters" case is byte-for-byte the default World and proves nothing (the real protection is `Storage/Campaigns.test.ts` "projects run deltas"). The CLI fakes return identical bodies for `status` and `unsuppress`, so wiring `unsuppress` to `status` passes. The `NotFoundException` branch on `deleteSuppressedDestination` and the present-entry mapping (`BOUNCE`/`COMPLAINT`, `LastUpdateTime` to ISO) are exercised only by the live gate.
- **Evidence:** `grep -c '"HEALTHY"' SendGuard.test.ts` → 0; the Dispatching case's `run` equals `emptyWorld()`; Commands fakes at `:320-337`; the Api fake's get always fails NotFound and its delete always succeeds.
- **Confidence:** C3
- **Condition:** any future edit to those rules.
- **Validation state:** confirmed by reading the fakes.
- **Smallest safe fix / validation:** add `account(healthy, "HEALTHY")` → `halted: none`; delete the tautological Dispatching case and point the review doc at the Storage test; make the CLI fakes return different `status` values; add two `Api.test.ts` cases (delete fails NotFound → record returned; get succeeds with a BOUNCE entry → non-null `accountSuppression`). Optionally one precedence case with `halted` and `dailyExhausted` both set → `reputation`.

### S2 — Echo and ignored classification has two owners

- **Dimension / authority:** simplicity and correctness; ADR-0012 "echoes suppress and record but do not count"
- **Location:** `apps/backend/src/Feedback.ts:36-38, 118-170` and `apps/backend/src/Storage/Feedback.ts:77-79, 183-263`
- **Impact:** the consumer computes `classification` (which drives suppression and the logged counts) from its Sets, then passes only the raw subtype strings; the store recomputes echo, permanent and ignored from identical Sets to choose counter versus transient versus history-only. Editing one Set and not the other silently makes an address suppressed while the counter still increments, or the reverse, and the breaker trips on echoes it must not count.
- **Evidence:** both Sets are identical copies; `persist` (`Feedback.ts:172-205`) discards `classification`.
- **Confidence:** C3
- **Condition:** any future change to echo or ignored subtypes.
- **Validation state:** no runtime defect today; the copies agree.
- **Smallest safe fix / validation:** pass the consumer's `classification` into `recordBounce`/`recordComplaint` and delete the store's Sets and predicates; the store then switches on the tag alone. `Storage/Feedback.test.ts` shapes stay; the store tests take the tag as input.

### S2 — Repository check is red and three documents contradict the tree

- **Dimension / authority:** validation and docs; plan T9 Verify, Final acceptance; repository rule that lint and check failures are fixed
- **Location:** `.adr/work/reputation-implementation-review.md` (format); `.adr/work/reputation.md:196` and per-task `Status:` lines; `.adr/work/reputation-implementation-review.md:91`; `README.md:130-134`
- **Impact:** `pnpm check` fails at `oxfmt --check` on a file this commit adds while the plan (`:210`, `:229`) and the PR body claim it green. The plan's T8 text still specifies the simulator seed the implementation had to abandon; every task carries a stale `Status: Pending` beside `Verified`; the committed review contradicts the Handoff on whether the stage was destroyed. The README tells operators the CLI honours SES's case-sensitive exact match, but the `EmailAddress` schema lowercases the domain before the address reaches SES.
- **Evidence:** `pnpm check` output; greps in this review.
- **Confidence:** C3
- **Condition:** always.
- **Validation state:** confirmed.
- **Smallest safe fix / validation:** `pnpm format`; update T8's Change bullet to the `example.com` seed and drop the stale `Pending` lines; fix the review's line 91; reword the README to say the address is normalised (domain lowercased) before lookup, or drop the exact-match sentence.

### S2 — `Retry.none` on `updateRecord` removes transient retries from contact and list updates

- **Dimension / authority:** resilience and simplicity; plan T2 (which prescribed it)
- **Location:** `apps/backend/src/Storage/Primitives.ts:157-166`
- **Impact:** `updateContact` and `renameList` are the only callers. On `main` they ran under distilled's default policy, which already retries throttling, 5xx, network errors and `TransactionConflictException` (marked retryable in distilled's `dynamodb.ts`). The PR switches those retries off and adds our own conflict-only retry, so a single throttled or 5xx attempt now surfaces as a 503 to the CLI user. The lost-response argument that justifies `Retry.none` on `updateIf` and `runTransaction` does not apply here: a repeated `updateRecord` that already applied still satisfies `attribute_exists` and sets the same values.
- **Evidence:** `main:Primitives.ts:112-119` has no `Retry.none`; distilled `services/dynamodb.ts` marks `TransactionConflictException` retryable; callers at `Storage/Contacts.ts:338`, `Storage/Lists.ts:111`.
- **Confidence:** C3
- **Condition:** DynamoDB throttling or a transient error during a contact or list update.
- **Validation state:** reasoning from sources; no repro needed.
- **Smallest safe fix / validation:** revert `updateRecord` to its `main` shape (no `Retry.none`, no `conflictRetry`); keep both on `updateIf` and `runTransaction`. Update the T2 bullet and the doc comment accordingly. This was a plan defect, not an implementer's.

## Context-dependent concerns

- **Concern:** the seed address for the un-suppress gate is `seed+<runId>@example.com`, placed on the shared account suppression list and deleted in `ensuring`. It is never mailed and the inventory shows none left behind.
- **Disposition:** for the user to ratify; the standing rule concerns recipients, which this is not.

## Confirmed-good areas

- `Reputation.ts` is cold-start safe: no deploy-only service is read, and `configurationSet` was already yielded by the dispatcher on `main`.
- Alarm props, `DescribeAlarms` grant on `*` with injected names, `Subscription` props, `reputationMetricsEnabled`, `DELIVERY_DELAY` literal and the `delivery-delay` kind all match the beta.77 sources.
- Conflict retry: `Retry.none` innermost, business classification before the retry predicate, timeout outermost; exactly seven attempts; mixed cancellations not retried; lost responses not retried.
- Transactional counters: redelivery cancels the whole transaction; multi-recipient events write one row and one increment per recipient; `unknown-campaign` leaves no history row.
- Breaker boundaries, pause cursor, guard order, `bouncing` skip through the existing path.
- Un-suppress: SES delete first, local deletes unconditional, opt-out untouched.
- API role gains the two suppression actions and not `ses:SendEmail`; feedback role gains the transaction grant.
- Integration suite sends only to simulator addresses; cleanups run through `Effect.ensuring`.
- No `test-d` alarm, topic, function or table remains; no `seed+` entry on the account list.

## Limitations and caveats

- The live gate was not re-run; its outcomes rest on the implementer's record and the empty inventory.
- `alchemy plan` was not reproduced; IAM statements were verified from binding sources.

## Next steps

1. Apply F1–F4 on the `reputation` branch, run `pnpm check`, push, and re-request closure.
2. Ratify or reject the `example.com` seed address.
