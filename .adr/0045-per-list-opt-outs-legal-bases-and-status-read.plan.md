# Plan: per-list opt-outs, legal bases and a status read (ADR-0045)

Task 4797. [ADR-0045](0045-per-list-opt-outs-legal-bases-and-status-read.md) holds the design and its cost.

## Goal

- A product site enrols its users into a list through a single opt-in key, on consent or as existing customers, reads each user's status, and the emailer stays the only store of membership, evidence and opt-outs.

## Non-goals

- Sending anything to the new list, importing into it, or a site-facing "unsubscribe from everything".

## Tasks

1. **Per-list opt-out** (`storage/Addresses.ts`, `storage/Subscriptions.ts`, `Schemas.ts`, `Errors.ts`): `optedOutOf` is `optOuts.includes(listId)`; drop `rejoined` from the status read, the address record, the opt-out write and the confirm transaction, which does `DELETE optOuts :list`. Tests: `storage/Addresses.test.ts`, `storage/Subscriptions.test.ts`, `Dispatching.test.ts`, the CLI's address output.
2. **Consent record shapes** (`Schemas.ts`): `ConsentBasis`, the existing-customer record, optional `ip`; the `consent` block with an optional `basis` defaulting to `consent`.
3. **Sign-up by basis** (`consent/Subscriptions.ts`, `storage/Subscriptions.ts`): consent lifts the list's opt-out in the join transaction; existing customer refused once opted out, and refused for a double opt-in key. Tests: `consent/Subscriptions.test.ts`, `storage/Subscriptions.test.ts`.
4. **Status read** (`Api.ts` contract, `api/Api.ts` handler, `consent/Subscriptions.ts`): `POST /subscriptions/status`. Tests: unit for each state and the 403.
5. **Import evidence** (`ImportContactsPayload`, `audience/Lists.ts`, `storage/Membership.ts`, CLI `lists import --source --wording --basis`). Tests: storage records only for new members; CLI sends the block in every batch.
6. **Unsubscribe page** says "this list". Test: `UnsubscribePage.test.ts`.
7. **Migration script** `apps/backend/scripts/MigrateRejoined.ts` with a unit test of its update; deleted after the prod rollout.
8. **Live tests** in `consent/Subscriptions.live.ts` (and `Unsubscribe.live.ts` where it asserted the cross-list rule).
9. **Docs**: README (opt-outs, sign-up API, status, import), ADR-0027/0037/0041 "Amended by" lines.

## Evidence

- The API contract (requests, responses, errors) in the report, key files and snippets, the live suite's result, a hand check on a test stage (CLI against the stage: status read in each state, consent rejoin, existing-customer refusal; the unsubscribe page's new wording screenshot).

## Ops after landing

- Prod deploy, then the migration (counts only).
- On emailer prod, create the product's updates list and two dev stand-ins (updates and newsletter, both named "(dev)"), and two single opt-in keys: a prod key for the real updates and newsletter lists, a dev key for the two dev lists.
- Infinite's vaults, the same new names in both, old names (`EMAILER_LIST_ID`, `EMAILER_SIGNUP_KEY`) untouched:
  - `EMAILER_UPDATES_LIST_ID`: dev → the dev updates list; prod → the real one.
  - `EMAILER_NEWSLETTER_LIST_ID`: dev → the dev newsletter stand-in; prod → today's `EMAILER_LIST_ID`.
  - `EMAILER_INFINITE_KEY`: dev → the dev key; prod → the prod key.

## Open questions

- None: the Infinite orchestrator chose separate dev lists and the names above.

## Settled findings
