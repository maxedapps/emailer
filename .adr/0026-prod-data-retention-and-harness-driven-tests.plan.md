# Plan: Keep prod's data on destroy, and test through the libraries' harnesses

- Status: In progress
- Decision: [ADR-0026](0026-prod-data-retention-and-harness-driven-tests.md)

## Goal

**Done when:**

- destroying stage `prod` keeps its table, and every other stage deletes it;
- prod configuration lives in `.env.prod`, and nothing reads an implicit `.env`;
- `pnpm test:integration` deploys its own stage through Alchemy's `Test.make`, runs every live suite from one entry file, and destroys the stage;
- the CLI command tests run in-process through Effect's CLI testing tools, with about six real-process tests left;
- every test can fail on the bug its name describes: the review's false greens are fixed, its low-value tests are gone, and the pacing wait, the submission timeout, the breaker's ratios and a sendAt of exactly now each have a test;
- the review's cleanups and style points are in;
- the live gate passes, and prod runs the result.

**Out of scope, deliberately unchanged:**

- the API contract, the storage layout and every runtime behaviour;
- ADR-accepted trade-offs the review questioned:
  - a throttled recipient stays `rejected` (ADR-0011);
  - the record version stamp (ADR-0024);
  - commands answer an unchanged campaign in other states (ADR-0011);
- the per-call `Config` reads of the public pages, and the other workarounds the review confirmed are still needed in beta.79:
  - the named feedback queue and rule;
  - `--force` for code-only deploys;
  - uncompressed AWS replies;
  - the typed `DescribeAlarms` error;
  - the raw `getEmailIdentity` lookup;
- a keep-the-stage option for live runs.

## Rules for every task

- One commit per task, with `pnpm check` green.
- **Cost:** the task states its running-cost effect. A task that would raise cost does not ship.
- **Test deletions:** the commit body lists every test the task deletes or merges, with a one-line reason each:
  - duplicate of a named test;
  - tests Effect or a library;
  - asserts the double's own logic;
  - cannot fail.
- **Test additions:** every test a task adds or fixes is shown to fail against the broken behaviour it names, once, in a scratch copy. The commit body names the break.

## Tasks

### T1 — Retain the prod table

Status: Done. As built: a removal-policy change is not a plan diff in beta.79. `alchemy plan --stage prod` lists `EmailerData` as `noop`, and the apply of a `noop` row writes the new policy to state (`Apply.ts:702–745`), so T16 checks state rather than the plan.

- **Where:** `dataTable` in `apps/backend/src/storage/Table.ts`.
- **Change:** `.pipe(RemovalPolicy.retain(Effect.map(Stack, ({ stage }) => stage === "prod")))`.
- **README "Deploy the service":** destroying `prod` keeps its table as an untracked resource. A redeploy creates a new, empty table. Recovery is manual, and the signing keys still rotate.

**Verify:**

- `pnpm check`;
- T15's functions start: the retain rule reads `Stack` wherever the table is yielded, including every cold start;
- T15 destroys its test stage and no table remains;
- T16 finds `removalPolicy: retain` for the table in prod's state.

**Cost:** none, unless prod is destroyed; then the retained table's storage.

### T2 — Prod configuration in `.env.prod`

Status: Done. As built: the README's "Configure" section also says why no plain `.env` may stay in the repository root.

- **Where:**
  - `package.json`: `emailer` loads `--env-file-if-exists=.env.prod`;
  - README: "Configure", "Use", and every `--env-file .env` becomes `.env.prod`;
  - the header of `.env.example`.
- **Operator step, stated in the commit body:** rename the local `.env` to `.env.prod`.

**Verify:**

- `pnpm check`;
- `pnpm emailer campaigns list --limit 1` answers from prod with the renamed file;
- no script or documented command reads a bare `.env` any more: `grep -n -E '\.env([^.a-z]|$)' README.md package.json` finds only prose that names the old file.

**Cost:** none.

### T3 — One typed `AWS.providers()`

Status: Not started

- **Where:** `alchemy.run.ts:22` (a lint-disable comment) and `stacks/sending-identity.ts:34–39` (a typed const).
- **Change:** the typed `awsProviders` moves into one small module under `stacks/`. Both stacks import it, and so does T13's test entry. The lint-disable comment goes.

**Verify:**

- `pnpm check`;
- `pnpm exec alchemy plan --config alchemy.run.ts --stage prod --env-file .env.prod` plans every resource `noop`.

**Cost:** none.

### T4 — Drop the log-group ordering env var

Status: Not started

- **Where:** `lambdaBasics` in `apps/backend/src/Lambda.ts`, and `EMAILER_LOG_GROUP` in the props of the Api, Dispatcher, Feedback, Unsubscribe and Preview functions.
- **Change:**
  - `lambdaBasics` still declares `<id>Logs` with 7-day retention, but no longer returns its name;
  - the five functions drop the env entry;
  - the doc comment loses the ordering paragraph.
- **Why it is safe in beta.79:**
  - the `LogGroup` provider creates the group, or silently adopts one Lambda created, and then applies the retention;
  - its delete tolerates a missing group;
  - the function reaps its own group on delete.

**Verify:**

- `pnpm check`;
- T15 finds all five log groups at 7 days during the run, and none after the destroy.

**Cost:** none.

### T5 — Queue-backlog alarm helper

Status: Not started

- **Where:**
  - the `FeedbackFailuresVisible` and `DispatchFailuresVisible` alarms in `alchemy.run.ts`;
  - the four alarms in `apps/backend/src/sending/Reputation.ts`.
- **Change:**
  - a `queueBacklogAlarm(id, description, queue)` helper beside `alertsTopic`;
  - `dispatchFailuresAlarm` is declared in `sending/Dispatch.ts` and `feedbackFailuresAlarm` in `feedback/Feedback.ts`;
  - the stack only yields them;
  - the four reputation alarms share one builder for their common props;
  - logical IDs and every alarm prop stay the same.

**Verify:**

- `pnpm check`;
- `alchemy plan --stage prod` plans no alarm change; the only changes are T4's function env.

**Cost:** none.

### T6 — Effect idioms

Status: Not started

- **Helpers that only return an `Effect.gen` become `Effect.fnUntraced`:**
  - `updateIf`, `readItems`, `readEntityPage` and `transact` in `storage/Primitives.ts`;
  - `fixedWindow` in `storage/RateLimit.ts`.

  Their `.pipe` tails move into `fn`'s extra arguments. `transact`'s conditional return type must still compile.
- **The same helpers become `Effect.fn` with a span:**
  - `record` in `feedback/Feedback.ts` (`Feedback.record`);
  - `emailerClient` and `withClient` in `apps/cli/src/Client.ts`;
  - `openInBrowser` in `apps/cli/src/Terminal.ts`.
- **`DateTime` instead of `Date.parse`:**
  - `campaigns/Campaigns.ts:191` checks with `DateTime.isFuture`;
  - `storage/Addresses.ts:75` parses with `DateTime.make`.
- **Sender address:** `sending/Message.ts` reads `EMAILER_FROM_EMAIL` with `Config.schema(Schemas.EmailAddress, …)`, and `decodeAddress` goes.
- **`storage/Items.ts`:** `present` becomes `Record.filter(…, Predicate.isNotUndefined)`, as in `storage/Addresses.ts`.

**Verify:** `pnpm check`. The existing suites cover all of these unchanged.

**Cost:** none.

### T7 — Layer naming

Status: Not started

- **Service classes gain `static readonly layer`, and their `…Live` constants go:**
  - `AudienceStore`, `CampaignStore`, `CampaignReader`, `UnsubscribeStore`, `FeedbackStore`;
  - `CampaignSchedule`, `CampaignWake`, `Mailer`, `SendGuard`, `AccountSuppression`.
- **Plain layers are renamed to `…Layer`:**
  - `ReportingLive`, `FunctionServicesLive`, `RateLimitStoreLive`;
  - `AwsRetryLive`, `UncompressedRepliesLive`;
  - `ApiLive`, `DispatcherLive`, `FeedbackLive`.

**Verify:** `pnpm check`.

**Cost:** none.

### T8 — `contacts create --attr`

Status: Not started

- **Where:** `contactsCreate` in `apps/cli/src/commands/Contacts.ts`.
- **Change:** the repeatable `--attr` flag from `contacts update`, with the same schema.
- **README:** the command table.

**Verify:** a test beside the existing `contacts update` one, on the current process harness, shows that two `--attr` pairs reach the create payload as one map. T12 moves it in-process.

**Cost:** none.

### T9 — Storage tests

Status: Not started

**Where:** `apps/backend/src/storage/*.test.ts`.

**Fix:**

- `Items.test.ts`, the "no version at all" row: remove `v` from the item. The row currently sets `v: undefined`, a malformed attribute.
- `Membership.test.ts`, "stays inside the transaction action limit at a full batch": use `Schemas.maxImportEntries`, and assert at most 100 actions.
- Every test that asserts only `transactionRequests[0]`, or only one update request, also asserts how many requests went out. Two `transact` calls in `recordFeedback` or `settleRecipient` must fail a test.

**Delete or merge the named items, and any other test that meets a deletion reason from the rules.** The named items are candidates from the review: confirm each against the deletion reasons before removing it.

- **Codec duplicates:** in `Contacts.test.ts`,
  - "stores bounded attributes as a map…";
  - "decodes a stored attribute map…";
  - "treats a record that no longer satisfies the contract as corrupt";
  - "…unknown schema version as corrupt".

  Also "ignores the key and index attributes…" in `Items.test.ts`.
- **Membership:**
  - "joins again without failing…";
  - "stays harmless when the contact was never a member";
  - "completes on a repeat after an interrupted cascade…";
  - "re-running an identical import…";
  - "keeps the original join time when a member is imported again";
  - both "does not turn a lost transaction response into a business answer";
  - merge "removes both directions for every member" into the paging-bound test.
- **Campaigns:**
  - "stores html beside text…";
  - "projects html from a stored body…";
  - "projects a stored filter into the campaign";
  - "writes filter as a string map on the META put";
  - the "schedules a tokenless draft…" and "starts a run from a draft that still holds a retired token…" variants of `newRun`;
  - "omits the cursor when the meta has none";
  - merge "projects a stored filter from META into the run" into the run-delta test;
  - "keeps an unknown transaction outcome unavailable";
  - two of the three rows of the unavailable table.
- **Primitives:**
  - "drops a key the response omits…";
  - "never asks the index for a consistent read" (the second one);
  - "leaves a TransactionConflictException to the client's retry policy";
  - merge the `it.live` "re-keys unprocessed keys…" into "keeps retrying the pending keys…", which asserts the retried `RequestItems` whole.
- **Transport:** the two lifecycle-Update copies of the transact token tests.
- **Addresses:** one of the two "still reports a provider that is unavailable".
- **Also:**
  - the reserved-name `afterEach` sweep in `Campaigns.test.ts`;
  - the stub-only rate-limiter test.

**Add:** one `transact` server-error case in `Primitives.test.ts`, which replaces the copies deleted above.

**Keep:**

- the `transact`, `readItems` and cursor suites;
- the uncompressed-reply regression;
- the condition-failure table;
- `updateContact`;
- the cascades and the import races;
- the transient window boundaries;
- `__proto__` handling;
- the dying stubs in `Testing.ts`.

**Verify:** `pnpm check`. Each fixed test fails against its break.

**Cost:** none.

### T10 — Backend domain tests

Status: Not started

**Where:** `apps/backend/src/{api,audience,campaigns,consent,feedback,identity,sending}/*.test.ts`, `Reporting.test.ts` and `SignedToken.test.ts`.

**Add** (each fails against its break):

- **Pacing:** in `TestSends.test.ts` and `Dispatching.test.ts`, the slot answers 500 ms, and nothing is sent before `TestClock.adjust`. Break: remove the sleep, or skip the first attempt's delay.
- **Submission timeout:** a `Mailer.test.ts` transport that never answers, then `TestClock.adjust(submissionTimeout)`. Expect "uncertain" after one attempt. Break: report a timeout as a throttle.
- **Breaker ratios:** rows for 400 accepted with 10 bounced, and 2,000 accepted with 1 complaint, both not tripping. Break: fixed counts.
- **Last closing body tag:** a `Message.test.ts` input with two literal `</body>` tags. Break: insert at the first.
- **A sendAt of exactly now:** "refuses a sendAt at or before now" becomes `it.effect`, with `sendAt` equal to the TestClock's now.

**Fix:**

- `UnsubscribePage.test.ts`, "judges each consecutive request on its own token": build the handler once, as `Api.test.ts`'s `api()` does.
- `SignedToken.test.ts`: the upper-case digest row changes only the digest's case, not the `v1` prefix.
- The scope helpers of `Api.test.ts`, `PreviewPage.test.ts` and `UnsubscribePage.test.ts` return Effects, and use `it.effect`'s scope instead of `Scope.makeUnsafe()`.
- Stale names in `Campaigns.test.ts`:
  - "…when enqueue loses the source" is `newRun`;
  - the "cancel reread" tests never reread.

  Remove their unread second snapshots.
- `Campaigns.test.ts`'s `World` fake, about 400 lines, becomes recording stubs that answer scripted results, including `CampaignChanged({ current })`. Its assertions on fake state go:
  - "preserves startedAt, progress and feedback";
  - "keeps its history".

**Delete or merge.** The named items are candidates from the review: confirm each against the deletion reasons before removing it.

- **Router 404:** keep `Api.test.ts`'s "keeps the router's 404…"; drop the copies in `Reporting`, `PreviewPage` and `UnsubscribePage`, plus Reporting's "leaves a success alone".
- **`Api.test.ts`:**
  - the error→status table is cut to one 404, one 409, `SendingPaused`, and one or two 503 rows;
  - "reaches the generated client as a typed failure", which `Client.test.ts` covers.
- **`Campaigns.test.ts`:**
  - the "queued wake repair" block;
  - "creates a draft carrying html";
  - "creates a draft carrying a filter";
  - the five-state refusal tables become one row each;
  - "queues a draft that retains a token…";
  - "reschedules under a fresh generation…".
- **`Dispatching.test.ts`:**
  - merge the settle and send-identity tests;
  - drop "takes one pacing slot per attempt…";
  - fold "skips bouncing members" into "skips unsubscribed and suppressed members".
- **`Feedback.test.ts`:** the five "summarises…" log tests.
- **`Mailer.test.ts`:**
  - "performs no HTTP call while the binding is being constructed";
  - the real-time "would retry the same answer…" canary;
  - the duplicate opaque-error test.
- **`SignedToken.test.ts`:** `tokensMatch` cut to three cases.
- **`Unsubscribe.test.ts`:** keep the golden tokens, and drop the tests they cover.
- **Also:**
  - `UnsubscribePage.test.ts`'s "reads no storage even for a token it accepts" and "still confirms a repeated opt-out…";
  - `Dispatch.test.ts`;
  - `audience/Contacts.test.ts`;
  - `SendingDns.test.ts`'s config-library case.

**Keep:**

- authorization and build-once isolation;
- request decoding with dying stubs;
- no-leak logging;
- the exact SES request;
- Dispatching's TestClock backoff, overrun and stale runs;
- the consent tokens and RFC 8058 encodings;
- the guard boundary table;
- the classification table;
- the cancel races.

**Verify:** `pnpm check`. Each added and fixed test fails against its break.

**Cost:** none.

### T11 — Contract tests

Status: Not started

**Where:** `packages/api/src/{Schemas,Client}.test.ts`.

- **`Schemas.test.ts`** is cut to the project's own rules:
  - the Timestamp calendar check (about 6 cases);
  - email CR/LF and non-ASCII refusal;
  - `ListedEmailAddress` keeping case;
  - `mailboxKey`;
  - attribute keys refused rather than dropped;
  - `EntityCursor`;
  - import file versus payload;
  - update null semantics;
  - the UTF-8 byte ceiling;
  - the error-status table (the CLI retries 5xx, so a 409 turned 503 would retry conflicts).

  Bare length, emptiness, literal and required-field checks of Effect Schema go, and so do the `runToken` checks that cannot fail. Confirm each removal against the deletion reasons.
- **`Client.test.ts`** keeps:
  - "attaches the bearer credential and encodes the request body";
  - "decodes a successful response through the shared schema";
  - "surfaces a declared public error as a typed failure".

  The two "does not retry" tests go: the retry lives in the CLI.

**Verify:** `pnpm check`.

**Cost:** none.

### T12 — CLI tests in-process

Status: Not started

**Where:** `apps/cli/test/CliHarness.ts`, `apps/cli/src/**/*.test.ts` and `apps/cli/src/Diagnostics.ts`.

- **The in-process runner:** `Command.runWith(emailer, { version })(args)`, provided with:
  - `NodeServices.layer`;
  - `TestConsole`, which yields stdout and stderr lines;
  - a scripted `Terminal` for prompt answers;
  - `ConfigProvider.fromUnknown` for `EMAILER_API_URL` and `EMAILER_API_TOKEN`;
  - `FetchHttpClient.Fetch` set to `HttpRouter.toWebHandler` over the fake routes.

  `it.live` is kept only where the real clock matters: the import retry, and anything bound to the 70-second deadline.
- **The fake:**
  - it still builds on `HttpApiBuilder` over the real `EmailerApi`, and still records authorizations;
  - it answers from state each test seeds, instead of re-implementing the backend: cancel, update merge, send and resume idempotency, import IDs and member paging all go;
  - handlers no test uses die.
- **Real-process tests,** about six, in `Emailer.test.ts`:
  - help;
  - an unknown subcommand;
  - an invalid flag;
  - missing configuration (asserts `EMAILER_API_URL` on stderr);
  - a refused credential;
  - a prompt on stderr.

  They start `main.ts` by `new URL(…, import.meta.url)`.
- **Fix:**
  - Contacts "refuses an attribute map the contract bounds, before any request": assert that no request reached the fake and that stderr names `--attr`.
  - "rejects a page size outside the contract…": assert that stderr names `--limit`.
  - "reports an unexpected defect…" produces a real defect, or goes.
- **Delete.** The named items are candidates from the review: confirm each against the deletion reasons before removing it.
  - the `shouldReport` describe block, and the export in `Diagnostics.ts`;
  - "reports a failure raised while services are still being provided";
  - Markdown's per-element style table, replaced by one check that every rendered element carries `style=`;
  - date-scheduling runs, cut to two accepted inputs, the TZ test and two calendar refusals;
  - tests that assert the fake's transitions: resume idempotency, cancel transitions and the whole-flow replay;
  - pass-through and repeat cases;
  - one of the two `KeyValuePair` merge tests.

  Tests seed state directly instead of running a `create` first.
- **Keep:**
  - Markdown's plain-text table, escaping and link parity;
  - all of CsvContacts;
  - Diagnostics' rendering cases;
  - validation before any request;
  - import batching, retry and no-retry;
  - the prompt tests;
  - the update payloads;
  - the TZ test.

**Verify:**

- `pnpm check`;
- the fixed tests fail against their breaks;
- the unit run starts at most about six Node processes.

**Cost:** none.

### T13 — Live suite through `Test.make`

Status: Not started

- **Stack outputs** (`alchemy.run.ts`), none secret:
  - `tableName`;
  - `dispatchFailuresQueueUrl`;
  - `setBounceAlarmName`, from the tuple `reputationAlarms` already returns.
- **Entry file,** `apps/backend/test/Live.integration.test.ts`:
  - fails at once if `./.env` exists, naming `.env.prod`;
  - fails at once if the resolved stage is `prod`, because `afterAll` destroys whatever stage it deployed;
  - `Test.make({ providers: awsProviders, state: AWS.state() })`;
  - `const outputs = beforeAll(deploy(Stack), { timeout: 30 min })`;
  - `afterAll(destroy(Stack), { timeout: 30 min })`;
  - calls the five suites in their current order.
- **Suites:** each `*.integration.test.ts` becomes a module next to its code, for example `api/Api.live.ts`. It exports a function that takes the harness and registers its `describe` and `test` blocks. Its bodies are Effects that `test` runs under `@effect/vitest`.
- **Credentials:** the harness resolves `ALCHEMY_PROFILE`, else `default`, and the test bodies use the SDK chain. As in today's live gate, the README tells the operator to export CLI credentials and `AWS_REGION` before the run; `.env.test` may name `ALCHEMY_PROFILE`.
- **`IntegrationSupport.ts`:**
  - configuration comes from `outputs` and `.env.test`'s deploy inputs;
  - function names derive from the stage (`emailer-${stage}-…`);
  - the unsubscribe key is read with `lambda.getFunctionConfiguration` on `emailer-${stage}-unsubscribe`;
  - the `live` wrapper goes; bodies provide `awsClient` themselves.
- **Fix:**
  - "refuses a forged token without opting anybody out" forges the token for the address it then checks;
  - the two DLQ-count assertions go, since a wake dead-letters only after about 2 hours;
  - "refuses to send a list that contains a non-simulator member" goes, since it tests the fixture;
  - "pages lists through a cursor…" requires a non-empty second page with a different first item.
- **Merge:**
  - "includes a campaign created through the API" into the index walk;
  - "refuses to move an opted-out contact to another address" into the ADR-0007 case;
  - the HTML send case into the first send case.
- **Config and docs:**
  - `vitest.config.ts`: the integration project includes only the entry file, and the file-parallelism note goes;
  - `.env.example`: the `EMAILER_TEST_*` and `EMAILER_UNSUBSCRIBE_*` keys go;
  - README "Develop and test": fill `.env.test` with deploy inputs, optionally set `ALCHEMY_TEST_STAGE` (default `test_<user>`), and run `pnpm test:integration`; after a killed run, `alchemy destroy --stage <stage>`; select one suite with `-t`.

**Verify:**

- `pnpm check`, with knip seeing the suite modules through the entry;
- the fixed forged-token check fails against a handler that accepts any signature, in a scratch copy;
- T15.

**Cost:** unchanged. A test stage exists only during a run.

### T14 — Vendored upstream tests

Status: Not started

- **Where:** the 24 `*.test.ts` files under `tools/oxlint/anti-slop/`.
- **Change:** delete them. `UPSTREAM.md` records that the upstream tests are omitted, and the rule sources stay unchanged.

**Verify:** `pnpm check`; `pnpm lint` still loads both plugins.

**Cost:** none.

### T15 — Live gate

Status: Not started

- With `.env.test` holding deploy inputs only, run `pnpm test:integration`.

**Verify:**

- deploy, the test bodies and destroy all authenticate with the documented credentials;
- the harness deploys stage `test_<user>`, or `ALCHEMY_TEST_STAGE`, and every live case passes;
- with `ALCHEMY_TEST_STAGE=prod` the entry file refuses to start, before any deploy;
- during the run, all five `/aws/lambda/emailer-<stage>-*` log groups have 7-day retention;
- after the run, the stage has no table, function, queue, log group, schedule group or state left;
- the account suppression list holds no labelled simulator entries;
- the alert inbox received nothing from the test stage.

**Cost:** one ephemeral stage for the length of the run.

### T16 — Prod rollout

Status: Not started. Runs when the user asks.

- **Deploy:** redeploy `prod` with `--env-file .env.prod --force`.
- **Check:**
  - each function's `CodeSha256` changed;
  - Alchemy's state records `removalPolicy: retain`;
  - `pnpm emailer campaigns list --limit 1` answers.

**Cost:** none.

## Open questions

None. The user decided:

- retaining only on `prod`;
- `.env.prod`;
- in-process CLI tests;
- deleting the vendored tests.
