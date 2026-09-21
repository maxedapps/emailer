# Queued campaign cancellation — plan review

- Date: 2026-09-17
- Targets: [implementation plan](queued-campaign-cancellation.md), [proposed ADR-0016](../0016-cancelling-pending-campaign-runs.md)
- Status: Clear — R1 corrected and closed by independent re-review
- Scope: plan correctness, feasibility, sequencing and validation sensitivity; implementation and deployment were not performed

## Independent review

A fresh reader reviewed the plan against lifecycle/domain/storage code, dispatcher behavior, transaction primitives, test seams, accepted ADRs 0011/0013/0014/0015, API schemas, Vitest configuration, deployment documentation and the relevant wiki pages. It did not edit the targets, run tests, access AWS or mutate Git. Provider claims were checked against repository evidence and the parent's previously inspected official sources, not a new provider probe.

### R1 — A worker pause could be reported as successful cancellation

- **Evidence:** The original draft treated any same-token paused reread after a failed cancellation transaction as idempotent success. Existing `Storage/Campaigns.ts:pauseRun` preserves the token; `Dispatching.ts:submitClaimed` can submit recipients and later pause the run. Therefore queued A → begin A → submit → automatic pause A → failed cancel CAS → paused A was reachable.
- **Impact:** A first-send cancellation could report success even though the worker won and mail had been submitted. Tests stopping the worker-wins interleave at sending would not reject the mistake.
- **Smallest correction:** After failed CAS, require the same token in the cancellation's expected inactive destination. Scheduled/first-send cancellation expects draft. Queued-resume cancellation expects paused with manual reason. Read the already-stored pause reason in the coherent snapshot. Worker-induced pauses conflict without cleanup; an initially paused command remains idempotent.
- **Disposition:** Accept. Parent independently confirmed the same counterexample. The correction reads one existing field and tightens outcome classification; it adds no persisted state, service or retry mechanism.
- **Applied plan changes:** Exact conflict policy, internal snapshot, T2 regression, test matrix and ADR-0016. The regression explicitly covers first and resumed queued observations with begin→claim/settle→automatic-pause before the cancel reread, plus concurrent successful cancellation reaching the expected destination.
- **Acceptance signal:** Independent re-review confirms the refined policy excludes automatic pauses while retaining safe idempotence and replacement ownership.
- **Closure:** The original reviewer inspected the revised plan/ADR and confirmed Clear on 2026-09-17. It verified the expected-destination/manual-reason rule, both queued-origin regressions, no cleanup after automatic pause, and preserved initial-paused idempotence. No residual material findings.

Other reviewed areas had no material findings: token retention/CAS, stable transaction replay, resumed history, replacement-safe Scheduler resource identity, primary-effect-first ordering, post-create cleanup and live queue evidence.

## Parent research dispositions

- **Accept:** Two bounded readers verified the API/CLI contract and existing provider-test seams. Use a cancel-only error admitting all six states; no public token or new response envelope. Reuse liveStorage beforeCommit and injected AWS transport rather than a simulated expression engine.
- **Accept:** A concrete Scheduler factory is necessary to test raw AWS names/error handling; high-level domain doubles cannot establish those details.
- **Accept with narrower implementation:** Add a stale-disposition log in the existing stale exit instead of logging every successful dispatcher slice. It supplies the required cancellation evidence with less logging and no handler-result redesign.
- **Alternative not selected:** One research handoff suggested predecessor cleanup before publish/create. Primary-effect-first ordering is selected because a failed old-resource deletion should not prevent the already-committed generation's wake/provisioning. Token guards already make the predecessor inert. The independent review found no correctness gap in this order.
- **Accept:** Keep migration of pre-existing campaign-named resources outside the fresh-stage acceptance plan and state the orphan-cleanup limit explicitly.

## Document validation

The parent verified referenced existing test paths, relative document links, unique task IDs, required task fields, shell syntax, whitespace and final newlines. The repository formatter excludes `.adr/**`; targeting these documents reports no eligible files, so no formatter result is claimed for them. Application tests are not rerun for a planning-only change. The earlier 112-test baseline and manual split-read reproduction are historical evidence only. All commissioned research/review readers completed; no task worktree, cloud resource or background test process was created.
