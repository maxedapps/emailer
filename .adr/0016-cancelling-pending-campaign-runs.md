# ADR-0016: Cancellation withdraws a specific pending campaign run

- Status: Accepted
- Date: 2026-09-17
- Accepted: 2026-09-17
- Authority: The user requested queued-campaign cancellation, explicitly allowed substantial refactoring, requested a detailed implementation plan, and on 2026-09-17 authorized implementation with `/implement-plan .adr/work/queued-campaign-cancellation.md`. Live confirmation remains the plan's T6 gate.
- Supersedes in part: [ADR-0015](0015-one-shot-scheduler-per-campaign.md), for cancellation transitions, removing run tokens, campaign-named schedules and delete-before-create replacement; [ADR-0013](0013-repeat-safe-writes.md), for the single-item update mechanism used by campaign lifecycle commands.
- Superseded in part: [ADR-0020](0020-drafts-previews-and-test-sends.md), for the cancel-only conflict: every wrong-state operation now answers one `CampaignStateConflict`.
- Preserves: [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md), for recipient identity, worker guards and late settlements; [ADR-0014](0014-campaign-body-item-and-summaries.md), for the META/BODY split.

## Context

Cancellation currently acts only on scheduled campaigns and silently returns other states unchanged. Queued work can be either a first send or a resume with existing recipient records and progress. Adding queued-to-draft alone permits old write retries to resurrect cancelled work, can conceal resumed progress, and exposes a split-read helper that can enqueue a replacement scheduled token early. Shared Scheduler names also let an old cleanup request delete a newer schedule.

## Decision

- Keep the existing cancel endpoint and CLI command. Withdraw scheduled and never-started queued runs to draft; withdraw queued resumes to paused with reason `manual`, preserving history and cursor. Draft and paused are idempotent successes. Sending, completed, and a conflicting replacement generation return a typed cancellation conflict.
- Cancellation competes with `beginRun` through a conditional mutation of the same META. A successful cancellation before the first start prevents that run's submissions. Cancelling a queued resume cannot recall recipients an older invocation already claimed.
- Read state, run token, original start time and pause reason in one internal control snapshot. Every lifecycle transition checks its observed state and token. Never retarget a failed command to a replacement generation. The queued wake repair uses exactly the token observed with queued state.
- After a lost cancellation condition, recognize another successful cancellation only by the same token in the expected draft or manual-paused destination. A worker-induced pause after beginRun won is a conflict, even though it retains the token. An initially paused campaign remains an idempotent already-inactive success.
- Keep the retired token on draft/paused records; state gates prevent dispatch. Every new send, schedule or resume replaces it with a fresh token. Retention prevents an old draft/paused observation from matching after an intervening lifecycle cycle and identifies cancellation cleanup retries.
- Use the existing tokenized `runTransaction` primitive for each lifecycle command's single conditional META update. Expected-source conditions protect delayed first attempts; transaction idempotency protects already-committed writes and run baselines from transport replay. Keep worker `beginRun` and recipient processing mechanisms unchanged.
- Name each Scheduler resource by its run token inside the existing stage group. Create never deletes a shared name. Delete only the observed retired generation. Perform the primary publish/create after the database commit, then generation-specific cleanup; after successful creation recheck whether that generation remains scheduled and delete it if obsolete.
- Keep the current public Campaign response. A successful command's response is a later observation; another explicit command can legitimately have changed the campaign by then. Do not fabricate a transition-time snapshot from stale counters.

## Alternatives considered

1. **Admit queued in the existing cancellation condition.** Does not protect resumed history, stale commands, transport retries or Scheduler ownership.
2. **Conditional UpdateItem alone with an own-result replay branch.** Retained tokens can prevent resurrection, but repeating expressions that copy mutable feedback counters can change run baselines. Source-only updates plus recovery reads can work, at the cost of another outcome-reconstruction protocol. The existing transaction primitive is smaller to reuse.
3. **Transaction idempotency without expected generation.** Does not protect a delayed first attempt after the campaign has changed and returned to an eligible state.
4. **Separate run entities, a state-machine framework, FIFO queues or queue scanning.** Adds infrastructure or changes recipient identity without removing the required state/token checks.
5. **Durable schedule reconciliation/outbox.** Would close crash-time provisioning and cleanup gaps, but introduces a new persistence and recovery subsystem. The user-facing cancellation guarantee is enforced in DynamoDB; automatic reconciliation remains a separate reliability feature.

## Consequences

Lifecycle writes incur transactional write cost, on the small META item and at command frequency. No new table, index, queue, Lambda, dependency or public run identifier is required. The manual pause reason and cancel-only 409 are deliberate public contract changes.

DynamoDB, SQS and Scheduler are not atomic together. A failed publish/create is reported as unavailable and repaired by the existing explicit send/resume/schedule commands. Cancellation can be committed even if resource deletion subsequently fails. Retaining its token lets repeated cancel repair that deletion while the generation remains current. It does not retain every earlier schedule: a crash can leave an obsolete resource until its future invocation and automatic deletion, or stage teardown. Late creation after cancellation remains harmless because the worker checks current intent. No promise of prompt cleanup after every crash is made.

Deployment is planned against a fresh ephemeral stage. Existing records remain readable, but switching an existing stage from campaign-named schedules requires a separate inventory/drain procedure; do not introduce silent dual naming or destroy an existing stage as an implementation shortcut.

## Confirmation

The [implementation plan](work/queued-campaign-cancellation.md) requires deterministic command/worker interleavings, transport replay checks, real DynamoDB condition tests, generation-specific Scheduler adapter tests, API/CLI conflict tests, and an ephemeral live queue-cancellation acceptance run with observed stale-message consumption and zero recipient rows.

## References

- [DynamoDB TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html): conditional single-item transactions and ten-minute request-token idempotency.
- [Scheduler CreateSchedule](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html), [DeleteSchedule](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_DeleteSchedule.html): generation-specific names fit the 64-character limit; delete offers no expected resource revision.
- [SQS DeleteMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_DeleteMessage.html): receipt-handle deletion does not replace consumer idempotency.
