# Code review: campaign listing implementation

## Review constraints

| Axis | Selection |
|---|---|
| Target | Worktree `/home/operator/worktrees/emailer/campaign-listing`, branch `campaign-listing`, uncommitted diff vs `5f62e7a` |
| Baseline | Plan-backed: `.adr/work/campaign-listing.md` (T1–T5). Constrained by ADR-0005 (sparse `gsi1`, `<createdAt>#<id>` cursor), ADR-0008 (bind only used operations), ADR-0011 (campaign record shape), `wiki/aws/dynamodb.md` (GSI/batch/order) |
| Scope | Full T1–T5 implementation in this worktree |
| Invocation | Standalone |
| Output | `.adr/work/campaign-listing-implementation-review.md` |
| Dimensions | Correctness; shared listing-order invariant; public contract; tests/validation; security/data; plan matrix |
| Validation/tools | Inspected source, tests, ADRs, wiki, installed find-my-way router, `git diff 5f62e7a`. Did not rerun `pnpm check` (parent reported green). Did not run integration/deploy |
| Writes/artifacts | This report only. No source edits, no commits, no deploy |

Parent-authorized deviations (not findings unless they fail):

1. `campaignStoreOperations` still takes `tokens` and passes them to `allPrimitives`.
2. `Audience.ts` one-sentence rewrite so it is no longer “the only capability that needs all six operations”.
3. T5 is a new small HTTP live case with GSI eventual-consistency retry (mirroring contact listing) rather than a one-shot assert inside the 60-contact send.
4. Parent oxfmt on `Campaigns.ts` plus two anti-slop blank lines (`Campaigns.test.ts`, `Api.integration.test.ts`).

## Summary

T1–T4 match the plan. Campaign META items join the existing sparse `gsi1` on create; `readEntityPage` restores index order by walking requested keys after a `pk.S` index of the batch; `listCampaigns` shares `campaignOf` with `getCampaign`; `GET /campaigns` / `campaigns list` use the same page/cursor contract as contacts and lists. Send and feedback writes still omit `gsi1*`. `CampaignStoreLive` now binds `BatchGetItem`; both Lambdas already provided `AudienceStoreLive`, so no new IAM action appears on either role.

No admitted findings. Live `test-list` deploy has not run; that is a validation gap, not an implementation defect. The T5 assertion is present.

**Recommend: ship** the implementation. Do not fix-now. Parent still owes the ephemeral live gate before merge.

## Related decomplex review

- **Report:** none
- **Owner disposition summary:** n/a

## Coverage

### Inspected

- Plan `.adr/work/campaign-listing.md` (full)
- ADR-0005, ADR-0008 (headers + bodies), ADR-0011 (campaign shape / bindings)
- `wiki/aws/dynamodb.md` (GSI eventual consistency, `KEYS_ONLY` + consistent `BatchGetItem`, unordered batch, omitted keys, UTF-8 sort)
- Diff vs `5f62e7a` for all 22 changed files
- `Storage/Primitives.ts` `readEntityPage` / `allPrimitives`
- `Storage/Items.ts` `listingAttributes` / `listingIndexName`
- `Storage/Campaigns.ts` create/get/list/`campaignOf`/`CampaignStoreLive`/send+skip Puts / META updates
- `Storage/Contacts.ts`, `Storage/Lists.ts` (sort removal), `Storage/Membership.ts` (`listMembers` still sorts)
- `Storage/Feedback.ts` history Put; `Storage/Addresses.ts` suppression key
- `Storage/Audience.ts`, `Storage/Testing.ts`, `Storage/Table.ts` GSI declaration
- Domain `Campaigns.ts` `list`; `Lists.ts` template
- `packages/api/src/Api.ts` `CampaignsGroup` + contacts comment; `apps/backend/src/Api.ts` handlers + Lambda layers
- CLI `Commands.ts` `campaignsList`; `README.md`
- Tests: `Primitives.test.ts`, `Campaigns.test.ts` (storage + domain), `Lists.test.ts`, `Api.test.ts`, `Dispatching.test.ts`, `Commands.test.ts`, `Api.integration.test.ts`
- Installed Effect find-my-way router (`ignoreTrailingSlash`, duplicate method+pattern, static child before parametric)
- `Api.ts` / `Dispatcher.ts` store live layers

### Skipped or partial

- Did not read `.adr/work/campaign-listing-review.md` (plan review; out of authority)
- Did not rerun `pnpm check` or any unit suite
- Did not deploy `--stage test-list` or run `pnpm test:integration`
- Did not run `pnpm emailer campaigns list --help` (flags are the shared `entityPageFlags`; parent reported the help text)
- Lane B (`campaign-html-bodies`) and MCP: out of scope
- Did not inspect generated IAM JSON from a deploy

### Required boundaries

- Shared `readEntityPage` used by contacts, lists, and campaigns
- Sparse `gsi1` writers (contact/list/campaign META only)
- `CampaignStore` fakes (`Api.test.ts`, `Campaigns.test.ts`, `Dispatching.test.ts`) and CLI `handleAll`
- `CampaignStoreLive` IAM vs existing `AudienceStoreLive` on both Lambdas
- HTTP `/campaigns` vs `/campaigns/:id`
- Live listing assertion vs unrun stage

## Validation

- **Run:** none this round (read-only review). Parent reported `pnpm check` green (format, lint, typecheck, 568 unit tests, import smoke) and targeted unit reruns per T1–T4.
- **Skipped/unavailable:** `pnpm test:integration` on `test-list`; alchemy deploy/destroy; CLI help; full suite rerun.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** The plan is complete and testable: one path for the third listable kind, shared order restoration, shared campaign projection, no new index, no backfill, named live gate. ADR amendments are header-only by design, so Decision-section sentences that still say “contact and list META only” / CampaignStore’s five bindings are stale in the body and accurate in the `Amended:` line — an accepted lifecycle choice, not an implementation hole. Residual baseline gap is the still-open live deploy, which the plan itself leaves to the parent.

2. **Implementation compliance:** T1–T4 are **Complete**, including the four parent-authorized deviations. T5’s assertion is **Complete** in source; the live run and the two-cursor manual check are **Unverifiable**. No Incorrect / Missing implementation rows. Matrix distribution: Complete except the live-validation rows.

3. **Implementation quality beyond the baseline:** No material defect beyond what the plan already accepted. Order restoration by `pk.S` is correct for the META-only keys `contactKey` / `listKey` / `campaignKey` produce; items whose `pk.S` is missing are dropped like a batch miss (DynamoDB always returns table keys on a hit). Send/feedback Puts do not write `gsi1*`. `campaignOf` preserves `getCampaign`. Static `/` and parametric `/:id` cannot collide in the installed router. `CampaignStoreLive` binding `BatchGetItem` does not add a new action to either Lambda.

4. **Test and validation quality:** Layered tests match the plan (one new behaviour per layer). The primitive reversed-batch case is the order net; Lists remains the caller-level net; campaign storage tests pin index attributes, `:kind = "campaign"`, and draft+paused projection. Domain last-page test actually protects key omission (`not.toHaveProperty("nextCursor")` against a fake that returns `nextCursor: undefined`). API/CLI tests use in-memory insertion order and do not claim DynamoDB order — they are not false-green for the assertions they make. Live listing is not false-green: timeout becomes `None` and the expect fails. Live evidence itself is unrun.

## Plan compliance matrix

| Authority item / implied requirement | Expected evidence | Implementation evidence | Validation / test evidence | Status |
|---|---|---|---|---|
| T1 `readEntityPage` restores index order by `pk.S`; missing batch keys absent (self-repair); callers do not sort | Walk requested keys after Map of hydrated `pk.S`; doc comment says UTF-8 index order | `Primitives.ts:363-383` builds `byPk` from `item.pk?.S`, walks `keys`, skips absent; comment at `315-319` | `Primitives.test.ts:345-381` omission + reversed batch. Pre-existing cursor/nextCursor cases unchanged | Complete |
| T1 delete `listContacts` / `listLists` post-hydration `localeCompare` | Sorts and comments gone; decode-then-return | `Contacts.ts:237-256`, `Lists.ts:77-94` — no sort | `Lists.test.ts:70-90` still reversed-batch, renamed to “index order”. `listMembers` still sorts by id (`Membership.ts:249-250`) | Complete |
| T1 `allPrimitives` comment: audience + campaign stores | Comment rewritten | `Primitives.ts:464-467` | n/a (comment) | Complete |
| T1 `Testing.ts` CampaignStore-subset paragraph | Paragraph no longer calls CampaignStore a small operations subset | `Testing.ts:165-173` | n/a | Complete |
| T1 `listingIndexName` comment: listable META (contact, list, campaign); send/feedback do not touch it | Comment + create-only `listingAttributes` on META | `Items.ts:13-18`; `Campaigns.ts:199-202` spreads `listingAttributes(campaignKind, …)` on META Put | `Campaigns.test.ts:315-334` asserts `gsi1pk=campaign`, `gsi1sk=<createdAt>#<id>` | Complete |
| T1 delete `CampaignTableOperations`; `campaignStoreOperations(operations, tokens) => campaignOperations(allPrimitives(…))`; widen `campaignOperations` with `PagePrimitives` | Type gone; compose like audience store; tokens kept | `Campaigns.ts:188-195`, `626-627`. No `CampaignTableOperations` | `pnpm typecheck` green (parent) | Approved deviation |
| T1 `CampaignStoreLive` binds all six ops + six Http layers, including `BatchGetItem` | Mirror `AudienceStoreLive` | `Campaigns.ts:635-665` vs `Audience.ts:42-71` | IAM implication: both Lambdas already `provide(AudienceStoreLive)` (`Api.ts:214-216`, `Dispatcher.ts:105-107`) which already constructs `BatchGetItem` (`Audience.ts:51,65`). No new action on either role | Complete |
| T1 `campaignKind`, `listCampaigns` via `readEntityPage` + `decodeStoredCampaign` + `campaignOf`; `StoredPage<Campaign, string>` | New op on the store object | `Campaigns.ts:32`, `236-255`, `604-607` | `Campaigns.test.ts:338-400`: `:kind=campaign`, draft then paused in index order when batch reversed | Complete |
| T1 extract `campaignOf`; `getCampaign` uses it (get/send/resume behaviour unchanged) | Same six-field projection + `decodeSubmission(submissionOf)` | `Campaigns.ts:138-148`, `222-234` | Existing getCampaign state/corrupt cases still pass through `campaignOf` (`Campaigns.test.ts:216-312`) | Complete |
| T1 fakes: dispatch `notExercised("listCampaigns")`; `Api.test.ts` in-memory slice like `listContacts`; `Campaigns.test.ts` in-memory list | Exhaustive `CampaignStore` objects typecheck | `Dispatching.test.ts:160`; `Api.test.ts:367-374`; `Campaigns.test.ts:95-99` | Parent typecheck green | Complete |
| T1 ADR-0005 / ADR-0008 one `Amended:` header line each, pointing at this work doc | Header only; no new ADR; bodies untouched | ADR-0005:8; ADR-0008:10 | n/a | Complete |
| T1 extra: Audience.ts “only capability” sentence | One-sentence rewrite | `Audience.ts:22` | n/a | Approved deviation |
| T2 `Campaigns.list` shaped like `Lists.list` | Omit `nextCursor` key when absent | `Campaigns.ts:28-39` vs `Lists.ts:31-42` | `Campaigns.test.ts:269-281` | Complete |
| T3 `CampaignsGroup` `GET list "/"` after create; `listingQuery`; `page(Campaign, EntityCursor)`; errors `BadRequestNoContent`, `StorageUnavailable` | Endpoint on the typed API | `packages/api/src/Api.ts:169-173` | `Api.test.ts:1316-1339` | Complete |
| T3 reword contacts comment: static segment wins regardless of declaration order | Comment only | `packages/api/src/Api.ts:56` | Installed router: `FindMyWay/internal/router.ts:47` (`ignoreTrailingSlash: true`), `247-248` (duplicate method+pattern throws), `664-673` (static child before parametric) | Complete |
| T3 handler `list: (request) => publicly(Campaigns.list(pageOf(query), query.cursor))`; `handleAll` exhaustive | Handler present; compile-time exhaustiveness | `Api.ts:68-75` | `Api.test.ts:1316-1339`: limit 1, listed item `toStrictEqual` create payload including `submission: { state: "draft" }`. Shared 400/401 not repeated | Complete |
| T4 `campaignsList` with `entityPageFlags`, description “List campaigns in the order they were created”, defined after resume, last in `campaigns` subcommands | Away from `campaignsCreate` (lane B) | `Commands.ts:456-476` | `Commands.test.ts:317` in-memory `handleAll.list`; `620-643` JSON `items` | Complete |
| T4 README `campaigns list` beside other campaign commands | One example line | `README.md:87` (after `campaigns get`) | n/a | Complete |
| T5 live assertion: created campaign id appears in `campaigns.list`, with GSI retry | New small HTTP case (authorized) | `Api.integration.test.ts:614-666` under “the deployed listing index”; 2s repeat / 45s timeout / cursor walk, same shape as contact listing at `547-575` | Live deploy of `test-list` has not run | Complete (code) / Unverifiable (runtime) |
| T5 `pnpm test:integration` green on `--stage test-list`, then destroy | Parent-owned deploy | Assertion present | Not run | Unverifiable |
| T5 manual: `campaigns list --limit 1` twice with cursor, two different campaigns in created order | Operator check | CLI wiring exists | Not run | Unverifiable |
| Final acceptance: `pnpm check` green | format/lint/typecheck/unit/import smoke | Diff compiles; parent reran | Parent: green (568 unit tests). Not re-run here | Complete (parent evidence) |
| Outcome: created-order listing, same cursor contract as contacts/lists; no backfill | `listingAttributes` + `readEntityPage` + `EntityCursor` page schema | Create writes `gsi1sk=<createdAt>#<id>` (`Items.ts:87-90`); wire `Schemas.page(Campaign, EntityCursor)` (`Api.ts:169-171`); domain cursor pass-through (`Campaigns.ts:34`) | Primitive resume/nextCursor tests; live cursor walk unrun | Complete (unit) / Unverifiable (live order/cursor) |
| Out of scope held: no second index; no filters; no get/send/resume redesign; no MCP; `listMembers` keeps its own sort | No extra GSI; send/resume code paths are still UpdateItem/SQS | `Table.ts:16-26` still one GSI `KEYS_ONLY`; `enqueueCampaign`/`resumeCampaign` unchanged except living beside `listCampaigns`; Membership sort remains | n/a | Complete |
| ADR-0005 implied: sparse index — send/feedback items must not gain `gsi1` | META-only `listingAttributes`; other Puts omit the attributes | Claim Put `Campaigns.ts:387-397`; skip Put `426-437`; feedback history Put `Feedback.ts:99-123`; suppression key `Addresses.ts:19` — no `gsi1pk`/`gsi1sk`. META updates are `SET`/`ADD`/`REMOVE` of state fields only (`274-601`), so create-time index attributes persist | No unit test asserts send items lack `gsi1`; inspection of every campaign/feedback Put is the evidence | Complete |
| ADR-0008 implied: capability binds only operations it uses | CampaignStore now uses `BatchGetItem` via `readEntityPage`, so it must bind it | `Campaigns.ts:643-644,658` | Same as T1 IAM row | Complete |
| ADR-0011 implied: campaign record shape unchanged | Listing is additive attributes + a read; states/counters/submission projection unchanged | `StoredCampaign` schema untouched; `campaignOf` is the previous inline projection | Existing decode-every-state / reserved-word tests kept | Complete |
| Wiki implied: GSI eventually consistent; batch unordered; omit missing; hydrate `KEYS_ONLY` with consistent `BatchGetItem` | Primitive already did this; order restore added | `readItems` `ConsistentRead: true` (`Primitives.ts:265`); index query has no `ConsistentRead` (pre-existing test `384-393`); Map+walk restores order | Primitive tests | Complete |
| Public contract: `GET /campaigns` vs `GET /campaigns/:id` do not conflict | Static `/` and parametric `/:id` at the campaigns prefix | `packages/api/src/Api.ts:169-177` (`list "/"` then `get "/:id"`). Lists already declared `get "/:id"` before `list "/"` | Installed find-my-way static-before-parametric (`router.ts:664-673`); `Api.test.ts` hits `GET /campaigns` | Complete |
| Exhaustive handlers/fakes | `handleAll` + every `Layer.succeed(CampaignStore)` includes `listCampaigns` | API `Api.ts:69-75`; CLI `Commands.test.ts:249-317`; three CampaignStore fakes as T1 | Typecheck (parent) | Complete |

### Approvals and conflicts

- **Approved deviation:** `campaignStoreOperations` keeps `tokens` and passes them to `allPrimitives` (plan shorthand omitted tokens; parent authorized).
- **Approved deviation:** `Audience.ts:22` rewritten so AudienceStore is not “the only capability that needs all six operations”.
- **Approved deviation:** T5 is a new small HTTP live case with GSI retry under “the deployed listing index”, not an assert inside the 60-contact send.
- **Approved deviation:** Parent oxfmt / two blank lines. No behavioural effect.
- **Authority conflict:** none. ADR-0005/0008 Decision bodies still describe the pre-listing index/bindings; the plan required header `Amended:` lines rather than body edits, and those lines are present.

## Follow-up closure

- **Round and material delta:** Round 1 of the implementation review (not the plan review). First pass against `5f62e7a` → current worktree.
- **Closure state:** Clear
- **Resolved or withdrawn:** n/a
- **Still material:** none
- **New fix-caused or fix-exposed findings:** none

## Findings

No admitted findings.

## Context-dependent concerns

- **Concern:** Live `test-list` deploy, `pnpm test:integration`, stage destroy, and the two-cursor manual check are still open. The T5 test will fail closed if the index write or query is wrong (`timeoutOrElse` → `None` → `expect(id)` fails), but that has not been observed on AWS.
- **Disposition:** Parent-owned validation, not an implementation defect. Do not merge to `main` until that gate runs (plan handoff already says this).

## Confirmed-good areas

- **Order restoration vs missing/corrupt keys.** Requested keys always come from `contactKey` / `listKey` / `campaignKey`, each of which sets `pk.S` and `sk=META`. Hydration is META-only, so Map-by-`pk.S` does not collide with `SEND#` / `LISTOF#` items that share a partition. A batch miss is skipped (existing self-repair). An item without `pk.S` is also skipped; DynamoDB returns table keys on every hit, so that branch is defensive rather than a drop of real META rows. Contacts and lists still page through the same primitive; their caller sorts are gone; `listMembers` still sorts by contact id on the base-table path.
- **Sparse index.** Only `createCampaign` (and the existing contact/list creates) write `listingAttributes`. Send/skip Puts, feedback history, and suppression items do not. Subsequent campaign META writes are `UpdateItem` `SET`/`ADD`/`REMOVE` of state/cursor/counters and do not strip `gsi1*`.
- **`campaignOf` vs `getCampaign`.** Same `decodeSubmission(submissionOf)` plus the six public fields. Corrupt submission still fails the read. List uses the same function with `corrupt("listCampaigns")`.
- **Routes.** `GET /campaigns` and `GET /campaigns/:id` are static `/` vs parametric `/:id` under prefix `/campaigns`. Installed find-my-way tries the static child first; duplicate method+pattern throws; trailing slashes ignored. `EntityId` would 400 a GET `/campaigns/list` anyway.
- **IAM.** `CampaignStoreLive` now constructs `BatchGetItem` (required, because `listCampaigns` uses it). API and dispatcher already constructed it via `AudienceStoreLive`. Duplicate statements, same action, same table — no Lambda gains a grant it did not already hold.
- **Exhaustiveness.** `handleAll` on the API group and the CLI in-memory group include `list`. Three `CampaignStore` fakes include `listCampaigns` (real in-memory or `notExercised`).
- **Tests not false-green for their claims.** Reversed-batch order is asserted against hydrated items at the primitive and against projected campaigns at `listCampaigns`. Domain last-page test fails if `nextCursor: undefined` leaks as a key. API `toStrictEqual([first])` includes submission. Integration timeout does not succeed the expect.

## Limitations and caveats

- Live AWS behaviour (GSI propagation, IAM on the deployed role, created-order across real pages) is unrun.
- Campaign storage listing test, like Lists, scripts full items on the Query reply; the primitive test is what distinguishes index entries from hydrated items.
- In-memory API/CLI fakes ignore cursor and use Map insertion order; they do not protect DynamoDB order (storage tests do).
- ADR-0005/0008 Decision-section sentences about who writes `gsi1` / which ops CampaignStore binds remain historically worded; headers carry the amendment.
- Did not inherit or re-litigate plan-review findings.

## Next steps

1. Parent: deploy `--stage test-list`, run `pnpm test:integration`, optional manual two-page `campaigns list`, then destroy the stage.
2. No implementation fix round from this review.
3. Merge to `main` only when the user asks, after the live gate (and after this lane, so lane B can merge `main`).
