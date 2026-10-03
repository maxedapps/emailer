# ADR-0030: Mailbox feedback is event-keyed, and replays stay conservative

- Status: Accepted
- Date: 2026-10-03
- Accepted: 2026-10-03, after the plan review
- Authority: The code review of `main` at `dea4c24` (task 241, 2026-10-03) found that untagged transient bounces are never recorded (F4) and that replayed feedback re-suppresses an address after a manual unsuppress (F6). The user decided F6 on 2026-10-03: keep the conservative replay, keep suppression independent of campaign writes, and record the rule "redrive before you clear a suppression". Plan: [0030 plan](0030-event-keyed-mailbox-feedback-and-conservative-replay.plan.md).
- Amends: [ADR-0012](0012-reputation-guardrails.md) for the transient window's entry format and its write path.

## Context

A feedback event changes two things that are written separately:

- **The mailbox:** a suppression, or an entry in the transient-bounce window. These hold for every mail this service sends.
- **The campaign:** a history row and a counter, written only for tagged campaign mail.

Two flaws came from where these writes sit:

- **F4.** The transient-window entry was written inside the campaign-history transaction, after an early return for untagged mail. Soft bounces from `[Test]` copies and sign-up confirmations were never recorded, so an address that kept soft-bouncing on those paths was never `bouncing`. The entry was `<receivedAt>#<feedbackId>`. Because the receive time differs on every delivery, only the history row's condition kept a redelivery from adding the entry a second time.
- **F6.** Suppression is written first, conditioned only on no suppression being there (`if_not_exists`). It deliberately comes before any campaign write, so that it covers untagged mail and unknown or deleted campaigns, and survives an outage of history and counters. A redriven or late-retried event that arrives after `addresses unsuppress` therefore suppresses the address again. This fails safe, but it can surprise an operator.

## Decision

- **The transient-window entry is keyed by the event: `<bounce.timestamp>#<feedbackId>`.**
  - `bounce.timestamp` is when the receiving server sent the bounce (SES event publishing). It is decoded as a date-time and stored in canonical ISO form.
  - Adding to a string set is idempotent, so a redelivered event leaves the window unchanged.
- **The mailbox write is its own update, made before the optional campaign attribution.**
  - Every transient bounce from this service's configuration set adds its entry, tagged or not.
  - The campaign transaction keeps only the history row and, for counted kinds, the counter.
- **Replay stays conservative.**
  - Replayed or late feedback is applied as it arrives. It may suppress an address, or add a window entry, after an operator cleared them.
  - There is no receipt store and no "cleared at" cutoff.
- **The operator rule: redrive before you clear a suppression.** Before `addresses unsuppress`:
  - redrive `FeedbackFailures` until it is empty, and
  - let `FeedbackEvents` drain (`ApproximateNumberOfMessages` and `ApproximateNumberOfMessagesNotVisible` both 0).

  This drains the feedback already known to be pending. It is no guarantee: SQS counts are eventually consistent, EventBridge retries a failed delivery for up to 24 hours, and a standard queue can deliver a message again. The README's Operate section and the CLI's `addresses unsuppress` help say so.

## Alternatives

1. **Keep the entry inside the campaign transaction, and give untagged mail a synthetic campaign or receipt row.** This is the simplest change to the code path, but it invents a fake campaign ID or a new item kind only so that a condition dedupes what an idempotent set add already dedupes.
2. **Event-aware dedupe for suppression.** Store a receipt per applied event, or a "cleared at" timestamp compared with the event time, so that old feedback cannot undo a clear but a new bounce still suppresses. The user rejected this for now:
   - neither design is a clear winner on cost or safety;
   - a wrong cutoff would let a genuinely new hard bounce through.
3. **Move suppression behind the campaign transaction.** Rejected: suppression would then depend on a known campaign and on the history and counter writes succeeding.

## Consequences

- **Every soft bounce counts toward `bouncing`.** This includes soft bounces from test copies and confirmation mail: three in thirty days skips the address on every path.
- **The window follows bounce time.** It used to follow processing time. The history row's `receivedAt` is still the processing time.
- **Entries written before this change keep their old form.** They still parse, and age out within thirty days. A redrive of such an event after the change adds a second, event-keyed entry once.
- **A clear can be undone by old feedback.** The redrive rule removes the known backlog. Late feedback can still arrive after it, and when it does it fails safe: the address is suppressed or `bouncing` again, and the operator clears it again.

## Confirmation

- `Feedback.test.ts`:
  - a tagged and an untagged transient bounce each add the event-keyed entry;
  - a redelivered event adds nothing new;
  - an untagged bounce adds no campaign counter.
- `Feedback.test.ts` (storage):
  - the transient entry is a plain idempotent `ADD`;
  - the campaign transaction no longer carries it.
- Live suite on an ephemeral stage: simulator bounces still decode and suppress through the deployed feedback function.
- Manual, on an ephemeral stage: the simulator has no soft bounce, so one realistic untagged `Transient` envelope is put on `FeedbackEvents` twice. `addresses status` then shows exactly one `<bounce timestamp>#<feedbackId>` entry, and nothing is attributed to a campaign.
