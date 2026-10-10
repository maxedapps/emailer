# Plan: Capped test workers, a lone rerun in the gate, a flake ledger and dated skips

- Status: Planned
- Decision: [ADR-0035](0035-flaky-tests-rerun-ledger-and-dated-skips.md)

## Goal

**Done when:**

- Vitest runs at most 4 workers; `pnpm test:integration` and the deploys and destroys of `pnpm stages` run through `agents heavy`.
- A red `pnpm gate` reruns its failed tests once by themselves, prints a verdict per test, appends a line to `flakes.md` for each that passes alone, and still fails.
- `pnpm check` fails on a `.skip` in a test file, and on a `.skipIf` without a `flaky: task-<N> until <date>` marker or with a date more than 14 days ahead.
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

- `Reruns.ts`: the report schema (the fields used), `failedTests(report)` (file relative to the repo, names, symptom), `rerunFilter(tests)` (files plus `-t '^(…)$'` with escaped `a > b > c` names), `verdicts(failed, rerun)` (`passes alone` / `fails alone` / `did not run`), `ledgerLine(test, date, task)` (symptom: first line, shortened), `branchTask(branch)` (`task-636-…` → `task-636`, else `task-?`).
- `main.ts`: each tested step (`pnpm check` with `pnpm test` as its rerun, the live run with `pnpm test:integration` as its rerun) writes its report into a scoped temp directory; on failure with failed tests it reruns once, prints the verdicts, appends ledger lines and fails with the original error. No failed tests in the report (lint, types, a failed deploy): fail as today.
- `flakes.md`: a short header; `.gitattributes`: `flakes.md merge=union`; `LiveReach.ts`, its test and the AGENTS.md table: `.gitattributes` reaches no group.
- Tests: parsing a report with passed, failed and skipped tests; the `-t` pattern selects exactly the names (escaping regex characters); verdicts for each case; a line with a multi-line symptom; the task from a branch name.
- Manual: a temporary unit test that fails on its first run and passes on the next (a marker file) makes `pnpm gate` red, rerun it, log it to the ledger and stay red; a temporary always-failing test is reported `fails alone`. Both removed before commit.

### T4 — Dated skips (`tools/oxlint/emailer/`, `oxlint.config.ts`, `tsconfig.json`)

- Plugin `emailer` with rule `flaky-skips`: report every `.skip` member call; on `.skipIf` member calls, look for `flaky: task-<N> until <YYYY-MM-DD>` in a comment on the call's first line or the line above, and report it missing or dated more than 14 days ahead (UTC).
- `oxlint.config.ts`: load the plugin; enable the rule for `**/*.test.ts` and `**/*.live.ts` in `overrides`.
- `tsconfig.json`: exclude only `tools/oxlint/anti-slop`, so the new plugin is typechecked.
- Tests (`flaky-skips.test.ts`, oxlint's `RuleTester` from `oxlint/plugins-dev`): a `skipIf` marked until 14 days ahead and one marked until yesterday (expired by itself) pass; one 15 days ahead, an unmarked `skipIf`, `it.skip`, `describe.skip`, `it.effect.skip`, `it.skipIf(x)` and `ctx.skip()` and a malformed comment fail.
- Manual: an unannotated `.skip` in a real test file fails `pnpm lint`; removed before commit.

### T5 — AGENTS.md, README

- AGENTS.md "Flaky tests" section: worker cap; the gate's rerun, verdicts and the ledger (replace the cause `?`, commit with the fix or skip); skips (the lint rule's marker and how it fails; `agents plan github.com/maxedapps/emailer --title 'Fix flaky <test>' '<brief>'` per skip); whole live suite now and then by judgement; link the shared `awesome-tests` skill (it now holds the flake rules), keeping only emailer specifics.
- README "Develop and test": one line that heavy scripts wait for machine headroom through `agents heavy`.
- Reach table: `.gitattributes` joins the "none" row; `flakes.md` is `**/*.md` (none).

### T6 — Gate and landing

- `pnpm leak-check && pnpm gate` via `agents land main`: this change touches `vitest.config.ts`, `package.json` and `tsconfig.json`, so the map runs every live group.

## Evidence

No UI. Key files and snippets from the landed commit; the gate output of the manual flake probe (T3) and the lint output of the skip probe (T4).

## Open questions

- None.
