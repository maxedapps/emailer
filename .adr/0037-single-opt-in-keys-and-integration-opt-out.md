# ADR-0037: Single opt-in keys and an opt-out endpoint for integrations

- Status: Accepted
- Date: 2026-10-19
- Authority: On 2026-10-19 the user decided that a site's waitlist stays single opt-in, and asked for the emailer to support single and double opt-in side by side, plus an endpoint through which a site opts an address out of a list, so the unsubscribe links in mail the site sent itself keep working.
- Amends [ADR-0027](0027-signup-api-scoped-keys-and-double-opt-in.md): decision 3 (double opt-in only) and the scoped key's shape in decision 2.
- Plan: [0037-single-opt-in-keys-and-integration-opt-out.plan.md](0037-single-opt-in-keys-and-integration-opt-out.plan.md)

## Context

- **Sign-ups are double opt-in only.** `POST /subscriptions` always stores a pending sign-up and mails a link to the key's `confirmUrl`; only `POST /subscriptions/confirm` joins the list.
- **A site that already runs single opt-in** wants to move its list here without asking every new subscriber to confirm by mail.
- **Only the emailer's own signed link opts out.** A site whose earlier mail carries its own unsubscribe links has no way to forward them.
- **Prod holds scoped keys and consent records** in ADR-0027's shapes.
- **Constraints:** running cost is a hard rule (ADR-0032); a public form must never undo a recipient's opt-out.

## Decision

1. **The scoped key chooses the opt-in mode.** A key with a `confirmUrl` signs up with double opt-in, exactly as before. A key created without one adds subscribers directly: single opt-in. The confirm page and the confirmation flow belong together, so a key holds both or neither.
   - The request never picks the mode, so a caller can't weaken consent per call.
   - Stored keys and their API shape keep `confirmUrl`, now optional; existing keys stay double opt-in with no migration.
   - The middleware gives the handlers the mode as a tagged `OptIn` (`Double { confirmUrl } | Single`), not a maybe-missing URL.
   - The CLI asks for an explicit choice: `keys create` takes exactly one of `--confirm-url <url>` or `--single-opt-in`.
2. **A single opt-in sign-up joins at once** through the same `POST /subscriptions` and payload (consent, IP, name, attributes):
   - one transaction with the confirmation's own join steps (contact, reservation, membership both ways) and an append-only consent record `CONSENT#<listId>#<subscribedAt>` holding `{ listId, source, wording, ip, subscribedAt }`;
   - answers `201 Subscribed { listId }`, `200 AlreadySubscribed`, `409 AddressOptedOut`, plus the existing `403`, `404`, `422`, `409 ContactChanged`;
   - sends no mail, so it neither reads the send guard nor rate-limits.
   - **Consent records are a union by shape:** double opt-in's `{ requestedAt, confirmedAt, confirmIp }` or single opt-in's `{ subscribedAt }`, each beside `listId`, `source`, `wording`, `ip`. Existing records keep decoding unchanged.
3. **A single opt-in sign-up never lifts an opt-out.** An address that left the list answers `409 AddressOptedOut` and stays out. Anyone can type an address into a form, so only a confirmed mail (double opt-in) proves the mailbox's owner wants back in. Imports and the CLI keep never lifting one either.
4. **`POST /subscriptions/opt-out { listId, email }`**, for every scoped key and limited to its lists, adds the list to the address's `optOuts`: the same single `UpdateItem` as the signed unsubscribe link. It is idempotent, answers `204`, and reads nothing beyond the key, so an address with no record still gets its opt-out, which also keeps a later import from mailing it.

## Alternatives

- **The mode per request** (a flag in the payload). The simplest. Rejected: the caller would choose how strong the consent is on every call.
- **The mode per list.** Rejected: a list doesn't own a site's confirm page, so a double opt-in list would need every key covering it to carry one, an invariant across two records that a later mode change breaks. Lists in prod would also need a migration.
- **An explicit `optIn` field on stored keys and consent records.** Rejected: it adds a prod migration and a second field that must agree with the presence of `confirmUrl` or the confirmation fields.
- **Lift the opt-out on a single opt-in sign-up**, or answer such a sign-up with a confirmation mail. Rejected: the first lets a third party re-subscribe someone who left; the second needs a confirm page that single opt-in keys don't have.
- **A separate `POST /subscriptions/direct` endpoint.** Rejected: two sign-up endpoints with one payload, and nothing stops a double opt-in key calling the wrong one.
- **Opt-out removes the membership instead.** Rejected: an import would add the address back; the opt-out set is what every send and import already honours.

## Consequences

- **Mixed consent on one list is possible** when keys of both modes cover it. Each consent record shows which way its member joined, and `keys list` shows each key's mode.
- **An address that left a single opt-in list can't rejoin it through that form.** It rejoins only through a double opt-in key for the list. A site should show its usual success message for `409` too, so the form never reveals that an address unsubscribed.
- **A site can opt out any address on its lists,** as its own unsubscribe links could before. Keys are already trusted with sign-ups to those lists.
- **Running cost:**
  - existing paths are unchanged: double opt-in reads the same items, and admin calls still read nothing to authorize;
  - a single opt-in sign-up does a double opt-in's sign-up reads (the key, the address state, the reservation again for its holders, the list) and the confirmation's join transaction, including the contact GSI write when it creates a contact and the consent item's retained storage. It skips the pending item's write, the send guard, the SES mail and the confirm call's invocation and reads, so it costs less per subscriber than a double opt-in;
  - an opt-out is one API Lambda invocation with its duration and log lines, one strongly consistent key read (1 RRU) and one base-table `UpdateItem` on the address item (1 WRU while the item stays under 1 KiB, growing with its `optOuts`); the address item has no GSI key, so no index write. The address item and its `optOuts` are retained storage;
  - no new resource, index, permission, queue or idle cost; SQS and its polling are untouched.
- **Deploy:** a normal prod deploy with `--force`; no data migration.

## Confirmation

- The live `subscriptions` suite, on its own stage: a single opt-in key signs an address up and finds the member and the consent record; an address that opted out through the new endpoint is refused and stays out; a repeated opt-out changes nothing; the key can't opt out of another list.
- Unit tests cover the mode choice, the consent record and the CLI's flags.
