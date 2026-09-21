# Code review: Queued campaign cancellation T3+T4

## Review constraints

| Axis | Selection |
|---|---|
| Target | T3+T4 implementation in worktree `queued-campaign-cancellation` (uncommitted vs `a5e66c6`) |
| Baseline | Plan-backed vs `.adr/work/queued-campaign-cancellation.md` and accepted ADR-0016; constrained by ADR-0011/0013/0014/0015 as cited |
| Scope | Bounded to T3+T4: Scheduler generation identity, command side-effect ordering, HTTP/CLI 409, README cancel/recovery |
| Invocation | Embedded in implement-plan |
| Output | `.adr/work/queued-campaign-cancellation-t3-t4-review.md` |
| Dimensions | Correctness, types/trust boundaries, tests/validation, APIs/compatibility, operator docs; simplicity only where it affects T3+T4 risk |
| Validation/tools | Authorized T3+T4 unit command. No AWS, deploy, lint, typecheck, commit, or implementation edits |
| Writes/artifacts | This report only |

## Summary

T3+T4 match the plan. Schedules are named by run token; create no longer deletes a shared campaign name; send/schedule/cancel perform the primary publish or create after the durable write, then generation-specific cleanup; a late create deletes only its own obsolete resource; cancel conflicts never remove a replacement. HTTP returns 200 for draft and manual-paused success, 409 for sending/completed and a replacement generation, and 404/503 as specified. The CLI exits nonzero on conflict. README states the active-send boundary and does not promise prompt orphan deletion. Challenged counterexamples do not reproduce.

## Related decomplex review

- **Report:** `.adr/work/queued-campaign-cancellation-decomplex.md` (plan/structural; Clear)
- **Owner disposition summary:** Parent accepted the Clear structural assessment. This review is a separate implementation report and does not reuse that closure. T1+T2 implementation review is also separate (Clear after R2).

## Coverage

### Inspected

- Plan T3/T4, Scheduler and command side effects, Exact conflict policy, T3/T4-owned test-matrix rows
- ADR-0016 (Accepted) Scheduler naming/order, cleanup limits, and cancel-only 409; ADR-0015 only as the superseded campaign-named/delete-before-create baseline
- `wiki/aws/scheduler.md` (Create/Delete, ClientToken, group-scoped bindings, non-atomic DB+Scheduler)
- `apps/backend/src/CampaignSchedule.ts` and `CampaignSchedule.test.ts`
- `apps/backend/src/Campaigns.ts` send/schedule/resume/cancel sequencing and `CampaignSchedule` service shape
- `apps/backend/src/Api.ts` factory wiring (`CreateSchedule`/`DeleteSchedule` still group-bound)
- `apps/backend/src/Api.test.ts` cancel HTTP 200/404/409/503 and replacement 409
- `packages/api/src/{Api,Schemas,Client.test}.ts` cancel error registration and client decoding
- `apps/cli/src/Commands.ts` cancel help/examples; `Commands.test.ts` help, success, conflict exit
- `README.md` cancel semantics and leftover-work recovery
- Diff vs `a5e66c6` for those files; new untracked `CampaignSchedule.ts` / `CampaignSchedule.test.ts`
- Domain `Campaigns.test.ts` delayed create/delete, late-create self-delete, failed writes, conflict non-cleanup, inactive retry

### Skipped or partial

- T1+T2 contract, control reads, lifecycle transactions (prior review; sampled only as T3/T4 callers)
- T5 live DynamoDB races, queue consumption, stale-disposition log
- T6 deploy, `pnpm check`, ephemeral acceptance, generated live plan / IAM inspection
- `pnpm typecheck`, `pnpm lint`, live `pnpm emailer campaigns cancel --help` (help content is asserted by the spawned CLI test)
- Work-document task Status/Evidence labels (treated as claims)

### Required boundaries

- Scheduler `Name`/`ClientToken` = run token; no delete-inside-create; NotFound-only remove success
- Domain owns sequencing: wake/create first, then observed-generation cleanup; post-create obsolescence check
- Conflict never deletes a replacement resource; inactive cancel retries the retained token
- Public Campaign and cancel error JSON/CLI output expose no run token
- Cancel HTTP 200/404/409/503 and CLI nonzero conflict; README active-send and orphan-cleanup limits

## Validation

- **Run:** `pnpm exec vitest run --project unit apps/backend/src/CampaignSchedule.test.ts apps/backend/src/Campaigns.test.ts apps/backend/src/Api.test.ts packages/api apps/cli/src/Commands.test.ts` — 6 files, 294 passed
- **Skipped/unavailable:** typecheck, lint, live AWS, mutating tests to restore delete-before-create. Challenge results are from source and current oracles, not a restored pre-fix run.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** Adequate for T3+T4. Scheduler identity, primary-effect-first order, post-create self-delete, conflict non-cleanup, cancel-only 409, and the documented crash/orphan limit are testable and consistent with accepted ADR-0016. ADR-0016’s supersession of ADR-0015 campaign-named schedules and delete-before-create is the stated baseline. Durable-cancel-plus-failed-delete 503 is required at domain+router; implementation has it, with thinner cancel-specific failure injection than send. No baseline conflict requiring a human decision. Confidence high for this bounded slice.

2. **Implementation compliance:** T3+T4 production behavior matches the plan. Matrix: 16 Complete, 1 Partial (cancel-delete-failure 503 is implemented and domain retry/order are tested; domain+router do not inject a failed delete after a successful cancel write). No Missing/Incorrect/Overbuilt/Approved-deviation rows in T3+T4 scope. Task Status “Verified” was not treated as proof; the tree was inspected directly.

3. **Implementation quality beyond the baseline:** No extra material generic risk in T3+T4. Challenged old cleanup deleting a new schedule, late create leaving its own resource, failed writes emitting wakes/creates, conflict deleting a replacement, tokens in public JSON/CLI, replacement generations returning 200, CLI success on conflict, and README overclaiming active-send interrupt or prompt orphan deletion do not reproduce.

4. **Test and validation quality:** Adapter tests pin Name/ClientToken, no hidden delete, and NotFound-only remove success. Domain tests control delayed create/delete and post-create reread. Router tests 200 draft/manual-paused, 409 sending/completed/replacement-paused, 404, control-read 503, and absent tokens. CLI help, success shapes, and sending-conflict nonzero exit are covered. The specified cancel-delete-failure 503 (durable inactive + observable 503 + same-token retry) is only partly locked: retry and write-then-remove are tested; a swallowed cancel-cleanup error would not fail the current cancel cases. Send already injects cleanup failure. Not admitted as a finding: production fail-through is the same `yield*` used by the tested send path, and inactive cancel retry is tested.

## Plan compliance matrix

| Authority item / implied requirement | Expected evidence | Implementation evidence | Validation / test evidence | Status |
|---|---|---|---|---|
| T3: extract concrete adapter; `Name`/`ClientToken` = run token; no UUID concatenation | Factory in `CampaignSchedule.ts`; 36-char UUID names | `campaignSchedule` `apps/backend/src/CampaignSchedule.ts:17-35`; `newIdentifier` is UUID v4 | `CampaignSchedule.test.ts` create: `Name`/`ClientToken` are `runToken`; no delete | Complete |
| T3: create never deletes; remove by observed token; NotFound success; other errors unavailable; no Conflict-as-success; no List/GetSchedule | Adapter create/delete only | Create has no delete (`CampaignSchedule.ts:17-35`); remove catches only `ResourceNotFoundException` (`36-41`); Conflict on create/delete → `StorageFailure` unavailable | Adapter tests: create failure does not delete; NotFound remove succeeds; Conflict delete is unavailable | Complete |
| T3: preserve stage group, role, target payload, future-time check, least-privilege bindings | Same `CreateSchedule(role, group)` / `DeleteSchedule(group)`; UTC `at()`; queue input unchanged | `Api.ts:191-217` still yields group/role bindings and injects the factory; payload still `encodeDispatchMessage`; `Campaigns.schedule` still 409s past `sendAt` before write (`203-213`) | Adapter request: UTC `at()`, `ActionAfterCompletion: DELETE`, queue ARN + dispatch input. Domain past-`sendAt` test creates nothing. Live IAM is T6 | Complete |
| T3 send: commit queued generation, enqueue wake, then remove predecessor; cleanup failure must not unpublish | Wake before `remove`; 503 after wake | `Campaigns.ts:150-156` | Order `enqueueCampaign, enqueue, remove`; “still publishes the wake when predecessor cleanup fails”; lost enqueue source publishes nothing | Complete |
| T3 schedule: commit, create, reread, delete own resource if no longer that scheduled generation, then predecessor | Primary create before cleanup; own token on obsolescence | `Campaigns.ts:232-249` | Order `scheduleCampaign, create, remove`; delayed predecessor delete uses old token only; late create removes own token, not replacement | Complete |
| T3 resume / queued repair: enqueue observed queued token only; no extra mint/delete | Resume has no `CampaignSchedule` | `Campaigns.ts:170-200`; `wakeQueued` `114-124` | Queued repair tests enqueue the captured token; resume has no schedule create/remove in this slice | Complete |
| T3 cancel: after applied write, remove only the observed token; already-inactive retries that token; conflict never deletes replacement | Cleanup gated on applied / expected destination | Applied then `remove(runToken)` `306-310`; draft/paused retry `277-284`; conflict returns before remove `319-322`; idempotent destination removes observed token `325` | Domain: write-then-remove order; inactive retry; replacement draft/paused/sending 409 and `removed` empty. HTTP replacement paused: no `removeSchedule` | Complete |
| Failed command write produces no external effects | No wake/create/remove on conflict | Send/schedule/resume only side-effect when outcome is queued/scheduled | Lost-source send/schedule: no wake/create/remove | Complete |
| T3/ADR-0016: old cleanup cannot delete a newer schedule | Distinct names; delayed delete still names the predecessor | `remove(predecessor)` / `remove(runToken)` never uses `campaignId`; baseline `Name: campaignId` + delete-before-create is gone | Adapter Name=runToken; delayed-delete test `Campaigns.test.ts:931-961` | Complete |
| T3/ADR-0016: late create removes its own obsolete resource | Post-create control reread | `stillScheduled` uses current state+token (`236-244`) | `Campaigns.test.ts:964-992` removes created token, not replacement | Complete |
| T3/T4 matrix: delete fails after cancellation → durable inactive, observable 503, repeat cancel retries same identity | Domain + router | Applied write then `remove`; `publicly` maps `StorageFailure` to 503; draft/paused retry same token | Domain: retry and order. Send cleanup 503 exists. No cancel-specific remove-failure injection in `Campaigns.test.ts` or `Api.test.ts` (router 503 is control-read, not post-write delete) | Partial |
| T4: router + generated client 200 draft / manual-paused; tokens absent | Real handler + client | `Api.ts:77` `publicly(Campaigns.cancel)`; Campaign schema has no `runToken` | `Api.test.ts` scheduled/never-started queued → draft 200; queued resume → paused+manual+history; bodies lack `runToken` | Complete |
| T4 / exact conflict: 409 for sending, completed, and replacement generation; no mutation/cleanup | Tagged `CampaignCancellationConflict`; all six states admitted | Error on cancel endpoint `packages/api/src/Api.ts:200-209`; `Schemas.ts:465-471` | Router: sending/completed 409, no `cancelCampaign`/`removeSchedule`; replacement paused 409, no remove. Client decodes sending 409 without `runToken`. Domain also replacement draft/sending | Complete |
| T4: 404 missing, 503 sanitized provider failure | Existing NotFound / StorageUnavailable | `publicly` `Diagnostics.ts:47-61`; cancel 404 from `readControl` | `Api.test.ts` missing cancel 404; control-read 503. CLI send 503 nonzero remains | Complete |
| T4 CLI: help covers scheduled, queued first send, queued resume; generic reporter nonzero on conflict; no extra formatting | Description/examples; `reporting` unchanged | `Commands.ts:556-575`; `main.ts` still wraps `reporting` | Help test asserts those phrases, not `runToken`. Sending conflict: nonzero, stderr tag, stdout empty, campaign unchanged. Success JSON has no `runToken` | Complete |
| T4 README: cancel semantics, concurrency, durable write then cleanup failure, active-send boundary, no prompt orphan deletion | Operator-facing limits | CLI section `README.md:173-180`; recovery `353-358` | Text: 409 for sending/completed/replacement; does not stop in-flight SES; leftover delete retried on repeat cancel; orphans until fire/`DELETE` or teardown; no automatic reconciliation | Complete |
| ADR-0016 implied: generation names fit 64-char limit; ClientToken supplied | UUID name, not campaignId+token | `Name`/`ClientToken` = run token only | Adapter test; UUID v4 is 36 characters. No List/Get added to application role in `Api.ts`/`Dispatch.ts` | Complete |

### Approvals and conflicts

- **Approved deviation:** None in T3+T4. Crash-time orphans and non-atomic DB+Scheduler are documented limits in ADR-0016, not silent descopes.
- **Authority conflict:** None. ADR-0016’s supersession of ADR-0015 campaign-named schedules and delete-before-create is the plan’s stated T3 baseline.

## Follow-up closure

- **Round and material delta:** R1, T3+T4 implementation review. No prior T3+T4 implementation findings.
- **Closure state:** Clear
- **Resolved or withdrawn:** —
- **Still material:** —
- **New fix-caused or fix-exposed findings:** —

## Findings

No material findings.

## Context-dependent concerns

- **Concern:** Cancel-delete-failure 503 is not injected at domain or router (matrix Partial). A cancel path that ignored `remove` errors would still pass the current cancel tests.
- **Disposition:** Not a finding. Production uses the same uncaught `yield*` as the tested send-cleanup 503; inactive same-token retry is tested; README already describes the operator recovery.

## Confirmed-good areas

- Baseline delete-before-create (`Api.ts` `remove(campaignId)` then `Name: campaignId`) is gone; factory create cannot delete.
- Delayed predecessor delete is aimed at the old token; late create deletes only its own identity.
- Failed send/schedule writes publish nothing; conflict cancel does not call `remove`.
- Replacement paused 409 is exercised through the real router and generated client, not only sending/completed.
- CLI conflict uses the generic reporter (nonzero, stderr tag, empty stdout).
- Public Campaign JSON, cancel error bodies, and CLI stdout/help do not include `runToken`.
- README explicitly refuses active-send interrupt and prompt orphan deletion.

## Limitations and caveats

- Bounded to T3+T4. Does not re-certify T1+T2 or claim T5/T6.
- Adapter tests use injected AWS callables, not live Scheduler. GroupName, FlexibleTimeWindow, and RoleArn remain binding-injected.
- Domain schedule doubles share one failure for create and remove, so create-success-then-predecessor-delete-failure is inferred from order plus the send cleanup case.
- CLI in-memory service does not model replacement generations; replacement 409 is proven on the API router.
- Work-document “Verified” labels were not used as evidence.

## Next steps

1. Parent may treat this review as Clear for T3+T4 and proceed to T5.
2. Optional, not required for closure: inject cancel `remove` failure at domain and router and assert 503 with retained inactive state.
