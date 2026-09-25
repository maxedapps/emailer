# ADR-0006: Consent survives a contact's address change

- Status: Accepted; the known residual is superseded
- Date: 2026-09-13
- Accepted: 2026-09-15, by the user, the implementation having been complete since 2026-09-13
- Superseded in part: [ADR-0007](0007-immutable-recipient-unsubscribe-links.md) retires the known residual below by removing the contact read from the opt-out path entirely. The policy this record decides — consent keyed on the mailbox, and an opted-out contact frozen at its address — remains in effect.
- Amended: 2026-09-24, on the user's decision in the simplification plan (`work/simplify.md` T3) — storage answers the refused move with `AddressOptedOut` itself, where it answered an `opted-out` outcome for the domain to map.
- Authority: Reviewing the trunk after the contact-management (`work/contact-list.md`, in git history) and consent (`work/consent-and-unsubscribe.md`, in git history) slices merged found that together they let an opt-out be escaped. The user asked for it fixed in the cleanest way, with the alternatives weighed in the follow-up (`work/consent-identity-and-storage-cleanup.md`, in git history) (I1), and approved this design for implementation. Acceptance follows the live confirmation below, as it did for ADR-0004 and ADR-0005.
- Superseded in part: [ADR-0024](0024-typed-errors-and-cost-neutral-storage.md) for the item the opt-out check targets. The check reads `unsubscribedAt` on the address item being left, not an `UNSUBSCRIBE#` item.

## Context

[ADR-0004](0004-sender-owned-one-click-unsubscribe.md) keys an opt-out on the mailbox, `UNSUBSCRIBE#<mailboxKey(email)>`, and `Campaigns.send` asks about the address a contact holds at send time. [ADR-0005](0005-contact-identity-and-membership-access-paths.md) made that address changeable. Each was right on its own. Together, an operator changing an opted-out contact's address made them mailable again, while ADR-0004 states that there is no resubscribe path.

Of ADR-0004's three reasons for keying consent on the address, two still hold: it matches what SES and a bounce key on, and it needs no index. The third, that duplicate contacts per address would make contact-keyed consent escapable, was retired by ADR-0005's `EMAIL#` reservation. So the key choice had to be reconsidered, not just patched.

`updateContact` is the only operation that changes a contact's address. Bulk import reuses an existing holder and never rewrites one.

## Decision

**Consent stays keyed by address, and a contact may not be moved off an opted-out address.** The address-change transaction carries a `ConditionCheck` that `UNSUBSCRIBE#<address being left>` does not exist. A failure answers `AddressOptedOut` (409), and it outranks `EmailAlreadyUsed` when both fail, because another address can be chosen and an opt-out cannot be worked around. A change of spelling that keeps the same mailbox key does not leave the address and is not checked.

Refusing is correct, not just cautious. An opted-out address is one that delivered mail and whose owner acted on it, so changing it never fixes a typo. It moves the contact to a different mailbox, and resuming mail to someone who opted out is the thing an opt-out forbids.

Suppression deliberately does not block the change. Correcting a hard-bounced address is exactly the right fix. The difference restates ADR-0004's distinction in behaviour: suppression is a fact about a mailbox, and an opt-out is a person's decision.

## Alternatives considered

**Key consent by contact**, as an attribute or a sibling item of `CONTACT#<id>`. The opt-out would follow the person through any address change, and the send path would lose a read. Rejected because consent would die with the contact, so deleting and re-importing would resubscribe everyone. Bulk import is a core operation, and address changes are rare.

**Carry the opt-out forward** by writing `UNSUBSCRIBE#<new address>` on a change. Rejected on two counts. Deciding to carry needs a prior read, so an opt-out landing between that read and the transaction would be lost. It would also create consent for a mailbox whose owner never opted out, and with no resubscribe path, anyone who later holds that address would stay unmailable forever.

**Keep both**, a contact-keyed record plus an address-keyed tombstone. Rejected as the largest design for the smallest gain: a second item type and a transactional opt-out write, to cover only the case the rejected contact-keyed option loses.

## Consequences

- No operation now turns an opted-out address back into a mailable contact. Deleting the contact and re-creating one at that address still works, and the send path still refuses it, because the consent record outlives the contact.
- An opted-out contact's address is frozen. The only way to reach the person at another mailbox is a new contact, which the system cannot link to the old one. That limit is intended: the system cannot know that a different mailbox belongs to the same person.
- The check adds no read to the update path, and it is atomic with the move. It adds one action to a transaction of three.
- The contract gains `AddressOptedOut` on `PATCH /contacts/:id`.
- Known residual, accepted — since retired by [ADR-0007](0007-immutable-recipient-unsubscribe-links.md): an opt-out `POST` reads the contact and then writes the opt-out for that address. An address change that commits in between records the opt-out against the old address. Closing that would need a transactional opt-out conditioned on the contact's current address, which is too much machinery for a race that needs a click and an edit on one contact within one round trip. ADR-0007 closed it for a different reason: the link now carries the mailbox it was issued for, so the `POST` performs no contact read that a concurrent edit could race.

## Confirmation

- Unit: the address-change transaction is asserted whole, including the `ConditionCheck` on the address being left. Cancellation at that slot answers `AddressOptedOut`, and a cancellation at both slots answers `AddressOptedOut` too. Each of those properties was mutation-checked: removing it fails the suite.
- Live: the unsubscribe integration test, having opted an address out, asserts that moving its contact to another address is refused with `AddressOptedOut`.
