# Consent identity and storage cleanup

- Status: Complete — all five implemented; see Handoff
- Date: 2026-09-12
- Trunk: `main` at `7e3b502`, after the contact-management and consent/unsubscribe slices were merged
- Authority: The user asked for every issue found reviewing the merged trunk to be fixed in the
  cleanest possible way, explicitly welcoming refactors and rewrites, and explicitly refusing
  legacy, compatibility and fallback code, then approved the fixes proposed here for implementation.

## Why these issues exist at all

Both slices were reviewed independently and both were reported clean. Every issue below lives at
the **seam** between them: one slice made consent an address-keyed fact, the other made a contact's
address mutable, and no review looked at the pair. That is also why the fixes are small — nothing
here is a design failure, it is two correct designs meeting for the first time.

---

## I1 — A contact's address change silently discards their opt-out

**Severity: high. Confirmed by source; no test covers it.**

`Storage/Feedback.ts` keys consent on the mailbox: `UNSUBSCRIBE#<mailboxKey(email)>`.
`Campaigns.send` gates on `addressStatus(contact.value.email)` — whatever address the contact holds
_now_ (`Campaigns.ts:94-96`). `Storage/Contacts.ts:updateContact` rewrites `email` and moves the
`EMAIL#` reservation (`:331-366`) and touches no consent item.

So: a recipient clicks the one-click link and is opted out. An operator later runs
`contacts update <id> --email <other>`, a documented command (`README.md:88`). The next campaign to
that contact is accepted and delivered.

`updateContact` is the only path in the system that changes a contact's address — `importContacts`
reuses the existing holder rather than rewriting it (`Storage/Membership.ts:471-474`), and nothing
else writes `#email`. So this one function is the entire exposure.

ADR-0004 gave three reasons for address-keying (`:22`). Two still hold. The third — _"at this
baseline `createContact` enforces no uniqueness on email, so contact-keyed state would leave a
duplicate contact mailable"_ — was retired by ADR-0005's `EMAIL#` reservation. And ADR-0004:43
states flatly **"There is no resubscribe path… it must be revisited with the open contact list."**
The open contact list is merged, and it shipped one.

### Alternatives

**A. Move consent onto the contact** (`CONTACT#<id>` attribute or sibling item). The opt-out then
follows the person through any address change for free, and the send gate gets cheaper — `getContact`
already reads that item, so the send path would drop from two extra `GetItem`s to one.
**Rejected.** It trades this hole for a worse one: consent would die with the contact, so
delete-then-re-import resubscribes everybody. Bulk import is a first-class feature of this very
slice. Address changes are rare; re-imports are the product.

**B. Carry the opt-out forward** — on an address change, also write `UNSUBSCRIBE#<new address>`.
**Rejected, on two counts.** It cannot be made atomic: the decision to carry needs a read of the old
address's consent, so a concurrent opt-out lands in the gap and is lost. And it manufactures a
consent record for a mailbox whose owner never opted out — if that contact is later deleted and the
address reused by a different person, that person is permanently unmailable with no resubscribe
path to clear it.

**C. Keep both representations** — a contact-keyed record that follows the person plus an
address-keyed tombstone that outlives them. Closes both holes completely.
**Rejected as the largest design for the smallest gain.** It doubles the write on the opt-out path,
adds an item type and a transaction, and buys only the case A already loses.

**D. Refuse the address change while the current address is opted out. ← chosen**

### Why refusing is the _correct_ answer and not merely the conservative one

An opted-out contact's address is, by construction, an address that successfully delivered mail and
whose owner acted on it. Changing it is therefore never a correction of a typo — a typo'd address
does not receive mail and its owner does not click links in it. It is a move to a different mailbox,
and moving an opted-out person to a different mailbox in order to resume mailing them is precisely
the thing that must not happen. Refusal is not a limitation of the model; it is the model saying
what it means.

It also composes with what is already there. Delete the contact and create a new one at the same
address: `createContact` succeeds (the reservation died with the contact) but the send gate still
refuses, because the consent record is address-keyed and outlived both. Create a new contact at a
_different_ address: nothing links it to the opted-out person, and no representable invariant is
broken. With D in place there is no remaining path from "opted out" to "mailable".

### The fix

One `ConditionCheck` at slot 0 of the address-change transaction in `updateContact`:

```ts
{
  // The address being left must not be opted out. An opted-out address is by definition one that
  // delivered mail and whose owner acted on it, so this is never a typo correction — it is a move
  // to a different mailbox, which is the one way an opt-out could be escaped. Checked here rather
  // than read first: a read would leave a window for an opt-out landing mid-update.
  ConditionCheck: {
    Table: tableLogicalId,
    Key: unsubscribeKey(current.email),
    ConditionExpression: "attribute_not_exists(pk)",
  },
},
```

Atomic, race-free, and it costs no read — the transaction already runs. Slots shift to
Update (1) / Delete old reservation (2) / Put new reservation (3), so `conditionFailures.has(0)`
becomes the new outcome and `has(3)` becomes `email-taken`. Both can fail in one cancellation —
the address is opted out _and_ the target is taken — and `has(0)` is answered first: the refusal an
operator cannot work around outranks the one they can.

The same-mailbox-key short-circuit branch does **not** get the check: a spelling-only change does
not move the contact off the address, so there is nothing to gate.

Suppression deliberately does **not** block the change. A hard-bounced address is exactly the case
where correcting it is the right remedy. That asymmetry is the clearest statement the codebase can
make of what the two item types mean: a bounce is a fact about a mailbox, an opt-out is a decision
by a person.

**Surface:** `UpdateContactOutcome` gains `{ outcome: "opted-out"; email }` (the address being left);
`Contacts.update` maps it to a new `Schemas.ContactOptedOut { email }` at 409, beside
`EmailAlreadyUsed`; the endpoint's error list gains it. The CLI renders errors by tag and needs no
change.

**Tests:** a whole-request assertion that the address-change transaction carries the check (the
idiom the `Storage/Lists.ts` suite established); a scripted cancellation at slot 0 → `opted-out`;
the handler mapping; the endpoint's 409. Live: the existing unsubscribe integration test already
opts an address out — one extra request there asserts the refusal against real DynamoDB.

**Record:** this is a material change to an accepted decision, so it is **ADR-0006**, with a forward
link added to ADR-0004's Consequences. ADR-0004:22's retired third reason and :43's "no resubscribe
path" are what ADR-0006 supersedes.

---

## I2 — `Storage/Feedback.ts` owns consent, which its name denies

**Severity: low on its own. A prerequisite for I1.**

The merge put `UNSUBSCRIBE#`, `unsubscribeAddress` and `addressStatus` into the module named for
feedback, because `addressStatus` reads the unsubscribe key and the suppression key in one
operation and splitting them would mean sharing `suppressionKey` across modules. That was the right
call for a merge and the wrong shape to keep. R8 recorded the convention as ownership by item type
(`.adr/work/contact-list.md`, R8: _"`Feedback` owns `SUPPRESSION#`/`FEEDBACK#`"_), written before
consent existed.

I1 forces the question: `updateContact` needs `unsubscribeKey`, and importing a consent key from a
module called `Feedback` would be worse than the status quo.

### Alternatives

**Rename `Storage/Feedback.ts` to `Storage/Consent.ts`.** Rejected — `CAMPAIGN#…/FEEDBACK#` records
are not consent; the lie just changes direction.

**Move the `FEEDBACK#` records into `Storage/Campaigns.ts`** (they live in the campaign partition)
and rename what remains. Rejected as a second refactor riding along: it deletes a module and makes
the app-level `Feedback.ts` import its storage from `Campaigns.ts`, which reads worse than it looks
on a partition diagram.

**Split the address-keyed state into its own module. ← chosen**

`Storage/Addresses.ts` owns `SUPPRESSION#` and `UNSUBSCRIBE#` and the `addressStatus` question that
reads both; `Storage/Feedback.ts` keeps `FEEDBACK#` and nothing else. Both names become true, and
`addressStatus` stays whole in the module that owns both keys it reads.

The one ambiguity worth naming in the module docstring: `EMAIL#` is also address-keyed but is
contact _identity_ and stays in `Contacts.ts`. `Addresses.ts` owns what is known about a mailbox
**independently of any contact, and outliving one**.

Mechanical: ~120 lines and their tests move; seven type imports re-point; `Storage/Table.ts` spreads
one more operation group. R8's sentence gets a one-line update.

---

## I3 — `updateContact`'s two branches disagree about what they condition on

**Severity: medium. Previously found and deliberately deferred; proposed for inclusion now.**

The address-change branch conditions on `attribute_exists(pk) AND #email = :currentEmail`
(`Storage/Contacts.ts:342`). The same-mailbox-key short-circuit conditions on `attribute_exists(pk)`
alone (`:315`). Two concurrent updates can therefore revert a concurrent address change and strand
the new reservation, which no endpoint can then clear.

This was F1 in the implementation review, deferred as niche — correctly, on its own. Three things
changed: I1 rewrites this exact function, the user has asked for no leftover weak paths, and the
fix turns out to be **net-subtractive**.

Adding `AND #email = :currentEmail` means the short-circuit branch always binds a value. The
`ExpressionAttributeValues`-may-be-empty special case then becomes unreachable and goes away:

- the conditional spread at `:321-327` collapses to a plain request object,
- `ContactChange.ExpressionAttributeValues` loses its `| undefined` (`:79`),
- `contactChange`'s `Object.keys(values).length === 0 ? undefined : values` collapses to `values`
  (`:134`),
- and the comment explaining the empty-map hazard goes with them.

One trap to state rather than let the implementer meet live: on a name-only or clear-only update
`change.ExpressionAttributeNames` carries no `#email`, because `contactChange` adds it only when an
address is supplied (`:96-100`). The new condition references it, so the short-circuit must merge
`"#email": "email"` in unconditionally. A referenced-but-undeclared name is a `ValidationException`,
which R4 recorded as the failure mode that bypasses cancellation handling and fails identically on
every retry.

Net: one condition added, roughly a dozen lines and one type refinement removed, and the two
branches of one function finally say the same thing. The existing clear-only regression test stays,
asserting the request it now produces.

---

## I4 — The integration suite can only run once per deployed stage

**Severity: none. Proposed disposition: record it, write no code.**

`drive` sends to `bounce@`/`complaint+` and asserts the address becomes suppressed; the unsubscribe
test opts `success+unsub` out and asserts it was mailable beforehand. Both records are permanent by
design and the allowlist forces the same few simulator addresses every run, so a second run against
a surviving stage fails — first at `contacts.create` with `EmailAlreadyUsed`, and, were that
resolved, again at the assertions themselves.

Making it re-runnable would require a resubscribe path and an un-suppress path, both of which
ADR-0004 refuses on purpose. A precondition guard would be machinery guarding a condition CLAUDE.md
already mandates — stages are ephemeral. The honest fix is a sentence in the work document and one
in `README.md`'s testing section saying the consent and suppression tests require a fresh stage.
Partly fixing it — swapping `contacts.create` for the resolve-or-create helper — is worse than
leaving it: it removes the loud early failure and leaves the quiet late one.

---

## I5 — Records that point at a file the merge deleted

**Severity: clerical.**

- `.adr/0001-resource-owning-effect-services.md:14` still says `Storage.ts` owns the persistence
  service. It is an accepted ADR and its decision is unchanged, so this is a clerical correction in
  place: `Storage/`.
- `.adr/work/consent-and-unsubscribe.md` carries five `Storage.ts:NNN` references. It is a record
  of finished work, so it gets the same **"Note on references"** header the `contact-list` documents
  use rather than re-pointed line numbers. `feedback-and-suppression.md` gets the same.
- `.adr/0004-…:43` gains the forward link to ADR-0006 (a lifecycle link, permitted in place).
- Landing I1 closes the _"Open at the seam, not fixed"_ bullet the merge added to
  `contact-list.md`'s handoff, and I3 reverses F1's **Deferred** disposition both there and in the
  Closure table of `contact-list-implementation-review.md` (`:132`). Left alone the records would
  contradict the code, which is the same drift F4 was raised for.

---

## Known residual, proposed as accepted rather than fixed

An opt-out `POST` reads the contact, then writes `UNSUBSCRIBE#<that address>`. An address change
committing in between records the opt-out against the address the contact no longer holds. It is
strictly narrower than I3's window — it needs a human clicking an unsubscribe link in the same
instant an operator edits that contact's address — and closing it needs the opt-out write to become
a transaction conditioned on the contact's current address, which is real machinery for a race that
requires two humans acting on one contact within one round trip. Recorded, not fixed.

---

## Order of work

1. **I2** first — the module split is a pure move, and I1 writes into the module it creates.
2. **I1 + I3** together — one function, one set of tests, one behavioural change to `updateContact`.
3. **ADR-0006**, drafted `Proposed`; ADR-0004 forward link.
4. **I4 + I5** — documentation only.
5. `pnpm check` at each step. The live assertions in I1 and the unexercised cascade probes inherited
   from the contact-list slice all need one `--stage test` deployment, which needs the `EMAILER_API_TOKEN`
   rotation plus the `EMAILER_UNSUBSCRIBE_*` configuration — the user's secrets, so that run is theirs to
   authorize.

## Deliberately not in scope

The send path's two `GetItem`s, the `contactId` attribute on the unsubscribe record (evidence only,
never read back), and any resubscribe or un-suppress capability. None is a defect and each would be
a new decision.

## Handoff

Implemented on `main` in three commits, each green under `pnpm check`:

- **I2** — `refactor(storage): give address-keyed state its own module`. A pure move: 351 unit tests
  before and after. `conditionFailed` became a shared fixture in `Storage/Testing.ts`, since both
  suites now script it.
- **I1 + I3** — `fix(contacts): refuse to move a contact off an opted-out address`. **357** unit
  tests. The address-change transaction is asserted whole. Six mutations were each confirmed to fail
  the suite: dropping the `ConditionCheck`, keying it on the new address instead of the old one,
  never reporting `opted-out`, answering `email-taken` first, dropping the `#email` name
  declaration, and restoring the weak plain-path condition.
- **ADR-0006, I4, I5** — the decision record, README guarantees and the run-once note, and the
  record corrections listed under I5.
- **Deviation:** the contract error is `AddressOptedOut`, not `ContactOptedOut` as proposed above.
  Consent belongs to the address, and the error names the address being left, which matches
  `AddressStatus` and `AddressUnsubscribe`.
- **Not yet exercised live:** the new integration assertion in the unsubscribe test, and the
  cascade probes inherited from the contact-list slice. Both need one fresh `--stage test` run.
