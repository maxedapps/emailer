# Event sources and sinks

[Alchemy](alchemy.md)

API examples target Alchemy `2.0.0-beta.79` with Effect `4.0.0-rc.117`.

Related: [SQS behavior](../aws/sqs.md)

An event source combines trigger configuration, permissions and runtime dispatch. An Alchemy sink adapts an Effect Stream into batched writes to an AWS resource. Both still inherit the delivery and failure semantics of the underlying service. An in-memory Stream is not a durable queue. [Event sources](https://alchemy.run/infrastructure-as-effects/event-sources/), [Sinks](https://alchemy.run/infrastructure-as-effects/sinks/)

## SQS consumer convenience API

`AWS.SQS.consumeQueueMessages(queue, props, process)` receives a `Stream<SQSRecord>`. Provide `AWS.Lambda.QueueEventSource` on the Lambda constructor. The layer grants receive/delete/get-attributes permissions and declares a mapping. This is appropriate for simple whole-batch processing, provided every externally visible action tolerates redelivery.

**Beta.79 limitation:** the Lambda adapter forwards only batch size and batching window, sets the mapping enabled, and expects `process` to return `Effect<void, never, ...>`. It does not produce an SQS `batchItemFailures` response. The lower-level mapping provider defaults `ReportBatchItemFailures`, but that setting alone does not implement record-level recovery. A thrown/defect failure still fails the invocation; swallowing a failure can acknowledge lost work. [Queue adapter source](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Lambda/QueueEventSource.ts), [Mapping source](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Lambda/EventSourceMapping.ts)

Choose a consumer according to its required failure granularity:

- Batch size **1** limits the convenience adapter's failure unit to one message; redelivery still requires idempotent processing. A normal return from `process` acknowledges and deletes that message; a slice that made no progress must die so SQS redelivers rather than dropping the work.
- For record-level failure reporting within a batch, use an explicit mapping and a native Lambda handler/adapter that returns failed record IDs. Configure IAM and runtime dependencies explicitly, and avoid registering duplicate mappings for the same consumer.

**Consume and send on one queue.** Constructing `SendMessage(queue)` in the same function that consumes that queue is two grants on one ARN: receive/delete/get-attributes from the consumer Layer, `SendMessage` from the binding. A continuation enqueued after a won checkpoint is the same message shape as the original wake-up. `AWS.Lambda.HandlerContext` is provided per invocation; see [runtime and bindings](runtime-and-bindings.md#handlercontext-is-available).

The explicit mapping exposes `functionResponseTypes`, `scalingConfig`, `enabled` and failure settings unavailable through the convenience API. Full worker integration needs a deployment test; setting these properties is not sufficient evidence that the generated handler preserves its return value.

## Sink data shape and loss behavior

The live documentation contains string-stream examples. **The published beta.79 `QueueSink` accepts message entry objects**, specifically `SendMessageBatchRequestEntry` without its per-batch `Id`. Supply `{ MessageBody, MessageGroupId?, MessageDeduplicationId?, ... }`. [QueueSink contract](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SQS/QueueSink.ts)

```typescript
import * as AWS from "alchemy/AWS";
import { Effect, Layer, Stream } from "effect";

export const makePublisher = Effect.gen(function* () {
  const queue = yield* AWS.SQS.Queue("ExportEvents");
  const sink = yield* AWS.SQS.QueueSink(queue);
  return (bodies: ReadonlyArray<string>) => Stream.fromIterable(bodies).pipe(
    Stream.map((MessageBody) => ({ MessageBody })),
    Stream.run(sink),
  );
}).pipe(Effect.provide(
  AWS.SQS.QueueSinkHttp.pipe(Layer.provideMerge(AWS.SQS.SendMessageBatchHttp)),
));
```

This is a composition example, **not a lossless outbox publisher**. Beta.79 groups up to ten entries with a 256 KiB packing target. Transient failed entries are retried on a bounded schedule; exhausted entries fail with `BatchRetryExhaustedError`. Permanently rejected entries (`SenderFault: true`) are warned about and dropped by the default shared sink implementation. Success of the sink therefore does not certify that every input reached SQS. [QueueSinkHttp](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SQS/QueueSinkHttp.ts), [BatchedSink implementation](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/internal/BatchedSink.ts)

For a lossless publication boundary, inspect explicit `SendMessageBatch` responses. Record each successful entry, retain retryable entries, and durably quarantine permanent failures. Only mark an intent dispatched after its entry is known to have succeeded. Do not mark an entire outbox page dispatched because a generic sink completed.

## Other event sources

DynamoDB Streams use `DynamoDB.consumeTableChanges` with the Lambda table event-source Layer; SNS-to-Lambda uses `SNS.consumeTopicNotifications` with `Lambda.TopicEventSource`. SNS → SQS → Lambda adds a durable buffer and independent consumer redrive; direct SNS → Lambda has different retry ownership. Separate queues can isolate workloads with different recovery and concurrency requirements. [DynamoDB guide](https://alchemy.run/aws/data/dynamodb/), [SNS guide](https://alchemy.run/aws/messaging/sns/)

## Acknowledgement is the critical output

For a queue consumer, map the complete chain from message receipt to acknowledgement. First decode the envelope; then perform or durably record the intended work; finally return the success/failure shape the host understands. Logging an error and returning normally is an acknowledgement decision. Throwing at the top level can replay records that already succeeded. Both choices need explicit handling of repeated effects. [Native SQS responses](../aws/sqs.md#partial-batch-failures)

A record can carry several identifiers: the transport message ID, a receive-specific receipt handle, and an application operation ID. Batch failure reporting uses the transport ID; a direct SQS delete uses the current receipt handle; deduplicating business work uses a stable application identity. Interchanging them can either fail acknowledgement or acknowledge the wrong logical outcome.

## Batch producers and recovery

When publishing a batch directly, map each request entry ID back to the durable source record. Inspect both successful and failed entries even after an HTTP 200 response. Only confirmed entries can advance to a dispatched state. Retryable failures remain pending; permanent failures require an explicit terminal record or quarantine policy. If a transport timeout leaves the entire batch uncertain, assume that some entries may already have reached the destination. [SQS batch publication](../aws/sqs.md#publish-and-receive-directly)

Backpressure in a Stream bounds demand between its stages, but it cannot replace persistent recovery after an invocation ends. Batching improves request efficiency and changes failure granularity; it does not establish transactional publication across the batch. An exhausted sink should leave enough durable information to reconstruct unfinished work without generating new logical IDs.

## Integration checks for an adapter

Test an all-success batch, a mixed-success batch, a malformed envelope, an operation timeout, and a process failure after an external write. Verify which messages reappear, which identifiers are returned, and whether the handler's native response survives wrapping. Also inspect the generated mapping, execution-role policy and destination resource policy. These checks establish the adapter's actual composition with the service; a stream transformation test alone cannot.
