# Consent and unsubscribe — plan review

> **Scope:** the draft of [the consent and unsubscribe plan](consent-and-unsubscribe.md) and [ADR-0004](../0004-sender-owned-one-click-unsubscribe.md), reviewed independently against the repository and the installed sources.
> **Date:** 2026-09-11
> **Outcome:** not ready as drafted — two blocking findings. All sixteen findings dispositioned; fifteen accepted, one partially rejected. The plan and the ADR were revised and are now `Ready for implementation`.

The reviewer was asked the standard question: if this plan were implemented exactly as written and every named check passed, could the required outcome still fail? It could, twice, for the same reason.

## Blocking

**B1 — The one-click `POST` had no specified failure path. _Accepted._**
`unsubscribeAddress` goes through `recordOnce`, bounded by the five-second `operationTimeout` and mapping everything non-conditional to `StorageFailure`. The draft specified responses for a valid token, an invalid signature, a missing contact and a repeat request — and for none of them a storage failure — while also mandating an identical response across cases. An implementer following it would render the confirmation unconditionally. A throttled write during a provider's one-click POST would then return 2xx, the provider would never retry, and the recipient would be mailed again. **Every named test would pass**, because they all drive a healthy `Storage` double. Applied, but smaller than the reviewer proposed. The user challenged the finding as niche, and was half right: the scenario is unlikely, and the first revision over-corrected with a bespoke 503 page. The real defect was the draft's own instruction — an uncaught `StorageFailure` already becomes a logged 500 through `safeHttpEffect`, so the correct behaviour is the default and the fix is to **delete** the mandate that suppressed it, not to add a failure page. T5 now says not to catch the write failure, the ADR states the rule as the absence of a mistake rather than a mechanism, and one assertion guards against the suppression returning.

**B2 — The proposed check order reversed a precedence pinned by name. _Accepted._**
The draft ordered the audience checks membership → allowlist → address status, justified as avoiding storage work on a refused send. `Campaigns.test.ts:431` is named "refuses a suppressed recipient before it is refused for not being allowed" and asserts the opposite; the draft did not mention it and claimed the existing cases would be unmodified. On the merits the existing order is also the right one: the allowlist is a temporary development guard the roadmap plans to delete, "the human said no" is permanent, and reporting the temporary reason would have made T9's expected outcome depend on `.env.test` contents. Applied: T3 preserves the existing order, and the `Campaigns.test.ts:414` retargeting the draft needed disappears with it.

## Material

**M1 — The contact-missing case mandated a false success page. _Accepted_**, folded into B1: it is now 404.

**M2 — `Audience.ts` extraction unjustified. _Accepted._** Its stated premise was that `send` "would otherwise gain a sixth" guard, but T2 replaces `isAddressSuppressed` with `addressStatus`, so the count does not grow. The named tests could not have caught a botched extraction either: the one invariant the draft called load-bearing and unprotected — `getList` before `readAudience`, whose `membershipVersion` is the claim fence — would have stayed unprotected, because the extracted function receives the members rather than reading them. Applied: extraction dropped, the two genuinely valuable parts kept (the `operationId: "getContact"` correction with its first test, and the missing 422 assertion at the HTTP boundary), and the reasoning recorded in the plan under the standing refactor licence rather than silently.

**M3 — ADR-0004 rejected the single-Lambda alternative for a reason the plan negates. _Accepted._** The draft claimed the separate function keeps the signing key out of the environment that holds the API token; the API function mints the links, so it holds the key either way. Applied: the clause is deleted and the point stated explicitly; the remaining reasons — an unauthenticated route inside the Bearer-guarded surface, and a stable link hostname — stand on their own.

**M4 — `T7` forbade the configuration key `T9` requires. _Accepted._** Applied: `EMAILER_UNSUBSCRIBE_URL` and `EMAILER_UNSUBSCRIBE_SECRET` are added to `.env.example` as integration-test-only keys, documented the way `EMAILER_TEST_TABLE_NAME` already is.

**M5 — `T9` needed a simulator address nothing allocated. _Accepted._** Reusing `bounce@` or the labelled `complaint+` would have made the expected problem describe-order-dependent, flipping `Api.integration.test.ts:475` from `recipient-suppressed` to `recipient-unsubscribed` depending on which suite ran first. Applied: a distinct `success+unsub<runId>@` address, with the allowlist comment updated in T7.

**M6 — T2's blast radius was miscounted and its verification was wrong. _Accepted._** Four stubs, not five, plus a partial override and `awaitSuppression`, which is a real consumer rather than a stub. More seriously, `scriptedTable` serves replies by call order, so the three `isAddressSuppressed` cases fail by **returning wrong answers** once `addressStatus` issues two reads. Applied: T2 lists the rewrites and no longer claims the existing cases pass unchanged.

**M7 — T6 broke five `Mailer.test.ts` cases it did not mention. _Accepted._** Applied: listed in T6's Change with line references.

**M8 — One load-bearing Alchemy claim is not settled by source. _Accepted._** Whether the bare tag's `onNone` registration makes `unsubscribe.functionUrl` safe to reference at the API's cold start cannot be established from `Platform.ts`. Applied: T7 runs `alchemy plan` as soon as the wiring compiles, the plan flags the claim as unverified, and the fallback is named.

## Minor

**m1 — The link builder had no failure path. _Accepted_**: it now fails the send, because degrading to a message with no unsubscribe mechanism is the outcome the slice exists to prevent.
**m2 — `Random(id)` is an Effect. _Accepted_**: T7 now says to `yield*` it.
**m3 — The `Content.Raw` fallback was under-scoped. _Accepted_**: "changes one function and nothing else" understated hand-composed MIME, RFC 2047 encoded-words for the existing `"Grüße 😀"` subject fixture, and a reshaped test describe. Both the plan and ADR-0004 now say so, which is also why T9 reads `h=` first.
**m4 — The unmatched-path 404 test targets the wrong layer. _Accepted_**: `toHttpEffect` fails with `RouteNotFound`; the 404 is Alchemy's `safeHttpEffect`. Case dropped.
**m5 — "known to nobody" overstated. _Accepted_**: the key is plaintext in two Lambda environments and in state. Phrase removed.
**m6 — Citation drift.** `Random.ts`'s `delete`/`list` sit just outside the cited range; the `awaitSuppression` citation described it as a stub. _Accepted_, both corrected.

## Partially rejected

**R1 — "The identical-response requirement is ceremony; delete it."** The reviewer's analysis is right that it defends against nothing: reaching the distinction between an unknown contact and a fresh opt-out requires a valid HMAC, which means being the recipient. But deleting it _as ceremony_ would have left the plan silent on what those paths do, which is how B1 and M1 arose in the first place. The requirement is removed and **replaced** by its opposite — a success page implies a durable write — rather than dropped.

## Verified without findings

The reviewer independently re-checked ten of the plan's citations against the installed sources and found none wrong or overstated: the inline-versus-bare-tag `Function` declaration behaviour, the plan-time `Config` capture, `HttpRouter.add` / `toHttpEffect` / `HttpServerResponse.html`, the 415 path, `RouteNotFound` handling, `rawPath` passing through verbatim, the absence of HMAC in `effect/Crypto`, the `sesv2` `Headers` field, and the `oxlint-disable` convention. Also confirmed sound and left alone: address-keying rather than contact-keying, which correctly defeats the duplicate-contact hole; `suppressionAddress` lowercasing the whole address on both write and read; `Campaigns.send` being the only send path; the token construction, whose real cost is irreversibility rather than forgery; and `apps/cli` and `packages/api/src/Client.ts` needing no edit for a new `AudienceProblem` member.
