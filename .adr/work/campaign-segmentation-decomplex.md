# Decomplex review: Campaign segmentation

## Overall status

Findings, none blocking and none contesting the user's decision. The core of the plan — `filter` as a `ContactAttributes` on `META`, projected by `summaryOf` and `beginRun`, one pure predicate in the dispatcher loop between the body read and the address-status read, no row and no transaction on a miss — is the smallest design that meets the decision of 2026-09-17, and nothing inspected contests the no-row rule, so ADR-0016 stays unwritten. What does not earn its place is a mutable mirror of the payload type in the CLI where the plan's own storage precedent already does the job (DEX-001), two of the four dispatcher cases (DEX-002), three schema and CLI cases that re-pin a shared schema, a type-level relation, or the CLI library (DEX-003), an operator recipe over a number the contract does not expose (DEX-004), one integration detail whose stated rationale does not hold (DEX-005), and Research bullets that restate the briefing (DEX-006).

If all six land, the change has this shape: T1 adds two schema cases; T3 and T5 build the payload with the same two-step conditional the plan already adopts for the stored item; T4 adds two dispatcher cases; T5 adds one CLI case and a README bullet that states the guarantee and stops; T6's contact fixtures are `plan=pro`, `plan=pro`, `plan=free`; Research keeps the decisions the briefing did not make.

## Review contract

| Axis | Selection |
|---|---|
| Mode | Prevention |
| Target | [`campaign-segmentation.md`](campaign-segmentation.md) (Ready for implementation, 2026-09-17) |
| Authority / required behavior | The user's decision of 2026-09-17: the filter is an AND of attribute equalities in the `key=value` shape the contacts commands use; stored on `META`; returned by `beginRun`; evaluated in memory per member after the per-slice body read and before the address-status lookup; a non-match writes no per-recipient row and goes through no transaction; an ADR only if that no-row choice is contested. Accepted ADRs 0005, 0011, 0013, 0014. Repository rules (`CLAUDE.md`, `AGENTS.md`): lean code and architecture; no edge-case or esoteric fail-state handling; cleanest solution over quick fix; the wiki is authoritative. Required behaviour is the plan's Outcome: `POST /campaigns` accepts an optional `filter`, the dispatcher pages the whole list live and mails only matching members, `list`/`get`/`create` show the filter, no filter or `{}` means the whole list |
| Scope | Structural choices, task shape, tests, records. The eight questions (a)–(h) in the brief. Defects, coverage gaps and plan compliance are routed (see Limitations) |
| Report | `.adr/work/campaign-segmentation-decomplex.md` (explicit path; the repository uses `.adr/`, not `adrs/`) |

## Coverage

### Inspected

- The full plan; `campaigns-next-lanes.md` in full (lane D at :198-225, the "Current system" section, the parallelism table); ADR-0005 header, ADR-0011, ADR-0013 and ADR-0014 in full; the two prior decomplex reports (`campaign-body-item`, `contact-list`) for shape and bar; the decomplex skill's gates and template.
- `apps/backend/src/Dispatching.ts` in full (`beginRun` destructure at :96, page read and body read at :141-150, `lastProcessed` at :154, the per-member loop at :171-251, the overrun branch at :196-204 and `SliceOverrun` at :46).
- `apps/backend/src/Storage/Campaigns.ts:1-300, 380-440` (`StoredCampaign`, `CampaignRun`, `summaryOf`, `createCampaign`, `getCampaignBody`, `getCampaign`, `listCampaigns`, `beginRun` projection, `claimRecipient`) and the `skipRecipient` transaction shape; `Storage/Contacts.ts:50-62, 160-175` (`StoredContact.attributes`, the two-step conditional item); `Storage/Items.ts:30-45, 68-115` (`strMap`, `StringMapAttribute`, `withOptional`); `Storage/Membership.ts:206-250` (`listMembers` hydrates attributes).
- `apps/backend/src/Campaigns.ts:41-71` (`create` with the `html` ternary); `packages/api/src/Schemas.ts:120-160, 225-240, 290-310` (`ContactAttributes`, `Contact`, `CampaignSummary`, `CreateCampaignPayload`).
- `apps/cli/src/Commands.ts:95-115` (`PageQuery`, `pageQuery`), `:185-200` (`--attr`), `:380-432` (`campaignsCreate`); `node_modules/effect/src/unstable/cli/Primitive.ts:855-877` (`keyValuePair`) and `Flag.ts:421`.
- The lint rule `tools/oxlint/anti-slop/rules/no-conditional-empty-object-spread.ts` in full.
- Test suites at the lines the plan cites: `Storage/Campaigns.test.ts:50-135, 275-300, 520-575, 655-775`; `Dispatching.test.ts:25-60, 140-190, 300-340, 380-460, 575-665, 955-975` and its full `it` list; `Campaigns.test.ts:50-80, 85-155, 235-290`; `Api.test.ts:45-57, 350-425, 850-905, 1345-1380`; `apps/cli/src/Commands.test.ts:240-280, 700-760, 830-870, 990-1015`; `packages/api/src/Schemas.test.ts:280-360, 604-627`; `Api.integration.test.ts:70-160, 250-290`; `test/IntegrationSupport.ts:190-255, 325-365, 400-440`; `README.md:70-170`.
- `wiki/aws/dynamodb.md:67` (reserved words need expression attribute names).

### Skipped or partial

- Lane C's plan (`campaign-scheduling.md`) and ADR-0015 were not read; the merge protocol is judged on this plan's text only.
- No suite was run, nothing was deployed, and no node check was made; every claim about library behaviour is from reading the installed source at the lines cited.

## Potential findings

### DEX-001 — A mutable mirror of `CreateCampaignPayload` in the CLI, and an undecided fork in the domain, where the plan's own storage form already does the job

- **Severity:** Low
- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** Plan T5 :108 ("replace the `html` ternary with the `pageQuery` form: a local mutable `CreateCampaignPayload`-shaped interface filled from the two `Option`s"); Key-files row :29 ("`pageQuery`: a local mutable interface for optional fields … the payload-shaping precedent once two optionals exist"); T3 :80 ("a second conditional step, or build the literal through a small local mutable object as `pageQuery` does in the CLI, whichever reads cleaner under the lint"). Question (d).
- **Current-need evidence:** Two optional fields need to land on one literal without an `undefined` value (`exactOptionalPropertyTypes`, `optionalKey`). The plan already chooses the form for that in T2 :64: `Contacts.ts:166-170` builds the item as `named` then `attributes` in two conditional steps with no mutable type. The lint rule (`no-conditional-empty-object-spread.ts:16-23`) bans only a spread whose argument is a conditional with an empty-object arm; `cond ? base : { ...base, x }` is not a spread of a conditional and is the form `Contacts.ts:168-170` and `Campaigns.ts:65-66` pass lint with today.
- **Added burden:** In the CLI, a second interface that mirrors five fields of `CreateCampaignPayload` (`listId`, `subject`, `text`, `html?`, `filter?`) and must follow every later change to the schema — `PageQuery<Cursor>` at `Commands.ts:95-98` (filled by `pageQuery` at `:100-112`) is that pattern for a two-field query, which is why it is tolerable there. In the domain, a fork the implementer must resolve, with the plan naming the larger option first.
- **Reachable practical impact:** Maintenance only: a parallel model of the wire type in the one client that already imports the type.
- **Smallest simpler alternative:** T3 and T5 both use the two-step conditional the plan adopts for T2: `const withHtml = Option.isSome(input.html) ? { ...base, html: input.html.value } : base; const payload = Option.isSome(input.filter) ? { ...withHtml, filter: input.filter.value } : withHtml;` in the CLI, and the same two ternaries over `payload.html` and `payload.filter` in `Campaigns.ts:56-66`. T3 :80 states that form and drops "whichever reads cleaner"; the Key-files row :29 loses the `pageQuery` clause.
- **Exception / boundary check:** No boundary: the wire type is the contract, and both forms produce a value of it. The lint stays satisfied.
- **Required behavior and simplification risk:** None affected; the encoded payload is identical.
- **Bounded next step or user question:** Amend T3 :80, T5 :108 and :29.
- **Acceptance signal:** `grep -n "interface CreateCampaign" apps/cli/src/Commands.ts` is empty; `Campaigns.ts create` is two conditional steps; the plan names one form.

### DEX-002 — Two of the four dispatcher cases duplicate the predicate or re-pin the language

- **Severity:** Low
- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** Plan T4 :96 (four cases), :100 (Tests), :102 ("expect green with the four new cases"). Question (c).
- **Current-need evidence:** Case 1 ("skips members the filter does not match without a row, a status read, a limiter slot or a submission") is the behaviour and the placement in one observation: `addressStatus` is called once, `consume` once, one claim, one continuation. Case 4 ("checkpoints at a filtered member when the next delay would overrun") is the only case that observes `lastProcessed = member.id` on a miss; without that line `Dispatching.ts:197-198` turns a page that opens with filtered members and then overruns into `SliceOverrun`, which dies and waits out the queue's visibility lease (ADR-0011 Consequences: 30 minutes) — reachable on any heavily filtered list. Both are load-bearing. Case 2 ("treats a member without attributes as a miss") exercises `attributes?.[key]` with `attributes` undefined, which is the same predicate as a wrong value; the fixtures at `Dispatching.test.ts:29-45` already have no attributes, so case 1's three members can be one match, one wrong value and one without attributes. Case 3 ("sends to every member under an empty filter") pins that `Array.prototype.every` is true on an empty array; "no filter means today's behaviour" is already pinned by every existing case in the suite running with the scenario's `filter` undefined, and the plan itself records that no supported client produces `{}` (:13, :40).
- **Added burden:** Two cases whose failure could only mean the predicate changed in a way case 1 would already report, or the language changed.
- **Reachable practical impact:** Maintenance only.
- **Smallest simpler alternative:** Two cases: case 1 with the attribute-less member as one of its two non-matchers, and case 4. T4 :96, :100 and :102 name two cases.
- **Exception / boundary check:** No unique protection is lost: the absent-attributes rule is asserted inside case 1 by that member's absence from `claims`, `statuses` lookups and `consumes`.
- **Required behavior and simplification risk:** None.
- **Bounded next step or user question:** Trim T4 :96, :100, :102.
- **Acceptance signal:** `Dispatching.test.ts` gains two cases; one of them has a member with no `attributes` and a filter that excludes it.

### DEX-003 — Three schema and CLI cases re-pin a shared schema, a type-level relation, or the CLI library

- **Severity:** Low
- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** Plan T1 :51 ("refuses a filter with 21 entries (the shared bound); `Campaign` round-trips a summary with a filter"); T5 :109 ("`--filter plan` exits nonzero with no request"), :114.
- **Current-need evidence:** `Schemas.test.ts:604-627` already decodes `maxAttributeEntries + 1` entries through `ContactAttributes` and refuses them; the filter is that schema by reference (T1 :50), so a 21-entry filter fails in the same check. `Campaign` is `{ ...CampaignSummary.fields, ...CampaignBody.fields }`; a summary field arriving on `Campaign` is the spread, which the previous round settled as a typecheck matter (`campaign-body-item-decomplex.md`, DEX-005). A bare `--filter plan` is refused by `Primitive.ts:864-869` before any command code runs; the `--attr` suite (`Commands.test.ts:836-860, 992-1008`) pins the merge and the contract bound and has no malformed-pair case, for the same reason.
- **Added burden:** Three cases whose subject is a library, a shared schema already under test, or the type system.
- **Reachable practical impact:** Maintenance only.
- **Smallest simpler alternative:** T1 keeps "decodes with a `filter`" and "refuses `filter: undefined`" (the `html: undefined` precedent at `Schemas.test.ts:307-312` pins `optionalKey` against `optional`, which is a real choice) plus the existing state rows passing without one. T5 keeps the merge-into-one-record case and the existing `:716` whole-object assertion.
- **Exception / boundary check:** The bound is still enforced at the CLI by `Flag.withSchema(Schemas.ContactAttributes)` and at the API by decoding; both are exercised by the cases that stay.
- **Required behavior and simplification risk:** None.
- **Bounded next step or user question:** Trim T1 :51, :55 and T5 :109, :114.
- **Acceptance signal:** `Schemas.test.ts` gains two cases under `CreateCampaignPayload` and none under `Campaign`; `Commands.test.ts` gains one `--filter` case.

### DEX-004 — An operator recipe over a number the contract does not expose, stated three times

- **Severity:** Low
- **Evidence:** Supported
- **Recommendation:** Act
- **Surface and location / authority:** Plan :13 ("the operator can subtract `accepted + rejected + uncertain + skipped` from the list size once the campaign completes"), Research :43 ("The operator can compute it from the list size"), T5 :110 (README bullet: "compare `accepted + rejected + uncertain + skipped` with the list size to see how many the filter excluded"). Question (e). The user's decision covers no filtered count in v1; the recipe is the plan's addition.
- **Current-need evidence:** `ContactList` is `{ id, name, createdAt }` (`Schemas.ts:156-160`) and `lists members` pages members; there is no member count on the wire, so "the list size" is a full page walk the README would be asking for. ADR-0011 Consequences records that rows claimed by a crashed slice stay `unconfirmed` and "the counters can sum to fewer than the members", so the subtraction over-counts exclusions after any crash. A README guarantee that is a procedure over an unexposed number and holds only in the absence of a documented anomaly is more than the guarantee the system makes.
- **Added burden:** One README sentence that scripts may take literally and that has to be re-qualified whenever a counter or list operation changes; the same recipe kept in sync in two places in the plan.
- **Reachable practical impact:** An operator counting a large list by paging to check a filter, and reading a wrong number after a crash.
- **Smallest simpler alternative:** The README bullet states the guarantee and stops: `--filter` narrows to members whose attributes equal every `key=value` given (AND); repeat per entry; omit for the whole list; members that do not match are not mailed and get no row, and `skipped` stays consent and deliverability; attributes are read as each page is sent. Plan :13 and :43 lose the recipe; "no count in v1" stays as the deferral it already is at :139.
- **Exception / boundary check:** The output contract at `README.md:147-164` documents only what the CLI prints; this keeps it that way.
- **Required behavior and simplification risk:** None; documentation only.
- **Bounded next step or user question:** Amend :13, :43 and T5 :110.
- **Acceptance signal:** `grep -n "list size" README.md .adr/work/campaign-segmentation.md` is empty.

### DEX-005 — The integration case's "third member carries another key" refutes nothing

- **Severity:** Low
- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** Plan T6 :124 ("`plan=free` (the third also carries another key so a key-only match would be wrong)"). Question (g).
- **Current-need evidence:** The third member already carries the key `plan` with a different value. An implementation that matched on key presence alone would include that member through `plan` and produce three rows, which the case's row count already catches. A second key on the same contact is reached by no wrong implementation the first key does not reach.
- **Added burden:** One attribute on one live contact plus a parenthetical whose reasoning a reader has to re-derive and find wanting.
- **Reachable practical impact:** None at runtime; a misleading rationale in the plan.
- **Smallest simpler alternative:** Three contacts with `plan=pro`, `plan=pro`, `plan=free`; the clause is dropped. If the parent wants the case to prove more, the cheap place is the unit suite, not a live contact (see Limitations on AND coverage).
- **Exception / boundary check:** The live case's sensitivity (three rows if the filter is dropped, `skipped: 1` if a miss goes through `skipRecipient`, :133) is unchanged.
- **Required behavior and simplification risk:** None.
- **Bounded next step or user question:** Amend T6 :124.
- **Acceptance signal:** The integration case creates its third contact with `{ plan: "free" }` only.

### DEX-006 — Research restates the briefing where it should record decisions, and the planned code comment points at a work document

- **Severity:** Low
- **Evidence:** Supported
- **Recommendation:** Act
- **Surface and location / authority:** Plan Research :38 ("Why a non-match writes nothing") and :43 ("No count"); Approach :13; T4 :95 ("Comment: why no row (see Research) and why before the status read"). Question (h).
- **Current-need evidence:** `campaigns-next-lanes.md:207` already states the two-item transaction, the tens of thousands of writes, re-paging as idempotency, and a count in its own field if wanted; :38 and :43 restate those, and :13 restates :38 again. What :38 adds that the briefing does not have is two arguments — ADR-0011's "skipped recipients get a row too" is about recipients and an excluded member is not one, and a member that starts or stops matching between two walks of a page is decided correctly by the absence condition on the row. :39-42 are decisions the briefing did not make (`optionalKey` with `{}` accepted and not refused; the natural attribute name with the sweep extended; `--filter` rather than `--attr`). A code comment that says "see Research" cites a mutable work document from source; the one sentence the comment needs is the argument itself.
- **Added burden:** One rationale carried in three places of the plan and a fourth in code, each to be kept consistent; a reader of Research cannot tell which bullets are decisions.
- **Reachable practical impact:** Documentation drift only.
- **Smallest simpler alternative:** :38 keeps the two novel arguments and drops the restated briefing; :43 drops to the deferral sentence already at :139; :13 says "a non-match sets `lastProcessed` and continues; see Research for why no row is written" once. T4's comment is self-contained: a miss writes nothing because a redelivered or continued slice re-evaluates the same pure function over the same attributes, and it sits before `addressStatus` so a miss costs no read.
- **Exception / boundary check:** ADR conventions keep records short and decision-bearing; the plan's own "Open gate: none" (:34) already says the language and the no-row rule were the user's, so the briefing text need not be re-argued here.
- **Required behavior and simplification risk:** None.
- **Bounded next step or user question:** Trim :13, :38, :43; reword T4 :95's comment instruction.
- **Acceptance signal:** Research has no sentence that also appears in `campaigns-next-lanes.md:207`; `grep -n "see Research" apps/backend/src/Dispatching.ts` is empty after implementation.

## User-decision queue

None. No finding touches the user's decision, and nothing inspected contests the no-row rule, so ADR-0016 is not needed.

## Confirmed proportionate areas

- **(a) Reusing `ContactAttributes` as the filter schema.** Direct use of the existing shared schema with its bounds; a `CampaignFilter` alias would be a rename-only type with no narrowing, and the field's doc comment (T1 :50) carries the meaning "an AND of attribute equalities". `Flag.withSchema(Schemas.ContactAttributes)` on `--filter` is the `--attr` form at `Commands.ts:191-198` unchanged.
- **(b) One token in the reserved-word sweep.** `reservedAttributeName` at `Storage/Campaigns.test.ts:56` already lists `text`, which no `META` expression names since ADR-0014 moved it to `BODY`; `filter` joins on the same footing, one word, and the sweep is the repository's standing mechanism for the rule at `wiki/aws/dynamodb.md:67`. The natural attribute name (Research :41) is right: aliasing an attribute no expression names would be ceremony.
- **(f) `matchesFilter` module-private, exercised through `runSlice`.** Nothing in `Dispatching.ts` is exported for tests (`memberPageSize` and `breaker` are exported as constants for reuse); the two cases that stay under DEX-002 observe the predicate through its only caller. Inline or a one-line named `const` are both fine; the name gives the domain word.
- **The storage form.** `StoredCampaign.filter` as `StoredContact.attributes` (`Contacts.ts:55-59`), the META put built in two steps (`Contacts.ts:166-170`), `summaryOf` projecting the key only when stored as `getCampaignBody` does for `html` (`Campaigns.ts:253-254`), and `CampaignRun.filter` typed like `cursor` (`Campaigns.ts:86-95`) — each is the nearest precedent, with no new helper.
- **The placement and the no-row rule.** Both are the user's decision; the plan's reasoning that `lastProcessed` advances on a miss (Research :39) is the same reasoning the skip path uses at `Dispatching.ts:189`, and the plan's "one status call" assertion (T4 :103) is what pins the order.
- **T6 live gate and the merge protocol.** Same shape as the previous lanes: deploy, integration project, manual pass, destroy; the "keep both" conflict list is guidance for a conflict that will happen, not machinery.

## Limitations

- Static review only; no suite was run and no stage was deployed.
- Every disposition is the parent's; the six findings are independent of each other and each is a trim, not a redesign.
- Routed to the test and compliance reviewer, not judged here:
  - Neither the integration case (single-entry `{ plan: "pro" }`) nor any named unit case in T4 uses a two-entry filter, so the AND semantic the user decided is not exercised where a member matches one entry and not the other. A two-entry filter in the unit case that stays under DEX-002 would close it at no extra case.
  - T3 :83 and Handoff :148 say three `CampaignStore` fakes' `beginRun` projections gain `filter`, but `Api.test.ts:48` and `Campaigns.test.ts:146` leave `beginRun` unexercised (`Effect.die` / `notExercised`) and construct no `CampaignRun`; only the Dispatching fake (`Dispatching.test.ts:168-183`) changes. Clerical.
