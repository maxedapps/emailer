# Plan: campaigns are light only (ADR-0049)

Task 5198. [ADR-0049](0049-campaigns-are-light-only.md) holds the design and its cost.

## Goal

- Saving a draft or variant refuses an HTML part that declares dark support, naming the declaration and its place.
- Campaign authors read that campaigns are light only, in the README and AGENTS.md.
- Prod's unsent campaigns go out light.

## Non-goals

- Changing sent campaigns. Rechecking stored drafts at send. Outlook `[data-ogsc]` rules.

## Tasks

1. **Check** (`sending/Templates.ts`): `refuseDarkMode`, called by `validateParts` after the image check; the ADR-0044 tag reader generalised to `<meta>`. Unit: `Templates.test.ts`.
2. **Docs**: README (features, Markdown note, limits), AGENTS.md (light-only rule; "not used in production yet" replaced), ADR-0019 notes the amendment.
3. **Prod drafts**: list unsent campaigns read only, check each HTML part with the new check.
4. **Hand check** on a fresh test stage through the CLI: create, update and variants set with a dark body refused; a light and a Markdown body accepted. Then destroy the stage.

## Evidence

- The CLI's refusals and acceptances as printed, the prod draft findings, and the key files and snippets.

## Prod drafts

Read on 2026-11-27 with `campaigns list` and `campaigns get` on prod: each unsent campaign (two drafts, one scheduled) declares `color-scheme` and `supported-color-schemes` `light` and has no dark rule, so nothing needed a fix. Each sent campaign with hand-written HTML is refused by the new check at its `color-scheme` meta `light dark`; they stay as sent.

## Hand check

On a fresh test stage, through the CLI, with a hand-written body declaring `light dark` (meta, CSS and a `prefers-color-scheme: dark` rule):

- `campaigns create --html`, `campaigns update --html` and `campaigns variants set --html` were each refused: `InvalidTemplate`, part `html`, `the color-scheme meta "light dark" names dark: campaigns are light only (ADR-0049)`, line 4, column 1;
- the same body declaring `light` was accepted, and so was a `--markdown` body.

The landing gate ran all seven live groups green (43 tests) on its own stage, which it destroyed.

## Settled findings

- medium bug: CSS comments counted as content, so `color-scheme /* x */: light dark` and `prefers-color-scheme: /* x */ dark` passed and `color-scheme:light /* no dark support */` was refused — fixed: comments are blanked (offsets kept) before the CSS scans; all three are unit tests.
- medium security: ADR-0049 and its plan named people, the company, its product and prod campaign titles in a public repo — fixed: the authority is the operator's decision, prod findings are described generically, specifics stay in the private report.
