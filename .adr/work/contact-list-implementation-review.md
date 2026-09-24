# Contact management — implementation review (PR #1)

> **Target:** branch `contact-list` → `main` (PR #1), 46 files, +7806/−1858, reviewed at `b4c15e7`
> **Authority:** [slice plan](contact-list.md), [ADR-0005](../0005-contact-identity-and-membership-access-paths.md) (Accepted), and the two pre-implementation records — [adversarial review](contact-list-review.md) and [complexity triage](contact-list-decomplex.md)
> **Verdict:** **Changes required** — three material defects, one records defect. **Closure:** F2, F3 and F4 fixed on this branch; F1 deferred by the author, then fixed after merge in [the follow-up](consent-identity-and-storage-cleanup.md). No defect in the cascades, the transaction arithmetic or the `membershipVersion` invariant.
> **Date:** 2026-09-12

Reviewed in a throwaway worktree at `b4c15e7`, which was left unchanged (probe scripts were written and removed; `git status` clean at the end) and then removed; the main checkout was not touched. Six independent lanes: membership storage, contact/list storage, table primitives and contract schemas, API and CLI, test quality, plan compliance. Claims in the plan and the ADR were treated as claims and re-derived from code; the pre-implementation records' `Storage.ts:NNN` references are stale and were re-located rather than trusted.

## Validation actually run

`pnpm check` green on the branch — `oxfmt --check`, `oxlint --type-aware --deny-warnings`, `tsc --noEmit`, **311 unit tests across 15 files**, import smoke. GitHub's `check` workflow is green and the PR is `MERGEABLE`/`CLEAN`.

**Mutation testing** was used to prove the suite bites rather than merely passes: 24 one-line source mutations against a copy of the tree, **17 killed, 7 survived**. Every survivor is in `Storage/Lists.ts` or in listing order — which is finding F3.

**Not run: the integration suite.** It needs a live `--stage test` deployment, and reproducing T11's decisive `update`-not-`replace` evidence needs a `main`-then-branch deploy sequence. Every T11 row below is therefore **author-evidenced, not reviewer-reproduced**. That is a stated limit, not a blocker; a live re-run is available on request.

## Verdicts

1. **Plan and baseline quality — strong.** The plan computes transaction arithmetic for every transaction in the slice, names its bounds as load-bearing rather than tuning, and records five deviations with scope, rationale and consequence. Its one real omission — `createList` also needing the listing attributes — was caught and corrected during implementation. Three defects in this slice were reachable only by execution (`Flag.boolean` required by default, the clear-only empty `ExpressionAttributeValues`, the empty `BatchGetItem` key set); the plan says so plainly instead of claiming type-level safety it did not have.
2. **Implementation compliance — complete.** Every accepted pre-implementation correction is present in shipped code with a test behind it: explicit `cascadePageLimit = 40` and the 81-action bound (F1), the per-membership 3-action contact cascade with its vanished-list fallback (F4b), the final delete conditioned on the address just read (F3), the import `ConditionCheck` per existing contact (F2), `addMember` still carrying exactly one `ConditionCheck` (F5), the import re-run asserting the version _does_ move (F6), no `deletingAt`/`beginDeletion` anywhere (decomplex 2), and exactly three attribute-bounding mechanisms (decomplex 4). Scope discipline holds: `Mailer.ts` and `alchemy.run.ts` are byte-identical, `Campaigns.ts` changed by two import lines, `readAudience` and `audienceProbeLimit` moved file without behaviour change, and no response schema exposes consent or mailability.
3. **Implementation quality beyond the baseline — two defects** (F1, F2 below), both in paths the plan reasoned about correctly elsewhere and then did not carry through to a sibling branch.
4. **Test and validation quality — good, with one hole.** All five `membershipVersion` sites bite, including a semantic no-op mutation of the shared `bumpList` helper. The page-length cursor trap, the cascade page bound, the final-delete address condition, the `BatchGetItem` physical/logical re-key, the index/base-table `ConsistentRead` split and the `Schema.Record` silent-drop trap each killed their mutation. T1's "pure move, no assertion rewritten" claim **verified on both sides**: 42 `it` blocks before and after with identical titles, and the only test-side diff is a doc comment. The hole is `Storage/Lists.ts` (F3).

## Findings

### F1 — a concurrent update carrying `email` reverts an address change and strands a reservation — **S3 / C3**

`apps/backend/src/Storage/Contacts.ts:310-326`

`updateContact` splits on whether the submitted address shares a mailbox key with the stored one. The transaction branch conditions slot 0 on `attribute_exists(pk) AND #email = :currentEmail`, with a comment explaining exactly why existence alone is not enough. The short-circuit branch — taken whenever the mailbox key is unchanged, **including when the address is resubmitted identically** — conditions on `attribute_exists(pk)` only.

Contact `C` holds `a@x.com`. Admin 1's `updateContact` reads it (`:288`). Admin 2's address change to `b@x.com` then commits in full: `C.email = b@x.com`, `EMAIL#a@x.com` deleted, `EMAIL#b@x.com → C` written. Admin 1 now writes `SET #email = :email` with `a@x.com` — its condition passes, because the only thing it checks is that the item exists.

The result is unrecoverable by any code path:

- `getContactByEmail("b@x.com")` resolves the reservation, sees the stored address no longer matches, and answers 404 (`:273-278`). `C` is unreachable by address.
- `a@x.com` is stored but unreserved, so a second contact can be created on it — the duplicate the slice exists to forbid.
- `deleteContact(C)` deletes `META` + `EMAIL#a@x.com` (a no-op). `EMAIL#b@x.com` survives with nothing pointing at it, so `b@x.com` returns 409 forever and no endpoint can clear it.

This is not the orphan window ADR-0005 accepts. That residual is self-healing by design — the vanished-list fallback clears it. This one accumulates.

**Why nothing catches it:** the case-only test (`Storage/Contacts.test.ts:478-490`) asserts `UpdateExpression` and that no transaction was issued; it never looks at `ConditionExpression`.

**Smallest fix** — make the two branches consistent, no new concepts, ~3 lines: when `update.email !== undefined`, use `attribute_exists(pk) AND #email = :currentEmail` and bind `:currentEmail` to `current.email`. `#email` is already in `ExpressionAttributeNames` on that path and `:email` already in the values, so the clear-only handling from `7227113` is untouched and `ExpressionAttributeValues` still cannot go empty. Add one assertion on the condition to the existing test.

### F2 — the CLI prints a `nextCursor` that `--cursor` cannot accept — **S3 / C3**

`apps/cli/src/Commands.ts:35`, `:90`, `:149-159`, `:273-283`

`EntityCursor` is a transform codec (`packages/api/src/Schemas.ts:244-256`): the wire carries `<createdAt>#<id>`, the decoded value is `{createdAt, id}`. The server encodes correctly. But the CLI uses the generated client, which **decodes** the response, and `report` prints the decoded value — so `contacts list` and `lists list` emit

```json
"nextCursor": { "createdAt": "2026-01-02T00:00:00.000Z", "id": "0195f0a0-…" }
```

while `--cursor` is `Flag.string` with `Flag.withSchema(Schemas.EntityCursor)` and rejects anything without the `#` join. Paging past the first page requires hand-reassembling a format the README never documents — and the README added in this very PR sells the round-trip as a guarantee: _"pass the `nextCursor` a page reports back as `--cursor`"_, under _"What those commands guarantee, so scripts can rely on it."_

`lists members` is unaffected: `MemberCursor = EntityId` is a plain string with no transform.

**Why nothing catches it:** every listing stub in `Api.test.ts` returns `nextCursor: undefined`, and `Commands.test.ts` contains no occurrence of `cursor` at all. The typed client round-trips the struct correctly, so the contract tests structurally cannot see this — only stdout can. Same class as the three defects the plan already records as execution-only.

**Fix, two shapes, both ~3 lines — your call which is leaner.** Either encode before printing in the two entity listings (`Schema.encodeSync(Schemas.EntityCursor)`), which keeps T10's "a mistyped cursor fails locally instead of as a 400 after a round trip" note true; or drop `Flag.withSchema(EntityCursor)` from `--cursor` and pass the string straight through, letting the server's 400 do the rejecting. Either way, one `Commands.test.ts` case with a stub returning a defined cursor. The contract and the wire format are already correct and should not change.

### F3 — `Storage/Lists.ts` has no unit suite, and five mutations survive — **S3 / C3**

`apps/backend/src/Storage/Lists.ts` (126 lines, no colocated `*.test.ts`)

Every other storage module has one. `Api.test.ts` and `Commands.test.ts` exercise lists through in-memory reimplementations that never reach this file, and `apps/backend/src/Lists.test.ts` covers the application layer.

What makes this S3 rather than a coverage nit is the first two rows below: `renameList` can lose its `attribute_exists(pk)` guard, or start rewriting the `gsi1sk` its own doc comment forbids it to touch, and **nothing anywhere in the repository fails** — not the unit suite, not the integration suite, not CI. Mutation testing makes it concrete:

| Mutation                                                                                          | Caught by        |
| ------------------------------------------------------------------------------------------------- | ---------------- |
| `renameList` drops `ConditionExpression: "attribute_exists(pk)"`                                  | **nothing**      |
| `renameList` also rewrites `gsi1sk` — what the doc comment at `:104-105` explicitly warns against | **nothing**      |
| `createList` omits `gsi1pk`/`gsi1sk`, so no new list is ever listable                             | integration only |
| `listLists` queries the `contact` partition                                                       | integration only |
| `getList` always reports `membershipVersion: 0`, so every campaign claim reads a stale version    | integration only |

The three "integration only" rows are the ones that matter for CI: `pnpm check` runs `vitest --project unit`, so none of them would fail a pull request. `createList` writing the listing attributes is precisely the omission the plan records as a late correction — _"without this `GET /lists` would return an empty page against real DynamoDB while every unit stub reported success"_ — and it is guarded today only by a suite CI does not run.

This is also the module whose sibling shipped a live-only defect: `updateRecord` has exactly two call sites, `Contacts.ts:321` and `Lists.ts:114`, and the one _with_ unit coverage still produced the `7227113` 503-on-every-clear bug.

**Smallest fix** — one new `apps/backend/src/Storage/Lists.test.ts`, three tests, ~50 lines over the existing `scriptedTable` seam: `toStrictEqual` the whole rename request; assert `createList`'s put item carries `gsi1pk: "list"` / `gsi1sk: "<createdAt>#<id>"` and that `listLists` queries `:kind = "list"`; assert `getList` reports the stored `membershipVersion`. That kills all five.

### F4 — an accepted ADR cites evidence it does not have, and 25 references point into a deleted file — **S2 / C3**

`.adr/0005-…md` Confirmation; `.adr/work/contact-list.md`; `.adr/work/contact-list-review.md`

**The overstated claim.** ADR-0005 states the 60-member live test deleted the list _"leaving no member item in either direction"_. The cited test cannot establish that. `Api.integration.test.ts:782` asserts `Option.isNone(listMembers(listId))`, but `listMembers` reads the list `META` first (`Storage/Membership.ts:183-187`) and returns `none` for a missing list — so it cannot distinguish "members gone" from "list gone". The follow-up loop at `:785-788` asserts each of the 60 `deleteContact` calls returns `"deleted"`, which the vanished-list fallback (`:323-327`) produces whether or not the reverse items survived. Of the four cells (forward/reverse × contact cascade/list cascade), exactly one is proven live — forward items after the contact cascade, at `:722`, where the list still exists. The design is genuinely pinned at unit level (`Membership.test.ts:504`, `:731`); it is the **claim**, not the code, that is wrong. The same sentence appears in the plan.

**The stale references.** `apps/backend/src/Storage.ts` is deleted by this branch, yet **29 `Storage.ts:NNN` references survive** in the committed records — 17 in the plan, 9 in the pre-implementation review, and **3 inside ADR-0005's accepted Decision text**, which is the durable record a future reader will chase. T1's own Verify step warns about exactly this class of drift.

**Also stale, same root cause:** "six modules" appears in four places in the plan and once in the decomplex report (the shipped shape is seven modules plus `Testing.ts`); T7's Change text places the final entity deletion in `Contacts.ts`/`Lists.ts` while its own Deviation line — and the code — say `Membership.ts`; T8's Tests line credits `apps/backend/src/Lists.test.ts` with import protections that live in `Storage/Membership.test.ts:848`.

**Smallest fix:** narrow the ADR bullet to what the run proves — a cascade completing across more than one 40-member page, an 81-action transaction accepted by real DynamoDB, and list `META` removed — and point the both-directions claim at the unit tests. Re-point or drop the `Storage.ts:NNN` references, at minimum the two in the ADR. Optionally add ~6 lines to the integration test: a raw query on `pk = CONTACT#<id>` / `begins_with(sk, "LISTOF#")` asserting zero items, which would make the original claim true.

## Minor, non-blocking

- `apps/backend/src/Api.test.ts:855` is named _"…and an update that replaces them"_ but performs no update; the in-memory stub's `updateContact` discards `name` and `attributes`, so it could not. Replace-not-merge _is_ protected at `Storage/Contacts.test.ts:355`. Rename the test.
- `apps/backend/src/Api.integration.test.ts:690-694` compares an address to itself (`email: Option.getOrUndefined(stored)?.email ?? ""`). The load-bearing half — a 3-key `toStrictEqual` — still bites.

## Examined and rejected as findings

- **Anything hardening the concurrent-admin orphan window.** Accepted consequence in ADR-0005, and the vanished-list fallback makes it self-healing.
- **Stub blind spots the plan already admits** — no condition evaluation, no item store, no index, no action limit. Declared in R7 and the ADR Confirmation.
- **`ClientRequestToken` freshly generated per request**, so it provides no idempotency. Pre-existing house pattern inherited from `addMember`/`claimCampaign`, not this slice's behaviour.
- **`__proto__` as an attribute key** is silently dropped on the read path (`Storage/Items.ts:47-51`). No pollution — values are always strings. Esoteric; the standing rule is not to handle it.
- **Second-round `UnprocessedKeys` dropped** (`Storage/Table.ts:168-174`). R3's and D5's stated design, explicitly tested, and strongly consistent hydration is what makes a stale index entry self-correcting.
- **Pre-slice rows would carry no `EMAIL#` reservation and no `gsi1` attributes**, so they would be invisible to listing and would not enforce uniqueness. Moot: `.alchemy/` holds no stage state and every deployment is an ephemeral `--stage test`. Worth one line in the ADR before a persistent stage exists.

## Corrections to the records, for accuracy

The three below were each reproduced by the lane that raised them and are reported as that lane found them; unlike the findings above, they were not independently re-checked. All three are harmless — the behaviour is correct in every case, only the stated reason is wrong.

- **`GET /contacts/by-email` does not depend on declaration order.** The plan, `packages/api/src/Api.ts:56`'s comment and T9's note all claim the literal segment must be declared before `/:id` or it would be read as an identifier. Reproduced directly: the Effect router prefers static segments over parameters regardless of order, and declaring `/:id` first still routes `/contacts/by-email` to the literal handler. The behaviour is correct; the stated reason is not, and the test pins routing rather than ordering.
- **`Omit<QueryRequest, "ConsistentRead">` protects object literals, not variables.** `Storage/Table.ts:129-133` claims the type excludes the field outright. TypeScript excess-property-checks only fresh literals, and `readEntityPage` builds a `const request` before passing it. The real guard is `Storage/Table.test.ts:246-255`. Reword the comment if that block is ever touched.
- **Bulk import's same-item-twice safety rests entirely on one schema refinement** — `ImportContactsPayload`'s duplicate-`mailboxKey` check (`packages/api/src/Schemas.ts:287-294`). Two entries sharing a mailbox key would target one item twice, a `ValidationException` at request validation that never becomes a cancellation and so fails identically on every retry. Correct today, with no compile-time link between the two facts.

## Process, before merging

- **The four untracked `.adr/` files in the main checkout are stale copies** of files this branch commits — `0005-…md` still says `Proposed` where the branch says `Accepted`, and `contact-list.md` differs too. `git merge origin/contact-list` will abort with _"untracked working tree files would be overwritten"_. Delete them first; the branch versions supersede them.
- **`origin/main` is 4 commits behind local `main`**, so the PR diff carries four unrelated documentation commits. Pushing `main` removes them. Already noted in the PR body.

## Closure

Dispositions are recorded in the [work document](contact-list.md); the findings above are left as written.

| ID                                                                      | Disposition                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 — `updateContact`'s short-circuit branch drops the address condition | **Deferred, then fixed.** First judged not worth closing, consistent with D3's accepted orphan window. Fixed in [the follow-up](consent-identity-and-storage-cleanup.md) (I3), which rewrote the function for [ADR-0006](../0006-consent-survives-a-contacts-address-change.md): both paths now carry the address condition. |
| F2 — the CLI reports a cursor `--cursor` cannot accept                  | **Fixed** — `EntityCursor` is now validated as a string rather than parsed into a pair, which removes the divergence instead of patching the printer.                                                                                                                                                                        |
| F3 — `Storage/Lists.ts` has no unit suite                               | **Fixed** — `apps/backend/src/Storage/Lists.test.ts` added; all five surviving mutations, plus the created-order sort, confirmed to fail it.                                                                                                                                                                                 |
| F4 — records cite a deleted file and overstate one live result          | **Fixed** — ADR-0005's Confirmation narrowed to what the run proved, its three `Storage.ts:NNN` references re-pointed by symbol, and both cascade tests extended to prove the reverse items are gone. The work documents keep their references under a header note, being records of finished work.                          |

The minor items (a stale test name in `Api.test.ts`, a tautological assertion in the F1 live test) were left; neither changes what is protected.

**Still outstanding:** F4's new cascade probes have not been exercised — they need the next live `test` stage. Everything else in this round was verified by `pnpm check` (format, lint `--deny-warnings`, typecheck, 317 unit tests, import smoke).
