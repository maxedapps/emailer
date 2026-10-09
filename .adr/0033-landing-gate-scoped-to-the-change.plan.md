# Plan: A landing gate that runs only the live groups a change reaches

- Status: In progress
- Decision: [ADR-0033](0033-landing-gate-scoped-to-the-change.md)

## Goal

**Done when:**

- `pnpm gate` runs `pnpm check`, prints the merge base, each changed path's reach and the selected groups, and runs the live suite for those groups only (or not at all).
- AGENTS.md maps the live suite, its groups and the paths reaching each, and names `pnpm gate` as the command to run before landing; the README's "Develop and test" names it too.
- Proof: unit tests of the map; `pnpm gate` on a docs-only change deploys no stage; on a change reaching one group it deploys one stage, runs only that group's tests and destroys the stage.

**Out of scope:** changing what `pnpm check` runs; the AWS pieces of the account's other sender (on hold); new live tests.

## Rules for every task

- Worktree `~/worktrees/emailer/task-590-adaptive-gate`, branch `task-590-adaptive-gate`; `pnpm check` green per commit.
- Live runs take their own fresh stage and destroy it; `pnpm stages list` must not show it afterwards.

## Tasks

### T1 — Groups as Vitest tags

- `apps/backend/test/LiveGroups.ts`: `liveGroups` (`api`, `cancellation`, `drafting`, `variants`, `unsubscribe`, `subscriptions`, `feedback`), the `LiveGroup` type, and the `TestTags` augmentation so `tags` is typed.
- `vitest.config.ts`: the integration project declares one tag per group.
- `Live.integration.test.ts`: `suites` maps each group to its suite (`satisfies Record<LiveGroup, …>`); each runs inside `describe(group, { tags: group }, …)`.
- Verify: `vitest list --project integration --tags-filter=<group>` lists only that group's tests (collection deploys nothing).

### T2 — The map (`tools/gate/LiveReach.ts`, tested in `LiveReach.test.ts`)

- `reach(path)`: `"all"` or the groups a path reaches, first matching rule wins (`path.matchesGlob`), unmatched paths reach all. Rules as in the ADR.
- `selected(paths)`: the union, in `liveGroups` order.
- Tests: docs, ADRs, unit tests, CLI and tooling reach nothing; the stack, live support, configs, any `package.json`, the lockfile and an unknown path reach all; each `.live.ts` reaches its group; a preview-page change reaches drafting and variants; a feedback change reaches its four groups; a mixed list unions; a docs-only list selects nothing.

### T3 — Shared process helpers (`tools/Process.ts`)

- `run(command, args)` (terminal output) and `read(command, args)` (stdout), both failing with `CommandFailed` on a non-zero exit; Effect's `ChildProcessSpawner.lines`/`string` do not check the exit code.
- `tools/stages/main.ts` uses them instead of its own Alchemy-only copies; behaviour unchanged.
- Tests (`Process.test.ts`): `read` returns stdout; `read` and `run` fail with `CommandFailed` on a non-zero exit, so a failed check or live run fails the gate.

### T4 — `pnpm gate` (`tools/gate/main.ts`)

- Effect CLI like `pnpm stages`: `pnpm check`; then `changes` (`tools/gate/Changes.ts`): `git merge-base origin/main HEAD`, `git diff --name-only --no-renames -z <base>` plus `git ls-files --others --exclude-standard -z` (NUL-separated, so Git never quotes a non-ASCII path), each bounded by a 1-minute timeout; prints base, `path → reach` lines and the groups; runs `pnpm test:integration` with `--tags-filter` for a subset, without one for all, or skips it.
- Tests (`Changes.test.ts`, a real Git fixture): committed, staged, unstaged and untracked paths and both rename sides are listed, a non-ASCII docs path verbatim, ignored files are not; the integration branch's own later commits are not; a missing integration branch fails instead of yielding an empty diff.
- Timeouts: 15 minutes for the check, 2 hours for the live run (deploy and destroy of up to 30 minutes each, the slowest group between).
- Wiring: `package.json` script `gate`; `tsconfig.json` and the unit project include `tools/**` (not the vendored oxlint plugins).

### T5 — Docs

- AGENTS.md: a short "Landing gate" section: `pnpm gate` before landing, the live suite and its groups with the paths reaching each, how to extend the map.
- README "Develop and test": `pnpm gate`, and that `-t` picks single tests while the gate picks groups.

### T6 — Verify

- Unit tests and `pnpm check` while iterating.
- Probe clone (`~/tmp`), whose `origin/main` is this branch's commit, so only the probe change counts: `pnpm gate` on a docs-only change deploys no stage and exits 0; on a comment in `apps/backend/src/consent/UnsubscribePage.ts` it deploys one stage, runs only the `unsubscribe` tests and destroys the stage; `pnpm stages list` clean.
- The real `pnpm gate` once on the merged result before landing: this change touches the live file, `vitest.config.ts` and `package.json`, so it runs every group.

## Evidence

No UI. Key files and snippets from the landed commit, plus the two gates' selection output.

## Open questions

None.
