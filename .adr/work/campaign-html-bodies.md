# Campaign HTML bodies

> **Status:** Complete
> **ADRs:** None new. Constrained by [0004](../0004-sender-owned-one-click-unsubscribe.md) (every commercial message carries the unsubscribe headers and a visible unsubscribe link plus postal address), [0007](../0007-immutable-recipient-unsubscribe-links.md) (the tokenized unsubscribe URL), [0011](../0011-open-recipient-set-and-paced-dispatch.md) (no body content on `SEND#` rows; `beginRun` hands the dispatcher the campaign content).
> **Updated:** 2026-09-16
> **Lane:** Round 1, lane B of [campaigns-next-lanes](campaigns-next-lanes.md). Ran in parallel with lane A ([campaign-listing](campaign-listing.md)). Worktree `~/worktrees/emailer/campaign-html-bodies`, branch `campaign-html-bodies`, Emailer stage `test-html` (ephemeral). Merged second: `main` (with lane A and [ADR-0014](../0014-campaign-body-item-and-summaries.md)) was merged into this branch under the rebase protocol in [campaign-body-item](campaign-body-item.md), so `html` lives on the `BODY` item beside `text`, not on `META`.

## Outcome and boundaries

- **Problem and target:** campaigns are plain text only. Marketing mail is HTML with a text alternative. Target: a campaign may carry an HTML body beside its required text body; SES sends both parts in one message; the unsubscribe link and the postal address appear in the HTML as they do in the text; a text-only campaign sends exactly what it sends today.
- **In scope:** `CampaignHtml` and the optional `html` field on the create payload and on `Campaign`; persistence on the campaign `META` item; the field through `beginRun`, `CampaignRun`, `OutgoingMessage` into `Mailer.submit`; `Body.Html` in the SES request with the HTML footer; the `--html` CLI flag reading a file; unit tests at every layer; one live send with both parts; README, `.env.example` unchanged; the wiki notes both research lanes found missing.
- **Out of scope:** templates, `{{name}}` or any personalisation, SES stored templates and `SendBulkEmail`, CSS inlining, AMP, tracking pixels, attachments, raw MIME, deriving text from HTML, a file flag for `--text`, listing, scheduling, segmentation, the MCP app.
- **Approach:** the smallest change that makes the SES request carry two parts. The contract gains one optional string with its own byte ceiling, spelled the way the text ceiling is. The stored item gains one optional attribute. The run projection and the outgoing message carry it through. The mailer adds `Body.Html` when the message has HTML and appends a small static footer fragment to it, inserted before the document's closing body tag when there is one. Nothing in the operator's HTML is touched; the footer escapes its own two interpolations. Text stays required because SES recommends both parts for bulk mail and because the text footer is what ADR-0004 already proves. `MailerLive` keeps its shape: the research confirmed it already follows Alchemy's documented layer and binding pattern.

## Key files, evidence, and decisions

| File or source | Why it matters | Decision or plan impact |
|---|---|---|
| `packages/api/src/Schemas.ts:7-9, 114-120, 226-235, 288-294, 296-306` | `maxTextBytes`, `maxRequestBytes`; `CampaignText` (non-empty, UTF-8 byte ceiling via `refine`); `Campaign`; `CreateCampaignPayload`; the `optionalKey` rationale comment | T1: `maxHtmlBytes`, one shared byte-ceiling filter, `CampaignHtml`, `html: optionalKey(CampaignHtml)` on both structs |
| `packages/api/src/Schemas.test.ts:180-218` | The four `CampaignText` cases (whitespace preserved, empty rejected, at-limit accepted, limit measured in bytes) | T1 tests mirror them for `CampaignHtml` |
| `apps/backend/src/Storage/Items.ts:92-107` | `withOptional(item, [[name, value]])` writes an attribute only when the value is defined | T2 uses it for `html` |
| `apps/backend/src/Storage/Campaigns.ts:45-68, 81-91, 185-205, 207-230, 293-338` | `StoredCampaign`; `CampaignRun`; `createCampaign`; `getCampaign` projection; `beginRun` projection | T2 |
| `apps/backend/src/Storage/Campaigns.test.ts:39, 72-121, 129-140` | `multiByteText`, the `meta(fields)` fixture built with `withOptional`, the round-trip test | T2 tests extend the fixture with an optional `html` |
| `apps/backend/src/Mailer.ts:20-27, 111-169` | `OutgoingMessage`; `footerFor`; `makeSubmit` builds `Content.Simple` with `Body.Text` only, plus the two unsubscribe headers and the tags | T3 |
| `apps/backend/src/Mailer.test.ts:93-159, 350-360` | The exact-request assertion over the raw HTTP body; the `footerFor` literal test | T3 tests: the text-only request assertion is unchanged (the fixture gains `html: undefined`); a second exact assertion for both parts |
| `apps/backend/src/Dispatching.ts:94, 224-231` | `beginRun` destructuring; `OutgoingMessage` construction | T4 |
| `apps/backend/src/Dispatching.test.ts:159-175, 95-103` | The `beginRun` fake returns `{ listId, subject, text, cursor, run }` | T4 adds `html` to the fake and asserts it reaches the mailer |
| `apps/cli/src/Commands.ts:343-366, 383-408` | `Flag.fileSchema` precedent for a file-backed flag; `campaignsCreate` with three string flags | T5: `Flag.fileText("html")` with `Flag.withSchema(CampaignHtml)` and `Flag.optional` |
| `apps/cli/src/Commands.test.ts:248-264, 580-617` | The in-memory service's `create` copies payload fields; fixtures construct `Campaign` literals; the file already imports `writeFile`/`rm` for temp files | T5 tests write a temp HTML file and assert the payload |
| `apps/backend/src/Campaigns.ts:28-55` | `create` builds the `Campaign` literal field by field from the payload; a new payload field reaches storage only if this function copies it | T2 carries `html` conditionally |
| `apps/backend/src/Api.test.ts:356-365, 700-704, 865, 906`, `Campaigns.test.ts:51-58` | `Campaign` fixtures without `html` remain valid because the key is optional; the in-memory store copies the campaign verbatim and the handler encodes through `Schemas.Campaign`, so the real-handler create-then-get round trip is a real detector of a dropped field | T2 adds that round trip; other fixtures are untouched |
| `apps/backend/src/Api.integration.test.ts:95-160`, `test/IntegrationSupport.ts:238-250` | Live send to labelled simulator addresses through the typed client; `sendToSimulatorList` refuses non-simulator members | T6 adds one html+text campaign case |
| `README.md:83-84`, `.env.example` | CLI example for `campaigns create`; no new configuration | T5 adds the `--html` example |
| `wiki/aws/ses.md:29, 45, 77-97`, `wiki/effect/schema-and-config.md`, `wiki/effect/http-cli-and-runtime.md` | Gaps found by research (below) | T7 |
| @distilled.cloud/aws 1.0.0-rc.9 `lib/services/sesv2.d.ts:431-506` | `Body { Text?: Content; Html?: Content }`, both independent; `Message.Headers?` unchanged | Both parts typecheck under `AWS.SES.SendEmailRequest` as is |
| Alchemy 2.0.0-beta.77 `node_modules/alchemy/src/AWS/SES/SendEmail.ts:13-84`, `BindingHttp.ts:263-341` | `SendEmail(identity, set)` returns a callable with no runtime context; the Http binding injects `ConfigurationSetName` | `MailerLive` unchanged |
| SES v2 `API_Body`, `API_Message`, `API_MessageHeader`, `send-email-concepts-email-format`, `quotas` | `Html` and `Text` both optional, "an HTML version, a text-only version, or both"; SES assembles the multipart message and the client chooses; at most 15 custom headers, value ≤ 995 chars; 40 MB message ceiling | Text stays required by our contract, not SES's; headers unchanged; 256 KiB HTML is far below every SES limit |
| Gmail bulk-sender guidelines, Yahoo sender best practices, RFC 8058 | One-click headers **and** a clearly visible unsubscribe link in the body; neither requires a plain-text part | Footer goes into both parts; text stays required for our own reasons |
| Effect `4.0.0-rc.112` `Schema.ts:2422-2514, 5116-5139, 5169-5190, 8880` | `optionalKey` is absent-only, `optional` admits `undefined`; `isMaxLength` counts UTF-16 units; `makeFilter` is the documented custom filter, `refine` is for type-guard narrowing | T1 uses `optionalKey`; the byte ceiling is one `makeFilter` shared by text and HTML |
| Effect `4.0.0-rc.112` `unstable/cli/Flag.ts:239-393` | `Flag.fileText(name)` reads the file's content through `FileSystem`; `Flag.withSchema` validates it | T5 |
| DynamoDB item limit 400 KB (`wiki/aws/dynamodb.md:77`) | The `BODY` item holds text and html (ADR-0014) | 64 KiB text + 256 KiB html stays under 400 KB with margin on the body item alone; the ceilings are chosen for that, not for SES |

- **Open gate:** none for implementation. One optional operator step needs the user's word first: a single rendered check by sending one message to the operator mailbox (a domain outside the project's; standing rule is to ask). The plan is complete without it.

## Research

- **Two parts, one request.** The installed `sesv2` types and the SES v2 API reference agree: `Body.Text` and `Body.Html` are independent optionals in `Content.Simple`, SES builds the multipart message itself, and custom `Headers` are unaffected. AWS's own one-click-unsubscribe article shows exactly this shape: `Simple` with `Html` and `Text` plus both `List-Unsubscribe` headers. No raw MIME is needed and none is used.
- **Text stays required.** SES does not require it, and neither Gmail nor Yahoo requires a plain-text part. SES recommends both parts for large audiences, the existing text footer is what ADR-0004 proves compliance with, and deriving text from HTML would be a converter this slice does not want. So HTML is optional and text is required, as the briefing's default says; that is a contract choice, not a platform constraint, and it is recorded here rather than in an ADR because it changes nothing already decided.
- **Footer in both parts.** Gmail and Yahoo require a clearly visible unsubscribe link in the body in addition to the headers, and the AWS article notes the header-driven control may not be shown by the client. The HTML footer is a static fragment: a paragraph with the unsubscribe link and a paragraph with the postal address. It is inserted before the last `</body>` (case-insensitive) when the operator's HTML is a full document, and appended otherwise, so the footer is inside the document and not after `</html>`. The operator's HTML is never modified beyond that insertion.
- **Escaping.** The operator's HTML is the body and is passed through untouched. The footer interpolates two values the operator does not author per message: the postal address, which is free configuration text and may contain `&`, and the unsubscribe URL, which goes into an `href`. One five-line `escapeHtml` covering `& < > " '` is correct for both a text node and a quoted attribute; Effect ships no public helper (its HTML escaper is `@internal`).
- **Byte ceilings.** `CampaignText` already refines on UTF-8 bytes because `Schema.isMaxLength` counts UTF-16 units. The docs' spelling for a custom rule is `Schema.String.check(Schema.makeFilter(...))`; `refine` is meant for type-guard narrowing and narrows nothing here. One shared filter factory `utf8ByteCeiling(maxBytes)` serves both schemas. `maxHtmlBytes` is 256 KiB: an HTML mail is larger than its text, and the `BODY` item that stores both stays under 400 KB (64 KiB + 256 KiB = 327,680 bytes against 409,600); the per-recipient counter writes on `META` never see the body (ADR-0014). The 512 KiB request cap binds first for heavily escaped content, since JSON escaping inflates the body; such a request answers 413 from `oversizedBody` before the schema's 400, which is acceptable.
- **`optionalKey`, not `optional`.** The contract means "absent or a string"; `Schema.optional` would also admit `{ html: undefined }`, a third state the typed client can construct and the store would have to reason about. The repo already documents this choice for `UpdateContactPayload`. Existing `optional` uses elsewhere are left alone.
- **`MailerLive` matches the docs.** Alchemy's layer, binding and runtime pages describe exactly what `Mailer.ts` does: a `Context.Service` contract, `Layer.effect` that yields resources and the `SendEmail` binding, the `SendEmailHttp` layer provided privately, the whole thing provided to the function constructor. No restructuring.
- **CLI file flag.** `Flag.fileText` reads the file through Effect's `FileSystem` and `Flag.withSchema` validates the content, so the CLI refuses an oversized or empty file before any request, the same way `lists import` validates its JSON file.

## Tasks

#### T1 — Contract: `CampaignHtml` and the optional `html` field

- **Change:**
  - `packages/api/src/Schemas.ts`: add `maxHtmlBytes = 256 * 1024`; add a private `utf8ByteCeiling(maxBytes)` that returns `Schema.makeFilter((value: string) => utf8ByteLength(value) <= maxBytes ? undefined : \`Expected at most ${maxBytes} UTF-8 bytes\`)`; rewrite `CampaignText` as `Schema.String.check(Schema.isNonEmpty(), utf8ByteCeiling(maxTextBytes))`; add `CampaignHtml = Schema.String.check(Schema.isNonEmpty(), utf8ByteCeiling(maxHtmlBytes))` and its type.
  - `Campaign` and `CreateCampaignPayload`: add `html: Schema.optionalKey(CampaignHtml)` after `text`.
- **Starts at:** `packages/api/src/Schemas.ts:7-9, 114-120, 226-235, 288-294`
- **Depends on:** none
- **Status:** Verified
- **Evidence:** Parent inspected `packages/api/src/Schemas.ts` (`maxHtmlBytes`, private `utf8ByteCeiling` via `makeFilter`, `CampaignHtml`, `optionalKey` on `Campaign` and `CreateCampaignPayload`) and `Schemas.test.ts` (CampaignHtml four cases; CreateCampaignPayload absent/string/undefined/empty). Parent reran `pnpm exec vitest run --project unit packages/api` (95 passed) and `pnpm typecheck` (green).
- **Tests:** `packages/api/src/Schemas.test.ts` (`unit`) protects the contract: `CampaignHtml` accepts a body at the byte limit, rejects empty and over-limit-in-bytes (mirroring the `CampaignText` cases, which keep passing after the rewrite); `CreateCampaignPayload` decodes without `html`, with a string `html`, and refuses `html: undefined` and `html: ""`.
- **Verify:**
  - Run `pnpm exec vitest run --project unit packages/api`; expect green.
  - Run `pnpm typecheck`; expect green (the field is optional, so no fixture is forced to change).
- **Risk/recovery:** none; the change is additive on the wire.

#### T2 — Domain and storage: carry, persist and project `html`

- **Change:**
  - `apps/backend/src/Campaigns.ts` `create`: the `Campaign` literal built from the payload carries `html` **only when the payload has it** (a conditional spread; never `html: undefined`, which the `optionalKey` response schema would refuse to encode). Without this line the API accepts `html` and stores nothing.
  - `apps/backend/src/Storage/Campaigns.ts` (as merged under ADR-0014): `StoredCampaignBody` gains `html: Schema.optionalKey(attributeOf(Schemas.CampaignHtml))`; `createCampaign` builds the `BODY` put through `withOptional(item, [["html", campaign.html]])`; `getCampaignBody` projects `html` only when the stored body has it, and `getCampaign` inherits it through the summary-plus-body spread. `META`, `CampaignRun` and `beginRun` carry no body content.
- **Starts at:** `apps/backend/src/Campaigns.ts:28-55`, `apps/backend/src/Storage/Campaigns.ts:45-68, 81-91, 185-205, 222-229, 324-337`
- **Depends on:** T1
- **Status:** Verified
- **Evidence:** Parent inspected conditional spread in `Campaigns.create`, `StoredCampaign.html` optionalKey, `withOptional` on create, getCampaign spread, `CampaignRun.html: string | undefined` and `beginRun` fill. Tests cover create-with/without html, storage round-trip, getCampaign, beginRun projection, API create-then-get. `Dispatching.test.ts` beginRun fake gained `html: undefined` (typecheck only). Parent reran T2 unit files: 97 passed.
- **Tests:** `apps/backend/src/Campaigns.test.ts` (`unit`) gains one case, "creates a draft carrying `html`", beside the existing "creates a draft" case, which is extended to assert the campaign has no `html` key. `apps/backend/src/Api.test.ts` (`unit`, real handler over the in-memory `CampaignStore`) protects the whole path: `POST /campaigns` with `html` followed by `GET /campaigns/:id` returns the same `html`. `apps/backend/src/Storage/Campaigns.test.ts` (`unit`) protects: `createCampaign` with `html` writes the `html` string attribute beside `text` and round-trips multi-byte HTML; `createCampaign` without `html` writes no `html` attribute; `getCampaign` on an item with `html` returns it and on an item without it returns a campaign with no `html` key; `beginRun` projects `html` into the run. The `meta(fields)` fixture gains an optional `html`. The reserved-word assertion stays (`html` is not reserved; `text` stays aliased where it already is).
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Storage/Campaigns.test.ts apps/backend/src/Campaigns.test.ts apps/backend/src/Api.test.ts`; expect green.
- **Risk/recovery:** the body item grows; the ceilings in T1 keep it under DynamoDB's 400 KB.

#### T3 — Mailer: `Body.Html` with the HTML footer

- **Change:**
  - `apps/backend/src/Mailer.ts`: `OutgoingMessage` gains `readonly html: string | undefined` (the `CampaignRun.cursor` precedent; an optional key would force a conditional spread in the dispatcher); add a module-private `escapeHtml(value)` (replaces `& < > " '` with entities); add `htmlFooterFor(unsubscribeUrl, postalAddress)` returning a fragment of the shape `<p>Unsubscribe from these emails: <a href="…">…</a></p><p>…postal…</p>` with both interpolations escaped; add `withHtmlFooter(html, footer)` that inserts the fragment before the last case-insensitive `</body>` if present and appends it otherwise (a literal-tag regex over the original string, never a parser; plain append is the fallback if it ever misbehaves); in `makeSubmit`, build `Body` as `{ Text: {...} }` plus `Html: { Data: withHtmlFooter(message.html, htmlFooterFor(...)), Charset: "UTF-8" }` when `message.html` is defined. Headers, tags and everything else stay as they are.
  - `.adr/0004-sender-owned-one-click-unsubscribe.md`: one header line in the existing lifecycle-line position, `- Amended: [campaign-html-bodies](work/campaign-html-bodies.md) — the same footer applies to an optional HTML part; operator HTML is sent verbatim`, so a reader of the record finds where the plain-text-only consequence changed. No new ADR (the `Amended:` form is shared with lane A's lines on ADR-0005 and 0008).
- **Starts at:** `apps/backend/src/Mailer.ts:20-27, 111-145`
- **Depends on:** T1
- **Status:** Verified
- **Evidence:** Parent inspected OutgoingMessage.html, private escapeHtml, exported htmlFooterFor, Body.Html only when defined, ADR-0004 Amended line. Text-only exact-request assertion unchanged. F1: window scan on original string; tests for `İ` and `</BODY>`. Mailer tests 25 passed; `pnpm check` 584 unit tests.
- **Tests:** `apps/backend/src/Mailer.test.ts` (`unit`, raw HTTP body of the SES request over the stubbed transport) protects: the existing exact-request assertion is unchanged for a text-only message (no `Html` key at all; the `message` fixture gains `html: undefined` to satisfy the new required key); a message with `html` produces `Body.Html.Data` equal to the operator's HTML with the footer inserted before `</body>` and `Body.Text.Data` with the text footer, the same two headers and tags; HTML without a `</body>` gets the footer appended; `htmlFooterFor` is asserted as a literal (as `footerFor` is) with a postal address containing all five of `& < > " '`, which pins the escaping without exporting `escapeHtml`.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Mailer.test.ts`; expect green.
- **Risk/recovery:** the text path is protected by the unchanged exact-request test; if it changes at all, the change is wrong.

#### T4 — Dispatcher: carry `html` to the mailer

- **Change:**
  - `apps/backend/src/Dispatching.ts` (as merged under ADR-0014): destructure `html` beside `text` from the per-slice `getCampaignBody` read and set it on the `OutgoingMessage`.
- **Starts at:** `apps/backend/src/Dispatching.ts:94, 224-231`
- **Depends on:** T2, T3
- **Status:** Verified
- **Evidence:** Parent inspected destructure of `html` from `begun.campaign` onto `OutgoingMessage`. Tests: with-html submit and without-html `undefined`. Parent reran Dispatching tests: 25 passed.
- **Tests:** `apps/backend/src/Dispatching.test.ts` (`unit`) protects: the `beginRun` fake returns `html` and the mailer fake receives it on the outgoing message; a run without `html` submits `html: undefined`.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Dispatching.test.ts`; expect green.
- **Risk/recovery:** none.

#### T5 — CLI flag and README

- **Change:**
  - `apps/cli/src/Commands.ts` `campaignsCreate`: add `html: Flag.fileText("html").pipe(Flag.withDescription("Path to a file holding the HTML body; the text body is still required"), Flag.withSchema(Schemas.CampaignHtml), Flag.optional)`; include `html` in the payload only when present (the same `Option.isSome` shaping `contactsCreate` uses for `name`); add an example `campaigns create --list … --subject … --text … --html newsletter.html`.
  - `README.md:83-84`: extend the create example with `--html newsletter.html`.
- **Starts at:** `apps/cli/src/Commands.ts:383-408`, `README.md:83-84`
- **Depends on:** T1
- **Status:** Verified
- **Evidence:** Parent inspected Flag.fileText+withSchema+optional, Option.isSome payload, README `--html newsletter.html`. Tests: file contents as html, omit sends no key, missing file nonzero/no request. Parent reran CLI unit (33 passed) and `pnpm emailer campaigns create --help` documents `--html file`.
- **Tests:** `apps/cli/src/Commands.test.ts` (`unit`, real CLI process against the in-memory service) protects: `campaigns create … --html <tempfile>` sends the file's content as `html` and prints the created campaign with it; omitting `--html` sends no `html` key; a missing file fails with a nonzero exit and no request. The in-memory service's `create` copies `html` through.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/cli`; expect green.
  - Run `pnpm emailer campaigns create --help`; expect `--html` documented as a file path.
- **Risk/recovery:** none.

#### T6 — Live gate on an ephemeral stage

- **Change:**
  - `apps/backend/src/Api.integration.test.ts`: add one case that creates a campaign with `text` and a small full-document `html` (with `<body>`), asserts `html` on the create response, sends it to a two-member simulator list, awaits `completed`, asserts `html` on the campaign `awaitCampaignState` returns, and asserts two `accepted` rows. The two `html` assertions make the case sensitive to the change (a text-only send also completes with two accepted rows); the accepted rows prove SES took the two-part request with the custom headers from the deployed function.
- **Starts at:** `apps/backend/src/Api.integration.test.ts:95-160`
- **Depends on:** T1 to T5
- **Status:** Verified
- **Evidence:** Case in `Api.integration.test.ts` asserts html on create and completed, two accepted rows. Live `test-html` deploy 26 create; suite 22/23 then unsubscribe flake (`queued` vs `sending`) fixed to the existing submitted-state set and re-run 4/4. HTML case 5344ms green. CLI `--html` create/send/get completed with html present, progress accepted:1. Stage destroyed (26 delete); no leftover `test-html` functions/tables/queues. the operator mailbox skipped (needs user go-ahead).
- **Tests:** the case above (`integration`) protects the round trip through the deployed table and the typed client and the deployed request shape. Simulator addresses accept without delivering, so rendering is not observed here; the request body is pinned in T3.
- **Verify:**
  - Run `pnpm check`; expect green.
  - Deploy with the README's command (`README.md:238-239`) at `--stage test-html`: `pnpm exec alchemy deploy --config alchemy.run.ts --stage test-html --env-file .env.test --profile emailer-test --yes --no-input`; point `.env.test` at the stage; run `pnpm test:integration`; expect green. Then the matching `alchemy destroy` (`README.md:265`) for `test-html`.
  - Manual: `campaigns create` with `--html` from a file, `campaigns send`, `campaigns get` until `completed`.
  - Optional, only after the user says so: one send to the operator mailbox and a read with the mailbox tools to confirm `multipart/alternative`, the footer visible in both parts, and both `List-Unsubscribe*` fields in the DKIM `h=` tag.
- **Risk/recovery:** a rejection surfaces as a `rejected` row with `invalid-request` or `message-rejected`; the text-only path is unaffected either way.

#### T7 — Wiki

- **Change:**
  - `wiki/aws/ses.md`: `MessageHeader` limits (15 headers, name ≤ 126, value ≤ 995, name + value ≤ 996, the disallowed set); SES builds the multipart message and the client chooses; SES recommends both parts for large audiences; Gmail and Yahoo require a visible body link but no plain-text part; both parts typecheck under `AWS.SES.SendEmailRequest`. In the same edit, replace the sentence at line 45 that still calls DKIM coverage of the two unsubscribe headers "inference rather than proof": ADR-0004 (line 46) recorded the delivered-message `h=` tag on 2026-09-14.
  - `wiki/effect/schema-and-config.md`: `optional` versus `optionalKey`; `isMaxLength` counts UTF-16 units, so byte ceilings are custom filters via `makeFilter`; `refine` is for narrowing.
  - `wiki/effect/http-cli-and-runtime.md`: router matching (static beats parametric regardless of order, trailing slash ignored, duplicate pattern throws); CLI `Flag.withSchema`, `Flag.optional`, `Flag.fileText`, `Flag.fileSchema`. (Owned here rather than in lane A so the two lanes never edit the same wiki file.)
- **Starts at:** `wiki/aws/ses.md:29-45, 77-97`, `wiki/effect/schema-and-config.md:36`, `wiki/effect/http-cli-and-runtime.md`
- **Depends on:** none
- **Status:** Verified
- **Evidence:** Parent inspected wiki diffs: SES Body.Html/Text independents, MessageHeader limits, DKIM h= proven 2026-09-14; Effect optional vs optionalKey, makeFilter byte ceilings; HttpRouter FindMyWay matching; Flag.fileText/fileSchema. `pnpm format:check` green (child).
- **Tests:** documentation; validated by review against the cited sources.
- **Verify:**
  - Run `pnpm format:check`; expect green (the wiki is excluded from lint, format still runs where configured).
- **Risk/recovery:** none.

## Final acceptance

- **Checks:** `pnpm check` green; `pnpm test:integration` green on `test-html`; the stage destroyed afterwards.
- **End state:** a campaign with `html` sends one SES message with `Text` and `Html` parts, the unsubscribe link and postal address in both, the same headers and tags as today; a campaign without `html` sends the byte-identical request it sends now; `campaigns create --html <file>` works; the wiki carries the SES and Effect facts this lane depended on.
- **Deferrals or blockers:** a file-backed `--text` flag (out of scope; the literal flag stays); the rendered check via the operator mailbox (needs the user's go-ahead); everything the briefing lists as out of scope.

## Handoff

- **Next action:** None for this lane. `main` was merged into this branch after lane A and ADR-0014 landed (rebase below); the PR merges when asked.
- **Reviews:** Plan review [campaign-html-bodies-review](campaign-html-bodies-review.md) round 2 Clear. Implementation review [campaign-html-bodies-implementation-review](campaign-html-bodies-implementation-review.md): round 1 Changes required (F1: `withHtmlFooter` indexed a lowercased copy). Disposition Fix now: scan original 7-char windows; tests for `İ` and `</BODY>`. Round 2 **Clear**.
- **Deviations:** (1) T2/T3/T5 used the plan's `...(value === undefined ? {} : { html })` form; `anti-slop/no-conditional-empty-object-spread` forbids it. Replaced with the repo's `contactOf` pattern: build the required fields, then `value === undefined ? base : { ...base, html: value }`. Same omission semantics; no ADR. (2) T3 `withHtmlFooter` matches `/<\/body>/gi` over the original string instead of `html.toLowerCase().lastIndexOf` (F1; JS `İ`.toLowerCase() expands, so the index must come from the original); the interim 7-char window scan was replaced by the regex at the rebase. (3) Unsubscribe live test now accepts `queued|sending|completed` after enqueue — same race the API suite already documents; not HTML-specific.
- **Resources:** Parent-owned worktree `~/worktrees/emailer/campaign-html-bodies` on branch `campaign-html-bodies` from `main` @ `5f62e7a`, retained until merge is asked. Ephemeral stage `test-html` deployed and destroyed (26/26). `.env.test-html` is local/untracked. Main checkout left untouched.
- **Rebase onto ADR-0014 (2026-09-16):** the merge protocol this document first carried (put `html` on `META` and inside lane A's `campaignOf`) was superseded by the rebase protocol in [campaign-body-item](campaign-body-item.md) before the merge, because `META` is the item every per-recipient settlement writes. Applied as: `html: optionalKey(CampaignHtml)` on `CampaignBody` (and `Campaign` through the spread; `CreateCampaignPayload` keeps its own line); `html` on `StoredCampaignBody`, `withOptional` around the `BODY` put, the conditional copy in `getCampaignBody`; `CampaignRun.html` and `beginRun`'s `html` line deleted; the dispatcher takes `html` from the body read. Tests retargeted from the `META` put and the run projection to the `BODY` put (`putItemRequests[0]`) and the body read; "projects html into the run" deleted. Five files conflicted (`Schemas.ts`, `Storage/Campaigns.ts` and its test, `Dispatching.ts` and its test); everything else merged automatically. In the same pass, `withHtmlFooter` became a case-insensitive literal-tag regex over the original string (original indices by construction, so the `İ` case holds; pinned by the existing `İçerik` and `</BODY>` tests), and the README keeps a text-only `campaigns create` example beside the `--html` one.
