# Plan: Capped test workers, a lone rerun in the gate, a flake ledger and dated skips

- Status: Implemented
- Decision: [ADR-0035](0035-flaky-tests-rerun-ledger-and-dated-skips.md)

## Goal

**Done when:**

- Vitest runs at most 4 workers; `pnpm test:integration` and the deploys and destroys of `pnpm stages` run through `agents heavy`.
- A red `pnpm gate` reruns each failed test once in a run of its own, prints a verdict per test, appends a line to `flakes.md` for each that passes alone, and still fails.
- `pnpm check` fails on a `.skip` or `skip` option in a test file, and on a `.skipIf` that is not the shared real-clock form with a matching `flaky: task-<N> until <date>` marker, dated at most 14 days ahead.
- AGENTS.md says all of this briefly, maps nothing new into the live suite, and links the shared `awesome-tests` skill.

**Out of scope:** retries, longer timeouts, changing live tests, a scheduled full run.

## Rules for every task

- Worktree `~/worktrees/emailer/task-636-flaky-tests`, branch `task-636-flaky-tests`; `pnpm check` green per commit, logs in `~/tmp/t636/`.

## Tasks

### T1 — Worker cap and heavy scripts

- `vitest.config.ts`: root `maxWorkers: 4`.
- `knip.config.ts`: `agents` is a binary from outside the repository.
- `package.json`: `test:integration` runs `agents heavy -- node --env-file=.env.test node_modules/vitest/vitest.mjs run --project integration`.
- `tools/stages/main.ts`: `run` (deploy, destroy) spawns `agents heavy -- alchemy …`; `read` (`state list`) stays direct.
- Verify: a unit run reports at most 4 workers (`VITEST_POOL_ID` ≤ 4 in a probe, or process count); `pnpm stages up` then `down` on a fresh stage work through the wrapper.

### T2 — JSON report on request (`vitest.config.ts`, `tools/Process.ts`)

- Config: `reporters` is `configDefaults.reporters`, plus `["json", { outputFile }]` when `GATE_TEST_REPORT` is set.
- `Process.run` takes an optional `env`, merged into the inherited environment.
- Verify: `GATE_TEST_REPORT=… pnpm test` writes the report; without it nothing is written; the variable reaches Vitest through `agents heavy` and `node --env-file`.

### T3 — Lone rerun and ledger (`tools/gate/Reruns.ts`, `Reruns.test.ts`, `main.ts`)

- `Reruns.ts`: the report schema (the fields used), `readResults(path, root)` (file relative to the repo, `a > b > c` names from the titles, status, symptom; none without a report), `rerunArgs(test)` (its file plus `-t '^<escaped name>$'`), `verdict(test, rerun)` (`passes alone` / `fails alone` / `did not run`), `ledgerLine(test, date, task)` (symptom: first line, shortened), `branchTask(branch)` (`task-636-…` → `task-636`, else `task-?`).
- `main.ts`: each tested step (`pnpm check` with `pnpm test` as its rerun, the live run with `pnpm test:integration` as its rerun) writes its report into a scoped temp directory; on failure it reruns each failed test once, one after another, each with its own report, prints the verdicts, appends ledger lines and fails with the original error. No failed tests in the report (lint, types, a failed deploy): fail as today.
- `flakes.md`: a short header, left out of `.oxfmtrc.json` so appended symptoms never fail `format:check`; `.gitattributes`: `flakes.md merge=union`; `LiveReach.ts`, its test and the AGENTS.md table: `.gitattributes` reaches no group.
- Tests: parsing a report with passed, failed and skipped tests and nested describes; no report; the `-t` pattern selects exactly the name (escaping regex characters); verdicts for each case; a line with a multi-line and a long symptom; the task from a branch name.
- Manual: a temporary unit test that fails on its first run and passes on the next (a marker file) makes `pnpm gate` red, reruns it, logs it to the ledger and stays red; a temporary always-failing test is reported `fails alone`; two tests sharing state that fail together and pass apart both pass alone. All removed before commit.

### T4 — Dated skips (`tools/oxlint/emailer/`, `oxlint.config.ts`, `tsconfig.json`)

- Plugin `emailer` with rule `flaky-skips`: report every `.skip` and `.runIf` member call and every `skip` property in an object passed to a call; on `.skipIf` member calls, require the condition `vi.getRealSystemTime() < Date.parse("<YYYY-MM-DD>")` and `flaky: task-<N> until <same date>` in a comment on the call's first line or the line above, the date at most 14 days after today (UTC).
- `oxlint.config.ts`: load the plugin; enable the rule for `**/*.test.ts` and `**/*.live.ts` in `overrides`.
- `tsconfig.json`: exclude only `tools/oxlint/anti-slop`, so the new plugin is typechecked.
- Tests (`flaky-skips.test.ts`, oxlint's `RuleTester` from `oxlint/plugins-dev`): the canonical form dated today + 14 days (the boundary) and one dated yesterday pass; today + 15 days, an unmarked `skipIf`, `skipIf(true)` with a marker, a condition date differing from the marker, `it.skip`, `describe.skip`, `it.effect.skip`, `ctx.skip()`, `it.runIf`, `describe.runIf`, `it.effect.runIf`, `{ skip: true }` and a malformed marker fail.
- Manual: an unannotated `.skip` in a real test file fails `pnpm lint`; a canonical skip dated yesterday runs and one dated tomorrow is skipped, also under `vi.useFakeTimers()` set past the date. Removed before commit.

### T5 — AGENTS.md, README

- AGENTS.md "Flaky tests" section: worker cap; the gate's rerun, verdicts and the ledger (replace the cause `?`, commit with the fix or skip); skips (the lint rule's marker and how it fails; flakes stay in the ledger for the orchestrator's fix batches, superseded in part by task 1534); whole live suite now and then by judgement; link the shared `awesome-tests` skill (it now holds the flake rules), keeping only emailer specifics.
- README "Develop and test": one line that heavy scripts wait for machine headroom through `agents heavy`.
- Reach table: `.gitattributes` joins the "none" row; `flakes.md` is `**/*.md` (none).

### T6 — Gate and landing

- `pnpm leak-check && pnpm gate` via `agents land main`: this change touches `vitest.config.ts`, `package.json` and `tsconfig.json`, so the map runs every live group.

## Evidence

No UI. Key files and snippets from the landed commit; the gate output of the manual flake probe (T3) and the lint output of the skip probe (T4).

## Open questions

- None.
