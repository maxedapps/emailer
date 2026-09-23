# Version-specific documentation and adapter traps

[Alchemy](alchemy.md)

These findings apply to **Alchemy 2.0.0-beta.77 / Effect RC112**, checked against published source on **2026-09-11** and extended on **2026-09-15**. Recheck them on upgrades; they are not permanent claims about Alchemy.

| Trap | Verified behavior and implementation consequence |
| --- | --- |
| Assume a prerelease version implies a `beta` dist-tag | No `beta` tag was observed for this release; use an exact version or verify the intended tag |
| Install every Effect package using `@rc` | Tags were inconsistent; pin a coherent RC family |
| Generic state page suggests no AWS backend | `AWS.state()` exists and uses S3; Stack state must be explicit |
| Assume a shared S3 state bucket serializes deploys | No distributed lock found in this backend; serialize writers externally |
| Set partial-batch mode and use the convenience SQS consumer | Mapping defaults partial-batch mode, but the adapter returns no per-item failure list |
| Use `QueueSink` with strings | Beta.77 accepts message entry objects |
| Treat sink completion as proof of lossless publication | Permanent per-entry failures are logged and dropped by the default sink |
| Assume SQS is capped at 256 KiB | AWS now allows 1 MiB; beta.77 sink packing still targets 256 KiB |
| Copy `workersDev: true` from a sink's Lambda example | It is a Cloudflare property; Lambda exposes `functionUrl` |
| Assume `functionUrl: true` includes product authentication | It selects public `NONE` authentication |
| Assume ACM certificate Region is fixed because the domain guide says so | Beta.77 exposes `region`, defaults to `us-east-1`, and replaces on change |
| Assume yielding a certificate always means it is issued | Without a matching public validation zone, the provider can return a pending certificate |
| Remove SES `tracking` props to reset remote settings | Omitted tracking settings preserve the existing SES configuration |
| Assume one SES binding call equals one HTTP attempt | Distilled AWS installs default transient retries; explicitly control the sender policy |
| Assume SES binding grants only one action | It grants multiple send actions plus identity/template/configuration-set scope |
| Pass `ConfigurationSetName` to the Alchemy send callable | It is omitted from that callable's request type; bind the configuration set instead |
| Upgrade to RC113 because its version satisfies the peer range | Beta.77 calls `Config.string`, removed in RC113; keep Effect and its companions pinned to RC112 |
| Copy early `ServiceMap.Service` examples | RC112 uses `Context.Service` |
| Manage the same data through IaC and runtime APIs | Runtime changes can conflict with desired-state reconciliation, including SES contact preferences |
| Adopt a “put then enqueue” tutorial as a durable API | A crash between the two leaves accepted records without work; use an outbox |
| Assume `adopt()` must wrap the whole deploy because the live docs say so | In beta.77 `AdoptPolicy.adopt()` is a per-effect decorator and can wrap one resource; `--adopt` is the deploy-wide flag. Recheck on upgrade. [AdoptPolicy source](https://unpkg.com/alchemy@2.0.0-beta.77/src/AdoptPolicy.ts) |
| Declare existing Route 53 records as `AWS.Route53.Record` | `read` returns attributes without `Unowned`, so an existing record is treated as owned and UPSERT overwrites it silently. [Record provider](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/Route53/Record.ts) |
| Rely on `RemovalPolicy.retain()` to survive `alchemy unsafe nuke` | `nuke` enumerates and deletes SES identities it can see regardless of retention (research F6). Exclude `AWS.SES.*` when identities must live. `retain()` only skips `provider.delete` on ordinary destroy. [nuke](https://alchemy.run/cli/nuke), [Resource lifecycle](https://alchemy.run/infrastructure-as-code/resource-lifecycle/#removal-policy) |
| Merge `Cloudflare.providers()` into a stack that only sometimes uses Cloudflare | Its layer resolves Cloudflare credentials when it is built, before the stack body runs, and dies without them. Choose providers with `Layer.unwrap` over a `Config` read (the `--env-file` values are visible there). Existing Cloudflare state rows still need the provider on every later run, destroy included. [Cloudflare providers](https://unpkg.com/alchemy@2.0.0-beta.77/src/Cloudflare/Providers.ts), [CloudflareEnvironment](https://unpkg.com/alchemy@2.0.0-beta.77/src/Cloudflare/CloudflareEnvironment.ts) |
| Give `AWS.Route53.Record` a numeric `ttl` | A bare number is read as milliseconds (`300` becomes 0 s). Write `"300 seconds"`. MX values carry their priority (`"10 host"`) and TXT values their own quotes. [Record provider](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/Route53/Record.ts) |
| Expect an adopted Cloudflare DNS record to be left alone | Adoption plans an update; reconcile sends a full PUT when content, TTL, `proxied` or priority differ from the declaration, and the PUT body carries no comment or tags. Compare the live record to the declared body before `--adopt`. [DNS Record](https://unpkg.com/alchemy@2.0.0-beta.77/src/Cloudflare/DNS/Record.ts) |
| Narrow `AWS.providers()` to drop the `any` | `providers()` is typed `Layer<…, never, any>` (`AWS/Providers.ts`). Stack files carry a scoped `oxlint-disable-next-line`; a cast is the same suppression. Recheck on upgrade. |
| Treat `ConfigurationSet.sendingEnabled` as a runtime pause | Reconcile re-asserts `sendingEnabled ?? true` whenever the set's props change, after adoption, or under `--force`. A guardian that disables the set through the API is undone by the next deploy. Halt on alarm state instead. [ConfigurationSet](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SES/ConfigurationSet.ts) |
| Read `Subscription.pendingConfirmation` to wait for an email confirm | `Subscribe` with `returnSubscriptionArn: true` (the default) returns a real ARN while unconfirmed, so the output is `false` immediately; the helper only inspects the ARN string for the literal `"pending confirmation"`. Confirm from the received mail. [Subscription](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SNS/Subscription.ts) |
| Yield a resource from a Function constructor and read deploy-only services in its props | A props effect runs wherever the resource is first yielded. The Lambda runtime provides Stack, credentials, region and endpoint only, not `AWSEnvironment`. A topic or alarm whose props read that service dies at cold start after planning cleanly. Keep those props empty or reading only resource outputs. [Resource](https://unpkg.com/alchemy@2.0.0-beta.77/src/Resource.ts), [Lambda bootstrap](https://unpkg.com/alchemy@2.0.0-beta.77/src/Runtime/Bootstrap/Lambda.ts) |

See [Distilled retry defaults and control](../effect/retries-and-concurrency.md#distilleds-automatic-retries-are-real) before implementing a one-attempt email transport.

The certificate and tracking findings are detailed in [AWS domains and HTTP resources](aws-domains-and-http.md), with links to the published providers.

## Effect prerelease compatibility

Alchemy beta.77 declares an Effect peer range of `>=4.0.0-rc.112 || >=4.0.0`, but **RC113 is not runtime-compatible with this release as published**. Alchemy initializes its profile configuration using `Config.string`; RC113 renamed that constructor to `Config.String`. Importing `alchemy` with RC113 therefore fails with `TypeError: Config.string is not a function` in `Auth/Profile.js`. With core and relevant companions aligned to RC112, imports of `alchemy` and `alchemy/AWS` passed under Node.js 24.19.0. This is an import check, not proof of deployment compatibility. [Alchemy peer metadata](https://registry.npmjs.org/alchemy/2.0.0-beta.77), [Profile source](https://unpkg.com/alchemy@2.0.0-beta.77/src/Auth/Profile.ts), [RC113 Config source](https://unpkg.com/effect@4.0.0-rc.113/src/Config.ts)

For beta.77, pin Effect and required companion packages to RC112. Direct dependency pins or pnpm catalogs do not constrain every transitive range; inspect the resolved tree and apply compatible overrides where necessary. A newer companion must not be forced onto an older core beneath its peer requirement. Typechecking with `skipLibCheck` can miss incompatible calls inside dependencies, so upgrade validation must exercise module initialization and the actual runtime entry points as well as application types.

## Exact evidence

- [State backend](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/StateStore/State.ts).
- [Queue event adapter](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/Lambda/QueueEventSource.ts) and [mapping provider](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/Lambda/EventSourceMapping.ts).
- [QueueSink type](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SQS/QueueSink.ts), [implementation](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SQS/QueueSinkHttp.ts), [shared batching implementation](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/internal/BatchedSink.ts).
- [SES send contract](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SES/SendEmail.ts), [send Layer](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SES/SendEmailHttp.ts), [scoped binding](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SES/BindingHttp.ts).
- [Lambda Function source](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/Lambda/Function.ts), [live sinks guide](https://alchemy.run/infrastructure-as-effects/sinks/).
- [Config source](https://unpkg.com/effect@4.0.0-rc.112/src/Config.ts), [Context source](https://unpkg.com/effect@4.0.0-rc.112/src/Context.ts).
- [SQS quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html), [tutorial's sequential database and queue writes](https://alchemy.run/aws/messaging/sqs/).

Review generated IAM, event-source mappings and the actual bundled runtime, rather than assuming that a compiling convenience wrapper provides all of AWS's reliability controls.

## A repeatable compatibility investigation

Begin with exact package metadata, not a dist-tag name. Resolve core, platform and other companion versions together; inspect the lockfile for additional Effect instances. Then import the actual infrastructure entry dependencies under the intended runtime before relying on compilation. For beta.77, this minimal smoke check detects the RC113 failure without provisioning resources:

```sh
node --input-type=module -e 'await import("alchemy"); await import("alchemy/AWS")'
```

Next compile representative Stack, binding, schema and handler examples. A successful check with `skipLibCheck` establishes only the checked application declarations; it does not validate every call inside dependency implementations. Exercise the built entry and any adapter whose return value controls acknowledgement. Finally, use an isolated deployment when behavior depends on IAM, cloud consistency or event-source configuration.

Record compatibility at the level actually observed: metadata accepted, TypeScript checked, module imported, bundle executed, or cloud integration passed. These are different evidence levels. Updating one constructor name in a dependency is not proof that every breaking change in a later RC has been addressed. [Exact package metadata](https://registry.npmjs.org/alchemy/2.0.0-beta.77)

## A changed bundle can deploy as `noop`

Observed on `2.0.0-beta.77`: after editing application source that is bundled into a Lambda, `alchemy deploy` reported every resource as `noop` and finished in seconds, leaving the previously deployed bundle in place — `CodeSha256` and `LastModified` were unchanged. `alchemy deploy --force` ("Force updates for resources that would otherwise no-op") redeployed the new code. Verify a code change actually shipped by reading the deployed function's `CodeSha256`, not by trusting the deploy summary; a `noop` line is not evidence that the artifact matches your source.

## CLI defaults also need version checks

The general stage description can obscure a command-specific default. Beta.77 uses `live_$USER` for normal deployment commands and `dev_$USER` for development mode, after explicit stage/environment selection. Verify defaults from [the shipped CLI flags](https://unpkg.com/alchemy@2.0.0-beta.77/src/Cli/commands/flags.ts), particularly when a plan unexpectedly shows an empty or entirely new stage. [CLI workflow](cli-and-deployment.md)
