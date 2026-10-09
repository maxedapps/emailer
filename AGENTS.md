We're building an AWS SES powered marketing / mass email sending service - using DynamoDB, Lambda, SQS, SNS, EventBridge and others.
We're using Alchemy (alchemy.run) and Effect (effect.website).

# RULES

- Linting, testing and other errors and warnings must be taken seriously and should be fixed properly
- Low running cost is a hard constraint and outranks the next rule ([ADR-0032](.adr/0032-low-running-cost-is-a-hard-constraint.md)): DynamoDB stays (no relational database); state every change's steady-state cost effect (DynamoDB read/write units, GSI writes and storage, Lambda invocations and duration, SQS requests incl. idle long polling, CloudWatch Logs volume) and withdraw any change that costs more, even by cents
- emailer is not used in production yet: within the cost constraint, ALWAYS evaluate alternatives and go for the cleanest solution and implementation, NEVER for the quick fix or workaround - think creatively, big refactors and rewrites are welcome
- Fully embrace Alchemy and Effect and their features
- ALWAYS consult the current official documentation (Alchemy, Effect, AWS) when working on code - do NOT make guesses or blind assumptions
- Perform additional in-depth web research as needed to ensure you operate on proper up-to-date knowledge
- Never drop an item of an approved plan on your own judgment - implement it or ask the operator first
- Evaluate your work by running automated tests and by testing manually
- If you work with worktrees, you own that tree, and you must handle merging back as well as worktree cleanup!
- Document key decisions and findings as ADRs (Architecture Decision Records) in an `.adr` folder (which is to be committed)
- Test deployments are absolutely wanted - on your own ephemeral test stage (see Test stages)
- The repository is public: never put details specific to the operator or their company (names, brands, vendors, domains, addresses, account or infrastructure identifiers) into code, tests, fixtures or docs - use neutral placeholders such as `example.com`. A checkout's private names (AWS CLI profile, zones, test inboxes) live in the git-ignored `AGENTS.local.md`: read it when present
- Deploy output prints the AWS account ID: keep deploy logs out of commits, docs and PR bodies

# Landing gate

Run `pnpm gate` once on the merged result before landing ([ADR-0033](.adr/0033-landing-gate-scoped-to-the-change.md)); fetch `origin` first. It runs `pnpm check` (fast, always whole), lists the paths changed against `git merge-base origin/main HEAD` (committed, uncommitted, untracked), prints each path's reach, and runs the live suite (`pnpm test:integration`, one fresh stage) for only the groups reached, or not at all. Never pick a bigger run by hand. `agents land main` runs the leak check and the gate, then the whole landing turn, as the block at the end of this file declares.

The live suite is the only slow suite. Its groups are Vitest tags (`apps/backend/test/LiveGroups.ts`): `api`, `cancellation`, `drafting`, `variants`, `unsubscribe`, `subscriptions`, `feedback`. The map is `tools/gate/LiveReach.ts`; first match wins (`src/` is `apps/backend/src/`):

| Paths                                                                                                                                                                   | Reach                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `**/*.md`, `.adr/**`, `LICENSE`                                                                                                                                         | none                              |
| `alchemy.run.ts`, `apps/backend/test/**`, `tools/stages/TestStage.ts`, `vitest.config.ts`, `tsconfig*.json`, `**/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | all                               |
| unit tests (`**/*.test.ts`), `src/storage/Testing.ts`, `apps/cli/**`, `stacks/**`, `src/identity/SendingDns.ts`, `tools/**`, lint, format and knip config               | none                              |
| each `src/**/*.live.ts`                                                                                                                                                 | its own group                     |
| `src/campaigns/TestSends.ts`                                                                                                                                            | drafting                          |
| `src/campaigns/Previews.ts`, `PreviewPage.ts`, `Copies.ts`                                                                                                              | drafting, variants                |
| `src/consent/UnsubscribePage.ts`                                                                                                                                        | unsubscribe                       |
| `src/consent/Subscriptions.ts`                                                                                                                                          | subscriptions                     |
| `src/feedback/Feedback.ts`, `FeedbackClassification.ts`                                                                                                                 | api, drafting, variants, feedback |
| anything else (other backend modules, `packages/api`, new paths)                                                                                                        | all                               |

A new live suite adds its group to `LiveGroups.ts` and its suite to the live file. A module that only some groups exercise gets a narrow rule here and in `LiveReach.ts`; when unsure, leave it reaching all.

**Not yet run live:** the gate landed without an AWS login, so no tagged group has run on a stage yet. The first gate after the next `aws sso login` that reaches the live suite is its first real run: check that only the selected groups run and that the stage is destroyed.

# Before pushing

`pnpm leak-check` must pass before every push ([ADR-0034](.adr/0034-leak-check-in-every-landing.md)). It fails when the machine-local pattern file `~/.config/emailer/leak-pattern.txt` is missing or empty, or when its pattern (grep `-E`, case-insensitive) matches a file changed against `origin/main` or a line of the commits `origin/main..HEAD`, messages included. It prints only file names and a line count, never the pattern. `agents land` runs it in the gate, so no landing pushes without it.

Grep a PR body against the same file (`grep -ciIEf`, never print the pattern), and read the diff yourself: the pattern misses some personal details, such as a first name used as a fixture persona.

# Dependencies

pnpm refuses any locked package published less than 24 hours ago, `--frozen-lockfile` included. A bump lands only once the newest publish among all its locked entries, platform binaries included, is a day old; find it with `npm view <pkg>@<version> time` for each. Until then, work in a worktree with pnpm's generated `minimumReleaseAgeExclude` list, never commit that list, and prove `pnpm install --frozen-lockfile` passes without it before landing.

# Test stages

Runtime, end-to-end and manual checks run on a real stage of your own; unit tests and `pnpm check` stay local ([ADR-0031](.adr/0031-own-test-stage-per-worker.md)).

- **Names:** `test-<UTC yyMMddHHmm>-<4 base36>`, made by the tools below. Never use a fixed name (`test`, `test_<user>`): parallel workers would deploy over each other.
- **Setup:** `.env.test` holds the deploy keys; export CLI credentials and `AWS_REGION` as the README's "Develop and test" shows. If `aws` reports an expired SSO session, ask the operator to run `aws sso login --profile <profile>`.
- **Create:** `pnpm stages up` deploys a fresh stage and prints its name; `pnpm stages up <stage>` redeploys yours after a change (forced, so no function keeps an old bundle).
- **Use:** take `apiUrl` from the deploy output and run the CLI with the test keys only, never through `pnpm emailer` (it loads `.env.prod`): `EMAILER_API_URL=<apiUrl> node --env-file=.env.test apps/cli/src/main.ts <command>`. Send only to SES mailbox-simulator addresses.
- **Live suite:** `pnpm test:integration` deploys a fresh stage of its own, logs its name and destroys it.
- **Tear down:** `pnpm stages down <stage>` before you report, then `pnpm stages list` must not show it. A killed live run leaves its stage; destroy it the same way.
- **Sweep:** `pnpm stages sweep` destroys only test stages older than 4 hours. Never destroy another worker's stage by hand, and leave stages in other formats alone. Work needing a stage beyond 4 hours takes a fresh one.
- **Access:** public, like prod. The Function URLs answer anyone, the API needs the token from `.env.test`, and the unsubscribe and preview pages need links signed by that stage. Anyone holding `.env.test` (the operator and their agents) may open a test stage; never publish its API token or signed links.

`agents land` runs these at the worktree's root (agentmanager ADR 0289):

```agents-land
gate: pnpm leak-check && pnpm gate
```
