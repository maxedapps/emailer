# HTTP, CLI, and runtime integration

[Effect](effect.md)

API examples target Effect `4.0.0-rc.117`.

Related: [MCP transports and compatibility](../mcp/transports-and-compatibility.md), [HTTP token authentication](../aws/http-token-authentication.md).

## Describe an HTTP contract

Effect's HTTP API modules model endpoints, schemas, errors, middleware and generated clients. RC117 places them under `effect/unstable/httpapi`; lower-level requests, responses, routers and clients live under `effect/unstable/http`. Keep contract definitions independent of server implementations so clients can reuse them without importing runtime dependencies. [Versioned HTTP API examples](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/51_http-server/10_basics.ts)

```typescript
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

const JobStatus = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["pending", "running", "completed"]),
});

export const JobsApi = HttpApi.make("JobsApi").add(
  HttpApiGroup.make("jobs").add(
    HttpApiEndpoint.get("getStatus", "/jobs/:id", {
      params: { id: Schema.NonEmptyString },
      success: JobStatus,
    }),
  ),
);

export const JobHandlers = HttpApiBuilder.group(
  JobsApi,
  "jobs",
  Effect.fn(function* (handlers) {
    return handlers.handle("getStatus", ({ params }) =>
      Effect.succeed({ id: params.id, state: "pending" as const }),
    );
  }),
);
```

This is a small contract example, intentionally missing real authorization and public error schemas. Add those before exposing a route. `HttpApiBuilder.group` supplies endpoint handlers as a Layer; compose handlers with domain services and middleware at the server boundary. Use OpenAPI metadata and a generated typed client where useful. [Handler example](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/51_http-server/fixtures/server/Users/http.ts)

Decoding strips undeclared object keys by default, and schema annotations cannot change that. To reject them, annotate the contract before passing it to `HttpApiBuilder.group`: `JobsApi.annotate(HttpApi.ParseOptions, { onExcessProperty: "error" })`. The annotation can sit on the API, a group or an endpoint; the most specific one wins and replaces the others rather than merging with them. It governs params, headers, query and payload decoding, response encoding and `HttpApiClient` decoding. A declared `headers` schema receives every request header, so `"error"` there also rejects undeclared headers such as `content-type`. A decode failure answers `400` with an empty body. In RC117, `"error"` also breaks every typed error response: encoding a `Schema.TaggedError` instance checks own keys with `Reflect.ownKeys`, which sees the error's non-enumerable `stack`, so the encode fails and the caller receives `500` instead of the declared error. [effect#8423](https://github.com/Effect-TS/effect/pull/8423) fixes that check to ignore non-enumerable properties; it was merged on 2026-09-23, after RC117. Until an RC contains it, keep `"error"` off an API whose endpoints declare error classes, and apply `{ onExcessProperty: "error" }` directly to the decode calls that need it. [ParseOptions](https://unpkg.com/effect@4.0.0-rc.117/src/unstable/httpapi/HttpApi.ts), [builder decoding](https://unpkg.com/effect@4.0.0-rc.117/src/unstable/httpapi/HttpApiBuilder.ts), [HttpApiSchemaError](https://unpkg.com/effect@4.0.0-rc.117/src/unstable/httpapi/HttpApiError.ts)

Treat `unstable` import paths as a reason to pin and revalidate, not to duplicate validation manually. The Alchemy HTTP guide contains older Schema spellings; prefer RC-matched source for exact syntax. [Alchemy HTTP overview](https://alchemy.run/apis/effect-http/)

`HttpRouter` matches through FindMyWay. A static segment wins over a parametric sibling at the same position regardless of declaration order. Trailing slashes are ignored by default (`ignoreTrailingSlash: true`). Registering the same method and pattern twice throws (`Method '…' already declared for route '…'`). [HttpRouter](https://unpkg.com/effect@4.0.0-rc.117/src/unstable/http/HttpRouter.ts), [FindMyWay](https://unpkg.com/effect@4.0.0-rc.117/src/unstable/http/FindMyWay.ts), [FindMyWay matcher](https://unpkg.com/effect@4.0.0-rc.117/src/unstable/http/FindMyWay/internal/router.ts)

## RPC has a different audience

Effect RPC fits coordinated Effect clients that share a versioned schema and protocol. Schemaless Alchemy RPC is convenient for trusted internal callers but does not replace validation at an external trust boundary. HTTP contracts support clients that do not share the Effect runtime; RPC trades that generality for a coordinated protocol. Select the transport according to client interoperability, schema evolution and authentication requirements. [Alchemy RPC](https://alchemy.run/apis/effect-rpc/)

## CLI surface

RC117 uses `Command`, `Flag`, and `Argument` from `effect/unstable/cli`, with Node services/runtime supplied by `@effect/platform-node`. Examples using `Options` from older `@effect/cli` versions are not the same API. [Versioned CLI guide](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/70_cli/10_basics.ts)

Separate command parsing from operation Effects so handlers can be tested independently of process execution. For automation, provide structured output and consistent exit codes. Remote commands should preserve the API's authentication and idempotency semantics; long-running operations can expose a durable operation ID for status queries.

`Flag.withSchema` decodes a parsed flag value through a Schema codec. `Flag.optional` wraps the result in `Option.Option`. `Flag.FileText(name)` takes a path and returns the file's content through Effect `FileSystem`. `Flag.FileSchema(name, schema, { format: "json" })` reads the file and decodes it as that schema (JSON when `format` is `"json"` or the extension implies it). [Flag.ts](https://unpkg.com/effect@4.0.0-rc.117/src/unstable/cli/Flag.ts)

`Flag.Date` parses through `new Date(string)`, so a zone-less value such as `2026-09-20T09:00` is the operator's local time. For an instant, start from `Flag.String`, decode with `Flag.withSchema(Schema.DateTimeUtcFromString)` (zone-less input is UTC) and render with `Flag.map(DateTime.formatIso)`. [DateTimeUtcFromString](https://unpkg.com/effect@4.0.0-rc.117/src/Schema.ts)

That decoder normalizes calendar overflow; it is not strict calendar validation. When impossible dates must fail, validate the entered date/time fields before applying the offset, then validate the normalized result against the wire schema. The scheduling CLI reuses the shared `Timestamp` check on padded calendar fields before decoding; this preserves valid leap days, offsets and milliseconds without silently rolling an invalid day into the next month.

## Native and Alchemy runtime boundaries

In Alchemy Effect mode, return the supported runtime interface and let Alchemy own startup and invocation scopes. In a native Lambda handler or third-party framework, `ManagedRuntime.make(layer)` bridges Effects to Promise callbacks while sharing initialized dependencies. Keep one runtime per process/environment when appropriate and scope request resources per invocation. [ManagedRuntime example](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/04_integration/10_managed-runtime.ts)

A native SQS handler must preserve AWS's return shape, including `batchItemFailures`. Do not route it through an adapter that discards that value. Test the actual deployed entry point, because a standalone handler test does not prove the bundler and runtime wrapper behave identically.

## From contract to a running HTTP server

The example exports an API description and a handler Layer independently. The fixed `pending` response is a demonstration implementation, not a database lookup. An actual handler supplies domain services and translates their expected errors to the endpoint's declared error schemas. Keep infrastructure failures and internal diagnostics out of the public error body.

RC117's server composition builds routes with `HttpApiBuilder.layer(Api, { openapiPath })`, provides all group handler Layers, then serves them through `HttpRouter.serve` with a platform server Layer such as `NodeHttpServer.layer`. `Layer.launch` owns the server lifetime at a process entry. A web-standard integration can use `HttpRouter.toWebHandler`, whose handler and disposer still need an owner. Neither adapter automatically converts an arbitrary AWS event into a web Request. [Complete server and client wiring](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/51_http-server/10_basics.ts)

A generated client created by `HttpApiClient.make` needs an HTTP client implementation and the correct base URL. Authentication middleware has server and client sides: the server validates credentials and supplies caller context, while the client attaches credentials. Sharing a contract does not make a credential trusted or authorize a record. Decide retry behavior for each mutation instead of automatically applying a blanket HTTP retry policy.

## A small runnable command

```typescript
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

const greet = Command.make("greet", {
  name: Argument.String("name"),
  uppercase: Flag.Boolean("uppercase"),
}, ({ name, uppercase }) => Console.log(
  uppercase ? `Hello, ${name}`.toUpperCase() : `Hello, ${name}`,
));

export const cliProgram = greet.pipe(
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
);

// At the executable entry point: NodeRuntime.runMain(cliProgram).
// Exporting it here keeps importing this example free of process execution.
export const runCli = () => NodeRuntime.runMain(cliProgram);
```

The parser owns flag and positional-argument errors; the handler owns operation errors. Use schema-backed arguments for domain constraints and preserve exit-code meaning for automation. For subcommands, compose commands with `Command.withSubcommands`; shared flags are explicit, and a subcommand can read its parent's parsed context. [RC117 command guide](https://unpkg.com/effect@4.0.0-rc.117/ai-docs/src/70_cli/10_basics.ts)

## Dispose at the owning boundary

A `ManagedRuntime` retains constructed services between callbacks. Dispose it when its owning application or test ends, not after every request if reuse is intended. Scope request resources inside each callback and forward cancellation where the surrounding framework exposes it. Conversely, do not keep a process-global runtime that captures request credentials. Runtime reuse concerns resource lifetime, not authorization lifetime. [ManagedRuntime API](https://unpkg.com/effect@4.0.0-rc.117/src/ManagedRuntime.ts)
