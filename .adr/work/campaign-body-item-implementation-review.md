# Code review: campaign body item implementation

## Review constraints

| Axis | Selection |
|---|---|
| Target | Worktree `/home/operator/worktrees/emailer/campaign-listing`, branch `campaign-listing`, uncommitted diff vs `a7956c6` (14 tracked files: the 12 source/test/README files the brief named plus two T5 record lines in `.adr/0011-*.md` and `.adr/work/campaign-listing.md`) and the untracked `.adr/0014-campaign-body-item-and-summaries.md` |
| Baseline | Plan-backed: `.adr/work/campaign-body-item.md` (T1–T4 Verified, T5/T6 Pending) and ADR-0014 (Accepted, unconfirmed). Constrained by ADR-0005 (single table, sparse `gsi1`, META-only hydration), ADR-0008 (bind only what is used; error boundaries), ADR-0011 (states, run token, per-slice dispatch), ADR-0013 (fresh-key creates are `recordOnce`), `wiki/aws/dynamodb.md` |
| Scope | Bounded to the diff and its required boundaries (store primitives, the three `CampaignStore` fakes, the CLI in-memory service, the domain module, the API contract). Lane B and everything the plan lists as out of scope are not reviewed |
| Invocation | Standalone |
| Output | This file only |
| Dimensions | Correctness (write ordering, repeat-safety, read consistency, dispatcher placement); types and contract; tests/validation; plan matrix; the eight challenges in the brief |
| Validation/tools | Read every touched file in full plus `Primitives.ts`, `Testing.ts`, `Errors.ts`, `Dispatcher.ts`, the domain `Campaigns.ts`, the plan review and decomplex reports, ADR-0013, ADR-0014, the wiki page. Ran `pnpm check` once (read-only). One node one-liner against the installed `effect` to confirm key stripping on encode and decode. No deploy, no integration run, no git state change |
| Writes/artifacts | This report. No source edits |

Accepted decisions not re-litigated: DEX-001 (`send`/`resume` keep `Campaign`), DEX-003 (`getCampaignBody` without an option), DEX-004 (two `recordOnce` puts, BODY first), DEX-005/006, and plan-review findings 1–7 and N1–N4 — all closed in round 2 of both reviews and reflected in the code.

## Summary

The implementation does what the plan and ADR-0014 say, and the required outcome holds on the evidence: every settlement now updates a META item that carries no body (`text` left `StoredCampaign` and the META put; nothing reads or writes it there), `GET /campaigns` hydrates META alone and answers `CampaignSummary` (the store's `listCampaigns` yields summaries with no `text` key at all, pinned by `toStrictEqual`), and the dispatcher reads `BODY` once per slice after the page read and hands that text to the mailer (pinned by a discriminating unit case, since `CampaignRun` no longer has a `text` member for it to come from anywhere else).

The two challenges the brief weighted most — write ordering and the absent-body decode — hold: the puts are sequential `yield*`s in one generator with BODY first, `readItem` is strongly consistent, and no delete exists, so no code path can observe a META whose BODY is not already readable, and decoding `undefined` fails as `corrupt("getCampaignBody")` (pinned). `pnpm check` is green on this tree.

No admitted findings. **Recommend: ship.** Fix-now list: empty. The parent still owes T6's live gate and T5's remaining record work (ADR-0014 `Confirmed:` line, PR #7 text); two T5 lines are already in the diff.

## Related decomplex review

- **Report:** `.adr/work/campaign-body-item-decomplex.md` (plan-stage; rounds 1 and 2 Clear)
- **Owner disposition summary:** all six DEX findings accepted at planning time and visible in the code: one new store operation, domain module byte-identical, two `recordOnce` calls, no `Option` on the body read, one new dispatch case, lifecycle line on ADR-0011 only. No implementation-stage decomplex review was requested.

## Coverage

### Inspected

- Plan (full), ADR-0014, ADR-0013, plan review and decomplex reports (both rounds), `CLAUDE.md`, `wiki/aws/dynamodb.md`
- `git diff` for all 14 tracked files; the untracked ADR-0014
- `packages/api/src/Schemas.ts` (`CampaignSummary`, `CampaignBody`, `Campaign` from `.fields`, `page`), `packages/api/src/Api.ts` (`CampaignsGroup`), `packages/api/src/Schemas.test.ts` (`Campaign` decode cases), `packages/api/src/Client.test.ts` (campaign references)
- `apps/backend/src/Storage/Campaigns.ts` (full), `Storage/Items.ts` (full), `Storage/Primitives.ts` (`readItem`, `recordOnce`, `updateIf`, `readItems`), `Storage/Testing.ts` (full), `Storage/Errors.ts`, `Storage/Campaigns.test.ts` (full)
- `apps/backend/src/Dispatching.ts` (full), `Dispatcher.ts` (full), `Dispatching.test.ts` (fixture, fakes, new case), `Campaigns.ts` (domain, full), `Campaigns.test.ts` (fake), `Api.test.ts` (`unusedCampaignStore`, in-memory campaign store, listing case)
- `apps/cli/src/Commands.test.ts` (in-memory campaigns group, listing case), `apps/backend/src/Api.integration.test.ts` (listing case), `README.md` output contract
- Root `tsconfig.json` include (`apps/**/*.ts` — the integration test is typechecked), `vitest.config.ts` projects

### Skipped or partial

- Did not deploy `test-list` or run the integration project (parent-owned T6 gate)
- Did not run the CLI manually
- Lane B worktree and its rebase protocol: non-goal
- `apps/backend/test/IntegrationSupport.ts` not re-read; the plan review already confirmed its `Schemas.Campaign` annotations consume `get` only, and `tsc` on this tree is green
- PR #7 title/body (T5): not inspectable from the tree

### Required boundaries

- `recordOnce` semantics (condition failure reported as done) and `readItem` consistency — the two facts write ordering rests on
- The three `CampaignStore` fakes (`Api.test.ts`, `Campaigns.test.ts`, `Dispatching.test.ts`) and the CLI in-memory `campaigns` group — exhaustiveness after the new operation
- HttpApi success schemas on the five campaign endpoints — `list` alone changed
- Dispatcher pause exits, missing-list exit, budget check, `SliceOverrun` — placement of the body read
- Sparse `gsi1` — the BODY put must not carry index attributes

## Validation

- **Run:** `pnpm check` on the worktree tree, exit 0: `oxfmt --check` clean (89 files); `oxlint --type-aware --type-check --deny-warnings` clean; `tsc --noEmit` clean; `vitest run --project unit` 29 files, 573 tests passed (25.7 s); import smoke (`alchemy`, `alchemy/AWS`, `@effect/platform-node/NodeRuntime`) passed. `git status` unchanged afterwards.
- **Run:** node one-liner against installed `effect`: `Schema.decodeUnknownSync` and `encodeUnknownSync` on a `Struct` both drop undeclared keys; `Schema.Struct({ ...A.fields, ...B.fields })` composes and requires the spread-in key.
- **Skipped/unavailable:** integration project on a live stage; alchemy deploy/destroy; manual CLI pass.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** Complete and testable. Two review rounds closed every record defect (write-cost arithmetic, empty-list wording, ADR lifecycle scope, title, alternative numbering) before implementation, and the implementation matches the revised text rather than the earlier drafts. One clerical residue only: ADR-0011's header now carries two separate "Superseded in part" bullets (the existing one for 0012/0013 and the new one for 0014) where the file's convention elsewhere is one bullet per relation kind — parent's call under T5, not a finding. The plan's acceptance still hinges on the live gate, which it says itself.

2. **Implementation compliance:** T1–T4 **Complete** with evidence in the matrix; T5 **Partial** (ADR-0014 is drafted and Accepted, and the 0011 lifecycle line and the campaign-listing supersession note are in this diff; the ADR-0014 `Confirmed:` line and PR #7 remain, both gated on T6); T6 assertion **Complete** in source and typechecked, live run **Unverifiable**. No Incorrect or Missing rows. No new deviations beyond those the plan already absorbed from the two reviews.

3. **Implementation quality beyond the baseline:** Nothing material. Checked specifically: the BODY put carries exactly `pk`, `sk`, `v`, `text` (no `gsi1*`, so the sparse index sees one entry per campaign); the META put's `attribute_not_exists(pk)` evaluates against the META primary key, not the shared partition, so BODY existing first cannot fail it; a body read that fails in the dispatcher (`unavailable` or `corrupt`) takes the same route as every other storage failure in a slice — `reportedAndFatal` dies, SQS redelivers after the lease, the next `beginRun` accepts `sending` under the same run token; the read sits before the first `remainingUntil` check, so `reservationFor` needs no change and the up-to-5 s read is accounted for by the absolute deadline. `getCampaign` composes with `{ ...summary, ...body }` — no key of `CampaignBody` shadows a summary key.

4. **Test and validation quality:** Each new behaviour has one protecting case at the layer where it can fail. Storage: put order and conditions (`[0]` is `toStrictEqual(body())`, `[1]` is META without `text`), META-then-BODY read order by request keys, merge, absent-BODY → `corrupt` with `operationId: "getCampaignBody"`, summaries without `text` from the index path, `beginRun` without `text`. Dispatch: the mailer's `text` equals what `getCampaignBody` returned — discriminating because the `beginRun` fake can no longer carry `text` (the type forbids it). API: listing compares to an explicit summary literal and `get` still equals the `create` response, which the client decoded through `Campaign` (so `text` was on the wire for `create` and `get`). CLI: printed page has no `items.0.text`. The scripted-reply arithmetic is right (five `getCampaign` calls consume ten interleaved replies; the round-trip case feeds `[1]` then `[0]`). Caveat on what the client-layer "no `text`" assertions prove is under Limitations.

## Plan compliance matrix

| Authority item / implied requirement | Expected evidence | Implementation evidence | Validation / test evidence | Status |
|---|---|---|---|---|
| T1 `CampaignSummary`, `CampaignBody`, `Campaign = Struct({ ...Summary.fields, ...Body.fields })` with a one-line comment; `CreateCampaignPayload` unchanged | Three exports, composed struct, comment | `packages/api/src/Schemas.ts:226-245`; `CreateCampaignPayload` at `:298-302` untouched | `tsc` green; `Schemas.test.ts:242-` decodes full campaigns through `Campaign` across every state (text required); node check: composed struct requires `text` | Complete |
| T1 `list` success `page(CampaignSummary, EntityCursor)`; other four endpoints unchanged | One-line change in `CampaignsGroup` | `packages/api/src/Api.ts:171`; `:161, 176, 181, 186` still `Schemas.Campaign` | `Api.test.ts:1318-1349`; CLI listing case | Complete |
| T2 `bodyKey` beside `campaignKey` | `{ pk: CAMPAIGN#id, sk: BODY }` | `Storage/Items.ts:31-34` | `Storage/Campaigns.test.ts:339-342, 380-383` assert the key | Complete |
| T2 `text` off `StoredCampaign`; `StoredCampaignBody = { v, text }`; `summaryOf`; `text` off `CampaignRun` and `beginRun`'s return | Schema and interface edits | `Storage/Campaigns.ts:42-73, 84-93, 144-153, 380-392`; grep: no `text` read from a META decode anywhere in `apps/backend/src` | `beginRun` cases at `:589-684` expect no `text`; `claimRecipient` case asserts the send row has no `text` (`:733`) | Complete |
| T2 `createCampaign`: `recordOnce` BODY then `recordOnce` META; rewritten comment | Two sequential conditional puts, BODY first | `Storage/Campaigns.ts:202-234`: two `yield* recordOnce(...)` in one generator, BODY item `{ ...bodyKey, v, text }`, META item without `text` | `Storage/Campaigns.test.ts:390-412`: length 2, both `attribute_not_exists(pk)`, `[0]` `toStrictEqual(body())`, `[1]` sk META and no `text`; `:414-433` index attributes on `[1]` | Complete |
| T2 `getCampaignBody`: `readItem` BODY, decode `response.Item` under `corrupt("getCampaignBody")`, no option | Decode of a possibly undefined item | `Storage/Campaigns.ts:236-246` | `:355-368` META present, BODY reply `{}` → `reason: "corrupt"`, `operationId: "getCampaignBody"`; `:371-387` reads the BODY key and projects `{ text }` | Complete |
| T2 `getCampaign`: META → `none`; else `summaryOf` then `getCampaignBody` then merge | Two dependent reads | `Storage/Campaigns.ts:248-263` | `:327-353` request keys META then BODY, merged value; `:145-179` round-trip through both puts; `:223-307` ten interleaved replies | Complete |
| T2 `listCampaigns` yields `CampaignSummary` | `summaryOf` on hydrated META, `StoredPage<CampaignSummary, string>` | `Storage/Campaigns.ts:265-284` | `:446-494` `toStrictEqual` two summaries with no `text` key | Complete |
| T2 fourteen operations exported | `getCampaignBody` in the returned record | `Storage/Campaigns.ts:632-647` (14 members) | `tsc`: three object-literal fakes typecheck against `ReturnType` | Complete |
| T3 dispatcher: body read after the page read, before the member loop; `beginRun` destructure without `text`; outgoing message takes `text` from the read | One `yield*` at the right place | `Dispatching.ts:96` (no `text`), `:149-150` (after `const page = listed.value`, after the three pause exits at `:100-139` and the `isNone` exit at `:143-147`, before the loop at `:171` and the first `remainingUntil` at `:194`), `:231` | `Dispatching.test.ts:519-529` new case; existing pause/missing-list cases unchanged and green | Complete |
| T3 three fakes gain `getCampaignBody` (`notExercised` in domain and API suites; constant in dispatch); `beginRun` fakes drop `text`; `listCampaigns` fakes unchanged | Exhaustive fakes | `Campaigns.test.ts:94`; `Api.test.ts:45-47` (in `unusedCampaignStore`, spread at `:357`); `Dispatching.test.ts:159, 165-180`; `Api.test.ts:369-376` and `Campaigns.test.ts` list fakes still return full campaigns | `tsc` green; 573 unit tests green | Complete |
| T3 `apps/backend/src/Campaigns.ts` unchanged | Not in the diff | `git diff --stat` does not list it; file read: `get`/`send`/`resume`/`wakeQueued` as before | n/a | Complete |
| T3 API listing case compares to the summary, asserts no `text`, asserts `get` returns the full campaign | Rewritten case | `Api.test.ts:1318-1349` | Passes; `get` `toStrictEqual(first)` where `first` was decoded through `Campaign` | Complete |
| T4 CLI listing case asserts the printed item has no `text`; no `Commands.ts` or service change | One assertion | `Commands.test.ts:640-645`; in-memory `list` handler at `:317` still returns full campaigns | Passes (real CLI process) | Complete |
| T4 README one sentence under Output contract | Sentence present | `README.md:148-149` | n/a | Complete |
| T5 ADR-0014 Accepted with `Confirmed:` after T6; 0011 lifecycle line; campaign-listing supersession note; PR #7 rewritten | Four record items | ADR-0014 exists, Status Accepted, Confirmation "Pending the live gate"; `.adr/0011-*.md:9` new "Superseded in part … ADR-0014" bullet; `.adr/work/campaign-listing.md:145` "Superseded:" line. PR #7 not inspectable | n/a — `oxfmt --check` matched 89 files before and after this report was added under `.adr/work/`, so `.adr/*.md` is outside its match set and the plan's T5 `pnpm format:check` gate does not validate these records | Partial (ADR-0014 drafted and Accepted, 0011 line and campaign-listing note landed; the `Confirmed:` line and PR #7 pending on T6, as the plan sequences) |
| T6 integration listing case: found item has no `text`; `get` returns the created `text` | Two assertions | `Api.integration.test.ts:665-669` (`Index probe ${runId}.` matches the create payload at `:627`) | Typechecked (root `tsconfig` includes `apps/**/*.ts`); not run live | Complete (source) / Unverifiable (live) |
| T6 deploy `test-list`, integration project green, manual CLI pass, destroy | Parent-owned gate | — | Not run | Unverifiable |
| Final acceptance: `pnpm check` green | Repo gate | — | Run here: green, exit 0 | Complete |
| Outcome: every settlement writes a lean META | No `text` on META; settle/skip updates untouched | META put has no `text`; `settleRecipient`/`skipRecipient` still `ADD` on `campaignKey` (`Storage/Campaigns.ts:443-535`) | `createCampaign` case: `[1]` has no `text`; `claimRecipient` case: send row has no `text` | Complete |
| Outcome: listing without bodies | Store returns summaries; contract is `CampaignSummary` | `listCampaigns` + `Api.ts:171` | Storage `toStrictEqual`; API/CLI cases (see Limitations for what they prove) | Complete |
| Outcome: dispatcher sends the right body | Body from BODY item reaches the mailer | `Dispatching.ts:150, 231`; `Mailer.ts:131` uses `message.text` | Dispatch case; live send unrun | Complete (unit) / Unverifiable (live) |
| ADR-0013 implied: both puts safe to repeat | Fresh keys, `recordOnce` swallows the condition failure | `Primitives.ts:126-132`; ids from `newIdentifier` per request (`Campaigns.ts:53`) | `createCampaign` case asserts both conditions; primitive contract pre-existing | Complete |
| ADR-0014 implied: META is the commit point; no reachable orphan | BODY written before META; nothing indexes or queries BODY | Sequential `yield*` order; `listingAttributes` only on the META put; `readEntityPage` hydrates by `campaignKey`; no `CAMPAIGN#` partition query in `apps/backend/src` | `createCampaign` case pins order; `[0]` `toStrictEqual(body())` pins the absence of `gsi1*` | Complete |
| ADR-0005 implied: sparse index — BODY carries no `gsi1*` | Exactly four attributes on the BODY item | `Storage/Campaigns.ts:209-213` | `Storage/Campaigns.test.ts:406` | Complete |
| ADR-0008 implied: capabilities bind what they use | `CampaignStoreLive` still binds all six; `recordOnce` and `readItem` already bound | `Storage/Campaigns.ts:664-694` unchanged | n/a | Complete |
| ADR-0011 implied: states, run token, per-slice loop unchanged | Only the `text` source moved | `Dispatching.ts` diff is two lines; `beginRun` condition and `ALL_NEW` untouched (`Storage/Campaigns.ts:349-393`) | Existing dispatch and storage cases green | Complete |
| Out of scope held: `send`/`resume` contract, `getCampaignRun`, claims, settlements, checkpoints, pauses, MCP, delete, backfill | Untouched | Diff touches none of them | n/a | Complete |

### Approvals and conflicts

- **Approved deviation:** none new. DEX-001/003/004 and plan-review dispositions are already the baseline.
- **Authority conflict:** none. ADR-0014 (Accepted) and the plan agree on every implemented point; ADR-0013's create rule is applied, not overridden.

## Follow-up closure

- **Round and material delta:** Round 1 of the implementation review, against the uncommitted tree over `a7956c6`.
- **Closure state:** Clear
- **Resolved or withdrawn:** n/a
- **Still material:** none
- **New fix-caused or fix-exposed findings:** none

## Findings

No admitted findings.

The brief's eight challenges, each with the evidence that closed it:

1. **Repeat-safety and ordering of the two puts.** `createCampaign` is one `Effect.fn` generator with two sequential `yield* recordOnce(...)`, BODY first (`Storage/Campaigns.ts:206-234`); the second put does not start until the first has succeeded or its condition failure was reported as done. Both ids are freshly generated per request, so a pre-existing item under either key can only be the client's own resend of a lost response, which `recordOnce` reports as done (`Primitives.ts:126-132`). The META condition `attribute_not_exists(pk)` is evaluated against the META item's full primary key, so a BODY already in the same partition cannot trip it. `readItem` sets `ConsistentRead: true` (`Primitives.ts:111`), so once META is readable its BODY is too. The only route to a META without a BODY is a crash between the puts (which leaves no META) or a hand delete (no delete exists). A BODY put that times out at 5 s after applying server-side fails the create and leaves an unreachable orphan: no `gsi1*` on it, every read keyed by `campaignKey`/`bodyKey`/`sendKey`, no partition query on `CAMPAIGN#` in the backend.
2. **`getCampaignBody` on an absent item.** `Schema.decodeUnknownEffect(StoredCampaignBody)(undefined)` fails with a schema error, mapped by `Effect.mapError(corrupt("getCampaignBody"))` — never `unavailable`, never a defect. Pinned at `Storage/Campaigns.test.ts:355-368` with both `reason` and `operationId`. Both callers hold a META first: `getCampaign` returns `none` before the body read (`:251-253`); the dispatcher reaches `:150` only after `beginRun` returned `running`, whose condition `runToken = :run AND #state IN (...)` fails on an absent item and yields `stale` at `Dispatching.ts:92-94`.
3. **Dispatcher read placement.** After all three pause exits (`:100-139`), after the missing-list completion exit (`:143-147`), before the loop (`:171`), before the first budget check (`:194`) and therefore before any `SliceOverrun` (`:196-199`). An existing empty list reads the body once and completes — the plan and ADR say so. `reservationFor` unchanged; the deadline is absolute, so the read's time is charged before the first reservation.
4. **`Campaign` from `.fields`.** `Schemas.test.ts:242-` still decodes full-campaign JSON in every state through `Campaign` (all green); `Campaigns.create` returns a literal typed `Schemas.Campaign` with `text` (`Campaigns.ts:56-67`), and `Api.test.ts:1346` decodes the `get` response through `Campaign` and compares it `toStrictEqual` to the decoded `create` response — both carried `text`.
5. **Scripted-table tests.** `scriptedTable` serves `getItem` replies by call index (`Testing.ts:66-71`); `getCampaign` issues exactly two `getItem`s in order META, BODY (asserted by request keys at `Storage/Campaigns.test.ts:339-342`), so the ten-reply array at `:228-262` is consumed as five interleaved pairs. Put-order assertions are real: `[0]` is compared `toStrictEqual(body())`, a four-attribute literal; `[1]` is asserted to be sk `META` and to lack `text`; length is asserted 2.
6. **Residual `text` on META.** `grep -rn "\btext\b" apps/backend/src` (non-test): only `Storage/Campaigns.ts:70` (body schema), `:212` (BODY put), `:245` (body projection), `Dispatching.ts:150, 231`, `Campaigns.ts:60` (create literal), `Mailer.ts`. Nothing reads `text` from a META decode or writes it to the META item.
7. **Integration edit.** Matches T6's text; `Index probe ${runId}.` is the create payload at `:627`; typechecked by the root `tsconfig` include. Live run is the parent's.
8. **Lint/format/typecheck.** `pnpm check` green, exit 0 (details under Validation).

Asked directly — if merged as is with all checks passing, could the required outcome still fail? No path found: the settlement transaction updates a META that structurally cannot carry `text` (the stored schema and the put both lack it); the listing path decodes `StoredCampaign` from META hydration and projects `summaryOf`, which has no `text` field to emit; the dispatcher's only `text` source is the BODY read.

## Context-dependent concerns

- **Concern:** T6 (deploy `test-list`, integration project, manual CLI check, destroy) has not run; the dispatcher's live body read and the live `get` composition are unobserved on AWS.
- **Disposition:** Parent-owned gate the plan already sequences before T5's `Confirmed:` line and before merge. Not an implementation defect.

## Confirmed-good areas

- **Write ordering and the commit point.** Sequential generator puts, BODY first; META carries the index attributes and BODY none, so an interrupted create is invisible to every access path. The create test forecloses a double-listed campaign by pinning the BODY item to exactly four attributes.
- **Read consistency.** `readItem` is `ConsistentRead: true`; a META that exists implies a readable BODY without any eventual-consistency window.
- **Error semantics.** Absent BODY → `corrupt("getCampaignBody")` from both callers; transport failures stay `unavailable("getCampaignBody")` through `readItem`'s own mapping. In the dispatcher either reaches `reportedAndFatal` exactly as any other slice-time storage failure and SQS redelivers.
- **Contract surface.** Only `list`'s success schema changed; `create`/`get`/`send`/`resume` still answer `Campaign`, and the client-decoded `get` equals the client-decoded `create` in the API suite.
- **Exhaustive fakes.** All three `CampaignStore` object literals and the CLI in-memory group compile against the fourteen-member `ReturnType`; the API and domain suites stub `getCampaignBody` with `die`, so an accidental reach is reported rather than answered.
- **Discriminating dispatch case.** With `text` removed from `CampaignRun`, the mailer's `text` can only come from `getCampaignBody`; the case would fail against a hardcoded or missing body.
- **Sparse index untouched.** No new writer of `gsi1*`; send/skip/feedback puts unchanged.

## Limitations and caveats

- **What the client-layer "no `text`" assertions prove.** Verified against the installed `effect`: `Struct` decode drops undeclared keys, so `Api.test.ts:1345`, `Commands.test.ts:645` and `Api.integration.test.ts:665` are satisfied by the client's decode through `page(CampaignSummary)` regardless of what bytes the server sent. They still discriminate the endpoint's declared schema (with `page(Campaign)` and the full-campaign fakes, `text` would survive decode and the assertions would fail), so they protect the contract declaration, not the raw wire. The wire guarantee rests on the storage test (`listCampaigns` `toStrictEqual` summaries with no decoder in between) and on the server encoding through the same schema, which the node check also showed strips undeclared keys. Not a finding: no concrete failure and no reachable path to one.
- **No test asserts the body read is skipped on a pause or missing-list exit.** The dispatch fake always succeeds, so an early read would go unnoticed by the suite; placement is confirmed by inspection only. The plan does not ask for such a case and the cost of an extra read is one bounded call.
- **`Storage/Campaigns.test.ts:309-325` ("sending without queuedAt is corrupt")** asserts `reason` only; it fails before the body read today, but would also pass (via the default `{}` reply → `corrupt("getCampaignBody")`) if the order changed. Pre-existing shape; it protects what it claims.
- Live AWS behaviour is unrun. PR #7 text is not inspectable from the tree.

## Next steps

1. Parent: run T6 (deploy `test-list`, integration project, manual `campaigns create` / `list --limit 1` / `get`, destroy and confirm), then finish T5 (ADR-0014 `Confirmed:` line, PR #7 title and body; decide whether ADR-0011's two "Superseded in part" bullets should be one).
2. No implementation fix round from this review.
3. Merge only when the user asks, after the live gate; lane B rebases afterwards under the plan's protocol.
