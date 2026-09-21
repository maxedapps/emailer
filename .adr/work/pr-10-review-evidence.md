# PR #10: independent review evidence

- Reviewed head: `0516864d3419af564f6267de581500a5d591b2f4`.
- Remote target and merge base: `9cd7e40f4f939376f225aaa0d74fea4dddbad4e8`.
- Local main began at `0835af2` with a clean working tree; its extra commit records PR #9's review only.
- Scope: PR #10's complete diff and scheduling integration boundaries. The accepted scheduling plan T1–T7 and ADRs 0011, 0013, 0014 and 0015 supply the baseline. PR #9 remains a separate change.
- Outcome: **Changes required — one S2/C3 finding, F1**. The walkthrough's R1–R2 are conditional deployment/accepted operating risks, not additional admitted code defects.
- This is a second opinion after the implementation review. No earlier finding is reopened, and no accepted ADR or work-plan status is changed. No new architecture decision is introduced.
- Method: parent review and synthesis plus three bounded read-only lanes: domain/storage races, Scheduler/infrastructure, and API/CLI/tests. Parent independently reproduced the admitted finding and verified the dependency evidence behind rollout risk.

## Finding F1

**P2 / S2 / C3: reject impossible calendar dates before replacing the current schedule.**

Primary diff location: `packages/api/src/Schemas.ts:319`. Supporting changed locations: `apps/backend/src/Campaigns.ts:175–186`, `apps/backend/src/Api.ts:222–240`.

`Timestamp` at `Schemas.ts:65` only checks a regular expression. The new public scheduling payload reuses it without validating that the input denotes an actual date. `Date.parse` of an invalid month is NaN, which passes the domain's `<= currentTimeMillis` rejection check. Invalid days may normalize to a different date instead, while the adapter retains the original string.

An authenticated reschedule thus invalidates an existing good run token, stores the invalid timestamp, and proceeds to the Scheduler adapter. That adapter deletes the good timer before attempting the invalid replacement. Rejection is mapped to 503 with no rollback, leaving the original scheduled delivery lost until operator intervention. The existing stale-token safeguard prevents the old timer from repairing the situation.

Smallest repair: refine the scheduling input with finite parse plus canonical UTC round-trip validation before any write. Keep malformed instants as HTTP 400; reserve 409 for valid instants at/before now. A regex expansion or NaN-only check does not fully cover invalid-calendar normalization. Add real-router cases for invalid month and non-leap February 29 that assert preservation of the old state and zero scheduling mutations.

This is a baseline omission as well as an implementation defect: the plan explicitly selected the existing Timestamp schema but did not inspect its calendar-validity behavior. It is unrelated to the accepted concurrent-reschedule and near-future timing limitations.

## Validation

| Check | Observed result |
| --- | --- |
| `pnpm install --frozen-lockfile --dir /home/operator/worktrees/emailer/pr-10-review` | Passed; dependencies installed in the detached checkout and Effect compiler/linter patches applied |
| `pnpm check` | Passed on first attempt: formatting, deny-warnings lint, typecheck, 625/625 unit tests across 29 files, imports |
| Unit phase duration | 28.02 seconds; no retries or timeout/config changes |
| Real router + production domain, invalid-date probes | Both impossible dates passed request validation, replaced stored timestamp/token, and reached schedule service; controlled service rejection returned 503 |
| Router controls | `nonsense` returned 400 without mutations; valid future canonical date returned 200 and reached the schedule service |
| Manual real CLI process + local HTTP server | Zone-less and explicit-offset inputs normalized identically under Europe/Berlin; malformed text exited 1 without a request; cancel exited 0 with draft output |
| GitHub check at reviewed head | SUCCESS; [check run](https://github.com/maxedapps/emailer/actions/runs/35216597895/job/105186431193) |
| AWS integration/deploy/teardown | Not independently rerun; author records 26/26 cases and destruction of test-sched in ADR-0015/T7 |

### Router probe details and limits

The parent imported `makeApiHandler`, the real API schemas, production campaign handlers/domain, and NodeCrypto from the fresh PR checkout. An Effect scope owned the handler and layers. A minimal CampaignStore double began with a valid scheduled campaign and existing token; its schedule operation recorded the replacement. A CampaignSchedule double recorded invocation and returned a controlled `StorageFailure` with a `ValidationException` cause for invalid-calendar cases. Requests were actual authenticated `Request` objects sent through `HttpEffect.toWebHandler`.

Assertions checked response status, operation order, exact stored timestamp, and token replacement/preservation. The scope closed after each request. No production source or existing tests were edited.

| sendAt input | Schema accepts | Date.parse result | HTTP | Persistence/service effects |
| --- | --- | --- | --- | --- |
| `2099-13-01T00:00:00.000Z` | Yes | NaN | 503 with controlled service failure | Persisted invalid value, new token, schedule service invoked |
| `2099-02-29T09:00:00.000Z` | Yes | March 1, 2099 | 503 with controlled service failure | Persisted original invalid February value, new token, schedule service invoked |
| `nonsense` | No | NaN | 400 | No write/service call; old token and time preserved |
| `2099-06-01T09:00:00.000Z` | Yes | Matching instant | 200 | Valid replacement persisted and service invoked |

The stub does not prove an AWS response or execute the production Scheduler binding. Production source proves deletion precedes creation and uses the raw string; the [CreateSchedule API contract](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html) supplies the documented date-expression/validation boundary. The finding's admission and pre-call state damage are directly reproduced; the AWS rejection is supported inference, explicitly not a live observation.

### Manual CLI probe

A temporary loopback HTTP server recorded paths and bodies while four real CLI child processes ran with `TZ=Europe/Berlin`. Both `--at 2099-06-01T09:00` and `--at 2099-06-01T11:00+02:00` sent `{ "sendAt": "2099-06-01T09:00:00.000Z" }`. `--at nonsense` exited 1 and did not increase request count. `campaigns cancel` issued the correct POST and printed a draft with exit 0. All child processes completed; the server closed in a finally block. Only synthetic credentials/data were used.

## Plan-backed verdicts

1. **Baseline quality:** Changes required at the input-validity boundary (F1). The plan assumes the existing Timestamp schema validates real instants; it only validates their shape. Its explicit manual-recovery and concurrency tradeoffs remain accepted. The timing prose should be reconciled with its own later mid-minute observation.
2. **Implementation compliance:** The specified T1–T6 design and T7 test implementation are present, including table-first order, token checks, stage-owned resources, and CLI semantics. The extra `{}` on ScheduleGroup matches the provider requirement and recorded adjustment. Live outcomes remain independently Unverifiable here, although author evidence reports completion. No unauthorized design expansion identified.
3. **Quality beyond the baseline:** Changes required for F1. New writable use of Timestamp makes a pre-existing weak schema destructive. R1 describes a conditional mixed-version upgrade risk; R2 records the consequences of the accepted manual repair model.
4. **Test/validation quality:** Full gate passes and existing tests protect transitions, ordering, API status and CLI parsing. They miss calendar-invalid strings with a valid timestamp shape. Parent probes establish the escaped failure and appropriate rejection invariant. Cloud service validation and in-place deployment sequencing were not exercised.

## Compliance matrix

| Authority item / implied boundary | Expected evidence | Inspected implementation | Validation | Status |
| --- | --- | --- | --- | --- |
| T1: scheduled union, payload, schedule/cancel endpoints, 409 | Public contract and router | `Schemas.ts:200,319,448`; `packages/api/src/Api.ts:189` | Schema/router suites | Complete |
| Implied: sendAt is a real instant before mutations | Invalid-calendar rejection | Regex-only Timestamp plus `Campaigns.ts:175` | Parent router probes, F1 | Incorrect |
| T2: intent stored on META/queuedAt, projected as sendAt | Conditional writes and decode | `Storage/Campaigns.ts:117,345,369` | Storage suite | Complete |
| T2: enqueue/beginRun admit scheduled; resume excludes it | State/token conditions | `Storage/Campaigns.ts:330,394,416` | Exact storage-request tests, domain state cases | Complete |
| T3: stage group and execution role | Resources and scoped bindings | `Dispatch.ts:56,61`; `Api.ts:190` | Installed Alchemy binding/provider source; imports | Complete |
| T3: Scheduler adapter identity and shape | UTC, OFF, DELETE, stable ClientToken, existing message | `Api.ts:222`; Alchemy BindingHttp | Source/typecheck; author cloud evidence separate | Complete |
| T4: schedule and reschedule | New token; write then create | `Campaigns.ts:166` | Domain/router suites, parent probe | Complete |
| T4: cancel and send-now | Invalidate token before timer deletion | `Campaigns.ts:85,197` | Domain order/state tests; claim/beginRun inspection | Complete |
| T5: CLI schedule/cancel and UTC parsing | Real CLI request/output behavior | `Commands.ts:487,520` | CLI suite and manual process probe | Complete |
| T5/T6: operational timing guidance | Claimed start/recovery threshold agrees with platform/evidence | README lines 162,331; ADR-0015 Confirmation | Mid-minute author observation contradicts wall-clock-minute phrasing | Partial |
| T6: ADR confirmation and wiki guidance | Decision record, binding and CLI notes | ADR-0015; Scheduler/Effect wiki changes | Source and current official docs | Complete |
| T7: guarded live-test code | Fire completes, cancel leaves usable draft, past instant rejected | `Api.integration.test.ts`; `IntegrationSupport.ts:239` | Full source inspection; cloud execution not rerun | Complete |
| T7: actual deploy, live/manual cases, teardown | Real AWS execution and empty inventory | Author T7 and ADR-0015 record | Attributed author result only | Unverifiable |
| ADR-0013: repeat-safe storage and creation token | Same write identity survives retry | New conditions; `Api.ts:234`; installed Distilled source | Storage tests and dependency inspection | Complete |
| ADR-0014: metadata/body separation | Scheduling affects META only | Campaign storage and unchanged body read path | Source plus storage suite | Complete |
| Merge protocol | PR #9 first, then merge main and revalidate | Work-plan Handoff | PR #10 currently based on pre-PR-9 main | Unverifiable |

## Risk evidence and dispositions

**R1 — conditional mixed-version rollout:** baseline `beginRun` permits only queued/sending, and unchanged `Dispatching.runSlice` returns normally on stale. Alchemy beta.77 `Apply.ts:431–453` waits only graph dependencies, while `:466–501` applies nodes concurrently. `alchemy.run.ts`, Api and Dispatcher contain no function-to-function ordering dependency. This establishes a possible initial-upgrade window; no active incident is alleged. Delay first scheduling until both updates complete, or arrange consumer-first rollout. A full fresh-stage test would not reproduce this window.

**R2 — accepted manual recovery:** the plan Research and earlier implementation review explicitly acknowledge concurrent replacements leaving mismatched tokens. There is no automatic reconciliation/Scheduler DLQ. The existing dispatch-failure alarm only sees messages accepted by its queue. Author evidence also gives the mid-minute offset `11:32:44` → `11:33:33.071`; wall-clock-minute expiration cannot establish failure. [AWS timing documentation](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html) refers to target invocation rather than downstream worker start. These are operating considerations, not reopened implementation findings.

Prior decomplex review shaped the accepted design; this review does not introduce another complexity audit. No source edits, permission changes, DLQ addition or architectural replacement are proposed beyond F1's request-boundary validation.

## Coverage and ownership

The review team inspected all changed production/test files and the relevant unchanged dispatch, storage primitive, auth/diagnostic, stack and dependency boundaries. Consulted local Scheduler, DynamoDB/outbox, Effect retry/schema/CLI and Alchemy documentation; checked current primary AWS scheduling and Lambda-version references. The old Campaigns entry point was read to establish what the previous input surface did not accept.

Review artifacts belong under `.adr/work/` per repository instructions. Implementation and existing work/ADR documents remain unchanged. No GitHub review/comment is posted, no PR is merged or pushed, and no AWS resources were created.

The workflow-owned detached worktree at `~/worktrees/emailer/pr-10-review` was checked clean and removed after all three review lanes completed. No branch was created. Existing campaign-scheduling and campaign-segmentation worktrees are user-owned and untouched.

The PR-review renderer produced the standalone HTML walkthrough. A dedicated browser session verified the report at 1280px and 375px widths, including screenshots: no document-level horizontal overflow, nine section headings, no scripts, no external assets and no broken internal anchors. Chromium initially failed because this host disables its sandbox; the local-report-only session was relaunched with the supported `--no-sandbox` flag and then closed. The browser diagnostic's missing ffmpeg warning is unrelated to static report inspection; no recording was attempted.

Final remote checks still showed PR head `0516864` and main `9cd7e40`. Only the three review artifacts are included in the local documentation commit, as required by repository instructions. There are no remaining workflow-owned servers, browser sessions, agents doing active work, worktrees or branches.
