# ADR-0040: Alchemy beta.87 and Effect 4.1

- Status: Accepted
- Date: 2026-11-17
- Authority: On 2026-11-17 the operator asked whether any dependency upgrades were possible (task 3939). The brief: land every upgrade installable now, adapt the code to breaking changes and new idioms instead of pinning back, and ask about any upgrade with a real tradeoff.
- Amends [ADR-0024](0024-typed-errors-and-cost-neutral-storage.md): a request the API cannot decode is no longer logged. Amends [ADR-0026](0026-prod-data-retention-and-harness-driven-tests.md): each function's log group is the function's own, not a separate resource.
- Plan: [0040-alchemy-beta-87-and-effect-4-1.plan.md](0040-alchemy-beta-87-and-effect-4-1.plan.md)

## Context

- **Alchemy split its providers into packages.** `alchemy/AWS`, `alchemy/Cloudflare` and `alchemy/Test` became `@alchemy.run/aws`, `@alchemy.run/cloudflare` and `@alchemy.run/test`. Beta.85 made DynamoDB the default `AWS.state()` backend, which keeps the S3 store behind `AWS.state({ backend: "s3" })`.
- **Effect 4.1 replaced `effect/Crypto` with `effect/crypto`.** Random bytes and UUIDs come from the `SecureRandom` service and hashes from `Digest`. Neither is part of a runtime's default services any more; `NodeCrypto` provides each as its own layer. Its new `Mac` service compares tags in a JavaScript loop that it documents as not guaranteed constant-time.
- **Effect 4.1 leaves request decoding failures unreported** ([effect#8834](https://github.com/Effect-TS/effect/pull/8834)): `HttpApi` answers them 400 and no longer hands them to the `ErrorReporter`. Response encoding failures still answer 500 and are reported.
- **Alchemy's Lambda functions gained two settings.** `logging.retention` creates (or adopts) the function's log group with that retention before the function can run, and deletes it with the function. `timeoutMargin`, one second by default, sets Lambda's timeout to the function's `timeout` plus the margin: the runtime interrupts the handler at `timeout` and holds the invocation until Lambda's own timeout, so every invocation that times out is billed one second more.
- **distilled rc.20 dropped Effect Schema from its generated code** for a lighter "schema-lite". It no longer exports data schemas such as `AttributeValue`, and decodes responses without validating them unless asked. Its error classes still type a failed condition's `Item` and a cancellation's `CancellationReasons` as `any`.

## Decision

1. **The state store stays on S3**, named explicitly as `AWS.state({ backend: "s3" })` in the stack, the sending-identity stack and the live suite. Prod needs no state migration, and no state table or overflow bucket is added.
2. **Crypto uses Effect's services.** Identifiers and issued secrets come from `SecureRandom`, and secret hashes from `Digest`. Each function provides only the layers it uses (`NodeCrypto.layerSecureRandom`, `NodeCrypto.layerDigest`). Signed tokens keep `node:crypto`'s `createHmac` and `timingSafeEqual`, because the platform's comparison is constant-time and Effect's is not.
3. **The storage primitives restore the SDK's declared types** for a failed condition's item and a cancellation's reasons at the one place they are caught. The decode against the SDK's exported schemas is gone with those schemas. Every record reader still validates the attributes it reads, as it does for any other output.
4. **An authenticated request the API cannot decode is answered 400 and not logged** (amends ADR-0024 plan T2). It is the client's error, not a failure of the service, so it now behaves like every other ignored error.
5. **Each function owns its log group** through `logging: { retention: Duration.days(7) }` in `lambdaBasics`; the separate `<id>Logs` resources go (amends ADR-0026).
6. **No timeout margin** (`timeoutMargin: Duration.zero`): Lambda's timeout stays each function's `timeout`. The dispatcher already ends its slices short of its timeout, and the other functions finish far inside theirs, so the interruption would buy nothing for a second billed on every timeout.
7. **Shims for fixed Alchemy issues go:** the stack no longer resolves `AWSEnvironment` first ([alchemy#1842](https://github.com/alchemy-run/alchemy/issues/1842), fixed in beta.85).

## Alternatives

- **Pin back to beta.80 and Effect 4.0** (the simplest): it leaves the repository on releases its dependencies no longer fix, and each later upgrade gets harder.
- **Move the state store to DynamoDB, Alchemy's new default:** it needs an `alchemy state migrate` on prod and adds a state table (and an overflow bucket), for no gain at emailer's scale. It remains open for a later task.
- **Sign and verify tokens with Effect's `Mac`:** it would make `sign` and `verify` effectful through every caller, and it would replace a constant-time comparison with one that is not guaranteed to be.
- **Write our own recursive `AttributeValue` schema:** it would duplicate the validation every record reader already performs.
- **Keep the default timeout margin:** finalizers would run on a timed-out invocation, at one more billed second per timeout.
- **Keep the `<id>Logs` resources:** the same log groups and retention through extra resources and state rows.
- **Keep logging malformed requests through our own middleware:** it would restore a log line that records a client's mistake, at a CloudWatch Logs cost per request.

## Consequences

- Steady-state cost: unchanged. The state store and every resource stay as they are, a malformed request logs one line fewer, and the crypto layers are smaller.
- **Existing stages (prod) need a one-time step before their first deploy of this change:** forget the five log-group records without deleting the groups, `pnpm exec alchemy state rm Emailer/<stage>/<Api|Dispatcher|Feedback|Unsubscribe|Preview>Logs` (with the stage's configuration and credentials). Without it the deploy deletes the groups after the functions adopted them, and Lambda's role may not recreate them, so the functions log nothing until a later deploy updates them.
- The live suite's harness and the stage tool import `@alchemy.run/test` and `@alchemy.run/aws`.
