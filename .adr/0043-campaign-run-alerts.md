# ADR-0043: The dispatcher alerts when a campaign run pauses or completes

- Status: Proposed
- Date: 2026-11-23
- Authority: The operator chose pause and completion alerts on 2026-11-23 (task 4571), before a send of about 25,000 recipients.
- Plan: [0043-campaign-run-alerts.plan.md](0043-campaign-run-alerts.plan.md)

## Context

- **A run's end is silent.** The dispatcher pauses a run on a guard refusal (reputation, a paused account, the daily budget), on its own bounce or complaint breaker, and on a throttle or suspension SES keeps answering; it completes a run after the last page. Each only writes the campaign's state. The operator learns of it by polling `campaigns get`.
- **A large send makes that costly.** About 25,000 recipients take some two hours at the measured 3.2 to 3.6 sends per second. A pause in the first minutes leaves the rest unsent until someone looks.
- **An alert path already exists.** Every stage has the `Alerts` SNS topic (`sending/Reputation.ts`); the stack subscribes `EMAILER_ALERT_EMAIL` to it when set, and the CloudWatch alarms notify it.

## Decision

- **The dispatcher publishes one message to the `Alerts` topic** each time a run it drives pauses or completes. `RunAlerts` (`sending/RunAlerts.ts`) binds `AWS.SNS.Publish` to the topic, which grants the dispatcher `sns:Publish` on it alone.
- **The run's own write says what to report.** `pauseRun` and `completeRun` return the campaign's ID, subject and counters as they wrote them (`ReturnValues: ALL_NEW`, free), so the alert needs no further read; the dispatcher adds the pause reason it wrote.
- **The alert is plain text.** The SNS subject is ASCII and names only the event and reason (`emailer: campaign paused (daily-quota)`); the campaign's subject, which may hold any character, goes into the body with the counters, what the reason means and, for a pause, the `campaigns resume` command.
- **A failed publish does not fail the slice.** The run's state is written by then, and a redelivered wake-up would only find the run superseded, so it is logged as a warning and the slice ends normally.
- **Operators' own actions send nothing.** A pause through `campaigns cancel` happens in the API, which the operator is watching.

## Alternatives considered

1. **Keep polling** (no change). Costs nothing, and leaves a pause unseen for as long as nobody looks.
2. **DynamoDB Streams to a Lambda function** that alerts on state changes. It would see every write to the table, so it costs a Lambda invocation per batch of send rows, tens of thousands per large send, to catch a handful of transitions.
3. **CloudWatch alarms on log metric filters.** Each alarm costs 0.10 USD a month, a filter adds log ingestion, and an alarm's mail cannot name the campaign or its counters.
4. **EventBridge events from the dispatcher, routed to the topic.** One more resource and rule for the same single message; worth it only when something else consumes run events.

## Consequences

- **The operator sees a pause within the slice that caused it,** and knows when a large send has finished, from the mail the stage already sends alarms to. A stage without `EMAILER_ALERT_EMAIL` publishes to a topic nobody subscribes to.
- **A publish lost to an SNS outage is only logged;** `campaigns get` stays the record.
- **Cost: one SNS publish and, where subscribed, one email per run end.** SNS charges 0.50 USD per million publishes and 2 USD per 100,000 email deliveries after the first 1,000 a month, so a campaign's alerts cost nothing measurable. `ReturnValues` costs no read units; no DynamoDB write, GSI write or storage, Lambda invocation, SQS request or log line is added at steady state; a failed publish logs one warning.
