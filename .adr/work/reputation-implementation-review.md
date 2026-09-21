# Code review: Reputation guardrails implementation (T1–T9)

## Review constraints

| Axis | Selection |
|---|---|
| Target | Branch `reputation` vs `main` (`fe6d59e`); full uncommitted + untracked implementation of `.adr/work/reputation.md` T1–T9 |
| Baseline | Plan-backed: `.adr/work/reputation.md` (full) and accepted [ADR-0012](../0012-reputation-guardrails.md). Parent-authorized T8 seed deviation. |
| Scope | Full plan T1–T9 as implemented. Out of scope: new features. |
| Invocation | Standalone, independent adversarial implementation review |
| Output | `.adr/work/reputation-implementation-review.md` |
| Dimensions | Correctness, types/trust boundaries, security/data, APIs/ops, tests/validation, plan compliance |
| Validation/tools | Source inspection of implementation, tests, Alchemy/Distilled types, wiki/ADR/README; repo greps; relative-link scan. Unit/integration/`pnpm check` and the live `test-d` gate were **not** re-executed this round. |
| Writes/artifacts | This report only. No source edits, no commit, no further agents. |

## Summary

The T1–T9 implementation matches accepted ADR-0012 and the plan. Guard, breaker, counters, echo exclusion, transient window, delay log, operator SES path, conflict retry, and the leaf `Reputation.ts` (no deploy-only services in props) are present in code with unit tests that protect the stated boundaries. The only intentional difference from the T8 text is the parent-authorized un-suppress seed (`seed+<runId>@example.com`). No admitted S4–S2 findings.

**Closure: Clear.**

## Related decomplex review

- **Report:** [reputation-decomplex.md](reputation-decomplex.md)
- **Owner disposition summary:** DEX-001 log-only delays; DEX-002 address ops on `AudienceStore`; DEX-003 bare topic, add policy only if notify fails; DEX-004 `StorageUnavailable` with SES `operationId`; DEX-005 no untagged-transient branch. All five are visible in the code reviewed here.

## Coverage

### Inspected

- Authorities: `.adr/work/reputation.md` (full), `.adr/0012-reputation-guardrails.md` (full); headers of ADR-0003/0008/0011.
- New/renamed: `apps/backend/src/{Reputation,SendGuard,Addresses,SendGuard.test}.ts`.
- Storage: `Storage/{Primitives,Feedback,Addresses,Campaigns,Audience,Items}.ts` and the matching unit tests (conflict retry, TransactItems shapes, window, baselines).
- Runtime: `Feedback.ts`, `Dispatching.ts`, `Dispatcher.ts`, `Mailer.ts`, `Api.ts`, `alchemy.run.ts`.
- Contract/CLI: `packages/api/src/{Schemas,Api,Schemas.test}.ts`, `apps/cli/src/Commands.ts`, `Api.test.ts`, `Commands.test.ts`, `Dispatching.test.ts`, `Feedback.test.ts`.
- Gate helpers/cases: `apps/backend/test/IntegrationSupport.ts`, `Api.integration.test.ts` (breaker/gate/un-suppress), `Feedback.integration.test.ts`.
- Docs: README (alarms, IAM, CLI, teardown), `.env.example`, `wiki/aws/{deliverability,sns-and-feedback,dynamodb}.md`, `wiki/alchemy/version-specific-traps.md`.
- Installed types/bindings: Distilled `SuppressedDestination.LastUpdateTime: Date`; Alchemy `DescribeAlarmsHttp` injects names and grants `cloudwatch:DescribeAlarms` on `*`.

### Skipped or partial

- Did not re-run `pnpm check`, unit, or integration tests.
- Did not re-deploy, re-read the operator mailbox, or inventory-destroy `test-d`. Live-gate rows rest on ADR-0012 Confirmation plus the parent’s authorized note, not a fresh run.
- Did not read every unchanged line of large fixtures (`Api.test.ts` campaign fakes beyond addresses/`feedback`; full `Commands.test.ts` in-memory service).
- Alchemy `Topic`/`Alarm`/`ConfigurationSet` providers were not re-read beyond the plan’s citations and `DescribeAlarmsHttp.ts`.

### Required boundaries

- Dispatcher cold-start path that yields `reputationAlarms` → topic + configuration-set **outputs** only.
- Feedback role `TransactWriteItems` + API SES suppression + dispatcher `DescribeAlarms`.
- Two writers on campaign META (conflict retry in primitives, client `Retry.none` retained).
- Account suppression list shared with any other SES sender on the account (`unsuppress` order: SES then local).
- Campaign contract `feedback` + pause reasons `reputation`/`feedback`.

## Validation

- **Run:** `git diff main --stat` (43 files, +2950/−615, plus untracked `Reputation.ts` / `Addresses.ts` / `SendGuard.ts` / `SendGuard.test.ts`). Grep: no `readCampaignFeedback`, `feedbackReads`, `SuppressionStore`, `SendBudget`, `DispatchBudget`, `SuppressionListUnavailable`, `no notification channel`, `Both alarms` / `both alarms`. No remaining `PutItem and nothing else`. Relative-link scan over `README.md`, `.adr/**/*.md`, `wiki/**/*.md`: no real broken targets (the ` [ADR-0012](…)` in the plan’s T9 prose is an ellipsis, not a path). Distilled `LastUpdateTime` is `Date`.
- **Skipped/unavailable:** `pnpm check` / unit / integration / alchemy plan / live `test-d` / teardown inventory. Work-document checkboxes were not treated as proof.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** The accepted ADR and the plan are complete enough to implement: thresholds, echo rules, breaker minima, window, delay log-only, no SES-side pause, cold-start constraint, IAM widening, and a live gate with fail-fast on `completed`. The T8 simulator-seed vs `PutSuppressedDestination` conflict was found in research and then overridden by a parent-authorized `example.com` seed. No authority conflict that would force Unverifiable rows. **Judgment: adequate. Confidence: C3.**

2. **Implementation compliance:** Matrix is Complete except the T8 seed (Approved deviation) and live teardown (Unverifiable this round). Code matches T1–T7 and T9; T8 cases exist in the integration project and match the authorized seed. **Judgment: compliant. Confidence: C3 for source; C2 for live-gate observation (not re-run).**

3. **Implementation quality beyond the baseline:** No extra material defect cleared the admission gate. Fail-open on an empty `DescribeAlarms` payload is the plan’s mapping (`any returned MetricAlarms[].StateValue === "ALARM"`); the binding injects the four names and the reported gate paused on a forced `ALARM`. Echo rules are duplicated in `Feedback.ts` and `Storage/Feedback.ts` but currently agree and are tested at both layers. **Judgment: no admitted beyond-baseline findings. Confidence: C2.**

4. **Test and validation quality:** Unit tests protect the contract, TransactItems shapes, echo/transient/delay paths, guard mapping, breaker boundaries (199/200×10/9, 1000/999 complaints), resumed baseline, bouncing skip, conflict retry (including mixed cancellation and seven conflicts), window edges, SES-before-storage un-suppress, and CLI output. Integration cases implement breaker (400, fail-fast `completed`), `SetAlarmState` gate, and seeded un-suppress. Delay and transient window have no live SES simulator analogue (ADR consequence; unit only) — that is the plan, not a silent gap. **Judgment: tests protect claimed acceptance. Confidence: C3 for test source; C2 for green runs (not re-executed).**

## Plan compliance matrix

| Authority item / requirement | Expected evidence | Implementation evidence | Validation / test evidence | Status |
|---|---|---|---|---|
| T1 Pause reasons `reputation`/`feedback`; `CampaignFeedback` on sending/paused/completed | Schema + API group | `packages/api/src/Schemas.ts:165-210`; `PauseReason` at `:172-178` | `Schemas.test.ts` each-member decode; `it.each` includes both new reasons | Complete |
| T1 `AddressRecord` / `AddressStatus`; `accountSuppression` `NullOr`; timestamps ISO UTC | Schema shape | `Schemas.ts:226-261` (`Timestamp`, `NullOr`) | `Schemas.test.ts` AddressRecord round-trips with/without optional rows and `null` account | Complete |
| T1 `AddressesGroup` query `email`, prefix `/addresses`, auth, errors | `Api.ts` group registered | `packages/api/src/Api.ts:188-208` | Backend/CLI handlers exist; `Api.test.ts` 401 without token | Complete |
| T2 Campaign counters + enqueue/resume baselines + `beginRun` run deltas + `submissionOf.feedback` | Stored fields, expressions, projection | `Storage/Campaigns.ts:63-67,119,198-203,256-257,278-279,331-335`; `campaignKey` in `Items.ts:26-29` | `Storage/Campaigns.test.ts` init, enqueue/resume expressions, `run` 7/3/2 from 10−3 / 4−1 | Complete |
| T2 `SkipReason` includes `bouncing`; delete `readCampaignFeedback` | Type + no leftover reader | `Campaigns.ts:74`; grep: no `readCampaignFeedback`/`feedbackReads` | Dispatching skip test; grep clean | Complete |
| T2 Conflict retry in primitives; `Retry.none`; lost responses not retried | Bounded retry, conflict-only | `Primitives.ts:44-64,157-192,395-428` (`Schedule.max` + `recurs(6)`, jittered 50ms) | `Primitives.test.ts`: second-attempt success (2 requests); condition-only not retried; mix not retried; 7 conflicts → unavailable | Complete |
| T2 Feedback transactions: permanent+count, echo Put-only, transient `SET v` + `ADD` SS, no META | Exact TransactItems | `Storage/Feedback.ts:143-265,289-297` (`PutItem` + `TransactWriteItems`) | `Storage/Feedback.test.ts` shapes for permanent, both echo subtypes, transient/undetermined, duplicate vs unknown-campaign indexes | Complete |
| T2 `addressStatus` one consistent batch of three keys; window 3/30d; `unsuppress` two Deletes; ops on `AudienceStore` | Batch + derive + writes | `Addresses.ts:29-34,174-313`; `Audience.ts:29-30` | `Addresses.test.ts` one batch, precedence, exactly-three in window, two-in/one-out, unsuppress keys, leaves opt-out | Complete |
| T3 `reputationMetricsEnabled`; `DELIVERY_DELAY`; leaf `Reputation.ts` no Function, no AWSEnvironment/Config | Mailer + Reputation module | `Mailer.ts:13-16,104`; `Reputation.ts:16-122` (bare `Topic("Alerts")`; alarms read `topicArn` / `configurationSetName` only) | No unit harness (plan); live gate is the cold-start proof (not re-run). oxlint/typecheck not re-run | Complete |
| T3 Four alarms, thresholds 0.02/0.0005 set and 0.05/0.001 account; `Maximum`, 3600, 1 period, `>=`, `ignore`, actions on topic | Alarm props | `Reputation.ts:22-113` | Code matches ADR/plan values | Complete |
| T4 Stack yields topic+alarms; optional email sub; existing three alarms gain actions; output `alertsTopicArn`; `.env.example` | `alchemy.run.ts` + env | `alchemy.run.ts:33-104`; `.env.example:22-24,42-44` | No stack unit harness. `pendingConfirmation` unread. Logical IDs unchanged (in-place update, not replace) | Complete |
| T5 Delay union member; `kinds` include `delivery-delay`; classify echo/transient/complaint/delay | Consumer | `Feedback.ts:49-80,118-170,361-362` | `Feedback.test.ts` delay log once/no storage; no expirationTime; untagged delay; echo/transient/not-spam; unknown-campaign still suppresses | Complete |
| T5 `suppress = echo \|\| !ignored` for complaints; suppress then record; summary counts | Parent fix + record loop | `Feedback.ts:166,231-285` | Complaint echo suppresses; `not-spam`/`auth-failure` do not; summary `bounced/complained/echoes/transient` | Complete |
| T6 `SendGuard` halt mapping; order halt → quota → breaker; integer breaker constants | Rename + `runSlice` | `SendGuard.ts:52-69`; `Dispatching.ts:25-28,98-137`; `Dispatcher.ts:64-86,112` | `SendGuard.test.ts` ALARM among four, OK/INSUFFICIENT_DATA, PROBATION/SHUTDOWN, missing status; `Dispatching.test.ts` reputation before claim/limiter; 199/200×10/9; 1000/999; resumed zeros; bouncing skip | Complete |
| T7 Domain `status`/`unsuppress`; SES first; NotFound → null; other SES → `StorageUnavailable`; CLI commands | Addresses + Api + CLI | `Addresses.ts:55-93`; `Api.ts:77-82,179-218`; `Commands.ts:461-500` | `Api.test.ts` NotFound null, 503 `getSuppressedDestination`, sequence delete→unsuppress→record→get; CLI prints record exit 0 | Complete |
| T8 Live gate: breaker 400, fail-fast completed, `SetAlarmState`, un-suppress | Integration project | `Api.integration.test.ts:241-452`; `IntegrationSupport.ts:68-77,260-362`; `Feedback.integration.test.ts:64-73` uses `feedback` on get | Cases present. Live green **not** re-run; ADR-0012 Confirmation + parent note | Complete (run reported; not independently re-executed) |
| T8 Un-suppress seed originally `success+…@simulator.amazonses.com` | Seed + poll + finally delete | Implemented as `seed+${runId}@example.com` (`Api.integration.test.ts:408-409`) with comment that SES rejects simulator addresses on Put | Parent-authorized; never mailed; finally deletes | **Approved deviation** |
| T8 Teardown: no `test-d` leftovers | Inventory after destroy | ADR Confirmation and the work-doc Handoff both record the stage as destroyed | Not inventoried this round; the [PR review](reputation-pr-review.md) inventoried the account and found no `test-d` resource | Complete |
| T9 README alarms/notifications/pauses/CLI/IAM/teardown/weekly duties; wiki; ADR headers; greps | Docs | README `:318-370`, `:244`, `:268`; wiki deliverability/sns/dynamodb/traps; ADR-0003/0008/0011 `Superseded in part`; ADR-0012 Accepted + Confirmation | Stale-phrase greps clean; relative links of real paths resolve | Complete |
| ADR-0012: no SES-side pause; dispatcher reads alarms + enforcement | No set disable; pause `reputation` | No `sendingEnabled: false`; `SendGuard` + `pauseRun(..., "reputation")` | Gate case asserts `reason === "reputation"` | Complete |
| ADR-0012: echoes do not increment counters; transients never suppress | Classification + storage | `Feedback.ts:132-149`; `Storage/Feedback.ts:189-221` | Storage + Feedback unit tests | Complete |
| ADR-0012: delays published and logged, not stored | Event destination + log | `Mailer.ts:104`; `Feedback.ts:218-226` | Delay tests: zero storage calls | Complete |
| Implied: `LastUpdateTime` must encode as `Timestamp` | ISO UTC with ms | Distilled type is `Date`; `Addresses.ts:51` `toISOString()` | Schema `Timestamp` requires `.sssZ`; `Date.toISOString()` matches | Complete |
| Implied: DescribeAlarms grant is `*` | Binding policy | `DescribeAlarmsHttp.ts:28-33` `Resource: ["*"]` | README IAM sentence; plan T4/T6 | Complete |

### Approvals and conflicts

- **Approved deviation:** T8 un-suppress seed uses `seed+<runId>@example.com` because SES `PutSuppressedDestination` returns `BadRequestException` for `simulator.amazonses.com`. Scope: that integration case only. Rationale: simulator addresses cannot be seeded on the account list. Consequence: never mailed; `finally` still deletes; local suppressed+null account is covered by the breaker bounce sample. Source: this review’s parent authorization (and ADR-0012 Confirmation).
- **Authority conflict:** none between the accepted ADR and the plan as implemented.

## Follow-up closure

- **Round and material delta:** Round 1 (no prior implementation-review finding IDs).
- **Closure state:** Clear
- **Resolved or withdrawn:** n/a
- **Still material:** none
- **New fix-caused or fix-exposed findings:** none

## Findings

None admitted. Candidates that failed the gate (empty `MetricAlarms` fail-open is the specified mapping; echo logic is duplicated but consistent; delay `expirationTime` is `optionalKey(String)` while bounce/complaint optionals are `NullOr` — AWS samples include a string `expirationTime`, and an absent field is already tested) are omitted.

## Context-dependent concerns

- **Concern:** `test-d` teardown is an acceptance item and is not independently verified here (ADR Confirmation vs Handoff disagree).
- **Disposition:** Operational follow-up for the owner; not a code defect. Inventory after destroy remains the check.

- **Concern:** Unit and `pnpm check` were not re-run in this review.
- **Disposition:** Source of the named suites was inspected; a red suite would be a process miss, not a hidden logic hole found in the diff.

## Confirmed-good areas

- Cold-start constraint: `alertsTopic` has no props; alarm props yield resources and read outputs only; `EMAILER_ALERT_EMAIL` is Stack-level (`alchemy.run.ts:36-44`), not on the dispatcher path.
- Breaker uses integer arithmetic on run deltas from `ALL_NEW` after enqueue/resume copy baselines; resume-to-zero is tested.
- Conflict retry classifies DynamoDB “applied nothing” vs condition outcomes; mixed `ConditionalCheckFailed`+`TransactionConflict` is unavailable, not retried.
- `unsuppress` deletes SES first, then local suppression+transient, never the opt-out; API 503 uses the SES operation id.
- Delay path cannot write: classify `delay` returns before `FeedbackStore` is taken.

## Limitations and caveats

- Live-gate mail, breaker pause, and SNS confirm are accepted as reported (ADR-0012 Confirmation + parent). This review did not observe AWS.
- Transient window and delay logging remain unit-only, as the simulator has no soft-bounce or delay address (ADR consequence).
- Work-document task statuses were ignored except as pointers to files.

## Next steps

1. Owner: destroy `test-d` if it is still present and confirm inventory (functions, table, seven alarms, topic, subscription, log groups, roles, rule).
2. No code changes required for this review’s findings (there are none).
3. Merge/PR is an owner decision; this review does not authorize merge.
