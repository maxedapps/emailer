# Code review: campaign HTML bodies implementation

## Review constraints

| Axis | Selection |
|---|---|
| Target | worktree `/home/operator/worktrees/emailer/campaign-html-bodies`, branch `campaign-html-bodies`; uncommitted diff vs HEAD `5f62e7a` (also `main`) |
| Baseline | plan-backed: `.adr/work/campaign-html-bodies.md`; accepted ADRs 0004 (Amended line in-scope), 0007, 0011 |
| Scope | Round 1: full plan T1–T7, including the T6 integration test **case**; live `test-html` deploy not run. Round 2: F1 only (`withHtmlFooter` + the two new Mailer cases and existing insert/append) |
| Invocation | standalone (round 1); embedded follow-up (round 2) |
| Output | `.adr/work/campaign-html-bodies-implementation-review.md` |
| Dimensions | correctness, security/data, tests (plan-backed matrix required). Round 2: F1 correctness + tests + fix-caused Mailer boundary |
| Validation/tools | Round 1: source inspection of the worktree diff; one local Node repro of `withHtmlFooter`; `pnpm check` / live integration **not** re-run. Round 2: source of `withHtmlFooter`; Node copy of production loop vs old index; Mailer unit file (25 passed) |
| Writes/artifacts | this report only |

Out of scope (per plan and task): templates, personalisation, SES stored templates, CSS inlining, AMP, tracking pixels, attachments, raw MIME, deriving text from HTML, `--text` as a file flag, listing, scheduling, segmentation, MCP, the operator mailbox rendered check.

## Summary

T1–T5 and T7 match the plan: optional `CampaignHtml`, persistence/projection through `META` / `beginRun` / `OutgoingMessage`, `Body.Html` only when defined, CLI `--html` file flag, wiki/ADR-0004 notes. The recorded `contactOf` deviation is the same omission semantics as the forbidden empty-object spread.

One admitted defect in round 1: `withHtmlFooter` took `lastIndexOf("</body>")` on a **lowercased copy** and sliced the **original**. JavaScript `toLowerCase()` expands U+0130 (`İ`) to two code units, so a full document containing that character before `</body>` had the footer inserted **into** the closing tag. Round 2 replaces that with a length-stable reverse window scan on the original string. The T6 case is present as specified; the live gate has not been run.

**Closure: Clear** (F1 resolved).

## Related decomplex review

- **Report:** none
- **Owner disposition summary:** n/a

## Coverage

### Inspected

- Round 2 (F1 only): `apps/backend/src/Mailer.ts` `withHtmlFooter` / `bodyClose`; `apps/backend/src/Mailer.test.ts` insert, append, `</BODY>`, `İçerik`; independent Node copy of the production loop vs the round-1 `toLowerCase`+`lastIndexOf` sequence; `pnpm exec vitest run --project unit apps/backend/src/Mailer.test.ts` (25 passed)
- `.adr/work/campaign-html-bodies.md` (full)
- `.adr/0004-sender-owned-one-click-unsubscribe.md` (Amended line and footer/header consequences)
- `.adr/0007-immutable-recipient-unsubscribe-links.md`
- `.adr/0011-open-recipient-set-and-paced-dispatch.md` (no body on `SEND#`; `beginRun` hands content to the dispatcher)
- `git diff HEAD` for all 19 modified files
- `packages/api/src/Schemas.ts`, `Schemas.test.ts`
- `apps/backend/src/Campaigns.ts`, `Campaigns.test.ts`
- `apps/backend/src/Storage/Campaigns.ts`, `Campaigns.test.ts`, `Items.ts` (`withOptional`, `attributeOf`)
- `apps/backend/src/Mailer.ts`, `Mailer.test.ts`
- `apps/backend/src/Dispatching.ts`, `Dispatching.test.ts`
- `apps/backend/src/Api.test.ts` (in-memory store + create-then-get)
- `apps/backend/src/Api.integration.test.ts` (T6 case)
- `apps/cli/src/Commands.ts`, `Commands.test.ts`
- `README.md`, `wiki/aws/ses.md`, `wiki/effect/schema-and-config.md`, `wiki/effect/http-cli-and-runtime.md`
- Effect RC112 `Schema.makeFilter` / `FilterOutput` and `Flag.fileText` (installed `node_modules`)
- `contactOf` in `apps/backend/src/Storage/Contacts.ts` (deviation pattern)

### Skipped or partial

- Full `pnpm check` not re-run (parent reported green: format, lint, typecheck, 582 unit tests, import smoke). Round 2 re-ran only the Mailer unit file. Treated remaining gates as a claim, not proof.
- `pnpm test:integration` / `alchemy deploy --stage test-html` not run (stated).
- `pnpm emailer campaigns create --help` not run; `--html` is present on the command definition and in README.
- the operator mailbox rendered check (out of scope).
- Lane A merge conflicts (future; not in this tree).

### Required boundaries

- Wire contract: `CreateCampaignPayload` / `Campaign` `optionalKey(CampaignHtml)`
- Persistence: `META` `html` attribute via `withOptional`; projections that omit the key when absent
- Dispatch: `CampaignRun.html: string | undefined` from `beginRun` onto `OutgoingMessage` (not onto `SEND#` rows)
- SES: `Content.Simple.Body.Html` only when defined; text path unchanged; HTML footer + headers
- CLI: `Flag.fileText("html")` + `CampaignHtml` + omit key when absent
- Live: T6 case written; deployed two-part request **not** observed

## Validation

- **Run (round 1):** local Node snippet exercising the production `toLowerCase` + `lastIndexOf` + `slice` sequence on `"<html><body>İçerik</body></html>"`. Result: index 19 vs original `</body>` at 18; output `<html><body>İçerik<<p>FOOTER</p>/body></html>`.
- **Run (round 2):** same production loop as `Mailer.ts:131-142` on that document inserts before the original `</body>` (`…İçerik<p>FOOTER</p></body>…`); uppercase `</BODY>`, fragment append, last-of-two tags, mixed `</BoDy>`, and `İ` + `</BODY>` also insert/append correctly. `pnpm exec vitest run --project unit apps/backend/src/Mailer.test.ts`: 25 passed.
- **Skipped/unavailable:** full `pnpm check`; live `pnpm test:integration` on `test-html`; manual `campaigns create --html` / send / get; the operator mailbox. Parent lint/typecheck green treated as a claim.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** Strong enough to implement against. In-scope outcome, non-goals, ceilings, `optionalKey`, footer heuristic, and layer tests are explicit. Two limits, neither an authority conflict: (a) T6’s prose that accepted `SEND#` rows “prove SES took the two-part request” is false — a text-only send also accepts; the plan separately (and correctly) pins the request body in T3 and rendering in optional the operator mailbox. (b) The three-line `</body>` heuristic never names the JS `toLowerCase()` length-change footgun; “append if it misbehaves” is the accepted fallback for a **failed** search, not for a **wrong index**. Completeness, consistency, and testability are otherwise fine. Confidence high on the written plan; T6 live evidence is absent by construction of this review.

2. **Implementation compliance:** T1, T2, T4, T5, T7, ADR-0004 Amended, ADR-0011 `SEND#` isolation, and the T6 **case** match the plan. One **Approved deviation**: empty-object spread replaced by the repo `contactOf` pattern (same absent-vs-present semantics). T3 `Body.Html` gating, headers/tags, `htmlFooterFor` escaping, and the unchanged text-only exact request match. Round 1 **Incorrect** `withHtmlFooter` (F1) is **Complete** after the length-stable window scan. T6 live verify and final-acceptance integration run remain **Missing** (out of this F1 follow-up).

3. **Implementation quality beyond the baseline:** Lean, same shapes as existing text / `contactOf` / `withOptional` / `Flag.fileText` paths. No html on `SEND#` rows; updates `SET` named attributes and leave `html` in place; operator HTML is passed through (plan + ADR-0004 Amended). F1 was the only admitted generic correctness issue the baseline did not already own as an accepted heuristic failure; the window scan does not add a parser/regex and does not change append-on-miss. No security finding: operator HTML is trusted sender content; footer interpolations (config postal address, minted unsubscribe URL) are entity-escaped with `&` first.

4. **Test and validation quality:** Unit oracles are discriminating for the plan’s named cases: `optionalKey` refuses `html: undefined`, storage omits the attribute, API create-then-get, text-only SES body has no `Html` key, HTML request inserts before lowercase `</body>` or appends, `htmlFooterFor` literal pins all five special characters, dispatcher passes `html` / `undefined`, CLI reads the file and issues no request on a missing file. Round 2 adds a `</BODY>` exact-request case and the round-1 `İçerik` counterexample as a full SES `Html.Data` literal, so F1 cannot regress green. T6 cannot see `Body.Html` (plan-accepted; T3 is the request oracle). Live gate not executed — T6 persistence-through-send is unproven at runtime. Do not treat work-document Status: Verified as proof.

## Plan compliance matrix

| Authority item / implied requirement | Expected evidence | Implementation evidence | Validation / test evidence | Status |
|---|---|---|---|---|
| T1 `maxHtmlBytes = 256 KiB`, private `utf8ByteCeiling` via `makeFilter`, `CampaignHtml` non-empty + byte ceiling; rewrite `CampaignText` to the shared filter | Shared filter; both schemas | `packages/api/src/Schemas.ts:8`, `:33-36`, `:121-128`. Installed `FilterOutput` treats `undefined` as success | `Schemas.test.ts` CampaignHtml four cases (whitespace, empty, at-limit, UTF-8 bytes); CampaignText cases retained | Complete |
| T1 `html: optionalKey(CampaignHtml)` on `Campaign` and `CreateCampaignPayload` | Absent-or-string only; refuse `undefined` / empty | `Schemas.ts:233-241`, `:296-301` | `CreateCampaignPayload` decodes without html, with string html, refuses `html: undefined` and `html: ""` | Complete |
| T2 `Campaigns.create` copies `html` only when present (never `html: undefined`) | Conditional object, same object stored and returned | `Campaigns.ts:43-57` (`payload.html === undefined ? campaign : { ...campaign, html }`) | `Campaigns.test.ts` draft has no `html` key; “creates a draft carrying html”; `Api.test.ts` create-then-get | Complete |
| T2 `StoredCampaign.html` optionalKey; `createCampaign` via `withOptional`; get projection omits key when absent | Attribute written iff defined; domain object omits key | `Storage/Campaigns.ts:54`, `:192-217`, `:235-246`; `Items.ts:94-107` | Storage tests: with-html PutItem `S` + round-trip; without-html `not.toHaveProperty("html")` on item and domain; get from `meta({ html })` | Complete |
| T2 `CampaignRun.html: string \| undefined`; `beginRun` fills from stored item | Required key on the run, value may be undefined | `Storage/Campaigns.ts:89`, `:343-357` (`html: stored.html`) | `beginRun` “projects html into the run”; existing run assertions now include `html: undefined` | Complete |
| T2 DynamoDB 400 KB still holds at ceilings | 64 KiB + 256 KiB + META overhead &lt; 409,600 | Ceilings unchanged from plan (327,680 body bytes; ~80 KiB margin for names/counters/subject) | None beyond arithmetic; no live item-size probe | Complete |
| T3 `OutgoingMessage.html: string \| undefined`; `Body.Html` only when defined; text-only request unchanged | No `Html` key on text-only; both parts when defined | `Mailer.ts:20-28`, `:144-160` | Exact-request test still has `Body: { Text: ... }` only (`Mailer.test.ts:138-161`); HTML exact request adds `Html` (`:165-209`) | Complete |
| T3 `escapeHtml` private; `htmlFooterFor` fragment with both interpolations escaped | `& < > " '` → entities; URL in `href` and text | `Mailer.ts:115-127`; `escapeHtml` not exported | `htmlFooterFor` literal with postal `Acme & Co <"O'Reilly">` (`Mailer.test.ts:453-460`) | Complete |
| T3 `withHtmlFooter`: insert before last case-insensitive `</body>`, else append; operator HTML otherwise untouched | Footer inside the document, not after `</html>`, for a real `</body>`/`</BODY>` | `Mailer.ts:129-142`: reverse scan of original windows of `bodyClose.length` (7); `slice(i, i+7).toLowerCase() === "</body>"`; insert at that original `i`, else append | Lowercase insert, no-tag append, uppercase `</BODY>` (`Mailer.test.ts:211-250`), `İçerik` (`:252-291`). Round-2 Node: old index 19 mis-inserts; new inserts at original tag. Last-of-two and mixed `</BoDy>` also hold | Complete |
| T3 ADR-0004 Amended line | Lifecycle header points at this work | `.adr/0004-sender-owned-one-click-unsubscribe.md:8` exact plan wording | Documentation | Complete |
| T4 Dispatcher destructures `html` onto `OutgoingMessage` | Run html reaches `Mailer.submit` | `Dispatching.ts:96`, `:227-235` | Dispatching tests: with-html submit; without-html `undefined` | Complete |
| ADR-0011: no campaign body on `SEND#`; content from `beginRun` | Claim PutItem without text/html | `Storage/Campaigns.ts:380-390` (sendId, contactId, recipient, state, startedAt only) | Existing claim tests; no new html on send rows in the diff | Complete |
| T5 `Flag.fileText("html")` + `withSchema(CampaignHtml)` + `optional`; payload includes `html` iff `Option.isSome`; README example | File contents as body; omit key; missing file fails closed | `Commands.ts:398-427`; `README.md:83-84` | CLI: tempfile contents on created campaign; existing create without `--html` has no html key; missing file nonzero and `authorizations.length === 0`. Installed `Primitive.fileText` reads via `readFileString`, does not trim | Complete |
| T5 `.env.example` unchanged | No new config | `git status` / diffstat: `.env.example` not modified | Diff | Complete |
| T6 integration **case**: create text+html full document, assert html on create and on completed campaign, two accepted rows | Case in `Api.integration.test.ts` | `Api.integration.test.ts:211-250`; uses `sendToSimulatorList` / `awaitCampaignState` / `sendRows` | Case is written and type-sensitive to dropped `html` on GET. **Not executed** against a deployed stage | Complete (case) / Missing (live run) |
| T6 live verify: `pnpm check`; deploy `test-html`; `pnpm test:integration`; destroy; optional the operator mailbox | Runtime evidence | None in this tree | Parent: `pnpm check` claimed green, not re-run. Live suite not run. the operator mailbox out of scope | Missing |
| T7 wiki SES: independent Body parts, MessageHeader limits, DKIM `h=` proven 2026-09-14, Gmail/Yahoo visible body link | Edited `wiki/aws/ses.md` | `wiki/aws/ses.md:37,45,47,101-103` | Review against cited plan sources; `pnpm format:check` not re-run | Complete |
| T7 wiki Effect: `optional` vs `optionalKey`; `isMaxLength` UTF-16; `makeFilter`; `refine` narrowing | Edited `wiki/effect/schema-and-config.md` | `:38-40`, `:86` | Matches installed `Schema.ts` `FilterOutput` (`undefined`/`true` success) | Complete |
| T7 wiki HTTP/CLI: FindMyWay matching; `Flag.withSchema` / `optional` / `fileText` / `fileSchema` | Edited `wiki/effect/http-cli-and-runtime.md` | `:46`, `:58` | Matches installed `Flag.ts` / `Primitive.fileText` | Complete |
| End state: text-only send is the byte-identical SES request as today | Unchanged exact-request assertion | `Mailer.ts` builds `{ Text }` only when `html === undefined`; fixture `html: undefined` | `Mailer.test.ts:118-163` `toStrictEqual` full request | Complete |
| End state: html campaign sends Text+Html with footers and the same headers/tags | Mailer exact HTML request + dispatcher wiring | `Mailer.ts:151-160`, `htmlFooterFor`, `footerFor`; headers/tags unchanged | Unit exact request. Live two-part MIME **not** observed (T6 accepted rows do not prove Html) | Partial |
| Deviation: `contactOf` instead of `...(x === undefined ? {} : { html })` | Same omission semantics; lint-legal | `Campaigns.create`, `getCampaign`, CLI in-memory create, Commands payload `Option.isSome` | Work document Deviations; user instruction not to re-litigate unless the replacement is wrong. Replacement omits the key iff undefined | Approved deviation |

### Approvals and conflicts

- **Approved deviation:** T2/T3/T5 empty-object spread → `contactOf` / ternary copy. Source: work document Deviations + this task’s explicit instruction. Rationale: `anti-slop/no-conditional-empty-object-spread`. Consequence: none on the wire (key absent vs present string).
- **Authority conflict:** none. T6’s “accepted rows prove two-part request” overclaim is a baseline wording defect, not a conflict with T3.

## Follow-up closure

- **Round and material delta:** Round 2 vs round 1 F1 only. Owner accepted the prescribed fix: do not index a full-string `toLowerCase()` copy. `withHtmlFooter` reverse-scans original-string windows of length 7 and compares `html.slice(i, i + bodyClose.length).toLowerCase() === "</body>"`, then inserts at that original `i`; appends if none. Tests add uppercase `</BODY>` and `"<html><body>İçerik</body></html>"`. No other Mailer behavior changed for this fix. Disputed dispositions: none.
- **Closure state:** Clear
- **Resolved or withdrawn:** F1
- **Still material:** none
- **New fix-caused or fix-exposed findings:** none

## Findings

### S2 — `withHtmlFooter` slices the original string at an index from a lowercased copy (F1)

- **Status:** Resolved (round 2)
- **Dimension / authority:** correctness / T3 “insert before the last case-insensitive `</body>`”
- **Location:** `apps/backend/src/Mailer.ts:129-132` (`withHtmlFooter`, round-1 code)
- **Impact:** A full-document HTML body that contains U+0130 (`İ`) before `</body>` — ordinary Turkish copy such as “İstanbul”, “İndirim” — gets the unsubscribe/postal footer inserted **inside** the closing tag. The delivered HTML is `…İçerik<<p>Unsubscribe…</p>/body></html>`. Recipients can see a stray `<` and `/body>` around the required commercial footer. Text part, `List-Unsubscribe` headers, and the `<a href>` itself still exist, so this is not a total opt-out miss.
- **Evidence:** Production code:

```129:132:apps/backend/src/Mailer.ts
const withHtmlFooter = (html: string, footer: string): string => {
  const index = html.toLowerCase().lastIndexOf("</body>");
  return index === -1 ? `${html}${footer}` : `${html.slice(0, index)}${footer}${html.slice(index)}`;
};
```

  `"İ".toLowerCase()` is `"i\u0307"` (length 2). Node repro on `"<html><body>İçerik</body></html>"`: lowercased length 33 vs 32; `lastIndexOf("</body>")` = 19; original tag starts at 18; output destroys `</body>`. Existing Mailer tests only use ASCII `</body>` / fragment HTML (`Mailer.test.ts:169`, `:215`), so they stay green.
- **Confidence:** C3
- **Condition:** `message.html` is defined, contains U+0130 (or any other character whose default case mapping changes UTF-16 length) before a `</body>` / `</BODY>` tag. Reachable: operator `--html` file or API `html` string; no further sanitiser.
- **Validation state:** Round 1 confirmed locally and uncovered by units. Round 2: production loop + Mailer `</BODY>` / `İçerik` cases; F1 closed.
- **Smallest safe fix / validation:** Do not index across a full-string `toLowerCase()`. Scan windows of length 7 on the original string and compare `slice(i, i + 7).toLowerCase() === "</body>"` (the candidate is ASCII when it matches, so length is stable), then insert at that `i`. Keep append when none found. Add two Mailer cases: (1) `İ` before `</body>`; (2) uppercase `</BODY>` on ASCII content. Do not “fix” this by appending always — that puts the footer after `</html>` for every full document.

This is not the plan’s accepted heuristic failure (comment/`<script>` containing `</body>`, then append). A failed search would append; a shifted index **mis-inserts**.

- **Resolution:** Production now walks original indexes only:

```129:142:apps/backend/src/Mailer.ts
const bodyClose = "</body>";

const withHtmlFooter = (html: string, footer: string): string => {
  let index = -1;

  for (let i = html.length - bodyClose.length; i >= 0; i--) {
    if (html.slice(i, i + bodyClose.length).toLowerCase() === bodyClose) {
      index = i;
      break;
    }
  }

  return index === -1 ? `${html}${footer}` : `${html.slice(0, index)}${footer}${html.slice(index)}`;
};
```

  A matching window is ASCII `</body>` under default case mapping, so `toLowerCase()` cannot change its length or the insertion index. Reverse order keeps last-tag semantics. Independent Node copy of this loop on the round-1 `İçerik` document inserts before the original tag; the old sequence still mis-inserts. `Mailer.test.ts:211-250` pins `</BODY>` casing preserved; `:252-291` is the U+0130 counterexample as a full `Html.Data` literal. Existing lowercase insert and no-tag append still pass. No new mismatch on last-of-two tags, mixed `</BoDy>`, `İ`+`</BODY>`, emoji, or `ß`. Loop is not a regex/parser (T3). No other `withHtmlFooter` callers.

## Context-dependent concerns

- **Concern:** T6 accepted rows plus campaign `html` round-trip do not observe `Body.Html` or the HTML footer. A deployed dispatcher that dropped `html` would still complete two simulator accepts. The plan also says the request body is pinned in T3 and rendering is the operator mailbox.
- **Disposition:** Not admitted. Unique live value is DynamoDB + typed-client persistence through send. Two-part MIME remains a unit (T3) / optional the operator mailbox concern. Revisit only if T3 is weakened.

- **Concern:** No CLI test for an empty or over-limit `--html` file (schema-only).
- **Disposition:** Not admitted. `CampaignHtml` already rejects both; `Flag.withSchema` applies that codec. Missing-file fail-closed is tested.

## Confirmed-good areas

- `optionalKey` vs `optional` at the campaign contract; typed client cannot send `html: undefined`.
- Shared `utf8ByteCeiling` / `makeFilter` (success `undefined` matches Effect RC112 `FilterOutput`).
- `withOptional` + get/create `contactOf` omission; in-memory API store spreads the campaign so create-then-get is a real dropped-field detector.
- Text-only SES request `toStrictEqual` unchanged (no `Html` key).
- `htmlFooterFor` escapes postal `& < > " '` with `&` first; unsubscribe URL escaped for both `href` and text.
- `SEND#` PutItem still has no subject/text/html (ADR-0011).
- CLI `Option.isSome` payload shaping; missing file makes no HTTP request.
- ADR-0004 Amended line; wiki SES/Effect notes the plan named.
- `.env.example` untouched.
- Round 2: length-stable reverse window scan inserts before last case-insensitive `</body>` without indexing a lowercased copy.

## Limitations and caveats

- Round 2 re-ran the Mailer unit file (25 passed) and a Node copy of the production loop. Did not re-run full `pnpm check` / lint / typecheck.
- Did not deploy `test-html` or run `pnpm test:integration`. T6 persistence-through-completed-send is unproven at runtime (out of F1 follow-up).
- Lane A merge is not in this tree; expected conflicts are recorded in the work document, not reviewed here.
- Work-document Status: Verified was ignored as proof. T3 evidence text still mentions `lastIndexOf`; that is the work document, not this fix.

## Next steps

1. F1 is closed; no further Mailer search change.
2. Ephemeral `test-html` deploy and `pnpm test:integration` remain the T6 live row (Missing; not an admitted finding).
3. Do not treat T6 accepted rows as proof of `Body.Html`; keep T3 as that oracle unless the owner later approves the operator mailbox.
