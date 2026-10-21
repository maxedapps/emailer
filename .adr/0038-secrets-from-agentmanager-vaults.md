# ADR-0038: Secrets from agentmanager's vaults

- Status: Superseded by [ADR-0039](0039-secrets-from-the-process-environment.md)
- Date: 2026-10-21
- Accepted: 2026-10-21, after one plan review with the Codex reviewer
- Authority: On 2026-10-21 the operator asked every project to read its secrets from agentmanager's vaults instead of `.env` files, keeping the files (and Infisical) in place until a later removal they confirm.
- Amends [ADR-0031](0031-own-test-stage-per-worker.md): where test stages' deploy keys come from.
- Plan: [0038-secrets-from-agentmanager-vaults.plan.md](0038-secrets-from-agentmanager-vaults.plan.md)

## Context

- **Untracked env files.** `pnpm emailer` loads `.env.prod`; `pnpm stages` (Alchemy's `--env-file`) and `pnpm test:integration` (Node's `--env-file`) load `.env.test`. A worktree has neither until someone copies them in, and each machine keeps its own copy.
- **agentmanager vaults.** The Hub keeps a project's variables per environment (agentmanager ADR 0373). `agents run [--env <env>] -- <command>` runs the command with the vault of the project the current folder's git remote names; a variable already set in the caller's environment wins, and no value is written to disk or printed. `agents secrets list|import|diff` work by name only.
- **Emailer's two environments.** `prod` (11 variables) and `test` (5, the deploy keys test stages use). No `.env` exists and nothing reads a `dev` environment.

## Decision

1. **Every script that reads secrets runs under `agents run`** with its vault:
   - `pnpm emailer`: `--env prod`;
   - `pnpm stages` and `pnpm test:integration`, and with it the gate's live run and reruns: `--env test`;
   - the CLI against a test stage: `EMAILER_API_URL=<apiUrl> agents run --env test -- node apps/cli/src/main.ts …`;
   - the README's manual Alchemy commands for prod: `agents run --env prod -- pnpm exec alchemy …`, without `--env-file`.
2. **No script loads `.env.prod` or `.env.test`.** A worktree takes no `.env*`; `.env.example` stays as the list of names to fill into a vault. A root `.env` stays forbidden, because Alchemy's CLI and test harness still read one when it exists, and the live suite's guard against it stays.
3. **Values never leave the vault in the open:** no agent prints one, and a value changes with `agents secrets set` or `import`, never in a file that is then read by a script.

## Alternatives

- **Keep the env files** (the simplest option): every worktree and machine needs copies, and they drift from each other.
- **Wrap the Alchemy calls inside `tools/stages/main.ts`**: needed only in a tool that deploys both prod and test stages; emailer's tool only touches test stages, so one wrapper in `package.json` keeps the tool free of secrets plumbing.
- **Declare `secrets: Secrets.ProcessEnv()` on both stacks**, so Alchemy never reads `./.env`: it also changes how a deploy resolves config (empty strings kept, the profile pinned), which this switch needn't touch, and the CLI and test harness would still read a stray `./.env` before the stack's config applies.

## Consequences

- Rotating a value means `agents secrets set --env <env> <NAME>` (value on stdin); the env files go stale and are removed in a later step the operator confirms.
- Every secret-reading script needs the `agents` CLI on the `PATH` and the Hub reachable: there is no offline copy.
- The leak pattern's private values come from the `prod` vault, read inside `agents run` without printing them.
- Running cost: none. Secrets reach the commands at run time only; DynamoDB, GSI, Lambda, SQS and CloudWatch Logs usage stay as they are.
