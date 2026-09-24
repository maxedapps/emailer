# Campaign listing

> **Status:** Complete
> **ADRs:** None new. Constrained by [0005](../0005-contact-identity-and-membership-access-paths.md) (the sparse `gsi1` listing index and the `<createdAt>#<id>` cursor; gets an `Amended:` line, see T1), [0008](../0008-storage-capabilities-and-error-boundaries.md) (one capability binds only the operations it uses; same), [0011](../0011-open-recipient-set-and-paced-dispatch.md) (campaign record shape).
> **Updated:** 2026-09-16
> **Lane:** Round 1, lane A of [campaigns-next-lanes](campaigns-next-lanes.md). Runs in parallel with lane B ([campaign-html-bodies](campaign-html-bodies.md)). Worktree `~/worktrees/emailer/campaign-listing`, branch `campaign-listing`, Emailer stage `test-list` (ephemeral). **Merges first**; lane B merges `main` afterwards.

## Outcome and boundaries

- **Problem and target:** campaigns can be created, fetched by id, sent and resumed, but never enumerated. An operator who loses an id has no way back to the campaign. Target: `GET /campaigns` and `emailer campaigns list` page campaigns in created order with the same cursor contract contacts and lists already use. A campaign created before this change stays invisible (no production data exists; no backfill).
- **In scope:** the listing index attributes on the campaign `META` item; `listCampaigns` in the campaign store over the existing page primitive; the campaign store composed from all six table operations like the audience store; `Campaigns.list`; the `list` endpoint on `CampaignsGroup`; the API handler; the CLI subcommand; unit tests at the layers that add behaviour; one live assertion in the existing integration suite; README; lifecycle lines on the two ADRs whose statements this changes.
- **Out of scope:** any second index (by state, by list); filters of any kind; HTML bodies, scheduling, segmentation (other lanes); backfilling existing rows; changing `get`, `send`, `resume`; the MCP app.
- **Approach:** the campaign is the third listable entity kind and takes exactly the path the first two took: `listingAttributes("campaign", createdAt, id)` on create, `readEntityPage` for a page, `page(Campaign, EntityCursor)` on the wire, `entityPageFlags` in the CLI. Two things are written once instead of a third time: the ordering of a hydrated page moves from the two callers that each restore it into `readEntityPage`, which knows the index order; and the stored-to-domain campaign projection that `getCampaign` performs inline becomes one function both reads share. Because the campaign store now uses every table operation, it is composed from `allPrimitives` exactly as the audience store is, and the type that picked a subset goes away.

## Key files, evidence, and decisions

| File or source | Why it matters | Decision or plan impact |
|---|---|---|
| `apps/backend/src/Storage/Items.ts:13-18, 83-90` | `listingIndexName = "gsi1"`; `listingAttributes(kind, createdAt, id)` writes `gsi1pk`/`gsi1sk`; the comment says the index is written only to contact and list items | T1 writes the attributes on the campaign item and rewrites that comment |
| `apps/backend/src/Storage/Primitives.ts:319-379, 432-449` | `readEntityPage(operationId, kind, keyOf, limit, cursor)`: index query for keys in `gsi1sk` order, then `readItems` (batch, consistent) which does not preserve order; the cursor is `LastEvaluatedKey.gsi1sk`. `allPrimitives` with a comment saying `AudienceStore` is its only production caller | T1 adds the order restoration in the primitive, once; `allPrimitives` gains a second caller and the comment is rewritten |
| `apps/backend/src/Storage/Lists.ts:76-98`, `Storage/Contacts.ts:245-259` | Both callers sort hydrated items by `<createdAt>#<id>` with `localeCompare` after the batch read, with the same comment | T1 deletes both sorts once the primitive orders (in index byte order, which the locale sort only approximated) |
| `apps/backend/src/Storage/Campaigns.ts:33-36, 45-68, 105-140, 180-230, 584-626` | `CampaignTableOperations` picks five of the six operations; `StoredCampaign`; `submissionOf`; `createCampaign` item without index attributes; `getCampaign` projects inline; `campaignStoreOperations` hand-composes primitives; `CampaignStoreLive` binds five operations, `Query` among them although nothing queries | T1: with `batchGetItem` the pick is the whole `TableOperations`, so the type is deleted and the store is `campaignOperations(allPrimitives(operations))`; shared projection; `listCampaigns` |
| `apps/backend/src/Storage/Audience.ts:40-66`, `apps/backend/src/Api.ts:214`, `Dispatcher.ts:106-107` | The precedent for `allPrimitives` and for binding all six operations with their Http layers; both Lambdas already provide `AudienceStoreLive`, so both already hold `dynamodb:BatchGetItem` on the table | `CampaignStoreLive` mirrors `AudienceStoreLive`; no Lambda gains a grant |
| `apps/backend/src/Storage/Testing.ts:70-75, 143-162` | The scripted table already answers `batchGetItem`; `primitivesFor` is `allPrimitives`; a paragraph says `CampaignStore` is small enough for suites to state its operations in full | T1: no test-seam change; that paragraph is rewritten |
| `apps/backend/src/Storage/Lists.test.ts:39-53, 70-91` | The two listing tests a listable kind has: index attributes on create; own partition queried and order restored | T1 tests mirror them exactly; the Lists case stays as the caller-level net |
| `apps/backend/src/Storage/Primitives.test.ts:246-363` | `readEntityPage` cases: cursor resume, `nextCursor` from `LastEvaluatedKey`, omitted key dropped (`:335-351`) | T1 adds one ordering case; cursor behaviour is not re-pinned per kind |
| `apps/backend/src/Lists.ts:31-42` | Domain `list` shapes the page (`nextCursor` omitted when absent) | T2 mirrors it |
| `packages/api/src/Api.ts:29-32, 51-66, 100-109, 157-186` | `listingQuery`; the contacts comment claims declaration order matters; lists declare `get "/:id"` **before** `list "/"` and work | T3 adds the endpoint; the comment is corrected |
| `apps/backend/src/Api.ts:35-36, 68-75` | `pageOf(query)`; `campaignsHandlers.handleAll` is exhaustive | T3 |
| `apps/cli/src/Commands.ts:71-112, 274-284, 456-459` | `entityPageFlags`, `pageQuery`, `listsList` as the template, the `campaigns` subcommand list | T4 |
| `apps/backend/src/Api.test.ts:117-124, 354-412`, `Campaigns.test.ts:89-121`, `Dispatching.test.ts:153-158`, `apps/cli/src/Commands.test.ts:248-279` | Three `Layer.succeed(CampaignStore)` fakes (the `Api.test.ts` one is the full in-memory store; `listContacts` at `:117-124` is the shape a real `listCampaigns` copies) plus the CLI test's exhaustive in-memory API group | T1 stubs the two dispatch-side fakes and writes the real in-memory `listCampaigns`; T4 adds the CLI group handler |
| `apps/backend/src/Api.integration.test.ts:95-125`, `apps/backend/test/IntegrationSupport.ts` | The live suite creates a campaign against a deployed stage through the typed client | T5 adds one listing assertion: the index write and query on a real table |
| `.adr/0005-*.md:6-7, 39`, `.adr/0008-*.md:22` | ADR-0005 says the index is written only to contact and list items; ADR-0008's table lists `CampaignStore` bindings; both carry header lifecycle lines ("Superseded in part: [ADR-…]") | T1 adds one `Amended:` line to each, pointing at this work document since no new ADR exists |
| `README.md:78-104` | CLI examples per entity | T4 adds `campaigns list` |
| Effect `4.0.0-rc.112`, `node_modules/effect/src/unstable/http/FindMyWay/internal/router.ts:47, 247-248, 664-673` | Radix-tree lookup tries the static child before the parametric one regardless of registration order; `ignoreTrailingSlash` defaults to true; a duplicate method+pattern throws at registration | `/campaigns` and `/campaigns/:id` cannot conflict; no ordering rule to follow |

- **Open gate:** none.

## Research

- **Route order is not a rule.** The HttpApi router is a vendored find-my-way radix tree: a static segment always beats a parametric one at the same depth, and `GET /campaigns` and `GET /campaigns/:id` live at different depths. The lists group already declares `get "/:id"` before `list "/"` and its tests pass. The comment in the contacts group reaches the right outcome for the wrong reason and is reworded in T3 so the next group does not inherit a superstition.
- **Ordering belongs to the primitive.** `readEntityPage` reads the index in `gsi1sk` order, collects the keys in that order, and hands the batch result back unordered; `listContacts` and `listLists` each re-sort by rebuilding `<createdAt>#<id>` with `localeCompare`. The primitive can instead emit hydrated items in the order of the keys it requested: every listable `META` item has a unique `pk` and `sk = "META"`, so keying the batch result by `pk` and walking the requested keys is sufficient, and it yields the index's byte order rather than a locale collation. `listMembers` keeps its own sort: it pages a different partition through `readItems` directly and orders by contact id.
- **The campaign store uses all six operations now.** It already bound `Query` without a user; with `BatchGetItem` for the page primitive the subset type it picks is the whole `TableOperations`, so it composes from `allPrimitives` like the audience store. Both Lambdas already provide `AudienceStoreLive` and therefore already hold every grant the campaign store now asks for; nothing about IAM changes.
- **No backfill.** Campaigns created before this change lack `gsi1pk`/`gsi1sk` and never appear in a listing. There is no production data, every test stage is ephemeral, and `get` by id still works.

## Tasks

#### T1 — Storage: ordered pages, index attributes, `listCampaigns`

- **Change:**
  - `apps/backend/src/Storage/Primitives.ts` `readEntityPage`: after `readItems`, return the hydrated items in the order of `keys`: index the batch result by `pk.S` and walk the requested keys; a key the batch did not return is absent (the existing self-repair). Rewrite the doc comment: the page is in index order, which is byte order; callers do not sort.
  - `Storage/Lists.ts` `listLists` and `Storage/Contacts.ts` `listContacts`: delete the post-hydration sort and its comment.
  - `Storage/Primitives.ts:432-435`: rewrite the `allPrimitives` comment (two production callers: the audience store and the campaign store).
  - `Storage/Testing.ts:159-162`: rewrite the paragraph that describes `CampaignStore` as a small subset.
  - `Storage/Items.ts:13-17`: rewrite the `listingIndexName` comment so it says the index is written to listable `META` items (contact, list, campaign).
  - `Storage/Campaigns.ts`: delete `CampaignTableOperations`; `campaignStoreOperations = (operations: TableOperations) => campaignOperations(allPrimitives(operations))`; widen `campaignOperations`' parameter type by `& PagePrimitives`; `CampaignStoreLive` yields all six bindings and provides all six Http layers, mirroring `AudienceStoreLive`. Add `campaignKind = "campaign"`; `createCampaign` spreads `listingAttributes(campaignKind, campaign.createdAt, campaign.id)`; extract `campaignOf(stored)` (the `decodeSubmission(submissionOf(stored))` plus the six-field projection now inline in `getCampaign`) and use it from `getCampaign` and from the new `listCampaigns(limit, cursor)`, which is `readEntityPage("listCampaigns", campaignKind, campaignKey, limit, cursor)` followed by `decodeStoredCampaign` and `campaignOf` per item, returning `StoredPage<Schemas.Campaign, string>`.
  - `Campaigns.test.ts:89` and `Dispatching.test.ts:153` fakes: `listCampaigns: () => notExercised("listCampaigns")`. `Api.test.ts:354-412`: the in-memory store's `listCampaigns` slices the `campaigns` map like `listContacts` at `:117-124` (written here so `pnpm typecheck` is green at the end of T1; T3's test uses it).
  - `.adr/0005-contact-identity-and-membership-access-paths.md` and `.adr/0008-storage-capabilities-and-error-boundaries.md`: one header line each in the existing lifecycle-line position. No new ADR supersedes them, so the line points at this work document: `- Amended: [campaign-listing](campaign-listing.md) — campaign META items join the listing index` and `… — CampaignStore binds all six table operations`.
- **Starts at:** `Storage/Primitives.ts:319-379, 432-449`, `Storage/Campaigns.ts:33-36, 185-230, 563-626`, `Storage/Lists.ts:76-98`, `Storage/Contacts.ts:245-259`
- **Depends on:** none
- **Status:** Verified
- **Evidence:** Parent inspected the worktree diff vs `5f62e7a`. `readEntityPage` restores index order by `pk.S`; `listContacts`/`listLists` sorts removed; `campaignStoreOperations` is `allPrimitives`; `createCampaign` writes `listingAttributes`; `listCampaigns` + `campaignOf`; `CampaignStoreLive` binds all six; Amended lines on ADR-0005/0008. Parent reran `pnpm exec vitest run --project unit apps/backend/src/Storage` → 187 passed (10 files); `pnpm typecheck` → green. Extra vs plan (true): Audience.ts “only capability” sentence rewritten. Tokens kept on `campaignStoreOperations`.
- **Tests:** `Storage/Primitives.test.ts` (`unit`, `readEntityPage`) gains one case: a batch that answers in reverse yields a page in index order (extend the omission case at `:335-351` or add one case; not two). `Storage/Lists.test.ts:70-91` stays as the caller-level net and now passes through the primitive. `Storage/Campaigns.test.ts` (`unit`) gains the two cases `Lists.test.ts` has: `createCampaign` writes `gsi1pk = "campaign"` and `gsi1sk = <createdAt>#<id>`; `listCampaigns` queries `gsi1` with `:kind = "campaign"` and projects a draft and a paused item in index order when the batch answers reversed. The reserved-word assertion keeps passing (no new expression).
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Storage`; expect green.
  - Run `pnpm typecheck`; expect green once the two fakes carry the stub.
- **Risk/recovery:** the reorder in `readEntityPage` changes shared behaviour for contacts and lists; the Lists listing test and the new primitive case are the regression net.

#### T2 — Domain: `Campaigns.list`

- **Change:**
  - `apps/backend/src/Campaigns.ts`: add `list(limit, cursor)` shaped exactly like `Lists.list`, over `CampaignStore.listCampaigns`.
- **Starts at:** `apps/backend/src/Campaigns.ts:16-26`, `Lists.ts:31-42`
- **Depends on:** T1
- **Status:** Verified
- **Evidence:** Parent inspected diff: `Campaigns.list` matches `Lists.list`; last-page test asserts missing `nextCursor` key. Parent reran `pnpm exec vitest run --project unit apps/backend/src/Campaigns.test.ts` → 13 passed.
- **Tests:** `apps/backend/src/Campaigns.test.ts` (`unit`): one case, a last page comes back without a `nextCursor` key.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Campaigns.test.ts`; expect green.
- **Risk/recovery:** none beyond T1.

#### T3 — Contract and API handler

- **Change:**
  - `packages/api/src/Api.ts` `CampaignsGroup`: add `HttpApiEndpoint.get("list", "/", { query: listingQuery, success: Schemas.page(Schemas.Campaign, Schemas.EntityCursor), error: [HttpApiError.BadRequestNoContent, Schemas.StorageUnavailable] })` after `create`.
  - `packages/api/src/Api.ts:56`: reword the contacts comment to the actual rule (a static segment wins over `:id` in the router regardless of declaration order).
  - `apps/backend/src/Api.ts` `campaignsHandlers`: `list: (request) => publicly(Campaigns.list(pageOf(request.query), request.query.cursor))`.
- **Starts at:** `packages/api/src/Api.ts:157-186`, `apps/backend/src/Api.ts:68-75`
- **Depends on:** T2
- **Status:** Verified
- **Evidence:** Parent inspected diff: `CampaignsGroup.list` after create; contacts comment reworded; handler wired; one API test honours limit and includes submission. Parent reran `pnpm exec vitest run --project unit apps/backend/src/Api.test.ts packages/api` → 135 passed (3 files). CLI `handleAll` is expected red until T4.
- **Tests:** `apps/backend/src/Api.test.ts` (`unit`, real router over the in-memory store): one case, `GET /campaigns` returns created campaigns with their `submission` and honours `limit`. Malformed cursor (400) and missing bearer (401) are already pinned once for the shared query and middleware (`:1128-1137`, `:504-513`) and are not repeated per group.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Api.test.ts packages/api`; expect green.
- **Risk/recovery:** the typed client is derived from the API, so the CLI and the integration helpers compile against the new endpoint without changes to `Client.ts`.

#### T4 — CLI and README

- **Change:**
  - `apps/cli/src/Commands.ts`: add `campaignsList` with `entityPageFlags`, description "List campaigns in the order they were created", defined after `campaignsResume` and registered last in the `campaigns` subcommands, away from `campaignsCreate`, which lane B edits.
  - `apps/cli/src/Commands.test.ts:248-279`: the in-memory service's campaigns group handles `list`.
  - `README.md:83-87`: add a `campaigns list` line beside the other campaign commands.
- **Starts at:** `apps/cli/src/Commands.ts:274-284, 456-459`, `README.md:78-90`
- **Depends on:** T3
- **Status:** Verified
- **Evidence:** Parent inspected diff: `campaignsList` after resume, last in subcommands; in-memory `list` handler; one CLI JSON `items` test; README line after `campaigns get`. Parent reran `pnpm exec vitest run --project unit apps/cli` → 32 passed; `pnpm emailer campaigns list --help` documents `--limit` and `--cursor`.
- **Tests:** `apps/cli/src/Commands.test.ts` (`unit`, real CLI process against the in-memory HTTP service): one case, `campaigns list` prints the page as JSON with `items`.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/cli`; expect green.
  - Run `pnpm emailer campaigns list --help`; expect the two flags documented.
- **Risk/recovery:** none.

#### T5 — Live gate on an ephemeral stage

- **Change:**
  - `apps/backend/src/Api.integration.test.ts`: in the first campaign case (or a new small case beside it), after `client.campaigns.create`, assert `client.campaigns.list({ query: { limit: 100 } })` contains the created id. This is the end-to-end proof that a campaign created through the deployed API carries the index attributes on a real table and comes back through the index query; the scripted-table unit tests cannot observe either.
- **Starts at:** `apps/backend/src/Api.integration.test.ts:95-125`
- **Depends on:** T4
- **Status:** Verified
- **Evidence:** Live assertion `includes a campaign created through the API` passed (989ms, then 1076ms). Full `node --env-file=.env.test … vitest run --project integration` on `--stage test-list`: 23 passed / 3 files. Manual `campaigns list --limit 1` then `--cursor` returned two different campaigns in created order (`aa302860-…` 13:45:48 then `fcc0d0fa-…` 13:46:16). First integration run had one empty-list send flake (`sending` vs `queued`); assertion now uses the file’s existing `submitted` states. Stage destroyed: alchemy 26 succeeded; `emailer-test-list-api` / dispatcher / unsubscribe / table all AWS 254 (not found).
- **Tests:** the assertion above (`integration`).
- **Verify:**
  - Run `pnpm check`; expect green.
  - Deploy with the README's command (`README.md:238-239`) at `--stage test-list`: `pnpm exec alchemy deploy --config alchemy.run.ts --stage test-list --env-file .env.test --profile emailer-test --yes --no-input`; point `.env.test` at the stage's URL and token; run `pnpm test:integration`; expect the listing assertion green. Then the matching `alchemy destroy` (`README.md:265`) for `test-list`.
  - Manual: `node --env-file=.env.test apps/cli/src/main.ts campaigns list --limit 1` twice, the second with the reported cursor; expect two different campaigns in created order.
- **Risk/recovery:** `get`, `send`, `resume` are untouched by this lane; a failing listing on the stage isolates to the index write or the page primitive.

## Final acceptance

- **Checks:** `pnpm check` green; `pnpm test:integration` green on `test-list`; the stage destroyed afterwards.
- **End state:** a campaign created through the API appears in `GET /campaigns` and `campaigns list` in created order, with the same cursor semantics as contacts and lists; the two pre-existing listings no longer sort in their callers; the campaign store is composed like the audience store; no new index; no new ADR, two lifecycle lines.
- **Deferrals or blockers:** filter-by-state, filter-by-list and any second index are out of scope by the briefing; backfill of pre-change campaigns is not done (no data to backfill); the wiki note on router matching semantics is written by lane B (T7 there), so the two lanes never edit the same wiki file.

## Handoff

- **Next action:** None. Merge to `main` only when the user asks (lane B then merges `main`).
- **Reviews:** Plan review [campaign-listing-review](campaign-listing-review.md) round 1 (14 findings, Revise) applied; round 2 **Clear**. Implementation review [campaign-listing-implementation-review](campaign-listing-implementation-review.md) Round 1 **Clear**, no findings. Dispositions: none. Empty-list send assertion aligned with `submitted` after a live race (not a review finding).
- **Deviations:**
  - `campaignStoreOperations` keeps `tokens` and passes them to `allPrimitives` (plan one-arg shorthand omitted them).
  - `Audience.ts` one-sentence rewrite so it is not “the only capability that needs all six operations”.
  - T5 is a new HTTP live case with GSI retry under “the deployed listing index”, not a one-shot assert inside the 60-contact send (plan allowed either).
  - Empty-list send integration assertion uses `submitted.includes(state)` after the dispatcher was already `sending` on `test-list`.
  - Parent oxfmt on `Campaigns.ts` and two anti-slop blank lines.
- **Resources:** Worktree `~/worktrees/emailer/campaign-listing` on branch `campaign-listing` retained (unique unmerged work). Stage `test-list` destroyed. Worktree `.env.test` is untracked and now points at the destroyed stage. Sibling `~/worktrees/emailer/campaign-html-bodies` untouched. Main checkout stays on `main`. Do not merge until the user asks.
- **Superseded:** the merge protocol below was written against a single-item campaign record; [campaign-body-item](campaign-body-item.md) moved the body to its own item on this branch and carries the current rebase protocol for lane B.
- **Merge protocol with lane B (HTML bodies):** this lane merges first; lane B merges `main` into its branch. Three textual conflicts are expected and resolve as follows. (a) `Storage/Campaigns.ts` `createCampaign`: lane A inserts `...listingAttributes(...)` inside the item literal, lane B wraps the literal in `withOptional(item, [["html", campaign.html]])`; the result is `withOptional({ ...campaignKey(id), ...listingAttributes(...), ... }, [["html", campaign.html]])`. (b) `Storage/Campaigns.ts` projection: lane A extracts `campaignOf`, lane B adds a conditional `html` spread; the spread goes inside `campaignOf`, which is the seam lane B's plan targets. (c) `README.md:83-87`: both lanes edit the campaign example block; keep both the `--html` example and the `campaigns list` line. Additive hunks that git merges on its own: `listCampaigns` beside lane B's `html` in the `CampaignStore` fakes, the `list` subcommand beside the `--html` flag in `Commands.ts`.
