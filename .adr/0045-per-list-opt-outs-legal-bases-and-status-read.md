# ADR-0045: Per-list opt-outs, legal bases and a status read for integrations

- Status: Accepted
- Date: 2026-11-25
- Authority: On 2026-11-25 (task 4797) the operator approved a list that a product site enrols people into through the API, with the emailer as the only store of its membership, evidence and opt-outs. He decided that an opt-out applies to its own list only, reversing his decision of 2026-11-18 (task 4068); that a single opt-in sign-up with a consent record lifts that list's opt-out, with no double opt-in to rejoin; that an existing customer enrolled after a purchase is recorded as its own legal basis and never lifts an opt-out; that a scoped key may read an address's status on its lists; and that an import may carry its evidence.
- Amends:
  - [ADR-0041](0041-personalized-templates.md), decision 4: an opt-out keeps the address from its own list only; `rejoined` is gone.
  - [ADR-0037](0037-single-opt-in-keys-and-integration-opt-out.md), decision 3: a single opt-in sign-up on the consent basis lifts that list's opt-out. Decision 2: the consent record gains the existing-customer shape and `ip` becomes optional.
  - [ADR-0027](0027-signup-api-scoped-keys-and-double-opt-in.md), decision 2: a scoped key may read an address's status on its lists.
- Plan: [0045-per-list-opt-outs-legal-bases-and-status-read.plan.md](0045-per-list-opt-outs-legal-bases-and-status-read.plan.md)
- Amended by [ADR-0046](0046-account-holder-basis-and-explicit-import-basis.md): a third basis, `accountHolder`, records `{ basis, listId, source, ip?, subscribedAt }` with no wording and, like an existing customer, never lifts an opt-out; an import's evidence always names its basis.

## Context

- **A product site enrols its users into an updates list** and shows each user a toggle for it in their account settings. It must show the toggle's state, so it needs to read where the address stands; today only the admin token can (`GET /addresses/status`).
- **Two legal bases.** A user who ticks a box or flips the toggle consents (GDPR Art. 6(1)(a)). A buyer enrolled after paying, whose checkout showed a notice and the right to object, is mailed as an existing customer (§7(3) UWG, GDPR Art. 6(1)(f)). The consent record has no field for the basis, and requires the subscriber's IP, which a server-side enrolment after payment does not have.
- **An opt-out blocks every list** (ADR-0041 §4). Turning the site's toggle off would silence every other list too, and anyone who ever left any list is refused by single opt-in (`409`) and needs a confirmation mail to come back.
- **An import records no evidence**: imported members have no consent record at all.
- **Constraints:** running cost is a hard rule (ADR-0032); the emailer is the single source of truth, so the site keeps no copy of the state.

## Decision

1. **An opt-out applies to its own list.** The address item's `optOuts` holds the lists the address left; an address is unsubscribed from list L exactly when `optOuts` contains L. `rejoined` goes from storage, the API and the CLI. An opt-out (the signed link, one-click, `POST /subscriptions/opt-out`) adds its list; whatever lifts it removes the list from `optOuts`. Sends, test sends, `campaigns check` and sign-ups keep deciding through the one function. The unsubscribe page says "this list" and still names none: the public function reads nothing (ADR-0004).
2. **Each consent record names its legal basis by shape.** Beside double opt-in's `{ requestedAt, confirmedAt, confirmIp }` and single opt-in's `{ subscribedAt }`, an existing customer's record is `{ basis: "existingCustomer", subscribedAt }`. All three carry `listId`, `source`, `wording` and an optional `ip`. Stored records keep decoding unchanged.
3. **The sign-up names its basis.** `POST /subscriptions` takes `consent: { basis?, source, wording }` with `basis` `"consent"` (the default) or `"existingCustomer"`, and an optional `ip`. Existing callers keep working unchanged.
   - **Consent, single opt-in key:** an address that left the list joins again; the same transaction removes the list from `optOuts` and appends the new consent record. `201 Subscribed`.
   - **Consent, double opt-in key:** unchanged: the confirmation mail, and the confirmed link removes the list from `optOuts`.
   - **Existing customer:** only a single opt-in key may enrol one (`403 Forbidden` for a double opt-in key, whose confirmation would turn it into consent). It never lifts an opt-out: an address that left the list answers `409 AddressOptedOut` and stays out.
4. **`POST /subscriptions/status { listId, email }`** answers `{ status }`: `subscribed`, `notSubscribed`, `optedOut` or `undeliverable`, exactly the sign-up's own `subscriptionState`. Any scoped key, limited to its lists (`403` otherwise). It is meant for a signed-in user's own address, read server to server; a public form must not call it, since it tells whether an address is on a list. `POST` keeps the address out of URLs and logs.
5. **An import may carry its evidence.** `POST /lists/:listId/contacts` takes an optional `consent: { basis?, source, wording }`; each contact the import newly adds to the list gets a record of that basis, with no `ip`, dated by the import. A contact already on the list gets none, so a repeated import writes nothing new. An import still never lifts an opt-out. The CLI takes `--source`, `--wording` and `--basis`.
6. **Prod's address items move over in a one-off migration**: an item holding `rejoined` loses those lists from `optOuts` and the attribute itself.

## Alternatives

- **Keep the cross-list opt-out and give the site's toggle a list of its own exemption.** Rejected by the operator: one person's toggle should not silence other lists, and past opt-outs elsewhere should not block an enrolment.
- **Per-list opt-out with an extra "unsubscribe from everything" option.** A second write path and more page UI for a need nobody stated. Rejected for now.
- **Rejoin only through double opt-in** (ADR-0037 §3 as it stands). Rejected by the operator: the toggle is flipped by a signed-in user, whose account already proves the mailbox.
- **An explicit `basis` on every consent record.** Needs a migration of every stored record for a field the shapes already imply. Rejected, as ADR-0037 rejected an explicit `optIn`.
- **The basis as free text in `source`.** The simplest. Rejected: the opt-out rule depends on it, so it must be typed.
- **A new error for an existing customer through a double opt-in key.** `Forbidden` already means "this key may not do that"; a new class adds nothing for the caller.
- **An outbound webhook on opt-out instead of the status read.** New resources (a stream or rule, a dispatcher, retries, per-key secrets), an invocation per event, and a copy of the state on the site. Rejected for cost and for the single source of truth.
- **The status on `GET` with the address in the query.** Rejected: addresses would land in URLs and access logs.
- **Evidence for every imported contact, new or not.** No membership read, but each repeated import would append a record claiming a later date for an old member. Rejected.
- **Migrate before the deploy.** Either order briefly keeps someone from a list they rejoined, never mails someone who left; deploying first means no old code writes `rejoined` after the migration.

## Consequences

- **A single opt-in form can now bring back an address that left its list.** Anyone can type an address into a form, so a public form's key carries that trust now; a site with a public form and no sign-in should use a double opt-in key. The new consent record and its timestamp are the evidence.
- **Leaving one list no longer stops the others,** which is what the operator decided and what the README and the unsubscribe page say.
- **A prod address item that rejoined one list and then left another** lost which lists it rejoined before that opt-out (ADR-0041 cleared `rejoined`); the migration keeps it out of both. It errs towards mailing less.
- **The status read lets a key holder test whether an address is on its lists.** Keys are trusted with sign-ups and opt-outs on those lists already.
- **Running cost:**
  - status read: on demand only, one API Lambda invocation, the key read (1 RRU), the address item and reservation reads and, when a contact holds the address, one member read: about 3–4 strongly consistent RRU, no write;
  - a consent sign-up that lifts an opt-out adds one `Update` of the address item to the join transaction (2 WRU, as transactional); every other sign-up is unchanged, and an existing customer's record is the same size as a single opt-in's;
  - the double opt-in rejoin does `DELETE` instead of `ADD`: no change;
  - an import with evidence reads the membership of each contact that already holds its address (one strongly consistent read each, batched) and puts one consent item per new member (2 WRU, transactional): about +3 units and some bytes of storage per new member, only when evidence is given; an import without evidence is unchanged. A batch of 20 stays within DynamoDB's 100 actions per transaction;
  - opt-out: the same single `UpdateItem`, which no longer removes `rejoined`; sends: the same single read per recipient;
  - the migration is a one-off strongly consistent scan of the table plus one update per affected item: fractions of a cent;
  - no new resource, index, permission, queue or idle cost.
- **Deploy:** a normal prod deploy with `--force`, then the migration.

## Confirmation

- `pnpm check`: unit tests for the per-list rule, both rejoin paths, the existing-customer refusals, the status answers, the import's evidence for new members only, the CLI's flags and the migration's update.
- The live `subscriptions` suite on its own stage: an opt-out from one list keeps the other; a consent sign-up through a single opt-in key brings an opted-out address back with a new record; an existing customer is enrolled, and refused once opted out; the status read answers each state and refuses another list.
