# ADR-0046: The account-holder basis, and an import names its basis

- Status: Accepted
- Date: 2026-11-25
- Authority: On 2026-11-25 (task 4797) the operator decided that a product site keeps a second list holding every account, for service notices only, filled through the API and by one import, and that no mail of any kind goes out for it. The orchestrator's brief asks for an `accountHolder` basis with its own record shape and no consent claim, blocked by an opt-out as an existing customer is, and for the basis to be explicit wherever an import gives evidence.
- Amends: [ADR-0045](0045-per-list-opt-outs-legal-bases-and-status-read.md), decisions 2, 3 and 5.
- Plan: [0046-account-holder-basis-and-explicit-import-basis.plan.md](0046-account-holder-basis-and-explicit-import-basis.plan.md)

## Context

- **A list of every account.** A product site enrols each account into a list that carries service notices only, mailed because the user has an account (GDPR Art. 6(1)(b)), not because they agreed or bought. Neither basis ADR-0045 knows fits: a consent record would claim an agreement nobody gave, an existing-customer record a purchase and an objection notice that free accounts never saw. Nothing was shown to the user, so there is no wording to record.
- **An import's basis defaulted to consent.** `lists import --source … --wording …` without `--basis`, and `POST /lists/:listId/contacts` with `consent: { source, wording }`, recorded consent. Preparing the accounts import, a file of free accounts nearly went in that way, labelled as consent.
- **The sign-up's default is load-bearing.** A live public form sends `consent: { source, wording }` with no basis through a double opt-in key, which takes consent only.
- **Constraints:** running cost is a hard rule (ADR-0032); nothing may mail an account holder unasked.

## Decision

1. **A third basis, `accountHolder`, with its own record.** `{ basis: "accountHolder", listId, source, ip?, subscribedAt }`: where the account was opened (or the import that brought it), from which address when the caller saw one, and when. It holds no `wording`, since nothing was agreed to or shown. Records of the other bases are unchanged.
2. **The basis block is a union by basis.** `consent` and `existingCustomer` take `{ basis, source, wording }`; `accountHolder` takes `{ basis, source }`, and a `wording` sent with it is refused (`400`), as the API refuses any field it does not know, so no caller believes it recorded one.
3. **A sign-up treats an account holder as an existing customer.** Only a single opt-in key enrols one (`403 Forbidden` for a double opt-in key, whose confirmation would turn it into consent). It never lifts an opt-out: an address that left the list answers `409 AddressOptedOut` and stays out. It mails nothing, as no single opt-in sign-up does.
4. **An import always names its basis.** `POST /lists/:listId/contacts` takes `consent: { basis, source, wording? }` with `basis` required. `lists import` requires `--basis` once any evidence flag is given, `--source` with every basis, `--wording` with `consent` and `existingCustomer` and never with `accountHolder`; the CLI refuses any other mix before the first request.
5. **A sign-up keeps `consent` as its default basis.** A public double opt-in form can name no other, and the live one sends none.

## Alternatives

- **Record account holders as existing customers, or as consent without a box:** the simplest, no new shape; refused, since each claims what did not happen (a purchase and objection notice, or an agreement), which is exactly the mislabel to avoid.
- **A free-form `basis` string:** no schema change per basis, but the opt-out and double opt-in rules depend on the basis, and a typo would silently record consent's rights.
- **`accountHolder` with an optional wording:** nothing is shown at account creation, so a field that is always empty or invented adds nothing.
- **Require the basis on sign-ups too:** breaks the live public form, which sends none, for no gain: a double opt-in key takes consent only.
- **Keep the import default and only warn:** a warning scrolls by; an import with evidence is rare and run by hand, so naming the basis costs one flag.

## Consequences

- An account-holder list is filled by sign-ups through a single opt-in key and by `lists import --basis accountHolder --source …`; `addresses status` shows the records.
- Leaving such a list blocks it for good unless a consent sign-up brings the address back, which a service-notice list should not offer.
- A caller of `POST /lists/:listId/contacts` that sent evidence without `basis` now gets `400`; only the operator's CLI calls it.
- **Cost:** none. An account-holder record is one item like the others, a few bytes smaller; no new resource, index, request or log line.
