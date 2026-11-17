# Plan: Alchemy beta.87 and Effect 4.1

- Status: Accepted
- Decision: [ADR-0040](0040-alchemy-beta-87-and-effect-4-1.md)

## Goal

**Done when:** every dependency with a release at least 24 hours old is on its newest version (within the Node 24 engine), the code follows the new releases' idioms, `pnpm install --frozen-lockfile` passes without an exclude list, and the change landed through the repo Check.

**Out of scope:** `@types/node` 25 and 26 (the engine is Node 24); TypeScript 7.1 (not released); Vite 8.4 betas; moving the state store to DynamoDB (ADR-0040, Alternatives).

## Tasks

### T1 — Versions

| Package | From | To |
| --- | --- | --- |
| `alchemy` | 2.0.0-beta.80 | 2.0.0-beta.87 |
| `@alchemy.run/aws`, `@alchemy.run/cloudflare`, `@alchemy.run/test` | (in `alchemy`) | 2.0.0-beta.87 |
| `effect`, `@effect/platform-node`, `@effect/vitest` | 4.0.0 | 4.1.4 |
| `@distilled.cloud/aws` | 1.0.0-rc.13 | 1.0.0-rc.20 |
| `@effect/tsgo` | 0.48.0 | 0.69.0 |
| `oxlint`, `@oxlint/plugins` | 1.82.0 | 1.93.0 |
| `oxlint-tsgolint` | 7.0.2001 | 7.0.2007 |
| `oxfmt` | 0.70.0 | 0.79.0 |
| `vite` / `vitest` | 8.3.0 / 5.0.1 | 8.3.8 / 5.1.0 |
| `knip` | 6.37.0 | 6.45.1 |
| `marked` | 18.0.14 | 18.2.0 |
| `csv-parse` | 7.0.2 | 7.0.3 |
| `@types/node` | 24.13.6 | 24.19.2 |
| pnpm | 12.3.4 | 12.21.0 |
| `.node-version` | 24.19.0 | 24.22.3 |

`packageExtensions` keeps TypeScript 6 for capnp-es, whose optional peer still accepts only 5 or 6. Waiting on the 24-hour age: `@effect/tsgo` 0.70.0 (from 2026-11-18 02:11 UTC), which is the first to support `oxlint` 1.94.0; and `marked` 18.2.1 (from 2026-11-17 17:23 UTC).

### T2 — Adapt the code

- Imports move to `@alchemy.run/aws`, `@alchemy.run/aws/Credentials`, `@alchemy.run/cloudflare` and `@alchemy.run/test/Vitest`; the state store is `AWS.state({ backend: "s3" })`.
- Crypto: `SecureRandom` for identifiers, transaction tokens and issued secrets, `Digest` for secret hashes and the variant split. The API and the dispatcher provide `NodeCrypto.layerSecureRandom` and `layerDigest`; the feedback function provides `layerSecureRandom`.
- SQS consumers read `event.Records` (beta.85 hands them the `SQSEvent`).
- The storage primitives restore the SDK's declared types for a failed condition's item and a cancellation's reasons.
- The CLI's stderr terminal implements `Terminal.size`, as Node's terminal does for stdout.
- The API's errors carry the brand type argument that `@effect/tsgo`'s correctness preset now asks for.
- Tests: credentials are `Redacted`, the alarm fixture carries `ActionConfiguration`, and the campaign tests provide `SecureRandom`. The transport tests provide credentials to the invocation, since the bindings now read them per call. The malformed-request test expects no log line (ADR-0040, 4).
- `lambdaBasics` gives each function `logging: { retention: Duration.days(7) }` and `timeoutMargin: Duration.zero`, and declares no log group of its own (ADR-0040, 5 and 6).
- Drop the #1842 workaround from `alchemy.run.ts`, and `--force` from `pnpm stages up` and the README's deploy once a stage shows that a code change plans an update; update the version references in the README, `Feedback.ts` and `Tokens.ts`.
- Verify: `pnpm check`.

### T3 — Stage and live suite

- Rehearse an existing stage's upgrade: deploy a stage of my own from `origin/main`, forget its five log-group records (`alchemy state rm`), deploy this branch onto it, and check that the five log groups kept their events and 7-day retention and that Lambda's timeouts are unchanged.
- On that stage, exercise the CLI against it: a list, a contact, a campaign draft and a test send to the SES mailbox simulator. Then destroy it.
- Run the gate on the merged result. A dependency change reaches every live group, so the operator is asked about that run first (scope and estimated cost).

## Settled findings

- medium bug: beta.87's default 1 s `timeoutMargin` lengthens every function's Lambda timeout, billed on each timeout — fixed: `timeoutMargin: Duration.zero` in `lambdaBasics` (ADR-0040, 6).
- medium simplification: the `<id>Logs` resources duplicate the function's own `logging.retention` — fixed: `lambdaBasics` sets `logging`, the resources go, and existing stages forget the old records first (ADR-0040, 5 and Consequences).

## Evidence

- From → to per package (T1), and what was adapted (T2).
- The stage name and its CLI run, and the gate's result.

As built, on stage `test-2611171615-3n7m`:

- **Upgrade rehearsal:** deployed from `origin/main` (beta.80), one API call logged, the five `<id>Logs` records forgotten with `alchemy state rm Emailer/<stage>/<id>Logs`, then this branch deployed onto it. All five log groups kept their creation time, the API's earlier log stream and 7-day retention; Lambda's timeouts stayed 60, 300, 30, 30 and 10 seconds.
- **No `--force`:** `alchemy plan` on the deployed stage reported no changes; after one string in `PreviewPage.ts` changed, it planned `Preview` and `Api` as updates.
- **CLI:** created a list and a contact on the mailbox simulator, added the contact, created a Markdown draft, sent a test copy (`accepted` by SES) and opened its preview link (200, the draft's subject and body).
- **Teardown:** `pnpm stages down`; `pnpm stages list` no longer shows the stage, and no log group remains.
