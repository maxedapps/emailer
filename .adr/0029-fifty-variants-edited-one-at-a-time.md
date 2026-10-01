# ADR-0029: Fifty variants, each copy edited and read on its own

- Status: Proposed
- Date: 2026-10-01
- Authority: Task 165. Max asked for 50 variants per campaign instead of 4, "unless there's a strong reason that speaks against it", and for a design that holds at 50, with big refactors welcome (emailer is not in production yet).
- Amends [ADR-0028](0028-campaign-variants-and-attribute-merge.md): decisions 1 (the limit), 3 (storage, edits, reads) and 5 (preview). Selection, dispatch, tags and attribute merge stay as decided there.
- Plan: [0029-fifty-variants-edited-one-at-a-time.plan.md](0029-fifty-variants-edited-one-at-a-time.plan.md)

## Context

- **4 was a pick, not a limit.** `maxVariants = 4` is the only thing enforcing it. What breaks first as it grows is the design of ADR-0028, which moves every copy at once:
  - a draft edit writes META, BODY and every variant body in one `TransactWriteItems`, which DynamoDB caps at 4 MB: about 11 copies at their size limit (64 KiB text + 256 KiB HTML, about 330 KB);
  - create, the draft edit, `GET /campaigns/:id` and the preview page carry every copy through a Function URL, capped at 6 MB per request and response: about 15 copies, fewer on the preview, whose escaped HTML grows;
  - the routing sits on `BODY` next to the default copy's 330 KB, and the 400 KB item cap leaves room for about 30 routes.
- **Worst-case routing.** A `when` holds up to 4 entries of a 64-character key and a 512-character value. Stored as JSON, a control character escapes to 6 bytes and other characters take up to 3, so one adversarial rule encodes to about 14 KB, and 50 of them to about 700 KB.
- **Nothing outside the edit path stops at 4 or at 50.** SES tags, the 100-bucket split (percents are at least 1 each), the 100-action transaction cap and the dispatcher's reads all hold 50.
- Low running cost is a hard rule, and every settlement rewrites META, so META must not grow.

## Decision

1. **A campaign has a default copy plus up to 50 variants.** Keys, `when`, `percent` and the selection rule are unchanged. A `when` additionally encodes to at most 5 KiB of JSON (UTF-8). Every ASCII rule within the existing bounds meets it, even one made of quotes, so 50 rules always fit one item.
2. **Storage: one item per copy, and the routing on its own item.** Under `CAMPAIGN#<id>`:
   - `META`: unchanged; the default copy's subject stays here for the listing.
   - `BODY`: the default copy's text and HTML only, as before ADR-0028.
   - `ROUTES` (new): `{ routes, revision }`, the variants' rules in order as a JSON string, at most about 260 KB. Absent means no variants.
   - `BODY#<key>`: a variant's subject, text and HTML, as in ADR-0028.
3. **Every write touches one copy, so every request and transaction stays at one copy's size.**
   - **Create** takes no variants: it writes `BODY`, then `META`, as before ADR-0028.
   - **`PATCH /campaigns/:id`** edits the default copy and META's fields and takes no variants. It is one transaction of updates of exactly the fields sent: META (`subject`, `listId`, `filter`) conditioned on `draft` (a `ConditionCheck` when none of them is sent), and `BODY` (`text`, `html`) when either is sent. With no read-modify-write left, it needs no revision and no retry, and two edits of different fields both land.
   - **`PUT /campaigns/:id/variants/:key`** sets one variant: it replaces the one with that key in place, so its `when` keeps its turn, or appends it. One transaction: a `ConditionCheck` that META is a draft, the `ROUTES` Put conditioned on the revision read, and the `BODY#<key>` Put. A lost race retries from a fresh read, as in ADR-0028.
   - **`DELETE /campaigns/:id/variants/:key`** removes one the same way, deleting `ROUTES` with its last route. A key that isn't there changes nothing.
   - **A draft delete** reads `ROUTES` and deletes META (conditioned on `draft`), `BODY`, `ROUTES` (conditioned on the revision read) and every variant body in one transaction: at most 53 of the 100 actions allowed.
   - A set that would make 51 variants answers `TooManyVariants` (422), and one that would take more than 100 percent answers `SplitOverfull` (422). Both depend on the stored routes, so the contract can't refuse them at decoding.
4. **Every read fetches what it shows.**
   - **`GET /campaigns/:id`** answers the summary, the default copy and `variants` as rules only (`{ key, when }` or `{ key, percent }`): `ROUTES` and `BODY`, then META.
   - **`GET /campaigns/:id/variants/:key`** answers one variant with its content: `ROUTES`, then `BODY#<key>`; an unknown key is `VariantNotFound` (404).
   - **The preview** is one page per copy. `/previews/<token>` shows the default copy and lists every copy with its rule, each linking to `/previews/<token>/<key>`, which shows that copy. The token stays per campaign, and the preview function keeps `GetItem` only.
   - **A test send** reads only the copy it sends.
   - **The dispatcher** reads `ROUTES` once per slice and each copy the first time a recipient of that slice needs it, through a slice-scoped `Cache`. A copy no recipient of the slice gets is never read.
5. **The CLI** maps one to one: `campaigns variants set` is the PUT, `variants remove` the DELETE, and a new `variants get <id> <key>` shows one variant. `campaigns get` shows the rules.
6. **Compatibility.** Prod has never run ADR-0028 (its table holds no `revision`, `variants` or `BODY#` items), so `BODY` returns to its pre-ADR-0028 shape and no migration is needed.

## Alternatives

- **Raise the constant to 10 and keep ADR-0028's design.** The simplest option, and it works up to about 11 copies at their size limit. Rejected: Max asked for 50, and nothing argues against 50 once copies move one at a time.
- **Keep editing the whole set, split across several transactions.** Rejected: the set is no longer all-or-nothing, so bodies can be orphaned, and the request and response still carry every copy past 6 MB.
- **Lower the per-copy body limits so 50 fit one transaction.** Rejected: 4 MB over 51 copies is about 80 KB each, below what a designed HTML mail can need, and the 6 MB request cap still binds.
- **Keep the routing on `BODY`.** Rejected: with a full default copy, 400 KB holds about 30 ASCII routes, fewer adversarial ones.
- **Routing on each variant's own item, found by `Query`.** Rejected in ADR-0028 for the same reasons: a query pages over bodies of up to 330 KB, and the preview function would need `Query`.
- **Bound the routing item as a whole, with a third 422.** Rejected: the per-rule byte cap is checked at decoding, answers 400 like every other contract bound, and still admits every ASCII rule. A tighter attribute pattern (no control characters) would bound it too, but would change what contacts may hold.
- **Read every copy per slice, as ADR-0028 does.** It works, but at 50 copies a slice reads all 50 even when its members need two. The slice-scoped cache costs a few lines and reads only what is sent.
- **Cache copies across slices in the dispatcher instance.** It would cut reads further, since copies are frozen while a run holds its token. Rejected: per-slice reads already cost cents per 100k sends (see Consequences), and an instance cache adds eviction and memory bounds for that.
- **Inline the preview as one page with every copy collapsed.** Rejected: the response still carries every copy, past 6 MB.

## Consequences

- **50 copies at their size limit work end to end.** No request, response, item or transaction carries more than one copy plus the rules.
- **Contract changes** (nothing outside this repo uses them): create and `PATCH` no longer take `variants`; `GET /campaigns/:id` answers rules only; three variant endpoints; two 422 errors; `DraftChanged` leaves `PATCH`; the preview link opens an overview of the copies.
- **`PATCH` gets simpler:** no read before the write, no revision, no retry.
- **Cost** (DynamoDB on-demand, consistent reads at 1 RRU per 4 KB; slices of 50 members, so 2,000 slices per 100k sends):
  - every slice reads `ROUTES`: 1 RRU when absent or small, so about $0.00025 per 100k sends for a single-copy campaign;
  - variant copies are read once per slice that uses them: at about 9 RRU for a typical 35 KB copy, a 50-way split costs about $0.07 per 100k sends; at the size limit, about $0.65;
  - per send nothing changes: the send row stays under 1 KB, and the SES tag is free;
  - a variant edit is a transactional write of up to about 330 KB, which is fractions of a cent.
- **Merging and retries:** two concurrent variant edits on one draft serialise through the `ROUTES` revision; the loser re-reads and re-applies its single change.
