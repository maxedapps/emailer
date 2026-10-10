# Plan: Capped test workers, a lone rerun in the gate, a flake ledger and dated skips

- Status: Planned
- Decision: [ADR-0035](0035-flaky-tests-rerun-ledger-and-dated-skips.md)

## Goal

**Done when:**

- Vitest runs at most 4 workers; `pnpm test:integration` and the deploys and destroys of `pnpm stages` run through `agents heavy`.
- A red `pnpm gate` reruns its failed tests once by themselves, prints a verdict per test, appends a row to `docs/flakes.md` for each that passes alone, and still fails.
- `pnpm check` fails on a `.skip`/`.skipIf` in a test file without a dated task comment, or 14 days after its date.
- AGENTS.md says all of this briefly, maps nothing new into the live suite, and links the shared `testing` skill if it exists by landing.

**Out of scope:** retries, longer timeouts, changing live tests, a scheduled full run.

## Rules for every task

- Worktree `~/worktrees/emailer/task-636-flaky-tests`, branch `task-636-flaky-tests`; `pnpm check` green per commit, logs in `~/tmp/t636/`.

## Tasks

### T1 — Worker cap and heavy scripts

- `vitest.config.ts`: root `maxWorkers: 4`.
- `package.json`: `test:integration` runs `agents heavy -- node --env-file=.env.test node_modules/vitest/vitest.mjs run --project integration`.
- `tools/stages/main.ts`: `run` (deploy, destroy) spawns `agents heavy -- alchemy …`; `read` (`state list`) stays direct.
- Verify: a unit run reports at most 4 workers (`VITEST_POOL_ID` ≤ 4 in a probe, or process count); `pnpm stages up` then `down` on a fresh stage work through the wrapper.

### T2 — JSON report on request (`vitest.config.ts`, `tools/Process.ts`)

- Config: `reporters` is `configDefaults.reporters`, plus `["json", { outputFile }]` when `GATE_TEST_REPORT` is set.
- `Process.run` takes an optional `env`, merged into the inherited environment.
- Verify: `GATE_TEST_REPORT=… pnpm test` writes the report; without it nothing is written; the variable reaches Vitest through `agents heavy` and `node --env-file`.

### T3 — Lone rerun and ledger (`tools/gate/Reruns.ts`, `Reruns.test.ts`, `main.ts`)

- `Reruns.ts`: the report schema (the fields used), `failedTests(report)` (file relative to the repo, names, symptom), `rerunFilter(tests)` (files plus `-t '^(…)$'` with escaped `a > b > c` names), `verdicts(failed, rerun)` (`passes alone` / `fails alone` / `did not run`), `ledgerRow(test, date)` (pipes and newlines escaped, symptom shortened).
- `main.ts`: each tested step (`pnpm check` with `pnpm test` as its rerun, the live run with `pnpm test:integration` as its rerun) writes its report into a scoped temp directory; on failure with failed tests it reruns once, prints the verdicts, appends ledger rows and fails with the original error. No failed tests in the report (lint, types, a failed deploy): fail as today.
- `docs/flakes.md`: a short header and the table.
- Tests: parsing a report with passed, failed and skipped tests; the `-t` pattern selects exactly the names (escaping regex characters); verdicts for each case; a row with a pipe and a multi-line symptom.
- Manual: a temporary unit test that fails on its first run and passes on the next (a marker file) makes `pnpm gate` red, rerun it, log it to the ledger and stay red; a temporary always-failing test is reported `fails alone`. Both removed before commit.

### T4 — Dated skips (`tools/oxlint/emailer/`, `oxlint.config.ts`, `tsconfig.json`)

- Plugin `emailer` with rule `dated-skips`: on `.skip`/`.skipIf` member calls, read the last comment before the call; report a missing or malformed `Skipped <YYYY-MM-DD> in task <N>: <reason>` and an expiry (date + 14 days < today, UTC).
- `oxlint.config.ts`: load the plugin; enable the rule for `**/*.test.ts` and `**/*.live.ts` in `overrides`.
- `tsconfig.json`: exclude only `tools/oxlint/anti-slop`, so the new plugin is typechecked.
- Tests (`dated-skips.test.ts`, oxlint's `RuleTester` from `oxlint/plugins-dev`): a dated skip from today and from 13 days ago pass; one from 15 days ago, an unannotated `it.skip`, `describe.skip`, `it.effect.skip`, `it.skipIf(x)` and `ctx.skip()` and a malformed comment fail.
- Manual: an unannotated `.skip` in a real test file fails `pnpm lint`; removed before commit.

### T5 — AGENTS.md, README

- AGENTS.md "Flaky tests" section: worker cap; the gate's rerun, verdicts and the ledger (fill task and cause, commit with the fix or skip; never retries or longer timeouts); skips (comment format, 14 days, one fix task each via `agents plan github.com/maxedapps/emailer --title 'Fix flaky <test>' '<brief>'`, never re-date); whole live suite now and then by judgement; link to `~/.agents/skills/testing/SKILL.md` if it exists, keeping only emailer specifics.
- README "Develop and test": one line that heavy scripts wait for machine headroom through `agents heavy`.
- Reach table unchanged: `docs/flakes.md` is `**/*.md` (none).

### T6 — Gate and landing

- `pnpm leak-check && pnpm gate` via `agents land main`: this change touches `vitest.config.ts`, `package.json` and `tsconfig.json`, so the map runs every live group.

## Evidence

No UI. Key files and snippets from the landed commit; the gate output of the manual flake probe (T3) and the lint output of the skip probe (T4).

## Open questions

- None.
