# ADR-0034: The leak check runs in every landing

- Status: Accepted
- Date: 2026-10-10
- Authority: The emailer orchestrator decided that `agents land` must never push without the leak check, and that `pnpm gate` stays runnable while the pattern file is missing.
- Confirmed: 2026-10-10 by unit tests and a gate run on this change
- Superseded in part: 2026-10-12, task 793. agentmanager dropped `agents land`, its queue and the `agents-land` block. The same command is now the Check in AGENTS.md "Landing", run before every push with no separate turn check; read `agents land` below as that Check.

## Context

- **The leak check was a shell recipe** in AGENTS.md "Before pushing": a machine-local, lowercase grep `-E` pattern file, grepped case-insensitively against the files changed against `origin/main` and the commits `origin/main..HEAD` with their messages. Each agent retyped it before a push.
- **`agents land` now runs the whole landing turn** (agentmanager ADR 0289) from an `agents-land` block in AGENTS.md: the `gate` at HEAD before queueing, then, in the turn, a rebase onto `origin/main`, the `turn` check (the gate when none is declared), push. The turn check runs only when the rebase moved HEAD; a HEAD already on top of `origin/main` pushes on the gate it passed.

## Decision

1. **`pnpm leak-check`** (`tools/leak-check/`) is the recipe as a tool: it fails when the pattern file is missing or empty, lists the changed files (deletions excluded) the pattern matches and counts the matching lines of `git log -p --format=%B origin/main..HEAD`, and fails on any. It prints file names and a count, never the pattern or a matching line.
2. **The landing gate is `pnpm leak-check && pnpm gate`,** with no `turn` key, so the turn check is the same command. Every push `agents land` makes has passed it: at HEAD when the rebase did not move it, at the rebased HEAD when it did.
3. **`pnpm gate` itself stays without it,** so it runs by hand while a machine lacks the pattern file; only `agents land` refuses, and it could not push safely then anyway.

## Alternatives

- **The leak check in `turn` only.** Skipped whenever the rebase does not move HEAD, which is the common case, so a landing could push unchecked.
- **The leak check inside `pnpm gate`.** One command, but the gate could not run on a machine without the pattern file, though nothing it checks needs it.
- **Keep the shell recipe.** Nothing would enforce it in a landing.

## Consequences

- Without `~/.config/emailer/leak-pattern.txt`, `agents land` stops at the gate; `pnpm gate` by hand still runs.
- A PR body and a reading of the diff stay manual: the pattern misses some personal details.
- Running cost: none; it is local tooling.
