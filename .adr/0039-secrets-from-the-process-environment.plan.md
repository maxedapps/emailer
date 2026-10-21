# Plan: Secrets from the process environment

- Status: Accepted
- Decision: [ADR-0039](0039-secrets-from-the-process-environment.md)

## Goal

**Done when:** no script, tool or README instruction depends on the `agents` CLI; the scripts read the process environment plus an optional `.env.prod` / `.env.test` through Node's `--env-file-if-exists`; README documents env files and injecting tools with `.env.example` as the list of names; AGENTS.md keeps the agent-facing `agents run` guidance in one place; ADR-0038 is marked superseded; `pnpm stages` and `pnpm test:integration` work under `agents run --env test -- …`; landed through the repo Check.

**Out of scope:** removing the operator's local `.env.prod` / `.env.test`, the vaults themselves, the leak pattern file.

## Rules for every task

- Worktree `~/worktrees/emailer/task-1559-generic-secrets`, no `.env*` copied in; logs in `~/tmp/emailer-1559-*`.
- Never print a value: probes print names and `set`/`unset` only.

## Tasks

### T1 — Scripts and tools

- `package.json`:
  - `emailer`: `node --env-file-if-exists=.env.prod apps/cli/src/main.ts`;
  - `stages`: `node --env-file-if-exists=.env.test tools/stages/main.ts`;
  - `test:integration`: `node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run --project integration`.
- `knip.config.ts`: drop `ignoreBinaries: ["agents"]`, and the explicit `tools/stages/main.ts` entry if knip finds the script's file again.
- `tools/stages/main.ts` doc comment: deploy keys come from the environment (optionally `.env.test`).
- `apps/backend/test/Live.integration.test.ts`: the guard comment drops "the `test` vault"; message cites ADR-0039.
- Verify: `pnpm check`; the real scripts with `agents` off the `PATH` (a scratch bin holding only `node` and `pnpm`) and synthetic, non-secret files removed afterwards:
  - `pnpm emailer lists list` with a `.env.prod` naming a marker `EMAILER_API_URL` fails on that URL; with another marker in the shell, on the shell's;
  - `pnpm stages list` and `pnpm test:integration` with a `.env.test` holding only `EMAILER_SENDER_IDENTITY` fail on the next missing key (`EMAILER_FROM_EMAIL`), before any deploy.
  - Done: all as expected (`~/tmp/emailer-1559-probe{1,2,5,6}.log`).

### T2 — Docs

- `.env.example` header: names only; values go into untracked `.env.prod` / `.env.test` or any tool that injects them.
- README: Requirements (drop the `agents` CLI), First deployment, Configure (env files first, injecting tools as `<tool> run -- pnpm …`, e.g. `op run`, `infisical run`, `doppler run`, no agentmanager example; root `.env` ban), One-time setup, sending-identity and service deploy commands back to `--env-file .env.prod` with the note on injecting tools, Use, Develop and test.
- AGENTS.md: the Secrets rule becomes the one place for `agents run --env prod|test` (worktree takes no env file, never print a value); Test stages Setup/Use/Access say "the test configuration"; the leak-pattern rebuild reads "the prod configuration" (here the `prod` vault, read inside `agents run`); the Landing Check runs the gate under `agents run --env test`, since its live run needs the deploy keys.
- ADRs: 0038 Status `Superseded by ADR-0039`; 0031's "Amended by" line names 0039.
- Verify: `git grep -nIiE 'agents (run|secrets)|vault|agentmanager' -- . ':!.adr'` lists only AGENTS.md: the Secrets rule, the test-stage CLI command, the leak-pattern rebuild and the Landing Check.

### T3 — Runtime check and landing

- `agents run --env test -- pnpm stages up`, `… stages list`, `… stages down <stage>`, then `stages list` no longer shows it.
- `pnpm leak-check && agents run --env test -- pnpm gate`: `package.json` reaches every live group, so the gate runs the whole live suite on one fresh stage, which proves `pnpm test:integration` under `agents run`.

## Evidence

Nothing visible changes: key files and snippets from the landed commit only.

## Plan review

One round (Codex): drop the agentmanager example from the README (done); exercise the real scripts without `agents` (T1 Verify); a working grep for T2 Verify. All fixed.

## Open questions

None.
