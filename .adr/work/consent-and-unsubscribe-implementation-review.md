# Consent and unsubscribe — implementation review

> **Scope:** the whole `consent-and-unsubscribe` branch against `main`, reviewed at `6397bf8` by an independent reviewer that saw the plan, ADR-0001/0003/0004 and `AGENTS.md` but none of the implementer's reasoning.
> **Verdict:** no blocker, and no material defect in the security-relevant path. One confirmed defect (docs-only) and two test-quality findings.
> **Checks the reviewer ran:** `vitest run --project unit` (229 passed, 12 files), `pnpm typecheck`, `pnpm lint --type-aware --deny-warnings`, `pnpm format:check`, `pnpm check:imports` — all clean. No deploy, no integration run, no files modified.

## Findings and dispositions

| #   | Finding                                                                                                                          | Severity | Disposition  |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------ |
| 1   | Plan header still labelled ADR-0004 `(Proposed)` after T8 moved it to `Accepted`                                                 | trivial  | **Fixed**    |
| 2   | The footer's literal text was unpinned: the "exact content" case built its expected body with `footerFor` itself                 | low      | **Fixed**    |
| 3   | `addressStatus`'s failure case scripted one reply, so a defect in the **suppression** read could report `"mailable"`             | low      | **Fixed**    |
| 4   | The endpoint logged nothing, so a refused token on the only unauthenticated surface left no trace                                | low      | **Fixed**    |
| 5   | `GET` does not verify the token, so a link whose signing key has rotated shows a confirm button that cannot work                 | low      | **Rejected** |
| 6   | The public function's IAM carries `StorageLive`'s four grants where the handler uses two                                         | low      | **Rejected** |
| 7   | Two cosmetic duplications (`Api.integration.test.ts:41` re-assembles the link; `Api.test.ts:31` takes two positional parameters) | trivial  | **Rejected** |

### 2 — the footer's literal text

`Mailer.test.ts`'s "exact content" `toStrictEqual` built the expected body as `` `${text}${footerFor(url, postal)}` ``, and the separate `footerFor` describe asserted only that the link and the postal address appeared somewhere in the result. The implementer's argument was that the two cases compose. They do not compose tightly enough: **swapping the two interpolations inside `footerFor`** — so the footer reads `Unsubscribe from these emails: <postal address>` followed by a bare URL — satisfies both `toContain`s, satisfies the leading-`\n\n` check, and makes the exact-content case compare the mutation against itself. Every delivered message would then label the postal address as the unsubscribe link, and the suite would be green. Deleting the label entirely survives identically.

Fixed by asserting the literal footer string once. **Validated** by applying the reviewer's exact mutation and confirming the test fails, then reverting.

The same shape at `Campaigns.test.ts` (expected link built with `mintToken`) was judged correct as-is by the reviewer: it genuinely pins the contact id and base-URL wiring, and the digest's key-dependence is covered by the alien-secret forgery in `Unsubscribe.test.ts`.

### 3 — `addressStatus`'s second read

`scriptedTable` serves replies by call order, and the failure case scripted `getItem: [fail(serverError)]` — which fails the **unsubscribe** read, the first one. A defect confined to the suppression read (an `Effect.catchAll(() => Effect.succeed({}))` on it) would report `"mailable"` for a suppressed address and pass. Since "a failed read never reports mailable" is the safety property this operation exists to hold, a case that only exercises the first read is not enough.

Fixed with an `it.each` over both reads. **Validated** by applying that mutation and confirming three `addressStatus` cases fail, then reverting.

### 5 — verifying the token on `GET` (rejected, but real)

Not a deviation: ADR-0004 deliberately scoped `GET` to rendering a confirmation and changing nothing, and the implementation does exactly that. The consequence the reviewer surfaced is nonetheless real — the signing key rotates at **every** ephemeral-stage teardown, so stale links are guaranteed rather than hypothetical, and a recipient holding one sees "Confirm that you no longer want to receive these emails", clicks, and gets "Link not valid". Verifying on `GET` needs the signing key and no storage, so it adds no dependency and does not conflict with "`GET` must not act".

Rejected from this slice because it is outside the plan's scope, and recorded as optional in the work document's handoff rather than silently dropped.

### 6 — IAM breadth (rejected)

`StorageLive` grants the table's operations to every host that binds it; the unsubscribe handler uses `GetItem` and `PutItem`. This is the pre-existing pattern `Feedback.ts` shares, the unused grants are not reachable through the handler, and narrowing it means changing how `StorageLive` binds for all three functions. Out of scope for this slice; worth revisiting as defence-in-depth on the one public function.

Confirmed against the deployment on 2026-09-12: the `Emailer-Unsubscribe-test-…` role carried `dynamodb:GetItem`, `PutItem`, `Query`, `UpdateItem`, `DeleteItem` and `ConditionCheckItem`, plus `AWSLambdaBasicExecutionRole`, and **no SES action**.

This finding concerns the function's **execution role** only. It is unrelated to the **resource policy**, which was separately checked and is correctly scoped: the public `lambda:InvokeFunction` statement is conditioned on `Bool lambda:InvokedViaFunctionUrl = true`, so it admits only invocations arriving through the Function URL and not direct `lambda:Invoke` API calls.

## Verified correct

Recorded because the absence of a finding here is informative.

- **Token minting and verification.** HMAC-SHA256 over the contact id alone — a single field, so no ambiguous concatenation. One separator; `parts.length !== 2` rejects `"a.b.c"`, the empty string, a bare id and a separator-stripped forgery. Comparison through `Auth.tokensMatch` (length check then branch-free XOR). `EntityId` is `isUUID(4)`, 36 characters with no `.`, so a real token can never mis-parse. **No way was found to obtain a valid verification for a token you did not sign.** The `".<64hex>"` case parses to an empty contact id but requires `HMAC(key, "")`, which no attacker can produce — and it 404s on the contact lookup anyway. All five forgery cases are genuine, each guarded by an assertion that the presented token differs from the valid one, which is what keeps the round-trip test non-circular.
- **`GET` cannot mutate.** The route is `Effect.succeed(confirmation)` with no `Storage` reference.
- **No unescaped input reaches HTML.** `page()` is called with three literal pairs only; the confirm form has no `action`, so the token is never interpolated. Path params go through FindMyWay's `safeDecodeURIComponent`, so `/unsubscribe/%` cannot throw a `URIError` into a 500.
- **No 2xx that lies.** Every `POST` exit was enumerated: forged token → 404 no write; contact `None` → 404 no write; storage or config failure → defect → empty logged 500; success → the write completes before the page is returned. `recordOnce` swallows only `ConditionalCheckFailedException`, so the repeat 200 is backed by an existing item. The inverse (written but non-2xx) is reachable only through the 5 s timeout racing a completed write — the safe direction, and the retry makes the next `POST` a 200.
- **`Effect.orDie`'s placement is load-bearing and correct.** `RouteNotFound` is raised by the router outside the route handler, and `safeHttpEffect`'s `causeResponse` preserves Respondable failures as 404 while mapping defects to an empty 500 with the cause logged. So the router's 404 survives and the handler's own failures do not become a page. 500 is the right answer for a provider, and AWS calls already retry transient failures internally — the reviewer explicitly recommended **against** adding retry machinery.
- **`maxParamLength: 256` is applied and sufficient.** `RouterConfig` is a `Context.Reference` read inside `HttpRouter.make`, and `toHttpEffect` builds its internal layer in the ambient context, so providing it on the outer effect does reach it. Pinned empirically too: the 200 assertion for a 101-character token would fail without the override.
- **The signing key's round trip arrives intact**, traced independently to the same conclusion this session reached: props `env` is merged raw with no `packEnvValue`, Lambda's `EnvironmentVariables` values are `SensitiveString` whose encoder unwraps a `Redacted`, and the handler reads the plaintext back through the interceptor path `EMAILER_CONFIGURATION_SET` already takes in production.
- **T7's open cold-start question is closed from source, negatively.** `apiProps` does re-run at init, and inside the API Lambda the bare tag takes the `onNone` branch registering `resource("Unsubscribe", undefined)` — but that resource is a Proxy whose `get` trap returns a lazy `PropExpr` for any unknown key, so `unsubscribe.functionUrl` and `secret.text` cannot throw on undefined props, and the props `env` is never read at runtime because the real variables were bound at deploy. Registration is idempotent, so the single `Random` declaration yields one resource and one minted value across both functions. This was the plan's highest live-only risk and it is no longer one.
- **Nothing in the previous slice broke.** `addressStatus` replaced `isAddressSuppressed` at every call site with no stale references; read order is unsubscribe-then-suppression with an early return; a failed read can never yield `"mailable"`; the scripted arrays line up with the read order in every case and the precedence test would genuinely fail on a reversed implementation. The check order, the claim/finalize path, the `membershipVersion` fence and bounce/complaint suppression are unmodified, and the link is built before `claimCampaign` so a config defect cannot strand a claimed campaign.
- **Contract and SES shape.** The fifth `AudienceProblem` literal and the moved negative case; `Headers` on `Simple` at the level SESv2 declares, angle-bracketed `List-Unsubscribe` and exactly the RFC's `List-Unsubscribe-Post`, no `ListManagementOptions`; no payload declared and the body never read; `oversizedBody` not copied; `EMAILER_POSTAL_ADDRESS` failing closed on whitespace. `.env.test` is git-ignored and no secret is tracked.
- **Complexity.** Nothing material. The two-declaration-form asymmetry is forced by the cross-resource reference, `Unsubscribe.ts` pulls no handler into the API bundle, and the dropped `Audience.ts` extraction was the right call.

## What this review does not cover

The DKIM `h=` read remains the slice's one unverified external fact, and the `Content.Raw` MIME fallback behind it is real work. A clean implementation review is not a substitute for T9.
