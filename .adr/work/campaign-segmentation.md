# Campaign segmentation

> **Status:** Complete
> **ADRs:** None new. Constrained by [0011](../0011-open-recipient-set-and-paced-dispatch.md) (membership is read live and the whole list is paged; per-recipient rows record consent and deliverability skips; T5 adds an "Amended" header line there), [0013](../0013-repeat-safe-writes.md) (no new write is added, so nothing new must be made repeat-safe), [0014](../0014-campaign-body-item-and-summaries.md) (the filter lives on `META`, which the listing hydrates and `beginRun` returns), [0005](../0005-contact-identity-and-membership-access-paths.md) (`listMembers` hydrates the full contact, attributes included). A one-page ADR-0016 is written only if the "no row per non-match" choice below is contested; neither review contested it.
> **Updated:** 2026-09-17
> **Lane:** Round 2, lane D of [campaigns-next-lanes](campaigns-next-lanes.md). Developed in parallel with lane C ([campaign-scheduling](campaign-scheduling.md)). Merged as PR #9 on 2026-09-17, after scheduling landed first under separate user authorization. Worktree and branch removed; ephemeral stage `test-seg` was already destroyed. See Merge and cleanup below.

## Outcome and boundaries

- **Problem and target:** a campaign goes to every member of its list. Operators want to send to the members whose attributes match, without building a second list. Target: `POST /campaigns` accepts an optional `filter`, an AND of attribute equalities over `Contact.attributes`; the dispatcher still pages the whole list live and skips members that do not match; `GET /campaigns`, `get`, `create` show the filter. No filter, or an empty one, means the whole list, which is today's behaviour.
- **In scope:** `filter` on `CreateCampaignPayload` and `CampaignSummary` (reusing the `ContactAttributes` schema, so the same bounds apply: at most 20 entries, keys up to 64 characters, values up to 512); `filter` stored on `META` and returned by `beginRun`; one pure match in the dispatcher loop, after the per-slice body read and before the address-status lookup; `campaigns create --filter key=value` (repeatable); unit, API, CLI and one live case; README; an "Amended" line on ADR-0011.
- **Out of scope:** OR, negation, regex, prefix or numeric ranges; saved segments or a segment entity; a second index or querying a subset of members from DynamoDB; snapshotting matching ids; a `filtered` skip reason or per-recipient row for a non-match; a filtered count on the campaign; editing a campaign's filter after creation; scheduling (lane C); templates; personalisation.
- **Approach:** the filter is data on the campaign and a pure function in the loop. `matchesFilter(filter, attributes)` is true when every `[key, value]` of the filter equals `attributes[key]`; a member without attributes matches only the empty filter. A non-match sets `lastProcessed` and continues: no `SEND#` row, no transaction, no limiter slot, no counter. Attributes are read live at page time, like membership: a contact edited to match after its page was walked is not mailed; one edited to stop matching before its page is not. Assumptions taken as routine: the CLI flag is `--filter` (the `key=value` shape of contacts' `--attr`, a different name because the meaning is "match", not "set"); `{}` is accepted and means the whole list (the CLI cannot produce it, since `Flag.keyValuePair` requires at least one pair); no count of filtered members in v1, because it would touch `checkpoint` and `completeRun` for a number the operator does not need to act.

## Key files, evidence, and decisions

| File or source | Why it matters | Decision or plan impact |
|---|---|---|
| `packages/api/src/Schemas.ts:132-144` (`ContactAttributes`), `:146-152` (`Contact.attributes` optional), `:233-239` (`CampaignSummary`), `:306-311` (`CreateCampaignPayload`) | The filter's shape already exists with its bounds; the summary is what `list` answers and `Campaign` spreads; verified against installed Effect that `optionalKey(ContactAttributes)` decodes `{}` and a map, rejects `filter: undefined`, and that encoding a summary with `filter: undefined` fails (so projections must be conditional) | T1 reuses `ContactAttributes` under `optionalKey` |
| `apps/backend/src/Storage/Campaigns.ts:43-65` (`StoredCampaign`), `:86-95` (`CampaignRun`), `:146-155` (`summaryOf`), `:208-245` (`createCampaign` META put), `:387-404` (`beginRun` projection) | Where the filter is written, projected and handed to the dispatcher | T2 |
| `apps/backend/src/Storage/Contacts.ts:55-59` (`attributes` on a stored item via `StringMapAttribute` + `decodeTo(ContactAttributes)`), `:166-170` (two-step conditional for an optional map) | The exact precedent for storing and decoding an attribute map; `withOptional` handles strings only; the lint (`no-conditional-empty-object-spread`) rejects only a spread of a conditional with an empty-object arm, so the two-step conditional passes | T2, T3, T5 use that form |
| [DynamoDB reserved words](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html) (`FILTER` is listed) | No expression names the attribute (`PutItem` on create; `beginRun` returns `ALL_NEW` without naming it; no projection or filter expression anywhere on the read path), and `expectAliasedReservedNames` only sweeps `count|state|cursor|text` | T2 stores it as `filter`, adds `filter` to the sweep regex, and comments that any future expression must alias it `#filter` |
| `apps/backend/src/Storage/Campaigns.test.ts:83-131` (`meta`), `:674-682, 716, 751` (`beginRun` projection `toStrictEqual`), `:281-296` (absent keys on create), `:540-570` (summary literals), `:58-81` (reserved-name sweep), `:658-771` (`describe("beginRun")`) | Exact assertions that gain or must not gain the key | T2 names each |
| `apps/backend/src/Storage/Membership.ts:245` (`listMembers` hydrates `contactOf(... attributes ...)`) | The dispatcher already holds each member's attributes; no extra read | T4 |
| `apps/backend/src/Dispatching.ts:141-155` (page read, body read, `lastProcessed`), `:171-190` (per-member loop start, `addressStatus`, skip), `:253-259` (last page completes without a checkpoint) | The match sits between the body read and the first per-member read | T4 |
| `apps/backend/src/Dispatching.test.ts:29-45` (members without `attributes`), `:80-137` (`World`, `emptyWorld`, no status-call recorder), `:146-157` (`listMembers` and `addressStatus` fakes), `:168-183` (`beginRun` fake, the only fake that builds a `CampaignRun`), `:303-333` (limiter double), `:384-456` (`Scenario`, `fixture`), `:641` (overrun case) | Fixtures gain attributes, the scenario gains a `filter`, the projection gains the key, the world gains a status-call recorder | T4 |
| `apps/backend/src/Campaigns.ts:41-74` (`create` builds the campaign literal by hand) | The lane B review's blocker: a payload field must be copied here or it is silently dropped; a direct copy is TS2375 under `exactOptionalPropertyTypes`, so the compiler forces the conditional form | T3 |
| `apps/backend/src/Campaigns.test.ts:51-78` (fixtures), `:253-287` (`create` cases); `apps/backend/src/Api.test.ts:356-422` (store fake), `:856-902` (contact-to-queued flow) | Unit and router cases for the copied field | T3 |
| `apps/cli/src/Commands.ts:191-198` (`Flag.keyValuePair("attr")` + `withSchema(ContactAttributes)` + `optional`), `:383-429` (`campaignsCreate` with the `Option.isSome` payload ternary); `node_modules/effect/src/unstable/cli/Primitive.ts:861-877` (`key=value` split; `min: 1`; repeated flags merge) | The flag precedent; verified through `Command.runWith`: no flag → none, repeats merge, a bare key or 21 flags are refused at parse | T5 |
| `apps/cli/src/Commands.test.ts:248-272` (in-memory `create` copies fields), `:716-752` (create-with-files case with a whole-object `toStrictEqual`, unaffected when the key is absent) | The in-memory service must copy `filter` | T5 |
| `apps/backend/test/IntegrationSupport.ts:68-77` (`simulator` address labels), `:239-252` (`sendToSimulatorList`), `:331-363` (`awaitCampaignState`), `:406-436` (`sendRows`); `apps/backend/src/Api.integration.test.ts:77-155` (send flow), `:655-711` (the listing case walks cursors at limit 100 with a repeat and timeout, because the index is eventually consistent and the stage accumulates campaigns) | The live case counts rows, which is the only observation that distinguishes "not mailed" from "mailed and not counted"; the summary is located the way the listing case does | T6 |
| `README.md:97-111` (contacts block with `--attr`), `:78-93` (campaign block), `:113-145` (guarantees) | Where the flag and its semantics go | T5 |
| `.adr/0011-open-recipient-set-and-paced-dispatch.md:44` ("Skipped recipients get a row too, so skip counts are exact") | After this lane `skipped` still counts every skipped recipient; members the filter excludes are not recipients. A reader of ADR-0011 should find that | T5 adds one "Amended" header line, the `.adr/0004…:8` precedent |

- **Open gate:** none. The filter language (AND of equalities, `--attr` shape) and the no-row rule were set by the user on 2026-09-17; the assumptions in Approach are routine.

## Research

- **Why a non-match writes nothing, and why that does not contradict ADR-0011.** ADR-0011's "skipped recipients get a row too" is about recipients: members the campaign would mail but must not (unsubscribed, suppressed, bouncing), signals the operator acts on. A member the filter excludes is not a recipient of this campaign; recording one would put tens of thousands of two-item transactions behind a filter that matches a small share of a large list. Idempotency does not need the row: a redelivered or continued slice re-pages from the checkpoint and evaluates the same pure function over the same attributes. A member that stops matching between two walks of the same page is skipped the second time and was never claimed the first time; one that starts matching is claimed once, under the absence condition on the row.
- **Placement.** After `getCampaignBody` (a pause exit or a missing list never pays for it) and before `addressStatus` (a DynamoDB read per member). A non-match sets `lastProcessed = member.id` because the member is finished; an overrun checkpoint at a filtered member is correct for the same reason a checkpoint at a skipped member is, and without it a page whose first members are all filtered would raise `SliceOverrun` instead of checkpointing.
- **Reserved word.** `FILTER` is a DynamoDB reserved word. It matters only inside expressions, and none names it. Storing it under its natural name with the sweep regex extended keeps a future `REMOVE filter` from passing tests.
- **Attribute name on the wire.** `filter` on the summary; `--filter` on the CLI. The contact commands' `--attr` sets attributes; reusing that name for a match predicate would read as "create the campaign with these attributes".
- **No count.** A per-page counter would have to ride on `checkpoint` (`ADD filtered :n`) and, for the last page, on `completeRun`, plus a wire field. Nothing in the contract exposes the list size either, so no recipe for deriving the number is offered. If a count is wanted later it is one field in its own name, not `skipped`.

## Tasks

#### T1 — Contract: optional `filter` on the payload and the summary

- **Change:**
  - `packages/api/src/Schemas.ts`: `CreateCampaignPayload` and `CampaignSummary` each gain `filter: Schema.optionalKey(ContactAttributes)` with a doc comment: an AND of attribute equalities; absent or `{}` means the whole list. `Campaign` inherits it through the spread.
  - `packages/api/src/Schemas.test.ts`: `CreateCampaignPayload` decodes with a `filter` and refuses `filter: undefined` (the html cases at `:298-314` are the precedent; the record bounds are already pinned on `ContactAttributes` at `:604-627`).
- **Starts at:** `packages/api/src/Schemas.ts:233-239, 306-311`, `packages/api/src/Schemas.test.ts:282-320`
- **Depends on:** none
- **Status:** Verified
- **Evidence:** `packages/api/src/Schemas.ts` adds `filter: Schema.optionalKey(ContactAttributes)` on `CampaignSummary` and `CreateCampaignPayload` with the AND-of-equalities comment; `Campaign` inherits via the spread. `Schemas.test.ts` decodes `{ plan: "pro" }` and refuses `filter: undefined`. Parent reran `pnpm exec vitest run --project unit packages` — 97 passed.
- **Tests:** `packages/api/src/Schemas.test.ts` (`unit`) protects the wire shape.
- **Verify:**
  - Run `pnpm exec vitest run --project unit packages`; expect green.
- **Risk/recovery:** none; an optional key breaks no annotated fixture.

#### T2 — Storage: `filter` on `META`, in the summary and in the run

- **Change:**
  - `apps/backend/src/Storage/Campaigns.ts` `StoredCampaign`: `filter: Schema.optionalKey(StringMapAttribute.pipe(Schema.decodeTo(Schemas.ContactAttributes, SchemaTransformation.passthrough())))` (the `StoredContact.attributes` form).
  - `createCampaign` META put: build the item as today, then `campaign.filter === undefined ? item : { ...item, filter: strMap(campaign.filter) }` (the `Contacts.ts:166-170` form). Comment: `filter` is a reserved word; no expression names it, and any future one must alias `#filter`.
  - `summaryOf`: the projected summary gains `filter` only when stored (the same two-step form; encoding `filter: undefined` fails).
  - `CampaignRun`: `readonly filter: Schemas.ContactAttributes | undefined` (typed like `cursor`); `beginRun` projects `filter: stored.filter`.
  - `apps/backend/src/Storage/Campaigns.test.ts`: `reservedAttributeName` regex gains `filter`; `meta` gains an optional `filter` attribute map; cases: `createCampaign` writes `filter` as a string map on the META put, and `:281-296` gains `not.toHaveProperty("filter")`; `getCampaign` projects a stored filter into the campaign (extend `:405`); the three `beginRun` projection assertions at `:674`, `:716`, `:751` gain `filter: undefined`, and one new case appended before `:773` projects a stored filter.
- **Starts at:** `apps/backend/src/Storage/Campaigns.ts:43-65, 86-95, 146-155, 220-245, 387-404`; `apps/backend/src/Storage/Campaigns.test.ts:58-131, 258-300, 658-771`
- **Depends on:** T1
- **Status:** Verified
- **Evidence:** StoredCampaign decodes optional `filter` via StringMapAttribute; createCampaign META put uses the two-step `strMap` form with a reserved-word comment; summaryOf projects only when stored; CampaignRun.filter is `ContactAttributes | undefined` and beginRun projects it. Tests cover write, absence, get projection, three beginRun `filter: undefined` projections, one stored-filter projection, and the reserved-word sweep. Parent reran `pnpm exec vitest run --project unit apps/backend/src/Storage` (196 passed) and `pnpm lint` (0 warnings/errors). Join: Dispatching.test.ts beginRun fake gained `filter: undefined` so CampaignRun stayed assignable (T4 replaces this with `world.filter`).
- **Tests:** `apps/backend/src/Storage/Campaigns.test.ts` (`unit`, recorded requests) protects: the stored encoding of the map, its absence when not given, its projection into the campaign and into the run, and the reserved-word sweep.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Storage`; expect green.
  - Run `pnpm lint`; expect green.
- **Risk/recovery:** none; no expression changes.

#### T3 — Domain `create` copies the filter; fakes and router

- **Change:**
  - `apps/backend/src/Campaigns.ts` `create`: carry `payload.filter` into the campaign literal with a second two-step conditional after the `html` one (the same form the store uses).
  - `apps/backend/src/Campaigns.test.ts`: "creates a draft carrying a filter" beside `:270`; the existing "creates a draft" gains `not.toHaveProperty("filter")`.
  - `apps/backend/src/Api.test.ts`: one case: `POST /campaigns` with a filter answers it and `GET /campaigns/:id` carries it (extend the flow at `:856`).
  - `apps/backend/src/Dispatching.test.ts:168-183`: the `beginRun` fake's projection gains `filter` from the scenario (the `Campaigns.test.ts` and `Api.test.ts` fakes leave `beginRun` as `notExercised`).
- **Starts at:** `apps/backend/src/Campaigns.ts:59-72`, `apps/backend/src/Campaigns.test.ts:253-287`, `apps/backend/src/Api.test.ts:856-902`
- **Depends on:** T1, T2
- **Status:** Verified
- **Evidence:** `Campaigns.create` copies `payload.filter` with a second two-step after html. `"creates a draft"` asserts `not.toHaveProperty("filter")`; `"creates a draft carrying a filter"` and the Api GET-after-create case round-trip `{ plan: "pro" }`. Parent reran `pnpm exec vitest run --project unit apps/backend/src/Campaigns.test.ts apps/backend/src/Api.test.ts` — 65 passed.
- **Tests:** `apps/backend/src/Campaigns.test.ts` (`unit`) protects that the field reaches the store (the lane B blocker class); `apps/backend/src/Api.test.ts` (`unit`, real router) protects the round trip.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend`; expect green.
- **Risk/recovery:** none.

#### T4 — Dispatcher: match before the address-status read; no row on a miss

- **Change:**
  - `apps/backend/src/Dispatching.ts`: module-private `const matchesFilter = (filter: Schemas.ContactAttributes, attributes: Schemas.ContactAttributes | undefined) => Object.entries(filter).every(([key, value]) => attributes?.[key] === value)`; destructure `filter` from `begun.campaign`; in the loop, before `addressStatus`: `if (filter !== undefined && !matchesFilter(filter, member.attributes)) { lastProcessed = member.id; continue; }`. A self-contained comment: a member the filter excludes is not a recipient, so it gets no row and no counter; re-paging re-evaluates the same pure function, so nothing needs recording; it sits before the status read so a miss costs no read.
  - `apps/backend/src/Dispatching.test.ts`: `memberA`/`memberB`/`memberC` gain attributes (`{ plan: "pro", city: "Berlin" }`, `{ plan: "pro" }`, none); `World` and `emptyWorld` gain `statusCalls: Array<string>` (the `addressStatus` fake pushes to it) and `filter: ContactAttributes | undefined`; `Scenario` gains `filter?: ContactAttributes`, copied into the world by `fixture`, and the `beginRun` fake projects `world.filter`; two cases: "skips members a two-entry filter does not match without a row, a status read, a limiter slot or a submission" (filter `{ plan: "pro", city: "Berlin" }`, a `nextCursor` that is not a member of the page: one accepted row for `memberA`, `statusCalls` equal to `[memberA.email]`, one limiter consume, one continuation checkpoint, no rows for the member matching one entry or the member without attributes); "checkpoints at a filtered member when the next delay would overrun" (`delays: [Duration.hours(1)]` so the first mailable member overruns, with a filtered member first: the checkpoint names the filtered member and no `SliceOverrun`; the `:641` case's `[zero, 1h]` would finish the page without a checkpoint).
- **Starts at:** `apps/backend/src/Dispatching.ts:96-98, 141-190`; `apps/backend/src/Dispatching.test.ts:29-45, 80-137, 146-157, 168-183, 384-456, 641-660`
- **Depends on:** T2 (the `CampaignRun.filter` type)
- **Status:** Verified
- **Evidence:** `matchesFilter` is module-private; the loop skips before `addressStatus` when `filter !== undefined` and the member does not match, setting `lastProcessed` and writing nothing. Tests: two-entry AND, no-attributes member, no status/limiter/row on a miss, continuation checkpoint, overrun checkpoint at a filtered member. Parent reran `pnpm exec vitest run --project unit apps/backend/src/Dispatching.test.ts` — 28 passed.
- **Tests:** `apps/backend/src/Dispatching.test.ts` (`unit`, `runSlice` against the recorded fakes) protects: a miss costs no write, no status read and no limiter slot; AND over two entries; the absent-attributes rule; the checkpoint at a filtered member. Existing skip, claim and overrun cases pin the untouched paths, and every existing case runs without a filter.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Dispatching.test.ts`; expect green with the two new cases.
- **Risk/recovery:** a match placed after `addressStatus` would still be correct but pay a read per non-match; the `statusCalls` assertion pins the order.

#### T5 — CLI `--filter`, README, ADR-0011 header

- **Change:**
  - `apps/cli/src/Commands.ts` `campaignsCreate`: `filter: Flag.keyValuePair("filter").pipe(Flag.withDescription("Send only to members whose attributes equal every key=value given; repeat the flag per entry"), Flag.withSchema(Schemas.ContactAttributes), Flag.optional)`; build the payload with two two-step conditionals (`html`, then `filter`) over the required fields; example `campaigns create ... --filter plan=pro --filter city=Berlin`.
  - `apps/cli/src/Commands.test.ts:248-272`: the in-memory `create` copies `filter`; one case: `campaigns create ... --filter plan=pro --filter city=Berlin` prints the campaign with `filter: { plan: "pro", city: "Berlin" }` (the existing `:716` case keeps pinning that no key is sent without the flag).
  - `README.md:78-93`: a create line with `--filter plan=pro`; `:113-145`: a bullet "`--filter` narrows a campaign to members whose attributes equal every `key=value` given (AND); repeat it per entry; omit it for the whole list. Members that do not match are skipped without a row and are not counted in `skipped`, which stays consent and deliverability. Attributes are read as each page is sent."
  - `.adr/0011-open-recipient-set-and-paced-dispatch.md` header, after the Supersedes line: "- Amended: [campaign-segmentation](work/campaign-segmentation.md) — a member a campaign filter excludes is not a recipient; it gets no row and is not counted in `skipped`"
- **Starts at:** `apps/cli/src/Commands.ts:191-198, 383-429`, `apps/cli/src/Commands.test.ts:248-272, 716-752`, `README.md:78, 113`, `.adr/0011-open-recipient-set-and-paced-dispatch.md:1-8`
- **Depends on:** T1
- **Status:** Verified
- **Evidence:** `--filter` is `Flag.keyValuePair` with `ContactAttributes`; payload uses two two-step conditionals; in-memory create copies filter. New CLI case merges `--filter plan=pro --filter city=Berlin`. README create line and guarantees bullet; ADR-0011 Amended header. Parent reran `pnpm exec vitest run --project unit apps/cli` (36 passed), `pnpm emailer campaigns create --help` (documents `--filter key=value`, repeatable), `pnpm format:check` (green).
- **Tests:** `apps/cli/src/Commands.test.ts` (`unit`, real CLI process) protects that repeated pairs merge into one record on the wire and that the flag is optional (the parser's own refusals are Effect's, pinned upstream).
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/cli`; expect green.
  - Run `pnpm emailer campaigns create --help`; expect `--filter` documented as repeatable `key=value`.
  - Run `pnpm format:check`; expect green.
- **Risk/recovery:** none.

#### T6 — Live gate on an ephemeral stage

- **Change:**
  - `apps/backend/src/Api.integration.test.ts`: one case: three `client.contacts.create` calls with labelled `simulator("success", runId, n)` addresses and attributes `plan=pro`, `plan=pro`, `plan=free`, `lists.addContact` for each, a campaign with `filter: { plan: "pro" }`; assert the create response carries the filter and locate its summary the way the listing case at `:674-703` does (cursor walk at limit 100 under its repeat and timeout) and assert `found.filter`; send through `sendToSimulatorList`, `awaitCampaignState(... "completed", campaignStateTimeout(3, quota?.MaxSendRate))` under the `sendTestTimeout` it budget as the send case at `:77-87` does, assert `progress` is `{ accepted: 2, rejected: 0, uncertain: 0, skipped: 0 }` and `sendRows(campaignId)` has exactly two rows, both `accepted`, for the two `plan=pro` contacts.
  - Manual: `campaigns create --filter plan=pro`, `campaigns send`, `campaigns get` until `completed` with `accepted: 2`; `campaigns list` shows the filter.
- **Starts at:** `apps/backend/src/Api.integration.test.ts:77-155, 655-711`, `apps/backend/test/IntegrationSupport.ts:68-77, 239-252, 406-436`
- **Depends on:** T1 to T5
- **Status:** Verified
- **Evidence:** Case is in `apps/backend/src/Api.integration.test.ts`. Parent `pnpm check` green (605 unit tests). Deploy `--stage test-seg` created 26 resources. Integration project: 3 files, 25 tests passed in 190s, including `creates a campaign filtered to plan=pro, lists the filter, and accepts only the two matching members` (6.5s). Manual CLI: create `--filter plan=pro`, send, get until `completed` with `{ accepted: 2, rejected: 0, uncertain: 0, skipped: 0 }`, list showed `{ plan: "pro" }` (runId `bd93a8cdb693`). `alchemy destroy` 26 succeeded. AWS inventory search for `test-seg` functions, tables, queues, log groups, roles, alarms, topics, EventBridge rules, SES config sets, event-source mappings: empty.
- **Tests:** the case above (`integration`) protects the whole path: the filter survives the deployed table, reaches the dispatcher, excludes the non-matching member without a row, and the summary shows it. The row count is what makes it sensitive: a dropped filter shows three rows; a miss routed through `skipRecipient` shows `skipped: 1`.
- **Verify:**
  - Run `pnpm check`; expect green.
  - Deploy with the README's command (`README.md:244`) at `--stage test-seg`; repoint the six stage-specific `.env.test` values (API and unsubscribe URLs, table name, dispatch failures queue URL, unsubscribe secret, set-bounce alarm name); run `node --env-file=.env.test node_modules/vitest/vitest.mjs run --project integration`; expect green. Run the manual walkthrough. Then the matching `alchemy destroy` (`README.md:270`) for `test-seg`; expect no `emailer-test-seg-*` functions, tables or queues.
- **Risk/recovery:** three rows means the filter was dropped somewhere between the payload and `beginRun` (T3's copy or T2's projection); `skipped: 1` means a miss went through `skipRecipient`.

## Final acceptance

- **Checks:** `pnpm check` green; the integration project green against `test-seg`; the manual walkthrough done; the stage destroyed and its inventory confirmed gone.
- **End state:** a campaign may carry an AND-of-equalities filter, visible on create, get and list; the dispatcher pages the whole list live and mails only matching members, writing nothing for the rest; no filter means today's behaviour; ADR-0011 points here.
- **Deferrals or blockers:** no filtered count; no OR, negation or ranges; no filter edits after creation; ADR-0016 only if a later review contests the no-row rule.

## Handoff

- **Next action:** None. PR #9 is merged and pushed; cleanup is complete.
- **Resources:** worktree `~/worktrees/emailer/campaign-segmentation` and its local/remote branch removed. Its private `.env.test` was preserved as gitignored `.env.test-seg` in the main checkout with owner-only permissions, without overwriting the existing `.env.test`. Stage `test-seg` was already destroyed; this merge created no cloud resources. No live processes remain from this merge.
- **Original merge protocol (superseded by the authorized scheduling-first order):** the anticipated overlapping edits were all "keep both sides", with the same substance as the list in [campaign-scheduling](campaign-scheduling.md):
  - `packages/api/src/Schemas.ts`: D's `filter` on `CreateCampaignPayload` and `CampaignSummary`; C's `scheduled` member, `ScheduleCampaignPayload`, `SendAtNotInFuture`.
  - `apps/backend/src/Storage/Campaigns.ts`: `StoredCampaign` gains D's `filter` and C's `scheduled` literal; `summaryOf` gains D's projection and `submissionOf` C's `scheduled` case; `beginRun` gains D's `filter` in the projection and C's condition; the create put gains D's map; the operations object gains C's two operations.
  - `apps/backend/src/Storage/Campaigns.test.ts`: `meta` gains D's `filter`; the `beginRun` case at `:667-697` carries D's `filter: undefined` in its projection (`:674`) and C's condition values in its request assertion (`:683-695`); `:716` and `:751` gain D's key only.
  - The three `CampaignStore` fakes (`Dispatching.test.ts:159`, `Campaigns.test.ts:89`, `Api.test.ts:45` and `:356`): C adds two operations to all three (in-memory versions in `Campaigns.test.ts` and `Api.test.ts`, `notExercised` in `Dispatching.test.ts`); D changes the `Dispatching.test.ts` `beginRun` result only.
  - `apps/backend/src/Campaigns.ts` and `Campaigns.test.ts`, `apps/cli/src/Commands.ts` and `Commands.test.ts`, `packages/api/src/Schemas.test.ts`, `apps/backend/src/Api.test.ts`, `Api.integration.test.ts`, `README.md`, `apps/backend/test/IntegrationSupport.ts` (C generalises the simulator guard; D uses the `send` form): one addition each per lane; keep both. After the merge lane C runs `pnpm check` and the integration project on its stage.
  - ADR numbering: lane C owns 0015; this lane takes 0016 only if an ADR becomes necessary.
- **Reviews:** [campaign-segmentation-review.md](campaign-segmentation-review.md) (adversarial, 0 blocker / 0 major / 3 minor / 4 nit) and [campaign-segmentation-decomplex.md](campaign-segmentation-decomplex.md) (6 findings, none blocking; the no-row rule uncontested). Dispositions, all applied above:
  - Review 1 (`statusCalls` recorder): Accept. 2 (locate the summary by the listing walk): Accept. 3 (two unnamed conflicts; only one fake builds a run): Accept, in both plans. 4 (`nextCursor` for the checkpoint): Accept. 5 (`contactFor` cannot carry attributes): Accept, API path and `simulator` labels. 6 (header line on ADR-0011): Accept, as "Amended". 7 (citations): Accept.
  - DEX-001 (no mutable payload mirror; two-step conditionals): Accept. DEX-002 (two dispatcher cases; a two-entry filter; no-attributes member folded in; drop the empty-filter case): Accept. DEX-003 (drop three re-pinning cases): Accept. DEX-004 (drop the subtraction recipe): Accept. DEX-005 (drop the third-member clause): Accept. DEX-006 (trim restated research; self-contained comment): Accept.
- **Re-review (2026-09-17):** Findings, 0 blocker / 0 major / 0 minor / 5 nit (appended to the review report): "Amended" rather than "Extended" on ADR-0011; lane C gives two fakes in-memory operations; name the live wait's timeout; three line numbers; the `World.filter`, overrun delay and `nextCursor` details in T4. All five accepted and applied. No material finding remains.
- **Implementation review:** [campaign-segmentation-implementation-review.md](campaign-segmentation-implementation-review.md) (plan-backed, round 1). 0 findings. Closure **Clear**. T6 live gate recorded as Partial in the matrix (case in source, deploy unrun) — a parent acceptance gate, not a review finding. Parent disposition: accept Clear. Parent independently inspected the diffs and reran T1–T5 verifies plus `pnpm check` (format, lint, typecheck, 605 unit tests, imports). No decomplex Audit this round: the implementation follows the already-dispositioned DEX-001–006 forms; the reviewer independently re-checked them and admitted no complexity finding.
- **Deviations:** none. T6 live gate completed after SSO refresh; no source change. Implementation review remains Clear.

## Merge and cleanup

The user explicitly requested merge, conflict reporting, commit, push and worktree cleanup on 2026-09-17. Scheduling had already landed through PR #10; the target was `150d2a6`. Synchronizing `main` into segmentation produced one content conflict, in `apps/backend/src/Api.integration.test.ts`, because both lanes inserted tests at the same location. The conflict was reported and resolved by retaining the complete segmentation test and both scheduling tests. All other files merged automatically. Comparing added and removed lines across all 16 changed files confirmed that the integration preserved the original PR changes over the new target without dropping scheduling changes.

Validation in the merged worktree: unrestricted `pnpm check` passed formatting, warning-denying lint, typechecking, all **665 unit tests across 29 files**, and import smoke checks. Manual CLI help confirmed both `campaigns create --filter` and `campaigns schedule --at`. A direct storage/schema probe confirmed a scheduled campaign retains its filter in `getCampaign` and `beginRun`, the run condition still admits scheduled campaigns, and impossible calendar dates remain rejected. No AWS integration suite or deployment was repeated for this merge; earlier live gates remain recorded above and in the scheduling work log.

The synchronization commit is `725531d`; PR #9 was merged into `main` with `--no-ff` as `02453a8` and pushed to `origin/main`. The resulting tree matched the validated segmentation branch exactly. GitHub confirmed PR #9 as merged. The worktree and local/remote segmentation branch were then removed after checking that all branch commits were reachable from `main`; only the main worktree remains. The private environment backup is untracked and ignored. No application source changed after validation.
