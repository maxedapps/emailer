# ADR-0022: The API contract rejects fields it does not declare

- Status: Accepted
- Date: 2026-09-23
- Accepted: 2026-09-23
- Authority: On 2026-09-23 a whole-codebase review found that a mistyped request field is dropped silently. The user approved rejecting unknown fields as part of [the cleanup plan](work/codebase-cleanup.md).

## Context

Effect Schema drops object keys a schema does not declare, unless told otherwise. For this API that turned typos into wrong results instead of errors:

- **Campaign create:** `"fitler": {...}` creates a campaign with no filter. That campaign then goes to the whole list.
- **Import entries:** in an import file, `"attributs": {...}` creates the contact without attributes. Re-importing the corrected file changes nothing, because an import only checks existing contacts and never updates them, so filtered campaigns keep missing that contact.

The CLI made the import case worse. It decodes the file locally before sending it, and that decode also dropped the key, so the server never saw the typo.

Since Effect RC113, schema-level `parseOptions` annotations are ignored. RC116 added `HttpApi.ParseOptions`, an annotation on an API, group or endpoint that sets the options for:

- params, query and payload decoding;
- response encoding;
- the generated client's decoding.

## Decision

- **The contract rejects undeclared keys everywhere.** `EmailerApi` is to carry `HttpApi.ParseOptions` with `onExcessProperty: "error"`, once and at API level:
  - an unknown field in a payload or query answers `400`;
  - a handler that returns an undeclared field fails to encode rather than leak it;
  - the CLI's client rejects an undeclared field in a response.

  The CLI and the service ship from the same repository, and every endpoint has a round-trip test, so a mismatch fails the unit suite before it reaches an operator.
- **The CLI decodes files it sends just as strictly.** `lists import --file` decodes with `{ onExcessProperty: "error" }` and rejects an unknown key locally, naming its path, before any request is made.
- **The API-level annotation waits for the next Effect RC.**
  - **The bug:** in RC117, `"error"` breaks the encoding of every `Schema.TaggedError`. The check reads own keys with `Reflect.ownKeys`, which includes an error's non-enumerable `stack`, so each declared error becomes a `500`.
  - **The fix:** [effect#8423](https://github.com/Effect-TS/effect/pull/8423) makes the check ignore non-enumerable properties. It merged on 2026-09-23, after RC117.
  - **Until then:** the CLI's strict decode covers the realistic case, a hand-written import file. The annotation is a one-line change, with a `400` test per unknown field, as part of the upgrade to the first RC that contains the fix.

## Alternatives considered

1. **Per-struct annotations.** These worked on RC112 and are silently ignored from RC113 on.
2. **Patching Effect with #8423 now.** This would be the repository's first patched dependency ([ADR-0018](0018-optional-dns-management.md) rejected one for the same reason), and it would need rechecking on every upgrade, for a fix the next RC ships.
3. **Endpoint-level annotations on the mutating endpoints only.** These leave query strings and responses lenient, need an annotation on every new endpoint, and change nothing about the encoding trade-off.
4. **Validating each payload by hand in the handlers.** This duplicates the schema and is exactly the kind of check the contract should own.

## Consequences

- **Typos fail loudly.**
  - The CLI names the offending key now.
  - Direct API callers get a `400` with an empty body once the annotation lands. Until then, a raw caller's unknown field is still dropped; the CLI is the only caller today.
- **Contract additions ship together.** A new response field needs the CLI and the service to update in the same change, which one repository already enforces.
- **Header schemas are a caution.** A header schema receives every request header, so adding one under this annotation would reject ordinary headers. The API declares none; the bearer token comes through security middleware.

## Confirmation

- **Now:** `Commands.test.ts` proves that a misspelled import-entry key fails in the CLI, naming its path, with no request sent.
- **After the upgrade:** the `Api.test.ts` cases for an unknown payload key and an unknown query parameter answer `400`, and every existing round trip still passes.

## References

- [Effect `HttpApi.ParseOptions` (RC117)](https://unpkg.com/effect@4.0.0-rc.117/src/unstable/httpapi/HttpApi.ts), [effect#8423](https://github.com/Effect-TS/effect/pull/8423)
- [wiki: HTTP, CLI and runtime](../wiki/effect/http-cli-and-runtime.md)
- [Codebase cleanup plan](work/codebase-cleanup.md)
