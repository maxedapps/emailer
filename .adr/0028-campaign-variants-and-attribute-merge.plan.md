# Plan: Alternate copies inside a campaign, and attributes merged into existing contacts

- Status: Done
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

Status: Done

- **`packages/api/src/Schemas.ts`:**
  - `VariantKey`: `^[A-Za-z0-9_-]{1,32}$`, not `default`.
  - `VariantRule`: a union of `{ when, percent?: never }` (1–4 attribute equalities) and `{ percent, when?: never }` (an integer, 1–100).
    - Each branch declares the other selector as `optionalKey(Schema.Never)`, so the default decoding the HTTP API uses rejects both-or-neither instead of dropping one.
  - `Variant`: the rule plus `{ key, subject, text, html? }`.
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
- **Tests:**
  - With default decoding (`Schemas.test.ts`), each of these is refused: both selectors, neither selector, a duplicate key, `default`, a percent sum over 100, and an invalid key character.
  - A handler test answers 400 for a both-selectors payload over HTTP.

### T2 — Campaign storage

Status: Done

- **`storage/Items.ts`:** `variantBodyKey(id, key)`.
- **`storage/Campaigns.ts`** (`META` is unchanged):
  - `BODY` gets `variants: optionalKey(fromJsonString(Routes))`.
  - `BODY#<key>` holds `{ subject, text, html? }`.
  - `createCampaign` writes the variant bodies, then `BODY`, then `META`, each with `recordOnce`.
  - `updateDraft(next, seen)`:
    - the `META` update (on `draft`);
    - the `BODY` Put, conditioned on `variants` equal to the routing `seen` held, or absent when it held none;
    - Puts for the variant bodies;
    - Deletes for the keys in `seen` that the edit drops.

    A refused `BODY` condition is `DraftChanged`, which the service retries from a fresh read.
  - `deleteDraft` reads `BODY` first. It then deletes `META` (on `draft`), `BODY` (on the routing read) and the variant bodies, in one transaction, with the same retry.
  - `getCampaign` reads `META`, then `BODY`, then the variant bodies by `GetItem`.
  - `getCopies(id)` reads `BODY`, then each variant by `GetItem` in parallel. `get`, the preview and the dispatcher all use it: a batch read costs the same and would be a second path.
- **Tests (`storage/Campaigns.test.ts`):**
  - create, get, update and delete round-trip the variants;
  - an update that drops a variant deletes its body;
  - delete removes every body;
  - interleaving: two edits that read the same routing, and an edit racing a delete, leave no orphan body, and the loser retries;
  - `getCopies` returns every copy in order.

### T3 — Choosing and sending a copy

Status: Done

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

Status: Done

- **`campaigns/PreviewPage.ts`:** one section per copy, headed with its key and rule, the default first.
- **`campaigns/TestSends.ts`:** `variant` picks the copy's subject and body. An unknown key answers `VariantNotFound`.
- **Tests:** the preview page renders every copy; a test send of a variant sends its content; an unknown variant fails.

### T5 — Attribute merge and contact revisions

Status: Done

- **`storage/Contacts.ts`:**
  - The contact item carries `revision` (storage only, not on the wire).
    - A create writes 1.
    - Every update Put writes `seen + 1`, conditioned on `revision = :seen`, or on `attribute_not_exists(revision)` for an item from before this change.
    - This replaces the email condition. The address moves stay as they are.
  - A pure `mergeAttributes(current, patch)`.
  - `updateContact` merges and validates against the 20-entry cap, failing `TooManyAttributes`.
  - `setAttributes(entries)`: `readHolders`, then a batch contact read, merge, and one transaction of revision-conditioned Puts, all inside `retryLostRace`.
- **`audience/Contacts.ts`** and the API handler wire `setAttributes`.
- **Tests:**
  - merge keeps untouched keys, `null` removes a key, and `attributes: null` clears the map;
  - a merge over 20 entries fails typed, and is re-checked after a re-read;
  - bulk: a mix of existing and unknown addresses;
  - interleaving: two disjoint merges keep both keys, and a bulk merge racing a name edit keeps both.

### T6 — CLI

Status: Done

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

Status: Done

- **README:** variants (the selection rule, utm per copy, preview and test), attribute merge semantics, `set-attributes`, and the limits table.
- **Live suite** (`apps/backend/test/Live.integration.test.ts` / `IntegrationSupport.ts`):
  - a campaign to simulator addresses with one `when` variant and one `percent` variant. Every send row names the expected copy (the `when` target, and the split as the bucket predicts), and a bounce-simulator recipient's feedback row carries `variant`;
  - set-attributes on existing contacts keeps their other keys.

### T8 — Live gate and walkthrough

Status: Done (see the ADR's Confirmed line)

- Export the CLI credentials and `AWS_REGION`, then run `pnpm test:integration`. It deploys and destroys its own stage.
- **Manual:**
  - `alchemy deploy --stage test`;
  - a CLI walkthrough: list, import, set-attributes, create, two variants, preview, `test --variant`, send, and read the send rows;
  - destroy the stage;
  - check that no stage resources are left in the account.

### T9 — Merge

Status: Done

- Settle the review, get `pnpm check` green, and run the leak grep over the diff and the messages.
- Merge into `main`, push, and remove the worktree and branch.

## Open questions

None.
