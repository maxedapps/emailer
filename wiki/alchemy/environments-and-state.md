# Stages, profiles, state, and secrets

[Alchemy](alchemy.md)

API examples target Alchemy `2.0.0-beta.79` with Effect `4.0.0-rc.117`.

Related: [Lambda token authentication](../aws/http-token-authentication.md), [domain resource ownership](aws-domains-and-http.md).

## Isolation has several dimensions

A stage selects a Stack instance; a profile selects credentials; the AWS account and Region select the actual cloud boundary. Stage names do not isolate account-wide quotas or singleton settings; SES quotas, reputation and domain identities are examples (SES allows one identity per domain per account and Region). Explicit physical names and cross-stage references can also defeat expected isolation. Use explicit stage/profile/Region selection for controlled environments and separate AWS accounts where production isolation matters. Account-level objects that must never be recreated, such as an Easy DKIM identity, belong in a retained owner stack rather than an ephemeral stage — see [SES](../aws/ses.md). [Stages](https://alchemy.run/environments/stages/), [Profiles](https://alchemy.run/environments/profiles/)

Beta.79 deployment commands default to `live_$USER`; `dev` defaults to `dev_$USER`, after any explicit stage or `ALCHEMY_STAGE` selection. [Stage resolution source](https://unpkg.com/alchemy@2.0.0-beta.79/src/Cli/commands/flags.ts) Do not make CI rely on whichever username happens to be present. Use stage-specific endpoints and restrict preview access to external side effects. Avoid reconciling an account-wide setting independently from multiple stages.

## S3 state is available

`AWS.state()` in beta.79 persists resource records and Stack outputs in S3. Its default bucket name is `alchemy-state-{accountId}-{region}-an`, using the account-regional namespace. Keys include Stack, stage and fully qualified resource identity. Initial state access can bootstrap the bucket; **planning may therefore have a bootstrap side effect** on a fresh environment. [Published State source](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/StateStore/State.ts)

The implementation enables bucket versioning, default encryption and public-access blocking. Default encryption is SSE-S3 (`AES256`); KMS configuration is available. Restrict deployment-role access to state and backups. Redacted values must remain recoverable by deployment, so do not treat an obscured log representation as proof that stored secrets are inaccessible.

No cross-process Stack/stage lock or conditional state-write protection was found in this S3 implementation. Its cached initialization protects local first-use setup, not two independent CI deployments. **Serialize all writers for a Stack/stage**, including local runs. Versioning helps recovery but does not serialize updates. Avoid changing state-store location casually: the new location does not automatically know the old resource ownership.

The generic [state-store overview](https://alchemy.run/state-store/) omits AWS while the [AWS guide](https://alchemy.run/aws/compute/lambda/) and published package implement it. Use version-matched backend source to resolve this documentation discrepancy. `Alchemy.localState()` is useful for isolated experiments; do not mix local and S3 state against the same production resources.

## Credentials

Alchemy profiles are distinct from AWS CLI profiles. The current profile documentation says complete provider environment credentials take precedence over stored profile credentials. CI resolves environment credentials instead of reading local Alchemy profiles. Use temporary role credentials supplied by CI OIDC, including session token and Region; avoid copying a developer credential directory into CI. Check the resolved account before any later deployment. [Profiles and CI environment contract](https://alchemy.run/environments/profiles/)

Credential permissions for deployment exceed those of runtime functions. Runtime roles need only the operations their handlers perform; deployment roles additionally need resource reconciliation, IAM and state permissions. A client calling an application API does not need the deployment role.

## Configuration is captured during construction

Resolve required configuration in the outer constructor so Alchemy discovers and injects it. Reading it only inside a request handler does not let planning discover it. The raw source value is captured; transformations and defaults execute again at runtime. Keep defaults deterministic. [Secrets and configuration](https://alchemy.run/environments/secrets/)

RC117 spells configuration constructors in PascalCase: `Config.String`, `Config.Number`, `Config.Int` and `Config.Redacted`. Combinators such as `Config.all`, `Config.option`, `Config.schema` and `Config.withDefault` stay lowercase, and a fallible transformation is `Config.mapEffect`. [Versioned Config source](https://unpkg.com/effect@4.0.0-rc.117/src/Config.ts)

Distinguish three mechanisms:

| Mechanism | Refresh behavior |
| --- | --- |
| Alchemy-captured environment configuration | Changes become deployed configuration on redeploy |
| AWS Secrets Manager secret resource | Manages secret storage; does not itself make every handler fetch it |
| Runtime secret retrieval with a cache | Can observe rotation according to cache lifetime and refresh logic |

Use runtime retrieval for secrets whose rotation must take effect without a deployment. Grant retrieval and KMS permissions explicitly and choose a cache lifetime. Keep credentials and sensitive application data out of Stack outputs. [AWS secret retrieval](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html)

## Diagnose an unexpected environment

A plan that wants to create every resource often indicates a different state address rather than deleted infrastructure. Compare the Stack name, stage, account, Region and backend location with the last successful deployment. A profile change can alter both resource location and the default AWS state bucket. A physical name collision in the new location does not prove that the object is safe to adopt.

Inspect the saved resource record and then query the actual cloud object using its returned identifier. Persisted props describe what Alchemy previously requested; output attributes describe what it saved; the live resource describes what exists now. Preserve all three when diagnosing a partial failure. See [CLI state inspection](cli-and-deployment.md#apply-repeat-and-recover).

## Restore state without confusing it with a rollback

Before restoring a state object, stop concurrent writers and retain the current version. Select a known snapshot, identify cloud mutations performed afterward, and compare the restored graph with live resources before applying. An old state snapshot can name a deleted generation or omit a newly created one. Restoring it does not reverse external mutations.

A state backend migration needs a consistent transfer of Stack records and outputs, correct access to any protected values, and a controlled switch of writers. Starting with an empty backend creates an ownership-discovery problem. Do not write to old and new backends independently while both target the same physical objects. S3 versioning provides useful history, but it does not supply distributed locking or a cross-object transaction. [AWS state implementation](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/StateStore/State.ts)

## Secret lifetime and application lifetime

An environment variable is an initialization input. A rotated secret retrieved from an external service is a runtime dependency. If a long-lived client caches a secret, refreshing the secret value without rebuilding the client may leave authentication unchanged. Specify the cache and client refresh behavior together, and test failure during rotation rather than only successful startup. [Secrets and runtime retrieval](../aws/iam-and-secrets.md)
