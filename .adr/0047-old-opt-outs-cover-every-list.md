# ADR-0047: Opt-outs from before the per-list rule cover every list

- Status: Accepted
- Date: 2026-11-25
- Authority: On 2026-11-25 (task 4841) the operator decided, before the next campaign to a large list, that every opt-out recorded before ADR-0045's prod deploy covers all lists, existing and future, applied by a migration: those opt-outs were made under ADR-0041 §4 ("an opt-out blocks every list"), and the unsubscribe page then promised no more mail from the sender at all.
- Amends: [ADR-0045](0045-per-list-opt-outs-legal-bases-and-status-read.md), decision 1: an address that opted out before the per-list rule stays away from every list until its own consent brings it back onto one.
- Plan: [0047-old-opt-outs-cover-every-list.plan.md](0047-old-opt-outs-cover-every-list.plan.md)

## Context

- **ADR-0045 made opt-outs per list** and went to prod on 2026-11-25 at 07:55:50 UTC. Its migration only removed legacy `rejoined` lists; it kept every existing opt-out on the one list it named.
- **Opt-outs from before then meant every list.** Under ADR-0041 §4 an opt-out kept the address from every list, and the unsubscribe page said so. Read per list, people who left one list the day before are mailable on another today.
- **Stored opt-outs carry no time.** `optOuts` is a string set of list IDs; neither it nor the address item records when each was added. What tells old from new is the deploy time against the lists' own `createdAt`: a list created since the deploy can only hold per-list opt-outs.
- **Constraints:** running cost is a hard rule (ADR-0032); the single-table design and the send path's one read per recipient stay.

## Decision

1. **An address item may carry `leftAllLists: true`**: the address left every list, present and future. An address is unsubscribed from list L when `optOuts` contains L, or when it left all lists and `rejoined` does not contain L. Sends, test sends, `campaigns check`, sign-ups and the status read keep deciding through the one function (`optedOutOf`).
2. **Its own consent brings it back onto one list.** A consent sign-up that lifts an opt-out (a confirmed double opt-in, or a single opt-in on consent, as ADR-0045 §3 says) removes the list from `optOuts` and, for an address that left all lists, adds it to `rejoined`, in the same `UpdateItem` as today. A later opt-out from that list adds it to `optOuts` again, which wins over `rejoined`. An existing customer's or account holder's sign-up still never lifts an opt-out.
3. **Only the migration sets `leftAllLists`.** Every opt-out from now on is per list, as ADR-0045 decided; nothing clears the flag.
4. **The migration** marks each address item whose `optOuts` names a list created before the deploy, or a list that no longer exists. One whose opt-outs all name lists created since keeps only those. It runs once on prod after the deploy and is then deleted, like ADR-0045's.
5. **The status read shows it:** `addresses status` returns `leftAllLists` and `rejoined` beside `optOuts`. Moving a contact onto an address that left all lists answers `409 AddressOptedOut`, as for any opt-out.

## Alternatives

- **Write every list into `optOuts`.** The simplest, with no new attribute. Rejected: a list created later would mail these people, breaking the promise the page made them.
- **Date each opt-out** (`optOuts` as a map of list to time) and decide by the deploy time. Needs a migration of every opt-out and a bigger item for no other gain, and the migration still could not date the old ones.
- **A flag with no exceptions**, refusing every rejoin. Rejected: a single opt-in sign-up on consent would answer `201` and record consent while sends kept skipping the address, or it would have to be refused, which ADR-0045 §3 rules out.
- **A cutoff by the unsubscribe page's logs.** The API's opt-out route logs no requests, so the page's logs would miss the opt-outs that came through it.

## Consequences

- **The people who left any list before the deploy, about 23,100 address items on prod, get nothing from any list** until they sign up again on consent. Most never were on another list; the count of those still mailable elsewhere goes into the plan's rollout.
- **An opt-out made through the API after the deploy from a list created before it** cannot be told apart and now covers every list. It errs towards mailing less.
- **`rejoined` returns** with ADR-0041's meaning, but only for addresses that left all lists: an address that never did stays on ADR-0045's plain per-list rule.
- **Running cost:**
  - sends, test sends and `campaigns check`: the same single read per recipient; the flag adds about 14 bytes to a marked item, still one read unit;
  - a consent sign-up of a marked address: to a list it left one by one, the same `UpdateItem` as before, with `ADD rejoined` beside `DELETE optOuts`; to any other list, one more `UpdateItem` in the join transaction (2 WRU) and about 40 bytes of storage per rejoined list, where before it joined without one. Any design that keeps these addresses off every list must record the way back onto one, so the decision itself brings this cost, and only when one of them signs up again on consent; every other write is unchanged;
  - sign-ups: the state they already read carries the flag, so no extra read;
  - storage: about 14 bytes per marked item, about 0.3 MB on prod; address items are not in the KEYS_ONLY index, so no index write or storage;
  - the migration: a one-off strongly consistent scan of the table plus one `UpdateItem` (1 WRU) per marked item, about 23,000 WRU: about 1.5 cents once;
  - no new resource, index, permission, queue, Lambda or log volume.
- **Deploy:** a normal prod deploy with `--force`, then the migration. A scan has no snapshot, and a consent sign-up since the deploy to an older list may have lifted an old opt-out the item no longer shows, so the migration refuses to write while any such sign-up exists for a mailbox with an address item (an opt-out creates one, and lifting it leaves it) and runs again afterwards to show none landed while it wrote; one that did is reconciled by hand.

## Confirmation

- `pnpm check`: unit tests for the rule (left all, rejoined, rejoined and left again), both rejoin paths' update, the subscription states, the status record, the contact move's condition, the boolean attribute and the migration's update and cutoff.
- The migration's dry run on prod, counts only, before it writes.
