# ADR-0035: Capped test workers, a lone rerun in the gate, a flake ledger and dated skips

- Status: Accepted
- Date: 2026-10-10
- Authority: The operator decided, for every project (task 636): cap Vitest at 4 workers and run every heavy script through `agents heavy`; when the gate goes red it reruns each failing test alone once and logs a pass to a flake ledger, and stays red; each skipped test carries its task and a date and expires after 14 days, with its own fix task; whole suites run when agents judge it worth it, on no schedule.
- Plan: [0035-flaky-tests-rerun-ledger-and-dated-skips.plan.md](0035-flaky-tests-rerun-ledger-and-dated-skips.plan.md)

## Context

- **Vitest runs one worker per core but one** (`availableParallelism() - 1` outside watch mode). On a 20-core machine shared by many worktrees that is 19 workers a run, the setting that overloaded the machine on 9 Oct; nothing here caps it.
- **Nothing here waits for headroom.** `agents land` runs the gate through `agents heavy`, but a live run or a stage deploy started by hand (`pnpm test:integration`, `pnpm stages up|down|sweep`) does not.
- **A red gate leaves the lone rerun to the agent,** and nothing records a test that passed alone, so the next agent investigates the same flake again.
- **Nothing bounds a skipped test:** there are none today, and nothing stops one from staying forever.
- **The live suite drives the deployed stack on AWS,** the system under test, not an outside service: no model, no third-party network. ADR-0033 already runs only the groups a change reaches. Its slowest test, the 400-member bounce breaker (up to 20 minutes), flaked once (task 241) and guards the reputation breaker (ADR-0012).

## Decision

1. **Four workers.** The root Vitest config sets `maxWorkers: 4`; both projects share the pool.
2. **Heavy scripts wait for headroom themselves.** `pnpm test:integration` runs `agents heavy -- node … vitest …`; `pnpm stages` runs each Alchemy deploy and destroy through `agents heavy --`, while `list` stays direct. Inside a heavy run (`agents land`'s gate) the nested call starts at once. `pnpm gate` and `pnpm check` stay direct: the gate's only heavy part is the live run.
3. **The gate reruns each red test alone and logs a pass.** The gate sets `GATE_TEST_REPORT`, and only then the Vitest config adds Vitest's `json` reporter (writing there) to the default ones. When `pnpm check` or the live run fails and the report lists failed tests, the gate reruns each of them once, one after another, in a run of its own: `pnpm test <file> -t '^<name>$'` for a unit test, `pnpm test:integration <file> -t '^<name>$'` (its own fresh stage) for a live one. Names are `describe > … > test`, built from the report's titles as `-t` matches them, escaped and anchored. A test that passes alone is a flake: the gate appends a line to the ledger and prints it. A test that fails again is a bug. The gate fails either way. A run that fails before its tests (lint, types, a failed deploy) lists none and fails as before.
4. **The ledger is `flakes.md` at the repo root,** as the shared `awesome-tests` skill defines it: one line per "passes alone" verdict, `- <date> task-<N> \`<file> > <test>\` — <symptom> — cause: ?`. The gate takes the task from the branch name (`task-<N>-…`, else `task-?`) and the symptom from the first line of the failure; the agent replaces the `?` with the suspected cause and commits the line with the fix or the skip. `.gitattributes` sets `flakes.md merge=union`, so parallel branches never conflict on it, and the formatter leaves it alone, so an appended symptom never fails `pnpm check`. As a doc it reaches no live group, nor does `.gitattributes` (added to the "none" rule); the leak check covers both like any changed file.
5. **A skip expires by itself.** The shared skill's form: `it.skipIf(vi.getRealSystemTime() < Date.parse("<until>"))(…) // flaky: task-<N> until <until>`, `<until>` 14 days after the skip, so the test runs again from that day on, fake timers or not; each skip gets a fix task (`agents plan`). A local oxlint rule, `emailer/flaky-skips`, runs in `pnpm check` on test files (`*.test.ts`, `*.live.ts`) and allows no other skip: a `.skip` call (`it.skip`, `describe.skip`, `it.effect.skip`, `ctx.skip()`) or a `skip` option fails, and so does a `.skipIf` whose condition is not exactly that comparison, whose marker (on its line or the line above) is missing or names another date, or whose date is more than 14 days ahead. A date that has passed is fine: the test runs again, and the dead `skipIf` goes with the fix.
6. **The live suite stays in the gate, scoped as ADR-0033 maps it.** It is the only test of the deployed stack, so moving any group out would land the changes reaching it unverified; it calls no outside service; and the map already keeps it out of changes that do not reach it. The breaker test stays: it guards the breaker, and one flake in its history is a ledger row, not a reason to drop it.
7. **Whole suites when worth it.** The unit suite always runs whole. AGENTS.md asks agents to run the whole live suite (`pnpm test:integration`) now and then on their own judgement: after a broad change, or when the scoped gate has not run a group in a while; not on every change, and to say so and adapt when such runs keep timing out.

## Alternatives

- **Leave the rerun to agents** (the simplest option). Keeps the gate as it is, but every red gate costs a manual rerun and nothing is recorded. The operator chose automation.
- **Always write the JSON report** from the config. No environment variable, but every `pnpm test` prints a report line and a red `pnpm check` that stopped before the tests would leave a stale report for the gate to misread.
- **Vitest's programmatic API (`startVitest`)** to read failed tests in memory. No report file, but the gate would have to run the unit tests and the live suite itself instead of through `pnpm check` and `pnpm test:integration`, duplicating both scripts.
- **`file:line` filters for the rerun.** Exact, but needs `includeTaskLocation`, and every live test is declared through the live file's one `test(...)` wrapper, so they would all share one line.
- **All failed tests in one rerun** (`-t '^(a|b)$'`, file parallelism off). One stage deploy for any number of live failures, but two failed tests of one file still share the run and its `beforeAll` state, so an interference between them reads as "fails alone": not alone.
- **Fail `pnpm check` once a skip's date has passed.** Forces deleting the dead condition, but turns `main` red for every worktree on that day, though the test already runs again; the shared rules chose the self-expiring form.
- **Skips through Vitest itself** (a quarantine tag with `skip: true`, or a reporter reading test `meta`). Vitest-native, but every wrapper (`@effect/vitest`, the live `test`) would need to pass options through, and a plain `.skip` would still slip past without a lint rule.
- **Move the breaker test, or whole groups, to an on-demand run.** Saves up to 20 minutes on gates reaching the `api` group, but a change to the breaker or feedback path would land without its only end-to-end check.

## Consequences

- At most four test workers per run; unit runs on a 20-core machine take a few seconds longer.
- A red gate prints a verdict per failed test and may add ledger rows; the agent fixes or skips each flake and fills its row before landing.
- A red live run pays one more stage deploy per failed test, one after another: a bug failing many live tests holds the gate for a deploy and destroy each.
- A skipped test runs again 14 days later without anyone acting; its dead `skipIf` is deleted with the fix.
- `pnpm gate` itself stays direct: its fast checks start at once, and its one heavy part, the live run, waits for headroom through `pnpm test:integration`.
- Running cost: none for the service, which is unchanged. Test spend rises only on a red live run (a stage deploy and the simulator sends per failed test); the worker cap and headroom waits cost nothing.
