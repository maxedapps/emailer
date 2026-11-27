# ADR-0049: Campaigns are light only

- Status: Proposed
- Date: 2026-11-27
- Authority: Task 5198. On 2026-11-27 the operator decided that every campaign goes out light only, future ones included.
- Amends: [ADR-0019](0019-markdown-campaign-bodies.md). Its layout's `color-scheme: light` was one look among any a hand-written HTML body could choose; it is now the only look a campaign may have, and the API enforces it.
- Plan: [0049-campaigns-are-light-only.plan.md](0049-campaigns-are-light-only.plan.md)

## Context

- **The Markdown layout is light only** (`apps/cli/src/Markdown.ts`): `color-scheme: light` and `supported-color-schemes: light`.
- **Hand-written HTML bypasses the layout.** Campaigns sent from prod as `--html` bodies declared `color-scheme: light dark`, with `prefers-color-scheme: dark` rules, so Apple Mail showed them dark.
- **Apple Mail darkens a message only when it opts in**, through the `supported-color-schemes` meta or the `color-scheme` CSS property naming `dark`; dark rules then come from `@media (prefers-color-scheme: dark)`.
- **Every stored body passes a save.** `create`, `update` and `setVariant` each run `validateParts`, which already refuses a hostless image (ADR-0044) with a 422 `InvalidTemplate`.

## Decision

- **`validateParts` refuses an HTML part that declares dark support:**
  - a `color-scheme` or `supported-color-schemes` meta whose `content` names `dark`;
  - a `color-scheme` or `supported-color-schemes` CSS declaration whose value names `dark`, in a `<style>` block or a `style` attribute;
  - `prefers-color-scheme: dark` anywhere: a media query, or a `media` attribute such as a `<source>`'s.
- **`light`, `only light` and `normal` pass,** and so does a `prefers-color-scheme: light` rule.
- **The refusal is the existing `InvalidTemplate`**, with `part: "html"`, a reason quoting the declaration (`the color-scheme meta "light dark" names dark: campaigns are light only (ADR-0049)`) and its line and column. The CLI already prints it.
- **Only the save checks**, as for images: `compileCopy` does not, so sending, test sends, previews and checks run as before.
- **The tag and attribute reader ADR-0044 wrote for `<img>` reads `<meta>` too**; two plain regexes find the CSS declarations and the media feature, with CSS comments blanked first, as CSS tokenizing skips them. No parser dependency.

## Alternatives considered

1. **Guidance only** (README, AGENTS.md). Free, and it is how the launch emails went out dark.
2. **Strip the dark declarations on save.** The stored body would differ from what the author previewed and tested, and the author would never learn the rule.
3. **Check in the CLI.** Misses every other API client, as ADR-0044 found for images.
4. **Also refuse Outlook's `[data-ogsc]` and `[data-ogsb]` rules.** They style Outlook's own dark rendering, not a declaration of support, and the decision names only the declarations above. Left out.
5. **An HTML and CSS parser.** Exact, but a new dependency in the API bundle for a check two regexes do on operator-written HTML (ADR-0044, alternative 5).

## Cost

- Three regex passes over at most 256 KiB of HTML in the API Lambda, on create, update and setVariant only, beside the Liquid parse and the image check. Well under a millisecond.
- DynamoDB, SQS, Lambda invocations and CloudWatch Logs: no change. A refusal is a business error that writes no error log.
- The sending path is untouched. Steady-state change: $0.

## Consequences

- A hand-written HTML body that declares dark support is refused at save, with the declaration and its place named. The author removes the dark declarations and rules, and declares `light`.
- The words `color-scheme: dark` in body text are refused too. A campaign has no reason to print them.
- Clients that darken every message on their own (some Gmail and Outlook apps) are outside the email's control.
- Stored drafts are not rechecked. On 2026-11-27 none of prod's unsent campaigns declared dark support; sent campaigns stay as they went out.

## Confirmation

- Unit tests (`sending/Templates.test.ts`): each refused form with its reason, line and column, and a light-only look accepted.
- Hand check on a test stage through the CLI: `campaigns create --html`, `campaigns update --html` and `campaigns variants set --html` with a `light dark` body are refused; a light body and a Markdown body are accepted.
- Landing gate on the merged result.
