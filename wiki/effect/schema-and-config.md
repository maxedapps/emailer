# Schema, wire formats, and configuration

[Effect](effect.md)

API examples target Effect `4.0.0-rc.112`.

## Decode at every external boundary

Use Schema for HTTP input, CLI values, MCP arguments, queue bodies, webhook envelopes, imported records and stored-record migrations. Decode unknown data before using it; `as Job` checks nothing at runtime. Reuse decoders instead of rebuilding them per request. [Schema basics](https://unpkg.com/effect@4.0.0-rc.112/ai-docs/src/01_effect/02_schema/10_schema-basics.ts)

```typescript
import { Effect, Schema } from "effect";

export const Job = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.NonEmptyString,
  resourceId: Schema.NonEmptyString,
});
export type Job = typeof Job.Type;

export const decodeJob = (body: string) => Effect.gen(function* () {
  const json = yield* Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: () => new Error("Queue body is not JSON"),
  });
  return yield* Schema.decodeUnknownEffect(Job)(json);
});
```

This checks shape and nonempty IDs, not ownership or existence. Resource lookup, authorization and revision checks remain separate operations after decoding.

## Separate representation from meaning

`Type` is the decoded TypeScript shape; `Encoded` describes the external representation. JSON does not preserve JavaScript `Date`, `Map`, binary buffers, `undefined` or branded identifiers by itself. Choose timestamp and binary encodings explicitly. Version queue schemas so old messages remain processable after a deployment. [RC112 Schema source](https://unpkg.com/effect@4.0.0-rc.112/src/Schema.ts)

Use refinements such as `Schema.check(...)` for lengths, counts and allowed values. Keep semantic rules in domain services: a structurally valid identifier does not establish that its resource exists or that the caller can access it. Validate encoded payload sizes as well as decoded values when a transport imposes byte limits.

A timestamp's shape does not prove calendar validity. RC112's `DateTime.make` can normalize an impossible day into the following month. For a canonical UTC string contract, combine the fixed-width pattern with `Option.exists(DateTime.make(value), instant => DateTime.formatIso(instant) === value)`. This rejects both parse failures and normalization, while keeping valid encoded values unchanged. Relative rules such as "must be in the future" still belong in the domain service. See the project's [Timestamp schema](../../packages/api/src/Schemas.ts) and [validation decision](../../.adr/work/campaign-scheduling-input-validation.md).

`Schema.optional` admits a present key whose value is `undefined` (`optionalKey(UndefinedOr(S))`). `Schema.optionalKey` is absent-or-value only and types as `field?: T` rather than `field?: T | undefined`. That distinction is load-bearing under TypeScript's `exactOptionalPropertyTypes`.

`Schema.isMaxLength` counts UTF-16 code units (`value.length`), not UTF-8 bytes. A byte ceiling is a custom filter via `Schema.makeFilter`: return `undefined` or `true` on success, or a string used as the issue message. `Schema.refine` is for type-guard narrowing (`value is T`); a predicate that does not narrow belongs on `check` / `makeFilter`. [RC112 Schema source](https://unpkg.com/effect@4.0.0-rc.112/src/Schema.ts)

For API input, decide whether unknown fields are rejected or stripped and configure the decoder accordingly. For AWS event input, tolerate newly added fields while strictly checking the event discriminant and fields used for state transitions. Don't force both boundaries into one unknown-field policy.

## Configuration and redaction

```typescript
import { Config, Effect } from "effect";

export const settings = Effect.gen(function* () {
  const apiOrigin = yield* Config.string("API_ORIGIN");
  const signingKey = yield* Config.redacted("SIGNING_KEY");
  return { apiOrigin, signingKey };
});
```

In an Alchemy runtime, execute this during construction so values are discovered and bound. `Redacted` masks ordinary inspection; it is not encryption or permission control. Reveal a secret only at the cryptographic/client boundary, and do not concatenate it into log messages or error fields. Keep the source raw and defaults deterministic because config transformation can run in both phases. [Versioned Config](https://unpkg.com/effect@4.0.0-rc.112/src/Config.ts), [Alchemy config binding](https://alchemy.run/environments/secrets/)

Store non-secret runtime settings separately from rotating secrets when their lifecycle differs. Validate required values at initialization; avoid falling back to a production endpoint or permissive access policy when configuration is absent.

## Decode and encode are different directions

A codec can have a different wire type and in-memory type. For `Schema.NumberFromString`, decoding maps a valid numeric string to a number; encoding maps a number to its string representation. Refinements can constrain the decoded value, so both conversion and validation matter.

```typescript
import { Effect, Schema } from "effect";

export const PositiveCount = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
);

export const countRoundTrip = Effect.gen(function* () {
  const count = yield* Schema.decodeUnknownEffect(PositiveCount)("12");
  const encoded = yield* Schema.encodeEffect(PositiveCount)(count);
  return { count, encoded };
});
```

`"12"` decodes to `12`, while a fractional or nonpositive value fails validation. Encoding is not equivalent to arbitrary `JSON.stringify`: it applies the codec's representation rules. Retain the same codec at the boundary where a value is serialized so that a TypeScript-only representation does not accidentally become a wire contract. [Schema encoding APIs](https://unpkg.com/effect@4.0.0-rc.112/src/Schema.ts)

Choose the decoder form for the caller. Effect decoders compose expected errors and required decoding services. Synchronous decoders throw on invalid input and cannot satisfy arbitrary asynchronous decoding. Parse JSON into `unknown` before decoding, or use an explicitly JSON-aware codec; a type assertion on parsed JSON supplies no validation.

## Evolve persisted and queued schemas

Schema versioning is a consumer compatibility problem. A new deployment may process records produced by an older deployment or replayed from a DLQ. Preserve readers for supported older versions, normalize them to a current internal type and reject unsupported versions deliberately. An additive field change is only safe if the previous decoder's unknown-field policy permits it.

Distinguish optional fields from fields explicitly set to `null`, empty strings and missing properties. `optionalKey` is the absent-or-value combinator; `optional` would also admit `{ field: undefined }` as a third state. Normalization should not erase meaning: trimming an identifier, lowercasing an address or supplying a default timestamp can alter identity or audit semantics. Validate constraints at ingress, then validate persisted data again when it crosses a trust or migration boundary.

## Provide deterministic configuration in tests

```typescript
import { Config, ConfigProvider, Effect } from "effect";

const concurrency = Config.int("CONCURRENCY").pipe(Config.withDefault(4));
export const exampleConcurrency = concurrency.pipe(
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnvRecord({ CONCURRENCY: "8" }),
  ),
);
```

The explicit provider avoids dependence on the machine's environment. RC112's environment-record provider treats literal empty strings as missing unless `preserveEmptyStrings` is enabled; test missing and invalid values separately. A default belongs to the configuration contract, not to error recovery that hides arbitrary startup failures. Keep secrets redacted through normal inspection and reveal them only at the client or cryptographic boundary. [ConfigProvider semantics](https://unpkg.com/effect@4.0.0-rc.112/src/ConfigProvider.ts), [Config defaults](https://unpkg.com/effect@4.0.0-rc.112/src/Config.ts)
