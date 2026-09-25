# ADR-0027: A sign-up API with scoped keys, double opt-in and per-list opt-out

- Status: Accepted
- Accepted: 2026-09-25
- Date: 2026-09-25
- Authority: On 2026-09-25 the user asked for a website's newsletter form to add subscribers to prod, server to server. The site verifies bots itself (Turnstile). After two design rounds they chose:
  - scoped API keys beside the admin token;
  - double opt-in, with the confirmation page hosted by the calling site and only an API here;
  - per-list opt-out, since there will be several lists;
  - a neutral, English-only confirmation mail;
  - the subscriber's IP stored as consent evidence;
  - imported contacts keep the operator's word for consent;
  - links valid for 7 days, and at most one confirmation mail per address, list and hour;
  - pending requests and consent evidence as separate records.

  No campaign has reached a real recipient, so existing unsubscribe links and opt-out data may break.

  They approved this record and its plan on 2026-09-25, including append-only consent records (`CONSENT#<listId>#<confirmedAt>`), by asking for the implementation.
- Supersedes in part, once implemented:
  - [ADR-0004](0004-sender-owned-one-click-unsubscribe.md): the address-wide opt-out and "there is no resubscribe path";
  - [ADR-0006](0006-consent-survives-a-contacts-address-change.md): the address-change check now refuses when the address has an opt-out for any list;
  - [ADR-0007](0007-immutable-recipient-unsubscribe-links.md): the token's payload also names the list.
- Plan: [0027-signup-api-scoped-keys-and-double-opt-in.plan.md](0027-signup-api-scoped-keys-and-double-opt-in.plan.md)

## Context

- **Every route sits behind one static admin token**, `EMAILER_API_TOKEN`. A website that holds it could do anything.
- **Contacts only enter through the admin API.** There is no double opt-in, no consent record, and no mail outside campaigns.
- **An opt-out covers the whole address.** Once there are several lists, that is wrong in two ways:
  - leaving one list silently leaves all of them;
  - a confirmed sign-up to a new list would have to lift the opt-out, which would revive every old membership.
- **Constraints:**
  - running cost is a hard rule, so no existing path may cost more;
  - stay on DynamoDB, with no new AWS resource that isn't needed;
  - the site owns the user-facing pages. The emailer exposes an API with typed errors and proper status codes.

## Decision

1. **Opt-outs are per list.**
   - The `ADDRESS#<mailbox>` item gains `optOuts`, a string set of list ids. The send path still reads one item.
   - An unsubscribe link signs `[mailbox, listId]`. Its POST is one `ADD` to the set, so the unsubscribe function keeps its `UpdateItem`-only permission.
   - Only the address's own confirmed opt-in to a list removes that list from the set. Imports and the CLI never do.
   - Suppression (bounces, complaints) stays address-wide: it is a fact about the mailbox.
2. **Scoped API keys.**
   - **Admin:** stays the configured `EMAILER_API_TOKEN`, checked in memory.
   - **Scoped keys:** `emk.<id>.<secret>`, with 32 random bytes of secret. Each is stored as `pk=APIKEY, sk=<id>` holding `{name, lists, confirmUrl, secretHash, createdAt}`. The hash is SHA-256, computed with Effect's `Crypto`.
   - **Lifetime and changes:** keys have no expiry and can't be edited. Rotating means create, swap, revoke. Revoking deletes the item.
   - **Two middlewares in the contract.** `AdminAuthorization` covers every existing group plus the new `keys` group. `SubscriptionAuthorization` covers only the new `subscriptions` group and provides the key's `Integration` (lists, confirm URL) to the handlers.
   - Neither middleware accepts the other's credential.
3. **Double opt-in, through the API only.**
   - **`POST /subscriptions`:**
     - checks the list against the key and reads the address's state;
     - stores `ADDRESS#<mailbox>/PENDING#<listId>` holding the request, the consent wording, the source, the IP, the link secret's hash and a `ttl` (7 days, epoch seconds);
     - sends the confirmation mail.
     - **Answers:** `202` sent · `200` already subscribed · `403` list not in the key · `404` · `422` undeliverable address · `429` mail sent within the hour · `503`.
   - **The link** is the key's `confirmUrl` with `?token=<mailbox>.<listId>.<secret>`. The site's page shows a button on GET and calls the API on POST, because link scanners fetch every GET.
   - **`POST /subscriptions/confirm`** runs one transaction:
     - the import's own join steps (contact, reservation, membership in both directions);
     - an append-only consent record `CONSENT#<listId>#<confirmedAt>` holding `{source, wording, ip, requestedAt, confirmedAt, confirmIp}`;
     - the pending delete;
     - removing the list from `optOuts`.
     - An invalid, expired or already-used link answers `404 ConfirmationNotFound`.
   - **The mail** is built by `Message.ts`: English, neutral, text and HTML, the list's name, the link, its expiry, "ignore this if it wasn't you" and the postal address. It has no `List-Unsubscribe`.
   - **The mailer takes one `Mail` tagged enum** (`Campaign | Test | Confirmation`) in place of `SendPurpose` and loose arguments. Only campaign mail carries feedback tags.
4. **Nothing else changes in the infrastructure.** Only DynamoDB TTL on the attribute `ttl`, which Alchemy applies in place. The rate limiter already uses `expiresAt` in milliseconds, so TTL can't reuse that name.

## Alternatives

- **A second env token for the site.** The simplest option. Rejected, because rotating or revoking it needs a redeploy and nothing can manage it.
- **All keys in the table, admin included.** Rejected: it needs a bootstrap path around the API, and puts a read on every admin call and import.
- **IAM-signed calls, or API Gateway keys.** Rejected: long-lived AWS credentials in the site, no scoping per list, and new cost.
- **A confirm page hosted here** (a new public function with a signing secret). Rejected, because the user wants the site to own the pages.
- **Stateless double opt-in** (everything in the signed link). Rejected: the consent wording and attributes don't fit in a URL, and no state means no resend limit.
- **Pending as a contact or member state.** Rejected: every read path and the dispatcher would have to filter it out.
- **One record per list for pending and consent, reusing TTL.** About $0.01 cheaper per 10,000 confirmations. Rejected: TTL deletes whole items, so an unconfirmed re-sign-up could erase earlier consent evidence (GDPR Art. 7(1)).
- **Per-list opt-out records instead of a set.** Rejected, because every recipient of every campaign would cost a second read.
- **SES templates for the confirmation mail.** Rejected: SES accepts a templated mail that fails to render and then drops it, and it would be a second way of building messages.
- **Key a scoped key's lookup through the listing index.** Rejected: keys are few, so one partition needs no index write and no hydration.

## Consequences

- **Opt-out timing:** `addresses status` shows which lists an address left, not when.
- **Suppressed or bouncing addresses** can't sign up (`422`) until the operator runs `addresses unsuppress`.
- **One per-list rule:** unsubscribing from one list leaves the others. A confirmed sign-up lifts only that list's opt-out. The address-change check refuses while any list's opt-out stands.
- **A confirmation mail that SES refuses after the pending write** blocks a new one for an hour. The send guard runs before the write, so a paused account never gets that far.
- **Running cost:**
  - existing paths are unchanged: one read per campaign recipient, one write per unsubscribe, no read on admin calls;
  - a confirmed sign-up costs about $0.000115, most of it the SES mail;
  - unconfirmed requests expire for free.
- **Deploy:** a normal prod deploy with `--force`. Old unsubscribe links stop working. Leftover `unsubscribedAt` fields in prod are removed once.

## Confirmation

- A contract test sends a scoped key to every admin endpoint and expects 401, and sends the admin token to the sign-up endpoints and expects 401.
- The live suite, on its own stage:
  - signs up a simulator address and finds its pending record;
  - confirms a planted pending record and finds the member, the consent record and the lifted opt-out;
  - unsubscribes from one list and stays mailable on another.
- After the prod deploy, `describe-time-to-live` reports `ttl` as enabled, and the table was updated in place, not replaced.
