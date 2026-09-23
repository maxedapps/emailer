# EventBridge Scheduler

[AWS](aws.md) · [SQS](sqs.md) · [Permissions](iam-and-secrets.md) · [Alchemy bindings](../alchemy/runtime-and-bindings.md)

EventBridge Scheduler persists future invocations of AWS API targets. It supports one-time, rate-based and cron-based schedules with an execution role, target payload, optional flexible time window, retry policy and dead-letter destination. It is different from an EventBridge event bus, which routes events, and from SQS, which buffers work that is already available to consume. [Schedule types](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)

## Choose time semantics first

| Expression | Meaning | Common mistake |
| --- | --- | --- |
| `at(2027-01-15T09:00:00)` | One nominal occurrence in the selected time zone | Treating a local time as UTC without specifying the zone |
| `rate(1 day)` | A repeating elapsed-time interval | Assuming it always means the same local wall-clock hour across DST |
| `cron(0 9 * * ? *)` | Calendar schedule evaluated in the selected zone | Copying a five-field Unix cron expression unchanged |

Scheduler invokes with 60-second precision when no flexible window is selected; a scheduled minute is not an exact-second guarantee. A flexible window intentionally allows a wider dispatch period. Cron schedules use IANA time zones: a nonexistent spring-forward local time is skipped, and a repeated fall-back local time runs once. An elapsed day for a rate schedule remains a 24-hour duration. [Time zones and daylight saving](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html#daylist-savings-time)

For one-time scheduling, record the intended instant and, when relevant, the original local zone and input. For recurring local scheduling, preserve the zone because a fixed UTC offset does not represent future daylight-saving changes. The application should state how missed or late work is interpreted rather than assuming Scheduler decides its business deadline.

## Target and execution role

A templated target supplies a service resource ARN and a supported operation-specific payload. For example, an SQS target publishes the supplied input as a message; a Lambda target invokes the function. Universal targets address a supported AWS SDK operation using the required request shape. The Scheduler role needs permission for that target operation, independently of the principal that creates the schedule. [Templated targets](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-templated.html), [execution role setup](https://docs.aws.amazon.com/scheduler/latest/UserGuide/setting-up.html)

An illustrative `CreateSchedule` request for an SQS target follows. The account, Region, role and queue are placeholders, and the future timestamp must be selected for the intended operation:

```json
{
  "Name": "example-job-42",
  "ScheduleExpression": "at(2027-01-15T09:00:00)",
  "ScheduleExpressionTimezone": "UTC",
  "FlexibleTimeWindow": { "Mode": "OFF" },
  "ActionAfterCompletion": "DELETE",
  "Target": {
    "Arn": "arn:aws:sqs:eu-west-1:123456789012:jobs",
    "RoleArn": "arn:aws:iam::123456789012:role/scheduler-target",
    "Input": "{\"version\":1,\"jobId\":\"job-42\",\"revision\":3}"
  }
}
```

This configures an invocation, not the queue, role or downstream worker. The creator also needs the applicable role-passing permission. `ActionAfterCompletion` can remove a completed one-time schedule; otherwise completed schedules still consume schedule inventory. [CreateSchedule API](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html)

## Alchemy binding

`CreateSchedule(role, group?)` and `DeleteSchedule(group?)` are runtime bindings: yield them in a Function constructor and provide `CreateScheduleHttp` / `DeleteScheduleHttp`. `CreateSchedule` grants `scheduler:CreateSchedule` on `schedule/<group>/*` (or `schedule/default/*` with no group) and `iam:PassRole` on the bound role, conditioned on `iam:PassedToService: scheduler.amazonaws.com`. `DeleteSchedule` grants `scheduler:DeleteSchedule` on that same schedule pattern. The execution role is the application's `AWS.IAM.Role`; Alchemy does not mint one for the runtime binding. The binding injects `GroupName`, `FlexibleTimeWindow { Mode: "OFF" }` and `Target.RoleArn`. [CreateSchedule](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Scheduler/CreateSchedule.ts), [BindingHttp](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Scheduler/BindingHttp.ts)

Supply `ClientToken` yourself. The distilled client fills a missing token per attempt, so a retry without a supplied token is a different request and answers Conflict. [CreateSchedule API](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html), [idempotency tokens](https://unpkg.com/@distilled.cloud/aws@1.0.0-rc.12/src/client/generate-idempotency-tokens.ts)

Alchemy's `ScheduleGroup` deletes with `DeleteScheduleGroup`. AWS: "Deleting a schedule group results in EventBridge Scheduler deleting all schedules associated with the group." A runtime-minted schedule is not an Alchemy resource, so a stage-owned group is the boundary that removes those schedules on destroy. [DeleteScheduleGroup](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_DeleteScheduleGroup.html), [ScheduleGroup](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Scheduler/ScheduleGroup.ts)

AWS documents the 60-second invocation window only for a whole-minute instant: a schedule at `1:00` fires between `1:00:00` and `1:00:59`. Nothing defines the window for a mid-minute `at()`. [Schedule types](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)

## Delivery, retries and dead-letter records

One nominal scheduled occurrence is not an exactly-once external side effect. Target delivery can retry, so give the target a stable operation identity and validate whether it is already complete. Configure both maximum event age and retry count according to how late an invocation remains useful. Exhausted delivery can be sent to a **standard SQS DLQ**; Scheduler does not accept a FIFO queue as its DLQ. The role must also be able to write to that queue. [Scheduler DLQ behavior](https://docs.aws.amazon.com/scheduler/latest/UserGuide/configuring-schedule-dlq.html)

The Scheduler DLQ protects target invocation. If the target accepts an asynchronous request and its later worker fails, that failure belongs to the target's own retry or redrive mechanism. A successful Scheduler invocation therefore does not prove downstream completion. Monitor both boundaries, and preserve the original operation/revision when replaying a dead-letter event.

## Reconcile schedules with application state

A database update and a Scheduler API request are not one atomic transaction. Persist a desired schedule intent and reconcile it, or retain another recoverable record of incomplete provisioning. Stable schedule names and explicit revisions help identify whether a retry repeats the same intended schedule or replaces it.

Cancellation has a race with already dispatched invocations. Deleting or disabling a schedule prevents future scheduling according to service behavior; it cannot recall work already accepted by the target. The consumer must check authoritative cancellation and revision state before a non-repeatable operation. Likewise, a rescheduled job should reject a late invocation from an older revision.

## Troubleshooting and documentation

For no invocation, inspect schedule state, expression, time zone, flexible window and target Region. For failed invocation, inspect execution-role trust and permissions, target existence, error code and DLQ permissions. For apparently duplicated work, distinguish target delivery retry from worker retry and consumer replay.

Use the [Scheduler `llms.txt`](https://docs.aws.amazon.com/scheduler/latest/UserGuide/llms.txt) to locate service guides, then consult the exact API request reference. Its time and retry model must not be inferred from a local cron library or an in-process Effect Schedule.
