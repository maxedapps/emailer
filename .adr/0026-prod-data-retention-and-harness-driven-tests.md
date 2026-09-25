# ADR-0026: Keep prod's data on destroy, and test through the libraries' harnesses

- Status: Accepted
- Date: 2026-09-25
- Authority: On 2026-09-25 a whole-codebase review, run against the installed Effect 4.0.0-rc.117 and Alchemy 2.0.0-beta.79 sources and docs, found no high-severity defect. The user then chose:
  - the table is retained on stage `prod` only;
  - the live suite deploys and destroys its own stage through Alchemy's test harness;
  - prod configuration moves from `.env` to `.env.prod`, because the harness always falls back to `./.env`;
  - the CLI command tests run in-process through Effect's CLI testing tools, with a few real-process tests kept;
  - the vendored lint plugin's upstream tests are deleted;
  - every cleanup and style finding of the review is fixed, and the low-value tests it found are removed.

  They approved this record and its plan on 2026-09-25 by asking to continue, after renaming their local `.env` to `.env.prod`.
- Plan: [0026-prod-data-retention-and-harness-driven-tests.plan.md](0026-prod-data-retention-and-harness-driven-tests.plan.md)

## Context

- **`alchemy destroy --stage prod` deletes the table.**
  - It holds every contact, list and campaign, and every opt-out and suppression.
  - Contacts imported again after a destroy would be mailable again.
  - The README documents the prod destroy as an ordinary command.
- **The live suite never deploys the code it tests.**
  - An operator deploys a stage by hand, copies nine values from the deploy inventory into `.env.test`, runs the suite, and destroys the stage by hand.
  - A stale stage passes against old code, and nothing stops the suite from pointing at prod.
  - Its `live` wrapper is `Effect.runPromise`: a test that times out keeps running, and can leave the dispatcher's queue mapping disabled.
- **Alchemy ships a Vitest harness,** `alchemy/Test/Vitest` `Test.make`:
  - `beforeAll(deploy(Stack))` returns the stack outputs, and `afterAll(destroy(Stack))` removes the stage;
  - test bodies run as `@effect/vitest` `it.live` tests;
  - the stage is `ALCHEMY_TEST_STAGE`, else `test_$USER`;
  - hooks default to a 120-second timeout and ignore interruption;
  - there is no way to share one deployment between test files.
- **The harness always reads `./.env` as a fallback** (`Test/Core.ts:372`, `Stack.ts:351`, `Util/ConfigProvider.ts`). Process environment wins, then `./.env` in the working directory. There is no option to name another file, and an empty value cannot override a key.
  - With the prod `.env` in the repository root, a key missing from the test environment silently takes the prod value.
  - `EMAILER_ALERT_EMAIL` would subscribe the real alert inbox to the test stage, and the forced-alarm test would then mail it.
- **The CLI tests start the CLI as a real `node` process** about 88 times.
  - A 650-line harness runs a stateful copy of the backend behind a loopback server.
  - Effect ships the pieces to run a command in-process: `Command.runWith`, `TestConsole`, `HttpRouter.toWebHandler`, and the `FetchHttpClient.Fetch` reference that the client reads per call.
- **About a quarter of the 871 unit tests protect nothing a cheaper test does not.** They restate the code, test Effect Schema or a test double, or repeat another test.
  - Six tests are proven false greens: they stay green when the behaviour they name is broken.
  - The pacing wait, the submission timeout and the breaker's ratios can be broken without any test failing.

## Decision

1. **The table is retained on `prod`:** `RemovalPolicy.retain(stage === "prod")`. Every other stage deletes it on destroy.
2. **Prod configuration lives in `.env.prod`.**
   - `pnpm emailer` and every documented Alchemy command name their file explicitly.
   - The live suite refuses to start while a `./.env` exists, or when its stage is `prod`.
3. **The live suite runs through `Test.make`, from one entry file.**
   - It deploys `alchemy.run.ts` to the harness stage in `beforeAll` and destroys it in `afterAll`, with hook timeouts above a deploy's worst case.
   - The five suites become modules the entry file calls. A single suite is selected with `-t`.
   - The values it needs come from new non-secret stack outputs: the table name, the dead-letter queue URL and the bounce alarm name.
   - Function names are derived from the stage.
   - The unsubscribe signing key is read from the deployed function's configuration, never output.
   - `.env.test` holds only deploy inputs.
4. **CLI command tests run in-process** through `Command.runWith` with `TestConsole`, a scripted terminal, and the fake routes served through `HttpRouter.toWebHandler` as the `Fetch` reference.
   - About six real-process tests keep what only `main.ts` shows: help, exit codes, diagnostics on stderr, missing configuration, and prompts on stderr.
   - The fake answers from seeded state instead of re-implementing the backend.
5. **Every test must be able to fail on the bug its name describes.** The review's low-value tests go, its false greens are fixed, and the untested behaviours gain one test each.
6. **Smaller cleanups ship in the same plan:**
   - the log-group ordering env var goes;
   - one typed `AWS.providers()` for both stacks;
   - a queue-backlog alarm helper, with each dead-letter alarm declared by its queue's module;
   - the Effect idioms the review listed;
   - `contacts create --attr`;
   - the vendored upstream tests go;
   - the README states that the daily ceiling counts the whole SES account.

## Alternatives

- **Retain the table everywhere except test stages.** This also protects future durable stages. The user chose `prod` only; the harness stage is not `prod`, so test runs leave no table behind.
- **Keep the hand-deployed live suite and only fix its assertions.** This is the smallest change. Rejected: it keeps the stale-stage and point-at-prod risks, and the user wants the libraries' harnesses.
- **A test-only config provider around `deploy(Stack)`.** Rejected, because it cannot work in beta.79: `evalStack` loads its own provider, which sits closer to plan and apply than any wrapper.
- **Run the live suite from a directory without a `.env`.** This keeps the prod file name. Rejected in favour of explicit env files, so safety does not depend on the working directory.
- **A globalSetup sharing one deployment between five test files.** Only possible through the undocumented `alchemy/Test/Core`. Rejected for the single entry file.
- **Keep the CLI tests as processes and only trim them.** Rejected: it keeps the process runner and the port, and the user wants Effect's CLI testing tools.
- **An in-memory DynamoDB fake for the storage tests.** Rejected: it would need its own expression evaluator, where fidelity bugs would hide. The live suite proves expression semantics.

## Consequences

- **Destroying prod** keeps the table as an untracked AWS resource. A redeploy creates a new, empty table and does not reattach the old one. Recovery is manual. The unsubscribe and preview keys still rotate, so unsubscribe links already sent stop working.
- **A live run** pays one deploy and one destroy of its own stage, so it takes several minutes longer than before. It refuses stage `prod`, and it destroys whatever other stage it is pointed at. A run killed mid-way leaves the stage for `alchemy destroy --stage <stage>`.
- **The operator renames `.env` to `.env.prod` once.** Every documented command changes accordingly.
- **The CLI suite** runs mostly in-process, with about six Node processes instead of 88.
- **The unit suite** shrinks by roughly a quarter and gains a handful of tests that fail on the behaviours they name.
- **Running cost:** unchanged. Test stages exist only while a live run is in progress.

## Confirmation

- `pnpm check` passes after every task.
- A live run through the new entry file deploys its own stage, passes, and destroys it, leaving no table, function, queue, log group or schedule behind.
- The test stage's log groups keep 7-day retention without the ordering env var.
- After the prod redeploy, the Alchemy state records `removalPolicy: retain` for the table.
