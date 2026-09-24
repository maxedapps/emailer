# Review fixes and simplification

> **Status:** In progress
> **ADRs:** amends [0019](../0019-markdown-campaign-bodies.md) in place (text part); lifecycle notes and clerical fixes on [0003](../0003-feedback-events-through-eventbridge.md), [0012](../0012-reputation-guardrails.md), [0013](../0013-repeat-safe-writes.md), [0015](../0015-one-shot-scheduler-per-campaign.md), [0016](../0016-cancelling-pending-campaign-runs.md), [0018](../0018-optional-dns-management.md), [0020](../0020-drafts-previews-and-test-sends.md); constrained by [0008](../0008-storage-capabilities-and-error-boundaries.md), [0011](../0011-open-recipient-set-and-paced-dispatch.md), [0013](../0013-repeat-safe-writes.md), [0020](../0020-drafts-previews-and-test-sends.md)
> **Updated:** 2026-09-24

## Outcome and boundaries

- **Problem and target:**
  - A whole-codebase review of `9ebb2fc`, and its follow-ups, found:
    - no critical or high defects;
    - four medium ones: the Markdown text part, CLI error output, a backoff test that can't fail, and a wiki page contradicting ADR-0013;
    - low-severity typing gaps and a missing send-path test;
    - about 140 lines of removable code;
    - ADR/wiki drift.
  - The target is that every finding is closed, the code is smaller, and `pnpm check` plus the live suite stay green.
- **In scope:** the tasks below. Every one was discussed with the user on 2026-09-23. The user approved "the obvious cleanup and simplification … all the fixes and improvements we discussed", and chose on 2026-09-23:
  - mark ADR-0016 Confirmed from recorded runs;
  - deliver as branch + PR;
  - start now and sync with `sender-name` later.
- **Out of scope:**
  - **Corrupt items answering 500.** Dying hands the `SchemaError`, with item values, to Alchemy's full-cause logging.
  - **Trimming the `Api.test.ts` fake's store rules.** There's no defect, and it risks losing HTTP-mapping coverage.
  - **CLI `--clear-attributes` and `--attr` on create.** These are features.
  - **Named HTML entities in the text part.**
  - **A helper for the four reputation alarms.** No test covers alarm props.
  - **Reusing `CreateContactPayload` for import entries.**
  - **Merging the unsubscribe and preview page scaffolding.**
  - **Sharing cause rendering across the CLI and the replay tool.** They are separate apps.
  - **A comment pass.**
  - **`.env.test` auto-fill.** Unverified.
  - **Echo handling for `OnTenantSuppressionList`/`EmailValidationSuppressed`.** This project uses neither SES tenants nor auto-validation.
  - **Things blocked upstream.** API `onExcessProperty: "error"` needs an Effect RC with effect#8423; rc.117 is still the newest. oxlint 1.85 needs a newer `@effect/tsgo`; 0.45.0 is still the newest.
  - **Any prod deploy.** Only on the user's go.
- **Approach:**
  - One branch, `review-fixes`, in the worktree `~/worktrees/emailer/review-fixes`, off `main` at `9ebb2fc`.
  - Commits follow the task order. `pnpm check` is green at every commit.
  - Tests go before the send-path refactor.
  - One ephemeral live gate at the end, then the ADR-0016 confirmation, the leak check and a PR.
  - If `sender-name` merges first, merge `main` in and re-run the gates. It also touches `Mailer.ts` and `README.md`, but no hunks overlap.

## Key files, evidence, and decisions

| File or source | Why it matters | Decision or plan impact |
|---|---|---|
| `apps/backend/src/sending/Dispatching.ts`, `Dispatching.test.ts` | Send path, and the untested uncertain and rate-limited recovery paths | T1 tests first, then T2 |
| `apps/backend/src/sending/SendGuard.ts`, `campaigns/TestSends.ts` | Guard read failures crash (500); pacing is mapped in one sender only | T3 |
| `apps/backend/src/Diagnostics.ts`, `sending/Mailer.ts` | Type cast at the API boundary, schema-based `describeCause`, untyped rejection table | T4 |
| `apps/backend/src/storage/{Primitives,Membership,Campaigns,Addresses}.ts` | Order-by-key and copied shapes | T5, T7 |
| `apps/backend/src/sending/Dispatcher.ts` | Slice deadline equals the Lambda timeout | T6 |
| `apps/cli/src/{Client,Diagnostics,Flags,Markdown}.ts`, `commands/Campaigns.ts`, `apps/backend/src/feedback/ReplayFeedback.ts` | CLI output, typing, text part | T8, T9 |
| ADR-0019:27, `wiki/email/html-email.md:23` | "Headings come out in capitals" | Amended in place by T9 |
| `wiki/effect/retries-and-concurrency.md:38` | Contradicts ADR-0013 and `wiki/aws/dynamodb.md:69` | T10 deletes the sentence |
| ADR-0015/0013/0016 headers | Missing supersede links | T10 |
| ADR-0016, `.adr/work/queued-campaign-cancellation.md` | T6 still open | T12 |

## Research

All from this session, 2026-09-23, at HEAD `9ebb2fc`. The review lanes ran read-only; this document records the results.

- **`pnpm check`:** green on HEAD: 874 unit tests, lint with 0 diagnostics.
- **Tried in a scratch copy** (typecheck, lint with the effecttsgo and anti-slop rules, format, full unit suite; 874 pass):
  - T3 and T4, and T8's `withClient<A, E>`.
  - A misspelled key in the typed rejection table fails typecheck.
  - `DescribeAlarms` has an `any` error type in Alchemy beta.79. It needs an annotated `const` for lint to pass: a pipeline over it without the annotation trips `effecttsgo(any-unknown-in-error-context)`.
- **T9 (Markdown), in the scratch copy:**
  - Nested lists, ordered continuation lines, multi-paragraph items and task lists render correctly.
  - The only unit failures are the 4 cases that pin the old behaviour (see T9).
- **T2, T5 (`readEntityPage`), T7 and T8 (`pageQuery`):** applied by a simplification lane; format, lint, typecheck and 877 tests pass (874 plus three characterization cases).
- **T5's `listMembers` half:** the plan review applied it in a scratch copy. It fails `Membership.test.ts:266`, which pins the `localeCompare` sort (the query and the batch answer in the same order), so T5 rewrites that fixture.
- **T8's render rule, as revised by the plan review:** `Config.ConfigError` is not an `Error` (`effect/src/Config.ts:72`), but its `message` already includes its cause. The rule keys on a string `message` and follows `.cause` only through `Error`s. In a scratch copy:
  - a missing `EMAILER_API_URL` printed `SchemaError(Expected string` and, on the next line, `at ["EMAILER_API_URL"])`, once;
  - a refused port printed `Transport error (GET …): fetch failed: connect ECONNREFUSED …`;
  - contract errors kept their JSON.
- **T1's two new tests** fail under three mutations:
  - resending after an uncertain outcome;
  - recording an uncertain send as accepted;
  - skipping the settle after a successful retry.
  - The backoff fix in T1 fails when the backoff `Effect.sleep` is removed; the test as it stands does not.
- **CLI failure output today:**
  - A duplicate `--to` prints 896 lines (41 KB) of schema tree.
  - A transport failure prints `"cause": {}`.
  - An oversized `--text` echoes the whole file.
- **Messages available to the renderer:** contract errors have an empty `message`. `SchemaError.message` is readable (`Expected each address to appear at most once at ["to"]`). A transport `HttpClientError.message` is `Transport error (GET <url>)`, with a `TypeError: fetch failed` cause that has its own cause.
- **AWS bounce subtypes** (SES event docs): `OnAccountSuppressionList` and `OnTenantSuppressionList` "do not count toward your bounce rate". `EmailValidationSuppressed` says no such thing. The code's echo set (`OnAccountSuppressionList`, `Suppressed`) stays.

## Tasks

#### T1 — Pin the send path's unknown-outcome and recovery rules

- **Change:**
  - Add to `Dispatching.test.ts`:
    - an uncertain first submission is settled `uncertain` and never resent (`mailer.sent` has 2 entries for 2 members); the next member is settled `accepted`; nothing pauses; the run completes;
    - one `rate-limited` and then `accepted` gives 2 sends, 2 slot consumes, one `accepted` settlement and no pause (clock moved forward 1 s).
  - An ordinary rejection that neither pauses nor stops the run is already pinned by "consumes the limiter once per attempt" (`:940`), so it gets no new case.
  - In "retries rate-limited submissions with 1s, 2s, 4s backoff then pauses", replace the single 7 s clock step with: adjust `6999 millis` and expect 3 sends, then adjust `1 millis` and continue.
  - Delete "still settles an already-claimed recipient after a stale begin". Its second half calls only the in-file fake. The real rule is pinned in `storage/Campaigns.test.ts:1543`.
- **Starts at:** `apps/backend/src/sending/Dispatching.test.ts:719-756, 854-883`; `fixture`/`mailerDouble` near :363-461.
- **Depends on:** none
- **Status:** Pending
- **Tests:** `Dispatching.test.ts` (unit) protects:
  - an unknown SES outcome is never resent;
  - a throttle retries with 1/2/4 s backoff and recovers.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/sending/Dispatching.test.ts`. Expect every case to pass, and 32 cases in total.
  - Remove the backoff `Effect.sleep(backoff)` locally. Expect the backoff test to fail. Revert.

#### T2 — One settlement per claimed recipient

- **Change:**
  - In `submitClaimed`, derive one `RecipientSettlement` from the result: failure → `uncertain`, accepted → `accepted`, rejected → `rejected` with its code.
  - Loop only while the code is `rate-limited` and a backoff remains.
  - Settle once. Pause with the settlement's code when it is `rate-limited` (retries used up) or `sending-paused`.
  - Return `"next" | "stop"` and delete `ClaimedSubmit`.
  - Keep `runSlice`'s three early-return guard `if`s as they are.
- **Starts at:** `apps/backend/src/sending/Dispatching.ts:231-322`
- **Depends on:** T1
- **Status:** Pending
- **Tests:** `Dispatching.test.ts` (unit), including T1's cases, protects the settle and pause behaviour, unchanged.
- **Verify:** run `pnpm exec vitest run --project unit apps/backend/src/sending`. Expect all to pass, with `Dispatching.ts` about 30 lines shorter.

#### T3 — Admission failures are storage failures at their source

- **Change:**
  - `SendGuard.current` becomes `Effect.Effect<SendAllowance, StorageFailure>`.
  - Map `GetAccount` with `unavailable("getAccount")`.
  - Map `DescribeAlarms` with `unavailable("describeAlarms")`, in an annotated `const alarmStates: Effect.Effect<AlarmStates, StorageFailure>`, because of the lint rule.
  - Delete both `Effect.orDie` calls and the "it is a defect here" comment.
  - `consumeSlot` ends in `Effect.mapError(unavailable("pacing"))`. Delete the same mapping, and the `unavailable` import, from `TestSends.ts`.
  - `outcomeOf` in `TestSends.ts:35` takes `Result.Result<SubmissionOutcome, SubmissionUncertain>`.
- **Starts at:** `apps/backend/src/sending/SendGuard.ts:35-40, 72-116`; `apps/backend/src/campaigns/TestSends.ts:33-44, 89`
- **Depends on:** none
- **Status:** Pending
- **Tests:**
  - **The `SendGuardLive` mapping is untested wiring,** like T6, protected by review only. As `SendGuard.ts` says, "tests stub the service", and the widened service type can't catch a restored `orDie`, because `never` is assignable to `StorageFailure`.
  - **The `consumeSlot` mapping is protected by typecheck:** without it, `Api.ts`'s `test` handler fails with `RateLimiterError`, an error that endpoint doesn't declare.
  - **The HTTP 503 mapping of `StorageFailure`** is already protected by `publicly` and `Api.test.ts:794, 881`.
- **Verify:** run `pnpm exec vitest run --project unit apps/backend/src/campaigns apps/backend/src/sending apps/backend/src/api`. Expect all to pass, then run `pnpm lint` and expect 0 diagnostics.
- **Risk/recovery:**
  - The dispatcher already dies on any failure (`reportedAndFatal`). The only change there is that the sanitized "storage operation failed" line is now logged.

#### T4 — Let the types carry the boundary

- **Change:**
  - `publicly` becomes `<A, E, R>(operation: Effect.Effect<A, E | StorageFailure, R>) => Effect.catchIf(operation, (failure): failure is StorageFailure => failure instanceof StorageFailure, report-and-fail-StorageUnavailable)`. This deletes the cast, its SAFETY comment and the `Public` alias.
  - `describeCause` becomes `Predicate.hasProperty(cause, "_tag") && Predicate.isString(cause._tag) ? cause._tag : Predicate.hasProperty(cause, "name") && Predicate.isString(cause.name) ? cause.name : "unknown"`. Delete `Tagged`, `Named`, both decoders and the `instanceof Error` fallback, and keep the doc comment's first two sentences.
  - `Mailer.ts`'s `rejectionCodes` becomes `const rejectionCodes: Partial<Record<sesv2.SendEmailError["_tag"], Schemas.RejectionCode>> = { … }` with the same nine entries, looked up with `rejectionCodes[error._tag]`.
- **Starts at:** `apps/backend/src/Diagnostics.ts:6-61`; `apps/backend/src/sending/Mailer.ts:41-51, 122`
- **Depends on:** none
- **Status:** Pending
- **Tests:**
  - `Diagnostics.test.ts` (15 cases, including `TypeError` and `Error`), `Api.test.ts` and `Mailer.test.ts` (unit) protect cause naming, the 503 mapping and rejection classification, unchanged.
  - A misspelled table key is caught by typecheck.
- **Verify:** run `pnpm typecheck && pnpm lint && pnpm exec vitest run --project unit apps/backend/src/Diagnostics.test.ts apps/backend/src/api apps/backend/src/sending/Mailer.test.ts`. Expect every step to exit 0.

#### T5 — Return pages in query order by key, not by position or collation

- **Change:**
  - In `readEntityPage`, build a `Map` from each hydrated item's `pk` and `flatMap` the requested keys through it. This deletes the two loops.
  - In `listMembers`, index the decoded contacts by id and emit them in the order of the queried member keys. This deletes the `localeCompare` sort and its comment.
- **Starts at:** `apps/backend/src/storage/Primitives.ts:329-349`; `apps/backend/src/storage/Membership.ts:235-247`
- **Depends on:** none
- **Status:** Pending
- **Tests:** these unit cases protect index or query order, dropping missing items rather than failing, and no positional matching:
  - `Primitives.test.ts:363` "returns a page in index order when the batch answers reversed";
  - `Primitives.test.ts:208`;
  - `Membership.test.ts:331` (a gone contact is dropped);
  - **`Membership.test.ts:266`, rewritten.** Today it pins the sort: query and batch both answer `[other, contact]` and it expects them sorted. Rewrite it so that:
    - the query answers `[contactId, otherContactId]` (real key order);
    - the batch answers `[otherContactId, contactId]`;
    - the test expects `[contactId, otherContactId]`.
  - **Don't just flip the expectation.** That would leave batch reordering untested.
- **Verify:** run `pnpm exec vitest run --project unit apps/backend/src/storage`. Expect all to pass.

#### T6 — Leave a margin between the slice deadline and the Lambda timeout

- **Change:**
  - Add `const sliceMargin = Duration.seconds(30)` in `Dispatcher.ts`.
  - Pass `now + Duration.toMillis(invocationTimeout) - Duration.toMillis(sliceMargin)` to `runSlice`, with a one-line comment: the reservation covers one attempt, and the margin covers a rate-limited retry tail.
- **Starts at:** `apps/backend/src/sending/Dispatcher.ts:15, 57-60`
- **Depends on:** none
- **Status:** Pending
- **Tests:**
  - No unit test: `Dispatcher.ts` is Lambda wiring with no unit harness, and the budget arithmetic it feeds is already covered by the `Dispatching.test.ts` overrun cases.
  - The live suite's multi-page campaigns check that slices still continue (T11).
  - No ADR change: this restores ADR-0013:32's "genuine crashes are now the only way to reach that state", apart from the extreme-contention residual ADR-0011 already accepts.
- **Verify:** run `pnpm typecheck`. Expect exit 0. The T11 integration run is expected to pass.

#### T7 — Remove the copied shapes in two stores

- **Change:**
  - **`Campaigns.ts`:**
    - build the shared run fields (`queuedAt`, `startedAt`, `progress`, `feedback`) once in `submissionOf` and delete `progressOf`;
    - move `bodyItem` to module scope and use it in `createCampaign`;
    - `checkpoint` and `pauseRun` share one values object and pick between two whole request objects.
  - **`Addresses.ts`:**
    - delete the `LocalSuppression`/`LocalAddressRecord` interfaces;
    - build `addressRecord`'s result with object ternaries and `Struct.omit(suppression, ["v"])`;
    - `addressStatus` is untouched.
  - The anti-slop lint rule forbids `...(c ? {} : {…})`, so each ternary picks between whole objects.
- **Starts at:** `apps/backend/src/storage/Campaigns.ts:127-172, 298-308, 701-787, 789-792`; `apps/backend/src/storage/Addresses.ts:54-69, 237-290`
- **Depends on:** none
- **Status:** Pending
- **Tests:** these unit cases protect the exact DynamoDB requests and the records they produce, unchanged:
  - `storage/Campaigns.test.ts:1667-1696, 1756-1805`, which pin the exact requests;
  - `storage/Addresses.test.ts:337-379`, which pins the exact record with and without optional parts;
  - `Campaigns.test.ts`.
- **Verify:** run `pnpm exec vitest run --project unit apps/backend/src/storage apps/backend/src/campaigns`. Expect all to pass, with about 80 lines fewer across the two files.

#### T8 — CLI keeps typed errors and prints readable failures

- **Change:**
  - **`Client.ts`:** `withClient = <A, E>(use: (client: EmailerClient) => Effect.Effect<A, E>)`, dropping the `{ readonly _tag: string }` widening.
  - **`Diagnostics.ts` `render`:**
    - a defect stays `Cause.pretty`;
    - a failure whose squashed value has a non-empty string `message` (checked with `Predicate.hasProperty` + `Predicate.isString`, as in T4) prints that message. `Config.ConfigError` has a message but is not an `Error`;
    - then, while the current value is an `Error`, the message of its `cause` is appended as `: <message>`, if that cause has one. A non-`Error` such as `ConfigError` adds nothing further: its message already contains its cause;
    - anything else (the contract's tagged errors, whose message is empty) keeps its `Inspectable` JSON;
    - the anti-slop `no-unknown-parameters` rule allows an `unknown` parameter only when it is named `cause`.
  - **Replay tool:** apply the same rule to `renderCause` in `ReplayFeedback.ts`, which states the same policy.
  - **`--text`/`--html` in `commands/Campaigns.ts`:**
    - drop `Flag.withSchema(Schemas.CampaignText/CampaignHtml)`;
    - `bodyOf` decodes both the file body and the rendered Markdown with `decodeBody`. Annotate the value to decode as `Effect<unknown, E>`; otherwise the `RenderedBody` union trips `exactOptionalPropertyTypes`;
    - a failure is refused with a message naming the part and the limit from the schema message (e.g. `Expected at most 65536 UTF-8 bytes at ["text"]`), never the content.
  - **`Flags.ts` `pageQuery`:** return `{ limit: Option.getOrUndefined(limit), cursor: Option.getOrUndefined(cursor) }` and delete the `PageQuery` interface.
- **Starts at:** `apps/cli/src/Client.ts:21-28`; `apps/cli/src/Diagnostics.ts:22-23`; `apps/backend/src/feedback/ReplayFeedback.ts:250-251`; `apps/cli/src/commands/Campaigns.ts:15-85`; `apps/cli/src/Flags.ts:32-49`
- **Depends on:** none
- **Status:** Pending
- **Tests:**
  - **`apps/cli/src/Diagnostics.test.ts` (unit, new cases):**
    - a schema failure prints its message and no `~effect/Schema` tree;
    - a missing config value prints the `ConfigError` message and no schema tree;
    - a transport failure prints `Transport error` and its cause's message;
    - a `NotFound` still prints its JSON fields.
  - **`ReplayFeedback.test.ts:342`:** the same rule for the replay tool.
  - **`commands/Campaigns.test.ts` (CLI harness, new case):** a `--text` file over 64 KiB exits non-zero, stderr names the 65536-byte limit, doesn't contain the file's content, and no request reaches the server.
  - **Existing `contacts list`, `lists members` and `campaigns list` CLI tests** protect paging, with and without `--limit`.
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/cli apps/backend/src/feedback`. Expect all to pass.
  - Run `EMAILER_API_URL=http://127.0.0.1:59999 EMAILER_API_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa node apps/cli/src/main.ts contacts get 00000000-0000-4000-8000-000000000000`. Expect one stderr line starting `emailer: Transport error` and ending in `ECONNREFUSED 127.0.0.1:59999`, and exit 1.
  - Run it again with `EMAILER_API_URL` unset. Expect stderr to name `EMAILER_API_URL`, contain no `~effect/Schema`, and not repeat the message. The schema message itself spans two lines.

#### T9 — A correct plain-text part for Markdown campaigns

- **Change:**
  - **Headings:** `heading` stops uppercasing, so the text keeps its own case and a link's URL keeps its case.
  - **Lists:** `list` renders each item block by block:
    - checkbox tokens are dropped, and the box is taken from `item.task`/`item.checked` (`[x] `/`[ ] `);
    - the remaining blocks are rendered one at a time and trimmed, and the empty ones dropped;
    - they are joined with `\n`, and continuation lines are indented by the marker's width plus one.
  - **Raw HTML:** `html({ text, block })` strips tags, decodes the basic entities and trims. A block gets `\n\n`.
  - **Entities:** `text` always decodes the basic entities (`&amp; &lt; &gt; &quot; &#39;`), not only escaped tokens. Update the comment on `unescapeHtml`.
  - **Docs:**
    - Rewrite ADR-0019's plain-text bullet (":27") in place: headings keep their text, raw HTML is reduced to its text, and task items render as `[x]`/`[ ]`.
    - Add a header line in the repo's format: `- Amended: [review-fixes](work/review-fixes.md) — …`.
    - Amend `wiki/email/html-email.md:23` the same way.
- **Starts at:** `apps/cli/src/Markdown.ts:135-220`
- **Depends on:** none
- **Status:** Pending
- **Tests:** `apps/cli/src/Markdown.test.ts` (unit) and `commands/Campaigns.test.ts:522` (CLI) protect the text part's structure and fidelity.
  - Update the four pinned cases:
    - `["# Title", "Title"]`;
    - `["A \\*literal\\* & <raw>", "A *literal* &"]`;
    - `Campaigns.test.ts:522` expects `"Hello\n\nSome bold words…"`;
    - `Campaigns.test.ts:648` expects `"Fresh"`.
  - Add cases:
    - `"- a\n  - b\n  - c\n- d"` → `"- a\n  - b\n  - c\n- d"`;
    - `"1. one\n   continued\n2. two"` → `"1. one\n   continued\n2. two"`;
    - `"- [x] done\n- [ ] todo"` → `"- [x] done\n- [ ] todo"`;
    - `"## See [the Docs](https://example.com/Docs/Page?Ref=A)"` → `"See the Docs (https://example.com/Docs/Page?Ref=A)"`;
    - `'<div align="center"><img src="https://x/y.png"></div>\n\nafter'` → `"after"`;
    - `"Tom &amp; Jerry, a &lt; b"` → `"Tom & Jerry, a < b"`.
- **Verify:** run `pnpm exec vitest run --project unit apps/cli`. Expect all to pass.

#### T10 — Documentation drift

- **Change:**
  - **`wiki/effect/retries-and-concurrency.md:38`:** delete the last sentence ("The same rule applies to DynamoDB conditional writes … (`Retry.none`) …").
  - **`wiki/aws/sns-and-feedback.md:78`:** say that the project treats `OnAccountSuppressionList` and `Suppressed` as echoes. `OnTenantSuppressionList` and `EmailValidationSuppressed` need SES tenants or auto-validation, which this project doesn't use, and a validation failure is a list-quality signal the breaker should count.
  - **ADR-0012:21 (clerical):** the echo definition names the account list or SES's global list (`Suppressed`), matching `FeedbackClassification.ts:68`.
  - **README.md:234:** "A page's `nextCursor` is absent when there is nothing more; a full last page may still carry one that leads to an empty page."
  - **`vitest.config.ts:29`:** the comment says the case disables the dispatcher's event-source mapping.
  - **Broken paths:**
    - ADR-0003:34 → `feedback/Feedback.ts`, `feedback/ReplayFeedback.ts`;
    - ADR-0012:18 → `apps/backend/src/sending/Reputation.ts`;
    - ADR-0018:75 → `apps/backend/src/identity/SendingDns.test.ts`.
  - **Supersede links (clerical lifecycle links, in both directions; cite bullets by content, not by line number):**
    - ADR-0015 header: "Superseded in part: ADR-0016 (schedules named by run token; cancel keeps the token; generation-specific delete)".
    - ADR-0016:7: "Would supersede in part" → "Supersedes in part".
    - ADR-0016 header: "Superseded in part: ADR-0020 (one `CampaignStateConflict` for every wrong-state operation)". Add ADR-0016 to ADR-0020's "Supersedes in part" list for that rule.
    - ADR-0013 header: "Superseded in part: ADR-0016 (enqueue and resume no longer accept an already queued campaign; lifecycle commands are single-item transactions with a request token)".
- **Starts at:** the files and lines named above
- **Depends on:** none
- **Status:** Pending
- **Tests:** documentation only.
- **Verify:**
  - Run `grep -n "Retry.none" wiki/effect/retries-and-concurrency.md`. Expect no conditional-write mention.
  - Run `pnpm format:check`. Expect exit 0.
  - Every edited relative link resolves (`test -f` on each target).

#### T11 — Live gate

- **Change:**
  - Run `pnpm check`.
  - Deploy `--stage test` with `.env.test`.
  - Point the seven stage-specific `.env.test` values at the new stage: API URL, unsubscribe URL, unsubscribe secret, table name, dispatch-failures queue URL, dispatcher function name, and the set-bounce alarm name.
  - Run `pnpm test:integration`.
  - Destroy the stage and check the account inventory.
  - If `sender-name` merged into `main` first, merge `main` in beforehand, so this gate runs on the merged code.
- **Starts at:** README "Develop and test"
- **Depends on:** T1–T10
- **Status:** Pending
- **Tests:** the full live suite (all 5 integration files, including `CampaignCancellation.integration.test.ts`) protects the deployed behaviour end to end.
- **Verify:**
  - `pnpm check` exits 0.
  - `pnpm test:integration` passes every case.
  - `alchemy destroy` finishes, and nothing is left for the stage.
- **Risk/recovery:**
  - A stale alarm name gives one false `ResourceNotFound`: re-point it and re-run.
  - An expired SSO profile: export CLI credentials, following README and project memory.

#### T12 — Close ADR-0016's live confirmation

- **Change:**
  - **ADR-0016:** add "Confirmed: <date>. `CampaignCancellation.integration.test.ts` passed in ADR-0020's recorded run on stage `test` (5 files, 40 cases) and in this plan's live gate (T11)".
  - Drop "Live confirmation remains the plan's T6 gate" from its Authority line.
  - **`.adr/work/queued-campaign-cancellation.md`:** status becomes Complete. T6 is closed on that evidence, by the user's decision of 2026-09-23.
  - Record T11's results in this document's Evidence fields.
- **Starts at:** `.adr/0016-cancelling-pending-campaign-runs.md:1-8`; `.adr/work/queued-campaign-cancellation.md:1-5`
- **Depends on:** T11
- **Status:** Pending
- **Tests:** documentation only; the evidence is T11's run.
- **Verify:**
  - The ADR header shows Status Accepted with a Confirmed line.
  - The work doc status is Complete.
  - `pnpm format:check` exits 0.

#### T13 — Delivery

- **Change:**
  - Run the leak check against `~/.config/emailer/leak-pattern.txt` over files, patches and commit messages, always case-insensitive (`grep -i`).
  - Separately, scan the diff for personal or company details the pattern doesn't cover: the owner's first name as a fixture persona, and brand, vendor or infrastructure names. Neutral placeholders only (user rule, 2026-09-24).
  - Push `review-fixes` and open a PR against `main`, grepping the PR body too.
- **Starts at:** project memory "Public repo leak check"
- **Depends on:** T12
- **Status:** Pending
- **Tests:** none; this is release hygiene.
- **Verify:**
  - The file check prints nothing, and the patch and message check prints `0`.
  - The PR is open. The repository has no CI, so T11's local `pnpm check` and live gate are the gates.

## Final acceptance

- **Checks:**
  - `pnpm check` is green at every commit.
  - Unit tests: 874 − 1 (deleted) + 2 (T1) + the new CLI, Diagnostics and Markdown cases, all passing.
  - The full integration suite passes on an ephemeral stage, which is then destroyed.
  - The leak check is clean.
- **End state:**
  - Every review finding is closed.
  - About 140 fewer production lines, with the Markdown and CLI fixes adding about 20.
  - Typed errors from AWS reads to the CLI.
  - The wiki and ADRs agree with the code.
- **Deferrals or blockers:**
  - API unknown-field rejection and oxlint 1.85 stay blocked upstream.
  - Prod deploy (`--force` + `CodeSha256`) only on the user's go.

## Handoff

- **Next action:** create the worktree and branch `review-fixes` from `main`, commit this document, and start T1.
- **Reviews:** [review-fixes-review.md](review-fixes-review.md). Independent plan review, round 1: Changes required. All seven findings were accepted and applied:
  - R1: T5 rewrites the member-order fixture.
  - R2: the T8 render rule covers `ConfigError`, and the Verify step uses a refused port.
  - R3: T3's Live mapping is marked as untested wiring.
  - R4: T9 has a fourth pinned case and an `Amended:` line.
  - R5: T10 adds ADR-0020's link, fixes ADR-0018's path and cites bullets by content.
  - R6: the live gate, the confirmation and delivery are reordered as T11–T13.
  - R7: T1 drops a redundant case.

  Round 2: Changes required. All three findings were accepted and applied:
  - N1: T8's rule and Verify are reworded, so the message is not printed twice and the check allows two lines.
  - N2: T3's Live mapping is protected by review only.
  - N3: T13 states that there is no CI.

  Round 3: Clear.
- **Complexity gate:** built-in; each task was challenged for a smaller alternative. Rejected simplifications and additions are listed under Out of scope.
