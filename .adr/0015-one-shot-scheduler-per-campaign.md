# ADR-0015: One EventBridge Scheduler one-shot schedule per campaign

- Status: Accepted
- Date: 2026-09-17
- Accepted: 2026-09-17
- Confirmed: 2026-09-17. Live gate on ephemeral stage `test-sched` passed (26 integration cases including fire and cancel); the stage was destroyed.
- Authority: The user decided on 2026-09-17 that scheduling gets a dedicated `POST /campaigns/:id/schedule` with a `sendAt` instant plus a cancel, that `send` stays "now", that the run token is minted when scheduling, and that a schedule group per stage is mandatory. Accepted by the user on 2026-09-17 after independent review and re-review of [the plan](work/campaign-scheduling.md); the plan's live gate confirms the implementation.
- Extends: [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md) (the dispatcher and its wake-up are unchanged; a fire is a wake-up), [ADR-0013](0013-repeat-safe-writes.md) (the three new or changed transitions follow its repeat-safe forms), [ADR-0014](0014-campaign-body-item-and-summaries.md) (the schedule intent lives on `META`).
- Superseded in part: [ADR-0016](0016-cancelling-pending-campaign-runs.md), for schedule naming and cancellation: a schedule is named by its run token, cancel keeps the token, and a replacement deletes only its own generation's schedule.

## Context

A campaign can only be sent now: `POST /campaigns/:id/send` writes `queued` under a fresh run token and sends one wake-up to the dispatch queue. Operators want to queue a draft for a future instant. The dispatcher, the wake-up message and every run-level condition already exist and are proven; what is missing is a clock that sends the same wake-up later, a state that records the intent, and a way to withdraw it.

The clock has to survive Lambda invocations and must not fire on a torn-down stage. Scheduler delivery is at-least-once, a database write and a Scheduler request are not one transaction, and a deleted schedule cannot recall a message already in the queue ([EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html)).

## Decision

- **One one-shot EventBridge Scheduler schedule per scheduled campaign**, named after the campaign id, created at runtime by the API function through Alchemy's `AWS.Scheduler.CreateSchedule` binding: `at(<sendAt to the second>)` in `UTC`, no flexible window, `ActionAfterCompletion: DELETE`, `ClientToken` = the run token, target = the existing dispatch queue, input = the existing `DispatchMessage { campaignId, runToken }`.
- **The intent lives on `META`.** `scheduled` is a campaign state beside `draft`, `queued`, `sending`, `paused`, `completed`; the instant is stored in the existing `queuedAt` (the wake-up is due then), beside the run token and the run baselines, and is shown as `sendAt`. The listing shows it as any other state.
- **The fire is the same transition a `send` takes.** `beginRun` admits `scheduled` beside `queued` and `sending` under the same token check; its update is unchanged. A fire whose token the item no longer holds is `stale` and dropped; that is what makes cancel, send-now and duplicate fires safe.
- **Table first, Scheduler second, in every operation.** Schedule: write `scheduled` under `#state IN (:draft, :scheduled)`, then delete any schedule of that name and create the new one. Cancel: write `draft` and remove the token and `queuedAt` under `#state IN (:scheduled, :draft)`, which also holds once the write has applied, then delete the schedule. Send now: the existing enqueue write under a fresh token (its condition admits `scheduled`), then delete the schedule, then send the wake-up. A crash between the two halves leaves either a `scheduled` campaign with no schedule (the operator repeats `schedule` or uses `send`) or a schedule whose fire is stale and which then deletes itself.
- **A stage-owned schedule group and execution role.** Every schedule is created in the stack's `ScheduleGroup`; destroying the stage deletes the group, and AWS deletes the group's schedules with it. The execution role trusts `scheduler.amazonaws.com` and may only send to the dispatch queue; the API function's role gains `scheduler:CreateSchedule`/`DeleteSchedule` on that group and `iam:PassRole` on that role through the bindings.
- **`sendAt` must be after now**, a contract rule (`send` is the verb for "now") checked in the domain against the clock and answered with a typed 409, independent of what Scheduler does with a past `at()`. Calendar validity is checked first by the shared `Timestamp` schema and malformed input returns 400; see the [validation decision](work/campaign-scheduling-input-validation.md). Scheduler fires with 60-second precision and documents the window only for whole-minute instants; queue and dispatcher processing can add delay.
- **No Scheduler retry policy or dead-letter queue.** A fire Scheduler could not deliver leaves the campaign `scheduled`; the recovery is `campaigns send`. An elapsed wall-clock minute alone does not prove delivery failure.

## Alternatives considered

1. **A poller Lambda on a rate schedule scanning for due campaigns.** Needs a due-time index or a scan, a second consumer of campaign state, and fires late by up to the polling interval. Rejected: Scheduler already persists the instant per campaign.
2. **SQS `DelaySeconds` on the wake-up.** Fifteen-minute cap. Rejected.
3. **An EventBridge bus rule per campaign or one cron rule.** Rules are for recurring or event-driven work, need a group-like cleanup story of their own, and one-shot semantics would have to be emulated. Rejected.
4. **DynamoDB TTL on an intent item with a stream consumer.** TTL deletion is best-effort within days of expiry. Rejected.
5. **Step Functions `Wait` state.** A new surface for one timer. Rejected.
6. **A `cancelled` terminal state.** A cancelled schedule leaves a campaign that can be scheduled again or sent; `draft` already says that. Rejected.

## Consequences

- **At-least-once and late fires cost nothing new.** They are duplicate or stale wake-ups, which ADR-0011's conditions already absorb.
- **Scheduler's 60-second precision** is not an end-to-end campaign start guarantee. What Scheduler does with an instant only seconds ahead or already past is not documented; the Confirmation records what the probe observed.
- **A one-time schedule counts against the account quota until it runs**; `ActionAfterCompletion: DELETE` removes it after the fire. Cancel and send-now delete it explicitly; a lost delete leaves a self-deleting schedule.
- **Two conditions change and no expression does**: `beginRun` and `enqueueCampaign` admit `scheduled`; `resumeCampaign` does not. `META` gains no attribute.
- **A schedule created by a runtime call belongs to no Alchemy resource.** The group is the only thing that ties it to the stage; declaring one is not optional.
- **A fresh execution role takes up to about a minute to become assumable.** The role is deployed before the API function that binds it, and the first `schedule` call of a live run comes minutes later; if it ever answers 503 right after a first deploy, wait and repeat.
- **Teardown inventory** gains the schedule group and the execution role.
- **Reschedule replaces.** A second `schedule` on a scheduled campaign overwrites `sendAt` under a fresh token and replaces the schedule; nothing records the earlier time.

## Confirmation

Confirmed on 2026-09-17 against ephemeral stage `test-sched`, then destroyed. Integration: 26/26 green, including the fire and cancel cases. The API role's inline policy granted `scheduler:CreateSchedule`/`scheduler:DeleteSchedule` on `schedule/Emailer-Schedules-test-sched-*/*` and `iam:PassRole` on the execution role conditioned on `scheduler.amazonaws.com`. After destroy, no `emailer-test-sched-*` functions, no `test-sched` table/queues/alarms, no schedule group for the stage, and no `*-test-sched-*` IAM roles.

Observed offsets (`startedAt - sendAt`):

- Whole-minute live case: `sendAt` `2026-09-17T11:23:00.000Z`, `startedAt` `2026-09-17T11:23:37.100Z`, **+37100 ms**. Two rows accepted. `startedAt` was not before the minute.
- Manual whole-minute walkthrough (~3 minutes ahead): `sendAt` `2026-09-17T11:31:00.000Z`, `startedAt` `2026-09-17T11:31:30.093Z`, **+30093 ms**. `list-schedules` showed one schedule named after the campaign targeting the dispatch queue; after completion the schedule was gone (`ActionAfterCompletion: DELETE`).
- Mid-minute probe (~20 seconds ahead): `sendAt` `2026-09-17T11:32:44.000Z`, `startedAt` `2026-09-17T11:33:33.071Z`, **+49071 ms**. The fire landed in the following minute, still within Scheduler's 60-second precision of the instant.
- Past `at()`: a direct `CreateSchedule` with `at(2020-01-01T00:00:00)` in the stage group was **accepted**. The schedule remained `ENABLED` and had not invoked within about 30 seconds; it was then deleted. The domain's 409 for a past `sendAt` is therefore independent of Scheduler.

A cancelled campaign returned to `draft`, its schedule disappeared from the group, and a later `send` completed with accepted rows.

## References

- [Plan](work/campaign-scheduling.md)
- [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md), [ADR-0013](0013-repeat-safe-writes.md), [ADR-0014](0014-campaign-body-item-and-summaries.md)
- [EventBridge Scheduler: schedule types](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html) (60-second precision, `at()` syntax)
- [EventBridge Scheduler: CreateSchedule](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html) (`ClientToken`, `ActionAfterCompletion`)
- [EventBridge Scheduler: DeleteScheduleGroup](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_DeleteScheduleGroup.html) (deletes the group's schedules)
- Alchemy 2.0.0-beta.77 `src/AWS/Scheduler/{CreateSchedule,DeleteSchedule,BindingHttp,ScheduleGroup}.ts`
