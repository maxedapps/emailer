# Retries, concurrency, and streams

[Effect](effect.md)

API examples target Effect `4.0.0-rc.117`.

## Retry a classified operation

Retry only errors known to be transient and operations whose repeated execution is acceptable. Schedule time and attempt caps separately. RC117's `Schedule.max` combines schedules using the larger delay and requires all to continue; `Schedule.min` uses the smaller delay and can continue while any member does. An exponential delay without a recurrence bound may retry forever. [Schedule examples](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/06_schedule/10_schedules.ts)

```typescript
import { Effect, Schedule } from "effect";

type ReadFailure = { readonly _tag: "ReadFailure"; readonly retryable: boolean };

const backoff = Schedule.max([
  Schedule.recurs(3),
  Schedule.exponential("100 millis").pipe(Schedule.jittered),
]);

// Retry only when repeating the read is safe.
export const retryRead = <A>(read: Effect.Effect<A, ReadFailure>) => read.pipe(
  Effect.retry({ schedule: backoff, while: (error) => error.retryable }),
  Effect.timeout("5 seconds"),
);
```

Three recurrences mean at most three retries after the initial attempt. An outer timeout bounds the whole retry sequence; a timeout inside the retried operation bounds each attempt. Neither cancellation nor timeout proves that a remote server did not perform the operation.

## Avoid nested retry amplification

There may be retries in an SDK, Effect, the queue consumer and a DLQ replay. Multiplying each layer's attempt budget can create many more remote requests than intended. Choose one owner for each class of failure. Record the SDK retry configuration and response ambiguity before wrapping it with another policy. Alchemy uses Distilled AWS; do not assume the AWS SDK for JavaScript retry defaults apply unchanged. [AWS SDK retry concepts](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html), [Alchemy dependency metadata](https://registry.npmjs.org/alchemy/2.0.0-beta.79)

### Distilled's automatic retries are real

`@distilled.cloud/aws@1.0.0-rc.12` threads a `Retry` service into generated SES operations. Its default comes from Distilled core: transient failures are retried with jittered exponential backoff and `Schedule.recurs(8)` (up to eight retries after the first attempt). Server retry hints can extend delays. A single call to the Alchemy send binding therefore must not be assumed to equal one HTTP attempt. [AWS retry module](https://unpkg.com/@distilled.cloud/aws@1.0.0-rc.12/src/retry.ts), [Core policy](https://unpkg.com/@distilled.cloud/core@1.0.0-rc.12/src/retry.ts), [Operation retry application](https://unpkg.com/@distilled.cloud/core@1.0.0-rc.12/src/api.ts)

The AWS retry module exports `none` and configurable `policy`; its transient/throttling convenience policies can retry indefinitely. For non-idempotent operations such as SES sends, select an explicit retry policy at the operation context and verify the resulting HTTP attempt count with a transport-level failure test. Durable attempt records must use the same definition of an attempt as the transport. Do not globally disable harmless infrastructure/read retries just to control SES sends. The same rule applies to DynamoDB conditional writes: a retried write that had already applied answers `ConditionalCheckFailedException`, so a primitive that maps that exception to a business outcome must run one HTTP attempt per request (`Retry.none`) and let its caller retry where the condition is re-evaluated.

## Bound work in several dimensions

`Effect.forEach(..., { concurrency: n })` or `Stream.mapEffect(..., { concurrency: n })` bounds simultaneous work in one computation. A semaphore bounds a shared in-process resource. Neither one controls other Lambda environments. Bound event-source concurrency, per-invocation concurrency and shared downstream service admission separately. [Effect concurrency APIs](https://unpkg.com/effect@4.0.0-rc.117/src/Effect.ts), [SQS scaling](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)

A concurrency option does not bound an array that has already been materialized. Stream paginated records and bound buffers as well as simultaneous network calls. For resumable processing, persist checkpoints externally; preserve input/result correlation when processing in parallel.

## Persistent RateLimiter

Effect 4 ships `RateLimiter` under `effect/unstable/persistence`. Its API may change before 4.0 final. The installed stores are process-local memory and Redis; a custom store implements `RateLimiterStore`. [RateLimiter source](https://unpkg.com/effect@4.0.0-rc.117/src/unstable/persistence/RateLimiter.ts)

`fixedWindow` in delay mode is a queue-style scheduler, not a reject-when-full counter. `consume` with `onExceeded: "delay"` calls the store with `limit: undefined` and returns `{ delay, remaining, resetAfter }`, where the delay is the time until this token's window opens. `sleep` is `consume` plus `Effect.sleep`. `refillRate` is `window / limit`; each token extends the item's `expiresAt` by one refill interval, so `count` only accumulates while consumes arrive faster than that interval.

The store contract for `fixedWindow`: if the item is absent or expired, start at `count = 0, expiresAt = now`; add `tokens` to `count` and `refill × tokens` to `expiresAt`; return `[count, expiresAt − now]`. DynamoDB cannot branch server-side, so the common path is one conditional `UpdateItem` and an expired item is a second `UpdateItem` conditioned on the window having closed. `tokenBucket` and the adaptive methods are separate store methods.

**Reserved-word trap.** DynamoDB reserves `COUNT`. A unit-table double that never evaluates expressions will not catch a bare `count` in `UpdateExpression` or `ConditionExpression`; the first live request fails. Alias `#count` (and `#state`, `#cursor`, `#expiresAt` where used) in every expression. [Reserved words](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html)

## Fibers and interruption

Structured child fibers belong to the parent lifetime. Detached fibers cannot provide durable execution after a serverless response. On shutdown, deadline or cancellation, stop starting new work and record unresolved non-idempotent remote operations as uncertain. Pass an AbortSignal to Promise clients that support it; a socket abort is not a rollback of a remotely completed operation.

`Effect.acquireRelease` and scoped finalizers help clean up resources, but cannot guarantee execution after Lambda termination. Use them for cleanup; use durable storage for business commitments. [Resource scope](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/01_effect/05_resources/10_acquire-release.ts), [Alchemy Lambda scopes](https://alchemy.run/aws/compute/lambda/)

## Streams, Queue, PubSub and durable queues

Effect Stream provides incremental processing and backpressure; Sink consumes a stream. Effect Queue and PubSub coordinate fibers in one runtime. AWS SQS persists messages across processes and crashes. Effect Schedule drives in-process timing; EventBridge Scheduler persists a future trigger. Select the primitive by durability requirements, not by a similar name. [Streams](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/03_stream/10_creating-streams.ts), [PubSub](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/01_effect/07_pubsub/10_pubsub.ts)

## Place timeout and retry deliberately

The composition order defines the time budget. Retrying an individually timed operation permits several per-attempt deadlines; placing one timeout around the retry sequence bounds the overall operation. Include delay time in that overall budget. A timeout must also leave enough time for the caller to persist its outcome or return the native acknowledgement shape.

Retries are repeated execution, not continuation from the failed line. Everything inside the retried Effect can run again, including logging, local mutation and remote calls that succeeded before a later failure. Put non-repeatable work outside a retry region when possible, or give it a stable idempotency identity. Separate admission throttling from transport retry so queued work does not multiply the same rate budget unexpectedly.

## Preserve useful outcomes in concurrent work

A failed element in a concurrent traversal can fail the traversal and interrupt other active work. If every item needs a recorded outcome, transform each item into an explicit result before collecting it, then decide which results should fail the batch. Do not turn every error into success merely to keep traversal alive: the resulting outcome must still drive retry or terminal handling. [Effect traversal and Exit APIs](https://unpkg.com/effect@4.0.0-rc.117/src/Effect.ts)

```typescript
import { Effect, Exit } from "effect";

export const classifyBatch = <A, E, R>(
  work: ReadonlyArray<Effect.Effect<A, E, R>>,
) => Effect.forEach(work, (item) => Effect.exit(item), {
  concurrency: 4,
}).pipe(Effect.map((outcomes) => ({
  successes: outcomes.filter(Exit.isSuccess).length,
  failures: outcomes.filter(Exit.isFailure).length,
  outcomes,
})));
```

This returns each termination outcome for inspection and uses a finite concurrency bound. It does not persist results, implement a queue acknowledgement, or guarantee completion if the parent process is killed. Preserve the correlation between each position and the originating item when using the result.

## Backpressure and buffering

A stream can pull a page, process its records, and request the next page only as downstream demand permits. An unbounded buffer inserted between stages defeats that memory bound. A bounded in-memory queue introduces a choice when full: wait, drop or reject. Select the overflow behavior explicitly; dropping is suitable for some telemetry but usually inappropriate for a durable work intent.

Fibers are units of concurrent execution managed by the runtime. `Effect.forkChild` ties a child to its parent's lifetime, and `Fiber.join` waits for its outcome. A background fiber intended to outlive a request needs a deliberately larger owner Scope, and still dies with its process. Use a persistent queue or scheduler when work must survive that boundary. [Fiber source](https://unpkg.com/effect@4.0.0-rc.117/src/Fiber.ts), [Queue source](https://unpkg.com/effect@4.0.0-rc.117/src/Queue.ts)
