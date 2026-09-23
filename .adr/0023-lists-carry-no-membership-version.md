# ADR-0023: Lists carry no membership version

- Status: Accepted
- Date: 2026-09-23
- Accepted: 2026-09-23
- Authority: On 2026-09-23 a whole-codebase review found that nothing reads the list's `membershipVersion` any more. The user approved removing it as part of [the cleanup plan](work/codebase-cleanup.md).
- Supersedes in part: [ADR-0005](0005-contact-identity-and-membership-access-paths.md):
  - the version bump in the contact and list cascades, with the contact cascade's bump-free fallback and the list cascade's last-page special case;
  - the unconditional bump on bulk import;
  - the version clauses in its tests and confirmation.

  The single table, the access paths, the `EMAIL#` reservation, the conditional transactions, `META` deleted last and the accepted cascade race all remain in effect.

## Context

ADR-0005 gave every list a `membershipVersion`. Every membership write incremented it, so that a campaign claim carrying the version it had read would be refused if the audience changed underneath it. [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md) replaced that claim with live membership reads, which left the counter with no reader. Every membership write still paid for it, and the counter still shaped the code:

- **Contact cascade:** each membership needed a second, bump-free transaction for when the list had been deleted concurrently.
- **List cascade:** the last page had to delete `META` instead of bumping, because a transaction may not target one item twice.
- **Comments:** several defended behaviour that no longer exists, among them that an orphaned membership fails a send, and that the bump makes changes visible to readers of the list.

## Decision

- **Lists store no version,** and `getList` returns the list itself.
- **Membership writes that need the list prove it exists.**
  - `addMember`, `removeMember` and `importContacts` carry a `ConditionCheck` on the list key with `attribute_exists(pk)`, in the slot the increment occupied.
  - A missing list still cancels the transaction at the same index, so its outcomes are unchanged.
- **Cascades remove memberships without touching the list.**
  - The contact cascade removes both directions of each membership in one transaction, and needs no fallback.
  - The list cascade deletes memberships page by page, then `META` last, so a repeated `DELETE` still resumes.

## Alternatives considered

1. **Keep the counter for a future reader.** It costs a write on every membership change and keeps two special cases alive, for a reader nothing plans.
2. **Drop the list-existence condition as well.** A membership could then be written under a list deleted a moment earlier, and would be orphaned until the next cascade. The `ConditionCheck` costs the same as the increment it replaces.

## Consequences

- Existing list items keep a stale `membershipVersion` attribute. Decoding ignores it, and it disappears as lists are recreated. No migration.
- The contact cascade is one transaction per membership, never two. The list cascade's pages all have the same shape.
- Nothing observable through the API changes.

## Confirmation

- **Unit tests:** they pin the new transaction shapes and their cancellation-index mapping.
- **Live suite:**
  - A repeated membership is a no-op, with exactly one membership afterwards.
  - Adding to a list that does not exist is refused by the real `ConditionCheck`, writing neither direction.
  - Both cascades remove every membership.

## References

- [ADR-0005](0005-contact-identity-and-membership-access-paths.md), [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md)
- [Codebase cleanup plan](work/codebase-cleanup.md)
- [Amazon DynamoDB: TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)
