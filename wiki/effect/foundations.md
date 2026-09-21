# Effect's core programming model

[Effect](effect.md)

API examples target Effect `4.0.0-rc.112`.

`Effect.Effect<A, E, R>` describes a computation returning `A`, failing with an expected `E`, and requiring services `R`. It is a value describing work; construction and execution are separate. `Effect.gen` sequences effects with `yield*`, while combinators transform results, errors or requirements. [RC112 Effect source and examples](https://unpkg.com/effect@4.0.0-rc.112/src/Effect.ts)

```typescript
import { Effect, Schema } from "effect";

export class InvalidName extends Schema.TaggedError<InvalidName>()(
  "InvalidName", { message: Schema.String },
) {}

export const validateName = (name: string) => Effect.gen(function* () {
  if (name.trim().length === 0) {
    return yield* new InvalidName({ message: "Name must not be empty" });
  }
  return name;
});
```

This illustrates a typed validation failure; it does not define a complete input schema. TypeScript alone cannot validate HTTP input, CSV imports or a queue body's JSON shape.

## Construct effects at the right boundary

| Work | Constructor |
| --- | --- |
| Known successful value | `Effect.succeed(value)` |
| Lazy synchronous work that should not throw | `Effect.sync(() => value)` |
| Synchronous work that may throw | `Effect.try({ try, catch })` |
| Promise API that may reject | `Effect.tryPromise({ try, catch })` |
| Existing Effect-returning SDK | Compose directly with `yield*` |

`Effect.succeed(client.fetch())` starts a promise eagerly and merely wraps that promise as a value. It does not model its rejection or cancellation. Prefer native Effect clients where they fit, or wrap the callback that starts work. Propagate an AbortSignal when the external client supports one. [Creating effects](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/01_effect/01_basics/10_creating-effects.ts)

## Expected errors, defects, and interruption

Expected errors belong in the typed channel: invalid input, not found, authorization denial, throttling, conditional conflicts and uncertain outcomes of remote operations. A defect denotes an unexpected failure or deliberately escalated error. Interruption ends work because its parent, request or deadline no longer needs it. Inspect `Cause`/`Exit` at process boundaries when all failure modes matter.

Use `Effect.catchTag` to handle a specific domain error, and `Effect.mapError` to translate SDK details into a stable application contract. Keep the underlying cause available for internal diagnostics without exposing secrets. Do not convert every failure with `Effect.orDie` merely to satisfy an adapter's `never` error channel; decide which failures need retry, quarantine or a public response first. [Error handling examples](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/01_effect/04_errors/01_error-handling.ts), [Tagged error recovery](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/01_effect/04_errors/10_catch-tags.ts)

## Keep runners at the edge

Domain functions return Effects. Run them at a CLI/process entry, a native Lambda adapter, or a third-party framework boundary. Calling `Effect.runPromise` in every service hides dependencies and fractures cancellation and resource lifetimes. Alchemy's Effect runtime already owns the execution boundary; do not build a second root runtime inside every handler.

Prefer `Effect.fn("Service.operation")` for named reusable operations and tracing, or `Effect.gen` for local composition. Services, schemas and durable records should make business invariants explicit; Effect does not automatically persist a computation or make remote side effects idempotent. [ManagedRuntime integration](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/04_integration/10_managed-runtime.ts)

## Compose success and recovery

`map` changes a successful value without introducing a new effect; `flatMap` chooses the next effect from that value. `tap` performs an additional effect while preserving the original successful value. If the tapped effect fails, the whole composition can fail, so logging or metrics placed there are not automatically harmless. A generator offers the same dependency sequencing in imperative-looking syntax.

Recovery changes the error contract. `catchTag` selects an expected tagged error; `mapError` translates errors while preserving failure. A fallback that returns a successful value removes the handled failure from that path. Use a fallback only when that value is semantically valid: an unavailable authorization store must not become “access granted.” Defects and interruption need deliberate handling at the runtime boundary rather than being silently flattened into a normal not-found result. [Error recovery examples](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/01_effect/04_errors/10_catch-tags.ts)

## Adapt a Promise without starting it early

```typescript
import { Effect, Schema } from "effect";

export class RequestFailure extends Schema.TaggedError<RequestFailure>()(
  "RequestFailure", { message: Schema.String },
) {}

export const readText = (url: string) => Effect.tryPromise({
  try: async (signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  },
  catch: (cause) => new RequestFailure({
    message: cause instanceof Error ? cause.message : "Request failed",
  }),
});
```

This example owns both the request and body read inside the Promise boundary, and passes the runtime's cancellation signal to `fetch`. Constructing `readText(url)` does not make a request. It intentionally uses one broad expected error; a reusable client can instead distinguish transport, HTTP and decoding failures so retry policies do not treat all of them alike. Restrict caller-controlled URLs when the application requires a trusted destination. [Promise construction](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/01_effect/01_basics/10_creating-effects.ts)

## Observe termination and choose a runner

`Effect.exit` captures an operation's success or failure as an `Exit`, making it possible to inspect termination explicitly. A failure contains a `Cause`, which can retain more information than a single expected error—for example, defects, interruption or multiple failures. Use these at boundaries where the full outcome matters, and avoid discarding them prematurely with a string conversion. [Exit source](https://unpkg.com/effect@4.0.0-rc.112/src/Exit.ts), [Cause source](https://unpkg.com/effect@4.0.0-rc.112/src/Cause.ts)

`runSync` is for computations that can finish synchronously; it is not a faster runner for network effects. `runPromise` integrates with Promise callbacks, while a platform runtime handles a process entry point. Before running, satisfy service requirements and decide who owns cancellation and shutdown. Starting an Effect does not create a durable record of its existence: a process crash still loses unfinished in-memory work.
