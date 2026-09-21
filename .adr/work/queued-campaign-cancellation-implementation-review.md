# Code review: Queued campaign cancellation (full implementation)

## Review constraints

| Axis | Selection |
|---|---|
| Target | Full queued-campaign-cancellation implementation in worktree `queued-campaign-cancellation` (uncommitted vs `a5e66c6`) |
| Baseline | Plan-backed vs `.adr/work/queued-campaign-cancellation.md` and accepted ADR-0016; constrained by ADR-0011/0013/0014/0015 as cited |
| Scope | Full plan T1–T6 plus required callers, contracts, shared state, and integration boundaries |
| Invocation | Standalone final implementation review |
| Output | `.adr/work/queued-campaign-cancellation-implementation-review.md` |
| Dimensions | Correctness, types/trust boundaries, tests/validation, APIs/compatibility, operations; simplicity only where it affects cancellation risk |
| Validation/tools | Authorized unit command (plus `CampaignSchedule.test.ts`). No AWS, deploy, `pnpm check`, commit, or implementation edits |
| Writes/artifacts | This report only |

## Summary

T1–T5 production behavior matches the plan and accepted ADR-0016. Control reads are coherent; lifecycle writes are expected-source transactions that retain tokens; cancel classifies worker pauses and replacement generations as 409; resumed history is not reset; queued wake repair uses the token observed with queued state; schedules are named by run token with primary-effect-first ordering; HTTP/CLI expose the cancel-only 409 without run tokens. Challenged counterexamples — silent fire-drop of a live replacement, double-send, send-after-cancel, cancel-of-replacement, history reset, worker-pause-as-success, replacement-token enqueue, Scheduler name collision, and token leakage — do not reproduce in inspected code or unit tests.

T6 live acceptance did not complete (credentials-misconfigured first run, then AWS KMS `InternalParameterValueException` on Lambda create; stage destroyed). Live matrix rows are Unverifiable, not code defects. Unit evidence for this review: 209 passed. Do not Confirm ADR-0016 or close the plan until the live gate is green.

## Related decomplex review

- **Report:** `.adr/work/queued-campaign-cancellation-decomplex.md` (plan/structural; Clear)
- **Owner disposition summary:** Parent accepted the Clear structural assessment. Prior implementation reviews: T1+T2 Clear after R2 (F1 resolved); T3+T4 Clear (no findings). This report does not reuse those closures as proof; the tree was re-inspected.

## Coverage

### Inspected

- Plan outcome/boundaries, behavior table, invariants, exact conflict policy, storage protocol, Scheduler/command side effects, deployment boundary, T1–T6, test matrix, final acceptance
- ADR-0016 (Accepted) and cited constraints in ADR-0011, ADR-0013, ADR-0014, ADR-0015 (superseded in part for cancel/schedule naming/order and command-write mechanism)
- Diff vs `a5e66c6` for modified production/test/docs files; new `CampaignSchedule.ts`, `CampaignSchedule.test.ts`, `CampaignCancellation.integration.test.ts`
- `apps/backend/src/{Campaigns,CampaignSchedule,Dispatching,Api,Storage/Campaigns,Storage/Primitives}.ts`
- `packages/api/src/{Schemas,Api,Client}.ts`; `apps/cli/src/Commands.ts`; `README.md`; `.env.example`
- `apps/backend/test/IntegrationSupport.ts` (`once`, `liveStorage` capture/replay, mapping acquireRelease, stale-log poll)
- Domain/storage/dispatcher/adapter/router/CLI unit tests named above
- Alchemy CreateSchedule binding (GroupName / FlexibleTimeWindow / RoleArn injection) and `wiki/aws/scheduler.md`
- Work-document T6 evidence treated as claims, not proof of live success

### Skipped or partial

- Live AWS, deploy, destroy inventory, CLI walkthrough, `pnpm check` / typecheck / lint
- Mutating production to restore split-read, delete-before-create, or own-result OR branches
- Wiki pages beyond scheduler/DynamoDB rules already encoded in ADR-0013/0016
- Work-document task Status/Evidence labels (treated as claims)

### Required boundaries

- Public cancel contract (`manual`, `CampaignCancellationConflict` on `POST /:id/cancel`) without exposing run tokens
- One strongly consistent META control read; queued wake repair must not follow a replacement generation
- Expected-source command transactions; no own-result OR; tokens retained and never reused
- Cancel vs `beginRun` on the same META; startedAt distinction; worker-pause vs manual destination
- Scheduler `Name`/`ClientToken` = run token; no delete-inside-create; conflict never deletes a replacement
- Dispatcher stale wakes: no claims/submissions/continuations; late settlement still allowed
- No new infrastructure; live confirmation is T6 and is not claimed here

## Validation

- **Run:** `pnpm exec vitest run --project unit apps/backend/src/Campaigns.test.ts apps/backend/src/Storage/Campaigns.test.ts apps/backend/src/CampaignSchedule.test.ts apps/backend/src/Dispatching.test.ts apps/backend/src/Api.test.ts` — 5 files, 209 passed
- **Skipped/unavailable:** `pnpm check`, typecheck, lint, live AWS, ephemeral deploy, CLI help against a deployed stage, mutation of owner tests to restore pre-fix behavior. Challenge results are from source and current oracles. Parent-recorded `pnpm check` 728 and T6 destroy inventory were not re-executed.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** Adequate. Invariants, conflict policy, storage protocol, generation-named Scheduler identity, primary-effect-first order, crash/orphan limit, and the T1–T6 test split are testable and consistent with accepted ADR-0016. ADR-0016 intentionally supersedes ADR-0013’s own-result OR branch for command writes and ADR-0015’s untokened cancel plus campaign-named delete-before-create. Live confirmation is an explicit T6 gate, not a silent assumption. No baseline conflict requiring a human decision. Confidence high.

2. **Implementation compliance:** T1–T5 production behavior matches the plan. Matrix: Complete for unit-backed contract, storage, command, adapter, HTTP/CLI, and diagnostic rows; one Partial (cancel-delete-failure 503 is implemented and inactive retry is tested, but cancel-specific remove-failure is not injected at domain/router); live T5/T6 execution rows Unverifiable because the ephemeral gate did not finish. No Missing/Incorrect/Overbuilt production rows. No approved deviations. Task Status “Verified” / “Blocked” was not treated as proof; the tree was inspected directly. Confidence high for inspected code; live DynamoDB/SQS/Scheduler evaluation is not confirmed.

3. **Implementation quality beyond the baseline:** No extra material generic risk. Challenged silent fire-drop of a live replacement, double-send, send-after-cancel, cancel-of-replacement, resumed-history reset, worker-pause-as-success, replacement-token enqueue, Scheduler name collision, and token leakage do not reproduce. Baseline `Name: campaignId` plus delete-before-create is gone. Worker `beginRun` / claim / settle paths are unchanged. Orphan schedules after crash remain a documented limit, not an implementation hole.

4. **Test and validation quality:** Unit suites protect the classification, destination fields, token retention, wake-repair regression, adapter identity, delayed create/delete, HTTP 200/404/409/503, CLI nonzero conflict, and stale-wake diagnostic. Live tests exist for both cancel/begin orders, the draft→scheduled→draft stale write, resume history, transaction replay, feedback-vs-baseline, and queued stale consumption with mapping restore; they were not executed. Storage unit tests still assert request shapes, not provider evaluation. That live gap is Unverifiable per the known T6 fact, not a finding that the tests cannot work: capture includes `ClientRequestToken`, replay bypasses the hook, `once` wraps interference, and the mapping helper is scoped acquireRelease.

## Plan compliance matrix

| Authority item / implied requirement | Expected evidence | Implementation evidence | Validation / test evidence | Status |
|---|---|---|---|---|
| T1: `manual` on PauseReason | Literal accepted on paused Campaign | `packages/api/src/Schemas.ts:196-203` | `Schemas.test.ts` PauseReason encode; API/CLI paused+manual success | Complete |
| T1: cancel-only `CampaignCancellationConflict { state }` tagged 409; all six states; no public token | Error class + cancel endpoint; Campaign unchanged | `Schemas.ts:465-471`; `packages/api/src/Api.ts:200-209`; Campaign has no `runToken` | Encodes all six states; router 409 bodies and client decode lack `runToken` | Complete |
| T1: replace `getCampaignRun` with metadata-only `getCampaignControl` from one consistent META read | `{ state, runToken, startedAt, pausedReason }`; shared decoder; `ConsistentRead` | `Storage/Campaigns.ts:107-112,190-195,351-365`; `Primitives.ts` `readItem` uses `ConsistentRead: true` | Storage control decode, tokenless draft, missing none | Complete |
| T1: consumers/doubles migrated; public shapes and endpoint names preserved | No `getCampaignRun` / `unscheduleCampaign` | Repo grep: both gone; cancel still `POST /:id/cancel` | Router/CLI still `campaigns.cancel` | Complete |
| T1/T2: queued wake repair uses the token observed with queued state; intervening change is concurrency, not corruption | No second ownership read; missing queued/scheduled token is command-corrupt | `Campaigns.ts:108-124,160-161,192-193`; `requireRunToken` on the snapshot | Send/resume × replacement scheduled token / cancelled tokenless draft (`Campaigns.test.ts:709-793`); queued-without-token is corrupt | Complete |
| T2: enqueue/schedule/resume/cancel are tokenized single-item transactions with exact expected source state/token | `runTransaction`; no IN-list/OR own-result branch; `attribute_not_exists(runToken)` for tokenless draft | `Storage/Campaigns.ts:367-494`; baseline own-result OR and `#state IN (:draft, :scheduled)` are gone | Request-shape tests pin conditions, new token in `:run`, no `IN`/`OR`; conflict → `"conflict"` | Complete |
| T2: rename `unscheduleCampaign` → `cancelCampaign`; both queued origins; retain token; draft removes `queuedAt`; resume-cancel preserves history | Started vs unstarted conditions; SET/REMOVE fields | Never-started/scheduled: `SET draft REMOVE queuedAt`; resume: `SET paused, pausedReason = manual` without REMOVE of cursor/counters/token/`queuedAt`/`startedAt` | Storage destination tests; domain retain-token and paused history | Complete |
| T2: commands decide from one control snapshot; failed send/schedule/resume publish nothing and return a fresh Campaign | No ignored mutation results; no-op on ineligible states | `Campaigns.ts` send/schedule/resume/cancel switches; conflict → `get()` without wake/create/remove | Domain tests for lost source, ineligible states, and 503 after durable write | Complete |
| Exact conflict policy: reread once; 404 if missing; same-token expected destination is idempotent success and may clean up; worker pause, sending, completed, and any other generation are 409; no recursive cancel | Manual reason required for queued-resume destination; replacement token never cleaned | `cancellationReachedDestination` `Campaigns.ts:260-270`; cancel `272-329`; cleanup only on applied / expected-destination paths | Domain: draft/paused retry; sending/completed 409; replacement draft/paused/sending 409 and no `remove`; concurrent same-token draft/manual-paused success; worker `rate-limited` pause 409 for fresh and resumed queued; begin-wins sending 409 | Complete |
| Invariant: every new send/schedule/resume mints a unique token; nothing clears or reuses one; virgin draft may have none | Cancel does not `REMOVE runToken`; next write matches observed token then SETs a new one | Cancel update expressions omit `runToken`; enqueue/schedule/resume SET `:run`; create META has no token; `newIdentifier` is UUID v4 | Storage: retired-token match vs `attribute_not_exists`; domain: post-cancel token still `existingRunToken` | Complete |
| Invariant: cancel vs `beginRun` on META; SQS/Lambda start does not win; stale begin does not claim | `beginRun` still `queued\|sending\|scheduled` + token; cancel destinations are draft/paused | `beginRun` `Storage/Campaigns.ts:496-517` unchanged in this diff; cancel destinations leave those states | Domain begin-wins 409; `Dispatching.test.ts` stale begin: no claims/submits/list/settlements/complete/continuation | Complete |
| ADR-0011/0014: no recipient reset, no run entity, no body migration; late settlement remains possible | Cancel does not touch SEND rows or lifetime counters; settle stays state-independent | Cancel SET only state/`pausedReason` or REMOVE `queuedAt`; `settleRecipient` still unconfirmed+sendId / `attribute_exists(pk)` | Storage cancel expression omits counters/cursor; dispatcher still settles a pre-claimed row after stale begin | Complete |
| ADR-0013/0016: no own-result OR; transport retry uses `ClientRequestToken`; conflict cancellation is a new token | Representative lifecycle Update through the real binding | `commitLifecycle` → `runTransaction`; primitive timeout/conflict classification unchanged | `Primitives.transport.test.ts` lifecycle Update: identical body+token on server error; new token on conflict cancellation | Complete |
| T1/T2-owned matrix: worker pause before cancel reread is not cancellation | 409, preserved history, no cleanup; both queued origins | Classification uses expected draft vs paused+manual, not “any paused same token”; dispatcher never writes `manual` | Domain tests for never-started and resumed snapshots (`Campaigns.test.ts:1307-1371`) | Complete |
| T3: extract concrete adapter; `Name`/`ClientToken` = run token; no UUID concatenation | Factory in `CampaignSchedule.ts`; 36-char UUID names | `campaignSchedule` `apps/backend/src/CampaignSchedule.ts:17-35`; `newIdentifier` is UUID v4 | Adapter create: `Name`/`ClientToken` are `runToken`; no delete | Complete |
| T3: create never deletes; remove by observed token; NotFound success; other errors unavailable; no Conflict-as-success; no List/GetSchedule | Adapter create/delete only | Create has no delete (`CampaignSchedule.ts:17-35`); remove catches only `ResourceNotFoundException` (`36-41`); Conflict → `StorageFailure` unavailable; `Api.ts`/`Dispatch.ts` have no List/Get | Adapter tests: create failure does not delete; NotFound remove succeeds; Conflict delete is unavailable | Complete |
| T3: preserve stage group, role, target payload, future-time check, least-privilege bindings | Same `CreateSchedule(role, group)` / `DeleteSchedule(group)`; UTC `at()`; queue input unchanged | `Api.ts:191-217` still yields group/role bindings and injects the factory; payload still `encodeDispatchMessage`; past `sendAt` 409s before write (`Campaigns.ts:211-213`); binding injects GroupName / FlexibleTimeWindow OFF / RoleArn | Adapter request: UTC `at()`, `ActionAfterCompletion: DELETE`, queue ARN + dispatch input. Live IAM is T6 | Complete |
| T3 send: commit queued generation, enqueue wake, then remove predecessor; cleanup failure must not unpublish | Wake before `remove`; 503 after wake | `Campaigns.ts:150-156` | Order `enqueueCampaign, enqueue, remove`; “still publishes the wake when predecessor cleanup fails”; lost enqueue source publishes nothing | Complete |
| T3 schedule: commit, create, reread, delete own resource if no longer that scheduled generation, then predecessor | Primary create before cleanup; own token on obsolescence | `Campaigns.ts:232-249` | Order `scheduleCampaign, create, remove`; delayed predecessor delete uses old token only; late create removes own token, not replacement | Complete |
| T3 resume / queued repair: enqueue observed queued token only; no extra mint/delete | Resume has no `CampaignSchedule` | `Campaigns.ts:170-200`; `wakeQueued` `114-124` | Queued repair tests enqueue the captured token; resume has no schedule create/remove | Complete |
| T3 cancel: after applied write, remove only the observed token; already-inactive retries that token; conflict never deletes replacement | Cleanup gated on applied / expected destination | Applied then `remove(runToken)` `306-310`; draft/paused retry `277-284`; conflict returns before remove `319-322`; idempotent destination removes observed token `325` | Domain: write-then-remove; inactive retry; replacement 409 and `removed` empty. HTTP replacement paused: no `removeSchedule` | Complete |
| Failed command write produces no external effects | No wake/create/remove on conflict | Send/schedule/resume only side-effect when outcome is queued/scheduled | Lost-source send/schedule: no wake/create/remove | Complete |
| T3/ADR-0016: old cleanup cannot delete a newer schedule (silent fire-drop) | Distinct names; delayed delete still names the predecessor | `remove(predecessor)` / `remove(runToken)` never uses `campaignId`; baseline `Name: campaignId` + delete-before-create is gone from `Api.ts` | Adapter Name=runToken; delayed-delete test `Campaigns.test.ts:931-961` | Complete |
| T3/ADR-0016: late create removes its own obsolete resource | Post-create control reread | `stillScheduled` uses current state+token (`236-244`) | `Campaigns.test.ts:964-989` removes created token, not replacement | Complete |
| T3/T4 matrix: delete fails after cancellation → durable inactive, observable 503, repeat cancel retries same identity | Domain + router | Applied write then `remove`; `publicly` maps `StorageFailure` to 503; draft/paused retry same token | Domain: retry and order. Send cleanup 503 exists. No cancel-specific remove-failure injection in `Campaigns.test.ts` or `Api.test.ts` | Partial |
| T4: router + generated client 200 draft / manual-paused; tokens absent | Real handler + client | `Api.ts:77` `publicly(Campaigns.cancel)`; Campaign schema has no `runToken` | `Api.test.ts` scheduled/never-started queued → draft 200; queued resume → paused+manual+history; bodies lack `runToken` | Complete |
| T4 / exact conflict: 409 for sending, completed, and replacement generation; no mutation/cleanup | Tagged `CampaignCancellationConflict`; all six states admitted | Error on cancel endpoint | Router: sending/completed 409, no `cancelCampaign`/`removeSchedule`; replacement paused 409, no remove. Client decodes sending 409 without `runToken` | Complete |
| T4: 404 missing, 503 sanitized provider failure | Existing NotFound / StorageUnavailable | `publicly`; cancel 404 from `readControl` | `Api.test.ts` missing cancel 404; control-read 503 | Complete |
| T4 CLI: help covers scheduled, queued first send, queued resume; generic reporter nonzero on conflict; no extra formatting | Description/examples; `reporting` unchanged | `Commands.ts:556-575` | Help test asserts those phrases, not `runToken`. Sending conflict: nonzero, stderr tag, stdout empty, campaign unchanged | Complete |
| T4 README: cancel semantics, concurrency, durable write then cleanup failure, active-send boundary, no prompt orphan deletion | Operator-facing limits | CLI section `README.md:173-180`; recovery `353-358` | Text: 409 for sending/completed/replacement; does not stop in-flight SES; leftover delete retried on repeat cancel; orphans until fire/`DELETE` or teardown | Complete |
| T5: structured stale diagnostic; only campaignId/runToken/disposition; successful discard | Info log on stale `beginRun`; no mailer/claim effects | `Dispatching.ts:98-105` | `Dispatching.test.ts` asserts exact log tuple and no claims/submits/settlements/continuation | Complete |
| T5: mapping helper discovers the one test mapping, waits Disabled, restores in a finalizer; `once` beforeCommit; separate ordinary store in the hook | IntegrationSupport only | `disableDispatcherMapping` acquireRelease `IntegrationSupport.ts:592-609`; `once` `120-132`; `liveStorage` documents hook recursion | Code inspection. Live execution is T6 | Complete (implementation) |
| T5 live: cancel wins / begin wins with explicit interleave | Real DynamoDB; hook uses ordinary store | `CampaignCancellation.integration.test.ts:116-185` | Tests exist and target the conditions. Not executed (T6) | Unverifiable |
| T5 live: queued resume cancel preserves cursor/rows/counters; later resume does not resend existing rows | Seeded storage history + API cancel/resume | `CampaignCancellation.integration.test.ts:187-323` | Test exists (seeded, labelled). Not executed | Unverifiable |
| T5 live: delayed first write after draft→scheduled→draft fails; no resurrection | Expected-source tokenless write after retained token | `CampaignCancellation.integration.test.ts:325-377` | Test exists. Not executed | Unverifiable |
| T5 live: committed enqueue replay after cancel does not reinstate; cancel replay after replacement leaves replacement | Captured `ClientRequestToken` request; replay bypasses hook | Capture `IntegrationSupport.ts:219-227`; `replayTransactWrite` `523-528`; cases `379-461` | Tests would throw on condition failure if the token were missing. Not executed | Unverifiable |
| T5 live: feedback between resume commit and replay keeps original run baseline | Resume copies baselines once; replay is idempotent | `CampaignCancellation.integration.test.ts:463-565` | Test asserts `bounced=1`, `runBounced=0`. Not executed | Unverifiable |
| T5 live: queued cancel then mapping restore yields stale-disposition log and no SEND rows | Disable mapping, API send+cancel, restore, poll logs | `CampaignCancellation.integration.test.ts:567-618`; `awaitStaleWakeLog` `614-643` | Test requires correlated log before empty rows. Not executed | Unverifiable |
| T5: sequential integration files; outer timeout only on mapping/log cases | vitest integration `fileParallelism: false`; case timeouts 480s / 1200s | `vitest.config.ts:19-34`; integration file timeouts | Config inspected. Intra-file tests are sequential `it()`, not `concurrent` | Complete |
| T6: full `pnpm check` | format, lint, typecheck, all unit tests, imports | Parent claim: 728 passed | This review ran 209 authorized unit tests, all passed. Full gate not re-run | Partial |
| T6: fresh ephemeral `Emailer/test`; no new resource types or unrelated permissions | alchemy plan/deploy; Scheduler Create/Delete bindings unchanged | `alchemy.run.ts` unmodified vs `a5e66c6`; `Api.ts` still Create/Delete on the existing group | Parent: plan 28 creates, existing types. Not independently inventoried here | Unverifiable |
| T6: full live integration + CLI walkthrough + resource/permission checks | Exact acceptance commands | Implementation of CLI/API/live tests exists | First live: deploy 28 succeeded, integration failed missing AWS credentials. Later deploy: KMS InternalParameterValueException on Lambda create. Walkthrough not green | Unverifiable |
| T6: destroy ephemeral stage; retain shared sending identity; record limits | Failure-safe teardown | Parent: destroy 28/28; leftover IAM roles from interrupted creates deleted; no remaining test functions/tables/queues/groups | Not independently inventoried. Known T6 fact, not a code defect | Unverifiable |
| T6 / ADR-0016 Confirmation: mark confirmed only with live results | ADR stays Accepted, not Confirmed | ADR-0016 header has Accepted, no Confirmed; work doc Status Partial / T6 Blocked | Process matches the plan’s completion rule | Complete |
| Out of scope kept out: no active-send interrupt, run entities, client idempotency keys, automatic orphan reconciliation, dual-name migration | No new infra or silent dual naming | No campaign-delete interrupt; no List/GetSchedule; no dual Name path; `alchemy.run.ts` unchanged | README states the limits | Complete |
| Implied: Scheduler names fit 64-char limit; ClientToken supplied | UUID name, not campaignId+token | `Name`/`ClientToken` = run token only (36 chars) | Adapter test. No concatenation | Complete |
| Implied: public JSON/CLI/help/error bodies never leak `runToken` | Campaign and conflict schemas omit it | Schema/error fields; stale log is internal dispatcher info only | Router/client/CLI/help asserts `not.toContain("runToken")` | Complete |

### Approvals and conflicts

- **Approved deviation:** None. Crash-time orphans, non-atomic DB+SQS+Scheduler, and deferred persistent-stage migration are documented limits in ADR-0016, not silent descopes. T6 live non-completion is recorded as Unverifiable, not recast as an implementation deviation.
- **Authority conflict:** None. ADR-0016’s supersession of ADR-0013 own-result OR and ADR-0015 campaign-named delete-before-create is the plan’s stated baseline.

## Follow-up closure

- **Round and material delta:** R1, first full-plan implementation review. Prior T1+T2 F1 (replacement-wake regression tests) is present in this tree and is not re-opened. T3+T4 had no findings.
- **Closure state:** Clear
- **Resolved or withdrawn:** —
- **Still material:** —
- **New fix-caused or fix-exposed findings:** —

## Findings

No material findings.

## Context-dependent concerns

- **Concern:** Cancel-delete-failure 503 is not injected at domain or router (matrix Partial). A cancel path that ignored `remove` errors would still pass the current cancel cases.
- **Disposition:** Not a finding. Production uses the same uncaught `yield*` as the tested send-cleanup 503; inactive same-token retry is tested; README already describes the operator recovery.

- **Concern:** T5 live cases were not executed, so DynamoDB actually evaluating expected-source conditions, transaction replay within ten minutes, and correlated stale-wake consumption are unproven in this review.
- **Disposition:** Unverifiable matrix rows, not S2. The tests look capable of working: `liveStorage` captures the physical request including `ClientRequestToken`, `replayTransactWrite` bypasses the hook, `once` plus a separate ordinary store wrap `beforeCommit`, and the mapping helper restores in a finalizer. Do not treat parent “Verified” labels or this review’s Clear as live proof.

- **Concern:** T6 `pnpm check` 728 was not re-run here.
- **Disposition:** Not a finding. Authorized unit subset passed (209). Full gate remains a parent T6 claim.

## Confirmed-good areas

- Worker-induced pause is not successful cancel: destination check requires draft for never-started sources and `paused`+`manual` for resumes; dispatcher never writes `manual`.
- Replacement generations in draft/paused/sending conflict with 409 and no cleanup, including when the replacement is itself inactive.
- Concurrent cancel that already reached the expected destination succeeds idempotently for scheduled→draft and queued-resume→manual paused.
- Tokens stay on draft/paused; enqueue/schedule match the retired token rather than `attribute_not_exists`; new identifiers are minted; cancel expressions never `REMOVE runToken`.
- Queued-resume cancel SETs only `state`/`pausedReason`; cursor, `queuedAt`, `startedAt`, counters, and SEND rows are untouched.
- `beginRun` still loses to draft/paused; a cancelled generation’s wake is stale and claims nothing; late settlement remains state-independent.
- Own-result OR branches are gone; transport tests show stable lifecycle request tokens on SDK retry vs new tokens on conflict cancellation.
- Baseline delete-before-create (`Api.ts` `remove(campaignId)` then `Name: campaignId`) is gone; factory create cannot delete.
- Delayed predecessor delete is aimed at the old token; late create deletes only its own identity.
- Failed send/schedule writes publish nothing; conflict cancel does not call `remove`.
- Queued wake repair does not consume a later control snapshot; send/resume × replacement-scheduled and cancelled-draft cases leave the unread snapshot in the queue.
- Public Campaign JSON, cancel error bodies, and CLI stdout/help do not include `runToken`.
- README explicitly refuses active-send interrupt and prompt orphan deletion.

## Limitations and caveats

- Full-plan review of implementation vs plan/ADR. Live AWS behavior is Unverifiable because T6 did not complete (credentials, then KMS). That is not recast as an implementation defect.
- Storage unit tests assert request shapes, not provider evaluation of conditions.
- Adapter tests use injected AWS callables, not live Scheduler.
- Domain schedule doubles share one failure for create and remove, so create-success-then-predecessor-delete-failure is inferred from order plus the send cleanup case.
- CLI in-memory service does not model replacement generations; replacement 409 is proven on the API router.
- Work-document “Verified” / “Blocked” labels and parent T6 inventory were not used as implementation proof.
- Uncommitted worktree vs `a5e66c6`; HEAD is the planning baseline.

## Next steps

1. Parent may treat this review as Clear for the implementation. No production changes are required by this report.
2. Re-run T6 live when Lambda KMS in us-east-1 is healthy, with credentials available to the integration process. Do not Confirm ADR-0016 or mark the plan Complete until that gate is green.
3. Optional, not required for closure: inject cancel `remove` failure at domain and router and assert 503 with retained inactive state.
