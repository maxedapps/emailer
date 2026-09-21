# Services and Layers

[Effect](effect.md)

API examples target Effect `4.0.0-rc.112`.

Related: [Alchemy bindings](../alchemy/runtime-and-bindings.md)

A service tag identifies an interface. A Layer constructs its implementation and describes the implementation's dependencies. RC112 uses `Context.Service`; early beta examples using `ServiceMap` are obsolete for this baseline. [Service example](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/01_effect/03_services/01_service.ts)

```typescript
import { Context, Effect, Layer } from "effect";

export class AccessPolicy extends Context.Service<AccessPolicy, {
  readonly canRead: (subjectId: string, resourceId: string) => Effect.Effect<boolean>;
}>()("example/AccessPolicy") {}

export const denyAllAccess = Layer.succeed(AccessPolicy, {
  canRead: () => Effect.succeed(false),
});

export const checkAccess = (subjectId: string, resourceId: string) => Effect.gen(function* () {
  const policy = yield* AccessPolicy;
  return yield* policy.canRead(subjectId, resourceId);
});

export const example = checkAccess("user-a", "document-a").pipe(
  Effect.provide(denyAllAccess),
);
```

This implementation always denies access and illustrates dependency replacement. Implementations that consult storage should expose expected lookup failures in the error channel; a failed lookup must not silently become an authorization grant.

## Compose dependencies explicitly

For `RepositoryLive` requiring a database and `ApplicationLive` requiring a repository:

```text
DatabaseLive → RepositoryLive → ApplicationLive
```

- `Layer.succeed(Tag, implementation)` supplies an already constructed service.
- `Layer.effect(Tag, initialization)` builds one effectfully.
- `Layer.mergeAll(A, B)` supplies independent siblings.
- `B.pipe(Layer.provide(A))` satisfies B's dependency and exposes B.
- `B.pipe(Layer.provideMerge(A))` satisfies B and exposes both A and B.

Providing sibling Layers without wiring their dependencies is a common source of residual `R` requirements. Do not suppress those errors with `any` or a cast to `never`. [Layer composition](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/01_effect/03_services/20_layer-composition.ts)

## Choose service boundaries by behavior

A service groups operations that share a meaningful capability or resource lifetime. Keep interfaces small enough to substitute in tests and hide implementation details such as database wire formats or vendor exceptions behind adapters. Avoid creating one service per function solely to use dependency injection.

Expose expected failures and dependencies accurately. A service that may fail while fetching data should not claim an infallible result; an implementation that needs a database should retain that Layer requirement until it is provided. Service boundaries do not imply separate packages, processes or deployable units.

## Lifetime and memoization

Reuse a Layer value within a composition graph so its initialization can be shared. Rebuilding Layer factories or independent runtimes may allocate separate clients and caches. Acquire closeable resources with `Effect.acquireRelease` and a Scope. The acquisition site determines whether the resource belongs to a process, a warm Lambda environment or a single request. [Resource management](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/01_effect/05_resources/10_acquire-release.ts), [ManagedRuntime](https://unpkg.com/effect@4.0.0-rc.112/src/ManagedRuntime.ts)

Never hold mutable authenticated caller identity in an instance-wide service. Pass it as request data or provide a request-scoped context. In-memory fakes are useful for deterministic domain tests, but they cannot validate AWS consistency, IAM or retry behavior.

## Read a Layer type

`Layer.Layer<Out, E, In>` describes the services constructed, possible construction errors, and services needed to construct them. These differ from errors raised by later service method calls. A database Layer might fail to connect at startup, while its query method has a separate error channel for failures during use. Providing the Layer removes its constructed services from an Effect's unmet requirements and adds any requirements or failures of construction that remain.

Construction order follows dependencies. If a repository requires a database, supplying both as siblings does not automatically direct the database into the repository constructor. Provide the database to the repository, then provide the resulting Layer to the application. Use `provideMerge` only when downstream consumers also need the supplied service; exposing everything makes lifetime and ownership harder to follow.

## Acquire resources with finalizers

```typescript
import { Effect, Ref } from "effect";

export const scopedResourceExample = Effect.gen(function* () {
  const released = yield* Ref.make(false);
  const value = yield* Effect.scoped(Effect.gen(function* () {
    const resource = yield* Effect.acquireRelease(
      Effect.succeed({ value: 42 }),
      () => Ref.set(released, true),
    );
    return resource.value;
  }));
  return { value, released: yield* Ref.get(released) };
});
```

The inner Scope owns the acquisition. On normal completion it closes before the outer program reads the release flag, producing `{ value: 42, released: true }`. Scope also governs cleanup on typed failure or interruption, subject to process termination limits. Real acquisitions replace the placeholder object with a connection, file or subscription and provide the corresponding close operation. [Resource management](https://unpkg.com/effect@4.0.0-rc.112/src/Scope.ts), [acquire/release example](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/01_effect/05_resources/10_acquire-release.ts)

## Sharing is tied to construction context

Layer memoization is associated with a build graph or explicitly shared memo map. Reusing the same Layer value inside one composition allows sharing; independently creating runtimes does not imply one global singleton. A constructor that creates a fresh Layer on each call can defeat intended reuse. Deliberately fresh instances are useful when isolation is required, but should be explicit.

In tests, replace the narrow service the behavior depends on and retain its real contract. An infallible in-memory fake can verify success logic but cannot demonstrate handling of a storage error it never produces. For request-scoped capabilities, supply the context within that request; avoid mutating a shared service to store the current caller. [Layer source](https://unpkg.com/effect@4.0.0-rc.112/src/Layer.ts)
