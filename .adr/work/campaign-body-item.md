# Campaign body as its own item

> **Status:** Complete
> **ADRs:** [0014](../0014-campaign-body-item-and-summaries.md) (new; the split and the summary listing). Constrained by [0005](../0005-contact-identity-and-membership-access-paths.md) (single table, the `gsi1` listing index and its hydration), [0008](../0008-storage-capabilities-and-error-boundaries.md) (capabilities bind only what they use; error boundaries), [0011](../0011-open-recipient-set-and-paced-dispatch.md) (campaign states, run token, per-slice dispatch), [0013](../0013-repeat-safe-writes.md) (creates under a fresh identifier are `recordOnce`).
> **Updated:** 2026-09-16
> **Lane:** continues lane A on branch `campaign-listing`, worktree `~/worktrees/emailer/campaign-listing`, before [PR #7](https://github.com/maxedapps/emailer/pull/7) merges. Supersedes the handoff and merge protocol in [campaign-listing](campaign-listing.md). Lane B ([campaign-html-bodies](campaign-html-bodies.md), branch `campaign-html-bodies`, one commit ahead of `main`) merges `main` afterwards under the protocol in this document.

## Outcome and boundaries

- **Problem and target:** the campaign `META` item holds the body beside the counters the dispatcher increments on every recipient, and PR #7's listing returns that body for every item. DynamoDB charges an `UpdateItem` by the whole item, transactional writes twice, and a partition sustains about 1,000 write units a second, so a 64 KiB text already caps settlements near 7 a second against a paced 20, and lane B's 256 KiB HTML makes it about 1.5. A page of 25 such campaigns also exceeds the 6 MB buffered Function URL response. Target: the body lives in its own `BODY` item and `GET /campaigns` returns summaries hydrated from `META` alone. `create`, `get`, `send` and `resume` keep answering the full campaign.
- **In scope:** `CampaignSummary` and `CampaignBody` schemas with `Campaign` composed from them; the `list` endpoint on the summary; the `BODY` item and its schema; a two-put create; `getCampaignBody`; `getCampaign` over both items; `listCampaigns` and `beginRun` without the body; the dispatcher's per-slice body read; the three backend fakes; one CLI assertion; README sentence; ADR-0014 with a lifecycle line on 0011; lane B rebase protocol; PR #7 title and body; live gate on an ephemeral stage.
- **Out of scope:** HTML bodies (lane B); changing what `create`, `get`, `send` or `resume` return; any second index or filter; a delete for campaigns (none exists; no cascade to extend); backfill (no production data); `getCampaignRun`, claims, settlements, checkpoints, pauses; the MCP app (a stub); object storage for bodies.
- **Approach:** the campaign becomes two items under one partition key, `META` and `BODY`, each written with `recordOnce` under the fresh identifier, `BODY` first so that `META` is the commit point. Each access path reads what it needs: the listing hydrates `META`, the dispatcher reads `BODY` once per slice, `get` reads both. The wire contract mirrors the items: `Campaign = CampaignSummary + CampaignBody`. Nothing about the index, the cursor, the run token, the per-recipient rows or the domain module changes.

## Key files, evidence, and decisions

| File or source | Why it matters | Decision or plan impact |
|---|---|---|
| `packages/api/src/Schemas.ts:226-235, 288-294, 353-356` | `Campaign` is one literal struct with `text` in position four; `CreateCampaignPayload` unchanged; `page()` factory. No struct in the repo derives from another; Effect `4.0.0-rc.112` exposes `Struct.fields` (`node_modules/effect/src/Schema.ts:3495-3509`) | T1: `CampaignSummary`, `CampaignBody`, `Campaign = Struct({ ...Summary.fields, ...Body.fields })` — the repo's first `.fields` spread, chosen because it states the relation the change is about and gives lane B's `html` one home. JSON key order of `create`/`get`/`send`/`resume` responses changes (text last); no test depends on order |
| `packages/api/src/Api.ts:157-191` | `list` declares `page(Campaign, EntityCursor)`; the other four declare `Schemas.Campaign` | T1: `list` → `page(CampaignSummary, …)`; nothing else |
| Effect `4.0.0-rc.112` encoder | `Schema.encodeUnknownSync` drops undeclared keys (verified by both reviewers against the installed package) | Fakes may hand a full campaign to the summary endpoint; the real store returns real summaries |
| `apps/backend/src/Storage/Campaigns.ts:41-64, 77-87, 138-148, 190-255, 320-366` | `StoredCampaign` (one schema for four readers); `CampaignRun.text`; `campaignOf`; `createCampaign` via one `recordOnce` with a single-key idempotency comment; `getCampaign` one `readItem`; `listCampaigns`; `beginRun` returns `ALL_NEW` attributes of `META`, which structurally cannot carry a sibling item | T2: `text` leaves `StoredCampaign`; `StoredCampaignBody = { v, text }`; `bodyKey`; `summaryOf`; create is two `recordOnce` puts; `getCampaign` = `readItem` META then BODY; `getCampaignBody`; `CampaignRun` loses `text` |
| `apps/backend/src/Storage/Primitives.ts:126-132` | `recordOnce`: conditional put, condition failure reported as done — the repeat-safe form for a fresh key (ADR-0013) | Two puts, BODY first: a lost response on either is replayed as done; a crash between them leaves an orphan body under an identifier nobody holds, which no read or index can reach |
| `apps/backend/src/Storage/Contacts.ts:258-282` | `getContactByEmail`: two dependent `readItem`s in one operation | T2 follows it for `getCampaign`. Not `readItems`: unordered, and `readEntityPage` keys hydrated items by `pk`, which META and BODY share |
| `apps/backend/src/Storage/Membership.ts:211-214` | `listMembers` answers `none` only for a missing list; an existing empty list answers an empty page | The dispatcher's body read sits after the page read: a pause exit or a missing list never pays for it; an empty existing list reads it once and completes |
| `apps/backend/src/Storage/Testing.ts:57-113` | Scripted replies are served by call order per operation; requests captured in `putItemRequests`, `getItemRequests`, … | T2 tests: every `getCampaign` consumes two `getItem` replies (META, BODY) — arrays interleave, not append; create captures `putItemRequests[0]` (BODY) and `[1]` (META) |
| `apps/backend/src/Storage/Campaigns.test.ts:100-130, 138-312, 315-335, 338-398, 484-600` | `meta()` fixture hard-codes `text`; `campaign records` scripts five `getItem` replies at 220-249 for five `getCampaign` calls; three tests read `putItemRequests[0]` (153, 195, 330); `beginRun` cases assert `text: "Body"` (505, 548, 584) | T2 fixtures: `meta()` without `text`, `body()` with it; ten interleaved replies; index shift to `[1]` for META; `beginRun` expectations without `text` |
| `apps/backend/src/Storage/Feedback.ts:125-133` | `addCampaignCounter` is the only other META writer (`ADD`, `attribute_exists(pk)`) | Unaffected; benefits from the lean item |
| `apps/backend/src/Campaigns.ts:16-143` | `get`, `send`, `resume` read `getCampaign`; `list` pages what the store returns | Untouched: types flow from the store and the contract |
| `apps/backend/src/Dispatching.ts:90-97, 141, 227-234` | `beginRun` once per slice; `{ listId, subject, text, cursor }` destructured; `text` used only in the outgoing message; `listMembers` at 141; early pause exits at 101-136 | T3: body read after the page read and before the member loop; one 5 s-bounded read against a 5 min budget, before the first budget check, so `reservationFor` is unchanged |
| `apps/backend/src/Dispatching.test.ts:47-49, 164-180, 332-340` | `beginRun` fake supplies `subject`/`text` from constants; `mailerDouble.submits` records outgoing messages; nothing asserts the body reaches the mailer | T3: `getCampaignBody` fake returns the constant; one new case: the submitted message's `text` is the body the store returned |
| `apps/backend/src/Campaigns.test.ts:89-152`, `apps/backend/src/Api.test.ts:45-57, 354-420, 1317-1338` | Fakes over `Map<string, Campaign>`; the API listing test compares a list item to the create response with `toStrictEqual` | T3: fakes gain `getCampaignBody`; `listCampaigns` fakes keep returning full campaigns (assignable; the encoder strips); the API listing case compares to the summary of the created campaign |
| `apps/cli/src/Commands.ts:32`; `apps/cli/src/Commands.test.ts:249-317, 620-643` | `report` prints the whole decoded response; the in-memory service's `list` handler returns full campaigns through the summary endpoint | T4: no service change; the listing case asserts the printed item has no `text` — the user-facing contract at the outermost layer |
| `README.md:145-164` | "Output contract" names only `submission` fields; no JSON example exists | T4: one sentence: `campaigns list` prints campaigns without their bodies; `get` prints the body |
| `apps/backend/src/Api.integration.test.ts:212-236, 614-666`; `apps/backend/test/IntegrationSupport.ts:331-363` | Empty-list case completes through the dispatcher; listing case finds the created id; `awaitCampaignState` polls `get`; the simulator send completing with accepted counts is the live proof the dispatcher read a body | T6: extend the listing case (item has no `text`; `get` returns it); no new send case |
| Lane B `3ccd82e`: `Storage/Campaigns.ts:54, 89, 215, 245, 349`; `Dispatching.ts:96, 231`; `Schemas.ts:9, 33-36, 125-127, 238, 300`; `Commands.ts:398-427`; plan `:41, 51, 85, 172` | `html` on `StoredCampaign`, `CampaignRun`, the create `withOptional`, the `get` projection, `beginRun`'s return, the dispatcher destructure; size arithmetic predicated on META carrying the body; a merge protocol written against a single-item create | Rebase protocol in this document (Handoff). `CampaignRun.html` and the `beginRun` line disappear; `withOptional` moves to the BODY put; `html` joins `CampaignBody` |
| AWS: [read/write capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html), [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) | `UpdateItem` consumes the larger of the item before and after; transactional writes consume two units per KB; synchronous invocation response 6 MB | The numbers in Problem and target and in ADR-0014 |

- **Open gate:** none.

## Research

- **The body cannot ride `beginRun`.** `beginRun` is an `UpdateItem` on `META` with `ReturnValues: "ALL_NEW"`, and ADR-0013 rejected transactions for it because they cannot return the updated item. A sibling item is out of reach of that call, so the dispatcher reads `BODY` separately, once per slice.
- **Two `recordOnce` puts, not a transaction.** Both keys are fresh, so `recordOnce` is the form ADR-0013 prescribes, and a lost response on either put replays as done. A transaction would double the create's write cost (about 132 units for a 64 KiB text against 66) to close a crash window between the puts whose worst outcome, with `BODY` written first, is an orphan body nobody can reach: the listing index is written on `META` only, every read goes through `campaignKey` or `bodyKey`, and no query scans the partition.
- **Two `readItem`s for `get`, not one batch.** `readItems` returns items unordered and `readEntityPage` distinguishes hydrated items by `pk`, which META and BODY share. Two consistent reads with `getContactByEmail` as precedent. `META` absent is `none`; `META` present without `BODY` is `corrupt`.
- **`getCampaignBody` has no absent case.** Its two callers, `getCampaign` and the dispatcher, both hold a `META` that proves the campaign exists, so an absent body is corrupt in both; the operation decodes the item and lets a missing one fail as corrupt rather than returning an option each caller must turn into the same failure.
- **`send` and `resume` keep the full campaign.** The cost this change removes is per settlement; a send runs once per campaign, so echoing the body there costs one bounded read. Leaving those contracts alone keeps the domain module untouched and the store at one new operation.
- **Fakes may hand a superset.** The installed encoder strips undeclared keys, so the in-memory stores and the CLI service can keep returning full campaigns to the summary endpoint; only assertions that compared a listed item to a created one change.

## Tasks

#### T1 — Contract: summary and body, and the listing that returns the summary

- **Change:**
  - `packages/api/src/Schemas.ts`: add `CampaignSummary = Schema.Struct({ id: EntityId, listId: EntityId, subject: CampaignSubject, createdAt: Timestamp, submission: CampaignSubmission })` and `CampaignBody = Schema.Struct({ text: CampaignText })`, each with its exported type; redefine `Campaign = Schema.Struct({ ...CampaignSummary.fields, ...CampaignBody.fields })` with a one-line comment naming the relation. `CreateCampaignPayload` unchanged.
  - `packages/api/src/Api.ts` `CampaignsGroup`: `list` success `Schemas.page(Schemas.CampaignSummary, Schemas.EntityCursor)`.
- **Starts at:** `packages/api/src/Schemas.ts:226-235`, `packages/api/src/Api.ts:169-173`
- **Depends on:** none
- **Status:** Verified
- **Evidence:** Parent inspected the diff: `CampaignSummary`, `CampaignBody`, `Campaign` from `.fields`; `list` on the summary page; `Api.ts` otherwise untouched. Worker `pnpm typecheck` green.
- **Tests:** none new: the contract relation is a library behaviour (`.fields` spread and key stripping) and is pinned where it is observable, by the API and CLI listing cases in T3 and T4.
- **Verify:**
  - Run `pnpm typecheck`; expect green (`Campaign` is structurally a superset, so every consumer still compiles).
- **Risk/recovery:** `apps/backend/src/Api.test.ts:1334` (`toStrictEqual([first])`) is red from here until T3 rewrites it; T1's gate does not run it.

#### T2 — Storage: the `BODY` item, a two-put create, the body read

- **Change:**
  - `apps/backend/src/Storage/Items.ts`: add `bodyKey = (campaignId) => ({ pk: str(\`CAMPAIGN#${campaignId}\`), sk: str("BODY") })` beside `campaignKey`.
  - `apps/backend/src/Storage/Campaigns.ts`: remove `text` from `StoredCampaign`; add `StoredCampaignBody = Schema.Struct({ v: StoredVersionAttribute, text: attributeOf(Schemas.CampaignText) })` and its decoder; rename `campaignOf` to `summaryOf` returning `Schemas.CampaignSummary`; remove `text` from `CampaignRun` and from `beginRun`'s return.
  - `createCampaign(campaign: Schemas.Campaign)`: `recordOnce("createCampaign", bodyItem)` then `recordOnce("createCampaign", metaItem)`; the META item is the current one minus `text`, the BODY item is `bodyKey`, `v`, `text`. Rewrite the comment: both keys are fresh, so an item already there is this request landing again; BODY goes first so META is the commit point and an interrupted create leaves nothing reachable.
  - `getCampaignBody(id)`: `readItem` BODY, decode `response.Item` with `corrupt("getCampaignBody")` → `Schemas.CampaignBody`. No option: both callers hold a META that proves the campaign exists.
  - `getCampaign(id)`: `readItem` META; `none` → `none`; else `summaryOf`, then `getCampaignBody`, then `Option.some({ ...summary, ...body })`.
  - `listCampaigns`: items are `summaryOf(stored)`; `StoredPage<Schemas.CampaignSummary, string>`.
  - Export `getCampaignBody` from the returned record (fourteen operations).
- **Starts at:** `apps/backend/src/Storage/Campaigns.ts:41-64, 77-87, 138-148, 190-255, 351-363`, `apps/backend/src/Storage/Items.ts:26-29`
- **Depends on:** T1
- **Status:** Verified
- **Evidence:** Parent inspected the diff: `bodyKey`; `text` off `StoredCampaign` and `CampaignRun`; `StoredCampaignBody`; two `recordOnce` puts BODY then META with the rewritten comment; `getCampaignBody` decodes the item under `corrupt`; `getCampaign` merges; `listCampaigns` yields summaries; fourteen operations. Worker: `vitest --project unit apps/backend/src/Storage` 191 passed (10 files). New cases: create writes BODY then META both conditional; getCampaign merges; META without BODY is corrupt; getCampaignBody reads the BODY key.
- **Tests:** `apps/backend/src/Storage/Campaigns.test.ts` (`unit`, scripted table) protects: `createCampaign` writes BODY then META, both conditional, META carrying the index attributes and no `text`, BODY carrying `text` and `v`; `getCampaign` reads META then BODY and merges them; META without BODY is `corrupt`; `getCampaignBody` reads the BODY key and projects `text`; `listCampaigns` yields summaries without `text` from META items; `beginRun` returns the run without `text`. Fixtures: `meta()` loses `text`; a `body()` builder; the `campaign records` reply arrays interleave META and BODY; the three `putItemRequests[0]` reads become `[1]` for META, and the round-trip case at 153 feeds its two reads from `[1]` then `[0]`. The reserved-word assertion keeps passing (no new expression).
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/Storage`; expect green.
  - `pnpm typecheck` is expected red until T3 adds `getCampaignBody` to the three fakes.
- **Risk/recovery:** `getCampaign` now costs two reads, so `send` and `resume`, which call it twice, cost four bounded reads inside the 60 s API budget.

#### T3 — Dispatcher and the backend fakes

- **Change:**
  - `apps/backend/src/Dispatching.ts`: after `listMembers` returns a page and before the member loop, `const { text } = yield* campaigns.getCampaignBody(message.campaignId)`; the outgoing message takes `text` from it and `subject` from the run. Drop `text` from the `beginRun` destructure.
  - `apps/backend/src/Campaigns.test.ts`, `apps/backend/src/Dispatching.test.ts`, `apps/backend/src/Api.test.ts`: the three `CampaignStore` fakes gain `getCampaignBody` (`notExercised` in `Campaigns.test.ts` and in `Api.test.ts`'s `unusedCampaignStore`, since no dispatcher runs in either; the constant `text` in `Dispatching.test.ts`); `beginRun` fakes drop `text`; `listCampaigns` fakes stay as they are.
  - `apps/backend/src/Campaigns.ts`: no change.
- **Starts at:** `apps/backend/src/Dispatching.ts:90-97, 141, 227-234`, `apps/backend/src/Dispatching.test.ts:164-180`, `apps/backend/src/Api.test.ts:354-420, 1317-1338`
- **Depends on:** T2
- **Status:** Verified
- **Evidence:** Parent inspected the diff: the body read sits after `const page = listed.value`; `beginRun` destructure without `text`; three fakes updated (`notExercised` in the domain and API suites, the constant in the dispatch suite); new dispatch case "hands the mailer the body the store's body read returned"; API listing case compares to the summary, asserts no `text`, and asserts `get` returns the full campaign. Worker: `vitest --project unit apps/backend` 454 passed; `pnpm typecheck` green.
- **Tests:** `apps/backend/src/Dispatching.test.ts` (`unit`): one new case — the message handed to the mailer carries the `text` the store's body read returned (today nothing protects the body reaching the mailer). `apps/backend/src/Api.test.ts` (`unit`, real router): the listing case compares to the summary of the created campaign and asserts no `text` on the item; `get` still returns it.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend`; expect green.
  - Run `pnpm typecheck`; expect green.
- **Risk/recovery:** the dispatcher gains one read per slice inside a 5 min budget, before the first budget check.

#### T4 — CLI assertion and README

- **Change:**
  - `apps/cli/src/Commands.test.ts` "lists campaigns as a JSON page": assert the printed item has no `text`. No service or `Commands.ts` change.
  - `README.md` "Output contract": one sentence — `campaigns list` prints each campaign without its body; `campaigns get` prints it.
- **Starts at:** `apps/cli/src/Commands.test.ts:620-643`, `README.md:145-157`
- **Depends on:** T3
- **Status:** Verified
- **Evidence:** Parent inspected the diff: CLI listing case asserts `not.toHaveProperty("items.0.text")`; README output-contract bullet. Worker: `vitest --project unit apps/cli` 32 passed. Parent reran `pnpm check` on the final tree: format, lint, typecheck, 573 unit tests (29 files) and import smoke all green.
- **Tests:** `apps/cli/src/Commands.test.ts` (`unit`, real CLI process): the assertion above.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/cli`; expect green.
  - Run `pnpm check`; expect green.
- **Risk/recovery:** none.

#### T5 — Records: ADR-0014, lifecycle line, stale protocol, PR #7

- **Change:**
  - `.adr/0014-campaign-body-item-and-summaries.md`: drafted with this plan; Status `Accepted` on the user's 2026-09-16 decision; `Confirmed:` line added after T6.
  - `.adr/0011-open-recipient-set-and-paced-dispatch.md`: one `Superseded in part: [ADR-0014](…)` header line (the campaign record).
  - `.adr/work/campaign-listing.md` Handoff: a line that its merge protocol is superseded by this document.
  - PR #7 title and body rewritten to describe listing plus the body item, with the live evidence from T6.
- **Starts at:** `.adr/0011-*.md:1-9`, `.adr/work/campaign-listing.md:135-146`
- **Depends on:** T4 (text), T6 (evidence)
- **Status:** Verified
- **Evidence:** ADR-0014 Accepted on the user's decision with a `Confirmed:` line from T6; ADR-0011 carries the ADR-0014 supersession in its existing lifecycle bullet; `campaign-listing.md` marks its merge protocol superseded; PR #7 title and body rewritten with the live evidence. `pnpm format:check` green (note: oxfmt does not match `.adr/*.md`, so the records are checked by reading).
- **Verify:**
  - Run `pnpm format:check`; expect green.
- **Risk/recovery:** none.

#### T6 — Live gate on an ephemeral stage

- **Change:**
  - `apps/backend/src/Api.integration.test.ts` listing case: assert the found item has no `text` and that `client.campaigns.get` returns the created `text`. The existing simulator send completing with accepted counts is the live proof the dispatcher read the body from its own item.
- **Starts at:** `apps/backend/src/Api.integration.test.ts:614-666`
- **Depends on:** T4
- **Status:** Verified
- **Evidence:** Deployed `test-list` (26 succeeded, 100 s) with AWS CLI credentials exported into the environment because the Alchemy profile's SSO token needed an interactive refresh. Integration: 22 of 23 passed on the first run; the one failure, `ResourceNotFound` from the set-bounce-alarm case, was `.env.test` still naming the destroyed stage's alarm; after pointing it at `Emailer-SetBounceRate-test-list-…` that case passed on a targeted rerun, so all 23 are green including the extended listing case (listed item has no `text`; `get` returns it). Manual: `campaigns create` returned the body; `campaigns list --limit 1` returned the same campaign without `text` and a cursor; `campaigns get` returned `text`. Direct table read of the campaign partition: a `BODY` item with `text` and `v`, a `META` item with `state`, `gsi1pk` and no `text`. Stage destroyed: see below.
- **Tests:** the assertion above (`integration`).
- **Verify:**
  - Check credentials: `aws sts get-caller-identity --profile deploy`; log in first if expired.
  - Deploy: `pnpm exec alchemy deploy --config alchemy.run.ts --stage test-list --env-file .env.test --profile emailer-test --yes --no-input`; point `.env.test` at the stage's URL, token, table name, dead-letter queue URL and unsubscribe secret as the README describes.
  - Run `node --env-file=.env.test node_modules/vitest/vitest.mjs run --project integration`; expect every case green including the listing case.
  - Manual: `campaigns create`, then `campaigns list --limit 1` (no `text`), `campaigns get <id>` (`text` present).
  - Destroy in a guaranteed cleanup path: `pnpm exec alchemy destroy --config alchemy.run.ts --stage test-list --env-file .env.test --profile emailer-test --yes --no-input`; confirm the four functions and the table are gone.
- **Risk/recovery:** a failing listing or get isolates to T2's reads; a send that never completes isolates to T3's body read.

## Final acceptance

- **Checks:** `pnpm check` green; the integration project green on `test-list`; the stage destroyed and its absence confirmed.
- **End state:** a campaign is a `META` item and a `BODY` item; `GET /campaigns` answers `CampaignSummary`; `create`, `get`, `send` and `resume` answer `Campaign`; the dispatcher reads the body once per slice; every settlement writes a lean item; ADR-0014 accepted and confirmed; PR #7 describes the whole lane.
- **Deferrals or blockers:** HTML bodies land through lane B's rebase; no delete or backfill exists to extend.

## Handoff

- **Next action:** None. Merge PR #7 only when the user asks; lane B then merges `main` under the rebase protocol below.
- **Rebase protocol for lane B (after this lane merges):**
  - `packages/api/src/Schemas.ts`: `html: Schema.optionalKey(CampaignHtml)` goes on `CampaignBody`, not on `Campaign`; `Campaign` inherits it through the spread; `CreateCampaignPayload` keeps its own line.
  - `Storage/Campaigns.ts`: `html` joins `StoredCampaignBody`, not `StoredCampaign`; `withOptional(item, [["html", campaign.html]])` wraps the BODY put's item; the ternary copy that adds `html` moves into `getCampaignBody`'s projection, and `getCampaign` inherits it; `CampaignRun.html` and `beginRun`'s `html` line are deleted, not moved, because `ALL_NEW` on META cannot return a sibling item.
  - `Dispatching.ts`: `html` comes from the body read beside `text`; the `beginRun` destructure carries neither.
  - Tests: `Storage/Campaigns.test.ts` html cases retarget from the META put (`putItemRequests[1]`) to the BODY put (`[0]`) and from the single read to the body read; the "projects html into the run" case is deleted with `CampaignRun.html`; `Dispatching.test.ts` html moves to the body fake; CLI and API tests are unaffected because no lane B assertion reads `html` from `send`, `resume` or `list`.
  - Lane B's size arithmetic (plan lines 41, 51, 85; review nit 6; implementation review T2 row) is restated: the 400 KB ceiling now binds on the BODY item alone.
- **Reviews:** [campaign-body-item-review](campaign-body-item-review.md) round 1 **Clear** (7 findings: 1 accepted — an existing empty list reaches the body read, wording fixed here and in ADR-0014; 2 and 3 moot — the create is two puts, so `recordOnce` stays in use and the write-unit figure is replaced by the transaction's true cost in the alternatives; 4 accepted — encoder verified, fakes hand supersets; 5 accepted — token-renumbering instruction dropped; 6 accepted — `listCampaigns` fakes stay; 7 accepted — ADR-0014 no longer supersedes ADR-0013, the contact-create comparison and the reference are corrected). [campaign-body-item-decomplex](campaign-body-item-decomplex.md) round 1: 6 findings, all accepted — DEX-001 `send`/`resume` keep the full campaign and `getCampaignSummary` is gone; DEX-002 no CLI projection; DEX-003 `getCampaignBody` has no option; DEX-004 two `recordOnce` puts; DEX-005 three tests dropped; DEX-006 no ADR-0005 line, no ADR-0013 supersession. Round 2: both **Clear**; the ADR title and alternative numbering corrected; two implementer nits applied below (the `Api.test.ts` `getCampaignBody` fake is `notExercised` because no dispatcher runs there; the storage round-trip case feeds its two reads from both puts, `[1]` then `[0]`). Implementation review [campaign-body-item-implementation-review](campaign-body-item-implementation-review.md) round 1 **Clear**, no findings, recommend ship; its one clerical residue (two lifecycle bullets on ADR-0011) merged into one.
- **Resources:** worktree `~/worktrees/emailer/campaign-listing` on branch `campaign-listing` (lane-owned, retained until merge); ephemeral stage `test-list` created and destroyed in T6; the worktree's untracked `.env.test` now names the destroyed stage.
- **Deviations:** from the recommendation given to the user before planning, `send` and `resume` keep answering the full campaign (DEX-001) and the create is two puts rather than a transaction (DEX-004); both reduce scope and neither touches the user's decision that the listing carries no body.
