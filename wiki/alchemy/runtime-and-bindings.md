# Runtime, bindings, and Layers

[Alchemy](alchemy.md)

API examples target Alchemy `2.0.0-beta.79` with Effect `4.0.0-rc.117`.

Related: [Effect Layers](../effect/services-and-layers.md)

## Two phases, two lifetimes

The outer Effect in an Alchemy Lambda declaration runs during planning and again at runtime initialization. It discovers resources/bindings during planning and constructs clients at cold start. Returned handlers execute per invocation. Put externally visible operations and application writes inside handlers, never directly in the outer constructor. [Phases](https://alchemy.run/infrastructure-as-effects/phases/), [Runtime](https://alchemy.run/infrastructure-as-effects/runtime/)

| Location | Appropriate work | Dangerous work |
| --- | --- | --- |
| Resource module | Inert declarations and service tags | Eager SDK calls on import |
| Outer constructor | Bind capabilities; resolve configuration; assemble services | Mutate application records; fetch request-specific data |
| Handler | Validate, authorize, persist intent, process records | Detach a promise and return before work is durable |
| Invocation finalizer | Short request cleanup | Treat cleanup as a durable job processor |
| Instance cleanup | Best-effort client cleanup | Depend on shutdown to commit transactions |

**Not every service in `FunctionServices` exists in both phases.** `AWS.Lambda.FunctionServices` is `Credentials | Region | AWSEnvironment`, so the type checker accepts `yield* AWS.AWSEnvironment.current` anywhere in the outer constructor — but the deployed runtime context does not provide it. A Layer that reads it and is also built at cold start dies there with `Service not found: AWS::Environment`, after planning and deploying cleanly. Anything derived from the account ID or Region — an ARN you must compose yourself, such as the default event bus `arn:aws:events:${region}:${accountId}:event-bus/default` — is therefore **deploy-time-only work**. Put it in the Stack generator, which never runs at cold start, and export it from the owning module so the module still owns its resources. Reach for the `__ALCHEMY_RUNTIME__` guard only when the declaration genuinely cannot move.

**A `Config` read inside a Function is a deploy-time capture, not a runtime lookup.** Alchemy wraps the Function's `ConfigProvider` (`Platform.ts`): during planning it loads each requested path from the **deploy machine's** environment and binds the resolved value into the function's runtime context, which materializes as a Lambda environment variable; at runtime the same read returns that stored value rather than consulting the ambient provider. Two consequences follow.

First, **the outer constructor can only read configuration that exists where the deploy runs.** A value you pin into `env` from the props effect — a generated physical name, say — has nothing to capture at plan time, so `yield* Config.String("MY_PINNED_VALUE")` in the constructor fails **at plan** with `ConfigError: Expected string at ["MY_PINNED_VALUE"]`. Read such values inside the handler or the event-source callback, which run only per invocation. A value that exists on the deploy machine as well — an API token, a sender address — is the ordinary case: the constructor read works in both phases precisely because the deploy process supplies it too. The stage itself needs no `Config` read at all: `Stack` is provided in both phases, at deploy time by the CLI and at cold start by the bootstrap from the `ALCHEMY_STACK_NAME`/`ALCHEMY_STAGE` variables the Function injects.

Second, **every constructor `Config` read becomes a deployed environment variable.** That is why a bearer token read with `Config.Redacted` in the constructor is available at cold start without anyone writing it into `env`, and why `alchemy plan --detailed` prints it back: it is bound configuration by then. Treat any secret read this way as present in the function's environment and visible to `lambda:GetFunctionConfiguration`.

Alchemy's Lambda invocation Scope is settled before the response returns. There is no reliable `waitUntil` equivalent for work after a Lambda response. Hard failures can prevent instance finalization. The phase marker and `__ALCHEMY_RUNTIME__` guard are implementation machinery; application code normally uses bindings and correctly placed handlers instead. [Lambda lifecycle](https://alchemy.run/aws/compute/lambda/)

### HandlerContext is available

The generated native handler provides `AWS.Lambda.HandlerContext` — the Lambda `context` object — per invocation, for HTTP and queue handlers alike (`Function.ts` succeeds the service with the native `context` before running the effect). It is **not** in `FunctionServices` and is not present during planning or cold-start construction. A deadline that must be testable with `TestClock` can use the Effect `Clock` plus the configured timeout instead of `getRemainingTimeInMillis`. [HandlerContext](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Lambda/Function.ts)

## Deploy-time secrets

`Alchemy.Random` mints a secret once and then keeps it. `Random("Id", { bytes: 32 })` — 32 is the default — resolves to `{ text: Redacted<string> }` holding hex-encoded random bytes, and `makeRandom` maps straight to that value. The provider has no remote counterpart: it returns the stored output when one exists and generates a value only when none does, so the secret is stable across deploys and changes only when the resource is replaced or its state entry goes away. It is registered in `AWS.providers()`, and Alchemy uses it for its own shared credentials, such as the Cloudflare state-store token.

Reach for it for keys the system verifies against itself — a signing key for links it issues, a shared secret between two of its own functions. Keep ordinary configuration for credentials a person presents, because those have to be placed rather than extracted.

```typescript
import { Random } from "alchemy";
import * as Effect from "effect/Effect";

export const linkSigningKey = Random("LinkSigningKey");

export const signerProps = Effect.gen(function* () {
  const key = yield* linkSigningKey;

  return { main: import.meta.url, env: { LINK_SIGNING_KEY: key.text } } as const;
});
```

Declare it once in the module that owns it and bind that single declaration into every function that needs it, rather than repeating the call per function. Read it in the handler with `Config.Redacted`; the outer constructor cannot, because the value does not exist on the deploy machine.

Three properties to accept before adopting it:

- **The value lives in Alchemy state.** `StateEncoding` writes a `Redacted` as a marker wrapper around the plaintext, which is tagging, not encryption. Under `AWS.state()` the protection is the state bucket's default `AES256` server-side encryption and its bucket policy — nothing else.
- **Destroying the stage rotates the secret.** The apply engine deletes a resource's state entry on destroy and the provider's own `delete` is a no-op, so the next deploy finds no stored output and mints a fresh value. Anything signed with the previous one stops verifying.
- **It is not listable.** `list` returns nothing because there is no remote service to enumerate; state is the only record of the value.

## A binding is a contract plus implementation

`SES.SendEmail(identity, configurationSet)` obtains a scoped sending capability. `SES.SendEmailHttp` supplies its implementation. Binding initialization records environment values and IAM requirements; the returned callable performs runtime work. Merely declaring an identity, or calling a plain SDK, does not generate the same permission relationship. [Bindings](https://alchemy.run/infrastructure-as-effects/binding/)

```typescript
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export const Sender = AWS.SES.EmailIdentity("Sender", {
  emailIdentity: "mail.example.com",
});
export const Tracking = AWS.SES.ConfigurationSet("ExampleEvents");

// Binding composition example: must be provided by a compatible runtime host.
export const makeSender = Effect.gen(function* () {
  const identity = yield* Sender;
  const configurationSet = yield* Tracking;
  const send = yield* AWS.SES.SendEmail(identity, configurationSet);
  return (recipient: string) => send({
    FromEmailAddress: "hello@mail.example.com",
    Destination: { ToAddresses: [recipient] },
    Content: {
      Simple: {
        Subject: { Data: "Example", Charset: "UTF-8" },
        Body: { Text: { Data: "Example body", Charset: "UTF-8" } },
      },
    },
  });
}).pipe(Effect.provide(AWS.SES.SendEmailHttp));
```

This demonstrates binding placement only. It omits workload-specific authorization, recipient policy, rate control and failure handling. The binding injects `ConfigurationSetName`; do not pass it as if this were an unbound SDK call. [Versioned SendEmail contract](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SES/SendEmail.ts)

## Hide infrastructure behind domain services

Service interfaces can expose domain behavior while their implementation Layers declare resources and bind cloud operations. This lets callers depend on a capability without importing its infrastructure representation. Infrastructure needs and runtime needs are distinct even when both use Effect Layers. `Alchemy.RuntimeContext` denotes effects that belong in a deployed invocation; do not erase that requirement with casts. [Alchemy Layers](https://alchemy.run/infrastructure-as-effects/layers/)

Compose dependent Layers with `Layer.provide`; use `Layer.provideMerge` when both services must remain exposed. A flat `Layer.mergeAll` combines siblings but does not itself satisfy one sibling's dependency on another. Keep module dependencies directional so domain and client packages do not import deployment entry points.

## Circular bindings

For necessary runtime cycles, split typed identity tags from `.make()` implementations and compose those implementations at the Stack. Supported providers can reserve identities before complete reconciliation. This capability does not remove JavaScript import initialization hazards, solve arbitrary resource dependency cycles, or prevent infinite runtime recursion. Use acyclic dependencies when they express the required behavior; reserve circular bindings for capabilities that actually need mutual references. [Circular bindings](https://alchemy.run/infrastructure-as-effects/circular-bindings/)

## Follow a capability through both phases

A binding has three observable responsibilities. Its constructor identifies the resource and records the required operation. Its implementation supplies a callable under the chosen runtime host. During execution that callable performs the data-plane request with the host's resolved configuration and credentials. Capturing the callable in a handler closes over a capability, not over the deployer's permanent credentials.

The resource declaration alone does not imply every possible permission. Conversely, a binding may grant several related actions or resource scopes. Inspect the implementation for the precise statement, including object prefixes, table indexes, configuration sets or other secondary resources. Cross-service delivery can additionally need a resource policy and KMS permissions that are not represented by one execution-role statement. [Binding model](https://alchemy.run/infrastructure-as-effects/binding/), [AWS permission boundaries](../aws/iam-and-secrets.md)

## Construct once, use within the right scope

Capture reusable configuration and clients during runtime construction, then take caller identity and request data as handler inputs or invocation-scoped services. A client can survive several warm invocations; authorization context must not leak between them. Resource acquisition that belongs to one invocation should not be promoted to instance lifetime merely because the enclosing Lambda environment is reused.

If a Layer still requires `Alchemy.RuntimeContext`, it has not become a standalone local program. Running it through a generic `Effect.runPromise` without a host cannot invent bindings or deployed environment values. A local test must provide a suitable capability implementation, while an integration test must use the actual host. Keep unit tests of domain behavior separate from assertions about generated runtime wiring. [Runtime interface](https://alchemy.run/infrastructure-as-effects/runtime/), [Layer composition](https://alchemy.run/infrastructure-as-effects/layers/)

The most useful failure check crosses the real boundary: import the bundled entry, construct its host, deliver the native event shape and inspect the returned native response. A pure Effect result can be correct while a surrounding adapter discards an acknowledgement field or executes the constructor at the wrong time.
