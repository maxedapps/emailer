# Plan: Secrets from agentmanager's vaults

- Status: Accepted
- Decision: [ADR-0038](0038-secrets-from-agentmanager-vaults.md)

## Goal

**Done when:** the `prod` and `test` vaults hold every variable of `.env.prod` and `.env.test` (`agents secrets diff` all `same`); `pnpm emailer`, `pnpm stages` and `pnpm test:integration` run under `agents run` with their env and no script loads `.env.prod` or `.env.test`; AGENTS.md, the README and `.env.example` say so; a test stage deployed and driven through `agents run --env test`, then destroyed; landed on `main` through `pnpm leak-check && pnpm gate`.

**Out of scope:** removing `.env.prod`, `.env.test` or `.env.example`'s role as the name list; `AGENTS.local.md`; the machine-local leak pattern file; a `dev` vault (nothing reads one).

## Rules for every task

- Worktree `~/worktrees/emailer/task-1484-agents-secrets`, branch `task-1484-agents-secrets`, no `.env*` copied in; logs in `~/tmp/emailer-1484-*`.
- Never print a value: probes print names and `set`/`unset` only.

## Tasks

### T1 — Vaults (done before the code)

- `agents secrets import --env prod .env.prod`, `--env test .env.test`; `agents secrets diff` per env: 11 and 5 `same`.

### T2 — Scripts (`package.json`, `tools/stages/main.ts`)

- `emailer`: `agents run --env prod -- node apps/cli/src/main.ts`.
- `stages`: `agents run --env test -- node tools/stages/main.ts`; the tool drops `--env-file .env.test` and its doc comment says the keys come from the environment.
- `test:integration`: `agents run --env test -- vitest run --project integration`. The gate and its reruns call this script, so they need no change.
- `apps/backend/test/Live.integration.test.ts`: the stray-`./.env` guard stays; its message no longer says to move it to `.env.prod`.
- Verified by: in the worktree (no env files), `pnpm stages up` deploys a fresh stage; the CLI through `EMAILER_API_URL=<apiUrl> agents run --env test -- node apps/cli/src/main.ts` answers (lists, a test send to the SES simulator); a probe under `agents run --env prod` reports the CLI's names set without printing them; `pnpm stages down` and `pnpm stages list` no longer shows the stage.

### T3 — Docs

- AGENTS.md: Test stages (Setup, Use, Access) and the leak-pattern rebuild name the vaults; a rule that secrets come from the vaults via `agents run`, per env, and are never printed.
- README: First deployment, Configure, One-time setup, Sending identity, Deploy, Use and Develop and test use the vaults and `agents run --env prod|test`; drop every `--env-file`.
- `.env.example` header: fill a copy and import it into the vault, then delete the copy.
- ADR-0031 "Amended by ADR-0038".

### T4 — Land

- `pnpm check` on the worktree; review; `pnpm leak-check && pnpm gate`. `package.json` reaches every live group, so ask the operator first with scope and cost (AGENTS.md "Flaky tests").

## Evidence

No UI changes and no running-cost change (secrets reach commands at run time only; ADR-0038). Key files and snippets from the landed commit; the stage name and the CLI's answers (no values).

## Open questions

None.
