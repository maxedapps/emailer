# Decomplex review: Drafting, previews and test sends

## Overall status

**Six potential findings: four `Act`, one `Act` rated low, and one `Ask user`.**

The plan implements every behavior the user decided without adding speculative infrastructure. Its large moves remove complexity:
- concern folders;
- one composer;
- one signed-token module;
- the `*Live` Layers with `Effect.context` capture;
- the CLI split;
- the sweep.

The findings are local. Each deletes machinery that handles a failure with no reachable harm, or writes storage in more shapes than the behavior needs. The two most valuable:
- **DEX-001:** drop the 45 s budget and `not-attempted`.
- **DEX-002:** make the draft update write one fixed shape.

None of the findings touches:
- the prod-replacement constraint;
- unsubscribe-token byte compatibility;
- the Preview function's least privilege.

## Review contract

| Axis | Selection |
|---|---|
| Mode | Prevention |
| Target | `.adr/work/drafting-and-preview.md` (plan), `.adr/0019-markdown-campaign-bodies.md`, `.adr/0020-drafts-previews-and-test-sends.md` (all unimplemented, Proposed) |
| Authority / required behavior | **User decisions of 2026-09-23 (not reviewed for simplification):**<ul><li>`marked` in the CLI;</li><li>editable and deletable drafts;</li><li>a dedicated public Preview Lambda with least privilege (ADR-0004, ADR-0008);</li><li>backend concern folders;</li><li>synchronous, capped test sends from the API that share SendGuard and pacing;</li><li>a stderr confirmation with `--yes`;</li><li>preview links with `--open`.</li></ul>**Standing rules:**<ul><li>big refactors, deletions and extractions toward a lean codebase that follows Alchemy 2.0.0-beta.77 and Effect 4.0.0-rc.112;</li><li>no edge-case or esoteric fail-state handling (global rule);</li><li>"rewrite over bolt-on" (memory).</li></ul>**Hard constraints:**<ul><li>prod never replaced;</li><li>unsubscribe-token byte compatibility.</li></ul> |
| Scope | Machinery, abstractions, options, outcomes, error types, tests and tasks beyond the required behavior. Also complexity the slice could delete while it touches the code. Defects, security and plan compliance are out of scope. |
| Report | `.adr/work/drafting-and-preview-decomplex.md` (explicit path; this repository uses `.adr/`, not `adrs/`) |

## Coverage

### Inspected

- **The three targets,** in full.
- **Backend source**, read in full unless a range is given:
  - `apps/backend/src/Api.ts`, `Unsubscribe.ts`, `Auth.ts`, `Mailer.ts`, `SendGuard.ts`, `Dispatching.ts`, `Dispatcher.ts`, `Dispatch.ts`, `CampaignSchedule.ts`, `Campaigns.ts`, `Feedback.ts`, `UnsubscribePage.ts`;
  - `Storage/Unsubscribe.ts`, and `Storage/Campaigns.ts` lines 230–340, 496–560 and 800–846;
  - the capability exports of `Storage/Primitives.ts`, `Storage/Audience.ts` and `Storage/Feedback.ts`.
- **API contract:** the errors and the import payload in `packages/api/src/Schemas.ts`, lines 395–483.
- **CLI:** the flag and command inventory of `apps/cli/src/Commands.ts` (via grep), and `main.ts`.
- **Tests and stack:**
  - `SendGuard.test.ts` lines 1–60;
  - `alchemy.run.ts`;
  - the uses of `EMAILER_UNSUBSCRIBE_URL` and `apiUrl` in `README.md`, `.env.example` and `IntegrationSupport.ts`.
- **Alchemy:** the `AWS/Lambda/Function.ts` props in `node_modules` (no log-retention prop exists).
- **Greps:** `SendEmail(` call sites (only `MailerLive`), and what `ReplayFeedback.ts` re-invokes (the Feedback Lambda with the original events).
- **Rules and memory:** the decomplex skill's gates and template, the ADR conventions, and the memory notes "rewrite over bolt-on" and "RateLimiter as pacing primitive".

### Skipped or partial

- **CLI:** the bodies of `Commands.ts` beyond the flag inventory; `Commands.test.ts`.
- **Backend tests:** `Api.test.ts`, `Campaigns.test.ts`, `Feedback.test.ts` and `Dispatching.test.ts`, beyond greps.
- **`IntegrationSupport.ts`:** beyond the grep.
- **ADRs:** the bodies of ADR-0001, 0004, 0007, 0008, 0011, 0012 and 0014. Their relevant clauses were taken as quoted in ADR-0020.
- **The `wiki/`.**
- **Live docs:** the Alchemy and Effect documentation for the `Effect.context` capture pattern. The plan's citation was accepted.
- **Research files:** the `scratchpad/md-research/` experiment.

## Potential findings

### DEX-001: Drop the 45 s test-send budget and the `not-attempted` outcome

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:**
  - Plan T10 step 4, T7 (`TestSendResult.not-attempted`) and T4 (exporting `reservationFor`).
  - Research, "Backoff doesn't fit the API budget".
  - ADR-0020 Decision, "inside a 45 s budget … `not-attempted`".
  - The budget is plan-derived. The user decided "synchronous, capped, shared SendGuard and pacing", not a budget.
- **Current-need evidence:**
  - Timeouts: the API function's is 60 s (`Api.ts:34`) and the CLI request's is 70 s (`apps/cli/src/Commands.ts:24`).
  - The plan's own numbers: "20 recipients take about 20 s even then", at the guard's 1/s floor.
  - With a campaign dispatching concurrently at 1/s, the shared fixed-window limiter interleaves the two senders: roughly 40 slots in about 40 s, still under 60 s.
  - On prod, the account has production access, so `limit` is `floor(MaxSendRate × 0.8)`, well above 1/s.
  - The budget therefore bites only when SES submissions hang. Each one then times out after 8 s (`submissionTimeout`), and those recipients are already `uncertain`.
  - It was also ported mechanically. `reservationFor` is `delay + submissionTimeout + 2 × operationTimeout` (`Dispatching.ts:59-60`), about 18 s. It reserves time for two 5 s store writes (claim and settle) that test sends never make.
- **Added burden:**
  - a deadline and per-recipient reservation check in `sendTest`;
  - a fifth outcome variant in the public contract, the CLI output and the ADR;
  - `reservationFor` exported from `sending/SendGuard.ts` for a second consumer;
  - a `TestClock` budget-exhaustion test.
- **Reachable practical impact:**
  - It protects only an SES-degraded window.
  - There, the outcome is a 5xx or timeout from the API, compared with a list of `uncertain`/`not-attempted` results.
  - The recipients are the operator's own test addresses. No store state exists to reconcile, because test sends write no SEND rows.
- **Smallest simpler alternative:**
  - Loop over the recipients in order: skip check, `consumeSlot(limit)`, sleep, send, map the result.
  - Rely on the cap of 20 and the 60 s function timeout.
  - `reservationFor` stays private in `Dispatching.ts`, so T4 moves only `consumeSlot` (with the limiter key and window).
  - `TestSendResult` keeps `accepted | skipped{reason} | rejected{rejectionCode} | uncertain`.
- **Exception / boundary check:**
  - "Unknown outcomes" is the relevant exception. It does not hold here: a hung SES already yields `uncertain` (an unknown outcome) per recipient. A retry re-sends only test mail to operator-chosen addresses, and no consent or counter state is at stake.
  - Shared admission (the guard and the `ses-send` limiter) is unchanged.
- **Required behavior and simplification risk:**
  - Synchronous, capped and shared admission are all preserved.
  - The residual behavior: during an SES outage a large test send may time out with no per-recipient report, and the operator re-runs it.
- **Bounded next step or user question:**
  - Remove T10's budget step and the budget test, and the `not-attempted` variant from T7.
  - Drop "export `reservationFor`" from T4.
  - Change ADR-0020's Decision bullet to "one attempt, no backoff; the cap keeps the call within the API's timeout".
- **Acceptance signal:**
  - A four-variant `TestSendResult`.
  - `reservationFor` has a single consumer.
  - ADR-0020 justifies the cap against the 60 s timeout, not against a budget.

### DEX-002: Write the draft update as one fixed transaction shape

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:**
  - Plan T9, `storage/Campaigns.ts` `updateDraft(id, change)`.
  - T9 step 5, "Return `get`".
  - T9 tests, "the exact transaction shapes for each update variant".
  - The user decided "editable drafts". The partial-write shapes are plan-derived.
- **Current-need evidence:**
  - The service must already read the current body to merge `text` and `html` independently (T9 step 3). It therefore holds the whole current campaign before writing.
  - Writing only the changed fields saves nothing observable. The DynamoDB items are small, and BODY is already replaced wholesale.
- **Added burden:** `updateDraft` has to build its expression from whichever fields are present:
  - an Update on META plus a Put of BODY;
  - a ConditionCheck plus a Put of BODY, when only the body changes;
  - an Update only, when only META fields change;
  - a per-field SET/REMOVE assembly for `subject`, `listId` and `#filter`;
  - an implicit empty-PATCH case.

  Each needs an exact-shape unit test, and the service ends with an extra `get`.
- **Reachable practical impact:**
  - Conditional expression assembly is the most error-prone code in this store (reserved-word aliasing, as with `#filter`).
  - Each variant is another exact-request test to maintain.
- **Smallest simpler alternative:**
  - `update` reads the campaign once (`get`), checks `draft`, checks a changed `listId` exists, and applies the PATCH in memory (absent keeps the value, `null` removes it).
  - It then calls `updateDraft(id, { listId, subject, filter?, text, html? })`. That always writes one transaction: an Update on META with `SET listId, subject` plus `SET #filter` or `REMOVE #filter`, conditioned on `#state = :draft`, and a Put of BODY.
  - It returns the merged campaign directly, as `create` returns `created` (`Campaigns.ts:84-86`).
  - Storage tests cover two shapes: with and without a filter.
- **Exception / boundary check:**
  - The API contract (`UpdateCampaignPayload` with absent/null keys) stays exactly as planned, which keeps the `UpdateContactPayload` convention.
  - The draft condition still guards against a state change between the read and the write. The re-read on conflict stays.
- **Required behavior and simplification risk:**
  - All PATCH semantics are preserved.
  - Two concurrent PATCHes that change different fields of the same draft become last-writer-wins. The planned design already has this for BODY. This is a single-operator tool, and the global rule excludes such edge cases.
- **Bounded next step or user question:** Rewrite T9's `updateDraft` bullet and its test bullet as above, and drop step 5's `get`.
- **Acceptance signal:**
  - `updateDraft` has no branches on which fields are present, apart from the filter set/remove.
  - The storage tests pin two transaction shapes.

### DEX-003: Drop the `purpose=test` SES tag and T12's new branch; relevel the existing untagged branch

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:**
  - Plan T3: the `purpose` maps to a `purpose=test` tag.
  - Plan T12: `Feedback.record` reads the `purpose` tag.
  - ADR-0020 Decision ("tagged `purpose=test`") and Consequences ("logged at info level").
  - The Feedback change is plan-derived.
- **Current-need evidence:**
  - `MailerLive` is the repository's only `AWS.SES.SendEmail` binding (`Mailer.ts:221`). `ReplayFeedback.ts` re-invokes the Feedback Lambda with the original events.
  - `handleEvent` drops events from other configuration sets (`Feedback.ts:138-143`), which covers EmailOctopus on the shared account.
  - After T3, the typed `purpose` union guarantees that every campaign send carries `campaignId`.
  - An event without `campaignId` on this configuration set can therefore only be a test send. The tag distinguishes a case from itself.
- **Added burden:**
  - a tag name and value that the Mailer emits;
  - a tag read and a new branch in `record`;
  - a new Feedback unit test;
  - a whole plan task (T12);
  - ADR wording.
- **Reachable practical impact:** None of these distinctions has a second reachable case.
- **Smallest simpler alternative:**
  - Keep the `purpose` union in `Mailer.send`, and map `{ kind: "test" }` to no `EmailTags`.
  - In `Feedback.ts:83-89`, change the existing untagged branch from `logWarning("feedback event without a campaign tag")` to an info log such as "feedback for a test send", with the same fields.
  - Retarget the existing untagged-warning test instead of adding one.
  - Fold this one-line change into T10 and delete T12.
- **Exception / boundary check:**
  - Suppression still runs first and is unchanged.
  - Campaign counters still depend only on `campaignId`, which test sends never carry.
- **Required behavior and simplification risk:**
  - Unchanged: tests suppress on bounce or complaint and never touch campaign counters. The T15 integration case still proves that.
  - The risk: if another untagged sender ever appears on this configuration set, its feedback would log as a test send. That is hypothetical today.
- **Bounded next step or user question:**
  - Edit T3 (no test tag) and T10 (the relevel).
  - Remove T12.
  - Adjust the ADR-0020 wording.
- **Acceptance signal:**
  - No `purpose` tag appears in the SES request tests.
  - Feedback has no new branch.
  - The plan has 15 tasks.

### DEX-004: Make `sendGuard` a pure function over the fetched responses once `SendGuardLive` owns the reads

- **Evidence:** Confirmed
- **Recommendation:** Act (low value; T4 already rewrites this file)
- **Surface and location / authority:**
  - The existing `SendGuard.ts:25-73` (`sendGuard<EA, RA, ED, RD>(getAccount, describeAlarms, ceiling)`).
  - Plan T4: "`SendGuardLive` … reuses the pure `sendGuard`".
- **Current-need evidence:**
  - The thunk parameters and the four generic type parameters existed so that the Dispatcher constructor could pass its bound AWS functions (`Dispatcher.ts:84-86`), and tests could pass `Effect.succeed` thunks (`SendGuard.test.ts:8-13`).
  - After T4, only `SendGuardLive` performs the two reads, and consumers stub the `SendGuard` service instead.
- **Added burden:**
  - The generic Effect signature.
  - Every guard test wraps plain data in thunks and runs `Effect.runPromise` to test arithmetic.
- **Reachable practical impact:** Maintenance and reading cost only. This is the least valuable finding.
- **Smallest simpler alternative:**
  - `allowanceFrom(account, alarms, ceiling): SendAllowance`, a plain function.
  - `SendGuardLive.current` runs `Effect.all([getAccount(), describeAlarms()], { concurrency: 2 })` and maps it through `allowanceFrom`.
  - The tests become direct `expect(allowanceFrom(...)).toStrictEqual(...)` calls.
- **Exception / boundary check:** The policy stays centralized and the thresholds are unchanged.
- **Required behavior and simplification risk:**
  - Identical output. The existing cases carry over one-for-one.
  - The risk is minimal because T4 already touches every line.
- **Bounded next step or user question:** Add this to T4's change list.
- **Acceptance signal:** `SendGuard.ts` has no generic type parameters, and `SendGuard.test.ts` has no `Effect.runPromise`.

### DEX-005: Don't remove a leftover schedule when deleting a draft

- **Evidence:** Confirmed
- **Recommendation:** Act (low value)
- **Surface and location / authority:**
  - Plan T9, `campaigns/Campaigns.ts` `remove`: "remove any schedule under the leftover `runToken`".
  - T9 test "leftover schedule removal".
  - ADR-0020 Decision, "after removing any leftover schedule".
  - This is plan-derived, "the way `cancel` does".
- **Current-need evidence:**
  - A draft carries a live schedule only when a `cancel` wrote `draft` but its `schedules.remove` then failed.
  - If that schedule fires after the delete, `beginRun`'s condition `runToken = :run AND #state IN (…)` (`Storage/Campaigns.ts:504`) fails on the missing META. The wake is discarded as `stale` with an info log.
  - The schedule deletes itself (`ActionAfterCompletion: "DELETE"`, `CampaignSchedule.ts:17`), and `DeleteScheduleGroup` removes any remnant with the stage.
- **Added burden:**
  - `remove` depends on `CampaignSchedule` and the run-token handling;
  - one unit test;
  - one ADR clause.
- **Reachable practical impact:** The guarded state is reachable but harmless. It is exactly the class of fail-state handling the global rule excludes.
- **Smallest simpler alternative:** `remove` reads the control record, checks `draft` and calls `deleteDraft`. Nothing else.
- **Exception / boundary check:**
  - Lifecycle cleanup is still owned: the schedule deletes itself, and stage teardown remains complete.
  - `cancel`'s own draft branch (`Campaigns.ts:278-285`) is untouched. That is where a failed cleanup is retried.
- **Required behavior and simplification risk:**
  - A deleted draft can never be sent, because the stale wake is discarded.
  - The only residual is one info log line if an orphaned schedule fires.
- **Bounded next step or user question:** Remove that step and its test from T9, and the clause from ADR-0020.
- **Acceptance signal:** `Campaigns.remove` does not yield `CampaignSchedule`.

### DEX-006: Collapse the CLI `content/` folder into one Markdown module

- **Evidence:** Supported
- **Recommendation:** Ask user
- **Surface and location / authority:**
  - Plan "Target structure" (`apps/cli/src/content/{Content,Markdown,EmailLayout}.ts`) and T11.
  - The plan says the user saw the target layout, so this may already be accepted.
- **Current-need evidence:**
  - `EmailLayout.ts` (the layout plus the `styles` record) has one consumer, `Markdown.ts`. Hand-written `--html` bodies are not wrapped.
  - `Content.ts` (`contentFlags`, `resolveContent`) has one consumer module, `commands/Campaigns.ts` (create and update).
- **Added burden:**
  - a folder;
  - two single-consumer module boundaries, including an exported `styles` record shared across them;
  - a separate `Content.test.ts`.
- **Reachable practical impact:** Navigation and API-surface cost only. Moderate to low.
- **Smallest simpler alternative:**
  - A single `apps/cli/src/Markdown.ts` holding the layout, the styles and both `Marked` instances, exporting only `renderMarkdown`.
  - `contentFlags` and `resolveContent` live in `commands/Campaigns.ts` beside `create` and `update`.
  - Their exclusivity and validation cases join the spawned-CLI tests in `commands/Campaigns.test.ts`.
- **Exception / boundary check:**
  - ADR-0019 names `EmailLayout.ts` as the one place to change the look. A named section inside `Markdown.ts` serves the same purpose.
  - The folder does become a real boundary when the MCP app needs the renderer. ADR-0019 already defers that move to a shared package.
- **Required behavior and simplification risk:** The behavior is identical. Only the file layout and the test location change.
- **Bounded next step or user question:** "Keep `content/` with three files as shown, or use one `Markdown.ts` plus content flags inside `commands/Campaigns.ts`?"
- **Acceptance signal:** The user's choice is recorded in the plan's Target structure.

## User-decision queue

| DEX ID | Material decision | Evidence and options | Recommendation |
|---|---|---|---|
| DEX-006 | Should the CLI keep a `content/` folder? | **Evidence:** single consumers, as above, and the user saw the layout. **Options:** (a) keep three files; (b) one `Markdown.ts`, with the flags in `commands/Campaigns.ts`. | Ask user |

## Confirmed proportionate areas

- **`lambdaBasics` (T5):**
  - Alchemy's `AWS.Lambda.Function` has no log-retention prop; it only reaps `/aws/lambda/<name>` on delete. The explicit `LogGroup` is therefore required.
  - Five functions share runtime, architecture, retention and naming. That is a stable policy, and the helper keeps the logical IDs byte-identical.
- **`SignedToken` (T2):**
  - It has two real consumers, about 20 lines of generic code, and it keeps the security-relevant structure (version inside the signed material, constant-time comparison) in one place.
  - The golden vector protects the hard constraint, and should be added whatever the design.
  - A small note: keep length bounds in the callers, as `maxTokenLength` and `maxPreviewTokenLength` already are, not as another generic parameter.
- **The three error types:**
  - `CampaignStateConflict` is a rename that also covers update and delete: net zero.
  - `TestAudienceTooLarge` is the server side of the required cap. The list size is known only after the read, and no existing error fits.
  - `SendingPaused` is how the required shared guard refuses.
- **`CampaignReader`:** required by the user's least-privilege Preview function. It mirrors the existing `UnsubscribeStore` pattern (`Storage/Unsubscribe.ts`: a capability built from one primitive).
- **`purpose` union:** keep the typed `{campaign, campaignId, sendId} | {test}` argument. Only the extra SES tag is questioned (DEX-003).
- **The Mailer mints the link and one composer serves both the Mailer and the preview:** this gives the preview fidelity the user asked for, and no caller can forget the link.
- **CLI module split (T6):**
  - `Client.ts` and `Flags.ts` are shared by all four command modules.
  - `Emailer.ts` lets tests import the root command without running `main`.
  - Per-group command files replace a 643-line file that would grow further.
  - The only question is `content/` (DEX-006).
- **`--clear-filter`:** it mirrors the existing `contacts update --clear-name` (`Commands.ts:197`) and the `UpdateContactPayload` absent/null convention.
- **`previewUrl` stack output:**
  - Nothing consumes it: minting returns the full URL, and `unsubscribeUrl` exists because `IntegrationSupport.ts:107` reads it.
  - It is not admitted, because the burden is about one line. Drop it if convenient.
- **Per-task prod plans (T1, T5, T14, T16):**
  - They are read-only, and the hard constraint justifies catching a replacement at the task that causes it: T1 moves `main`, and T5 rebuilds the log-group and function props.
  - T14's plan is redundant with T16's but cheap.
- **Sweep (T15):** a bounded, scout-verified deletion task. It reduces complexity.
- **Stderr terminal, `QuitError` to `UserError`, detached `openInBrowser`, and the `CliHarness` stdin option:** the smallest mechanisms that deliver the user's prompt on stderr, `--yes` and `--open`, and make them testable.
- **Preview wrapper page (From, Subject, sandboxed HTML, text part):** the text part comes from ADR-0019's custom text renderer, and the page is the only place to review it before a send.

## Limitations

- **Budget reasoning (DEX-001):** it relies on the plan's rate figures and on the code's fixed-window limiter semantics. Concurrent-campaign interleaving was reasoned about, not measured.
- **Update test count (DEX-002):** the effect on the test count is estimated from the plan's wording. The existing `Storage/Campaigns.test.ts` scripted-table style was not read.
- **Other untagged senders (DEX-003):** "no other untagged sender" is confirmed for this repository only. Any external use of the `EmailerMail` configuration set would change that.
- **What this review does not cover:** the correctness of the Preview CSP, iframe and escaping details, and any other defects. Those belong to `code-review` or the plan review.
- **These findings are advisory.** The plan owner dispositions each one.
