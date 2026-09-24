# HTML email

[Deliverability](../aws/deliverability.md) · [SES](../aws/ses.md)

Email HTML is rendered by clients that never adopted most of the web platform. It needs a narrower dialect than a web page: tables for layout, inline styles, fixed widths an old engine understands, and a plain-text part that reads well on its own. This page records what that dialect requires and how the CLI's Markdown rendering meets it ([ADR-0019](../../.adr/0019-markdown-campaign-bodies.md)).

## What the clients require

| Requirement | Why |
| --- | --- |
| Inline every style | Gmail drops `<style>` blocks for non-Google accounts, and several webmail clients rewrite or strip them. An element's own `style` attribute survives. [caniemail: `<style>`](https://www.caniemail.com/features/html-style/) |
| Lay out with tables: a fluid table capped at 600px, plus an Outlook-only 600px table | Classic Outlook for Windows renders with Word's engine and ignores `max-width`. A conditional `<!--[if mso]>` table with `width="600"` holds the column there. Microsoft supports classic Outlook until at least 2029. [Outlook availability](https://learn.microsoft.com/en-us/microsoft-365-apps/outlook/get-started/guide-product-availability) |
| `width` attribute on images | Outlook sizes an image from the attribute, not from CSS. Give the attribute the content width (552px inside a 600px card with 24px padding) and keep `width:100%;max-width:552px;height:auto` for the fluid clients. In Outlook every image is then shown at 552px, so small images are upscaled. |
| Absolute `https://` image URLs | Nothing resolves a relative URL inside a message, and many clients refuse plain `http`. |
| `<meta name="color-scheme" content="light">` | Gmail and classic Outlook do not support `prefers-color-scheme`, so a designed dark mode cannot work everywhere. Declaring light keeps the clients that respect it from inverting colours. [caniemail: `prefers-color-scheme`](https://www.caniemail.com/features/css-at-media-prefers-color-scheme/) |
| Stay well under about 102 KB of HTML | Gmail clips a longer message behind "View entire message", and the unsubscribe footer is at the end. |
| A real plain-text part | Some clients and filters read it. It should read like text, not like Markdown source with `**` and `](`. |

## Rendering Markdown with `marked`

`marked` (MIT, no dependencies, bundled types) renders Markdown to HTML with overridable renderers. The CLI creates **two instances** from the same source:
- **HTML:** overrides for headings, paragraphs, links, images, lists, blockquotes, code spans, code blocks, rules and tables. Each writes its element with an inline `style`.
- **Text:** overrides turn the same tokens into plain text: headings as their own text, links as `label (url)`, images as `[alt]`, table rows as `a | b`, quotes prefixed `> `, task items as `[x]`/`[ ]`, and raw HTML reduced to its text.

The HTML output is wrapped in one fixed layout. The reference newsletter renders to about 5 KB. [Renderer overrides](https://marked.js.org/using_pro#renderer)

**The escaping trap.** `marked` escapes text only in its own renderers. An override that interpolates `href`, `alt`, a title or code text must escape each value itself. The first prototype's code-span override forgot this and passed `<`, `>` and `&` through as markup. Escape each value exactly once: a URL with a query string must come out with `&amp;`, never `&amp;amp;`. In the text instance the reverse applies. `marked` keeps a named entity such as `&amp;` in a text token as written, so the `text` renderer decodes the basic entities itself, `&amp;` last so each one is decoded once.

`marked` passes raw HTML embedded in Markdown through without styling. That is acceptable for content an operator writes, not for untrusted input.

## Tools that were rejected

| Tool | Finding |
| --- | --- |
| MJML 5 | Its Outlook and responsive guarantees cover only its own `mj-*` components. Markdown inside `mj-text` gets inlining and nothing else, unscoped element rules leaked into MJML's layout tables, and images still lacked the `width` attribute. It adds 234 packages. |
| juice (CSS inliner) | It only saves writing styles inline; the image `width` attribute is still missing. |
| react-email | It needs JSX and a build step, and its Markdown component left images and tables unstyled. |
| html-to-text | A dependency whose defaults flatten tables. Rendering text from the Markdown tokens needs nothing extra. |

## Checking a rendering

Unit tests can pin every element's style, the escaping and the output size, but not how a real client draws the message. Look at it twice: in the preview page (`campaigns preview`), which shows the HTML part in a sandboxed frame at desktop and phone widths, and in a real inbox through a `campaigns test` send. The footer the backend appends is its own styled block, so it renders the same below the Markdown layout and below hand-written HTML.
