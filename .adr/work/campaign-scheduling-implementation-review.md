# Code review: campaign scheduling implementation

## Review constraints

| Axis | Selection |
|---|---|
| Target | Worktree `/home/operator/worktrees/emailer/campaign-scheduling`, branch `campaign-scheduling`, `9cd7e40..HEAD` (HEAD `b92073e`; last implementation commit `5961612`; `b92073e` is plan-doc only) |
| Baseline | Plan-backed: `.adr/work/campaign-scheduling.md` (full). Accepted [ADR-0015](../0015-one-shot-scheduler-per-campaign.md). Constrained by [ADR-0011](../0011-open-recipient-set-and-paced-dispatch.md), [ADR-0013](../0013-repeat-safe-writes.md), [ADR-0014](../0014-campaign-body-item-and-summaries.md) |
| Scope | Full implementation of T1–T7 **code**; live `--stage test-sched` deploy/run/destroy is a recorded validation skip |
| Invocation | Standalone, first implementation round |
| Output | `.adr/work/campaign-scheduling-implementation-review.md` |
| Dimensions | Correctness (beginRun/enqueue admission, table-then-Scheduler order, token invalidation, adapter, sendAt, resume), security/IAM, tests/validation, plan matrix |
| Validation/tools | Source inspection of `git diff 9cd7e40..HEAD` plus current callers/tests; installed Alchemy Scheduler bindings and distilled Scheduler error types; `pnpm exec vitest run --project unit` on the six scheduling-touched unit files (274 passed). Did not deploy, did not run integration, did not run `alchemy plan` |
| Writes/artifacts | This report only. No source edits, no work-document edits, no ADR status edits, no commits, no deploy |

Out of scope (per plan): recurring sends, send-time windows, per-recipient send-at, a `cancelled` terminal state, Scheduler DLQ/retry policy, DynamoDB TTL or EventBridge bus as the clock, SQS delay, dispatcher-loop changes, rounding `sendAt` to a minute, confused-deputy conditions on the execution-role trust, segmentation, templates, MCP.

Historical plan reviews (`.adr/work/campaign-scheduling-review.md`, `-decomplex.md`) are **not** authority. Their conclusions were re-checked against the implementation rather than reused.

Known skip (authorized, not a code defect): live integration has not been run because AWS SSO for Alchemy profile `emailer-test` is expired.

## Summary

T1–T6 match the accepted plan and ADR-0015. T7’s automated cases are present; the live run, manual walkthrough, ADR Confirmation offset, and destroy are Unverifiable.

The four races this review was told to challenge do not admit as defects:

- **Silent fire-drop of a live schedule** is not reachable: `beginRun` admits `scheduled` under the same token check the fire carries.
- **Double-send** is the existing at-least-once wake-up; a send-now mints a fresh token before the old schedule can be useful, and per-recipient claims still refuse a second row.
- **Send-after-cancel** fails `beginRun` because cancel removes `runToken` (and `queuedAt`) **before** the Scheduler delete.
- **Send-before-minute** is Scheduler’s clock; the domain rejects `sendAt <= now`, and the live case (unrun) is the only behavioural net for the minute window.

No material findings. Residual risk is the unrun live gate (role assumable, PassRole, group-scoped grants, `at()` accepted, fire offset), which the plan already owns.

**Recommend: no code changes from this review.** Parent still owes SSO refresh, `--stage test-sched` deploy, integration + walkthrough, ADR-0015 Confirmation, and destroy before merge.

## Related decomplex review

- **Report:** `.adr/work/campaign-scheduling-decomplex.md` (plan-time; historical)
- **Owner disposition summary:** DEX-001–003, 005–007 accepted into the plan; DEX-004 (`SendAtNotInFuture`) rejected as a contract rule. This implementation review does not re-open those plan dispositions.

## Coverage

### Inspected

- Plan `.adr/work/campaign-scheduling.md` (full, including T1–T7, Approach, Research, Final acceptance)
- ADR-0015 (full); ADR-0011, ADR-0013, ADR-0014 (full)
- `git log` / `git diff --stat` / core diffs `9cd7e40..HEAD`
- `packages/api/src/{Schemas,Api,Schemas.test}.ts`
- `apps/backend/src/Storage/Campaigns.ts` (`StoredCampaign`, `submissionOf`, `scheduleCampaign`, `unscheduleCampaign`, `enqueueCampaign`, `beginRun`, `resumeCampaign`, exported operations)
- `apps/backend/src/Storage/Campaigns.test.ts` (expression pins, scheduled projection)
- `apps/backend/src/{Campaigns,Api,Dispatch,Dispatching}.ts`
- `apps/backend/src/{Campaigns,Api,Dispatching}.test.ts` (fakes, order, 409, resume table)
- `apps/backend/src/Api.integration.test.ts` (fire + cancel + past `sendAt`)
- `apps/backend/test/IntegrationSupport.ts` (`submitToSimulatorList`)
- `apps/cli/src/{Commands,Commands.test}.ts`
- `README.md`, `wiki/aws/scheduler.md`, `wiki/effect/http-cli-and-runtime.md`
- Installed Alchemy `CreateSchedule.ts`, `DeleteSchedule.ts`, `BindingHttp.ts`, `ScheduleGroup.ts`, `Output.ts` (`yield*` of an attribute is an `Accessor`/`Effect`)
- Distilled `@distilled.cloud/aws` Scheduler errors (`ResourceNotFoundException`, `ConflictException` retryable) and `CreateScheduleInput.ClientToken`

### Skipped or partial

- Did not treat task Status labels in the work document as proof
- Did not re-read plan-review reports as authority (filenames only, for the historical pointer above)
- Did not run `pnpm check` / `pnpm typecheck` / `pnpm lint` (targeted unit suite green)
- Did not deploy `--stage test-sched`, run integration, `alchemy plan`, or inspect a deployed `alchemy-bindings` policy
- Did not run the CLI help process (`--at` text is in source and covered by Commands tests)
- Lane D (`campaign-segmentation`) merge protocol: noted as future work, not executed
- Confused-deputy trust conditions: plan out of scope

### Required boundaries

- `beginRun` / `enqueueCampaign` / `resumeCampaign` conditions and callers (`Dispatching.runSlice`, `Campaigns.send` / `schedule` / `cancel` / `resume`)
- Table-then-Scheduler order on schedule, cancel, send-now
- Token invalidation on cancel (REMOVE `runToken`) and send-now (fresh token)
- Live `CampaignSchedule` adapter: `at()` slice, `ClientToken`, `ActionAfterCompletion DELETE`, `ResourceNotFoundException`, binding-injected `GroupName` / `FlexibleTimeWindow OFF` / `Target.RoleArn`
- Domain `sendAt` future check → 409 `SendAtNotInFuture`
- IAM: stage-owned `ScheduleGroup`, `SchedulerRole` trust + `sqs:SendMessage` on the dispatch queue, API bindings for Create/Delete/PassRole
- Fakes that must compile against two new store operations (`Campaigns.test.ts`, `Api.test.ts`, `Dispatching.test.ts`, CLI `handleAll`)
- Integration simulator guard covering a scheduled submit

## Validation

- **Run:** `pnpm exec vitest run --project unit packages/api/src/Schemas.test.ts apps/backend/src/Storage/Campaigns.test.ts apps/backend/src/Campaigns.test.ts apps/backend/src/Api.test.ts apps/backend/src/Dispatching.test.ts apps/cli/src/Commands.test.ts` — 6 files, 274 passed.
- **Skipped/unavailable:** `pnpm check`; `alchemy plan --stage test-sched`; deploy/integration/destroy; `aws iam get-role-policy` on the API role; manual Scheduler walkthrough and past-`at()` probe; ADR-0015 Confirmation fill.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** The plan is complete, internally consistent, and testable. ADR-0015 states the same contracts (one-shot named after the campaign, intent on `META.queuedAt`, fire = existing wake-up, table first, stage-owned group+role, `sendAt` after now as a 409). Repeat-safe forms follow ADR-0013 (`#state IN (:draft, :scheduled)` / `#state IN (:scheduled, :draft)` plus enqueue’s queued+same-token disjunct). Intent stays on `META` (ADR-0014). Dispatcher loop unchanged (ADR-0011). Residuals the plan already accepts — no Scheduler DLQ, concurrent reschedules can leave table and schedule under different tokens with `send` as recovery, mid-minute precision undocumented by AWS — are documented, not holes. The live Confirmation of ADR-0015 is still empty; that is an execution gate, not a baseline defect.

2. **Implementation compliance:** T1–T6 are **Complete** with source evidence. T7’s cases and guard generalisation are **Complete** in code and **Unverifiable** at runtime. IAM declarations match the plan; generated policies are Unverifiable without deploy. No Incorrect / Missing implementation rows, no undocumented deviations, no Overbuilt rows. Matrix: Complete except live-validation / Confirmation / teardown inventory rows.

3. **Implementation quality beyond the baseline:** No material defect the plan missed. `yield* queue.queueArn` is an Alchemy `Accessor` (extends `Effect`), so `Effect.flatMap(queueArn, …)` is the runtime resolve, not a string captured too early. Cancel ignoring `unscheduleCampaign`’s `"not-scheduled"` still deletes the schedule, which is the safe leftover-delete. A 503 after send-now’s enqueue but before `remove` leaves a stale self-deleting schedule — the documented lost-delete case, not a second send. `Campaigns.send` now requires `CampaignSchedule` even for drafts; every caller and fake was updated. `resume` still falls through `default` for `scheduled`.

4. **Test and validation quality:** Unit tests protect the contracts that can be pinned without AWS: union member and payload; exact DynamoDB condition/update strings (including resume **not** listing `scheduled`); domain call order (table then Scheduler; send-now enqueue → remove → wake); 409 body; CLI ISO/UTC/`nonsense`; fake exhaustiveness. They do **not** execute the live adapter (plan: no fake can observe it). Integration cases would prove fire admission, not-before-minute (`startedAt >= sendAt - 1000`), cancel-then-send, and past `sendAt`, but they have not been run. `failIfPausedOrDraft` does not fail-fast on a stuck `scheduled` campaign; a dropped fire still times out waiting for `completed` — not false-green. CLI/API fakes that no-op `CampaignSchedule` are not false-green for the assertions they make; order is asserted in `Campaigns.test.ts`.

## Plan compliance matrix

| Authority item / implied requirement | Expected evidence | Implementation evidence | Validation / test evidence | Status |
|---|---|---|---|---|
| T1 `CampaignSubmission` gains `{ state: "scheduled", sendAt: Timestamp }` | Union member; `Timestamp` remains `.sssZ` | `packages/api/src/Schemas.ts:200-205` | `Schemas.test.ts:356-359` row `["scheduled", { state: "scheduled", sendAt }]` | Complete |
| T1 `ScheduleCampaignPayload` + `SendAtNotInFuture` 409 | Struct `{ sendAt }`; tagged error `httpApiStatus: 409` | `Schemas.ts:319-321`, `:448-452` | `Schemas.test.ts:322-332` payload decode; `:789` status table | Complete |
| T1 `POST /:id/schedule` and `POST /:id/cancel` after resume | Typed endpoints; schedule errors include `SendAtNotInFuture` | `packages/api/src/Api.ts:189-204` | `Api.test.ts:1091-1156` schedule + cancel; `:802-854` 409 | Complete |
| T2 `StoredCampaign.state` includes `scheduled`; no new attribute | Literal list; `queuedAt` optional reused | `Storage/Campaigns.ts:49-52, 52` | Decode-every-state includes scheduled (`Campaigns.test.ts:309-355`) | Complete |
| T2 `submissionOf` scheduled → `sendAt: queuedAt`; missing `queuedAt` corrupt | Same decode path as sending-without-`queuedAt` | `Storage/Campaigns.ts:117-119` (`sendAt: stored.queuedAt`); `decodeSubmission` in `summaryOf` | Happy path pinned at `:353-355`. No dedicated corrupt-scheduled case; sending-without-`queuedAt` at `:395-410` is the same decoder | Complete |
| T2 `scheduleCampaign`: SET scheduled + `queuedAt` + token + baselines; `#state IN (:draft, :scheduled)` | Exact expression | `Storage/Campaigns.ts:345-367` | `Campaigns.test.ts:633-655` verbatim request | Complete |
| T2 `unscheduleCampaign`: SET draft REMOVE `runToken, queuedAt`; `#state IN (:scheduled, :draft)` | Exact expression | `Storage/Campaigns.ts:369-383` | `Campaigns.test.ts:668-687` verbatim request | Complete |
| T2 `enqueueCampaign` admits `scheduled` (condition only; expression already sets `queuedAt = :now`) | `#state IN (:draft, :scheduled) OR (#state = :queued AND runToken = :run)` | `Storage/Campaigns.ts:326-339` | `Campaigns.test.ts:590-604` verbatim | Complete |
| T2 `beginRun` admits `scheduled` under token check; expression unchanged | `runToken = :run AND #state IN (:queued, :sending, :scheduled)` | `Storage/Campaigns.ts:415-424` | `Campaigns.test.ts:760-773` verbatim | Complete |
| T2 `resumeCampaign` must **not** admit `scheduled` | Condition still paused OR queued+same token; comment | `Storage/Campaigns.ts:394-395` | `Campaigns.test.ts:707-721` still omits `scheduled`; domain `it.each` includes scheduled (`Campaigns.test.ts:526-541`) | Complete |
| T2 export two new operations (breaks fakes at compile time) | Returned object includes both | `Storage/Campaigns.ts:698-699` | Fakes in `Campaigns.test.ts:143-182`, `Api.test.ts:61-64,416-451`, `Dispatching.test.ts:167-168` typecheck via the unit run | Complete |
| T3 stage-owned `ScheduleGroup("Schedules")` (no explicit name) | Declared beside the queues; leaf module | `Dispatch.ts:56` | No unit observer. `alchemy plan` not run | Complete (source) / Unverifiable (plan/deploy) |
| T3 `SchedulerRole`: trust `scheduler.amazonaws.com`; `sqs:SendMessage` on dispatch queue ARN | `AWS.IAM.Role` props Effect yields `dispatchQueue` | `Dispatch.ts:61-91` | Matches Alchemy `CreateSchedule.ts:52-76` example. Deployed role not inspected | Complete (source) / Unverifiable (IAM JSON) |
| T3 yield role+group in `ApiFunction`; `CreateSchedule(role, group)` + `DeleteSchedule(group)`; Http layers | Constructor + layer list | `Api.ts:190-193`, `:260-261` | Bindings grant `scheduler:CreateSchedule`/`DeleteSchedule` on `schedule/<group>/*` and `iam:PassRole` conditioned on `scheduler.amazonaws.com` (`BindingHttp.ts:174-196`). Deployed `alchemy-bindings` not read | Complete (source) / Unverifiable (deployed policy) |
| T3 live adapter: delete then create; `at(${sendAt.slice(0, 19)})`; timezone UTC; `ActionAfterCompletion: DELETE`; `ClientToken: runToken`; Input = `encodeDispatchMessage`; swallow `ResourceNotFoundException` on delete | Adapter body | `Api.ts:195-246` | Binding injects `GroupName`, `FlexibleTimeWindow { Mode: "OFF" }`, `Target.RoleArn` (`BindingHttp.ts:208-215`). `ResourceNotFoundException` tag matches distilled client (`scheduler.ts:109-114`). `ClientToken` field exists (`scheduler.ts:397`). No unit of the adapter (plan). Live fire unrun | Complete (source) / Unverifiable (runtime) |
| T3 `alchemy.run.ts` unchanged; role/group register through the API function | Stack still yields `ApiFunction` only | `alchemy.run.ts:22`; role/group yielded at `Api.ts:190-191` | Same registration pattern as `dispatchQueue` | Complete |
| T4 `schedule`: future check; draft/scheduled mint token, table then `schedules.create`; other states unchanged | Domain switch | `Campaigns.ts:166-195` | `Campaigns.test.ts:545-644` (order `scheduleCampaign` then `create`; reschedule fresh token; past `sendAt` writes nothing; other states; 503 after write) | Complete |
| T4 `cancel`: scheduled → `unscheduleCampaign` then `schedules.remove`; else unchanged | Domain switch | `Campaigns.ts:197-214` | `Campaigns.test.ts:647-659` order `unscheduleCampaign` then `remove`; non-scheduled table `:663-678` | Complete |
| T4 `send` on scheduled: enqueue (fresh token) then remove then wake | `case "draft": case "scheduled"`; remove only when previous state was scheduled and outcome queued | `Campaigns.ts:92-105` | `Campaigns.test.ts:476-493` order `enqueueCampaign`, `remove`, `enqueue`; new token ≠ existing | Complete |
| T4 `resume` unchanged (`scheduled` → default) | No `scheduled` case | `Campaigns.ts:145-163` | `Campaigns.test.ts:526-541` | Complete |
| T4 handlers + HTTP 409 | `publicly(Campaigns.schedule/cancel)` | `Api.ts:75-76`; `publicly` passes non-`StorageFailure` through (`Diagnostics.ts:51-60`) | `Api.test.ts:802-854` 409 `SendAtNotInFuture`; `:1091-1156` schedule/cancel | Complete |
| T5 CLI `schedule --at` via `DateTimeUtcFromString` + `formatIso`; `cancel`; registered after resume | Flag chain; examples | `Commands.ts:487-557` | `Commands.test.ts:683-808` ISO, `TZ=Europe/Berlin` zone-less UTC, malformed `--at` no request, cancel → draft | Complete |
| T5 README commands, output contract (minute of `sendAt`), stuck-`scheduled` recovery, teardown inventory includes group + scheduler role | Sections edited | `README.md:91-92, 162-167, 281, 331-334` | Documentation; live teardown unrun | Complete (source) / Unverifiable (destroy inventory) |
| T6 ADR-0015 accepted; wiki Alchemy binding + Flag.date paragraph | Files exist | ADR-0015 Decision/Consequences; `wiki/aws/scheduler.md:42-50`; `wiki/effect/http-cli-and-runtime.md:60` | Confirmation still awaiting observed offset (T7) | Complete (docs) / Unverifiable (Confirmation) |
| T7 simulator guard generalised; fire + cancel live cases | `submitToSimulatorList`; whole-minute ≥90s; `failIfPausedOrDraft`; past 409; cancel then send | `IntegrationSupport.ts:239-266`; `Api.integration.test.ts:57, 266-409` | Cases compiled into the suite; **not executed** (SSO expired) | Complete (code) / Unverifiable (runtime) |
| T7 live gate + destroy + ADR Confirmation | Deploy `test-sched`, integration green, walkthrough, probe, destroy | Code ready; stage not deployed | SSO `needs-reauth` | Unverifiable |
| ADR-0015 / plan: table first, Scheduler second, every operation | Domain never calls Scheduler before the matching write | `Campaigns.ts:183-186, 205-206, 99-104` | Order asserts in `Campaigns.test.ts:563, 581, 491, 659` | Complete |
| ADR-0015: fire is existing `DispatchMessage`; dispatcher unchanged except `beginRun` admission | Same encoder as wake; `runSlice` still drops `stale` | `Api.ts:214-216` vs `:225-236`; `Dispatching.ts:90-94` | `Dispatching.test.ts` gained only `notExercised` ops (`:167-168`); no dispatcher behaviour change | Complete |
| ADR-0015: late/duplicate fires are stale wake-ups (ADR-0011) | Token on the item is the authority | Cancel REMOVE token (`Storage/Campaigns.ts:372`); send-now overwrites token (`:327`); `beginRun` requires `runToken = :run` (`:416`) | Storage pins + domain order. Live cancel-then-send unrun | Complete (unit) / Unverifiable (live) |
| ADR-0013: schedule/unschedule conditions hold after apply; enqueue keeps queued+same-token disjunct | Repeat-safe forms | Conditions as T2 rows | Expression tests | Complete |
| ADR-0014: intent on `META`, never `BODY` | `queuedAt` / `runToken` on META update; BODY untouched | `scheduleCampaign`/`unscheduleCampaign` update `campaignKey` only | No BODY writes in the new operations (inspection) | Complete |
| Implied: listing shows `scheduled` + `sendAt` because it hydrates META | Shared `summaryOf`/`submissionOf` | `listCampaigns` → `summaryOf` (`Storage/Campaigns.ts:281-294, 151-160`) | Scheduled projection covered via `getCampaign` decode-every-state; no dedicated list HTTP case. Same decoder | Complete |
| Out of scope held | No DLQ, no `cancelled` state, no dispatcher loop change, no `sendAt` rounding, no confused-deputy trust | No RetryPolicy/DeadLetterConfig on Target (`Api.ts:229-237`); cancel returns `draft`; `Dispatching.ts` slice loop untouched; trust is service-only (`Dispatch.ts:70-73`) | n/a | Complete |
| `pnpm check` green | format/lint/typecheck/unit/imports | Targeted unit 274 passed | Full `pnpm check` not re-run this round | Complete (targeted) / Unverifiable (full check) |

### Approvals and conflicts

- **Approved deviation:** none in the implementation. Plan dispositions of the historical plan review (whole-minute live gate, fake `enqueueCampaign` admitting `scheduled`, generalised simulator guard, past-`sendAt` documented not mapped) are visible in the source and match those dispositions; they change the baseline only because the owner already recorded them in the work document before this review.
- **Authority conflict:** none. Plan, ADR-0015, and ADR-0011/0013/0014 agree on the fire, the token, META, and repeat-safe writes.

## Follow-up closure

- **Round and material delta:** Round 1 (first implementation review). No prior implementation findings to close.
- **Closure state:** Clear
- **Resolved or withdrawn:** n/a
- **Still material:** none
- **New fix-caused or fix-exposed findings:** none

## Findings

None admitted.

## Context-dependent concerns

- **Concern:** Live path (execution role assumable, PassRole, group-scoped grants, `at()` accepted by Scheduler, fire offset, destroy deletes the group) is unproven.
  **Disposition:** Authorized validation skip. Not a code defect. Parent-owned next action: SSO refresh → `--stage test-sched` → integration + walkthrough → fill ADR-0015 Confirmation → destroy.

- **Concern:** Two concurrent `schedule` calls can finish with the table under token T2 and the schedule still carrying T1; the fire is then stale and the campaign stays `scheduled` past its minute.
  **Disposition:** Documented residual (plan Research + README recovery `campaigns send`). Not a defect; ADR-0015 “reschedule replaces” plus table-first ordering.

- **Concern:** `failIfPausedOrDraft` does not fail-fast if a fire is dropped and the campaign remains `scheduled`.
  **Disposition:** Timeout still fails the case. Not false-green. No change required.

## Confirmed-good areas

- **`beginRun` admission.** Condition is `runToken = :run AND #state IN (:queued, :sending, :scheduled)` with `:scheduled` in values (`Storage/Campaigns.ts:416-424`). A fire whose message token matches a `scheduled` item cannot be dropped as stale. `Dispatching.runSlice` still returns on `stale` (`Dispatching.ts:92-94`) — that path is now only cancel / send-now / reschedule / duplicate-after-complete.
- **Send-now token invalidation.** `enqueueCampaign` writes a **new** token and `queuedAt = now` before `schedules.remove` (`Campaigns.ts:95-104`). A fire still in flight carries the old token and fails `runToken = :run` whether the item is already `queued` or `sending`.
- **Cancel token invalidation.** `unscheduleCampaign` `REMOVE runToken, queuedAt` under `#state IN (:scheduled, :draft)` **before** `schedules.remove` (`Campaigns.ts:205-206`, `Storage/Campaigns.ts:372-374`). DynamoDB `runToken = :run` is false when the attribute is absent. A lost Scheduler delete leaves a self-deleting stale fire (`ActionAfterCompletion: DELETE`).
- **Table then Scheduler.** Domain tests pin call order for schedule, reschedule, cancel, and send-now (`Campaigns.test.ts:563, 581, 659, 491`). A crash after the write is either “scheduled with no schedule” (repeat `schedule` or `send`) or “stale fire” — the plan’s recovery.
- **Adapter shape.** Name = campaign id; `at(sendAt.slice(0, 19))` in UTC; `ClientToken` = run token (so the distilled client does not mint a fresh token per attempt); delete-then-create; `ResourceNotFoundException` swallowed only on delete. Binding injects OFF window, group, and execution-role ARN. `queueArn` after `yield*` is an Alchemy `Accessor`/`Effect` (`Output.ts:79-90, 142-162`), so `Effect.flatMap(queueArn, …)` is valid at runtime.
- **`sendAt` 409.** Domain compares `Date.parse(sendAt)` to `Clock.currentTimeMillis` **after** `get` (`Campaigns.ts:173-177`); payload is already `Timestamp`. HTTP 409 typed body is covered at the real router (`Api.test.ts:802-854`) and declared on the endpoint (`Api.ts:196`).
- **`resume` does not start a scheduled campaign.** Storage condition and domain default both omit `scheduled`.
- **IAM declarations.** Group is stage-owned so `DeleteScheduleGroup` can reap runtime-minted schedules. Role may only `sqs:SendMessage` to the dispatch queue. API grants come from the bindings, not a hand-written policy on `Dispatch.ts`.
- **Fakes compile.** Two new store operations are present on every exhaustive `CampaignStore` object this lane owns.

## Limitations and caveats

- Live confirmation of fire, cancel-then-send, minute-precision, role/PassRole/group grants, and teardown inventory is **Unverifiable** in this environment (expired AWS SSO). That skip was authorized and is not scored as an implementation bug.
- The live adapter has no unit test by plan; inspection against installed Alchemy/distilled types is the non-live evidence.
- Full `pnpm check` was not re-run; the six targeted unit files covering the scheduling surface passed.
- Generated IAM JSON and `alchemy plan` resource list were not observed.
- ADR-0015 Confirmation (observed `startedAt - sendAt`, mid-minute probe, past `at()`) is still empty.

## Next steps

1. Parent: no implementation changes from this review.
2. Refresh AWS SSO for `emailer-test` / `example`, deploy `--stage test-sched`, run the integration project, manual walkthrough and probe, fill ADR-0015 Confirmation, destroy and inventory the group/role.
3. Merge protocol (lane D first) remains as written in the work document; this review does not execute it.
