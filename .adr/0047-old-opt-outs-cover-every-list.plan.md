# Plan: Opt-outs from before the per-list rule cover every list (ADR-0047)

## Goal

Every opt-out recorded on prod before ADR-0045's deploy (2026-11-25 07:55:50 UTC) keeps its address from every list, existing and future, before the next campaign goes out. Non-goals: dating opt-outs, changing how opt-outs are recorded from now on.

## Tasks

1. **Storage:** `leftAllLists` (boolean) and `rejoined` (list IDs) on the address item; `optedOutOf` decides by both; the items codec learns DynamoDB's `BOOL`. Unit tests for the rule.
2. **Rejoin:** the opt-out state travels in `SubscriptionState.OptedOut`; a consent rejoin of a marked address adds `rejoined` in the same update. Unit tests for both rejoin paths.
3. **Contact move:** the condition refuses an address that left all lists too. Unit test.
4. **API and CLI:** `AddressRecord` returns `leftAllLists` and `rejoined`; README.
5. **Migration script** `apps/backend/scripts/MigrateAllListsOptOuts.ts` with a unit test of its update and cutoff; dry run on prod (counts only), then deleted after the prod run.
6. **Landing gate, prod deploy with `--force`, migration with `--apply`.**

## Evidence

Counts only: items marked, by the list they left, and how many were still mailable on a list they had not left.

## Open questions

None.

## Settled findings

- medium bug: a consent rejoin landing before or during the migration's scan can clear an old opt-out unseen, or be blocked by the unconditional mark — fixed: the script counts consent sign-ups since the deploy to lists from before it whose mailbox has an address item (an opt-out creates one and lifting it leaves it), refuses `--apply` while there is any, and runs again after writing to show none landed meanwhile.
- medium bug: the ADR's cost claim missed a marked address's consent sign-up to another list, which now adds an `UpdateItem` (2 WRU) — fixed: the ADR states it; investigated against ADR-0032: the operator's decision brings it, since any design keeping these addresses off every list must record the way back, and it costs only when one of them signs up again on consent.

## Rollout

- 2026-11-25, dry run before the deploy: 23,220 address items hold an opt-out; 23,106 name a list from before the deploy (Newsletter 23,078; a launch customers list 26; a checkout-fix list 1; a waitlist 2), 10 of them still mailable on a list they had not left. The other 114 name only lists created since. No consent record joined any of them since the deploy, so no `rejoined` exception is needed. Of the 2 consent sign-ups since the deploy to older lists, neither mailbox has an address item: both are first sign-ups, not rejoins.
- 2026-11-25: landed as 222606a after a green gate (`pnpm check`, the full live suite 43/43) and deployed to prod with `--force`. The migration then marked 23,106 address items (Newsletter 23,078; the launch customers list 26; the waitlist 2; the checkout-fix list 1), 10 of them still mailable on a list they had not left; no consent sign-up since the deploy could have lifted an old opt-out, before or after it wrote. Its rerun found no item left to mark. The script, its test and its knip entry went in the next commit.
