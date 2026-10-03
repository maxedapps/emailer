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
- The repository is public: never put details specific to the operator or their company (names, brands, vendors, domains, addresses, account or infrastructure identifiers) into code, tests, fixtures or docs - use neutral placeholders such as `example.com`

# Test stages

Runtime, end-to-end and manual checks run on a real stage of your own; unit tests and `pnpm check` stay local ([ADR-0031](.adr/0031-own-test-stage-per-worker.md)).

- **Names:** `test-<UTC yyMMddHHmm>-<4 base36>`, made by the tools below. Never use a fixed name (`test`, `test_<user>`): parallel workers would deploy over each other.
- **Setup:** `.env.test` holds the deploy keys; export CLI credentials and `AWS_REGION` as the README's "Develop and test" shows.
- **Create:** `pnpm stages up` deploys a fresh stage and prints its name; `pnpm stages up <stage>` redeploys yours after a change (forced, so no function keeps an old bundle).
- **Use:** take `apiUrl` from the deploy output and run the CLI with the test keys only, never through `pnpm emailer` (it loads `.env.prod`): `EMAILER_API_URL=<apiUrl> node --env-file=.env.test apps/cli/src/main.ts <command>`. Send only to SES mailbox-simulator addresses.
- **Live suite:** `pnpm test:integration` deploys a fresh stage of its own, logs its name and destroys it.
- **Tear down:** `pnpm stages down <stage>` before you report, then `pnpm stages list` must not show it. A killed live run leaves its stage; destroy it the same way.
- **Sweep:** `pnpm stages sweep` destroys only test stages older than 4 hours. Never destroy another worker's stage by hand, and leave stages in other formats alone. Work needing a stage beyond 4 hours takes a fresh one.
- **Access:** public, like prod. The Function URLs answer anyone, the API needs the token from `.env.test`, and the unsubscribe and preview pages need links signed by that stage. Anyone holding `.env.test` (the operator and their agents) may open a test stage; never publish its API token or signed links.
