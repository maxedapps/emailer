# Plan: the account-holder basis and an explicit import basis (ADR-0046)

Task 4797, part 3. [ADR-0046](0046-account-holder-basis-and-explicit-import-basis.md) holds the design and its cost.

## Goal

- A product site enrols every account into a service-notice list through its single opt-in key on the `accountHolder` basis, and the operator imports existing accounts with `lists import --basis accountHolder`; no import records a basis nobody named.

## Non-goals

- Any mail to the new lists, any import into them, a change to the sign-up's default basis.

## Tasks

1. **Schema** (`packages/api/src/Schemas.ts`): `LegalBasis` (union of consent, existing customer and account holder, basis required) for imports, `SignUpBasis` (the same, consent by default) for sign-ups, the `accountHolder` record in `ConsentRecord`.
2. **Record** (`storage/Addresses.ts` `joinedAtOnce`): consent keeps its basis-less shape; the others record their own fields.
3. **Sign-up** (`consent/Subscriptions.ts`): a double opt-in key takes consent only (403); a single opt-in rejoin takes consent only (409 otherwise).
4. **CLI** (`apps/cli/src/commands/Lists.ts`): `--basis` required with any evidence; decode the flags with `LegalBasis`, excess fields refused.
5. **Tests**: unit tests for the sign-up (201, 409, 403, nothing mailed), the record shapes written and read back, the API's decoding, the CLI's refusals; the live sign-up suite adds an account holder's join, record and 409.
6. **Docs**: README (sign-up, statuses, import, `addresses status`), ADR-0045 "Amended by".

## Evidence

- The contract change, a hand check on a test stage (account-holder sign-up and import, the refusals, SES send count unchanged), the live suite's result.

## Ops after landing

- Prod deploy. On emailer prod, the account lists (prod and dev), new single opt-in keys covering the product's three lists each, stored with the list ids in the product's vaults; the old keys stay valid until the product runs the new ones.
