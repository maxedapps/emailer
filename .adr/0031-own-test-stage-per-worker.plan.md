# Plan: One test stage per worker, and a sweep that spares live ones

- Status: Done (see the ADR's Confirmed line)
- Decision: [ADR-0031](0031-own-test-stage-per-worker.md)

## Goal

**Done when:**

- No instruction in the repository names a shared stage (`--stage test`, `test_$USER`, `ALCHEMY_TEST_STAGE`).
- `pnpm stages up|down|list|sweep` works against the account, and the live suite deploys a fresh `test-<id>` on each run.
- AGENTS.md has a "Test stages" section: create, use, tear down, who may open them.
- Proof: two stages alive at once, one backdated past 4 hours; `pnpm stages sweep` destroys only that one; the young one and every stage in another format survive; then the young one is destroyed and the account holds neither stage's resources.

**Out of scope:** the shared cloud-stages skill, other repositories, destroying stages in the old formats.

## Rules for every task

- Worktree `~/worktrees/emailer/cloud-stages-259`, branch `cloud-stages-259`; `pnpm check` green per commit.
- Never destroy a stage this work did not create (`test` and `test_<user>` belong to another worker). Before any sweep, `pnpm stages list` must show only this work's stages; the format is new, so no one else can hold one yet.

## Tasks

### T1 — Stage names (`tools/stages/TestStage.ts`)

- `make`: an Effect returning `test-<yyMMddHHmm>-<4 base36>` from `DateTime.now` and `Random`.
- `parse(name)`: the creation time for a name in exactly that format, else `None`.
- `isStale(name, now)`: true only for a parsed name created 4 hours or more before `now`.
- Tests (`TestStage.test.ts`): a made name parses back to its minute; `prod`, `shared`, `test`, `test_example`, `test-import`, a malformed time (month 13) and a missing or longer suffix are not test stages; a stage at 3 h 59 min is live and at 4 h stale; a name from the future is live.
- Wiring: `tsconfig.json` and the unit project include `tools/stages`; knip's entry list names the two stack files explicitly.

### T2 — The `pnpm stages` tool (`tools/stages/main.ts`)

- Effect CLI (`effect/unstable/cli`) with `up [stage]`, `down <stage>`, `list`, `sweep`; spawns `alchemy` through `ChildProcessSpawner` with `--config alchemy.run.ts --env-file .env.test`.
- `up`: a fresh name unless one is given (which must parse); `deploy --force --yes --no-input`, so a redeploy never keeps an old bundle; prints the stage.
- `down`: refuses a name that does not parse; `destroy --yes --no-input`.
- `list`: `alchemy state list Emailer`, whose lines are paths (`Emailer/<stage>/`); keeps the stages whose names parse, prints name, age and `stale`.
- `sweep`: destroys the stale ones one after another and names each; the first failure stops it.
- Every child inherits stderr (deploy and destroy inherit all output) and its exit code is checked: a non-zero exit fails the command, so a failed `state list` never reads as "no stages".
- The selection is pure and tested in `TestStage.test.ts`: `testStages(listOutput)` over real path-form output with stale, young, future, malformed and old-format entries, and `isStale` over the result.
- `package.json`: `"stages": "node tools/stages/main.ts"`.

### T3 — Live suite

- `Live.integration.test.ts`: `stage = Effect.runSync(TestStage.make)`, its name written to stderr at start (Vitest's agent reporter drops logs of passing tests, `Effect.log` included); the `prod` guard and `Test.defaultStage()` go.
- Verified by `pnpm test:integration -t "<one small suite>"`: it deploys a `test-<id>` stage, passes and destroys it.

### T4 — Docs

- AGENTS.md: the `--stage test` rule becomes a "Test stages" section (create, use, tear down, sweep, access, the 4-hour limit, never touch another worker's stage).
- README "Develop and test": the suite's stage, `pnpm stages`, a killed run.
- ADR-0026: an "Amended by ADR-0031" note on stage selection. Done plans (0025, 0028, 0029) and ADR-0009 keep their history as it happened.

### T5 — Proof (manual)

- Export CLI credentials and `AWS_REGION`.
- `pnpm stages up test-<now − 5 h>-<rand>` and `pnpm stages up` (fresh), both alive; `pnpm stages list` shows one stale, one live.
- `pnpm stages up <young>` again: a forced redeploy completes.
- `pnpm stages list` shows exactly these two before the sweep, nothing else.
- `pnpm stages sweep`; `pnpm stages list` and `alchemy state list Emailer` show the young one, `prod`, and the other worker's stages, and no longer the stale one.
- AWS inventory for the stale stage (functions `emailer-<stage>-*`, table, queues, log groups, alarms) is empty.
- `pnpm stages down <young>`; same inventory check; `alchemy state list Emailer` shows neither.

## Departures

- The script is `pnpm stages`, and its code lives in `tools/stages/`: pnpm 12 ships a built-in `pnpm stage` (package staging) that shadows any script of that name.
- `list` prints "No test stages" when there are none.

## Evidence

No UI. Key files and snippets from the landed commit, and the proof transcript (list → sweep → list → inventory).

## Open questions

None.
