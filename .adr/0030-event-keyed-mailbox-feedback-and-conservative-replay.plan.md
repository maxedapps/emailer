# Plan: Code review 241 fixes

- Status: In progress
- Decision: [ADR-0030](0030-event-keyed-mailbox-feedback-and-conservative-replay.md) (F4, F6). The other findings need no new design decision. Their records are amendments to ADR-0011 (F2, F3) and ADR-0022 (F1).
- Source: code review of `main` @ `dea4c24`, 2026-10-03 (task 241). The user asked for every finding and every cleanup it names.

## Goal

**Done when:**

- **F1:** the API rejects undeclared payload and query fields with `400` on Effect 4.0.0 stable and Alchemy beta.80.
- **F2:** a known `SendingEnabled: false` refuses before anything is claimed.
- **F3:** a throttled retry never runs past the invocation deadline.
- **F4:** every transient bounce reaches the mailbox's window.
- **F5:** the storage double fails on calls it was not scripted for.
- **F6:** the replay rule is recorded.
- **Ceiling:** `EMAILER_DAILY_SEND_CEILING` refuses `0` and negative values.
- **Checks:** `pnpm check` and `pnpm test:integration` pass, and a manual walk on an ephemeral `--stage test` passes. Both stages are destroyed.

**Out of scope:**

- the review's dropped items: full-list pagination past 1 MB, a distributed `GetAccount` limiter, and splitting `storage/Campaigns.ts`;
- the "keep" list and the accepted ADR trade-offs;
- the oxlint upgrade, which is a separate open item and not part of this review;
- a prod deploy.

## Rules for every task

- Worktree `~/worktrees/emailer/review-241-fixes`, branch `review-241-fixes`. One commit per task, with `pnpm check` green.
- Every test change follows the existing suites' style: behaviour first, condition pins kept.

## Tasks

### T1 — Effect 4.0.0 stable, Alchemy beta.80 (F1 prerequisite)

**Versions.** Catalog bumps:

- `effect`, `@effect/platform-node` and `@effect/vitest` to 4.0.0;
- `alchemy` to 2.0.0-beta.80;
- `@distilled.cloud/aws` to 1.0.0-rc.13;
- `@effect/tsgo` to 0.48.0;
- the `packageExtensions` key to beta.80;
- `allowBuilds` to the new `workerd` version.

**Overrides removed.** Evidence:

- Alchemy beta.80 declares `effect: ^4.0.0` and the distilled packages declare `effect: ^4.0.0`.
- Without overrides, the lockfile holds exactly one `effect@4.0.0`, and every `@effect/*` package is at 4.0.0 with an `effect@4.0.0` peer.
- `strictPeerDependencies` fails an install that would split them.
- The review said to keep the overrides "until dependency resolution shows a single copy". It now does.

**Imports.** Move `effect/unstable/{http,httpapi,persistence,cli,process}` to `effect/{http,http-api,persistence,cli,process}`. Also:

- `Encoding` becomes `effect/encoding` (`Base64`, `Base64Url`, `Hex`);
- `Schema.isStartsWith` becomes `Schema.isStartingWith`.

**tsgo 0.48 lint fallout.**

- **The new `effecttsgo/unstable-api-usage` warning (440 hits)** is turned off in `oxlint.config.ts`, with a reason. Effect 4.0 marks its HTTP, HTTP API, CLI, persistence and process modules unstable, and the API, CLI and pacing are built on them.
- **Eight `oxlint-disable` directives are deleted**, because they now report as unused:
  - seven for `effecttsgo/node-builtin-import`;
  - one for `no-unsafe-assignment` in `stacks/providers.ts`.

**`stacks/providers.ts` deleted.**

- In beta.80, `AWS.providers()` is fully typed: its requirements are concrete services, not `any`. The file existed only to hide that `any`.
- `alchemy.run.ts`, `stacks/sending-identity.ts` and `Live.integration.test.ts` call `AWS.providers()` directly.

**Shims rechecked against beta.80**, with an outcome for each:

- The `AWSEnvironment` line in `alchemy.run.ts` stays, because alchemy#1842 is still open. Its comment's version becomes beta.80.
- The `toQueue` cycle comment in `Feedback.ts` stays. `EventBridge/ToQueue.js` is byte-identical to beta.79. Its version becomes beta.80.
- The README's "code-only change plans as `noop`" note stays. `Lambda/Function.js` is byte-identical. Its version becomes beta.80.
- The `capnp-es` `packageExtensions` entry stays: `cloudflare-runtime` beta.80 still pulls in `capnp-es@0.0.16`, which peers on TypeScript ≤6.
- README line 44 states the new versions. The ADR-0011 reference to `effect/unstable/persistence` gets an amendment note.

**pnpm release-age policy.**

- pnpm 12 refuses packages younger than 24 hours: beta.80, rc.13 and tsgo 0.48.0, the last published 2026-10-02 15:02 UTC.
- While working, the worktree carries pnpm's generated `minimumReleaseAgeExclude` list. That list is **not committed**.
- Before landing, after 15:03 UTC, the list is dropped and `pnpm install --frozen-lockfile` must pass with the default policy.

**Verify:** `pnpm check` green (done in exploration: 849 tests pass); `pnpm why effect` shows a single copy.

### T2 — Strict HTTP contract (F1)

- **The annotation.** `EmailerApi` gets `.annotate(HttpApi.ParseOptions, { onExcessProperty: "error" })`, once.
  - Effect 4.0.0's `SchemaAST` checks only enumerable excess keys, which is the effect#8423 fix, and `HttpApiBuilder` reads the slot.
  - No header schema exists, so `HeadersParseOptions` is not needed.
- **The test fake.** The CLI fake service's `campaigns.list` answers full campaigns where the contract says summaries. Strict encoding rejects that, and it is the one failure the probe found. The fake will map to `CampaignSummary`, as the real store does.
- **Tests (`Api.test.ts`):**
  - an unknown payload field (`naem` on contact create) answers `400`;
  - an unknown query parameter on a listing answers `400`;
  - a declared `TaggedError` keeps its status, e.g. `404 ContactNotFound`, not `500`;
  - every existing round trip and client test passes.
- **Docs:**
  - ADR-0022: status Confirmed, a dated note that the annotation landed, and Consequences updated;
  - README: the "unknown fields are ignored for now" sentence becomes "answer **400**".
- **Manual (on the stage):** `curl` a contact create with an extra field (`400`), a missing contact (`404`), and `addresses status` (its `accountSuppression` is mapped field by field, but it is proven against real SES anyway).

### T3 — `SendingEnabled: false` refuses (F2)

- `sendGuard`: refusals rank `reputation`, then `sending-paused` when `account.SendingEnabled === false`, then `daily-quota`.
- `SendingPaused.reason` in `packages/api/src/Errors.ts` widens to `["reputation", "sending-paused", "daily-quota"]`. The CLI prints the reason from the schema, so no CLI change is needed.
- **Tests:**
  - `SendGuard.test.ts`: the review's probe input refuses with `sending-paused`, and reputation outranks it;
  - `Dispatching.test.ts`: the guard refusal pauses with `sending-paused`, with zero claims and zero sends;
  - `TestSends.test.ts`: the refusal answers `SendingPaused { reason: "sending-paused" }`.
- **Docs:**
  - README test-send line: "a reputation halt, a paused SES account or the daily budget";
  - ADR-0011: an amended line.

### T4 — Throttled retries bounded by the deadline (F3)

- **The deadline reaches the retry.** `submitClaimed` takes the slice's `deadline`.
- **Each retry checks before it sends.** After its backoff, a retry reserves its slot and checks that slot wait + submission + settle + pause fit before the deadline. This is the same `reservationFor` check the first attempt makes; `remainingUntil` becomes a shared `fits(deadline, delay)`.
- **A retry that won't fit stops retrying.** It fails with a local `RetryOutOfTime`, which the backoff's `while` (`SendThrottled` only) does not retry. That outcome is caught as `failureOutcomes.SendThrottled`, so the row settles as the existing `rejected / rate-limited` and the run pauses.
  - No timeout wraps the claimed workflow.
  - Uncertain submissions are still never retried.
- **Comments.** The Dispatcher's `sliceMargin` comment changes from "covers a rate-limited retry tail" to: it covers the claim before an attempt, and the checkpoint and wake-up an overrun still writes.
- **Test (`Dispatching.test.ts`):** this is the review's probe. With delays `[0, 400 s]` and `SendThrottled` first:
  - there is one send and no second;
  - the row is `rejected / rate-limited` and the run pauses at memberA;
  - the settlement lands before the deadline.

  The existing backoff tests still pass.
- **Docs:** an ADR-0011 amended line.

### T5 — Event-keyed transient window outside the campaign transaction (F4, ADR-0030)

**Decoding.** `FeedbackClassification.EmailEvent` decodes `bounce.timestamp` with `Schema.DateTimeUtcFromString`, on the bounce only. The fixtures gain realistic SES timestamps.

**The decision table.** `Decision.write` (`count | transient | history`) is replaced by:

- `mailbox: "suppress" | "transient" | "none"`, what the event does to the mailbox for any mail;
- `counter?: "bounced" | "complained"`, what a tagged event adds to its campaign.

`suppress: boolean` folds into `mailbox`, and `outcome` stays.

**Storage.**

- `Addresses.ts`: `suppressionWrites` becomes `mailboxFeedbackWrites`, with `suppressAddress` plus `addTransientBounce({ email, occurredAt, feedbackId })`. The latter is one `UpdateItem`: `SET` stamp, `ADD transientBounces :entry`.
- `storage/Feedback.ts`: `recordFeedback(row, counter)` writes the history row plus the counter when one is given. `FeedbackWrite`, `addTransientBounce` and the transient branch go.

**The handler.** `Feedback.record` writes:

- the suppression or transient entry per recipient, first;
- then, only for tagged mail, the campaign attribution.

The untagged log line no longer says "(a test send)", because confirmations are untagged too.

**The occurrence docs.** The `occurredSince` comment names `<bounce timestamp>#<feedbackId>`.

**`IntegrationSupport.ts`** follows the renames.

**Tests:**

- `Feedback.test.ts`:
  - a tagged transient bounce adds the entry and a history row with no counter;
  - an untagged transient bounce adds the entry and no campaign write;
  - a duplicate event, replayed after the clock has moved on, yields the same entry string, so the set is unchanged;
  - an untagged permanent bounce still suppresses.
- `storage/Feedback.test.ts` and `Addresses.test.ts`: the request shapes of the new writes.

**Docs:**

- ADR-0012: an amended-by line;
- ADR-0003: line 35 ("a redriven event that already landed is a no-op") and line 48 ("a redelivered event writes nothing new") are qualified by the replay rule;
- README: the test-send line ("a test bounce or complaint suppresses the address but never counts against the campaign") gains that soft bounces count toward `bouncing` on every path.

### T6 — Replay rule recorded (F6, ADR-0030)

- **README, Operate:**
  - "A redriven event that already landed changes nothing" becomes: a redriven event never counts twice, but it suppresses again, or re-adds a window entry, if the address was cleared in the meantime;
  - plus the rule: redrive before you clear a suppression, with the two queue checks (`aws sqs get-queue-attributes … ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible`);
  - the checks drain known pending work only, so late feedback (eventually consistent counts, EventBridge's 24-hour retries, SQS redelivery) can still re-suppress after a clear (review R1).
- **README `addresses unsuppress` bullet:** the rule, in one sentence.
- **CLI:** the `addresses unsuppress` description carries the rule, because operators read `--help`.
- No code change.

### T7 — Strict scripted storage double (F5)

**The double (`storage/Testing.ts`).**

- A scripted operation answers its replies in call order.
- A call past the end of the script, or to an operation with no script, dies: `Unexpected <operation> call #<n>: the test scripted <k>`.
- There is no implicit fallback.
- A test that expects success scripts it explicitly, with a shared `succeeds` reply (`Effect.succeed({})`), repeated with `Array.replicate` where a loop writes many times.
- `unusedAudience` and `unusedCampaigns` stay as they are.

**Probe result, kept as evidence.** Strict mode fails 93 tests:

- 85 relied on the implicit success for an unscripted operation;
- 11 call sites ran past a script, and every one is an intentional retry after a scripted failure, such as a lost race or a raced import.

None hides an extra write. Each test now states its calls.

**Pruning, only exact repeats of a writer's full serialization already pinned by its first test.** Each shrinks to the delta its title promises:

- `newRun`: `Campaigns.test.ts` ~1196–1211 shrinks to the token condition and values, plus `REMOVE pausedReason`.
- `cancelCampaign`: ~1297–1310 shrinks to the `attribute_not_exists(startedAt)` condition and `:queued`.
- `updateContact`:
  - `Contacts.test.ts` ~313 shrinks to the `attributes` map;
  - ~327 shrinks to "no `attributes`";
  - ~416 shrinks to "no `name`";
  - ~436 shrinks to one action and the new `email`.
- `checkpoint`: ~1629–1635 shrinks to `:previous` and `:next`. The condition pin stays.
- `recordFeedback`: rewritten anyway in T5. Only the first pin stays in full.

Condition pins, action and reason ordering, retry exhaustion, corrupt-data and `UnprocessedKeys` tests stay. The partial repeats inside ordered transaction lists (`Contacts` ~466, `Subscriptions` ~332) stay, because each index there is a reason-ordering pin.

### T8 — Daily ceiling must be positive (minor)

- `SendGuard.ts`: `Config.option(Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), "EMAILER_DAILY_SEND_CEILING"))`.
  - A probe showed that absent is `None`, `"5"` is `Some(5)`, and `"0"`, `"-3"` and `"abc"` fail. They do not fall back to `None`.
  - Alchemy pins init-time config reads, so a bad value fails the deploy's plan.
- **Test (`SendGuard.test.ts`):** building the `make` config read against `ConfigProvider.fromEnvRecord` for absent, `"0"` and `"5"`. The read is exported as a named `Config` so that it can be tested without the AWS bindings.

### T9 — Verify, review, land

- `pnpm check`.
- `pnpm test:integration` (it deploys and destroys its own stage). Credentials and `AWS_REGION` are exported first.
- An ephemeral `--stage test` deploy for the manual walk:
  - T2's curls;
  - one campaign to simulator addresses (`success`, `bounce`), with the bounce suppressed through the new feedback path;
  - `addresses status` on the bounced address;
  - the transient path, which the simulator cannot produce (review R2): one realistic untagged `Transient` EventBridge envelope with the stage's configuration-set tag and a neutral `example.com` recipient, sent to `FeedbackEvents` twice. `addresses status` shows one canonical `<bounce timestamp>#<feedbackId>` entry and no campaign attribution. The evidence labels it as injected;
  - `alchemy destroy --stage test`, verified against the account inventory.
- The leak-pattern grep over files, patches and messages.
- Merge to `main`, push, and remove the worktree and branch.

## Evidence for the user

Nothing visible changed, so the evidence is key files and snippets from the landed commit:

- the `ParseOptions` line plus a `400` test;
- the guard's refusal order;
- the retry deadline check;
- the event-keyed transient write;
- the strict double's die message.

Plus the stage's curl transcript, with the account and URLs redacted.

## Open questions

None. F6 was decided by the user.

## As built

- **T5:** the decision table keeps `suppress` and gains `counter` (`FeedbackCounter | undefined`). It does not get a `mailbox` enum. `Classified.transientAt`, the canonical bounce time, is set only for a transient bounce, and the handler adds the window entry when that field is present. Only bounces carry the timestamp, so an enum would also have needed a separately optional field.
- **T7:** strict mode failed 92 tests:
  - 84 relied on the implicit success for calls they make by design;
  - 8 were intentional retries after a scripted failure.

  None hid an extra write. The scripts come from a measured per-test call log, in call order. These pins shrank:
  - `newRun`'s re-queue;
  - `cancelCampaign`'s queued cancel;
  - `checkpoint`'s later-page value map.

  These were kept: `updateContact`'s `rewritten(...)` and `recordFeedback`'s `historyPut(...)` one-liners. Each already states only its delta through a helper, and shrinking it would only weaken it.
- **T8:** `dailySendCeiling` is exported, so its test reads it without the AWS bindings.

## Review

Plan review (Codex, round 1):

- **R1 (fix):** the ADR promised that the redrive rule prevents re-suppression. AWS documents eventually consistent queue counts, 24-hour EventBridge retries and SQS redelivery, so the wording now says the rule drains known pending work only. ADR-0003 line 35 is also qualified.
- **R2 (fix):** no planned check reached the deployed transient branch. The stage walk injects one untagged transient envelope twice, and the local duplicate test replays after the clock has moved.

Code review (Codex, round 2): no bug, security or simplification findings. It accepted the three departures above.

- **R3 (fix, nit):** the replay wording said that old feedback "suppresses again". A transient bounce restores only the window, and an ignored complaint does neither, so the README and the CLI help now say "can restore the suppression or the transient-bounce window".
