# ADR-0039: Secrets from the process environment

- Status: Accepted
- Date: 2026-10-21
- Accepted: 2026-10-21, after one plan review with the Codex reviewer
- Authority: On 2026-10-21 the operator asked to make emailer secret-source agnostic again: it must work standalone as open source, with agentmanager's vaults as one way to supply secrets, not the only one (task 1559).
- Supersedes [ADR-0038](0038-secrets-from-agentmanager-vaults.md); amends [ADR-0031](0031-own-test-stage-per-worker.md) again: where test stages' deploy keys come from.
- Plan: [0039-secrets-from-the-process-environment.plan.md](0039-secrets-from-the-process-environment.plan.md)

## Context

- **ADR-0038 hard-codes one private tool.** `pnpm emailer`, `pnpm stages` and `pnpm test:integration` start with `agents run --env prod|test`, so nobody without agentmanager can run them, and the README requires its CLI.
- **Node and Alchemy load env files differently.** Node's `--env-file-if-exists` lets a variable already in the environment win over the file and skips a missing file. Alchemy's CLI reads `./.env` under the shell when no file is named, but a file named with `--env-file` wins over the shell (`Util/ConfigProvider.ts`, `ConfigProvider.orElse(dotEnv, shell)`).
- **No generic loader for package scripts.** `node --env-file=<file> --run <script>` does not hand the file's variables to the script (measured on Node 24.21), and pnpm loads no env files.
- **The root `.env` hazard of ADR-0026 stays:** Alchemy's CLI and test harness read `./.env` for every key the environment lacks.

## Decision

1. **Every command reads its configuration from the process environment.** No script names a secrets manager; any tool that injects variables works as `<tool> run -- pnpm …`.
2. **An optional, untracked env file per environment, loaded by Node with `--env-file-if-exists`,** so the environment always wins and a missing file is no error:
   - `pnpm emailer`: `.env.prod`;
   - `pnpm stages` and `pnpm test:integration` (and with it the gate's live run and reruns): `.env.test`. The stages tool hands its environment to the Alchemy CLI and passes no `--env-file`.
   - The README's manual Alchemy commands for prod show `--env-file .env.prod`, and say to drop it under an injecting tool, since Alchemy's file would win over it.
3. **A root `.env` stays forbidden,** and the live suite's guard against it stays.
4. **agentmanager is one injecting tool.** In this repository's checkouts the operator and their agents run `agents run --env prod|test -- …` and a worktree takes no env file; AGENTS.md says so, no script does.

## Alternatives

- **The process environment only, no env file** (the simplest): every standalone user then needs a loader, and there is no generic one for package scripts (see Context), so they would need a third-party tool or `set -a; . ./file`, which reads shell syntax, not dotenv.
- **Keep ADR-0038:** ties the open-source repository to one private tool.
- **Alchemy's `--env-file` in the scripts:** its file wins over the environment, so an injected value would lose to a stale file, and it covers only the Alchemy commands, not the CLI or the live suite.
- **One variable naming the env file** (`EMAILER_ENV_FILE`): a knob nobody asked for; the per-environment names already separate prod from test.

## Consequences

- A standalone user copies `.env.example` to `.env.prod` and `.env.test` and runs the scripts as they are; a secrets-manager user prefixes them.
- A checkout holding both an env file and an injecting tool gets each key from the tool, else from the file. Agent worktrees hold no env file, so there the tool is the only source.
- Running cost: none. Configuration reaches the commands at run time only; DynamoDB, GSI, Lambda, SQS and CloudWatch Logs usage stay as they are.
