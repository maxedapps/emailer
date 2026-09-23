# ADR-0021: The check suite finds unused code across the whole project

- Status: Accepted
- Date: 2026-09-23
- Accepted: 2026-09-23
- Authority: On 2026-09-23 a whole-codebase review found dead types, a dead schema, an empty workspace package with an installed SDK, a parameter kept alive with a `_` prefix, and two lint suppressions that no longer suppressed anything. The user asked how that could survive linting, and chose to add knip. See [the plan](work/codebase-cleanup.md).

## Context

`pnpm check` formats, lints with type information, typechecks and runs the unit suite. Each of those looks at one file at a time, or at types only:

- **Exports:** oxlint's `no-unused-vars` treats an `export` as a use, so it cannot see an export that nothing imports. Oxlint 1.82 has no whole-project unused-exports rule, and the 1.83–1.85 releases added none.
- **Parameters:** the same rule deliberately accepts `_`-prefixed parameters, which is how an unused one stayed in place.
- **Suppressions:** an `oxlint-disable` comment keeps its place after the code it excused has changed.
- **Packages and dependencies:** no step asks whether a workspace package or a dependency is used at all.

## Decision

- **knip runs in `pnpm check`,** after lint, and must report nothing. It builds the import graph from the workspaces' entry points and reports:
  - unused files, exports and exported types;
  - duplicate exports;
  - unused and unlisted dependencies.
- **Its configuration names only what it cannot infer:**
  - **Entry points:** `alchemy.run.ts` and `stacks/*.ts`, which the Alchemy CLI loads by path.
  - **Ignored path:** the vendored `tools/oxlint/anti-slop` rules.
  - **Ignored dependency:** `@effect/language-service`, the tsconfig plugin key that `@effect/tsgo` reads, which is not a package.
  - **`packages/api`:** also checks entry exports. Its `./*` exports map makes every file an entry, and only this repository imports the package, so an export nothing here imports is dead rather than public.

  Test files count as entries, so an export a test imports is a use.
- **Lint reports unused disable directives,** and `--deny-warnings` turns them into failures. A suppression is removed when the code it excused no longer needs it.
- **Findings are fixed, not ignored.** Dead code is deleted and module-private names lose their `export`. A new ignore entry needs the same justification as those above.

## Alternatives considered

1. **ESLint's `import/no-unused-modules`.** The project lints with oxlint, which does not implement that rule. A second linter for one rule is more machinery than a dedicated tool.
2. **TypeScript's `noUnusedLocals` / `noUnusedParameters`.** These duplicate `no-unused-vars` and, like it, stop at the module boundary.
3. **A periodic manual review.** This review is what found the leftovers; making it the only safeguard means they accumulate between reviews.

## Consequences

- One more dev dependency and a short configuration file. `pnpm check` takes a few seconds longer.
- An export used only by a test stays exported. That is deliberate: the test is a real consumer.
- A new deploy-time entry point (another stack file loaded by path) must be added to `knip.config.ts`, or knip reports its modules as unused.

## References

- [knip documentation](https://knip.dev/)
- [Codebase cleanup plan](work/codebase-cleanup.md)
