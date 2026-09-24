# SES feedback: EventBridge and SNS

[AWS](aws.md) · [Engagement event measurement](ses-engagement-tracking.md)

## Choosing a destination

SES configuration-set event destinations support CloudWatch, Amazon Data Firehose, EventBridge, Amazon Pinpoint and SNS. An SNS destination must be a **standard topic**; an EventBridge destination uses the account's **default bus**. Choose according to the consumer and the destination's supported event types. [SES event destinations](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination.html).

For a **single in-account consumer**, EventBridge is the shorter and cheaper path. AWS-service events cost nothing to ingest and nothing to deliver to targets in the same account, while SNS charges per message and an SNS→SQS→Lambda path charges again per SQS request. It is also one permission boundary — the rule grants EventBridge permission to invoke the target — instead of the three below.

SNS earns its keep on **fan-out** to several independent subscribers with per-subscription retry and dead-letter queues, and on an SQS hop that provides a durable buffer with independent consumer redrive.

## Delivery is best effort, not at-least-once

The EventBridge reference gives SES's delivery type as "Best effort": the service attempts to send all events to EventBridge, "but in some rare cases an event might not be delivered", as opposed to durable delivery, which is at-least-once. SES also states events may be delivered out of order and makes no ordering or batching guarantees.

**A consumer-side dead-letter queue cannot recover an event SES never published.** Distinguish publication, target delivery and accepted-event execution:

| Boundary | Retry and recovery |
| --- | --- |
| SES → EventBridge | Best-effort publication; a downstream DLQ cannot capture a missing publication |
| EventBridge → Lambda acceptance | EventBridge target retries, by default up to 24 hours and 185 retries; a target `DeadLetterConfig` can retain failed deliveries |
| Lambda acceptance → handler completion | Lambda asynchronous invocation policy; function errors normally receive two retries, after roughly one and two minutes. Configure Lambda's own failure destination or DLQ for exhausted execution |

Throttling and Lambda service errors follow a different asynchronous retry schedule, by default for up to six hours. An EventBridge target DLQ does not capture handler failures after Lambda has accepted the event. Monitor each boundary and destination delivery failures. [EventBridge delivery retries](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html), [Lambda asynchronous retries](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html), [Lambda failure destinations](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html).

SES-side suppression can limit the effect of a missing publication: a later send to an already suppressed address is accepted without delivery and can produce a suppression-list echo (`OnAccountSuppressionList` in the bounce subtype or complaint subtype). Recording that echo can repair local suppression state. Its publication is also best effort, so recovery on the very next send is not guaranteed. [SES suppression behavior](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html).

## SES event publishing and delivery paths

An SES configuration set event destination publishes to a **standard SNS topic**. Subscribers can include SQS queues or Lambda functions; an SQS hop adds a durable buffer with independent consumer redrive. SES does not support a FIFO SNS topic for this event destination. Select delivery, bounce, complaint, reject, rendering failure, delivery delay and subscription events as appropriate; open/click tracking additionally introduces privacy and signal-quality considerations. [SES SNS destination](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html)

Configuration-set event publishing and identity-level bounce/complaint/delivery notifications are separate mechanisms with different payload conventions. Avoid unintentionally processing both as independent real-world events. Binding or passing the configuration set on **every** send is necessary for consistent publishing; creating the destination alone does not attach it to arbitrary requests.

## Three permission boundaries (SNS path)

| Hop | Required control |
| --- | --- |
| SES → SNS | Topic policy allows `ses.amazonaws.com` to publish, scoped by account and source configuration set where supported |
| SNS → SQS | Queue resource policy allows `sns.amazonaws.com` to send from the intended topic ARN |
| Lambda → SQS | Execution role can receive/delete/read attributes; custom KMS encryption can add key-policy requirements |

A subscription declaration alone does not replace the queue policy. Scope the `aws:SourceArn` condition to the intended topic and constrain principals; don't solve delivery errors by opening the queue to every publisher. Customer-managed KMS keys require compatible service permissions in addition to the queue/topic policies. [SNS-to-SQS setup](https://docs.aws.amazon.com/sns/latest/dg/subscribe-sqs-queue-to-sns-topic.html), [SES topic policy](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html), [Alchemy SNS wiring](https://alchemy.run/aws/messaging/sns/)

Keep SES feedback infrastructure in the chosen sending Region unless a cross-Region design has been verified. Identity-level notification topics must be in the SES Region. [Identity notification setup](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html)

## Decode the right envelope

Default SNS → SQS delivery puts an SNS JSON envelope inside the SQS `body`; the envelope's `Message` is another JSON string containing the SES event. With raw message delivery, `body` contains the SES JSON directly and SNS metadata is stripped. Choose one mode and test its fixture; do not guess based on whichever fields happen to exist.

Preserving the envelope retains topic and SNS message IDs for correlation and deduplication. Raw delivery simplifies payload decoding but removes that envelope metadata. Raw SQS delivery has a ten-message-attribute limitation; excessive attributes can cause delivery failure. [Raw message delivery](https://docs.aws.amazon.com/sns/latest/dg/sns-large-payload-raw-message-delivery.html)

Treat all payloads as unknown until decoded. Check the expected topic/source and schema; tolerate extra fields while validating fields that affect suppression. A generic `as SesEvent` bypasses this boundary.

## IDs and deduplication

Keep these identifiers separate:

- SQS message ID: used for batch acknowledgement.
- SNS message ID: identifies the notification envelope.
- EventBridge envelope `id`: identifies one delivery attempt; it dedupes **target-invocation retries only**, not the underlying feedback.
- `bounce.feedbackId` / `complaint.feedbackId`: the documented unique identifier of the feedback itself. **This is the deduplication key.**
- `mail.messageId`: SES acceptance identifier. One message legitimately produces several events, so it is insufficient on its own.
- Application correlation ID: optionally assigned before the SES request and included as a non-PII email tag.

One event can also list several recipients under a single `feedbackId`, so a per-event record key silently discards all but the first. Key the record on `feedbackId` **plus** the recipient.

Use stable event identity plus recipient context when recording feedback; one message can produce multiple event kinds and multiple events of one kind. Do not deduplicate everything by SES message ID alone. A provider-generated duplicate and an application replay may have different queue IDs.

Email tags are useful for correlation when the worker never received the SES response. They are not SES idempotency tokens. Validate the mapping between correlation tags, recipients and authorized application records before updating state. [SES event fields](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)

## Reduce events without regressing state

| Event | Interpretation |
| --- | --- |
| Send | SES accepted work; not delivery |
| Delivery | Recipient mail server accepted; not inbox placement |
| Bounce | Classify on `bounceType`: `Permanent` (subtypes `General`, `NoEmail`, `Suppressed`, `OnAccountSuppressionList`, `OnTenantSuppressionList`, `EmailValidationSuppressed`) suppresses; `Transient` (including `MailboxFull`) and `Undetermined` do not. `Suppressed` (SES's global list) and `OnAccountSuppressionList` are **echoes** of an address SES already suppressed — record them, or every later send repeats the wasted call. `OnTenantSuppressionList` and `EmailValidationSuppressed` need SES tenants or auto-validation, which this project does not use; a failed validation would count as a bounce, since it says the list is bad. Apply the classification to `bouncedRecipients`, never to `mail.destination`. |
| Complaint | Recipient/provider complaint; suppress unless `complaintFeedbackType` is `not-spam` (the reporter says it is not spam) or `auth-failure` (a DMARC/DKIM report about your own sending, not a recipient complaint). The field is **optional** and absent should still suppress — the `complaintSubType: "OnAccountSuppressionList"` echo carries no feedback report. Complaints only arrive from providers that run a feedback loop, so they are a floor, never a complete picture; Gmail supplies none. Apply to `complainedRecipients`. |
| Reject / Rendering Failure | Accepted request may still fail before outbound delivery |
| DeliveryDelay | Delivery is delayed. Detail-type `Email Delivery Delayed`, `eventType: "DeliveryDelay"`, payload `deliveryDelay: { delayType, delayedRecipients[{ emailAddress, status, diagnosticCode }], expirationTime, reportingMTA, timestamp }`. `SpamDetected` and `IPFailure` are reputation signals; `MailboxFull` is not. Log the type; do not store or independently resend. |
| Subscription | Update managed preferences, preserving event identity/version |
| Open / Click | Engagement signal susceptible to scanners/proxies; not authoritative human action |

Campaign counters move only for events that reached a mailbox: `bounced` for a permanent bounce that is not an echo, `complained` for a complaint that suppresses and is not an echo. Echoes, ignored complaints (`not-spam`, `auth-failure`) and transient/undetermined bounces write a history row without incrementing those counters. Delivery delays write nothing.

SES API v2 has no set-specific pause exception. A paused configuration set and a paused account both surface as `SendingPausedException` on `SendEmail`.

Events can arrive before the sender saves its response, repeat, or arrive out of order. Persist them, support later correlation, and update state with conditional/idempotent transitions. Delivery after a complaint must not remove suppression. Keep delivery history and suppression as separate dimensions rather than one last-event-wins status. [SES event structure](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)

## Failure recovery

For an SNS → SQS path, the SNS subscription DLQ captures failure to deliver into SQS; the SQS queue's redrive DLQ captures repeated consumer failure. Configure and monitor each boundary separately. Useful signals include subscription delivery failures, queue age, unresolved events and suppression-write failures. A feedback outage can leave suppression stale even while sends continue, so sending-rate controls should account for that lag. [SNS DLQs](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html)

## Topics, subscriptions and filtering

A topic is a publication endpoint; each subscription defines a delivery relationship to one endpoint. SNS fan-out allows independent consumers to receive the same publication. Delivery and retry belong to each subscription, so success for one endpoint does not prove delivery to another. A durable SQS subscriber adds storage and consumer redrive beyond SNS's own delivery handling.

A subscription filter can evaluate message attributes or a JSON message body, depending on `FilterPolicyScope`. Missing or mismatching fields can intentionally prevent delivery. A filtered-out event is not a consumer failure and should not be expected in its DLQ. Verify representative accepted and rejected fixtures, including the exact capitalization and nesting of event fields, before using a filter to control downstream load. [SNS filtering](https://docs.aws.amazon.com/sns/latest/dg/sns-message-filtering.html)

## Decode configuration-set events explicitly

A simplified decoded SES configuration-set event looks like this; additional service fields are omitted:

```json
{
  "eventType": "Delivery",
  "mail": {
    "messageId": "ses-message-1",
    "destination": ["person@example.com"],
    "tags": { "operationId": ["operation-42"] }
  },
  "delivery": {
    "timestamp": "2026-09-11T10:00:00.000Z",
    "recipients": ["person@example.com"]
  }
}
```

For default SNS-to-SQS delivery, parse `record.body` to obtain the SNS envelope, check its expected topic context, then parse its `Message` string to obtain this event. With raw delivery, parse `record.body` directly as the SES event. **On the EventBridge path there is no string to parse:** the event above arrives already parsed as `detail`, one level below the envelope, with no SNS `Message` wrapper — decode `event.detail`, and use the envelope's `id`/`detail-type` only for logging and routing. Configuration-set events use `eventType`; identity notification formats can use `notificationType`. Decoder fixtures must match the selected publication mechanism. [SES event fields](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)

EventBridge can filter configuration-set tags: when the event field and pattern are arrays, a shared value is sufficient to match. Alchemy `2.0.0-beta.79`'s `consumeEmailEvents({ configurationSets })` has a separate limitation: its in-process `matchValue` recheck unwraps the expected array but not the event's `detail.mail.tags["ses:configuration-set"]` array, rejecting an event the AWS rule matched. With that helper version, omit its configuration-set option and validate the actual tag array in the handler against the configured name. Retain the appropriate `detail-type` filter, but do not use it as a substitute for checking the configuration-set tag. Reassess the helper on upgrade. [AWS array matching](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns-arrays.html), [pinned event-source implementation](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/EventBridge/EventSource.ts).

Tag values are arrays in event payloads. An event can identify several recipients, and only a subset may appear in a particular feedback category. Preserve affected-recipient information when applying updates. Do not interpret a delivery for one destination as delivery for every destination or clear a complaint because a later-arriving event has a newer processing timestamp.

Before replay, distinguish an SNS delivery failure from a consumer failure and preserve event identity. Avoid publishing a replay under a fresh business identity merely because the transport assigns another message ID. Use the [SNS index](https://docs.aws.amazon.com/sns/latest/dg/llms.txt) and [SES guide index](https://docs.aws.amazon.com/ses/latest/dg/llms.txt) to verify subscription, payload and feedback behavior.
