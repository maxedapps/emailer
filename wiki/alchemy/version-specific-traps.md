# Version-specific documentation and adapter traps

[Alchemy](alchemy.md)

These findings apply to **Alchemy 2.0.0-beta.79 / Effect RC117 / Distilled 1.0.0-rc.12**, checked against published source on **2026-09-23**. Recheck them on upgrades; they are not permanent claims about Alchemy.

| Trap | Verified behavior and implementation consequence |
| --- | --- |
| Assume a prerelease version implies a `beta` dist-tag | Alchemy publishes no `beta` tag; on 2026-09-23 `latest` pointed at beta.79 and `next` at the older beta.72. Use an exact version |
| Install every Effect package using `@rc` | Each package's `rc` tag moves on its own; pin one exact RC for core and every companion |
| Generic state page suggests no AWS backend | `AWS.state()` exists and uses S3; Stack state must be explicit |
| Assume a shared S3 state bucket serializes deploys | No distributed lock found in this backend; serialize writers externally |
| Set partial-batch mode and use the convenience SQS consumer | Mapping defaults partial-batch mode, but the adapter returns no per-item failure list |
| Use `QueueSink` with strings | Beta.79 accepts message entry objects |
| Treat sink completion as proof of lossless publication | Permanent per-entry failures are logged and dropped by the default sink |
| Assume SQS is capped at 256 KiB | AWS now allows 1 MiB; beta.79 sink packing still targets 256 KiB |
| Copy `workersDev: true` from a sink's Lambda example | It is a Cloudflare property; Lambda exposes `functionUrl` |
| Assume `functionUrl: true` includes product authentication | It selects public `NONE` authentication |
| Assume ACM certificate Region is fixed because the domain guide says so | Beta.79 exposes `region`, defaults to `us-east-1`, and replaces on change |
| Assume yielding a certificate always means it is issued | Without a matching public validation zone, the provider can return a pending certificate |
| Remove SES `tracking` props to reset remote settings | Omitted tracking settings preserve the existing SES configuration |
| Assume one SES binding call equals one HTTP attempt | Distilled AWS installs default transient retries; explicitly control the sender policy |
| Assume SES binding grants only one action | It grants multiple send actions plus identity/template/configuration-set scope |
| Pass `ConfigurationSetName` to the Alchemy send callable | It is omitted from that callable's request type; bind the configuration set instead |
| Copy early `ServiceMap.Service` or lowercase `Config.string` / `Flag.boolean` examples | RC117 uses `Context.Service` and PascalCase constructors: `Config.String`, `Config.Redacted`, `Flag.Boolean`, `Argument.String` |
| Manage the same data through IaC and runtime APIs | Runtime changes can conflict with desired-state reconciliation, including SES contact preferences |
| Adopt a “put then enqueue” tutorial as a durable API | A crash between the two leaves accepted records without work; use an outbox |
| Assume `adopt()` must wrap the whole deploy because the live docs say so | In beta.79 `AdoptPolicy.adopt()` is a per-effect decorator and can wrap one resource; `--adopt` is the deploy-wide flag. Recheck on upgrade. [AdoptPolicy source](https://unpkg.com/alchemy@2.0.0-beta.79/src/AdoptPolicy.ts) |
| Declare existing Route 53 records as `AWS.Route53.Record` | `read` returns attributes without `Unowned`, so an existing record is treated as owned and UPSERT overwrites it silently. [Record provider](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Route53/Record.ts) |
| Rely on `RemovalPolicy.retain()` to survive `alchemy unsafe nuke` | `nuke` enumerates and deletes SES identities it can see regardless of retention (research F6). Exclude `AWS.SES.*` when identities must live. `retain()` only skips `provider.delete` on ordinary destroy. [nuke](https://alchemy.run/cli/nuke), [Resource lifecycle](https://alchemy.run/infrastructure-as-code/resource-lifecycle/#removal-policy) |
| Merge `Cloudflare.providers()` into a stack that only sometimes uses Cloudflare | Its layer resolves Cloudflare credentials when it is built, before the stack body runs, and dies without them. Choose providers with `Layer.unwrap` over a `Config` read (the `--env-file` values are visible there). Existing Cloudflare state rows still need the provider on every later run, destroy included. [Cloudflare providers](https://unpkg.com/alchemy@2.0.0-beta.79/src/Cloudflare/Providers.ts), [CloudflareEnvironment](https://unpkg.com/alchemy@2.0.0-beta.79/src/Cloudflare/CloudflareEnvironment.ts) |
| Give `AWS.Route53.Record` a numeric `ttl` | A bare number is read as milliseconds (`300` becomes 0 s). Write `"300 seconds"`. MX values carry their priority (`"10 host"`) and TXT values their own quotes. [Record provider](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Route53/Record.ts) |
| Expect an adopted Cloudflare DNS record to be left alone | Adoption plans an update; reconcile sends a full PUT when content, TTL, `proxied` or priority differ from the declaration, and the PUT body carries no comment or tags. Compare the live record to the declared body before `--adopt`. [DNS Record](https://unpkg.com/alchemy@2.0.0-beta.79/src/Cloudflare/DNS/Record.ts) |
| Narrow `AWS.providers()` to drop the `any` | `providers()` is typed `Layer<…, never, any>` (`AWS/Providers.ts`). Stack files carry a scoped `oxlint-disable-next-line`; a cast is the same suppression. Recheck on upgrade. |
| Treat `ConfigurationSet.sendingEnabled` as a runtime pause | Reconcile re-asserts `sendingEnabled ?? true` whenever the set's props change, after adoption, or under `--force`. A guardian that disables the set through the API is undone by the next deploy. Halt on alarm state instead. [ConfigurationSet](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SES/ConfigurationSet.ts) |
| Read `Subscription.pendingConfirmation` to wait for an email confirm | `Subscribe` with `returnSubscriptionArn: true` (the default) returns a real ARN while unconfirmed, so the output is `false` immediately; the helper only inspects the ARN string for the literal `"pending confirmation"`. Confirm from the received mail. `read` and `delete` treat a subscription whose topic is gone as absent. [Subscription](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SNS/Subscription.ts) |
| Yield a resource from a Function constructor and read deploy-only services in its props | A props effect runs wherever the resource is first yielded. The Lambda runtime provides Stack, credentials, region and endpoint only, not `AWSEnvironment`. A topic or alarm whose props read that service dies at cold start after planning cleanly. Keep those props empty or reading only resource outputs. [Resource](https://unpkg.com/alchemy@2.0.0-beta.79/src/Resource.ts), [Lambda bootstrap](https://unpkg.com/alchemy@2.0.0-beta.79/src/Runtime/Bootstrap/Lambda.ts) |
| Expect `deploy` to return while a Lambda update is still in progress | Reconcile waits until the function is `Active` with `LastUpdateStatus` `Successful`, polling every 2 s for up to 30 attempts (about 60 s; 150 attempts with a VPC). A failed update fails the deploy with `FunctionUpdateFailed`; one still pending after the budget fails with `FunctionUpdatePending`, whose message carries the state and reason. [Lambda Function source](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Lambda/Function.ts) |
| Look for `aws4fetch` or `@aws-sdk/credential-providers` when debugging AWS auth | Distilled ships its own SigV4 signer and Node credential chain: environment keys, shared config and SSO profiles, `credential_process`, web identity token file, then container or instance metadata. Environment keys are skipped when a profile is named (argument or `AWS_PROFILE`). Every operation's error type includes `SigningError` and `CredentialsError` (for example `ExpiredSSOToken`). [SigV4 signer](https://unpkg.com/@distilled.cloud/aws@1.0.0-rc.12/src/sigv4.ts), [credential chain](https://unpkg.com/@distilled.cloud/aws@1.0.0-rc.12/src/credential-providers/node.ts), [common errors](https://unpkg.com/@distilled.cloud/aws@1.0.0-rc.12/src/errors.ts) |

See [Distilled retry defaults and control](../effect/retries-and-concurrency.md#distilleds-automatic-retries-are-real) before implementing a one-attempt email transport.

The certificate and tracking findings are detailed in [AWS domains and HTTP resources](aws-domains-and-http.md), with links to the published providers.

## Effect prerelease compatibility

Alchemy beta.79 declares an open-ended Effect peer range, `>=4.0.0-rc.115 || >=4.0.0`, for `effect` and the platform packages. It also lists `@effect/vitest`, `@effect/sql-d1` and `@effect/sql-sqlite-do` as dependencies with that range. The range admits every later RC, and Effect RCs rename public APIs (RC113 renamed `Config.string` to `Config.String`, for example), so a matching range is not evidence that a later RC works with this release. Alchemy also pins every `@distilled.cloud/*` package to exactly `1.0.0-rc.12`; a direct `@distilled.cloud/aws` dependency must name the same version, or the tree carries two Distilled copies. [Alchemy package metadata](https://registry.npmjs.org/alchemy/2.0.0-beta.79), [RC117 Config source](https://unpkg.com/effect@4.0.0-rc.117/src/Config.ts)

Keep the whole tree on one Effect RC. Catalogs and direct pins constrain direct dependencies only; transitive packages resolve Alchemy's open ranges on their own. The project's pnpm `overrides` therefore map every Effect v4 package (`effect`, the Node and Bun platform packages, the SQL adapters and `@effect/vitest`) to the same RC, currently RC117. `@effect/vitest@4.0.0-rc.117` peers on Vitest `>=5.0.0 <6.0.0`, so Alchemy's copy resolves the application's Vitest 5. One `packageExtensions` entry remains: `@alchemy.run/cloudflare-runtime` depends on `capnp-es`, whose optional TypeScript peer is `^5.7.3 || ^6.0.0`, so the extension gives it TypeScript 6.0.3 next to the project's TypeScript 7. The entry is keyed by Alchemy version and must move with it. [capnp-es metadata](https://registry.npmjs.org/capnp-es/0.0.16), [`@effect/vitest` peers](https://registry.npmjs.org/@effect/vitest/4.0.0-rc.117)

Upgrade Alchemy, Effect and Distilled as one change: read the new Alchemy peer range and Distilled pin, move the catalog, the overrides and the extension key together, then validate as described below. Typechecking with `skipLibCheck` can miss incompatible calls inside dependencies, so upgrade validation must exercise module initialization and the actual runtime entry points as well as application types.

## Exact evidence

- [State backend](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/StateStore/State.ts).
- [Queue event adapter](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Lambda/QueueEventSource.ts) and [mapping provider](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Lambda/EventSourceMapping.ts).
- [QueueSink type](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SQS/QueueSink.ts), [implementation](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SQS/QueueSinkHttp.ts), [shared batching implementation](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/internal/BatchedSink.ts).
- [SES send contract](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SES/SendEmail.ts), [send Layer](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SES/SendEmailHttp.ts), [scoped binding](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SES/BindingHttp.ts).
- [Lambda Function source](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/Lambda/Function.ts), [live sinks guide](https://alchemy.run/infrastructure-as-effects/sinks/).
- [Config source](https://unpkg.com/effect@4.0.0-rc.117/src/Config.ts), [Context source](https://unpkg.com/effect@4.0.0-rc.117/src/Context.ts).
- [SQS quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html), [tutorial's sequential database and queue writes](https://alchemy.run/aws/messaging/sqs/).

Review generated IAM, event-source mappings and the actual bundled runtime, rather than assuming that a compiling convenience wrapper provides all of AWS's reliability controls.

## A repeatable compatibility investigation

Begin with exact package metadata, not a dist-tag name. Resolve core, platform and other companion versions together; inspect the lockfile for additional Effect or Distilled instances. Then import the actual infrastructure entry dependencies under the intended runtime before relying on compilation. This smoke check fails fast when Alchemy calls an Effect API the installed RC no longer exports, without provisioning resources; the project runs it as `pnpm check:imports`, and it passes with the tree on RC117 under Node.js 24.19.0:

```sh
node --input-type=module -e 'await import("alchemy"); await import("alchemy/AWS"); await import("alchemy/Cloudflare"); await import("@effect/platform-node/NodeRuntime")'
```

Next compile representative Stack, binding, schema and handler examples. A successful check with `skipLibCheck` establishes only the checked application declarations; it does not validate every call inside dependency implementations. Exercise the built entry and any adapter whose return value controls acknowledgement. Finally, use an isolated deployment when behavior depends on IAM, cloud consistency or event-source configuration.

Record compatibility at the level actually observed: metadata accepted, TypeScript checked, module imported, bundle executed, or cloud integration passed. These are different evidence levels. Updating one constructor name in a dependency is not proof that every breaking change in a later RC has been addressed. [Exact package metadata](https://registry.npmjs.org/alchemy/2.0.0-beta.79)

## A changed bundle can deploy as `noop`

In beta.79, after editing application source that is bundled into a Lambda, `alchemy deploy` can report every resource as `noop` and finish in seconds, leaving the previously deployed bundle in place — `CodeSha256` and `LastModified` unchanged. Observed again on 2026-09-23: a redeploy updated only the one function whose props had changed, while three functions whose bundled code had changed reported `noop` and kept their old `CodeSha256` until `--force`. `alchemy deploy --force` ("Force updates for resources that would otherwise no-op") redeploys the new code. Verify a code change actually shipped by reading the deployed function's `CodeSha256`, not by trusting the deploy summary; a `noop` line is not evidence that the artifact matches your source.

The cause, traced on 2026-09-23: the Lambda provider's `diff` begins with `if (!isResolved(news)) return;`. At plan time a Function's props always carry an unresolved `exports.handler` value, so `diff` returns before it compares the bundle hash. The engine then falls back to a props-only comparison (`havePropsChanged`). Every code-only change is therefore planned as `noop`. A change to the props (env, memory, the `main` path) still updates the function and ships the current bundle with it. A temporary diagnostic in the compiled provider showed `exports.handler` as the only unresolved prop for all five functions of this stack. Recheck on upgrade.

## CLI defaults also need version checks

The general stage description can obscure a command-specific default. Beta.79 uses `live_$USER` for normal deployment commands and `dev_$USER` for development mode, after explicit stage/environment selection. Verify defaults from [the shipped CLI flags](https://unpkg.com/alchemy@2.0.0-beta.79/src/Cli/commands/flags.ts), particularly when a plan unexpectedly shows an empty or entirely new stage. [CLI workflow](cli-and-deployment.md)
