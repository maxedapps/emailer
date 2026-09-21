# Implementation review: shared contract (T1)

Scope: `packages/api/src/{Schemas,Api,Client}.ts` and their tests, plus the T1
scaffold alignment. Target: [implementation plan](first-campaign-slice.md) T1 and
the "Proposed application contract" section, and
[ADR-0001](../0001-resource-owning-effect-services.md).

An independent reviewer with read-only access inspected the files, the installed
Effect `4.0.0-rc.112` source, and a real `HttpApiBuilder` server built from
`EmailerApi`. The reviewer changed nothing. Result: **Changes required**, since
addressed. Backend modules that landed during the review were out of scope.

## Findings and dispositions

### F1 — No 400 was declarable anywhere in the contract

A params or payload decode failure is converted to a defect by
`HttpApiBuilder`, which renders a bare `400` with **no body and no headers**.
The generated client has no `400` entry in its decode map, so a validation
rejection arrived as an opaque `HttpClientError`. The plan requires validation
errors to be 400 and the CLI to produce useful errors.

**Disposition: Fix now.** `HttpApiError.BadRequestNoContent` is declared on every
endpoint. The server's behavior is unchanged; the client now decodes the bare
400 into a typed `BadRequest`. This was the smallest change that makes the
status part of the contract, and it needed no middleware machinery.

The reviewer also measured the accompanying error report: exactly one, at `Info`
severity, never duplicated. No action.

### F2 — `SendStatusUnrecorded` used status 500

500 is outside the plan's status vocabulary (400/401/404/409/413/422/503) and
collides with the framework's own default and unhandled-defect status.

**Disposition: Fix now.** Moved to 503, joining `SendNotAttempted`,
`SendUnconfirmed` and `StorageUnavailable`. The reviewer verified that errors
sharing a status still decode to the correct class, because the client builds a
`_tag`-discriminated union per status.

### F3 — The plan's Bearer challenge on 401 was absent

The plan requires a generic 401 **and** a `WWW-Authenticate: Bearer` challenge.
Nothing in the contract or the framework emits it.

**Disposition: Fix now, in T5.** The challenge is attached at the application
level, where the response is assembled, rather than encoded into the shared
error schema. See T5's evidence.

### F4 — `requestTimeout` documented a property the module did not provide

**Disposition: Fix now.** The doc comment now states that the constant is the
caller's budget and that the client does not apply it. T6 applies it.

### F5 — Test gaps on plan-named boundaries

The reviewer verified each behavior was correct, so these were missing
regression guards rather than defects.

**Disposition: Fix now.** Added: an unknown submission state is rejected; a
draft cannot smuggle terminal fields; positive `unconfirmed` and `rejected`
decodes including the `rate-limited` code; and subject boundaries at the limit,
whitespace-only, and over-limit-after-trimming. `packages/api` went from 35 to
42 tests.

Not acted on: the reviewer noted that the bearer header is asserted on one route
only, having verified it is attached on every route and that the guarantee is
type-level (`requiredForClient` plus a single tag-keyed client middleware). A
per-route assertion would restate the type system.

### F6 — A recorded deviation rested on an inaccurate claim

T1's deviation said `HttpApiBuilder` exposes no request-side `ParseOptions`.
Rejecting excess properties _is_ reachable, through the public `parseOptions`
schema annotation, which survives the builder's union wrap.

**Disposition: Validate — correct the record, keep the behavior.** Stripping
already satisfies the plan's requirement that unknown request properties cannot
become stored or internal fields, and it keeps additive clients working. T1's
deviation now states the real reason.

## Confirmed correct

The reviewer verified rather than assumed: `normalizeEmailAddress` splits on the
only possible `@` and preserves the local part; the submission union makes no
illegal state representable and no legal state unrepresentable; CR/LF injection
vectors are closed, including the trailing-newline anchor case; the 64 KiB limit
is measured in UTF-8 bytes and the 200-character limits in code units; no
secret, AWS exception or internal field appears in any schema; the client issues
each request exactly once and attaches the credential on every route;
authentication wraps decoding, so 401 precedes body decoding; and `packages/api`
imports no backend or Alchemy code.

## Limits

This is a contract review. It did not exercise the backend implementation, the
Lambda runtime, AWS, or deployment.
