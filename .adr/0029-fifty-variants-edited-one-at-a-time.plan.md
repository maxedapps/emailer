# Plan: Fifty variants, each copy edited and read on its own

- Status: In progress
- Decision: [ADR-0029](0029-fifty-variants-edited-one-at-a-time.md)

## Goal

**Done when:**

- A draft holds up to 50 variants, each set, read and removed on its own through the API and the CLI, at their full body size limits.
- `GET /campaigns/:id` answers the rules only; the preview shows one copy per page; a test send and each dispatcher slice read only the copies they use.
- The README and ADR-0028 (amended-by note) describe it.
- `pnpm check` and the live suite pass; a CLI walkthrough on an ephemeral `--stage test` sets 50 variants, previews them in a browser and sends through the simulator; the stage is destroyed.
- The final report has the cost assessment (feature and raise, per 10k and 100k sends).

**Out of scope:** reordering variants (remove and set again), per-variant reports, a prod deploy.

## Rules for every task

- Worktree `../emailer-variants-50`, branch `variant-limit-50`; `pnpm check` green per commit.
- No new AWS resources; META doesn't grow; the preview function stays `GetItem` only.

## Tasks

### T1 — Contract (`packages/api`)

- `maxVariants = 50`, exported. A `when` encodes to at most 5 KiB of UTF-8 JSON.
- `VariantPayload`: a variant without its key (the key is in the path). `Variant` stays as the GET answer.
- `Campaign.variants`: `VariantRoutes` (rules only). `Variants` (the whole-set array) goes; `CreateCampaignPayload` and `UpdateCampaignPayload` lose `variants`.
- Errors: `TooManyVariants { limit }` and `SplitOverfull { percent }`, both 422.
- Endpoints: `GET`/`PUT`/`DELETE /campaigns/:id/variants/:key`; `update` loses `DraftChanged`.
- Tests (Schemas.test): the rule byte cap admits a maximal ASCII rule of quotes and refuses an oversized one; `VariantRoutes` takes 50 and refuses 51.

### T2 — Storage (`apps/backend/src/storage/Campaigns.ts`, `Items.ts`)

- `routesKey` → `CAMPAIGN#<id>/ROUTES` holding `{ routes (JSON string), revision }`. `BODY` back to `{ text, html? }`.
- `createCampaign`: BODY, then META.
- `updateDraft(id, change)`: one transaction of field updates (META Update or ConditionCheck on `draft`; BODY Update when text/html sent), then the read for the answer. No revision, no retry.
- `setVariant(id, variant)` / `removeVariant(id, key)`: read ROUTES, compute the next routes (in place or appended), refuse 51 or >100 %, transaction of META ConditionCheck, ROUTES Put/Delete on the revision, BODY#key Put/Delete; `retryDraftRace`.
- `deleteDraft`: one transaction with every body, ROUTES on its revision.
- Reads: `getCampaign` (ROUTES + BODY, then META), `getVariant` (ROUTES, then BODY#key; META only to tell a missing campaign apart), `getRoutes` and `getCopy(id, key)` for the dispatcher.
- Tests (Campaigns.test against the in-memory table): set replaces in place and appends; 50 accepted, the 51st `TooManyVariants`; percents over 100 `SplitOverfull`; a set racing another set retries and both land; set/remove on a non-draft conflict; remove of an unknown key writes nothing; delete with 50 variants is one transaction of 53 actions and leaves no item; PATCH of subject alone keeps text and vice versa.

### T3 — Service and API (`campaigns/Campaigns.ts`, `api/Api.live.ts`)

- `update` passes the change through; `edited` goes. New handlers `getVariant`, `setVariant`, `removeVariant`, answering the campaign after set/remove.
- Tests: API handler tests for the new endpoints and error mapping.

### T4 — Dispatcher (`sending/Dispatching.ts`)

- Per slice: `getRoutes`, and a `Cache.make({ capacity: maxVariants + 1, lookup })` over `getCopy`; `chooseVariant` over the routes.
- Tests: a slice reads only the copies its members get; a missing copy item is a defect.

### T5 — Preview and test send (`campaigns/PreviewPage.ts`, `TestSends.ts`, `Copies.ts`)

- Routes `/previews/:token` (default copy plus a list of every copy with its rule, each linking to its page) and `/previews/:token/:key` (one copy, a link back). Unknown key → not-found page.
- Test send reads the campaign, plus the variant when one is named.
- Tests: PreviewPage.test for both pages and an unknown key; TestSends.test for a named variant and `VariantNotFound`.
- Manual: agent-browser on the test stage — the overview links open each copy's page under the CSP sandbox.

### T6 — CLI (`apps/cli/src/commands/Campaigns.ts`)

- `variants set` → PUT, `variants remove` → DELETE, new `variants get <id> <key>`.
- Tests: Campaigns.test for the three commands' requests.

### T7 — Live suite, docs, deployment check

- `Variants.live.ts`: set variants through PUT; fetch a variant; preview overview and one copy page.
- README: limits (50, rule size), commands, contract, preview; ADR-0028 gets "Amended by ADR-0029".
- `pnpm test:integration`; a manual walkthrough on `--stage test` with 50 variants at a realistic size (a script sets them), a send to simulator addresses, the preview in a browser; destroy and check the account.

## Open questions

None.
