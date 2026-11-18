# Plan: Personalized templates, opt-outs across lists, and safe test sends

- Status: Accepted
- Decision: [ADR-0041](0041-personalized-templates.md)

## Goal

**Done when:** every copy (subject, text, HTML) is a Liquid template rendered per recipient in the send path, validated on save with line and column, carrying `{{ unsubscribe_url }}` and `{{ postal_address }}` in each body part; the appended footer is gone; an opt-out from any list keeps every campaign away; re-importing keeps and merges name and attributes; preview and test send render as a chosen contact; test sends go only to named addresses; `campaigns check` renders every recipient without sending; README and amended ADRs say so; landed on `main` through `pnpm leak-check && pnpm gate`.

**Out of scope:** the cohort list, its import and the real send (the operator's, after landing); a prod deploy; any cross-campaign exclusion (several campaigns to one person are fine).

## Rules for every task

- Worktree `~/worktrees/emailer/task-4068-personalization`, branch `task-4068-personalization`; logs in `~/tmp/t4068-*`.
- Every task states its steady-state cost; none may add any.

## Tasks

### T1 — Templates (`apps/backend/src/sending/Templates.ts`, `liquidjs` in the catalog)

- One HTML engine (output escaped) and one plain engine per language; strict filters; no `include`, `render` or `layout`; `date` refuses a value it cannot read; render, memory and parse limits.
- `compileCopy(copy)` parses each part, refuses unknown variables and missing required tags with part, line and column (`InvalidTemplate`); `renderCopy(compiled, recipient)` renders, then checks the subject is one line within the limit and each body still carries the link and the address.
- Variables: `contact.email`, `contact.name`, `contact.<attribute>` (fields win over a same-named attribute), `unsubscribe_url`, `postal_address`.
- Tested: `Templates.test.ts` (fallbacks, escaping only in HTML, German month names, each refusal with its position, the post-render checks).

### T2 — Contract and storage (`packages/api`, `storage/Campaigns.ts`, `campaigns/Campaigns.ts`)

- `Language` (canonical BCP 47) on create, update, variants, body and variant items; absent means English.
- `InvalidTemplate { part, message, line?, column? }` (422) on create, update and set-variant, validated before any write.
- `SkipReason` gains `unrenderable`.
- Tested: `Campaigns.test.ts`, `Api.test.ts`.

### T3 — Send path (`Dispatching.ts`, `Message.ts`, `Mailer.ts`)

- Copies cached compiled per slice; render after the status read, before the slot and the claim; a failure records a skip `unrenderable` and logs the campaign, copy and message (never the address).
- `compose` adds only the headers; footer code deleted; `Mail.Campaign`/`Mail.Test` carry rendered content.
- Tested: `Dispatching.test.ts`, `Mailer.test.ts`, `Message.test.ts`.

### T4 — Preview, render, test send (`PreviewPage.ts`, `TestSends.ts`, new render route)

- The public preview renders each copy with no contact (fallbacks) and the placeholder link.
- `POST /campaigns/:id/render { as, variant? }` answers the copy that contact gets (rules applied unless a variant is named).
- Test payload `{ to, variant?, as? }` (optional keys, so the CLI passes its flags as they are); the list form and `TestAudienceTooLarge` go. The link is minted for the test address, never the `as` contact.
- CLI: `campaigns preview --as <email>` prints the render (`--open` opens its HTML), `campaigns test --as`; `--list`/`--yes` removed.
- Tested: `PreviewPage.test.ts`, `TestSends.test.ts`, `Api.test.ts`, CLI tests.

### T5 — Opt-outs across lists (`storage/Addresses.ts`, `storage/Subscriptions.ts`, unsubscribe page)

- Address item keeps `optOuts` and gains `rejoined`; one `standingFor(state, listId)` decides for sends, test sends and sign-ups. Opt-out: `ADD optOuts :list REMOVE rejoined`; confirmed double opt-in: `ADD rejoined :list`.
- Unsubscribe page and `AddressRecord` say it covers all emails.
- Tested: `Addresses.test.ts`, `Subscriptions.test.ts`, `UnsubscribePage.test.ts`.

### T6 — Contact data kept (`storage/Membership.ts`, `storage/Contacts.ts`, `CsvContacts.ts`)

- `contactUpdates` reads the existing contacts an import brings a name or attributes for and builds a revision-guarded Put merging them; `joinActions` takes those writes and keeps the condition check for every other existing contact. Sign-ups pass no updates: a subscriber's form never rewrites a contact. `setAttributes` accepts `name`; the CSV allows a `name` column.
- Tested: `Membership.test.ts`, `Contacts.test.ts`, `CsvContacts.test.ts`.

### T7 — `campaigns check` (`campaigns/Checks.ts`, `POST /campaigns/:id/check`, CLI)

- Pages the list (cursor in, cursor out), applies filter and standing, chooses the copy, renders; answers counts plus findings per recipient: failure, fallback (a used `contact.*` value missing or blank), odd value (surrounding whitespace, line break). The CLI pages, groups and prints; one recipient's render is `preview --as`.
- Tested: `Checks.test.ts`, CLI test.

### T8 — Markdown, docs, ADRs

- CLI Markdown keeps Liquid tags intact through `marked`; the layout comment loses the backend footer.
- README: features, writing a template, CLI table, test-send and opt-out rules; "no merge fields" removed. ADR-0041 amends 0004, 0019, 0020, 0027, 0028, 0037.

## Checks

- `pnpm check`; the live suite through `pnpm gate` (reaches all groups: ask the operator first).
- Hand check on an own stage with simulator addresses only: create a list of simulator contacts with names and dates, a templated campaign, a refused save, preview link, `preview --as`, `test --as`, `check`, a real send and its send rows, an opt-out on one list keeping a campaign on another list away.

## Evidence

- Report `~/agent-reports/share/emailer-4068-personalization-build`: what changed, a template example with fallbacks, CLI output from the stage, key files and excerpts.

## Open questions

- None.

## Settled findings

- high bug: the HTML engine's `outputEscape` was the string-only `escapeHtml`, so a missing value or a number (`{{ forloop.index }}`) in the HTML part failed every such recipient as `unrenderable` — fixed: Liquid's own `outputEscape: "escape"`; the post-render check prints the link and the address through each part's own engine; `Templates.test.ts` covers a missing value and numbers in HTML.
- medium security: the dispatcher's `recipient unrenderable` warning logged the Liquid message, which can quote a member's value (an address in an attribute) — fixed: it logs only the campaign, copy and error kind; `campaigns check` names recipient and reason; `Dispatching.test.ts` now fails a render on the member's own address.
- medium bug: a contact without a name let a `name` attribute fill `contact.name` — fixed: `contactValues` overlays both fields, an absent name as blank, before dropping blanks; tested in `Templates.test.ts`.
