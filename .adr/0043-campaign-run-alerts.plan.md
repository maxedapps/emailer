# Plan: campaign run alerts (ADR-0043)

Task 4571. [ADR-0043](0043-campaign-run-alerts.md) holds the design and its cost.

## Goal

- When the dispatcher pauses or completes a run, the stage's `Alerts` topic gets one plain-text message naming the campaign, its counters and, for a pause, the reason and how to resume.

## Non-goals

- Alerts for the operator's own pause through `campaigns cancel`, for schedules, or for progress during a run.

## Tasks

1. **Storage** (`storage/Campaigns.ts`): `pauseRun` and `completeRun` ask for `ALL_NEW` and return the campaign's ID, subject and counters as written (`EndedRun`). Unit: `storage/Campaigns.test.ts` checks what they return.
2. **Alert** (`sending/RunAlerts.ts`): `RunAlerts.paused(run, reason)` and `RunAlerts.completed(run)` build the subject and body and publishes through `AWS.SNS.Publish(alertsTopic)`; a failure or timeout is logged as a warning. Unit: `RunAlerts.test.ts` (the message for a pause and a completion, a failed and a timed-out publish).
3. **Dispatcher** (`sending/Dispatching.ts`, `Dispatcher.ts`): every run end in `runSlice` goes through one pause and one complete helper that also alert; `submitClaimed` answers the reason to pause with instead of pausing itself. Unit: `Dispatching.test.ts` checks one alert per pause and completion, none for a stale run.
4. **Docs**: README's alerts section.
5. **Hand check** on a fresh test stage: subscribe a temporary SQS queue to the stage's topic, send a campaign to simulator addresses, read the completion message; pause one through the daily ceiling and read that message; remove the queue and the stage.

## Evidence

- The two messages as the queue received them, and the key files and snippets.

## Hand check

On a fresh test stage, an SQS queue subscribed to the `Alerts` topic received, for two simulator recipients:

- a completed run: subject `emailer: campaign completed`, the campaign subject with its umlauts intact, `Accepted 2, rejected 0, uncertain 0, skipped 0.` and the `campaigns get` command;
- a run paused through `EMAILER_DAILY_SEND_CEILING=1`: subject `emailer: campaign paused (daily-quota)`, the daily budget explanation, the counters and the `campaigns resume` command.

The landing gate ran all seven live groups green (43 tests) on its own stage, which it destroyed.

## Settled findings

Codex GPT-6.1 Sol reviewed f984928: no high or medium findings.
