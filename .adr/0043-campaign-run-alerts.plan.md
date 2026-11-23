# Plan: campaign run alerts (ADR-0043)

Task 4571. [ADR-0043](0043-campaign-run-alerts.md) holds the design and its cost.

## Goal

- When the dispatcher pauses or completes a run, the stage's `Alerts` topic gets one plain-text message naming the campaign, its counters and, for a pause, the reason and how to resume.

## Non-goals

- Alerts for the operator's own pause through `campaigns cancel`, for schedules, or for progress during a run.

## Tasks

1. **Storage** (`storage/Campaigns.ts`): `pauseRun` and `completeRun` ask for `ALL_NEW` and return the campaign's summary. Unit: `storage/Campaigns.test.ts` checks the returned summary.
2. **Alert** (`sending/RunAlerts.ts`): `RunAlerts.runEnded(summary)` builds the subject and body and publishes through `AWS.SNS.Publish(alertsTopic)`; a failure or timeout is logged as a warning. Unit: `RunAlerts.test.ts` (the message for a pause and a completion, a failed publish).
3. **Dispatcher** (`sending/Dispatching.ts`, `Dispatcher.ts`): every run end in `runSlice` goes through one pause and one complete helper that also alert; `submitClaimed` answers the reason to pause with instead of pausing itself. Unit: `Dispatching.test.ts` checks one alert per pause and completion, none for a stale run.
4. **Docs**: README's alerts section.
5. **Hand check** on a fresh test stage: subscribe a temporary SQS queue to the stage's topic, send a campaign to simulator addresses, read the completion message; pause one through the daily ceiling and read that message; remove the queue and the stage.

## Evidence

- The two messages as the queue received them, and the key files and snippets.
