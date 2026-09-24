# Queued campaign cancellation

> **Status:** Complete. T1–T5 are verified. On 2026-09-23 the user decided to close T6 on recorded evidence instead of repeating its walkthrough (see T6).
> **ADRs:** [Accepted ADR-0016](../0016-cancelling-pending-campaign-runs.md); constrained by [0011](../0011-open-recipient-set-and-paced-dispatch.md), [0013](../0013-repeat-safe-writes.md), [0014](../0014-campaign-body-item-and-summaries.md) and [0015](../0015-one-shot-scheduler-per-campaign.md)
> **Updated:** 2026-09-24
> **Baseline:** `a5e66c6` on `queued-campaign-cancellation` from `main` (`4b78381` planning baseline; source unchanged since then except this plan commit)

## Outcome and boundaries

- **Problem and target:** `campaigns cancel` currently ignores queued campaigns. Make it withdraw a specific pending run safely, including queued resumes, with honest results when dispatch or another command wins the race.
- **In scope:** lifecycle control reads and mutations; queued/scheduled cancellation; retry and generation ownership; Scheduler resource identity and cleanup; a manual pause reason; cancel-only HTTP/CLI conflict reporting; focused concurrency tests and ephemeral AWS acceptance.
- **Out of scope:** interrupting active SES submissions; recalling mail; repeating a completed campaign; separate run entities; recipient ledger resets; public request idempotency keys; automatic crash reconciliation; recurring schedules; new infrastructure; unrelated feature work.
- **Approach:** retain the current states, META/BODY layout, standard queue and dispatcher. Read one control snapshot, condition transitions on its state/token, reuse tokenized transactions for lifecycle commands, retain retired tokens, and give each schedule its own generation identity.
- **Authority:** the user requested this plan after the preceding design analysis, then authorized implementation with `/implement-plan .adr/work/queued-campaign-cancellation.md` on 2026-09-17. ADR-0016 is Accepted on that authority; live confirmation remains T6.

## Behavior and invariants

| State observed by cancel | Effect if its condition wins | Successful response meaning |
| --- | --- | --- |
| Scheduled | Draft; retain token; remove queuedAt | This scheduled generation was withdrawn |
| Queued without startedAt | Draft; retain token; remove queuedAt | This first-send generation cannot start |
| Queued with startedAt | Paused; reason manual; retain token, queuedAt, startedAt, cursor and counters | This pending resume was withdrawn |
| Draft or paused | No lifecycle mutation; retry deletion for its retained token, if any | Already inactive at the observation |
| Sending or completed | No mutation or cleanup; typed 409 | Cancellation did not stop it |
| Missing | Existing 404 | Campaign does not exist |

1. Cancellation and `beginRun` compete on the same META. Cancellation wins only before that generation becomes sending. SQS receipt or Lambda invocation start does not decide the race.
2. Every new send, schedule and resume mints a unique run token. No operation clears or reuses an existing token. A newly created draft can still have no token.
3. Every lifecycle write checks the exact observed state plus token, using `attribute_not_exists(runToken)` for a tokenless draft. Conditions also preserve the relevant startedAt distinction for cancellation. A failed condition never authorizes following a newer generation.
4. A queued wake repair carries the token captured with queued state. Later cancellation makes that message stale; later scheduling must never substitute its new token into the old repair.
5. Recipient records, cursor, cumulative counters and late settlements survive cancellation of a queued resume. Its per-run baselines are not reset by cancellation. An older invocation's already-claimed recipients may finish even after this cancellation.
6. A later explicit send/resume/schedule is a new intent. This work does not deduplicate separately issued HTTP requests with client idempotency keys.
7. Public Campaign responses remain observations made after the command. A concurrent later command can change the returned state. Success does not promise that no future explicit command can restart the campaign.

### Exact conflict policy

Add `CampaignCancellationConflict { state }` as a tagged 409; `state` admits all six campaign states because a replacement generation can itself be draft or paused. Do not expose run tokens in the API.

For an initially eligible cancel whose transaction condition fails, reread control once. Missing is 404. Idempotent success requires the same token in this cancellation's expected destination: draft for a scheduled/never-started queued snapshot, or paused with pausedReason manual for a queued-resume snapshot. Only that outcome may clean up the observed token. All other outcomes, including a worker-induced pause or a different generation in any state, are 409 with the observed current state. Do not invoke cancel recursively or retry its condition against a replacement. Genuine storage/provider failures remain the existing sanitized 503.

The manual-reason check matters: a worker can win beginRun, submit recipients, then pause under the same token before the losing cancel rereads. That is not successful cancellation. The initial-state paused branch remains an idempotent already-inactive success; it is distinct from classifying a failed queued cancellation.

Send, schedule and resume retain their existing no-op behavior on initially ineligible states. On a failed conditional transition they return a fresh Campaign observation without publishing or cleaning up for that failed transition. This avoids expanding unrelated public error contracts.

## Key files, evidence, and decisions

| File or source | Why it matters | Decision or plan impact |
| --- | --- | --- |
| `apps/backend/src/Campaigns.ts` | Commands and split-read wake repair; cancel ignores storage outcome | One coherent control read; explicit conditional outcomes and generation-owned side effects |
| `apps/backend/src/Storage/Campaigns.ts` | META decoder, run token, start time, lifecycle writes, begin/claim/settle | Retired tokens, expected-source transactions, resumed-history preservation |
| `apps/backend/src/Storage/Primitives.ts` | Stable transaction token, conflict retry, five-second operation timeout | Reuse unchanged; do not add another retry framework |
| `apps/backend/src/Api.ts` | Inline Scheduler adapter uses one campaign name and delete-before-create | Extract one concrete adapter factory; create/delete by run token |
| `apps/backend/src/Dispatching.ts`, `Dispatcher.ts` | beginRun is before recipient work; successful stale messages currently have no correlated disposition log | Keep dispatch guards; add a small stale-wake diagnostic for operational/test evidence |
| `packages/api/src/Schemas.ts`, `Api.ts`, `Client.ts` | Shared state/error contract and generated client | Add manual and cancel conflict; preserve Campaign success shape |
| `apps/cli/src/Commands.ts`, `Commands.test.ts` | Cancel help and typed failure reporting | Updated semantics and nonzero conflict behavior |
| `apps/backend/src/Campaigns.test.ts`, `Storage/Campaigns.test.ts`, `Dispatching.test.ts` | Existing domain fakes and request-shape checks | Add deterministic interleavings; do not mistake request snapshots for provider proof |
| `apps/backend/src/Storage/Primitives.transport.test.ts` | Real AWS binding over injected HTTP transport | Verify identical transaction body/token on SDK retry without AWS fault injection |
| `apps/backend/test/IntegrationSupport.ts`, `src/Api.integration.test.ts` | liveStorage beforeCommit hook, consistent recipient reads, simulator guard | Real DynamoDB race cases and scoped queue-consumption gate |
| `README.md`, `alchemy.run.ts`, `vitest.config.ts` | Exact deployment commands, resource inventory, sequential live files | Fresh test stage, no alert emails, complete teardown |
| `wiki/aws/{dynamodb,sqs,scheduler}.md`, `wiki/alchemy/runtime-and-bindings.md` | Conditional ownership, queue retries, non-atomic external effects, IAM bindings | Existing infrastructure is sufficient; cleanup limits remain explicit |
| ADR-0011 and ADR-0014 | Campaign-wide recipient deduplication and lean META | No reset, separate run entity or body migration |
| ADR-0013 and ADR-0015 | Current retry and scheduling decisions | ADR-0016 supersedes only the lifecycle-write mechanism, cancellation and schedule naming/order |

## Research and implementation protocol

The previous read-only analysis ran 112 focused tests successfully and reproduced `Campaigns.send` enqueueing a replacement scheduled token after its initial queued read. That is baseline evidence, not validation of this unimplemented plan. Current cancellation tests explicitly expect queued campaigns to remain unchanged.

Installed versions are Alchemy `2.0.0-beta.77`, Effect/platform-node `4.0.0-rc.112`, distilled AWS `1.0.0-rc.9`, Vitest `5.0.0`, and Node `24.x` under the manifest's exact engine range. No upgrade is required.

### Storage protocol

Replace `getCampaignRun` with a metadata-only `getCampaignControl` returning `{ state, runToken, startedAt, pausedReason }` from one strongly consistent META read. The reason is already stored; including it distinguishes manual cancellation from a worker pause after a lost race. Commands use this for decisions and call the existing public `get` only when constructing their response. Keep the decoder/projection shared with existing storage logic; avoid a second persisted model or a generic state-machine engine. Missing tokens in queued/scheduled records are corrupt; tokenless virgin drafts are valid.

Change the explicit enqueue, schedule, resume and renamed `cancelCampaign` storage operations to take the expected source state/token. Each uses one conditional Update inside existing `runTransaction`, returning a small applied/conflict outcome. There is no own-result OR branch: the transaction token handles already-committed transport repeats. Bindings and the primitive's timeout/conflict classification remain unchanged.

Enqueue/schedule/resume still capture runAccepted/runBounced/runComplained atomically from cumulative counters once. A transport retry must not copy them again after late feedback. Cancellation never changes those baselines or lifetime counters. For draft destinations remove queuedAt; for manual-paused destinations retain queuedAt and the original startedAt/cursor. Preserve all SEND rows. `beginRun`, guarded claims, checkpointing and state-independent settlement remain intact.

### Scheduler and command side effects

Keep `CampaignSchedule.create(campaignId, runToken, sendAt)` and change removal to mean `remove(runToken)`. Extract the inline AWS mapping into one small concrete factory, preferably in `apps/backend/src/CampaignSchedule.ts`, injected with the existing create/delete callables and queue ARN. The domain still owns sequencing; the factory owns AWS requests and error translation. This is an adapter test seam, not another service hierarchy.

- Create uses `Name = runToken`, `ClientToken = runToken`, the existing UTC at() expression, ActionAfterCompletion DELETE and unchanged queue payload. Do not concatenate two UUIDs: Scheduler names are limited to 64 characters. Do not delete inside create.
- Remove uses `Name = runToken`; absent is successful cleanup. Other AWS errors remain unavailable. Do not catch arbitrary Conflict as success or add List/GetSchedule to the application role.
- Schedule: commit the new scheduled generation, create its resource, reread control, remove its own resource if that generation is no longer scheduled, then remove the observed predecessor token if one existed. The current generation's primary provisioning precedes old-resource cleanup.
- Send from draft/scheduled: commit the fresh queued generation, enqueue its wake, then remove the observed predecessor token if present. A failed cleanup must not prevent the primary wake from being published.
- Resume: commit the fresh queued generation and enqueue it. Queued send/resume repair publishes only the observed queued token, without minting or deleting another generation.
- Cancel: commit the appropriate inactive state, then remove only the observed token. An already-inactive snapshot with a retained token also retries that token's deletion. A conflict never deletes the replacement's resource.
- Return a fresh public Campaign after successful side effects. On provider failure, report 503; document that the preceding database intent may already be durable.

Generation-specific resources make old cleanup safe, not atomic. A process can die before creation, after cancellation but before deletion, or after an obsolete late creation. The post-create check and explicit retries repair surviving handlers; obsolete messages remain harmless even if cleanup never executes. The current item retains only its latest token, so older orphan schedules can survive until their future execution/automatic deletion or stage teardown. Automatic orphan reconciliation is explicitly deferred.

### Deployment boundary

Use a fresh ephemeral `Emailer/test` deployment. The last recorded test deployment was fully destroyed, but inventory must be checked again at execution time. If `test` already exists or contains someone else's work, stop the live task and identify ownership; do not destroy or overwrite it automatically. No production deployment is included. Switching an existing persistent stage to generation-named schedules requires an inventory/drain/migration decision outside this plan; do not add an unneeded dual-name compatibility path.

## Tasks

### T1 — Define cancellation contract and coherent control reads

- **Change:**
  - Add `manual` to PauseReason and the cancel-only CampaignCancellationConflict error; register it on the existing endpoint.
  - Replace getCampaignRun with getCampaignControl and update consumers/doubles; keep ownership fields internal.
  - Make queued wake repair use one coherent queued state/token and treat an intervening normal state change as concurrency, not corruption.
  - Preserve public Campaign/summary/body shapes and all existing endpoint names.
- **Starts at:** `packages/api/src/{Schemas,Api}.ts`; `apps/backend/src/Storage/Campaigns.ts:getCampaignRun`; `Campaigns.ts:wakeQueued`; dependent test service fixtures.
- **Status:** Verified
- **Evidence:** Parent inspected worktree diff and reran T1 unit files (211 passed at T1; later 121 Schemas + Campaigns/Storage as part of T2). `getCampaignRun`/`CampaignRunToken` gone. T1+T2 review F1 added queued-then-reschedule/cancel snapshot tests; split-read sensitivity: 4 failed, restored production 51 passed. Review Clear after R2.
- **Tests:** `packages/api/src/Schemas.test.ts` (unit) covers manual pause and conflict encoding; `apps/backend/src/Storage/Campaigns.test.ts` (unit) covers coherent control decoding and valid tokenless draft; `apps/backend/src/Campaigns.test.ts` (unit) protects against waking a replacement scheduled generation and false corruption after cancellation. Use controlled service effects between reads; assert emitted token/state, not helper call trivia.
- **Verify:** Run `pnpm exec vitest run --project unit packages/api/src/Schemas.test.ts apps/backend/src/Storage/Campaigns.test.ts apps/backend/src/Campaigns.test.ts`; expect all affected tests green and the previously demonstrated early-wake scenario to emit no scheduled-token wake. Run `pnpm typecheck`; expect no errors after fixture migration.

### T2 — Make lifecycle transitions generation-owned and repeat-safe

- **Change:**
  - Convert enqueue/schedule/resume/cancel META mutations to single-item transactions with exact expected source state/token.
  - Rename unscheduleCampaign to cancelCampaign, support both queued origins, retain retired tokens, and preserve all historical data.
  - Refactor command branches around their one control snapshot and the conflict policy above; remove stale separate-token lookups and ignored mutation results.
  - Preserve explicit queued send/resume wake repair and current no-op responses for other commands' ineligible states.
  - Update store comments and all fixtures to describe command transactions separately from worker updates.
- **Starts at:** `apps/backend/src/Storage/Campaigns.ts:enqueueCampaign/scheduleCampaign/resumeCampaign/unscheduleCampaign`; `apps/backend/src/Campaigns.ts:send/schedule/resume/cancel`; existing `runTransaction`.
- **Depends on:** T1
- **Status:** Verified
- **Evidence:** Parent inspected storage/command diffs and reran `pnpm exec vitest run --project unit apps/backend/src/Campaigns.test.ts apps/backend/src/Storage/Campaigns.test.ts apps/backend/src/Dispatching.test.ts apps/backend/src/Storage/Primitives.transport.test.ts` (139 passed at T2; Campaigns 51 after F1 tests) and `pnpm typecheck`. Lifecycle writes are tokenized expected-source transactions; cancel conflict policy matches ADR-0016. Review: [T1+T2 implementation review](queued-campaign-cancellation-t1-t2-review.md) Clear after R2 (F1 resolved).
- **Tests:** `Storage/Campaigns.test.ts` covers expected-source conditions, missing-token handling, correct destination fields and untouched cursor/counters; `Campaigns.test.ts` uses explicit barriers/controlled Effects for both worker/cancel orders, replacement-generation conflicts, idempotent inactive cancellation and resumed history. Include begin→claim/settle→automatic-pause before the failed cancel reread, for both fresh and resumed queued snapshots: require 409, preserved history and no cleanup. A concurrent cancel reaching the same token's expected draft/manual-paused destination must still succeed idempotently. `Dispatching.test.ts` asserts stale runs make no claims, submissions or continuations and late settlements remain possible. `Storage/Primitives.transport.test.ts` exercises a representative lifecycle transaction through the real AWS binding, checking stable request token/body across a scripted server error and the existing conflict-retry distinction. Mocked AWS responses do not establish AWS idempotency; T5 provides real-table evidence.
- **Verify:** Run `pnpm exec vitest run --project unit apps/backend/src/Campaigns.test.ts apps/backend/src/Storage/Campaigns.test.ts apps/backend/src/Dispatching.test.ts apps/backend/src/Storage/Primitives.transport.test.ts`; expect cancellation cannot resurrect work, cancel a replacement, reset resumed history or silently claim to stop sending. Run `pnpm typecheck`; expect no errors.
- **Risk/recovery:** Preserve worker and recipient semantics. Do not deploy intermediate lifecycle/Scheduler combinations; T3 must be complete first.

### T3 — Give schedules generation identity and explicit recovery ordering

- **Change:**
  - Extract the concrete Scheduler adapter and name resources by run token.
  - Remove delete-before-create behavior and change all cleanup callers to the observed generation.
  - Apply the documented primary-effect-first ordering, post-create obsolescence check, and inactive cancellation cleanup retry.
  - Preserve stage group, execution role, target payload, future-time validation and existing least-privilege bindings.
- **Starts at:** `apps/backend/src/Api.ts:CampaignSchedule layer`; planned `apps/backend/src/CampaignSchedule.ts`; `apps/backend/src/Campaigns.ts:CampaignSchedule and command effects`.
- **Depends on:** T2
- **Status:** Verified
- **Evidence:** Parent inspected adapter (`Name`/`ClientToken`=runToken, no delete-in-create, NotFound-only remove success) and command order (wake-then-remove; create-then-reread-then-own-cleanup-then-predecessor). Reran `pnpm exec vitest run --project unit apps/backend/src/CampaignSchedule.test.ts apps/backend/src/Campaigns.test.ts apps/backend/src/Api.test.ts` (115 passed) and `pnpm typecheck`. Independent T3+T4 review after T4.
- **Tests:** planned `apps/backend/src/CampaignSchedule.test.ts` (unit) invokes the real adapter factory over fake AWS callables to verify exact Name/ClientToken/target, no hidden deletion and NotFound-only cleanup success. `Campaigns.test.ts` controls delayed create/delete completions to prove old cleanup cannot remove a new schedule, late create removes its own obsolete resource, cancellation cleanup retry works after the durable write, and failed writes produce no external effects. Assert publication happens despite a later cleanup failure and provider errors remain observable.
- **Verify:** Run `pnpm exec vitest run --project unit apps/backend/src/CampaignSchedule.test.ts apps/backend/src/Campaigns.test.ts apps/backend/src/Api.test.ts`; expect all adapter, recovery and orchestration cases green. Run `pnpm typecheck`; expect no errors. Inspect the generated live plan in T6 for no new resource types or unrelated permissions.
- **Risk/recovery:** Transport/client retries and process crashes can still leave obsolete resources. Tests and docs must distinguish safe invalidation from guaranteed physical deletion.

### T4 — Verify HTTP/CLI behavior and document operator semantics

- **Change:**
  - Exercise the real router and generated client for the new 409 and manual-paused success shapes.
  - Update cancel help/examples to include scheduled work, queued first sends and queued resumes.
  - Verify the existing generic CLI error reporter exits nonzero for cancellation conflict; add special formatting only if an observed usability failure requires it.
  - Update README cancellation, concurrency and recovery guidance, including durable cancellation followed by cleanup failure and the active-submission boundary.
- **Starts at:** `apps/backend/src/Api.test.ts`; `packages/api/src/Client.test.ts`; `apps/cli/src/Commands.ts:campaignsCancel`, `Commands.test.ts`; `README.md` campaign behavior and recovery sections.
- **Depends on:** T3
- **Status:** Verified
- **Evidence:** Parent reran `pnpm exec vitest run --project unit packages/api apps/backend/src/Api.test.ts apps/cli/src/Commands.test.ts` (234 passed), `pnpm emailer campaigns cancel --help` (pending cancellation described), `pnpm lint` (0 warnings/errors). Router covers 200 draft/manual-paused, 409 replacement/sending, 404/503. CLI generic reporter exits nonzero for CampaignCancellationConflict. No extra CLI formatting.
- **Tests:** existing API/router, generated-client and spawned CLI suites protect status/error decoding, manual reason, returned campaign body, stdout/stderr and exit status. Include a replacement-generation 409, not just sending/completed. Keep tokens absent from public JSON and output.
- **Verify:** Run `pnpm exec vitest run --project unit packages/api apps/backend/src/Api.test.ts apps/cli/src/Commands.test.ts`; expect 200/404/409/503 distinctions and CLI failure behavior. Run `pnpm emailer campaigns cancel --help`; expect help to describe pending cancellation accurately. Run `pnpm lint`; expect no warnings or errors.

### T5 — Prove database races and stale-message consumption

- **Change:**
  - Add real-table lifecycle cases using the existing liveStorage beforeCommit hook for deterministic ordering; use unique campaigns and simulator-only lists.
  - Add a narrowly scoped helper that discovers and temporarily disables the test dispatch event-source mapping, waits for Disabled, and restores its original state in a finalizer. Use only in a quiet fresh test stage.
  - Add one structured info diagnostic when runSlice rejects a stale wake, carrying only campaignId and runToken, with an explicit stale disposition. These are internal correlation IDs, never credentials, recipient addresses or content. Keep stale processing successful so Lambda acknowledges it.
  - Add the live queued-cancel scenario described below and preserve sequential integration-file execution.
- **Starts at:** `apps/backend/test/IntegrationSupport.ts:liveStorage/sendRows`; planned `apps/backend/src/CampaignCancellation.integration.test.ts` discovered by the existing project; `apps/backend/src/Dispatching.ts` stale exit; `Dispatching.test.ts`. Use the logger capture pattern already present in `Feedback.test.ts` and `Diagnostics.test.ts`.
- **Depends on:** T3, T4
- **Status:** Verified
- **Evidence:** Parent inspected stale log (campaignId/runToken/disposition only), mapping acquireRelease restore, one-shot `once` helper, and eight live cases in `CampaignCancellation.integration.test.ts`. Reran unit `Dispatching.test.ts` + `Primitives.transport.test.ts` (34 passed) and `pnpm typecheck`. Live execution is T6. Independent T5-only review deferred to T6 full-plan review (parent inspected mapping/logs).
- **Tests:** real DynamoDB interleavings prove both cancel/begin orders, stale first writes after a draft→scheduled→draft cycle, and preservation of a resumed campaign's cursor/rows/counters. A bounded live transaction-replay case submits the same captured tokenized request twice around cancellation/replacement and verifies AWS does not reapply it; keep replay within ten minutes and bypass hook recursion. Unit transport tests separately prove the SDK sends that identical request. The live queue test requires a correlated stale-disposition log before asserting no recipient rows; approximate queue counts are supplementary only. `Dispatching.test.ts` checks the stale diagnostic and absence of mailer/claim effects. Keep beforeCommit interference one-shot and use a separate ordinary store inside it. Use Effect-owned bounded readiness polls; give only the affected live cases an outer Vitest timeout exceeding the mapping/log/campaign deadlines plus finalizer time, rather than changing the suite-wide timeout.
- **Verify:** Run `pnpm exec vitest run --project unit apps/backend/src/Dispatching.test.ts apps/backend/src/Storage/Primitives.transport.test.ts`; expect green. On the T6 deployment run `node --env-file="$EMAILER_ACCEPTANCE_ENV" node_modules/vitest/vitest.mjs run --project integration --reporter verbose`; expect every required case discovered and passed, with no skipped required scenarios. Capture exact case names/counts and provider evidence rather than prescribing a stale total.
- **Risk/recovery:** Live mutations are limited to owned stage resources and labelled simulator contacts. Restore mapping state and any test alarm state even on failure. Do not rely on sleep timing, disable the whole queue globally outside the owned test stage, or leave an acceptance stage running after a failed assertion.

### T6 — Full checks, ephemeral acceptance, review and cleanup

- **Change:**
  - Run the full repository gate after T1–T5 and resolve all failures/warnings with evidence.
  - Inventory, deploy, drive and monitor only a fresh owned `Emailer/test` stage using the existing private configuration/credential workflow.
  - Run the full live suite, the queued-cancel CLI walkthrough below, and resource/permission checks.
  - Destroy the ephemeral stage on success or failure; independently verify its resources are gone while retaining the shared sending identity and bootstrap buckets.
  - Record implementation decisions, test evidence, limitations and cleanup in this work document; mark ADR acceptance/confirmation only when supported by authorization and actual results.
  - Complete independent implementation review, then commit the finished change; if implementation uses a worktree, its owner handles authorized integration and removes it after preserving all work.
- **Starts at:** `package.json:check`; `README.md` deployment/recovery runbook; `alchemy.run.ts`; this plan and ADR-0016.
- **Depends on:** T5
- **Status:** Closed by the user's decision of 2026-09-23. The live suite, including `CampaignCancellation.integration.test.ts`, passed in ADR-0020's run on stage `test` (40 cases) and in the [review-fixes](review-fixes.md) live gate on `test-review` on 2026-09-24 (41 cases); both stages were destroyed. The queued-cancel CLI walkthrough below was not run separately.
- **Evidence:** `pnpm check` passed in the worktree (728 unit tests, format, lint, typecheck, imports). Alchemy plan for `--stage test` created only existing resource types (28 creates, Scheduler Create/Delete bindings unchanged). Live deploy succeeded once (28 resources, alert subscriptions 0) then integration failed because the suite ran without AWS credentials (`unset AWS_PROFILE`). A later deploy retry hit AWS `InvalidParameterValueException: Internal KMS service error` on Lambda create (Api/Dispatcher/Unsubscribe). Failure-safe destroy completed 28/28; leftover IAM roles `Emailer-Api-test-*` and `Emailer-Unsubscribe-test-*` from interrupted creates were deleted. No `emailer-test` functions, tables, queues, schedule groups, log groups, alarms, or SNS topics remain. Shared `EmailerSending/shared` identity retained. Live integration and CLI walkthrough not green; T6 cannot Confirm ADR-0016.
- **Tests:** `pnpm check` covers format, lint, typecheck, all unit tests and imports. The full integration project covers scheduling, segmentation, HTML, unsubscribe, feedback, pacing and cancellation together. Manual CLI acceptance covers the actual operator path and resource inventory; simulator acceptance does not establish inbox placement or rendering.
- **Verify:** Run the exact commands and acceptance procedure below; expect no required skips, no unexplained runtime errors, no unintended recipients or alert subscriptions, no new resource type, and no remaining owned ephemeral resources.
- **Risk/recovery:** Preserve the first failure and fix its cause; do not turn flaky retries into acceptance. If credentials are unavailable, record the blocked live task and cleanup state rather than claiming completion. Do not deploy, delete or migrate a pre-existing stage without establishing ownership and authorization.

## Test matrix and required failure signals

| Case | Narrowest credible layer | Required signal |
| --- | --- | --- |
| Fresh queued cancellation | Domain + live queue | Draft; retired token retained; consumed stale wake; no SEND rows |
| Queued resume cancellation | Domain + live storage | Manual paused; identical original startedAt/cursor/history; later resume does not resend existing rows |
| Cancel wins / begin wins | Live storage using explicit interleave | Stale begin with no claims / cancel conflict with no reset |
| Worker starts, submits, then pauses before cancel reread | Domain controlled interleave for fresh and resumed queued snapshots | 409 with preserved history and no cleanup; automatic pause is not cancellation |
| Old send/resume first write after intervening cycle | Live storage | Expected generation fails; no resurrection or new wake |
| Committed enqueue retry after cancellation | Real binding transport + live transaction replay | Identical request/token; no state reinstatement |
| Committed cancel retry after replacement | Live transaction replay | Replacement generation unchanged |
| Feedback between resume commit and replay | Live storage/replay | Cumulative counter changes, original run baseline does not |
| Queued read followed by cancellation/reschedule | Domain regression | Never enqueue the replacement scheduled token; no false corruption |
| Delayed create/delete across replacement | Adapter + controlled domain effects | New schedule intact; obsolete handler deletes only its own identity |
| Delete fails after cancellation | Domain + router | Durable inactive state, observable 503, repeat cancellation retries same identity |
| Sending/completed/replacement conflict | Router + generated client + CLI | Typed409, no mutation/cleanup, nonzero CLI exit |
| Duplicate/late stale wakes | Dispatcher + live queue | Successful discard with no claims/submissions/continuation |

Use controlled Effects/barriers and the existing beforeCommit hook. Do not build a general DynamoDB-expression interpreter or a reusable simulation framework. Demonstrate regression sensitivity using the known pre-change behavior or a safe test seam; never mutate production merely to manufacture a failing test. Request-shape assertions remain useful for protocol fields, but real DynamoDB must evaluate the important ownership conditions.

## Exact acceptance commands and live procedure

Commands below are instructions for implementation, not commands executed while creating this plan. Supply `EMAILER_ACCEPTANCE_ENV` as an absolute path to a private temporary file populated from the current deployment; do not overwrite the user's `.env.test` or print credentials/signing material. Use the existing `emailer-test` Alchemy profile and the resolved AWS credentials/profile appropriate to the account. Do not set `EMAILER_ALERT_EMAIL`; assert the alert topic has zero subscriptions. Check every recipient is a labelled SES mailbox-simulator address before every send.

```bash
pnpm check
pnpm exec alchemy plan --config alchemy.run.ts --stage test --env-file "$EMAILER_ACCEPTANCE_ENV" --profile emailer-test
pnpm exec alchemy deploy --config alchemy.run.ts --stage test --env-file "$EMAILER_ACCEPTANCE_ENV" --profile emailer-test --yes --no-input
node --env-file="$EMAILER_ACCEPTANCE_ENV" node_modules/vitest/vitest.mjs run --project integration --reporter verbose
node --env-file="$EMAILER_ACCEPTANCE_ENV" apps/cli/src/main.ts campaigns cancel --help
node --env-file="$EMAILER_ACCEPTANCE_ENV" apps/cli/src/main.ts campaigns send "$EMAILER_ACCEPTANCE_CAMPAIGN_ID"
node --env-file="$EMAILER_ACCEPTANCE_ENV" apps/cli/src/main.ts campaigns cancel "$EMAILER_ACCEPTANCE_CAMPAIGN_ID"
node --env-file="$EMAILER_ACCEPTANCE_ENV" apps/cli/src/main.ts campaigns get "$EMAILER_ACCEPTANCE_CAMPAIGN_ID"
pnpm exec alchemy destroy --config alchemy.run.ts --stage test --env-file "$EMAILER_ACCEPTANCE_ENV" --profile emailer-test --yes --no-input
```

Install failure-safe teardown before deploying and run destruction from the supervising process's finalizer, not only the success path. Resolve current URLs, table name, queue/mapping identifiers, signing configuration and alarm name from the deployment into the private test configuration as the README requires. Set EMAILER_ACCEPTANCE_CAMPAIGN_ID from the newly created owned campaign in the procedure below; run those CLI commands while its mapping is disabled, not blindly as an uninterrupted command list. Never source deployment output as shell code.

Live acceptance steps:

1. Confirm the owned test stage is fresh and quiet. Create a uniquely labelled list with two success-simulator contacts and a text/HTML campaign.
2. Disable only its dispatch event-source mapping, wait for Disabled, then send through the API/CLI. Capture the strongly consistent queued control record and token. The campaign did not exist before the gate, so no older invocation can own it.
3. Cancel through the CLI. Require exit zero and draft; require unchanged body/filter and retained old token. Repeat cancel and require idempotent success.
4. Restore the mapping, wait for Enabled, and poll logs for that campaign/token's stale-disposition event within a bounded timeout. Require no SEND rows and no startedAt in a strongly consistent read. Queue depth alone is insufficient evidence.
5. Send the same campaign again. Require a fresh token and completed progress for exactly the two intended recipients, proving the cancelled campaign remains usable.
6. Exercise a queued resume using the integration fixture that constructs prior progress through real storage operations: enqueue, begin, claim/settle a historic row, checkpoint and pause while no queue wake is published. Label this seeded persistence history, not proof of earlier SES delivery. Include a nonzero progress count and cursor; capture the raw META and SEND rows before API resume/cancel. Cancel to manual-paused and verify history; resume afterward and verify no existing recipient row is submitted again. Separately exercise the already-started 409 through the actual CLI using a fixture held in sending without a queued worker wake.
7. Verify a replacement generation's Scheduler resource survives old cleanup; verify normal schedule firing and cancellation still pass the full suite. Inspect stage IAM for unchanged group-scoped Scheduler create/delete and pass-role boundaries.
8. Inspect relevant logs, available error/throttle metrics, failure queues and alarms. Classify deliberate test errors separately; do not claim delayed CloudWatch metrics are exhaustive.
9. Destroy and independently inventory functions, table, queues, event-source mappings, IAM roles, logs, alarms, SNS resources, EventBridge rule, SES configuration set/destination and Scheduler group. Keep shared sending identity/DNS and bootstrap buckets. Remove private task files and restore account-level simulator suppression changes made by the suite.

## Final acceptance

- **Checks:** full `pnpm check`; deterministic unit/provider race evidence; full live integration project without required skips; successful manual CLI cancellation and conflict paths; documented warning disposition and verified teardown.
- **End state:** every eligible pending run can be withdrawn without resurrecting it or affecting a replacement; resumed history remains intact; stale wakes are acknowledged without recipient work; failures expose their real boundary; no new infrastructure or dependency is introduced.
- **Deferrals:** active-send interruption, client-supplied idempotency keys, automatic provisioning/orphan reconciliation and migration of an existing persistent stage. These are not silently included in cancellation's guarantees.
- **Completion rule:** implementation and live acceptance remain pending until performed. Unit test success alone cannot close this plan.

## Handoff

- **Next action:** Re-run T6 live gate when Lambda KMS in us-east-1 is healthy, with `AWS_PROFILE=example` for the integration process (Alchemy deploy still uses `--profile emailer-test`). Do not claim Complete until that gate is green.
- **Reviews:** Plan reviews remain Clear. Implementation: [T1+T2](queued-campaign-cancellation-t1-t2-review.md) Clear after R2 (F1 resolved). [T3+T4](queued-campaign-cancellation-t3-t4-review.md) Clear. [Final implementation review](queued-campaign-cancellation-implementation-review.md) Clear (no findings). T6 live rows Unverifiable, not code defects.
- **Deviations:** None.
- **Resources:** Workflow-owned worktree `~/worktrees/emailer/queued-campaign-cancellation` on branch `queued-campaign-cancellation` from `a5e66c6`. Parent owns integrate/cleanup. Main checkout remains `main` at `a5e66c6`.
- **Plan validation:** Referenced local documents/test paths exist; relative links, task IDs, required task fields, shell syntax and whitespace were checked. The repository formatter intentionally excludes `.adr/**`. No application code, dependencies or infrastructure changed during planning, and no new test/deployment result is claimed.
