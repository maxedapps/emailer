# ADR-0028: Alternate copies inside a campaign, and attributes merged into existing contacts

- Status: Accepted
- Accepted: 2026-10-01, after one plan review with the Codex reviewer
- Date: 2026-10-01
- Authority: Task 165. Two explorations designed this (task 133, score-driven, and task 165, score-free). Max then decided:
  - build variants now, with no pilot;
  - the first slice is `when` rules, a random or weighted split, and a CLI that merges attributes into existing contacts from a CSV;
  - copies are compared with utm links per copy and site analytics, with no SES open or click tracking;
  - big refactors are welcome, since emailer isn't used in production yet.
- Amends:
  - [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md): the dispatcher chooses a copy per recipient before its claim, and the claim records the copy.
  - [ADR-0014](0014-campaign-body-item-and-summaries.md): a campaign has one body item per copy.
  - [ADR-0020](0020-drafts-previews-and-test-sends.md): draft edits replace the copies together, the preview shows every copy, and a test send names the copy it sends.
  - [ADR-0025](0025-fast-large-imports.md): import stays create-only, and a separate batched endpoint merges attributes.
- Plan: [0028-campaign-variants-and-attribute-merge.plan.md](0028-campaign-variants-and-attribute-merge.plan.md)

## Context

- **One campaign sends one copy.** Its subject sits on `META` and its text and HTML on `BODY`. The list `filter` decides who gets mail, but not what they get.
- **Contact attributes exist**, at most 20 per contact, and are read live when each member is dispatched (ADR-0011). The first match on them decides nothing yet.
- **Getting attributes onto existing contacts isn't possible without replacing them.**
  - `PATCH /contacts/:id` replaces the whole attribute map.
  - Import and sign-up ignore the attributes they carry for a contact that already exists.
- **Cost constraints:**
  - every settlement and feedback event updates `META` in a transaction billed by item size (ADR-0014);
  - the public preview function binds `GetItem` only (ADR-0020);
  - low running cost is a hard rule.
- **The item codec** stores strings, numbers, string sets and flat string maps. It can't store an ordered list of rules.
- **SES tag values** allow only ASCII letters, digits, `_` and `-`, at most 256 characters ([MessageTag](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_MessageTag.html)).

## Decision

1. **A campaign has a default copy plus up to four variants.**
   - **The default copy** is today's `subject`, `text` and `html`, unchanged. Its key is the reserved `default`.
   - **A variant** is `{ key, subject, text, html?, when | percent }`. `key` matches `^[A-Za-z0-9_-]{1,32}$` and isn't `default`.
   - **`when`** holds 1 to 4 attribute equalities (AND), with the same semantics as `filter`.
   - **`percent`** is an integer from 1 to 100.
   - A variant has exactly one of `when` or `percent`. Keys are unique, and the percents together are at most 100.
   - `Campaign` carries `variants` only when there are some. `CampaignSummary` doesn't carry them.
2. **One rule chooses a copy, and it covers both selectors:**
   1. **Targeting first.** The first `when` variant, in order, that matches the contact's attributes wins.
   2. **Otherwise a split.** `bucket = SHA-256(campaignId + "/" + contactId)`: the first four bytes, as an unsigned integer, mod 100. The `percent` variants take consecutive ranges of buckets, in order, and the default copy takes the rest.

   So `when` variants alone are "segment copies with a default". `percent` variants alone are an A/B or weighted test against the default. Both together are "these segments get their copy, and everyone else is split". A split within one segment is left out until a campaign needs it.
3. **Storage: a campaign's copies live in its body items, and `META` doesn't change.**
   - **Bodies:** each variant is its own item, `CAMPAIGN#<id>/BODY#<key>`, holding `{ subject, text, html? }`.
   - **The default `BODY`** keeps its text and HTML and gains `variants`: the routing only, as `[{ key, when } | { key, percent }]`.
     - It is stored as a JSON string through `Schema.fromJsonString`, so the codec stays flat. Nothing ever evaluates into it, and a condition can compare it whole.
     - `META` stays as it is, so settlements and feedback, which rewrite it, pay nothing for routing. At its bounds, routing can reach about 9 KB.
   - **Create** writes the variant bodies, then `BODY`, then `META` last, each with `recordOnce`, as today.
   - **A draft edit** replaces the whole set in the existing single transaction:
     - the `META` update, conditioned on `draft`;
     - the `BODY` Put, conditioned on its routing still being what the edit read;
     - a Put for every variant body;
     - a Delete for each variant the edit dropped.

     A concurrent edit that changed the routing makes the condition fail, and the edit is retried from a fresh read, so no body item is orphaned.
   - **A draft delete** reads `BODY` first. It then deletes `META` (conditioned on `draft`), `BODY` (conditioned on the routing it read) and every variant body that routing names, in one transaction.
   - **Reads:**
     - `get`, the preview and the dispatcher share one read: `BODY`, then each variant it names by `GetItem`, in parallel (at most four). The preview function keeps `GetItem` only.
     - The dispatcher makes that read once per slice, where it read `BODY` before.
4. **Dispatch** (amends ADR-0011).
   - The copy is chosen after the filter and the address status and before the claim. The claim's conditional Put records `variant` on `SEND#<contactId>`, and the choice is never recomputed on settle or resume.
   - Every campaign mail carries a third SES tag, `variant=<key>`. The feedback consumer copies the tag onto its history row.
5. **Preview and test send.**
   - The preview page shows every copy, each with its key and rule.
   - `POST /campaigns/:id/test` takes an optional `variant` (the default copy if absent). An unknown key answers `VariantNotFound` (404).
6. **Attributes merge** (the root fix of the gap).
   - **`PATCH /contacts/:id`:** `attributes` is a merge patch ([RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)). A string sets a key, `null` removes it, keys left out stay, and `attributes: null` removes them all.
   - **`POST /contacts/attributes`** merges a patch into up to 20 contacts by address. It reads the reservations and contacts in batches, then writes one transaction of whole-contact Puts.
   - **Every contact write is guarded by a revision.** A contact item carries `revision`, a number every write sets and every update increments. An update or merge Put is conditioned on the revision it read, which is the standard [optimistic locking](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBMapper.OptimisticLocking.html) pattern.
     - Two disjoint merges, or a merge racing a name edit, then both land: the loser fails `ContactChanged` and `retryLostRace` re-reads and re-merges.
     - This replaces `updateContact`'s email-only condition, which let a concurrent edit be silently reverted.
     - A contact written before this change has no revision, and then the condition is `attribute_not_exists(revision)`.
     - **Answer:** one entry per address, `updated` with the contact id or `not-found`.
   - A merged map over 20 entries answers `TooManyAttributes` (422) on both endpoints, instead of becoming an encode defect.
   - **`emailer contacts set-attributes --file <csv>`:** the email column plus attribute columns. It sends batches of 20, four at a time, like `lists import`. A blank cell leaves that key alone.
   - **Import and sign-up stay create-only.**
7. **Compatibility.** Every new stored field is optional (`BODY.variants`, `FEEDBACK.variant`, the contact's `revision`) or only written (`SEND.variant`), so the retained prod table decodes as it is. `recordVersion` stays 1, and no migration is needed.

## Alternatives

- **Sibling campaigns, one per copy, with disjoint filters.** This works today with no code. Rejected as the design because a contact without a value gets nothing, a random split needs an attribute written onto every contact, and each copy needs its own create, schedule, test and stats. It stays the documented workaround for a split within a segment.
- **Copies as one uniform array, with no distinguished default and every subject on `META`.** Rejected:
  - the listing still needs one subject;
  - five subjects of up to 200 characters would push `META` past a 1 KB write unit, and every settlement and feedback event would pay for that.
  - The default copy keeps its place on `META`/`BODY`, and variant subjects go in their own bodies.
- **A selection mode per campaign (`when` or split, never both).** Rejected: it needs a mode field and a rule forbidding the mix. The two-step rule is total, just as short to explain, and makes the combination free.
- **Weights instead of percents.** Weights avoid the sum check, but "10%" is what an operator means. The default takes the remainder, so no sum has to equal 100.
- **Routing on `META`.** `beginRun` returns `META` anyway, so the dispatcher would learn the routing without a read. Rejected: four variants with four equalities at their bounds add about 9 KB to the item every settlement and feedback event rewrites, billed per 1 KB. That is ADR-0014's body problem again. On `BODY`, it costs one sequential read per slice and nothing per recipient.
- **Routing on every variant item, found with a `Query`.** Rejected: a query page caps at 1 MB, so it has to paginate over bodies of up to 256 KiB. The preview function would also need `Query`.
- **A native list-of-maps attribute.** Rejected: it means a recursive codec in `Items.ts` for one field that nothing queries. A JSON string is one line in the record schema.
- **Per-campaign assignment rows (`email → copy`).** Rejected: an extra write per contact, a read per recipient, and it would reverse ADR-0011's live audience. It is only worth it if frozen cohorts become a must.
- **SES stored templates.** Rejected: a second send path, template resources with their own lifecycle, Handlebars instead of Markdown, and no HTML escaping.
- **Per-variant counters on `META`.** Rejected: up to six counters per copy would grow the item every settlement rewrites. The variant lives on the SEND and FEEDBACK rows, so counts can be derived on demand later.
- **Attribute merge as `GET /contacts/by-email` plus `PATCH` per CSV row.** No new endpoint, but two round trips per contact. A 50k-contact file would take about half an hour, against minutes for 20-entry batches, as with the import (ADR-0025).
- **Guarding merges by comparing the whole attribute map in the condition.** Rejected: absent fields and maps need a branch each, while a revision is one number and also protects name and email.
- **Merge with `SET attributes.#k = :v`.** Rejected: it fails when the map doesn't exist yet, and it can't enforce the 20-entry cap.
- **Merge inside import and sign-up.** Rejected:
  - an import would need a contact read per existing contact, raising ADR-0025's measured cost;
  - a public sign-up form could overwrite attributes the operator set.
  - One explicit operator path is clearer.
- **Automatic `utm_content=<key>` on every link.** Not needed: each copy is its own Markdown file, so its links carry their own utm values. It would also mean rewriting operator HTML.

## Consequences

- **One campaign reaches everyone with the right copy**, and each send row and bounce or complaint row names its copy.
- **Cost:**
  - A slice reads every body instead of one: up to five items, about 50 read units for typical 40 KB bodies. That is about $0.01 per 50k recipients.
  - A send row grows by about 20 bytes, and still costs one write unit.
  - A single-copy campaign costs what it does today, apart from the tag and those bytes.
  - `set-attributes` costs a reservation read, a contact read and a transactional write per contact.
  - No new AWS resources.
- **Attributes stay live until the claim** (ADR-0011). Changing a contact's attribute before it is reached changes its copy. After the claim, the copy is fixed.
- **`PATCH /contacts/:id` changes meaning:** attributes merge rather than replace. Nothing in production depends on the old meaning.
- **Concurrent contact edits no longer revert each other.** Each loser pays one extra read and write.
- **A split is fresh per campaign.** The same contact can land in different buckets in different campaigns.
- **No per-variant report yet.** Copies are compared with utm links in site analytics. Delivery counts per copy can be derived from the rows when needed.
