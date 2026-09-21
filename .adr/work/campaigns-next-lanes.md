# Campaigns next lanes — briefing for planning

> **Status:** Brief only. Not an implementation plan. Not authorized to code.
> **Audience:** another agent, to flesh each lane into its own plan via `create-plan`.
> **Date:** 2026-09-16, current-system section refreshed 2026-09-17 after PR #8
> **Authority:** User agreed to finish the campaigns story (HTML, segmentation, listing) and to add scheduling soon. User asked for two parallel worktrees now, then the rest. This document is that sequence, written so a planner does not re-derive coupling from scratch.

Do **not** implement from this file. Produce one implementation plan per lane (or a pair of plans for a parallel round), with ADRs only when a lane needs a significant decision. Consult `./wiki` and accepted ADRs. Prefer the smallest sufficient change.

## Current system (main after PR #8)

A campaign is a draft that `POST /campaigns/:id/send` moves to `queued`. A dispatcher Lambda consumes one SQS wake-up, pages fifty list members, reads the campaign body once per slice, skips unsubscribed/suppressed/bouncing, claims a `SEND#` row, submits through SES, checkpoints, and continues. Membership is live, not snapshotted. A campaign is **two items** under one partition key (ADR-0014): `META` holds identity, subject, state, counters, run token, cursor and the listing index attributes; `BODY` holds `text` and an optional `html`. `GET /campaigns` pages **summaries** in created order (PR #7). Bodies are text with an optional HTML part, both sent in one SES `Simple` message (PR #8). Every write is safe to repeat and the client retries every write (ADR-0013). There is still **no schedule** and **no audience filter**.

Relevant shapes:

- `packages/api/src/Schemas.ts`: `CampaignSummary = { id, listId, subject, createdAt, submission }`; `CampaignBody = { text, html? }` (`html` is `optionalKey`, absent or a string); `Campaign = CampaignSummary + CampaignBody`; `CreateCampaignPayload = { listId, subject, text, html? }`. `CampaignText` ≤ 64 KiB and `CampaignHtml` ≤ 256 KiB UTF-8 through one shared `utf8ByteCeiling` filter. `maxRequestBytes` is 512 KiB.
- `packages/api/src/Api.ts` `CampaignsGroup`: `create`, `list` (`page(CampaignSummary, EntityCursor)`), `get`, `send`, `resume`.
- `apps/backend/src/Storage/Campaigns.ts`: composed from `allPrimitives` like the audience store. `createCampaign` writes `BODY` then `META`, each with `recordOnce`. `getCampaign` reads both items; `getCampaignBody` reads one; `listCampaigns` hydrates `META` only; `beginRun` returns `{ listId, subject, cursor, run }` and **no body**.
- `apps/backend/src/Storage/Membership.ts` `listMembers`: hydrates the full `Contact` including `attributes`.
- `apps/backend/src/Mailer.ts` `makeSubmit`: SES `Content.Simple` with `Body.Text` always and `Body.Html` when the message has one, plus the `List-Unsubscribe` headers; text footer `footerFor`, HTML footer `htmlFooterFor` inserted before the last `</body>`.
- `apps/backend/src/Dispatching.ts`: after the member page is read, `getCampaignBody` once per slice; `OutgoingMessage` is `{ recipient, subject, text, html, unsubscribeUrl, campaignId, sendId }`.
- `apps/backend/src/Dispatch.ts`: wake-up is `{ campaignId, runToken }` only.
- CLI: `campaigns create --list --subject --text <file> [--html <file>]` (both bodies are read from files), `campaigns list`, `get`, `send`, `resume`.
- Alchemy 2.0.0-beta.77 already has `AWS.Scheduler.{CreateSchedule,DeleteSchedule,UpdateSchedule,ScheduleGroup}` and `wiki/aws/scheduler.md`.

Accepted ADRs that constrain later lanes: 0004 (sender-owned unsubscribe + postal footer, in both parts), 0007 (mailbox-keyed unsubscribe token), 0011 (open list, paced dispatcher, live membership), 0012 (reputation pause reasons, breaker, no SES-side pause), 0013 (every write is repeat-safe: fresh-id creates use `recordOnce`, conditional transitions tolerate a repeat, the client retries), 0014 (two campaign items; summaries on the wire; the dispatcher reads `BODY` per slice).

Still deferred: templates, personalisation, snapshotting, MCP, real recipients (after Round 2). Segmentation is lane D and scheduling is lane C below.

## Parallelism rules

Two worktrees are useful only when they do not both rewrite the same hot loop.

| Pair | Parallel? | Why |
|---|---|---|
| Listing ∥ HTML | **Yes — do these first** | Listing owns the index + `GET /campaigns`. HTML owns Mailer + outgoing payload. Shared files are additive (`createCampaign` item fields, CLI subcommands). |
| HTML ∥ segmentation | **No** | Both edit `Dispatching.ts` per-member loop (outgoing body vs skip-before-claim). |
| Listing ∥ scheduling | Possible later, worse now | Both touch `Storage/Campaigns.ts` and `Campaigns.send`/schema if scheduling adds a state. Listing should exist first so scheduled campaigns are visible. |
| Scheduling ∥ segmentation | **Yes — second round** | Scheduling owns enqueue/time (Scheduler → existing SQS message). Segmentation owns a skip in `Dispatching.ts`. |
| Either of these ∥ MCP | No until the contract settles | HTTP campaign shape will change twice. |
| Standing stage | Not a worktree | Ops: durable stage, real postal address, confirmed `EMAILER_ALERT_EMAIL`, then a tiny real send. |

Worktrees live in `~/worktrees/emailer/<branch>` (`use-worktrees`). Each lane gets its own Emailer `--stage` if it deploys. Parent owns merge to `main`. Never rebase shared branches.

## Sequence

```
Round 1 (done):                 listing (PR #7, with ADR-0014)  ∥  HTML (PR #8)
Round 2 (two new worktrees):    scheduling  ∥  segmentation
Then, not a code pair:          standing stage + first real send
Then optional:                  MCP (after the campaign contract is stable)
```

Templates, `{{name}}`, SES stored templates / `SendBulkEmail`, open/click tracking, double opt-in, resubscribe, and DMARC tightening stay **out** until this sequence is done.

---

## Round 1, lane A — Campaign listing

> **Done.** Merged as PR #7 together with the body-item split: [campaign-listing](campaign-listing.md), [campaign-body-item](campaign-body-item.md), ADR-0014. Kept for the record.

### Outcome

An operator can page campaigns in created order the same way they page contacts and lists. `GET /campaigns` and CLI `campaigns list`. Existing `get` / `send` / `resume` unchanged.

### In scope

- Write `listingAttributes("campaign", createdAt, id)` on `createCampaign` (same helper contacts/lists use).
- `listCampaigns(limit, cursor)` via existing `readEntityPage` / `gsi1`.
- HTTP: `HttpApiEndpoint.get("list", "/", { query: listingQuery, success: page(Campaign, EntityCursor) })` on `CampaignsGroup`, declared **before** `get("/:id")` so `"list"` is not parsed as an id (see contacts `getByEmail` before `get`).
- Domain `Campaigns.list`, API handler through `publicly`, CLI `campaigns list --limit --cursor`.
- Unit tests mirroring `Storage/Lists.test.ts` / contacts listing (index keys, cursor is `gsi1sk`, reserved-word assertion still holds).
- API/CLI tests for paging and auth.

### Out of scope

HTML, filters, schedule fields, new campaign states, backfill of existing rows (no production data; new creates only). Do not add a second index (by state, by list). A later filter-by-state is a query param only if it stays a **client-side** filter of a created-order page; a new GSI is a new decision.

### Owned files (expected)

- `apps/backend/src/Storage/Campaigns.ts` (+ tests) — index attrs + list op
- `apps/backend/src/Campaigns.ts` (+ tests) — `list`
- `packages/api/src/Api.ts` — list endpoint
- `apps/backend/src/Api.ts`, `Api.test.ts` — handler + fake
- `apps/cli/src/Commands.ts`, `Commands.test.ts`

May touch `Schemas.ts` only if the page helper needs a new export (prefer reusing `page(Campaign, EntityCursor)`).

### Merge hazards with HTML

HTML will add an `html` field on `Campaign` / `StoredCampaign` / `createCampaign`. Listing adds `...listingAttributes(...)` on the same `createCampaign` item. Resolve by keeping both. CLI: listing adds a **subcommand**; HTML adds flags on **create**. Do not rewrite `create` payload except to pass through fields HTML introduces after merge (HTML merges second, or both merge with that understanding).

### Done when

`pnpm check` green; `campaigns list` returns created-order pages; a live gate is optional (this is the same index already proven for contacts/lists). No new ADR unless the planner invents a second index.

---

## Round 1, lane B — HTML bodies

> **Done.** Merged as PR #8: [campaign-html-bodies](campaign-html-bodies.md). `--text` became a file flag afterwards for symmetry with `--html`. Kept for the record.

### Outcome

A campaign can carry an HTML body as well as the existing required text. SES `Simple` sends both. Unsubscribe link and postal address appear in the HTML footer as well as the text footer. Plain-text-only campaigns remain valid.

### In scope

- Contract: optional `html` on `CreateCampaignPayload` and `Campaign` (likely `optionalKey`, max bytes — decide against `maxTextBytes` / `maxRequestBytes`; HTML is larger than text, but the 512 KiB request cap still binds).
- Persist on `META`. `beginRun` / `CampaignRun` / `OutgoingMessage` carry it through to `Mailer.submit`.
- `Mailer.makeSubmit`: `Body.Html` when present, `Body.Text` always. Same `List-Unsubscribe` headers. HTML footer is a small static fragment (link + postal), not a template engine. Escape nothing from the **operator-supplied** HTML (it is the body). The footer's own interpolations are escaped: the postal address is free config text and goes through HTML escaping; the unsubscribe URL goes into an `href` attribute-escaped. Do not interpolate the recipient address into HTML.
- CLI: `--html` (file or string — pick one and stick to the existing `--file` import precedent if the body is large).
- Unit tests: text-only still sends text-only; html+text sets both parts; footer present in both; size/schema rejects.
- Integration: one simulator send whose received source (or at least SES accept) includes an Html part — only if the planner can prove it without the operator mailbox; otherwise unit + a documented skip.

### Out of scope

Templates, Mustache/`{{name}}`, per-recipient personalisation, SES template store, `SendBulkEmail`, CSS inlining services, AMP, tracking pixels, MIME attachments, multipart beyond Text+Html, segmentation, listing, scheduling.

### Owned files (expected)

- `packages/api/src/Schemas.ts`, `Schemas.test.ts`
- `apps/backend/src/Mailer.ts` (+ tests)
- `apps/backend/src/Storage/Campaigns.ts` (+ tests) — stored field + `CampaignRun`
- `apps/backend/src/Dispatching.ts` (+ tests) — pass `html` into `OutgoingMessage`
- `apps/backend/src/Campaigns.ts` — create payload
- CLI create command + tests
- Fixture updates wherever `Campaign` is constructed (Api/CLI/Campaigns tests, integration helpers)

### Constraints

- ADR-0004: every commercial message still has unsubscribe headers **and** a postal footer. HTML must not drop them.
- SES `Simple` (not `Template`, not raw MIME) unless the planner finds a hard limit that forces otherwise — stay on `Simple`.
- Do not put HTML on the `SEND#` row (subject/text were already removed from that row in ADR-0011).

### Merge hazards with listing

Same `createCampaign` object: HTML adds `html: str(...)` (optional via `withOptional`); listing adds `listingAttributes`. Both are extra fields. `Campaign` schema change will break listing-lane fixtures if listing merged first without `html` — HTML lane updates those fixtures; listing lane should not freeze a Campaign shape that omits future keys if it can avoid it (don't spread exhaustive object literals that reject extra keys at the type level more than the current tests already do).

### Decision that may need an ADR

Only if HTML is **required** rather than optional, or if the planner rejects `Simple` for a raw MIME path. Default: optional HTML, required text, `Simple`. That may not need an ADR.

### Done when

`pnpm check` green; text-only path unchanged; html+text submits both SES parts; unsubscribe/postal present in both representations.

---

## Round 2, after both Round 1 lanes are on main

Round 1 is merged. Plan both lanes against the "Current system" section above, not against the lane A/B text.

---

## Round 2, lane C — Scheduling

### Outcome

An operator can queue a **draft** to send at a future instant. At that instant the existing dispatcher runs. Cancel before fire returns the campaign to draft (or an explicit `cancelled` — pick one and justify). A fire after cancel is a no-op.

### In scope

- Contract: either `POST /campaigns/:id/schedule` with `{ sendAt: Timestamp }` or `send` with optional `sendAt`. Prefer a dedicated schedule endpoint so `send` stays “now”.
- New submission member, e.g. `scheduled { queuedAt? scheduledAt }`, plus pause/resume interaction: a scheduled campaign is not `queued` until the schedule fires.
- Runtime `AWS.Scheduler.CreateSchedule` (not a stack-static `Schedule` resource). One-shot `at(...)`, `ActionAfterCompletion: DELETE`, `FlexibleTimeWindow: OFF`, timezone explicit (UTC unless the user picks otherwise).
- Target: the **existing** dispatch queue with the **existing** `DispatchMessage` `{ campaignId, runToken }`, minted when scheduling (same as `send` today). Wiki: persist intent, then create the schedule; DynamoDB and Scheduler are not one transaction — reconcile or make create idempotent on a stable schedule name.
- `DeleteSchedule` on cancel / on `send` now that supersedes a schedule.
- CLI: `campaigns schedule --at ...` and cancel.
- Stack: Scheduler execution role (assume `scheduler.amazonaws.com`, `sqs:SendMessage` on Dispatch), a **mandatory** `ScheduleGroup` per stage (runtime-minted schedules outlive `alchemy destroy` unless they belong to a stack-owned group; an unfired schedule on a torn-down test stage would fire at a deleted queue), `CreateSchedule`/`DeleteSchedule` Http layers on the API Lambda.
- Tests: unit for state machine and “late fire is no-op”; live gate with a near-future `at(...)` if proportionate.

### Out of scope

Recurring cron/rate, send-time windows, per-recipient send-at, changing the dispatcher loop, HTML, filters. Do not use DynamoDB TTL or EventBridge **bus** rules as the scheduler.

### Must read

- `wiki/aws/scheduler.md` (time semantics, DST, DLQ, reconcile, late invocations)
- `node_modules/alchemy/src/AWS/Scheduler/CreateSchedule.ts` (PassRole, group, runtime minting)
- ADR-0011: `send` on already-queued re-enqueues the wake-up; schedule fire should be the same kind of idempotent enqueue once state is `queued`/`sending`.
- ADR-0013: every state transition the lane adds (schedule, cancel, fire) must be safe to repeat under the client's retry policy; `enqueueCampaign` is the precedent.
- ADR-0014: schedule intent lives on `META` (which the listing hydrates and `beginRun` updates), never on `BODY`.

### Risks the plan must close

- Scheduler delivery is at-least-once; `runToken` + conditional `enqueueCampaign` already exist — reuse them.
- **`beginRun` admits only `queued` and `sending`** (`Storage/Campaigns.ts`, `ConditionExpression: "runToken = :run AND #state IN (:queued, :sending)"`). A fire on a campaign whose state is `scheduled` would return `stale` and be dropped silently. The plan must admit `scheduled` in that condition (the fire is then the same token-checked transition `queued` takes today), or it must not introduce a distinct `scheduled` state at all. Cancel clears the token and returns to draft; send-now mints a fresh token and deletes the schedule; a late fire fails the token check either way.
- Deleting a schedule cannot recall a message already in SQS; the token check above is what makes that safe.
- Listing (Round 1) should already show the campaign; scheduling only adds a submission state the list already returns.

### Decision / ADR

Likely yes: “one-shot EventBridge Scheduler targeting the dispatch queue, intent stored on the campaign, late fires ignored.” Alternatives: poller Lambda (worse), SQS delay (max 15 minutes), EventBridge cron (not per-campaign).

---

## Round 2, lane D — Segmentation

### Outcome

A campaign can name a **filter** over contact attributes. The dispatcher still pages the whole list (live membership, ADR-0011) and **skips** members that do not match, with a skip reason the operator can see (new reason, e.g. `filtered`, or reuse `skipped` with a stored skipReason — `SkipReason` today is `unsubscribed | suppressed | bouncing`).

### In scope

- Filter language, smallest useful: **AND of attribute equality** against `Contact.attributes` (already max 20 keys, 64/512 chars). No OR, no regex, no numeric ranges in v1 unless the planner has a strong reason.
- Store the filter on the campaign `META` (small; the listing already hydrates that item and `beginRun` already returns it, so a summary can show it); `Dispatching.ts` evaluates it **in memory, after the per-slice `getCampaignBody` read and before `addressStatus`** (that lookup is a DynamoDB read; the filter is a pure function of `member.attributes`, which `listMembers` already returns). A non-match is **not** routed through `skipRecipient`: that is a two-item transaction per member (SEND row + counter) and a filter matching a small share of a large list would generate tens of thousands of writes to record nothing. Idempotency needs no row here, because re-paging from the checkpoint re-evaluates the same pure function. If a count is wanted, count per page at checkpoint time, in a field of its own rather than `skipped`, which today means consent and deliverability signals.
- Contract + CLI: `--attr plan=pro` style already exists on contacts; reuse that shape.
- Unit tests: match, miss, missing key, empty filter (= all members, today’s behaviour).

### Out of scope

New GSI / “segment” entity / saved segments / snapshot of matching IDs. HTML, scheduling, personalisation. Do not query a subset of members from DynamoDB in v1 — that is a different access path and a new index design.

### Owned files

- Schemas + create payload
- `Storage/Campaigns.ts` persist filter
- `Dispatching.ts` + `SkipReason` + tests (this is why it cannot parallel HTML)
- CLI create flags
- Maybe `campaigns get` showing how many were skipped as filtered (progress.skipped already counts skips)

### Decision / ADR

Maybe a short ADR if the "no row per non-match" choice is contentious. Default: no SEND row and no `SkipReason` for a filter miss; an optional per-page `filtered` counter on `META`.

---

## After Round 2

**Standing stage + first real send** (ops, no worktree): durable Emailer stage (not `test-*`), real `EMAILER_POSTAL_ADDRESS`, `EMAILER_ALERT_EMAIL` confirmed, first send to a tiny real list. Reputation and deliverability lanes are already on `main`; this was the remaining bar besides HTML.

**MCP** (`apps/mcp` is a stub): only after listing, HTML, schedule, and filter are in the HTTP contract, otherwise the tools churn. CLI remains the operator surface until then.

## How the next agent should proceed

1. Read this briefing, ADR-0011, ADR-0013, ADR-0014, ADR-0004, ADR-0012, `wiki/aws/scheduler.md` (for lane C), `wiki/effect/schema-and-config.md` and `wiki/aws/dynamodb.md` as needed. The Round 1 plans show the shape a lane plan takes and the review flow it goes through.
2. Use `create-plan` **once per lane**: Round 2 C and Round 2 D as two plans that name non-overlapping owned files and a merge protocol for the files both touch (`Schemas.ts`, `Storage/Campaigns.ts` `META`, `Commands.ts`, the `CampaignStore` fakes, README).
3. Round 1 is implemented; both Round 2 plans can be written now.
4. Stay inside each lane’s in-scope list. Research may not add templates, tracking, or SES tenants.
5. If a material product choice appears (required vs optional HTML; `schedule` endpoint vs `send --at`; filter language), stop and ask the user rather than inventing a larger system.
