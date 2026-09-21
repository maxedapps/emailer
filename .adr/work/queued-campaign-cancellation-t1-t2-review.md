# Code review: Queued campaign cancellation T1+T2

## Review constraints

| Axis | Selection |
|---|---|
| Target | T1+T2 implementation in worktree `queued-campaign-cancellation` (uncommitted vs `a5e66c6`) |
| Baseline | Plan-backed vs `.adr/work/queued-campaign-cancellation.md` and accepted ADR-0016; constrained by ADR-0011/0013/0014/0015 as cited |
| Scope | Bounded to T1+T2: contract, control reads, lifecycle transactions, cancel conflict policy, related unit tests |
| Invocation | Embedded in implement-plan |
| Output | `.adr/work/queued-campaign-cancellation-t1-t2-review.md` |
| Dimensions | Correctness, types/trust boundaries, tests/validation, APIs/compatibility; simplicity only where it affects T1+T2 risk |
| Validation/tools | Authorized T2 unit command; extra T1 `packages/api/src/Schemas.test.ts` run. No AWS, deploy, commit, or implementation edits |
| Writes/artifacts | This report only |

## Summary

T1+T2 implement the generation-owned cancel contract correctly. Control reads are coherent; lifecycle writes are expected-source transactions that retain tokens; cancel classifies worker pauses and replacement generations as 409; resumed history is not reset; queued wake repair uses the token observed with queued state. One material test gap remains: the T1 domain regression that a queued observation must not enqueue a later scheduled replacement token is not present, and the current suite would not fail if split-read were restored.

## Related decomplex review

- **Report:** `.adr/work/queued-campaign-cancellation-decomplex.md` (plan/structural; Clear)
- **Owner disposition summary:** Parent accepted the Clear structural assessment. This review is a separate implementation report and does not reuse that closure.

## Coverage

### Inspected

- Plan T1/T2, Behavior and invariants, Exact conflict policy, Storage protocol, T1/T2-owned test-matrix rows
- ADR-0016 (Accepted) and cited constraints in ADR-0011, ADR-0013, ADR-0014, ADR-0015
- Diff vs `a5e66c6`: `packages/api/src/{Schemas,Api,Schemas.test}.ts`; `apps/backend/src/{Campaigns,Storage/Campaigns,Campaigns.test,Storage/Campaigns.test,Dispatching.test,Storage/Primitives.transport.test,Api.test}.ts`
- Callers of the new control snapshot and lifecycle outcomes, including `beginRun`, `pauseRun`, `settleRecipient`, and dispatcher stale exit
- Existing plan review `.adr/work/queued-campaign-cancellation-review.md` (R1 worker-pause classification) used as prior evidence, not authority

### Skipped or partial

- T3 Scheduler identity, adapter factory, primary-effect-first ordering, post-create obsolescence check, inactive cleanup retry
- T4 HTTP/CLI conflict reporting, generated-client decoding, README
- T5 live DynamoDB races, queue consumption, stale-disposition log
- T6 deploy, `pnpm check`, ephemeral acceptance
- `wiki/` and provider docs beyond the transaction/`ClientRequestToken` rules already encoded in ADR-0013/0016
- Work-document task Status/Evidence labels (treated as claims)

### Required boundaries

- Public cancel contract (`manual`, `CampaignCancellationConflict` on `POST /:id/cancel`) without exposing run tokens
- One strongly consistent META control read used by send/schedule/resume/cancel
- Expected-source command transactions; no own-result OR branch; tokens retained and never reused
- Cancel vs `beginRun` on the same META; startedAt distinction; worker-pause vs manual destination
- Queued wake repair must not follow a replacement generation
- Dispatcher stale wakes: no claims/submissions/continuations; late settlement still allowed

## Validation

- **Run:** `pnpm exec vitest run --project unit apps/backend/src/Campaigns.test.ts apps/backend/src/Storage/Campaigns.test.ts apps/backend/src/Dispatching.test.ts apps/backend/src/Storage/Primitives.transport.test.ts` — 4 files, 139 passed
- **Run (T1 extra):** `pnpm exec vitest run --project unit packages/api/src/Schemas.test.ts` — 121 passed
- **Skipped/unavailable:** `pnpm typecheck`; live AWS; mutation of owner tests to re-prove split-read sensitivity; T3–T6 commands. Sensitivity of F1 is reasoned from the current oracles, not a restored pre-fix run.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** Adequate for T1+T2. Invariants, conflict policy, storage protocol, and the T1/T2 test split are testable and consistent with accepted ADR-0016. ADR-0016 intentionally supersedes ADR-0013’s own-result OR branch for command writes and ADR-0015’s untokened cancel/schedule conditions. Draft/paused cleanup retry and generation-named Scheduler identity are sequenced to T3, including the plan’s “do not deploy T2 without T3” note. No baseline conflict requiring a human decision. Confidence high for this bounded slice.

2. **Implementation compliance:** T1+T2 production behavior matches the plan, with T3-owned side-effect ordering/identity omitted as required. Matrix: 20 Complete, 1 Partial (T1 replacement-wake regression tests). No Missing/Incorrect/Overbuilt/Approved-deviation rows in T1+T2 scope. Task Status “T1 Verified” / “T2 In progress” was not treated as proof; the tree was inspected directly.

3. **Implementation quality beyond the baseline:** No extra material generic risk in T1+T2. Challenged silent fire-drop of a live replacement, double-send, send-after-cancel, cancel-of-replacement, resumed-history reset, worker-pause-as-success, replacement-token enqueue, and token clear/reuse do not reproduce in this slice. Remaining campaign-id schedule deletion is T3. Unused `world.control` override is dead test scaffolding, not a production defect.

4. **Test and validation quality:** Conflict-policy, destination-field, token-retention, and transport-retry tests protect the T2 claims they name. Dispatcher stale-wake assertions were tightened. The specified T1 domain regression — queued read followed by cancel/reschedule must not enqueue the replacement scheduled token, and must not report false corruption — is not in the suite (F1). Request-shape storage tests do not evaluate DynamoDB conditions; that remains T5, as the plan states.

## Plan compliance matrix

| Authority item / implied requirement | Expected evidence | Implementation evidence | Validation / test evidence | Status |
|---|---|---|---|---|
| T1: `manual` on PauseReason | Literal accepted on paused Campaign | `packages/api/src/Schemas.ts:196-203` | `Schemas.test.ts` paused+manual round-trip and PauseReason encode | Complete |
| T1: cancel-only `CampaignCancellationConflict { state }` tagged 409; all six states; no public token | Error class + cancel endpoint registration; Campaign unchanged | `Schemas.ts:465-471`; `packages/api/src/Api.ts:200-209`; Campaign has no `runToken` | Encodes all six states; `httpApiStatus` 409 in public error table. HTTP/CLI wiring is T4 | Complete |
| T1: replace `getCampaignRun` with metadata-only `getCampaignControl` from one consistent META read | `{ state, runToken, startedAt, pausedReason }`; shared decoder | `Storage/Campaigns.ts:107-112,190-195,351-365`; `readItem` uses `ConsistentRead: true` | `Storage/Campaigns.test.ts` control decode, tokenless draft, missing none, queued-without-token returned not decoder-corrupt | Complete |
| T1: consumers/doubles migrated; public shapes and endpoint names preserved | No `getCampaignRun` / `unscheduleCampaign` | Repo grep: both gone; cancel still `POST /:id/cancel` | `Api.test.ts` fixture renamed; existing cancel-to-draft client case still uses `campaigns.cancel` | Complete |
| T1/T2: queued wake repair uses the token observed with queued state; intervening change is concurrency, not corruption | No second ownership read; missing queued/scheduled token is command-corrupt | `Campaigns.ts:108-124,160-161,192-193`; `requireRunToken` on the snapshot | Stable queued send/resume wake the stored token; queued-without-token is corrupt. No interleaving of cancel/reschedule between observation and enqueue (F1) | Partial |
| T2: enqueue/schedule/resume/cancel are tokenized single-item transactions with exact expected source state/token | `runTransaction`; no IN-list/OR own-result branch; `attribute_not_exists(runToken)` for tokenless draft | `Storage/Campaigns.ts:367-494` | Request-shape tests pin conditions, new token in `:run`, no `IN`/`OR`; conflict → `"conflict"`; `updateItemRequests` empty | Complete |
| T2: rename `unscheduleCampaign` → `cancelCampaign`; both queued origins; retain token; draft removes `queuedAt`; resume-cancel preserves history | Started vs unstarted conditions; SET/REMOVE fields | `cancelCampaign` `attribute_not_exists(startedAt)` → draft; `attribute_exists(startedAt)` → paused+manual without REMOVE of cursor/counters/token/`queuedAt`/`startedAt` | Storage tests for three destinations; domain tests retain token and paused history | Complete |
| T2: commands decide from one control snapshot; failed send/schedule/resume publish nothing and return a fresh Campaign | No ignored mutation results; no-op on ineligible states | `Campaigns.ts` send/schedule/resume/cancel switches; conflict → `get()` without wake/create/remove | Domain tests for lost source, ineligible states, and 503 after durable write | Complete |
| Exact conflict policy: reread once; 404 if missing; same-token expected destination is idempotent success and may clean up; worker pause, sending, completed, and any other generation are 409; no recursive cancel | Manual reason required for queued-resume destination; replacement token never cleaned | `cancellationReachedDestination` `Campaigns.ts:239-249`; cancel `251-306`; cleanup only on scheduled success/idempotent paths | Domain: draft/paused no-op; sending/completed 409; replacement draft/paused/sending 409 and no `remove`; concurrent same-token draft/manual-paused success; worker `rate-limited` pause 409 for fresh and resumed queued; begin-wins sending 409 | Complete |
| Invariant: every new send/schedule/resume mints a unique token; nothing clears or reuses one; virgin draft may have none | Cancel does not `REMOVE runToken`; next write matches observed token then SETs a new one | Cancel update expressions omit `runToken`; enqueue/schedule/resume SET `:run`; create META has no token | Storage: retired-token match vs `attribute_not_exists`; domain: post-cancel token still `existingRunToken`; create path has no token | Complete |
| Invariant: cancel vs `beginRun` on META; SQS/Lambda start does not win; stale begin does not claim | `beginRun` still `queued\|sending\|scheduled` + token; cancel destinations are draft/paused | `beginRun` `496-517`; cancel destinations leave those states | Domain begin-wins 409; `Dispatching.test.ts` stale begin: no claims/submits/list/settlements/complete/continuation | Complete |
| ADR-0011/0014: no recipient reset, no run entity, no body migration; late settlement remains possible | Cancel does not touch SEND rows or lifetime counters; settle stays state-independent | Cancel SET only state/`pausedReason` or REMOVE `queuedAt`; `settleRecipient` still unconfirmed+sendId / `attribute_exists(pk)` | Storage cancel expression omits counters/cursor; dispatcher test still settles a pre-claimed row after stale begin (fake store; real condition unchanged) | Complete |
| ADR-0013/0016: no own-result OR; transport retry uses `ClientRequestToken`; conflict cancellation is a new token | Representative lifecycle Update through the real binding | `commitLifecycle` → `runTransaction`; wiki/ADR-0013 retry rules unchanged | `Primitives.transport.test.ts` lifecycle Update: identical body+token on server error; new token on conflict cancellation | Complete |
| T1/T2-owned matrix: worker pause before cancel reread is not cancellation | 409, preserved history, no cleanup; both queued origins | Classification uses expected draft vs paused+manual, not “any paused same token” | Domain tests for never-started and resumed snapshots; dispatcher never pauses with `manual` (`Dispatching.ts` reputation/daily-quota/feedback/rate-limited/sending-paused) | Complete |
| T1-owned matrix: queued read then cancel/reschedule never enqueues the replacement scheduled token | Controlled effects between observation and enqueue | `wakeQueued` uses the captured snapshot only | No test mutates to a replacement scheduled generation after the queued read (F1). Work-doc T1 sensitivity claim not visible in this tree | Partial |

### Approvals and conflicts

- **Approved deviation:** None in T1+T2. T3-owned Scheduler identity, cleanup retry, and primary-effect-first ordering are sequenced, not silent descopes.
- **Authority conflict:** None. ADR-0016’s supersession of ADR-0013 own-result OR and ADR-0015 untokened cancel is the plan’s stated baseline.

## Follow-up closure

- **Round and material delta:** R2, test-only. After R1, `queued wake repair` queues a second `getCampaignControl` snapshot (replacement `scheduled` token, or cancelled tokenless draft) after the queued observation. Production `wakeQueued` is unchanged and still enqueues only the captured snapshot. Parent proved the four new send/resume cases fail if `wakeQueued` re-reads `getCampaignControl`, then restored production. This review re-ran `pnpm exec vitest run --project unit apps/backend/src/Campaigns.test.ts` (51 passed) and inspected the double, `send`/`resume`/`wakeQueued`, and the T1 matrix row. No production edits in R2. R1 Partial rows for that T1 regression are Complete under this delta; the R1 matrix body is left as historical.
- **Closure state:** Clear
- **Resolved or withdrawn:** F1
- **Still material:** —
- **New fix-caused or fix-exposed findings:** —

## Findings

### S2 — T1 replacement-wake regression is not in the suite

- **Status:** Resolved (R2)
- **Dimension / authority:** Tests/validation; plan T1 tests + matrix row “Queued read followed by cancellation/reschedule”
- **Location:** `apps/backend/src/Campaigns.test.ts:651-754` (`queued wake repair`); `world.control` queue at `166-172`; `wakeQueued` `Campaigns.ts:114-124`
- **Impact (R1):** The pre-change defect — `send`/`resume` observe queued, then a later read follows a cancel+schedule and enqueues the new scheduled token — can be restored without failing the current unit tests. That wake can start a generation the operator just scheduled, or at least publish the wrong identity. False corruption after cancel is independently closed by token retention plus no second read, but the replacement-token half is not locked.
- **Evidence (R1):** Current oracles only cover a stable queued world (`re-wakes only the token observed with queued state`) and true corruption when the snapshot itself has no token. Nothing changes control to `scheduled` + a new token after the first read. `world.control` exists to override snapshots and is never written. `wakeQueued` (`Campaigns.ts:114-124`) is correct today because it does not re-read; that shape is not what the tests check. Plan T1 required controlled effects between reads and named this regression; work-document “Verified”/sensitivity text is not in this tree.
- **Evidence (R2):** `getCampaignControl` now `shift`s a pending `world.control` queue (`Campaigns.test.ts:166-172`). Four new cases (`send`/`resume` × replacement scheduled token / cancelled tokenless draft, `676-732`) present that second snapshot after the queued observation and assert the emitted wake is still `existingRunToken`, the command succeeds with the queued campaign (not `corrupt`), and the replacement case leaves the unread scheduled snapshot in the queue. Production `send`/`resume` pass the first-read control into `wakeQueued`, which calls `requireRunToken(control)` with no second store read (`Campaigns.ts:114-124,160-161,192-193`). `get` after enqueue reads `getCampaign`, not control (`Campaigns.ts:30-40`). A restored `getCampaignControl` inside `wakeQueued` would consume the replacement/`draft` snapshot: enqueue `replacementToken`, or `corrupt` on the tokenless draft. Parent already demonstrated those four failures then restored production; this round did not re-mutate. Authorized unit file: 51 passed.
- **Confidence:** C3
- **Condition:** Reintroduce a `getCampaignControl` (or equivalent) inside `wakeQueued` after send/resume already observed queued.
- **Validation state:** R2 unit command green on current production. Split-read sensitivity claimed by parent proof plus the queue-seam oracles; not re-run as a production mutation in this round.
- **Smallest safe fix / validation:** Done. Send and resume cases present a replacement scheduled control (new token) and a later cancelled draft after the queued observation; they assert the original queued token is woken and the path is not `corrupt`. The pending-control queue is the inter-read seam.

## Context-dependent concerns

- **Concern:** Initial draft/paused cancel does not retry schedule deletion (`Campaigns.ts:257-259` returns `get()` with empty `order` in tests). The behavior table mentions retrying deletion of a retained token; T3 owns inactive cleanup retry and generation-named `remove(runToken)`. Implementing that retry in T2 with campaign-id names would be the ADR-0015 fire-drop window.
- **Disposition:** Out of T1+T2 scope. Do not treat as T2 noncompliance. T3 must add the retry against the observed token, not `campaignId`.

- **Concern:** Send-from-scheduled still `remove` then wake (`Campaigns.ts:148-154`). The plan’s primary-effect-first order is a T3 change; ADR-0015 order is what T2 kept. A failed cleanup can 503 before the primary wake; repeat send on queued still repairs.
- **Disposition:** T3. Plan already forbids deploying T2 without T3.

- **Concern:** `Dispatching.test.ts` late-settlement case calls `settleRecipient` on the fake store after a stale slice; it does not prove DynamoDB’s state-independent settle expression.
- **Disposition:** Acceptable for T2. Production `settleRecipient` is unchanged; live proof is T5.

## Confirmed-good areas

- Worker-induced pause is not successful cancel: destination check requires draft for never-started sources and `paused`+`manual` for resumes; dispatcher never writes `manual`.
- Replacement generations in draft/paused/sending conflict with 409 and no cleanup, including when the replacement is itself inactive.
- Concurrent cancel that already reached the expected destination succeeds idempotently for scheduled→draft and queued-resume→manual paused.
- Tokens stay on draft/paused; enqueue/schedule match the retired token rather than `attribute_not_exists`; new identifiers are minted; cancel expressions never `REMOVE runToken`.
- Queued-resume cancel SETs only `state`/`pausedReason`; cursor, `queuedAt`, `startedAt`, counters, and SEND rows are untouched.
- `beginRun` still loses to draft/paused; a cancelled generation’s wake is stale and claims nothing.
- Own-result OR branches are gone; transport tests show stable lifecycle request tokens on SDK retry vs new tokens on conflict cancellation.
- Public Campaign success shape and endpoint names are unchanged; run tokens stay off the wire.

## Limitations and caveats

- Bounded to T1+T2. Full-plan compliance is not claimed.
- Storage unit tests assert request shapes, not provider evaluation of conditions.
- R1: F1 sensitivity was not re-run against a restored split-read. R2: parent proved the four new cases fail under a temporary `wakeQueued` re-read, then restored production; this round did not re-mutate.
- `Api.test.ts` fixture updates were inspected for T1/T2 store compatibility only; router 409 cases are T4.
- Uncommitted worktree vs `a5e66c6`; HEAD is the baseline.

## Next steps

1. F1 closed in R2: T1 send/resume interleaving tests are in `queued wake repair`; parent split-read proof plus queue-seam oracles; production snapshot path unchanged.
2. Keep T3 for generation-named cleanup, primary-effect-first ordering, and draft/paused cleanup retry.
3. Do not deploy this intermediate lifecycle/Scheduler combination.
