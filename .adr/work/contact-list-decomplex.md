# Complexity triage — contact management slice

> **Target:** [contact-list.md](contact-list.md) and [ADR-0005](../0005-contact-identity-and-membership-access-paths.md), as drafted before revision
> **Question asked:** which parts are machinery the user would not want, and what is the smallest design that still meets the outcome?
> **Outcome:** 13 tasks → 11; one entity state, one error type, two seam members and three validation mechanisms removed.
> **Date:** 2026-09-11

Triaged against two standing constraints that both apply: _"avoid complexity… do not try to handle edge cases, esoteric fail states or similar"_, and _"a clean, lean implementation that has the shape as if we built it like this from the ground up"_. The second authorizes rewriting, not adding.

## Dispositions

### 1. Reverse membership item (D2) — **KEEP**, rationale rewritten — **Accept**

The reviewer corrected two framings that mattered more than the verdict. `addMember` is already a 3-action transaction, so the reverse item is +33%, not a doubling. More importantly, the draft ADR rejected an alternative — "serve contact→lists from the index" — that **D4 had already eliminated**, since the sparse index covers only contact and list `META` items. There is no index over member items, so without the reverse item there is _no contact→lists access path at all_.

The genuinely smaller design — no contact-delete cascade, leave forward items behind — was rejected on evidence: orphans are observable today, because `Campaigns.send` maps a missing contact to `StorageUnavailable` (`Campaigns.ts:88-89`), i.e. a permanent 503 on a list containing a ghost.

**Disposition:** accepted. D2 and the ADR alternative are rewritten as "the sparse index has no reverse path; the lookup item is it", with the staleness argument retained only where it belongs — as the reason not to add a _second_, inverted index.

### 2. `deletingAt` tombstone (D3) — **CUT** — **Accept**

`META`-last ordering already provides resumability with or without a tombstone, and `addMember`'s existing `attribute_exists(pk)` check closes the window the moment `META` is gone. What the tombstone added was protection against a membership landing _during_ a cascade — a seconds-wide window requiring two concurrent admin operations on the same entity.

The draft's own admitted open question was the tell: it never defined what `GET` returns for a tombstoned entity, and the adversarial review computed the answer — 200 from `GET`, 404 from `addMember`, 503 from `DELETE`, three contradictory answers about one entity. Defining it would have added a branch to every read path.

**Disposition:** accepted. The attribute, the `attribute_not_exists(deletingAt)` conditions and `beginDeletion` are all removed. The orphan window is recorded as an accepted consequence in ADR-0005 with no fallback branch. This also dissolves three of the adversarial review's four tombstone findings (see [review](contact-list-review.md), F2-F4).

Also accepted: T6's dead clause about refreshing `gsi1sk` on rename. `gsi1sk` is `<createdAt>#<id>` and both are immutable.

### 3. Sparse GSI (D4/D5) — **KEEP** — **Accept, with a stronger reason**

The reviewer supplied a better decisive argument than write amplification: with a plain inverted index every `META` item shares one sort-key value, so `listContacts` becomes a _filtered_ query and runs straight into the empty-page-with-more-pages trap the wiki names explicitly (`wiki/aws/dynamodb.md:69`). Two hand-maintained attributes on two item types is the minimum that avoids it.

**Disposition:** accepted; D4 and the ADR alternative now lead with the filtered-query argument. D5's irreversibility note is retained — `isSameGsiDefinition` comparing `Projection` is a real table-replacement trap.

### 4. Attribute bounding — **SIMPLIFY, five mechanisms → three** — **Accept**

A bound is genuinely required, since an unbounded map turns a request that passes the 512 KB body cap into a DynamoDB `ValidationException` surfaced as a 503. But it only has to be _deterministic_, not measured: 20 entries × (64-char key + 512-char value) ≈ 12 KB, three orders of magnitude under the 400 KB item cap.

**Disposition:** accepted. The encoded-byte-size refinement is cut — `CampaignText`'s equivalent exists because a 64 KB body is genuinely near its limit; attributes are not. The key character pattern is cut as speculative, since attributes are stored as map data, not as expression attribute names. Retained: `isPropertyNames`, `isMaxProperties`, and a value `isMaxLength` — and R1's silent-drop finding with its test, which the reviewer independently rated the highest-value item in the task.

### 5. `DeletionIncomplete` + `Clock` budget — **CUT the error and the budget; keep the paging and `META`-last** — **Accept**

The arithmetic, computed rather than guessed: ≤49 memberships per 100-action transaction, ~250 transactions within the 25-second budget the codebase already uses, ≈12,000 members in a single request — and with import capped at 20 per call, reaching that takes 600 API calls. Below it, one request finishes; above it, the Lambda returns an error and the client repeats the `DELETE`, which resumes, because resumability comes from `META`-last ordering and not from a typed error.

The reviewer also rebutted the precedent I had leaned on: `SendNotAttempted` exists because a send has an irreversible external effect that must not begin without time to record it. A delete has none.

**Disposition:** accepted. The error type and the budget are cut; the page loop and `META`-last ordering remain, each one line of discipline.

### 6. Splitting `Storage.ts` — **CUT from this slice** — **Accept**

The draft already conceded the case: gated on another branch merging, carrying no functionality, "cleanly deferrable". `no-service-constructor-imports` also makes it a design task rather than a file move, and that whole analysis was being carried for a task that might never run.

**Disposition:** accepted. The task and its supporting research section are removed; the rationale survives as a named deferral in Final acceptance and a consequence in ADR-0005, so the next slice inherits the analysis rather than repeating it. Flagged to the user as a recommended follow-up, since it is the one cut that touches their stated preference for large refactors.

### 7. Thirteen tasks — **CUT to eleven** — **Partially accept**

`HttpApiBuilder.group(...).handleAll` makes endpoint declaration, backend handlers and the CLI stub server one compile boundary, so splitting them schedules a deliberately-red intermediate state — which is also the root of the adversarial review's F7.

**Disposition:** the contract and handler tasks are merged (T8). The CLI _commands_ task stays separate, because only the CLI _stub server_ shares that compile boundary; the commands themselves are additive and land green on their own. Eleven tasks, not ten.

### 8. Other machinery — **Accept**

- **`batchWriteItem` has no consumer** — cascades need conditions and bumps, so they are transactions; hydration uses `batchGetItem`. Cut.
- **`deleteItem` has no consumer either** — the contact `META` and reservation must go together in one transaction, and the list's final `META` delete rides the last page's transaction. Cut. `TableOperations` grows by two, halving the four-site seam churn.
- **Import's duplicate-address rejection named no error type**, forcing the implementer to invent one. Expressed instead as a `Schema.refine` on the payload, so it is a 400 by decoding, consistent with the batch-size cap. This requires the derivation callable from `packages/api`, which is an independent reason to move `mailboxKey` into `Schemas.ts` beside `normalizeEmailAddress` — and that also puts all three email normalizations in one visible file.
- **Three page structs** → one `page(itemSchema)` helper.
- **`UnprocessedKeys` backoff policy** → one bounded retry pass. The wiki requires handling them; nothing requires a subsystem.
- **Cursor codec** → encode `{ id, createdAt }` and rebuild the key attributes, rather than a generic attribute-map codec. Smaller, and it keeps a database key out of the public contract.

### Under-specification that would have forced invented complexity — **Accept all**

Every bound in the schema task was written as `…`; the storage shape of `attributes` was unstated; replace-versus-merge semantics were undefined; `listMembers` on a missing list was undefined; and campaigns pointing at a deleted list were unaddressed.

**Disposition:** all closed. D8 now names every number (20 entries, 64-char keys, 512-char values, batch 20, page 1-100 default 25, cascade limits). Attributes are stored as a DynamoDB `M` of `S` with a `readStringMap` helper and **replace** the whole map. `listMembers` 404s on a missing list and returns hydrated contacts. There is no campaign cascade, because `Campaigns.send` already 404s through `getList`.

## Later disposition change (2026-09-12)

**Item 6 — splitting `Storage.ts` — reversed from CUT to KEEP, and moved to first, on the user's direction.**

The triage verdict stands on its own terms: at the time it was written the split was gated on another branch merging, carried no functionality, and was being planned as a trailing task that might never run. Two things changed. The user resolved the parallel-work question with "implement independently, we'll handle merge conflicts later", which removes the gate; and the user restated the goal as the cleanest architecture, with refactors wanted where they genuinely produce one.

Re-evaluated on that basis, it earns its place: one module currently holds six item domains plus all the DynamoDB plumbing, at 800 lines heading to ~1,300, with its test file heading past 1,600 — while the application layer already has the per-entity structure the storage layer lacks. The decomposition was also corrected in the process: a strictly per-entity split fails, because `addMember` spans contacts, lists and members and `claimCampaign` spans lists, campaigns and sends, so ownership follows **item type** and membership becomes a module in its own right.

Sequencing it **first** rather than last is what keeps it from being a rewrite for its own sake: it is a pure move over already-tested code, verified by the existing suites passing with no assertion rewritten, after which every task writes into the module where its code belongs. Recorded as D9 and R8 in the plan and in ADR-0005.

Scope held: one `Storage` tag, one table owner, six files. No per-entity service tags, no generic repository abstraction, no split of the application-layer modules.
