# Testing and observability with Effect

[Effect](effect.md)

API examples target Effect `4.0.0-rc.117`.

## Match tests to failure boundaries

Use service Layers to inject deterministic implementations into domain tests. Test externally meaningful outcomes: an authorization denial prevents a protected operation, a duplicate job does not repeat a completed side effect, and an interrupted computation releases acquired resources. A test that repeats the implementation's own sequence of method calls does not establish those invariants.

Use `@effect/vitest` with its matching Effect RC and supported Vitest peer version: `@effect/vitest@4.0.0-rc.117` requires Effect `^4.0.0-rc.117` and Vitest `>=5.0.0 <6.0.0`. `it.effect` supplies Effect testing services; use `TestClock` from `effect/testing` for retry, lease and timeout behavior. Fork sleeping work before advancing virtual time, then join it. Use a live-clock integration test only where actual I/O needs real time. [RC117 test examples](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/09_testing/10_effect-tests.ts), [Test runner peers](https://registry.npmjs.org/@effect/vitest/4.0.0-rc.117)

High-value tests include:

- Failure classification: expected domain error, defect, interruption and uncertain remote result.
- Resource lifetime: successful completion, typed failure and interruption all release scoped resources.
- Retry behavior: only classified errors retry, with bounded attempts and predictable virtual-time delays.
- API idempotency: same key and payload returns the same operation; changed payload conflicts.
- Cancellation: child fibers terminate with their parent unless a deliberately different lifetime is provided.

Use generated data/property tests for state transition invariants, event permutations and identity normalization. In-memory tests cannot prove DynamoDB transactions, IAM, event-source mappings or SES event routing. Validate those with AWS integration fixtures and isolated deployed tests. [Alchemy Stack testing](https://alchemy.run/testing/testing-a-stack/)

## Logs and spans

Name business operations with `Effect.fn` or `Effect.withSpan`. Include bounded context such as operation type and outcome; correlate using request ID, operation ID and upstream request ID in controlled logs. Avoid personal data, request bodies, credentials, authorization headers and raw SDK request dumps. [Logging](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/08_observability/10_logging.ts), [OTLP tracing](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/08_observability/20_otlp-tracing.ts)

Use low-cardinality metric dimensions: stage, worker, operation and outcome. Put unbounded request/resource IDs in queryable logs, not metric dimensions. Instrument success, expected failure, retry exhaustion, interruption and uncertain remote outcomes separately. Lambda error counts alone miss successful invocations that return partial failures or durably quarantine work.

Keep telemetry best-effort relative to domain durability: failure to emit an optional trace must not cause a known successful external operation to repeat. Await any essential audit write as part of the operation before acknowledging it. Bound telemetry flushing within the invocation deadline; shutdown hooks cannot guarantee delivery after a hard termination.

## Test logical time rather than wall-clock delay

```typescript
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

it.effect("releases a scoped resource when its task is interrupted", () =>
  Effect.gen(function* () {
    const released = yield* Ref.make(false);
    const ready = yield* Ref.make(false);
    const task = Effect.scoped(Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.void,
        () => Ref.set(released, true),
      );
      yield* Ref.set(ready, true);
      yield* Effect.sleep("1 hour");
    }));
    const fiber = yield* Effect.forkChild(task);
    yield* TestClock.adjust("1 second");
    assert.isTrue(yield* Ref.get(ready));
    yield* Fiber.interrupt(fiber);
    assert.isTrue(yield* Ref.get(released));
  }),
);
```

The test advances logical time to let the child enter its long sleep, then verifies release on interruption. It checks a lifetime property rather than duplicating an implementation call sequence. `it.effect` supplies test services; a real I/O integration that needs wall-clock behavior belongs in a live-service test. An in-memory test cannot prove cleanup after a hard process kill. [Testing examples](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/09_testing/10_effect-tests.ts), [TestClock source](https://unpkg.com/effect@4.0.0-rc.117/src/testing/TestClock.ts)

## Exercise construction and execution separately

A Layer can fail before the first method call. Test invalid configuration, dependency acquisition failure and teardown as well as successful service methods. When two services share a Layer, a construction counter can verify intended resource sharing without asserting incidental internal call order. When tests must isolate mutable state, create a fresh test-owned Layer/runtime and close it after the test.

At a transport boundary, exercise representative native inputs and outputs: malformed payloads, declared errors, cancellation and partial batch responses. Import and execute the actual exported handler where possible. A domain test with a fake transport cannot prove that a wrapper preserves the response shape or forwards an abort signal.

## Make telemetry useful without changing the outcome

Choose span boundaries around named operations and remote calls, then propagate correlation through asynchronous message metadata deliberately. A queue creates a time and process boundary; process-local context alone cannot carry identity to the next consumer. Distinguish a trace identifier from an application idempotency key.

Record expected failures as outcomes with useful classifications rather than dumping entire exception objects into logs. A metric's dimension set should remain bounded; operation IDs belong in searchable event records or logs. Observe retry counts, queue latency and partial failures alongside request duration. Configure exporter services and flushing for the actual runtime; enabling spans does not by itself send them to a backend. [Tracing integration](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/08_observability/20_otlp-tracing.ts), [CloudWatch and audit](../aws/observability.md)
