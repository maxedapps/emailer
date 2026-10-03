# ADR-0031: One test stage per worker, and a sweep that spares live ones

- Status: Accepted
- Accepted: 2026-10-03, after one plan review with the Codex reviewer
- Date: 2026-10-03
- Confirmed: 2026-10-03.
  - Two stages deployed in parallel, one named 5 hours in the past; `pnpm stages list` showed exactly those two, the old one stale. `pnpm stages sweep` destroyed only the old one; the account held none of its resources and Alchemy's state no longer listed it. A second sweep found nothing stale.
  - The young stage answered the CLI with the `.env.test` token (401 without it), kept its data through a forced redeploy, and was then destroyed with `pnpm stages down`.
  - A live run of one suite deployed, logged and destroyed its own stage while the young one stayed up.
- Authority: The user decided that runtime, end-to-end and manual tests run on real, ephemeral `test-<id>` Alchemy stages, that parallel workers never share one, that a sweep removes only stale ones, and that each repository sets its own default access for them.
- Plan: [0031-own-test-stage-per-worker.plan.md](0031-own-test-stage-per-worker.plan.md)
- Amends: [ADR-0026](0026-prod-data-retention-and-harness-driven-tests.md), which let the live suite pick its stage from `ALCHEMY_TEST_STAGE`, else `test_$USER`.

## Context

- **Stages are shared by name.** Manual checks deploy `--stage test` (AGENTS.md, ADR-0028/0029 plans). The live suite deploys `test_$USER`, and every worker runs as the same user. Two workers on the same name deploy over each other, and the first to finish destroys the other's stage mid-run.
- **Nothing removes a leaked stage.** A killed run or a forgotten walkthrough leaves its stage until someone destroys it by hand. A sweep that destroys every `test*` stage would also kill a sibling's live one.
- **Alchemy's state store records no deploy time.** `alchemy state list Emailer` lists the stages as paths (`Emailer/<stage>/`), nothing more, and it evaluates `alchemy.run.ts`, so it needs the deploy keys (`--env-file`).
- **An idle stage costs almost nothing:** on-demand DynamoDB, Lambda, SQS and EventBridge bill per use; only the stage's CloudWatch alarms bill per month.
- **A stage's endpoints are Lambda Function URLs.** The API requires the bearer token from `.env.test`; the unsubscribe and preview pages accept only links signed with the stage's own keys. Prod is reached the same way.

## Decision

1. **Every test stage is `test-<UTC yyMMddHHmm>-<4 base36 chars>`**, e.g. `test-2610031430-k3x9`. The name carries its creation time, so its age needs no store. The random part keeps two workers starting in the same minute apart.
2. **`pnpm stages` owns test stages** (pnpm 12 has a built-in `stage` command, so the script cannot be `stage`): `up [stage]` deploys a fresh stage, or redeploys the given one with `--force`; `down <stage>` destroys one; `list` shows every test stage with its age; `sweep` destroys the stale ones. `up` and `down` refuse any other name, and every command deploys with `.env.test`.
3. **A stage is stale 4 hours after its creation, however often it was redeployed.** The sweep matches names against the exact pattern above, so `prod`, `shared`, and stages in older formats (`test`, `test_<user>`, `test-import`) are never touched. It lists the `Emailer` stack only.
4. **The live suite takes a fresh stage on every run** and writes its name to stderr, which Vitest's agent reporter keeps. `ALCHEMY_TEST_STAGE` and the guard against `prod` go: the suite can no longer be pointed at another stage.
5. **Default access: test stages are public, like prod.** Their Function URLs answer anyone; the API needs the token from `.env.test`, and pages need links signed by the stage. No extra gate.

## Alternatives

- **Keep fixed names, one per worker** (`test-<worker>`). Simplest, but worker names are not unique across machines or harnesses, and the age of a stage still has to come from somewhere.
- **Age from the state bucket's object times.** Reads "last deployed" rather than "created", which favours long jobs that redeploy, but it couples the sweep to the S3 layout of Alchemy's state store, which is not a public interface.
- **Tag resources with a creation time and sweep by tag.** Needs every resource tagged and a tag scan per stage. The name already carries the time.
- **2 hours, the default the research proposed.** A live run takes under 30 minutes, but a worker's walkthrough with review rounds can hold a stage for hours. Given the negligible idle cost, 4 hours leaves more room before a live stage is destroyed under a worker.
- **A gate in front of test stages** (an IAM-authorized Function URL or an allowlist). Adds signing to the CLI and the tests, and protects nothing the token and signed links do not already protect.

## Consequences

- Parallel workers and live runs never share a stage. A worker needing a stage beyond 4 hours takes a fresh one.
- A killed live run leaves its stage until its owner runs `pnpm stages down <stage>` or a sweep finds it stale.
- Stages in the old formats are left alone; their owners destroy them by hand.
- Running cost: unchanged or lower, since leaked stages no longer stay forever.
