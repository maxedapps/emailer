# ADR-0019: Markdown campaign bodies rendered by the CLI

- Status: Accepted
- Date: 2026-09-23
- Accepted: 2026-09-23
- Confirmed: 2026-09-23. On the ephemeral stage `test`, a draft created from the reference newsletter rendered to about 5 KB of HTML. Its preview showed every element styled, the image at full card width, and the footer below the card, at desktop and at 390px width. A `[Test]` copy delivered to the operator's test inbox kept every inline style, and its text part carried no Markdown syntax. The stage was destroyed.
- Amended: review-fixes (`work/review-fixes.md`, in git history) — the plain-text part keeps a heading's own case (and its link's URL), reduces raw HTML to its text, decodes the basic entities, renders task items as `[x]`/`[ ]`, and indents a list item's further lines and nested lists under its marker.
- Amended: 2026-09-24, on the user's decision after reviewing PR #4. Raw HTML in the plain-text part reads as the HTML part shows it. A raw link keeps its URL as `label (url)`. `<br>`, block tags and table cells end a line; a `<br>` at the end of a source line ends only that line. `<style>`/`<script>` contents are dropped. Before, a raw link lost its URL and words on either side of those tags ran together.
- Authority: On 2026-09-23 the user asked for Markdown authoring with email-conformant HTML output, and asked for MJML and other tools to be evaluated. After seeing the research, they followed the recommendation to use `marked` alone, in the CLI. See the plan (`work/drafting-and-preview.md`, in git history).

## Context

- **Today's input.** A campaign takes a required plain-text file and an optional hand-written HTML file, both sent verbatim. The backend appends the unsubscribe and postal-address footer (ADR-0004).
- **Operators want to write once.** They want to write one Markdown file and get both parts.
- **Email HTML is not web HTML:**
  - Gmail drops `<style>` for non-Google accounts, so styles must be inline.
  - Classic Outlook ignores CSS widths, and Microsoft supports it until at least 2029.
  - Dark-mode media queries are unsupported in Gmail and classic Outlook.
- **Where rendering could run:** in the Lambdas, which stay lean, or in the CLI, which is today the only place campaigns are created.

## Decision

- **The CLI renders `--markdown <file>`.** The API contract keeps `text` and `html`. The stored draft is exactly what is sent, and the Markdown source is not stored.
- **`marked` is the only new dependency** (MIT, no transitive packages).
  - **HTML:** one instance with renderer overrides writes inline styles onto every element, and every override escapes its own output. Images get `width="552"` plus fluid CSS.
  - **Layout:** the output goes into one fixed layout:
    - a fluid table with a 600px max width, plus an Outlook-only 600px wrapper;
    - `color-scheme: light`, `lang`, and the viewport and Apple reformatting metas.
  - **Plain text:** a second instance renders the same tokens as text. Headings keep their text, links come out as `label (url)`, images as `[alt]`, tables as `a | b` and task items as `[x]`/`[ ]`. Raw HTML is reduced to the text the HTML part shows: raw links as `label (url)`, a line break wherever `<br>`, a block tag or a table cell ends one, and no `<style>`/`<script>` contents.
- **The backend footer is a self-contained styled block.** It is still inserted before the last `</body>`, so it renders cleanly below the layout and below hand-written HTML.
- **`--text`/`--html` remain for hand-written bodies,** and are mutually exclusive with `--markdown`.

## Alternatives considered

- **MJML 5.**
  - It is stable and maintained, and inlining works.
  - But its Outlook and responsive guarantees cover only its own `mj-*` components. Markdown inside `mj-text` gets inlining and nothing else.
  - Unscoped element rules leaked into MJML's own layout tables in the experiment, and images still lacked the width attribute.
  - It adds 234 packages (61 MB) for a single-column wrapper that about 30 lines replace.
  - Worth revisiting only for designed multi-column templates, which would be authored in MJML rather than Markdown.
- **marked + juice.** It works, but its 45 packages only save writing the styles inline. The image width attribute is still missing.
- **react-email.** It needs JSX, and therefore a build step for a CLI that Node runs directly. Its Markdown component is stale and left images and tables unstyled.
- **Maizzle.** A Vite, Vue and Tailwind framework, not a library.
- **Plain text via `html-to-text` over the HTML.** An extra dependency whose v10 ships no types, and its defaults flatten tables. Rendering from the tokens needs nothing.
- **Plain text as the Markdown source verbatim.** It leaves `**`, `[label](url)` and table pipes in the text part.
- **Rendering in the backend.** It would store Markdown and render at send time. That adds weight to every Lambda and a second representation of the body, for no present consumer beyond the CLI.

## Consequences

- **One look for every Markdown campaign:** there is no theme or template configuration. Changing it means changing the layout in `apps/cli/src/Markdown.ts`.
- **Raw HTML passes through unstyled.** HTML embedded in Markdown is passed through by marked without the inline styles. That is acceptable for operator-authored content.
- **Images must be absolute https URLs.** In classic Outlook every image displays at 552px, so small images are upscaled.
- **The footer duplicates two layout colors,** so it matches without knowing the layout.
- **Real-client rendering is proven only by the live gate,** through a test send to a real inbox. No rendering-farm check is made.
- **A future MCP campaign tool** needs the same renderer. The module moves to a shared package then, not before.

## Confirmation

- Unit tests pin:
  - every element's inline style;
  - escaping in text, code, and link and image attributes;
  - the image width attribute;
  - the text rendering;
  - the output size for the reference newsletter.
- A CLI test proves `create --markdown` sends the rendered body.
- The live gate reads one delivered test message's headers and checks its rendering in a real inbox, with the user's permission.

## References

- Plan (`work/drafting-and-preview.md`, in git history)
- [ADR-0004: Sender-owned one-click unsubscribe](0004-sender-owned-one-click-unsubscribe.md)
- [marked](https://marked.js.org/) 18.0.14 — [renderer overrides](https://marked.js.org/using_pro#renderer)
- [MJML 5 release](https://github.com/mjmlio/mjml/releases/tag/v5.0.0)
- [caniemail: `<style>`](https://www.caniemail.com/features/html-style/), [caniemail: `prefers-color-scheme`](https://www.caniemail.com/features/css-at-media-prefers-color-scheme/)
- [Microsoft: Outlook for Windows availability](https://learn.microsoft.com/en-us/microsoft-365-apps/outlook/get-started/guide-product-availability)
