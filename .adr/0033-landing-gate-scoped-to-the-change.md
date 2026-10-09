# ADR-0033: A landing gate that runs only the live groups a change reaches

- Status: Accepted
- Date: 2026-10-09
- Accepted: 2026-10-09, after one plan review with the Codex reviewer (precedence of docs over shared support, exact narrow paths)
- Authority: The user decided that checks scale with the change, in every project: the fast checks run whole, and a repository's gate runs only the slow tests its change reaches, mapped in its AGENTS.md and selected against the integration branch; where the mapping is unsure, the test runs (no nightly run backs it up).
- Confirmed: 2026-10-09 by unit tests and a docs-only gate run (no stage); the groups' first live run waits for an AWS login (plan T6)
- Plan: [0033-landing-gate-scoped-to-the-change.plan.md](0033-landing-gate-scoped-to-the-change.plan.md)

## Context

- **`pnpm check` is fast and offline**: format, lint, knip, typecheck, unit tests, import probe.
- **The live suite is the one slow suite.** `pnpm test:integration` deploys a fresh stage, runs all seven suites in one file (Alchemy's harness deploys one stage per file) and destroys it: minutes of deploy and destroy plus suites with send timeouts of up to 20 minutes. Nothing selects suites; a docs fix that runs it pays for the whole thing.
- **Static import reach cannot pick groups.** The live file imports `alchemy.run.ts`, which imports every Lambda and so almost all of `apps/backend/src`, and every group drives the deployed stack through the API. `vitest related` would select the one file for any backend change. Which group a module reaches is a fact about the contract it serves, not about imports.

## Decision

1. **`pnpm gate` is the one command to run before landing.** It runs `pnpm check`, then lists the paths changed against `git merge-base origin/main HEAD` (committed, uncommitted and untracked, both sides of a rename), prints each path's reach and the selected groups, and runs `pnpm test:integration` for those groups only, or not at all.
2. **Groups are Vitest tags.** `apps/backend/test/LiveGroups.ts` names the groups; the integration project declares them as tags, and the live file wraps each suite in a `describe` tagged with its group, typed so every group has exactly one suite. The gate passes `--tags-filter="a || b"`; a change reaching every group passes no filter. `-t` stays for picking single tests by hand.
3. **A hand-written map, first match wins** (`tools/gate/LiveReach.ts`, unit-tested; the table in AGENTS.md lists every path):
   1. **Docs reach no group,** wherever they sit (`**/*.md`, `.adr/**`, `LICENSE`), so a README beside the live support deploys nothing.
   2. **Inputs of every run reach all groups:** the stack (`alchemy.run.ts`), live support (`apps/backend/test/**`, `tools/stages/TestStage.ts`), `vitest.config.ts`, `tsconfig*.json`, every `package.json`, the lockfile and `pnpm-workspace.yaml`. They come before the exemptions below, so the CLI's `package.json` or the live file still reach all.
   3. **What no live run deploys or loads reaches no group:** unit tests and their support, the CLI app, the separate sending-identity stack and its DNS module (not `identity/SendingIdentity.ts`, which the mailer imports), repo tooling (`tools/**`), lint, format and knip config. `pnpm check` covers them.
   4. **Modules serving one contract reach the groups exercising it:** each `*.live.ts` its own group; `campaigns/TestSends.ts` drafting; `campaigns/Previews.ts`, `PreviewPage.ts`, `Copies.ts` drafting and variants; `consent/UnsubscribePage.ts` unsubscribe; `consent/Subscriptions.ts` subscriptions; `feedback/Feedback.ts` and `FeedbackClassification.ts` api, drafting, variants and feedback (the groups awaiting mailbox feedback).
   5. **Anything else reaches all groups:** every other backend module and `packages/api` sit under every group's path through the API, and an unknown path is unsure. Modules that look narrow but are not stay here, such as `storage/Feedback.ts` (the cancellation group writes feedback through it) and `consent/Unsubscribe.ts` (every send mints its links).

## Alternatives

- **Keep `pnpm check` plus a manual `pnpm test:integration`** (the simplest option). Leaves the decision to whoever lands, so either docs changes deploy stages or backend changes land unverified. The shared rule asks for an automatic gate.
- **Live suite on or off, no groups.** Simpler map, but every backend change runs all seven groups, including the 20-minute breaker send, when a preview-page change reaches two.
- **Name filters (`-t`) instead of tags.** Works with a regex over describe names, but couples the gate to suite titles, and a renamed title silently selects nothing. Tags are declared, validated (`strictTags`) and typed.
- **Per-group Lambda reach from the import graph.** Computes which functions a file reaches, but every group goes through the API function, which imports almost everything, so it would select all groups for nearly every change.

## Consequences

- Docs, ADR, CLI, tooling and unit-test-only changes land on `pnpm check` alone; no stage is deployed.
- A change reaching some groups still pays one deploy and destroy, but skips the other groups' sends.
- The map is code: a new live suite adds its group to `LiveGroups.ts` (the live file will not type-check without its suite), and a new contract-specific module either joins a group rule or reaches all groups by default.
- Running cost: the service is unchanged; test spend falls, since fewer gates deploy stages or send to the simulator.
