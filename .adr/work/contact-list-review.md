# Independent adversarial review — contact management slice

> **Target:** [contact-list.md](contact-list.md) and [ADR-0005](../0005-contact-identity-and-membership-access-paths.md), as drafted before revision
> **Question asked:** if this plan is implemented exactly as written and every named check passes, could the required outcome still fail?
> **Verdict at review time:** not ready — two blocking defects. **Closure:** all findings dispositioned; accepted corrections folded into the plan.
> **Date:** 2026-09-11
> **Note on references:** every `Storage.ts:NNN` below predates T1's split of that file and is kept as written, since this is the record of a review that closed before implementation. The modules it became are `Storage/{Items,Table,Contacts,Lists,Membership,Campaigns,Feedback}.ts`.

The reviewer read the cited sources rather than the plan's summary of them, verified every external claim against installed source, and walked concurrency interleavings by hand. Its factual-verification pass is recorded at F11 because it constitutes evidence the plan's research is sound, not merely unchallenged.

## Findings and dispositions

### F1 — Cascade transaction bound never computed — Blocking — **Accept**

The draft computed the import cap precisely (`4n + 1 ≤ 100`) but specified the cascades as "each page removes both directions and bumps `membershipVersion`" with **no page cap**. A DynamoDB query page defaults to 1 MB — hundreds of small member items.

Deleting a 200-member list would build a ~401-action transaction, fail `ValidationException` → `TransactionCanceledException` with a non-`ConditionalCheckFailed` reason → `runTransaction` re-fails (`Storage.ts:299-300`) → 503 on **every** retry. The list becomes permanently undeletable. Nothing named catches it: the stub models no action limit, and live testing would have used small fixtures.

**Disposition:** accepted in full. The plan now carries a transaction-bound table (R4) covering every transaction in the slice, explicit `Limit` constants in T6, and a T10 requirement to exercise a list larger than one cascade page.

### F2 — The tombstone closed one membership door of four — Blocking — **Accept, resolved by removal**

`addMember` was guarded, but bulk import built its own transaction and — for an existing contact — carried **no action on `CONTACT#<id>/META` at all**, not even an existence check. So T8's stated risk mitigation ("the transaction's conditions remain the authority") was empty for that path. `updateContact` was likewise unguarded (F3).

**Disposition:** the underlying defect is accepted and fixed; the proposed _mechanism_ is not. The complexity review independently concluded the tombstone should be removed (see [decomplex report](contact-list-decomplex.md), item 2), which dissolves F2's framing, F3, and F4(a). What survives removal and **is** fixed: bulk import now carries a `ConditionCheck` on `CONTACT#<id>/META` for every existing contact, matching what `addMember` already does. The residual orphan window is recorded as an accepted consequence in ADR-0005.

### F3 — `updateContact` unguarded, stranding an `EMAIL#` reservation — Material — **Accept, fixed differently**

An address change concurrent with a cascade could leave a reservation with no contact behind it, making that address return 409 forever and `getContactByEmail` resolve to a nonexistent contact.

**Disposition:** accepted. With the tombstone gone the proposed one-clause fix does not apply, so the plan closes it at the other end: the cascade's **final** transaction deletes `META` and the reservation together, conditioned on the stored address still matching the value just read. A concurrent change fails that condition rather than stranding an item.

### F4 — Two coin flips decide whether a tombstoned entity is recoverable — Material — **Partially accept**

(a) `beginDeletion`'s condition was ambiguous; the natural reading would break resume at step one. (b) Concurrent `deleteContact` and `deleteList` over the same membership: the contact cascade's bump on a just-deleted list fails its condition, cancelling the whole page transaction — and neither retrying nor dropping the condition helps, since bumping a missing item is a `ValidationException`. (c) `GET` on a tombstoned entity was undefined, and would have returned 200 while `addMember` returned 404 and `DELETE` returned 503.

**Disposition:** (a) and (c) are moot — the tombstone is removed. **(b) is accepted and is the more important half**: it survives tombstone removal entirely, because the contact cascade still bumps a list that may vanish. The plan now runs the contact cascade as one 3-action transaction **per membership**, and treats a `ConditionalCheckFailed` bump slot as "that list is gone", repeating the membership as a 2-action delete with no bump. This also removes the need for contact-cascade page arithmetic.

### F5 — "gains the guard on both `ConditionCheck`s" contradicts the code — Material — **Accept**

`addMember` has exactly **one** `ConditionCheck` (slot 0, contact). Slot 1 is an `Update` on the list carrying its own `ConditionExpression` — precisely the shape `wiki/aws/dynamodb-outbox.md:31` prescribes to avoid targeting one item twice. An implementer following the draft literally would have added a second `ConditionCheck` on the list, producing a `ValidationException` on every `addMember` and shifting every slot index, silently invalidating the positional test contract.

**Disposition:** accepted. The key-files table and T4 now state the actual structure and explicitly warn against adding a second `ConditionCheck`. Verified directly: `Storage.ts:392-398` is the `ConditionCheck`, `:399-407` the `Update`.

### F6 — Import's stated test contradicted the `membershipVersion` contract — Material — **Accept**

The draft claimed a re-run "writes no new logical work" while specifying an unconditional bump. An unconditional bump _is_ new logical work and is observable as a spurious `MembershipConflict` on a concurrent send.

The reviewer's analysis of the correct direction is adopted verbatim: the unconditional bump is the **safe** side, because making it conditional on the advisory pre-read would let a concurrent `removeMember` between read and write result in a re-added membership with no version movement — the audience changing while the version did not.

**Disposition:** accepted as a text fix, not a code change. T7's test now reads "writes no new **items** and returns an identical response, while `membershipVersion` is expected to move", and R5 and ADR-0005 both record why.

### F7 — Six tasks claimed "expect green" against a deliberately red tree — Material — **Accept**

The contract task declared the tree intentionally red until handlers landed, while three later tasks each promised `pnpm check` green. Both cannot hold, and for half the slice an implementer could not distinguish their own breakage from the intended breakage — disabling the plan's only stated guard that all four seam sites get updated.

**Disposition:** accepted, and resolved more thoroughly than proposed. Rather than resequencing, endpoint declaration and handlers are now **one task** (T8), per the complexity review's finding that `handleAll` makes them a single compile boundary. Every task now ends green, and every task carries a `Verify:` line — three previously had none.

### F8 — Five wrong line references — Material — **Accept**

Most consequentially, `claimCampaign`'s `membershipVersion = :expected` was cited twice as `Storage.ts:766`, which is `} as const;`. The real line is **`:534`**. Also: `packages/api/src/Api.ts:25-46` was cited for `handleAll`, which that file does not contain (the sites are `apps/backend/src/Api.ts:26,33,41` and `apps/cli/src/Commands.test.ts:62,83,116`); `CreateContactPayload` is at `Schemas.ts:153-158`, not `:145-152`; and `toCodecStringTree` is defined at `HttpApiEndpoint.ts:1081` and applied at `:1087`.

**Disposition:** accepted. All five corrected and independently re-verified against the files.

### F9 — `batchWriteItem` wired with no consumer — Minor — **Accept**

**Disposition:** accepted, and extended. The complexity review found `deleteItem` is equally unused — every delete in the slice needs a condition or an atomic bump, so all are transactions, and the final `META` delete rides the last page's transaction. `TableOperations` now grows by **two** members, not four, halving the seam churn.

### F10 — `claimCampaign` does not observe a deletion in progress — Minor — **Reject as out of scope**

With the tombstone removed this is moot in the form raised. The reviewer itself classed it as a soft policy question belonging to the parallel slice's audience check, and explicitly noted it is not an invariant violation: `membershipVersion` still governs the claim exactly as intended. Recorded here so it is a decision rather than an oversight.

### F11 — External claims verified — Clear, with one half-truth — **Accept the correction**

Every Alchemy, Effect and SDK citation resolved exactly: GSI/`ConsistentRead`, the batch key asymmetry, per-table `ConsistentRead` inside `KeysAndAttributes`, `isSameGsiDefinition` comparing `Projection`, in-place index and attribute addition, index readiness gating on `IndexStatus`, `delete` versus `del`, the `query` option key, `isBetween`'s object argument, the `Schema.Record` silent-drop behaviour, the stub shape and seam sites, the lint rule, both `Flag` APIs, and all fifteen wiki citations.

The one error: the draft said the stored `email` "keeps its original case for display". `EmailAddress` decodes through `normalizeEmailAddress` at the boundary, so the **domain is already lowercased** — only local-part case survives.

**Disposition:** accepted; D1 and ADR-0005 now say exactly that. The reviewer's related note that `Flag.keyValuePair` requires at least one pair, and so needs `Flag.optional`, is also accepted into T9.

## Findings explicitly returned Clear

Recorded because they are load-bearing assurances, not absence of effort:

- **The reverse membership item does what it claims.** The reviewer walked the interleavings and could not construct one where the two directions end inconsistent on their own. The residual defects were tombstone coverage and the two-cascade interleaving, not the mechanism.
- **Double-bumping `membershipVersion` is harmless.** The update is monotonic (`Storage.ts:403`) and the assertion is equality (`:534`), so there is no ABA; an extra bump only yields a conservative `MembershipConflict`.
- **Bumping once per page rather than once per membership is sufficient**, because the assertion compares against a value read at the start of the same request. The defect was the page _cap_, not the bump _count_.
- **"Cannot target one item twice" is not violated** by `addMember` today or by the import transaction.
- **The arithmetic checks out:** `4n + 1 ≤ 100 ⇒ n ≤ 24`; capping at 20 for headroom is sound.
- **Every stated task dependency is satisfiable in position.**

## Re-review of the revised design

> **Scope:** the rewritten D3/T6/T7, the R4 transaction-bound table, and ADR-0005's cascade paragraph — the three elements that were new after the first review and had never been examined.
> **Verdict:** two corrections, both to text one review old; no reopened design question. **Closed** by the edits below.

**F1 — closed for the contact cascade, and reintroduced for the list cascade through a different door — Blocking — Accept.** The revision said the final page's transaction removes both directions, bumps `membershipVersion`, _and_ deletes `LIST#…/META`. The bump is an `Update` on `listKey(listId)`; the META delete is a `Delete` on the same key (`Storage.ts:30`) — one item, twice, in one transaction. Worse than a cancellation: it is a `ValidationException` raised at request validation, so it never becomes a `TransactionCanceledException` and bypasses `runTransaction`'s handling (`Storage.ts:284`), falling through to a 503. Every non-empty list would have failed `DELETE` deterministically forever — the exact class F1 was raised to close. The plan, the ADR and R4 were also describing three different transactions.

Fixed by **dropping the bump from the final page**, which removes an action rather than adding one. Verified independently: `claimCampaign`'s slot-0 `ConditionCheck` fails on an absent list whatever `:expected` holds (`Storage.ts:531-537`), yielding `membership-changed` exactly as a bump would, so the send invariant survives. T6, D3, R4's table and ADR-0005 now describe the same transaction.

**F12 — the final contact transaction's condition failure has two opposite meanings — Material — Accept.** `email = :e` fails both when the address changed _and_ when the item is absent, since a condition on a missing item evaluates false. An implementer taking the natural "META-last, so absent means done" reading would return **204 for a contact still alive with every membership stripped**. Closed by one rule in D3: re-read the contact — absent means the delete completed, present means a concurrent address change and the transaction is rebuilt.

The reviewer separately confirmed the mechanism itself is right, walking all three orderings of a concurrent address change and finding no strand, and confirming that conditioning on `contactId` instead would strand a reservation in one of them.

**M1 — the import bump lacked a stated existence condition — Minor — Accept.** "Unconditional" meant "not conditional on the advisory pre-read", but without `attribute_exists(pk)` an import into a deleted list is an `Update` on a missing item — a `ValidationException` → 503 instead of `addMember`'s clean `list-missing` → 404 (`Storage.ts:431-433`). T7 now says so.

**M2 — half-right citation — Minor — Accept.** `Storage.ts:392-398` is the _contact_ `ConditionCheck`; a list delete's door is closed by the list `Update`'s own condition at `:399-407`. Both are now cited.

### Returned Clear on re-review

- **F2, F3, F4(b) all close.** The import `ConditionCheck` gives the existing-contact path the authority it wholly lacked; the conditioned final delete prevents the strand under every ordering; the per-membership transaction plus fallback makes a vanished list survivable.
- **The vanished-list fallback is unambiguous and cannot loop.** Neither `Delete` in the 3-action transaction carries a condition, so `conditionFailures.has(2)` holds **iff** the list is gone. The 2-action fallback is two unconditional deletes — terminal, and silent on already-missing items. The outer loop is monotonic, and `ExclusiveStartKey` is a key rather than an offset, so concurrent deletion never skips.
- **The fallback branch survives complexity challenge.** Plain `continue` is almost equivalent, but D3 explicitly accepts that a concurrent `addMember` or import can orphan a membership mid-cascade; in exactly that case `continue` would leave both items behind permanently. The branch is what makes the accepted residual self-healing.
- **Do not split the delete from the bump.** `Campaigns.send` reads the version, then the audience, then claims (`Campaigns.ts:66`, `:72`, `:114`). Non-atomic removal would let a send that read the audience before the deletion still claim in the gap — the window `membershipVersion` exists to close. The 3-action atomic form is load-bearing; it warrants a note beside the code.
- **Import arithmetic confirmed:** 4 per new contact, 3 per existing, +1 bump; 20 new → **81 ≤ 100**; all-existing → 61. No transaction targets one item twice — within an existing contact, the `ConditionCheck` on `CONTACT#C/META` and the `Update` on `CONTACT#C/LISTOF#L` share a partition key but differ in sort key.

## Later disposition change (2026-09-12)

**F12's accepted correction was narrowed after a complexity re-reading.**

The finding is sound and its mechanism is kept: the final contact transaction stays conditioned on the stored `email` still matching what was just read, because a stranded `EMAIL#` reservation is unrecoverable through the API. What was cut is the **re-read-and-rebuild branch** that the first disposition accepted alongside it.

The reviewer's failure scenario — an implementer mapping the condition failure to success and returning 204 for a live contact — is closed by stating that a condition failure there is a failure, not a success. From that point the client's repeated `DELETE` re-reads and completes, which is the resume contract the design already relies on. A dedicated in-request re-read, absent-versus-present branch and transaction rebuild duplicated existing machinery to handle a failure inside an already-improbable window.

Separately, the **vanished-list fallback** accepted under (a) is now labelled in D3 as a judgment call rather than a necessity. The re-review's "permanently undeletable" framing holds only for a _stacked_ case — the accepted orphan window leaves a membership pointing at a deleted list, and a later contact delete then fails on it identically. In the ordinary interleaving the repeated `DELETE` self-heals, because the list cascade removes both directions and the retry no longer discovers the membership. The branch is kept, at roughly five lines, to make the accepted residual self-healing rather than accumulating; the plan now says plainly what it buys so it can be dropped on judgment.
