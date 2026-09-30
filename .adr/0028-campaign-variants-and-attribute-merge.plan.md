# Plan: Alternate copies inside a campaign, and attributes merged into existing contacts

- Status: In progress
- Decision: [ADR-0028](0028-campaign-variants-and-attribute-merge.md)

## Goal

**Done when:**

- A draft carries up to four variants, each chosen by `when` or `percent`, through the API and the CLI.
- The dispatcher sends each recipient the chosen copy. It records the copy on the send row and tags the mail `variant`, and feedback rows carry the tag.
- The preview shows every copy, and a test send can name one.
- `PATCH /contacts/:id` merges attributes. `POST /contacts/attributes` and `emailer contacts set-attributes --file <csv>` merge them in batches.
- The README documents all of it.
- `pnpm check` and the live suite pass. A manual CLI walkthrough on an ephemeral `--stage test` sends through the simulator, and the stage is then destroyed.

**Out of scope:**

- per-variant reports or counters;
- a split within a segment, and OR rules;
- automatic utm rewriting;
- SES open/click tracking;
- tags on test sends;
- attribute merging in import or sign-up;
- a prod deploy.

## Rules for every task

- Work in the worktree `~/worktrees/emailer/campaign-variants` (branch `campaign-variants`), one commit per task, with `pnpm check` green.
- No new AWS resources. A single-copy campaign costs what it does today, apart from the tag and about 20 bytes per send row.
- New stored fields are optional or only ever written, so the retained prod table decodes unchanged.
- Only neutral placeholders (`example.com`) and simulator addresses.

## Tasks

### T1 — Contract

Status: To do

- **`packages/api/src/Schemas.ts`:**
  - `VariantKey`: `^[A-Za-z0-9_-]{1,32}$`, not `default`.
  - `VariantRule`: a union of `{ when }` (1–4 attribute equalities) and `{ percent }` (an integer, 1–100).
  - `Variant`: a union of `{ key, subject, text, html?, when }` and `{ key, subject, text, html?, percent }`.
  - `Variants`: 1–4 entries, unique keys, percents summing to at most 100.
  - `Campaign`, `CreateCampaignPayload` and `UpdateCampaignPayload` get `variants` (`optionalKey`; on update also `NullOr`).
  - `TestSendPayload` members get `variant?`.
  - `AttributePatch`: a record of `string | null`, with the same key and value bounds.
  - `UpdateContactPayload.attributes` becomes `NullOr(AttributePatch)`.
  - `SetAttributesPayload` / `SetAttributesResult`, at most 20 entries, each mailbox once.
- **`Errors.ts`:** `VariantNotFound` (404) and `TooManyAttributes` (422, `{ email }`).
- **`Api.ts`:**
  - `contacts.setAttributes`: `POST /contacts/attributes`.
  - `test` adds `VariantNotFound`.
  - `update` and `setAttributes` add `TooManyAttributes`.
- **Tests (`Schemas.test.ts`):** a payload with both `when` and `percent` is refused on the decode path with excess properties as errors; so is one with neither, and so are a duplicate key, `default`, a percent sum over 100 and an invalid key character.

### T2 — Campaign storage

Status: To do

- **`storage/Items.ts`:** `variantBodyKey(id, key)`.
- **`storage/Campaigns.ts`:**
  - `META` gets `variants: optionalKey(fromJsonString(Routes))`.
  - `beginRun` returns `routes`.
  - `createCampaign` writes the variant bodies, then `BODY`, then `META`, each with `recordOnce`.
  - `updateDraft(next, dropped)` adds a Put per variant body and a Delete per dropped key. The `META` values come from the record's encoder, not by hand.
  - `deleteDraft` also deletes each variant body the stored routing names, read from the returned old item or from a read first.
  - `getCampaign` reads `META`, then `BODY` and the variant bodies by `GetItem`.
  - `readCopies(id, routes)` reads every body in one batch, matched by `sk`, for the dispatcher.
- **Tests (`storage/Campaigns.test.ts`, against the in-memory table):**
  - create, get, update and delete round-trip the variants;
  - an update that drops a variant deletes its body;
  - delete leaves nothing in the partition;
  - `readCopies` returns every copy.

### T3 — Choosing and sending a copy

Status: To do

- **`sending/Variants.ts`** (new, pure apart from the digest):
  - `bucketOf(campaignId, contactId)` via `Crypto.digest("SHA-256")`;
  - `chooseCopy(routes, attributes, bucket)`: first `when` match, then the percent ranges, then `default`.
- **`sending/Dispatching.ts`:**
  - read the copies once per slice;
  - choose after the address status and before the claim;
  - `claimRecipient(…, variant)` writes `variant` on the send row;
  - `Mail.Campaign` gets `variant`.
- **`sending/Mailer.ts`:** a third tag, `variant`.
- **`feedback/Feedback.ts` / `storage/Feedback.ts`:** the row gets `variant` from the tag (optional).
- **Tests:**
  - the chooser: first-match order, the default fallback, percent ranges;
  - bucket proportions over 10,000 ids within ±2 points, and the same bucket for the same input;
  - the dispatcher: each member gets its copy's content and tag, the send row carries `variant`, and a redelivered page doesn't change it;
  - the mailer: the tags;
  - feedback: a row carries `variant`.

### T4 — Preview and test send

Status: To do

- **`campaigns/PreviewPage.ts`:** one section per copy, headed with its key and rule, the default first.
- **`campaigns/TestSends.ts`:** `variant` picks the copy's subject and body. An unknown key answers `VariantNotFound`.
- **Tests:** the preview page renders every copy; a test send of a variant sends its content; an unknown variant fails.

### T5 — Attribute merge

Status: To do

- **`storage/Contacts.ts`:**
  - a pure `mergeAttributes(current, patch)`;
  - `updateContact` merges, validates against the 20-entry cap and fails `TooManyAttributes`;
  - `setAttributes(entries)`: `readHolders`, then a batch contact read, merge, and one transaction of Puts conditioned `attribute_exists(pk) AND #email = :email`, all inside `retryLostRace`.
- **`audience/Contacts.ts`** and the API handler wire `setAttributes`.
- **Tests:**
  - merge keeps untouched keys, and `null` removes a key;
  - `attributes: null` clears the map;
  - a merge over 20 entries fails typed;
  - bulk: a mix of existing and unknown addresses, and a race retried.

### T6 — CLI

Status: To do

- **`campaigns variants set <id> <key>`:** `--subject`, `--markdown` or `--text [--html]`, and `--when k=v…` or `--percent n`. It reads the campaign, replaces or appends the variant, and updates the draft.
- **`campaigns variants remove <id> <key>`.**
- **`campaigns test --variant <key>`.**
- **`contacts update`:** `--attr` merges, and `--unset <key>` (repeatable) and `--clear-attributes` remove.
- **`contacts set-attributes --file <csv>`:** reuses the CSV reader, with a `name` column refused. Batches of 20, four at a time, with progress output and the rerun-safe message.
- **Tests (in-process CLI harness):**
  - a variant set, replaced and removed;
  - the flag combinations that are refused;
  - `--variant` passed through;
  - update's merge flags;
  - set-attributes over a CSV of 45 rows, which takes three batches.

### T7 — Docs and live suite

Status: To do

- **README:** variants (the selection rule, utm per copy, preview and test), attribute merge semantics, `set-attributes`, and the limits table.
- **Live suite** (`apps/backend/test/Live.integration.test.ts` / `IntegrationSupport.ts`):
  - a campaign to simulator addresses with one `when` variant and one `percent` variant. Every send row names the expected copy (the `when` target, and the split as the bucket predicts), and a bounce-simulator recipient's feedback row carries `variant`;
  - set-attributes on existing contacts keeps their other keys.

### T8 — Live gate and walkthrough

Status: To do

- Export the CLI credentials and `AWS_REGION`, then run `pnpm test:integration`. It deploys and destroys its own stage.
- **Manual:**
  - `alchemy deploy --stage test`;
  - a CLI walkthrough: list, import, set-attributes, create, two variants, preview, `test --variant`, send, and read the send rows;
  - destroy the stage;
  - check that no stage resources are left in the account.

### T9 — Merge

Status: To do

- Settle the review, get `pnpm check` green, and run the leak grep over the diff and the messages.
- Merge into `main`, push, and remove the worktree and branch.

## Open questions

None.
