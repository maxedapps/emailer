# Decomplex review: Campaign body as its own item

## Overall status

Findings, none blocking. The core of the change — a `BODY` item beside `META`, a lean item under every settlement, a listing that hydrates `META` alone, and the dispatcher reading the body once per slice — is the smallest design that meets the user's decision, and ADR-0014's rejected alternatives are real ones. What does not earn its place is scope the decision did not ask for and machinery for cases the repository rules say not to handle: the `send`/`resume` contract change and the store read it exists for (DEX-001), a projection rule built on a premise that is now falsified (DEX-002), an `Option` on a read that has no legitimate absent answer (DEX-003), a tokened transaction whose recorded cost is wrong by a factor of the body size (DEX-004), three tests that re-pin library or primitive behaviour (DEX-005), and one lifecycle line on an ADR the change does not touch (DEX-006).

If DEX-001, DEX-003 and DEX-004 all land, the change has this shape: the store gains one operation (`getCampaignBody`) instead of two and keeps fourteen; `apps/backend/src/Campaigns.ts` is untouched; T3 is the dispatcher, one fake member in each of three suites, and one new case proving the body reaches the mailer; T4 is a README sentence and one CLI assertion; ADR-0014 loses one Decision bullet, one Consequence and one Alternative, and ADR-0013's create rule stands unamended.

## Review contract

| Axis | Selection |
|---|---|
| Mode | Prevention |
| Target | [`campaign-body-item.md`](campaign-body-item.md) (Ready for implementation, 2026-09-16) and [ADR-0014](../0014-campaign-body-item-and-summaries.md) (Accepted, unconfirmed) |
| Authority / required behavior | ADR-0014:5 — the user decided that a campaign listing must not carry the body and asked for the cleanest fix with big refactors allowed. Accepted ADRs 0005, 0008, 0011, 0013. Repository rules: keep code and architecture simple and lean; do not handle edge cases or esoteric fail states; rewrites over bolt-ons; every write safe to repeat (ADR-0013). Required behaviour is the plan's Outcome: settlements write a lean item, `GET /campaigns` returns summaries, `create` and `get` keep the full campaign, the dispatcher reads the body |
| Scope | Structural choices, task shape, tests, records. The eight questions (a)–(h) in the brief. Defects and plan compliance are routed (see Limitations) |
| Report | `.adr/work/campaign-body-item-decomplex.md` (explicit path; the repository uses `.adr/`, not `adrs/`) |

## Coverage

### Inspected

- The full plan and ADR-0014; ADR-0005, 0011 and 0013 headers and the Decision sections the plan cites; the lifecycle-line convention across ADRs 0001–0013; `campaign-listing.md` (handoff and merge protocol); the two prior decomplex reports (`contact-list`, `mass-sending`) for shape and precedent.
- `apps/backend/src/Storage/Campaigns.ts` in full (`StoredCampaign`, `campaignOf`, `createCampaign` via `recordOnce`, `getCampaign`, `listCampaigns`, `beginRun` with `ALL_NEW`); `Storage/Primitives.ts` in full (`recordOnce` swallows the condition; `runTransaction` draws one token per call; `readItems` unordered; `readEntityPage` keys by `pk`); `Storage/Contacts.ts:178-282` (`createContact` two-Put transaction and its slot semantics; `getContactByEmail` two dependent reads); `Storage/Items.ts` in full; `Storage/Errors.ts`; `Storage/Testing.ts:57-160` (replies served by call order per operation; `tokensFor`).
- `apps/backend/src/Campaigns.ts` in full (`send`/`resume` re-read through `get`; `wakeQueued`; `corrupt` classified in the domain at :110); `Dispatching.ts` in full (`beginRun` destructure at :96; `listMembers` at :141; the outgoing message at :227-234); `Dispatch.ts:1-40`; `Api.ts:68-74`.
- `packages/api/src/Schemas.ts` (`Campaign`, `CreateCampaignPayload`, `page`); `Api.ts:157-191`; `Schemas.test.ts:242-262, 354-372`.
- Test suites at the lines the plan cites: `Storage/Campaigns.test.ts` (`meta()` fixture, create and listing cases, `beginRun` cases, the full `it` list); `Storage/Contacts.test.ts:53-172` (the colliding-identifier anomaly case); `Campaigns.test.ts:85-155, 310-400`; `Api.test.ts:45-85, 354-425, 870-950, 1316-1338`; `Dispatching.test.ts:40-60, 160-185, 325-345` and its `it` list; `apps/cli/src/Commands.test.ts:245-320, 500-645`; `Api.integration.test.ts:614-666`; `README.md:140-170`.
- `node_modules/effect/src/Schema.ts` (`readonly fields` on `Struct`; no `pick`/`omit` on `Struct` in rc.112); `wiki/aws/dynamodb.md:9, 77`.
- One static check outside reading, disclosed because the brief listed no validation: a node one-liner against the worktree's Effect `4.0.0-rc.112` confirmed that `Schema.encodeUnknownSync(Struct)` drops keys the struct does not declare, and that `Schema.Struct({ ...A.fields, ...B.fields })` composes as the plan expects. Nothing was deployed, no test suite was run, no file other than this one was written.

### Skipped or partial

- Lane B's plan and worktree (`~/worktrees/emailer/campaign-html-bodies`) were not read, per the non-goals; the plan's rebase protocol is judged on its own text only.
- `campaigns-next-lanes.md` is not present in the main checkout's `.adr/work/` despite the session's git-status snapshot listing it; the lane briefing was taken from ADR-0014's Authority line and `campaign-listing.md`.
- The HttpApi response encoder was not traced; the excess-key check above exercised the Struct codec directly (see DEX-002's evidence grade).
- The DynamoDB write-unit arithmetic in DEX-004 is computed from the AWS reference the plan itself cites, not measured.

## Potential findings

### DEX-001 — The `send`/`resume` contract change, and the store read that exists for it, are outside the decision

- **Severity:** Medium
- **Evidence:** Confirmed
- **Recommendation:** Ask user
- **Surface and location / authority:** Plan :10 ("`send` and `resume` return the summary too"), :47 ("`send` and `resume` need the state and return the summary; reading the body there would re-create the cost this change removes"), T1 :56, T2 :72 (`getCampaignSummary`), T3 :89, :95; ADR-0014:18 ("`send` and `resume` read the summary for their state check and return it"), :19, :35. ADR-0014:5 records the user's decision as: a campaign listing must not carry the body.
- **Current-need evidence:** The problem statement (plan :10, ADR-0014:10) is per-settlement write amplification on `META` and the size of a listing page. A `send` or `resume` runs once per campaign. Keeping them on `get` costs two `GetItem`s of a ≤256 KiB body and one response of that size, once; it re-creates neither of the costs named. Nothing else in the plan or ADR needs the summary on those two endpoints.
- **Added burden:** A public contract change on two endpoints (`Api.ts:180-190`), `getCampaignSummary` in the store and in three fakes, a rewrite of `send`, `resume` and `wakeQueued` in `apps/backend/src/Campaigns.ts:70-143`, the three `toStrictEqual(campaign)` comparisons in `Campaigns.test.ts:326, 380, 395`, the `send`/`resume` assertions in `Api.test.ts:878-890, 932-941`, the CLI in-memory `send`/`resume` handlers in `Commands.test.ts:272-312` (see also DEX-002), and one Decision bullet, one Consequence and one README clause that exist only to say the body is no longer echoed.
- **Reachable practical impact:** A CLI operator who runs `campaigns send` today sees the campaign as `create` printed it; under the plan they see a different shape from `create` and `get` and must call `get` for the body. The saving is two reads per send.
- **Smallest simpler alternative:** `send` and `resume` keep `Schemas.Campaign` and keep reading through `get`. `getCampaignSummary` is not added; the store has `getCampaign` (META then BODY) and `getCampaignBody`, which answers question (a) with two reads and no composition in the domain. `Campaigns.ts` does not change. T3 becomes the dispatcher and the fakes' `getCampaignBody` member; T4 becomes the README sentence for `list` alone. ADR-0014 Decision bullet 3 loses its `send`/`resume` clause; bullet 4 reads "`list` answers `CampaignSummary`; everything else answers `Campaign`"; Consequence :35 is deleted.
- **Exception / boundary check:** No trust boundary or data invariant depends on the summary here; the state check `send` performs reads `submission.state`, which the full campaign carries. A `META` without a `BODY` would make `send` fail `corrupt` through `getCampaign`, which is the same answer the dispatcher would give one step later.
- **Required behavior and simplification risk:** The user's decision is untouched; the plan's Outcome sentence "`send` and `resume` return the summary too" is scope the plan added. Risk of taking the alternative: none to the settlement path or the listing; lane B's `html` then also rides `send`/`resume` responses, which is what it does today.
- **Bounded next step or user question:** "`send` and `resume` currently echo the full campaign. The plan changes both to return a summary and adds a store read for it, on the argument that reading the body there re-creates the cost this change removes — it does not; that cost is per settlement. Keep the contract change (summaries everywhere but `create`/`get`), or leave `send`/`resume` as they are and drop `getCampaignSummary`?"
- **Acceptance signal:** If dropped: `Api.ts` changes only the `list` success schema; `grep -rn getCampaignSummary apps` is empty; `apps/backend/src/Campaigns.ts` is byte-identical; `Campaigns.test.ts` comparisons unchanged. If kept: the user has decided; DEX-002 still applies.

### DEX-002 — "Never hand a superset through a narrower schema" rests on a premise that is now falsified

- **Severity:** Low
- **Evidence:** Supported
- **Recommendation:** Act
- **Surface and location / authority:** Plan :48 ("encoding's treatment of excess keys is unverified. Every path that answers a summary endpoint builds a summary"), T4 :104 (a local `summaryOf` in `Commands.test.ts` for `send`, `resume` and `list`), :33 (Key-files row for `Commands.ts`: "never hand a superset through a narrower schema, because the encoder's treatment of excess keys is unverified").
- **Current-need evidence:** The premise was checked against the worktree's Effect `4.0.0-rc.112`: `Schema.encodeUnknownSync(Schema.Struct({ id, subject }))({ id, subject, text })` returns `{ id, subject }`. Encoding strips undeclared keys exactly as decoding does (`Schemas.test.ts:354-372` already pins the decode side). `Campaign` is structurally a superset of `CampaignSummary`, so a handler that returns a `Campaign` where `CampaignSummary` is declared compiles (the plan says so itself at T1 :63) and encodes to a summary.
- **Added burden:** A `summaryOf` projection in the CLI's in-memory service and the discipline sentence in two places of the plan; under the plan as written, also the projections in the three backend fakes for `send`/`resume` results.
- **Reachable practical impact:** None at runtime; the burden is a rule the implementer must remember and re-verify, written to guard against a behaviour the library does not have.
- **Smallest simpler alternative:** Delete the rule from :48 and :33. In `Commands.test.ts` the `list` handler (and `send`/`resume` if DEX-001 is not taken) keeps returning stored `Campaign`s; the CLI listing assertion the plan already has ("the printed item has no `text`") is what proves the wire contract. If the parent prefers a recorded fact over a deleted rule, one sentence in the plan's Research: "Struct codecs drop undeclared keys on encode as on decode; handlers may return a `Campaign` where a summary is declared."
- **Exception / boundary check:** The HttpApi success encoder is the contract boundary; relying on its documented default (excess keys ignored) is the same reliance every decode path in the repository already makes. The evidence is graded Supported rather than Confirmed because the check exercised the Struct codec, not the HttpApi response path; the CLI assertion closes that gap at implementation time.
- **Required behavior and simplification risk:** No contract changes. If the encoder ever preserved excess keys, the CLI listing assertion fails loudly.
- **Bounded next step or user question:** Amend T4 and :48 as above.
- **Acceptance signal:** `Commands.test.ts` has no `summaryOf`; the CLI listing case asserts the absence of `text`; the plan carries no "unverified" clause.

### DEX-003 — `getCampaignBody` returning `Option` adds two absent-body branches and one test that nothing needs

- **Severity:** Low
- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** Plan T2 :73 (`getCampaignBody(id)`: `readItem` BODY → `Option<CampaignBody>`), :74 (`getCampaign`: body `none` → `corrupt("getCampaign")("campaign has no body")`), T3 :90 (`Dispatching.ts`: `Option.none` → `corrupt("getCampaignBody")("running campaign has no body")`), :95 ("one case — a missing body fails the slice rather than sending"); ADR-0014:18 ("a `META` without a `BODY` is corrupt").
- **Current-need evidence:** No caller has a legitimate "no body" answer. `getCampaign` reads `META` first and returns `none` on its absence; by the time it reads `BODY`, absence is corruption. The dispatcher reaches the body read only after `beginRun` applied on `META`; absence is corruption there too. Two callers, one meaning, spelled out twice plus a dispatcher test for it.
- **Added burden:** An `Option` wrapper, an explicit `none → corrupt` branch in `getCampaign`, another in `Dispatching.ts`, and a Dispatching unit case whose only subject is that branch.
- **Reachable practical impact:** Two branches and a test for a state that neither create design (transaction, or BODY-first puts under DEX-004) can produce; only a hand-deleted item reaches them.
- **Smallest simpler alternative:** `getCampaignBody(id)` = `readItem("getCampaignBody", bodyKey(id))` → `decodeStoredCampaignBody(response.Item)` → `Effect.mapError(corrupt("getCampaignBody"))` → `{ text }`. An undefined `Item` fails the Struct decode and is reported corrupt with no branch written for it. `getCampaign` becomes: `META` absent → `none`; else `{ ...summaryOf(stored), ...(yield* getCampaignBody(id)) }`. The dispatcher becomes `const { text } = yield* campaigns.getCampaignBody(campaignId)`. The storage suite keeps one case — an absent `BODY` on `getCampaignBody` is corrupt — and the Dispatching "missing body fails the slice" case is not written; the one that matters there is the plan's other new case, that the mailer receives the body the store returned.
- **Exception / boundary check:** The corrupt classification is preserved and lands where every decode failure of a stored item already lands. The dispatcher's behaviour on corruption is unchanged: the slice fails and SQS redelivers.
- **Required behavior and simplification risk:** None affected. The error's `operationId` is `getCampaignBody` on both paths instead of `getCampaign` on one; nothing reads that field except diagnostics.
- **Bounded next step or user question:** Amend T2 :73-74 and T3 :90, :95.
- **Acceptance signal:** `getCampaignBody` has no `Option` in its return type; `grep -n "has no body" apps/backend/src` is empty; `Dispatching.test.ts` gains exactly one new case.

### DEX-004 — One tokened transaction for create, against ADR-0013's own rule, with a cost recorded wrong

- **Severity:** Low to medium
- **Evidence:** Confirmed
- **Recommendation:** Ask user
- **Surface and location / authority:** Plan :45 ("One transaction, not two `recordOnce` puts … for one extra write unit per create"), :36, T2 :71 (`runTransaction` of two conditional Puts; `committed: false` → `unavailable`; a rewritten comment), T2 :80 (transaction assertions; "grep the suite for tests that create and then transact in one table and renumber their expected tokens"); ADR-0014:6 (supersedes ADR-0013's "creates under a fresh identifier collapse into `recordOnce`"), :17, :25 (alternative 3: "Cheaper by one write unit"), :34. ADR-0013:23 is the accepted rule the plan overrides.
- **Current-need evidence:** The transaction buys atomicity across a failure between two puts inside one API request. `createContact` (`Contacts.ts:184-218`) is a transaction because its second Put is a uniqueness reservation whose condition failure is a business outcome; here neither condition can fail under a fresh identifier, which the plan itself says (:71). The failure the transaction guards against — a DynamoDB error or a Lambda death between two consecutive puts in one request — is the kind of fail state the repository rules say not to build for, and with BODY first its consequence is an orphan body item under an identifier no one holds: invisible, never read, at most 400 KB. The plan's "META-first creates a campaign that lists and sends with no body" is a consequence of choosing META first, not of two puts.
- **Added burden:** Compared with two `recordOnce` calls: a transaction request in `createContact`'s style, an outcome branch that maps `committed: false` to `unavailable`, a rewritten comment, a storage case for the anomaly, the move of every create assertion from `putItemRequests[0]` to `transactionRequests[0].TransactItems[i].Put.Item` (three sites at `Storage/Campaigns.test.ts:153, 195, 330`), the token-renumbering sweep the plan asks for at :80, an ADR-0013 lifecycle line the plan's T5 does not actually add (see DEX-006), and ADR-0014 alternative 3. The write cost is also misstated: the AWS reference the plan cites charges transactional writes two units per KB per item, so a create with a 64 KiB text costs about 130 units as a transaction against about 65 as two puts, and lane B's 256 KiB HTML about 514 against 257 — not "one extra write unit". Immaterial at create rates, but ADR-0014:25 records a trade-off that is wrong by the size of the body.
- **Reachable practical impact:** None at runtime for either design in normal operation. The transaction's benefit is reached only on a mid-request failure, and the two-put design's cost on that same failure is one orphan item.
- **Smallest simpler alternative:** Two `recordOnce` calls, BODY first, then META. Both puts are individually safe to repeat (the primitive's own contract), ADR-0013:23 stands as written, ADR-0014 loses its ADR-0013 supersession and alternative 3 becomes the decision with the transaction as the rejected alternative. Tests read `putItemRequests[0]` (BODY) and `[1]` (META); no token renumbering.
- **Exception / boundary check:** ADR-0013's invariant — every write safe to repeat — holds for both puts. The `META` ⇒ `BODY` implication holds for every campaign that can be listed or sent, because `META` is written last. `getCampaign` and the dispatcher still classify an absent body as corrupt (free under DEX-003), so a hand-deleted body is caught either way.
- **Required behavior and simplification risk:** Unchanged for every read and write path. What is lost: a create that is atomic across a mid-request failure; the possibility of an unreachable orphan body item; two round trips instead of one on `create` (a few milliseconds once per campaign).
- **Bounded next step or user question:** "The plan creates `META` and `BODY` in one tokened transaction; two ordinary `recordOnce` puts with the body first would honour ADR-0013's create rule unchanged, cost half the write units, and leave at worst an invisible orphan body if a create dies between the two puts. The transaction's stated cost of 'one extra write unit' is wrong — it doubles the write cost of the body. Which do you want recorded as the decision?"
- **Acceptance signal:** If two puts: `createCampaign` calls `recordOnce` twice; ADR-0014:6 no longer names ADR-0013; ADR-0014:17 and :25 swap roles with the arithmetic corrected. If the transaction stays: the plan's :45 and ADR-0014:25 state the doubled body write cost, and T5 adds the ADR-0013 lifecycle line the header already claims.

### DEX-005 — Three planned tests re-pin library or primitive behaviour

- **Severity:** Low
- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** T1 :60 ("a full campaign JSON decodes through `CampaignSummary` without `text`, and `Campaign` still decodes the same JSON with it"); T2 :80 ("`getCampaignSummary` and `getCampaignBody` each read one item"); T3 :95 ("a missing body fails the slice rather than sending").
- **Current-need evidence:** The T1 case pins that a Struct drops undeclared keys on decode, which `Schemas.test.ts:354-372` already pins for `Campaign`; the summary-to-campaign relation is enforced by the type system through the `.fields` spread and needs no runtime case. The T2 case pins that a wrapper around one `readItem` issues one `GetItem`, which is the primitive's behaviour; the shape of each key is already asserted by the `getCampaign` merge case (META then BODY) the plan also lists. The T3 case is the branch DEX-003 removes.
- **Added burden:** Three cases whose failure could only mean the library or the primitive changed, which the existing suites would already report.
- **Reachable practical impact:** Maintenance only.
- **Smallest simpler alternative:** T1: no new Schemas case; `pnpm typecheck` is the check. T2: keep the create case(s), the `getCampaign` merge case, the absent-body corrupt case (on `getCampaignBody` under DEX-003), the updated listing and `beginRun` expectations. T3: keep the one case that protects new behaviour — the mailer receives the `text` the body read returned — which the plan rightly notes nothing protects today.
- **Exception / boundary check:** No unique protection is lost: the wire contract's absence of `text` is asserted at the API (`Api.test.ts` listing case) and CLI layers per the plan, which is where it can fail.
- **Required behavior and simplification risk:** None.
- **Bounded next step or user question:** Trim T1 :60, T2 :80 and T3 :95 as above.
- **Acceptance signal:** `Schemas.test.ts` gains no case; `Storage/Campaigns.test.ts` has no case whose subject is the read count of a single-item read; `Dispatching.test.ts` gains one case.

### DEX-006 — The ADR-0005 lifecycle line is unwarranted; the ADR-0013 one is claimed but not scheduled

- **Severity:** Low
- **Evidence:** Confirmed
- **Recommendation:** Act (0005); Validate (0013)
- **Surface and location / authority:** Plan T5 :119 (one `Superseded in part` line each on 0011 and 0005); ADR-0014:6 (supersedes in part 0011's record, 0005's access paths, and 0013's create rule).
- **Current-need evidence:** ADR-0005 decides contact identity, membership access paths, cascades and one sparse index over contact and list `META` items (`:28-40`); campaign `META` joining the index is already recorded there as an `Amended:` line (`:8`) by `campaign-listing`. A `BODY` item that carries no index attributes and is reached by primary key contradicts nothing ADR-0005 decided. ADR-0011's Decision (`:23-24`) implies the campaign item holds subject and text ("[send rows] no longer copy the campaign's subject and text"), so the 0011 line is defensible. ADR-0013:23 is genuinely overridden if the create becomes a transaction, yet T5 schedules no line on 0013 while ADR-0014:6 claims one — under DEX-004's alternative this disappears; under the plan as written it is a gap.
- **Added burden:** One lifecycle line on a record it does not change, which future readers of ADR-0005 must reconcile with a body item that never touches its access paths.
- **Reachable practical impact:** Documentation drift only.
- **Smallest simpler alternative:** T5 adds a line on 0011 only; ADR-0014:6 drops the 0005 clause. Whether 0013 needs a line follows DEX-004; if the transaction stays, T5 must add it.
- **Exception / boundary check:** ADR conventions ask lifecycle links only for statements a new decision materially changes.
- **Required behavior and simplification risk:** None.
- **Bounded next step or user question:** Amend T5 :119 and ADR-0014:6 for 0005 now; settle 0013 with DEX-004.
- **Acceptance signal:** `git diff` after T5 touches `0011-*.md` and, only if the transaction stays, `0013-*.md`; `0005-*.md` is untouched.

## User-decision queue

| DEX ID | Material decision | Evidence and options | Recommendation |
|---|---|---|---|
| DEX-001 | Whether `send` and `resume` change contract to `CampaignSummary` | Outside the recorded decision (listing only); the cost argument at plan :47 does not hold for a once-per-campaign call; removes `getCampaignSummary`, all `Campaigns.ts` changes and most of T4. Options: (a) keep `send`/`resume` on `Campaign` via `get`; (b) keep the plan, recording it as a user decision | Ask user; lean (a) |
| DEX-004 | One tokened transaction versus two `recordOnce` puts (body first) for create | Neither condition can fail; the guarded failure is a mid-request crash whose two-put consequence is an invisible orphan; ADR-0013's rule stands unamended; the "one extra write unit" figure is wrong (it doubles the body's write cost). Options: (a) two puts, body first; (b) keep the transaction with the arithmetic corrected and the 0013 line scheduled | Ask user; lean (a) |

## Confirmed proportionate areas

- **ADR-0014's size.** About fifty lines with five real alternatives and no task log; within the one-to-two-page convention. The lifecycle lines are the only record-level finding (DEX-006).
- **The `BODY` item and the split itself.** The settlement arithmetic (plan :10, ADR-0014:10) is right for a single item collection under one partition key, which is where every `SEND#` row and the `META` counters of one campaign live. Alternatives 1, 2 and 5 in ADR-0014 are real; recording the object-storage rejection is warranted because `wiki/aws/dynamodb.md:9` recommends object storage for large documents and a reader would otherwise ask.
- **(c) `Campaign = Schema.Struct({ ...CampaignSummary.fields, ...CampaignBody.fields })`.** Verified to compose on rc.112 (`Struct` exposes `fields`; no `pick`/`omit` exists on `Struct` in this release, so the spread is the only derivation available). One line that states the relation, gives lane B's `html` one home, and replaces five duplicated field lines. First-in-the-repo is novelty, not a finding.
- **(a) Composition of `get` in storage rather than the domain.** With DEX-001 taken the question dissolves (two reads, `getCampaign` composes them). If the user keeps the contract change, three reads with composition in storage follows `getContactByEmail`'s precedent and keeps `Campaigns.get` a one-liner. One correction to the plan's argument at :46: "classified in storage where every other corrupt classification lives" is not so — `Campaigns.ts:110` classifies `corrupt("getCampaignRun")` in the domain — but the choice stands on the precedent, not on that sentence.
- **(e) The dispatcher's body read after `listMembers` and before the member loop.** One `yield*` either there or beside the `beginRun` destructure; the "pause or empty list never pays for it" rationale is a micro-optimisation worth one read per campaign, but the placement costs nothing extra. The corrupt classification is addressed in DEX-003.
- **Two `readItem`s for `get` rather than a batch.** `readEntityPage` keys hydrated items by `pk` (`Primitives.ts:364-372`), which `META` and `BODY` share, and `readItems` returns items unordered; two consistent reads are the smaller form. Alternative 4 in the ADR is right.
- **`v` on the `BODY` item.** `Items.ts:111`: every item carries the record version. Consistent, one attribute.
- **The lane B rebase protocol in the Handoff.** Ten lines of merge guidance for a conflict that will happen; not machinery.
- **T6 live gate.** A deploy, the integration project, a manual CLI pass and a guaranteed destroy match the repository's standing rule for test deployments; the manual steps mirror the user's "test manually too" rule rather than duplicating the suite for its own sake.
- **Not a finding, noted for the record:** `getCampaignRun` (out of scope by the plan) means `send` on a queued campaign reads `META` twice (state, then run token). It cannot be folded into a public summary without exposing the run token, so it stays.

## Limitations

- Static review only, plus the one node check disclosed under Coverage. No suite was run and no stage was deployed.
- Every disposition is the parent's; DEX-002, DEX-003, DEX-005 and DEX-006 are small and independent of each other; DEX-001 and DEX-004 touch ADR-0014's Decision section, which is marked Accepted, so they are queued for the user rather than recommended outright.
- Routed to the defect and compliance reviewer, not judged here:
  - ADR-0014:6 claims a supersession of ADR-0013 that T5 :119 does not schedule (surfaced in DEX-006 only for its complexity angle).
  - The plan's "one extra write unit" figure (plan :45, ADR-0014:25) is arithmetically wrong under the AWS reference the plan cites; the correction is stated in DEX-004 and should be applied whichever create design is chosen.
  - Whether `Campaigns.ts:110`'s existing `corrupt` in the domain should move to storage is a pre-existing question and outside this change.

## Round 2

Re-read on 2026-09-16 after the revision: [`campaign-body-item.md`](campaign-body-item.md) (Ready for implementation, Reviews line :158 records every round-1 disposition) and [ADR-0014](../0014-campaign-body-item-and-summaries.md) (Accepted, unconfirmed). Same contract as round 1; the two sources the revision newly cites were read as well (`Storage/Membership.ts:206-214`, `Api.integration.test.ts:212-236`).

### Closure per finding

| DEX | Status | Where it closed |
|---|---|---|
| DEX-001 `send`/`resume` contract and `getCampaignSummary` | **Closed** | Plan :10, :12 ("changing what `create`, `get`, `send` or `resume` return" is out of scope), :29 and :89 (`Campaigns.ts` untouched), :47; T2 :74 (fourteen operations, one new). ADR-0014:19, alternative 6 at :26, consequence :36 |
| DEX-002 superset-through-narrower-schema rule | **Closed** | Plan :21 (encoder verified), :48, T3 :88 (`listCampaigns` fakes stay), T4 :102 (no service change; the CLI listing assertion is the check) |
| DEX-003 `Option` on `getCampaignBody` | **Closed** | Plan :46, T2 :71-72 (decode the item, `corrupt` on absence, `getCampaign` composes it), T3 :87 (`const { text } = yield* …`), T3 :93 (one new case only). ADR-0014:18 |
| DEX-004 transaction versus two puts | **Closed** | Plan :13, :23, :44 (arithmetic corrected: about 132 against 66 units), T2 :70 (BODY then META, comment rewritten), T2 :78 (`putItemRequests[0]` BODY, `[1]` META; no token sweep). ADR-0014:17, alternative 3 at :25 with the true cost; ADR-0013 no longer named at :6 |
| DEX-005 three re-pinning tests | **Closed, one residue accepted** | T1 :60 (no new schema case); T3 :93 (one Dispatching case, the mailer receives the body). T2 :78 keeps "`getCampaignBody` reads the BODY key and projects `text`": with `getCampaignSummary` gone this is the one direct case for the operation the dispatcher depends on, and the dispatcher suite fakes it, so a single wiring case is proportionate. Not re-raised |
| DEX-006 lifecycle lines | **Closed** | Plan :11, T5 :117 (0011 only); ADR-0014:6 names 0011 only |

### New complexity introduced by the revision

None material. The revision removed code and records and added no mechanism: the store has one new operation, the domain module is untouched, the create is two calls to an existing primitive, the dispatcher change is one destructured read. Checked specifically:

- **The body read's placement rationale** (plan :25, :30; ADR-0014:18) was tightened from "an empty list never pays for it" to "a missing list never pays for it; an existing empty list reads it once and completes", which `Membership.ts:212-214` confirms. Wording only; the placement is still one `yield*`.
- **`send`/`resume` four bounded reads** (plan :82; ADR-0014:36) is a stated consequence of DEX-001, not new machinery; the pre-existing re-read-after-enqueue pattern is unchanged.
- **Lane B rebase protocol** (:152-157) was updated for the two-put create (`putItemRequests[1]`/`[0]`) and grew by no step.
- **One nit, no finding:** T3 :88 gives the `Api.test.ts` fake a `getCampaignBody` that projects the map entry, but that suite never reaches the dispatcher (`grep -n "runSlice\|Dispatching" apps/backend/src/Api.test.ts` is empty) and `get` goes through the fake's `getCampaign`, so nothing calls it there. The `unusedCampaignStore` form at `Api.test.ts:45-57` (one `Effect.die` line) is the smaller spelling. Implementer's call.

### Clerical residues, routed (not complexity)

- ADR-0014's title (:1) still reads "listings **and transitions** return summaries"; after DEX-001 only the listing does, and Decision bullet 4 (:19) says so. The title should drop "and transitions".
- ADR-0014's alternatives are numbered 1, 2, 3, 6, 4, 5 (:23-28).
- Plan T6 :136 names AWS CLI profile `deploy` beside Alchemy profile `emailer-test`; README:219-226 explains the two are different profile systems, so this is consistent, recorded here only so the next reader does not re-check it.

### Verdict

**Clear.** All six round-1 findings are closed in both documents; the revision introduced no new complexity; the one residue under DEX-005 is a single proportionate wiring case; the remaining items are clerical and are routed to the parent, not re-raised as findings.
