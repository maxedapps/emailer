# Code review: campaign-segmentation implementation

## Review constraints

| Axis | Selection |
|---|---|
| Target | Uncommitted `campaign-segmentation` vs `9cd7e40` (`main`) |
| Baseline | Plan-backed: [campaign-segmentation.md](campaign-segmentation.md); accepted ADRs [0011](../0011-open-recipient-set-and-paced-dispatch.md), [0013](../0013-repeat-safe-writes.md), [0014](../0014-campaign-body-item-and-summaries.md), [0005](../0005-contact-identity-and-membership-access-paths.md) |
| Scope | Full plan T1–T6 as implemented (T6 live deploy has not run; the integration case is in source). Public contract, storage encoding/projection, domain copy, dispatcher skip-before-status with no row, CLI/README/ADR-0011, tests |
| Invocation | Standalone |
| Output | This report only. No source, test, README, ADR (except this file), or work-document edits. No commit |
| Dimensions | Correctness, types/trust boundaries, APIs/compat/data, tests/validation, simplicity (admission-gated) |
| Validation/tools | Read plan, ADRs, `git diff 9cd7e40`, callers, and tests. No deploy. No unit/lint/help run (no finding needed a repro) |
| Writes/artifacts | `.adr/work/campaign-segmentation-implementation-review.md` |

## Summary

T1–T5 match the plan in source: `filter` is an optional `ContactAttributes` map on the payload and summary, stored on `META` with the two-step omit-or-`strMap` form, copied through domain `create` and the CLI, and applied in the dispatcher as a pure AND of equalities after the body read and before `addressStatus`. A miss sets `lastProcessed` and writes nothing. T6’s live case is present and is shaped to distinguish a dropped filter (three rows) from a miss routed through `skipRecipient` (`skipped: 1`). Live integration against `test-seg` has not been run by the parent; this review did not run it.

No material finding is admitted.

## Related decomplex review

- **Report:** [campaign-segmentation-decomplex.md](campaign-segmentation-decomplex.md) (plan-stage; not this round)
- **Owner disposition summary:** DEX-001–006 were accepted in the work document before implementation (two-step copies; two dispatcher cases; no empty-filter dispatcher case; no filtered-count recipe). Independently re-checked against the diff; none of those choices produced a source defect.

## Coverage

### Inspected

- `git diff 9cd7e40` (15 files; work-document status edits inspected only as claims, not as proof)
- `packages/api/src/Schemas.ts`, `Schemas.test.ts`, `packages/api/src/Api.ts` (`CampaignsGroup` payload/success types)
- `apps/backend/src/Storage/Campaigns.ts`, `Campaigns.test.ts`; `Items.ts` (`strMap` / `StringMapAttribute`); `Contacts.ts` (`contactItem` / `contactOf` precedent); `Membership.ts` (`listMembers` hydration)
- `apps/backend/src/Campaigns.ts`, `Campaigns.test.ts`; `Dispatching.ts`, `Dispatching.test.ts`; `Api.test.ts`; `Api.integration.test.ts`; `test/IntegrationSupport.ts` (`simulator`, `sendToSimulatorList`, `awaitCampaignState`, `sendRows`)
- `apps/cli/src/Commands.ts`, `Commands.test.ts`
- `README.md`; `.adr/0011-open-recipient-set-and-paced-dispatch.md` header
- Callers of `beginRun` / `CampaignRun` (only `Dispatching.ts` consumes the projection; Campaigns/Api fakes leave `beginRun` unexercised)

### Skipped or partial

- Live deploy, integration project, manual walkthrough, and `alchemy destroy` for `test-seg` (parent has not run them; this review is forbidden to deploy)
- Execution of `pnpm check`, unit suites, `pnpm emailer campaigns create --help`, `pnpm lint`, `pnpm format:check`
- Lane C merge-protocol files (out of this lane’s implementation)

### Required boundaries

- HTTP contract: `CreateCampaignPayload` / `CampaignSummary` / `Campaign` spread; list success is `page(CampaignSummary)`
- Persistence: META put, `summaryOf`, `beginRun` `ALL_NEW` (no expression names `filter`)
- Domain `create` copy (the lane-B silent-drop class)
- Dispatcher loop vs `skipRecipient` / limiter / checkpoint
- `listMembers` → `contactOf(..., stored.attributes, ...)`
- CLI payload construction and in-memory create copy
- ADR-0011 skip-count sentence vs the Amended header

## Validation

- **Run:** none. Inspection of the uncommitted diff and callers only.
- **Skipped/unavailable:** all automated checks named in T1–T6 Verify; live `test-seg` gate. Parent work-document claims of green unit runs were not re-executed and are not treated as proof.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** The plan is complete and internally consistent with the four constraining ADRs. In-scope behaviour (AND of equalities, absent-or-`{}` = whole list, no row / no `skipped` bump for a non-match, live attributes, filter on `META`) is specified down to copy form, placement, and test assertions. Out of scope is explicit (OR/ranges, segment entity, subset query, filtered count, post-create edits). The no-row rule does not contradict ADR-0011 once “recipient” is the consent/deliverability set; the Amended header is the prescribed reader repair. DEX-002’s drop of an empty-filter dispatcher case is a test omission the plan itself authorized; the behaviour remains specified. No authority conflict. Confidence: **C3**.

2. **Implementation compliance:** T1–T5 rows are **Complete**. T6 is **Partial**: the integration case is in source and is sensitive as specified; live deploy/run/destroy have not happened. No **Incorrect**, **Missing**, **Overbuilt**, or **Approved deviation** rows. Distribution: 30 Complete, 1 Partial, 0 other. Confidence: **C3** for T1–T5 source; **C2** for T6 until the parent runs `test-seg`.

3. **Implementation quality beyond the baseline:** No material defect beyond the plan. `filter !== undefined && !matchesFilter(...)` treats `{}` as match-all (`Object.entries({}).every` is vacuously true) and treats a missing `attributes` as a miss for any non-empty filter (`attributes?.[key] === value`). Placement is after `getCampaignBody` and before `addressStatus`, so a miss costs no status read, limiter slot, claim, or counter. Two-step copies keep `filter: undefined` out of objects that `exactOptionalPropertyTypes` / Schema encoding would reject. `FILTER` is stored under its natural name and is not referenced in any expression this diff touches. Confidence: **C3**.

4. **Test and validation quality:** Named unit/API/CLI cases exist and assert the behaviours the plan uses as acceptance (wire refuse-`undefined`, META map vs absence, get/`beginRun` projection, domain copy, two-entry AND, no-attributes member, no status/limiter/row on a miss, overrun checkpoint at a filtered member, repeated `--filter` merge). Existing no-filter dispatch cases still exercise today’s whole-list path. The live case would distinguish dropped filter vs `skipRecipient`; it has not been run. This review does not claim unrun checks passed. Confidence: **C3** for unit-level protection as written; **C1** for the deployed table/dispatcher path until T6 runs.

## Plan compliance matrix

| Authority item / implied requirement | Expected evidence | Implementation evidence | Validation / test evidence | Status |
|---|---|---|---|---|
| T1: `CreateCampaignPayload.filter` is `Schema.optionalKey(ContactAttributes)` with AND / absent-or-`{}` comment | Schema field + comment | `packages/api/src/Schemas.ts:313-314`; `CampaignsGroup` create payload is this schema (`packages/api/src/Api.ts:160`) | `Schemas.test.ts` decodes `{ plan: "pro" }`, refuses `filter: undefined` (`:321-335`). Bounds already on `ContactAttributes` (`:134-142`) | Complete |
| T1: `CampaignSummary.filter` same shape; `Campaign` inherits via spread; list answers summaries | Field on summary; `Campaign` spread; list success type | `Schemas.ts:239-240, 253`; list success `page(CampaignSummary)` (`Api.ts:169-171`) | Payload tests as above; GET-after-create uses `Campaign` (`Api.test.ts:934-956`). HTTP list-with-filter is the T6 walk, unrun | Complete |
| T2: `StoredCampaign.filter` optional `StringMapAttribute` → `ContactAttributes` | Same form as `StoredContact.attributes` | `Storage/Campaigns.ts:58-62`; `strMap` (`Items.ts:36-38`) | `Campaigns.test.ts` META put `{ M: { plan: { S: "pro" } } }` (`:542-561`); get projects `{ plan: "pro" }` (`:439-459`) | Complete |
| T2: create META put two-step `strMap`; reserved-word comment | `campaign.filter === undefined ? item : { ...item, filter: strMap(...) }` | `Storage/Campaigns.ts:255-259` | Absence case `not.toHaveProperty("filter")` (`:302`); write case above | Complete |
| T2: `summaryOf` projects `filter` only when stored | Two-step; no `filter: undefined` | `Storage/Campaigns.ts:154-166`; `getCampaign` merges `{ ...summary, ...body }` (`:288-291`); `listCampaigns` uses `summaryOf` (`:301-306`) | get-with-filter toStrictEqual includes `filter`; get-without-filter (`:427-434`) and list summaries (`:599-621`) omit the key | Complete |
| T2: `CampaignRun.filter` and `beginRun` projection | `ContactAttributes \| undefined`; `filter: stored.filter`; `ALL_NEW` unchanged | `Storage/Campaigns.ts:93-97, 385-415` (`ReturnValues: "ALL_NEW"`, no `ProjectionExpression`) | Three `beginRun` projections `filter: undefined` (`:731, :774, :810`); stored `{ plan: "pro" }` (`:818-847`) | Complete |
| T2: reserved-name sweep includes `filter` | Regex `count\|state\|cursor\|text\|filter` | `Campaigns.test.ts:57` | `expectAliasedReservedNames` still runs on create/get/beginRun paths; no expression in this diff names `filter` | Complete |
| T3: domain `create` copies `payload.filter` with a second two-step after html | Direct copy or the field is dropped (lane-B class) | `Campaigns.ts:56-68` | `"creates a draft"` `not.toHaveProperty("filter")` (`Campaigns.test.ts:267`); `"creates a draft carrying a filter"` (`:289-304`) | Complete |
| T3: router round-trip POST + GET `/:id` | Real router, in-memory store keeps the object | `Api.test.ts` in-memory `createCampaign` spreads the campaign (`:358-361`) | `"returns the same filter from GET after creating a campaign with a filter"` (`:934-956`) | Complete |
| T3/T4: `Dispatching.test` `beginRun` fake projects `world.filter` | Only fake that builds a `CampaignRun` | `Dispatching.test.ts:178-194, 427` | Filter cases pass `scenario.filter` into the world (`:1002, :1031`) | Complete |
| T4: `matchesFilter` is module-private AND of equalities; extra attributes do not have to match | `Object.entries(filter).every(([k,v]) => attributes?.[k] === v)` | `Dispatching.ts:80-83` | Two-entry `{ plan: "pro", city: "Berlin" }` mails `memberA` only; `memberB` `{ plan: "pro" }` is a miss (`Dispatching.test.ts:994-1022`) | Complete |
| T4: skip after body read, before `addressStatus`; `lastProcessed = member.id`; `continue` | Loop order | Body read `:156`; skip `:177-184`; status `:186` | `statusCalls` equals `[memberA.email]` on both new cases (`:1013, :1042`) | Complete |
| T4: miss writes no row, no skip counter, no limiter slot, no submission | No `skipRecipient` / `claimRecipient` / `consumeSlot` on that member | Miss path is `continue` only (`Dispatching.ts:181-184`). `skipRecipient` remains the consent/deliverability path (`:189-204`) | No row for B/C, `skipped: 0`, one consume, one submit (`:1008-1017`); overrun case no row for B, consumes length 1 (`:1037-1041`) | Complete |
| T4: overrun checkpoints at a filtered member (avoids `SliceOverrun` when leading members are filtered) | `lastProcessed` set before the mailable member’s delay check | Same skip + existing overrun branch (`:210-217`) | Members `[memberB, memberA]`, delays `[1h]`, checkpoint `next: memberB.id`, no claims (`:1025-1046`). Existing first-member overrun (`:694-708`) still uses `[memberA]` with no filter | Complete |
| T5: CLI `--filter` is repeatable `key=value` with `ContactAttributes`; payload two-step html then filter | `Flag.keyValuePair("filter")` + optional + withSchema | `Commands.ts:403-427`; example `:438-442` | `"creates a campaign whose filter is the merged --filter pairs"` (`Commands.test.ts:756-792`); html-only create still toStrictEqual without `filter` (`:742-750`). `--help` not run here | Complete |
| T5: in-memory CLI `create` copies `filter` | Two-step on the fake campaign | `Commands.test.ts:252-269` | Merge-case stdout includes `filter: { plan: "pro", city: "Berlin" }` | Complete |
| T5: README create line + guarantees bullet | Flag semantics, no-row, `skipped` stays consent/deliverability, live attributes | `README.md:87-88, 124` | Inspection only | Complete |
| T5: ADR-0011 Amended header after Supersedes | One header line, no-row / not counted in `skipped` | `.adr/0011-open-recipient-set-and-paced-dispatch.md:9` | Inspection only. Body sentence at `:45` is unchanged, as the plan specified a header amendment not a body rewrite | Complete |
| T6: live case in source — three labelled simulator contacts, `filter: { plan: "pro" }`, list walk, `accepted: 2` / `skipped: 0`, exactly two accepted rows for the two pro ids | Case uses `simulator`, `sendToSimulatorList`, listing walk + repeat/timeout, `campaignStateTimeout(3, ...)`, `sendRows` | `Api.integration.test.ts:252-354` | **Not run.** Parent has not deployed `test-seg`. This review did not deploy | Partial (case present; live evidence absent) |
| Implied: no `SEND#` row and no transaction on a non-match | Dispatcher never calls `skipRecipient`/`claimRecipient` for a miss | `Dispatching.ts:181-184` vs `skipRecipient` (`:189`) / `claimRecipient` (`:222`) | Unit: `rows.has(memberB/C) === false`. Live row-count assertion unrun | Complete |
| Implied: `skipped` stays consent and deliverability | Filter miss does not increment `skipped`; unsubscribed/suppressed/bouncing still go through `skipRecipient` | Miss `continue`s; `status !== "mailable"` still skips (`:189-204`). `SkipReason` unchanged (`Storage/Campaigns.ts:86`) | New cases assert `counters.skipped === 0`. Existing bouncing skip (`Dispatching.test.ts:980-990`) still records a skip with no filter. No combined filter+unsubscribed unit case; sequential code makes a miss-then-skip impossible for the same member | Complete |
| Implied: absent or empty `filter` is the whole list | Absent: skip branch not taken. `{}`: every() vacuously true | `filter !== undefined && !matchesFilter(...)` (`Dispatching.ts:181`); empty object is not `undefined` but matches everyone | Every existing dispatch case runs with `world.filter === undefined` (`emptyWorld` `:141`). Empty-`{}` dispatcher case explicitly dropped (plan DEX-002). Schema accepts `{}` via `ContactAttributes`. CLI cannot produce `{}` (`Flag.keyValuePair` min 1) | Complete |
| Implied: reserved-word handling — store as `filter`, alias in any future expression | No expression names it today; sweep would fail a future unaliased `filter` | Comment `Storage/Campaigns.ts:255`; PutItem attribute map only; `beginRun` aliases `#state` only | Regex includes `filter` (`Campaigns.test.ts:57`); `(?<![:#])` allows `#filter` / `:filter` | Complete |
| Implied: two-step optional copies (no `filter: undefined` under `exactOptionalPropertyTypes`) | html-then-filter form at each encode/copy boundary | Domain `Campaigns.ts:65-68`; store put `:258`; `summaryOf` `:165`; CLI `:418-426`; CLI fake `Commands.test.ts:261-269`; test `meta()` `:135` | Lint not re-run. No empty-object-spread arm (the lint the plan names). Create/get tests use `not.toHaveProperty("filter")` rather than `filter: undefined` | Complete |
| ADR-0011: still page the whole list live; membership not snapshotted | No subset query; filter is in-process | `listMembers` still called with `memberPageSize` (`Dispatching.ts:147`); filter is the loop predicate | Unchanged list call; filter tests still request the full fixture page | Complete |
| ADR-0014: filter lives on `META`; listing hydrates META; `beginRun` returns it | Not on `BODY` | META put `:235-259`; BODY `withOptional` html only (`:223-232`); `beginRun` decodes `StoredCampaign` | Create put asserts `putItemRequests[1]` (META). get merges META+BODY | Complete |
| ADR-0013: no new write, so nothing new must be repeat-safe | Miss is not a write; existing checkpoint/complete/skip remain | Miss path has no store call | N/A beyond inspection | Complete |
| ADR-0005: `listMembers` hydrates the full contact, attributes included | Dispatcher reads `member.attributes` with no extra get | `Membership.ts:241-246` → `contactOf(..., stored.attributes, ...)`; `Contacts.ts:71-81` | Dispatcher fixtures set `attributes` on A/B; C omits. Live T6 creates contacts with `attributes` then `lists.addContact` — unrun | Complete |

### Approvals and conflicts

- **Approved deviation:** none.
- **Authority conflict:** none. ADR-0011’s “skipped recipients get a row too” is about consent/deliverability recipients; the plan’s no-row rule (user 2026-09-17) plus the Amended header are the current reading. ADR-0016 was not required.

## Follow-up closure

- **Round and material delta:** Implementation review round 1 (source vs plan). Prior artifacts were plan review / plan decomplex, not this implementation.
- **Closure state:** Clear
- **Resolved or withdrawn:** none (first round)
- **Still material:** none
- **New fix-caused or fix-exposed findings:** none

T6 live against `test-seg` remains a plan acceptance gate for the parent. It is not a review finding: the case is in source, and this review was not to deploy.

## Findings

No material findings.

## Context-dependent concerns

None that pass the admission gate. The unrun `test-seg` gate is recorded under T6 / Limitations, not as a defect.

## Confirmed-good areas

- Public contract reuses `ContactAttributes` (20/64/512) under `optionalKey`, so `filter: undefined` is refused and `{}` is a real empty map meaning the whole list.
- Storage follows the contact-attributes precedent (`StringMapAttribute` + two-step `strMap`) and keeps `filter` off every Update/Condition expression.
- Domain `create` actually copies the field (the class of bug that dropped `html`).
- Dispatcher miss is a pure `continue` with `lastProcessed` set, so a page of leading non-matches can still checkpoint instead of raising `SliceOverrun`.
- `skipped` is untouched on a miss; consent/deliverability still use `skipRecipient`.
- CLI `--filter` matches contacts’ `--attr` shape under a different name; in-memory create copies the merged record.

## Limitations and caveats

- Live integration against ephemeral stage `test-seg` has not been run by the parent. This review did not deploy, destroy, or execute the integration project.
- Unit, lint, format, and `campaigns create --help` were not re-run here. Matrix “Complete” rows for T1–T5 are from source and test *text*, not from this review’s execution.
- `listCampaigns` has no dedicated stored-filter unit case; projection is the same `summaryOf` that `getCampaign` tests. HTTP list-with-filter is only in the unrun T6 case.
- Overflow of S1/S0 nits is omitted per caps (none were material).

## Next steps

1. Parent runs T6: deploy `--stage test-seg`, repoint `.env.test`, integration project, manual `--filter` walkthrough, destroy, confirm inventory gone.
2. No source change is required from this review before that gate.
3. Lane C merge protocol in the work document is unchanged and out of scope here.
