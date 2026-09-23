# SQS work queues

[AWS](aws.md)

Related: [Alchemy queue adapter](../alchemy/events-and-sinks.md)

## Delivery semantics

Standard SQS queues can deliver duplicates and do not guarantee ordering. Lambda polls messages, hides them for the visibility timeout and deletes them after successful processing. A failure or lease expiry makes work available again. Every message must be safe to observe repeatedly. [Lambda with SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)

FIFO queues provide ordered processing within a message group and deduplicate producer requests within their deduplication interval. AWS's “exactly-once processing” terminology does not make a consumer's external side effect atomic with queue acknowledgement. Consumer idempotency remains necessary. Putting all messages in one group serializes that group's processing. [FIFO deduplication](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html)

## Publish and receive directly

A queue URL addresses data-plane requests; its ARN identifies it in IAM policies and event-source mappings. `SendMessage` publishes one body, while `SendMessageBatch` publishes up to ten request entries and reports each entry separately. The `Id` in a batch request is a correlation key within that request, not the SQS-generated message ID or a durable business deduplication key.

A representative successful HTTP response can still contain a failed entry:

```json
{
  "Successful": [{ "Id": "entry-1", "MessageId": "message-1", "MD5OfMessageBody": "example-digest" }],
  "Failed": [{ "Id": "entry-2", "SenderFault": true, "Code": "InvalidMessageContents", "Message": "Invalid body" }]
}
```

This is an illustrative response fragment. Map entries back to their source records, retain failed records and classify the reason before retrying. `SenderFault` indicates a request-side issue; repeating an unchanged invalid payload is unlikely to repair it. Both the individual message and combined batch payload are limited to 1 MiB under the inspected API documentation. [SendMessageBatch](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessageBatch.html)

A direct polling consumer uses `ReceiveMessage`, processes the returned body and calls `DeleteMessage` only when its acknowledgement condition is satisfied. Each receive gives a receipt handle; deletion and visibility changes use that handle rather than the stable message ID. Long polling waits for available work and reduces empty responses; keep the HTTP request timeout longer than the configured long-poll wait. Lambda event-source mappings perform this polling and deletion on the consumer's behalf. [ReceiveMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html)

A mapping reporting `State: Disabled` is not yet quiet. Observed live on 2026-09-23 (us-east-1): on a quiet stage a message sent one second after the mapping turned `Disabled` was still received and invoked, while one sent twelve seconds after stayed in the queue; on a stage that had just been busy, the pollers kept invoking for more than twenty seconds, and a draining poller took about five seconds to pick a new message up. Code that holds messages by disabling a mapping needs evidence that the pollers have stopped. The integration suite sends a canary message and requires it to be still visible, with nothing in flight, 25 seconds later, which is longer than one 20-second long poll. [Lambda SQS event source mappings](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)

## Queue and worker settings

| Setting | Guidance |
| --- | --- |
| Message unit | Independently retryable work with a stable application ID; references for large payloads |
| Visibility | AWS recommends at least `6 × function timeout + batching window` |
| Function timeout | Must not exceed queue visibility; budget the whole batch and final writes |
| Batch size | Balance throughput against failure granularity; batch size 1 limits whole-batch retries to one record |
| Redrive attempts | AWS recommends `maxReceiveCount` at least 5 as a starting point; classify permanent errors earlier |
| Retention | Long enough for expected outages; DLQ retention longer than source retention |
| Worker concurrency | Limit per mapping and per function, enforce downstream service rate limits separately |

Choose values from workload duration, outage tolerance and downstream limits; the AWS visibility and redrive recommendations are starting points. [Lambda SQS configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html), [Scaling](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)

## Partial-batch failures

For a native handler, enable `ReportBatchItemFailures` and return the **SQS message ID** for each record that needs another attempt:

```json
{
  "batchItemFailures": [
    { "itemIdentifier": "failed-sqs-message-id" }
  ]
}
```

Do not use an upstream event ID or application job ID here. A top-level throw fails the whole batch; successful records may repeat. FIFO handlers must stop after a failure and report failed/unprocessed records as required to preserve order. Persist a terminal quarantine outcome before excluding an invalid record from failures. With partial responses enabled, polling does not automatically scale down on failures as it otherwise can, so rate limiting still matters. [Partial-batch behavior](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)

Alchemy's lower-level mapping supports these controls; its convenience SQS adapter does not generate the per-record response. See [adapter evidence](../alchemy/version-specific-traps.md).

## DLQs and replay

The source queue's redrive policy moves repeatedly received messages to a DLQ. An SNS subscription DLQ protects an earlier delivery hop and has a separate role. Alert on any DLQ growth and inspect age as well as count. For standard queues, the original enqueue timestamp governs expiry even after a DLQ move, which is why longer DLQ retention matters. [SQS DLQs](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)

Fix the cause before replay. Revalidate current authorization, cancellation state, completed-operation records, schema version and referenced payloads. Redrive at a bounded rate and preserve logical operation IDs; a new ID can bypass deduplication and repeat an external side effect.

## Quotas worth remembering

The current AWS limit is **1 MiB per message**; batch API calls contain at most **10 messages**. Default retention is **4 days**, maximum **14 days**. Message delay is at most **15 minutes**. Lambda's receive batch limits differ from SQS's send-batch limit. Long scheduling belongs in Scheduler or a durable due-work dispatcher. [SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)

A local rate-limited Stream is bounded only within its invocation. Across N Lambda instances the rate can multiply by N. Treat queue buffering as pressure relief, not as quota enforcement.

## Visibility is not exclusive ownership

A received message remains in SQS while it is invisible to ordinary subsequent receives. If processing exceeds visibility, another delivery may begin while the first worker is still active. Extend visibility when supported for long processing, but also use durable ownership/version conditions where concurrent external effects matter. A lease deadline alone does not prevent a paused worker from resuming after its lease expired.

For FIFO, choose message groups from the actual ordering requirement. Independent groups allow parallel processing; one global group serializes work. Producer deduplication is bounded by its service interval and does not eliminate consumer redelivery. A consumer that performs an external operation and crashes before acknowledgement still needs a way to recognize completed work. [FIFO semantics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html)

For native Lambda partial responses, record each failed SQS ID once and ensure success means that either processing completed or a terminal disposition is durable. If a FIFO failure prevents later records in its ordered sequence from running safely, return those unprocessed records as required instead of acknowledging them. Test an actual mixed batch; enabling a mapping flag without returning the response is insufficient.

Documentation discovery starts with the [SQS `llms.txt`](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/llms.txt). Keep send-batch limits, receive API limits and Lambda invocation batch limits distinct when sizing a consumer.
