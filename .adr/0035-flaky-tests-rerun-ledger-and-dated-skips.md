# ADR-0035: Capped test workers, a lone rerun in the gate, a flake ledger and dated skips

- Status: Proposed
- Date: 2026-10-10
- Authority: The operator decided, for every project (task 636): cap Vitest at 4 workers and run every heavy script through `agents heavy`; when the gate goes red it reruns each failing test alone once and logs a pass to a flake ledger, and stays red; each skipped test carries its task and a date and expires after 14 days, with its own fix task; whole suites run when agents judge it worth it, on no schedule.
- Plan: [0035-flaky-tests-rerun-ledger-and-dated-skips.plan.md](0035-flaky-tests-rerun-ledger-and-dated-skips.plan.md)

## Context

- **Vitest runs one worker per core but one.** On a 20-core machine shared by many worktrees that is 19 workers a run, the setting that overloaded the machine on 9 Oct; nothing here caps it.
- **Nothing here waits for headroom.** `agents land` runs the gate through `agents heavy`, but a live run or a stage deploy started by hand (`pnpm test:integration`, `pnpm stages up|down|sweep`) does not.
- **A red gate leaves the lone rerun to the agent,** and nothing records a test that passed alone, so the next agent investigates the same flake again.
- **Nothing bounds a skipped test:** there are none today, and nothing stops one from staying forever.
- **The live suite drives the deployed stack on AWS,** the system under test, not an outside service: no model, no third-party network. ADR-0033 already runs only the groups a change reaches. Its slowest test, the 400-member bounce breaker (up to 20 minutes), flaked once (task 241) and guards the reputation breaker (ADR-0012).

## Decision

1. **Four workers.** The root Vitest config sets `maxWorkers: 4`; both projects share the pool.
2. **Heavy scripts wait for headroom themselves.** `pnpm test:integration` runs `agents heavy -- node … vitest …`; `pnpm stages` runs each Alchemy deploy and destroy through `agents heavy --`, while `list` stays direct. Inside a heavy run (`agents land`'s gate) the nested call starts at once. `pnpm gate` and `pnpm check` stay direct: the gate's only heavy part is the live run.
3. **The gate reruns a red test alone and logs a pass.** The gate sets `GATE_TEST_REPORT`, and only then the Vitest config adds Vitest's `json` reporter (writing there) to the default ones. When `pnpm check` or the live run fails and the report lists failed tests, the gate reruns them once, in one run with file parallelism off, so each runs by itself without the rest of the suite: `pnpm test <files> -t '^(<name>|…)$' --no-file-parallelism` for unit tests, one fresh stage with `pnpm test:integration -t …` for the live suite. Names are `describe > … > test`, as `-t` matches them, escaped and anchored. A test that passes in the rerun is a flake: the gate appends a row to the ledger and prints it. A test that fails again is a bug. The gate fails either way.
4. **The ledger is `docs/flakes.md`,** one table row per "passes alone" verdict: date, test (file and name), task, symptom (the first line of the failure), suspected cause. The gate fills the date, test and symptom; the agent fills the task and the cause and commits the row with the fix or the skip. As a doc it reaches no live group; the leak check covers it like any changed file.
5. **A skip is dated and expires.** A local oxlint rule, `emailer/dated-skips`, runs in `pnpm check` on test files (`*.test.ts`, `*.live.ts`): every `.skip` or `.skipIf` call (`it.skip`, `describe.skip`, `it.effect.skip`, `ctx.skip()`) needs the comment `// Skipped <YYYY-MM-DD> in task <N>: <reason>` right above it, and fails 14 days after that date. AGENTS.md asks for a fix task per new skip (`agents plan`).
6. **The live suite stays in the gate, scoped as ADR-0033 maps it.** It is the only test of the deployed stack, so moving any group out would land the changes reaching it unverified; it calls no outside service; and the map already keeps it out of changes that do not reach it. The breaker test stays: it guards the breaker, and one flake in its history is a ledger row, not a reason to drop it.
7. **Whole suites when worth it.** The unit suite always runs whole. AGENTS.md asks agents to run the whole live suite (`pnpm test:integration`) now and then on their own judgement: after a broad change, or when the scoped gate has not run a group in a while; not on every change, and to say so and adapt when such runs keep timing out.

## Alternatives

- **Leave the rerun to agents** (the simplest option). Keeps the gate as it is, but every red gate costs a manual rerun and nothing is recorded. The operator chose automation.
- **Always write the JSON report** from the config. No environment variable, but every `pnpm test` prints a report line and a red `pnpm check` that stopped before the tests would leave a stale report for the gate to misread.
- **Vitest's programmatic API (`startVitest`)** to read failed tests in memory. No report file, but the gate would have to run the unit tests and the live suite itself instead of through `pnpm check` and `pnpm test:integration`, duplicating both scripts.
- **`file:line` filters for the rerun.** Exact, but needs `includeTaskLocation`, and every live test is declared through the live file's one `test(...)` wrapper, so they would all share one line.
- **Each failed test in its own run.** Strictly alone, but each failed live test would deploy its own stage; a bug failing ten tests would hold the gate for hours. One run with file parallelism off already runs each failed test by itself, without the suite or other workers around it.
- **Skips through Vitest itself** (a quarantine tag with `skip: true`, or a reporter reading test `meta`). Vitest-native, but every wrapper (`@effect/vitest`, the live `test`) would need to pass options through, and a plain `.skip` would still slip past without a lint rule.
- **Move the breaker test, or whole groups, to an on-demand run.** Saves up to 20 minutes on gates reaching the `api` group, but a change to the breaker or feedback path would land without its only end-to-end check.

## Consequences

- At most four test workers per run; unit runs on a 20-core machine take a few seconds longer.
- A red gate prints a verdict per failed test and may add ledger rows; the agent fixes or skips each flake and fills its row before landing.
- A red live run pays one more stage deploy for the rerun.
- A skip turns `pnpm check` red 14 days after its date, also on an untouched `main`.
- Running cost: none for the service, which is unchanged. Test spend rises only on a red live run (one more stage deploy and the failed tests' simulator sends); the worker cap and headroom waits cost nothing.
