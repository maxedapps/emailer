import { Marked } from "marked";

import type { Tokens } from "marked";

/**
 * Markdown to email, in one module: an HTML rendering whose every element carries its own inline
 * style inside a fixed 600px layout, and a plain-text rendering of the same tokens. Gmail drops
 * `<style>` for most accounts and classic Outlook ignores CSS widths, so nothing here relies on a
 * stylesheet or on `max-width` alone (ADR-0019).
 */

const fontStack = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const monoStack = "Menlo,Consolas,monospace";

/** Wide enough for the card's content box: 600px less 24px padding on each side. */
const imageWidth = 552;

export const styles = {
  h1: "font-size:28px;line-height:1.25;margin:0 0 16px;color:#111111;",
  h2: "font-size:21px;line-height:1.3;margin:32px 0 12px;color:#111111;",
  h3: "font-size:18px;line-height:1.35;margin:24px 0 8px;color:#111111;",
  p: "margin:0 0 16px;",
  a: "color:#0a66c2;text-decoration:underline;",
  list: "margin:0 0 16px;padding-left:24px;",
  li: "margin:0 0 6px;",
  blockquote: "margin:0 0 16px;padding:8px 16px;border-left:4px solid #d0d7de;color:#57606a;",
  code: `font-family:${monoStack};font-size:14px;background-color:#f6f8fa;padding:2px 4px;`,
  pre: `font-family:${monoStack};font-size:14px;background-color:#f6f8fa;padding:12px;white-space:pre-wrap;margin:0 0 16px;`,
  img: `display:block;width:100%;max-width:${imageWidth}px;height:auto;border:0;`,
  table: "border-collapse:collapse;width:100%;margin:0 0 16px;",
  cell: "border:1px solid #d0d7de;padding:6px 10px;",
  hr: "border:0;border-top:1px solid #d0d7de;margin:24px 0;",
} as const;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * The page every Markdown campaign shares: a fluid table capped at 600px, with an Outlook-only
 * fixed-width wrapper, on a light page colour the backend's footer repeats.
 */
export const layout = (title: string, body: string): string => `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;">
<tr><td style="padding:32px 24px;font-family:${fontStack};font-size:16px;line-height:1.6;color:#1f2328;">
${body}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;

const headingStyles = [styles.h1, styles.h2];

const headingStyle = (depth: number): string => headingStyles[depth - 1] ?? styles.h3;

const titleAttribute = (title: string | null | undefined): string =>
  title === null || title === undefined || title === "" ? "" : ` title="${escapeHtml(title)}"`;

// Every override escapes what it interpolates itself: marked escapes text tokens in its own
// renderers, but an override that emits `href`, `alt` or code text replaces that escaping.
const htmlRenderer = new Marked({
  renderer: {
    heading({ tokens, depth }) {
      return `<h${depth} style="${headingStyle(depth)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    paragraph({ tokens }) {
      return `<p style="${styles.p}">${this.parser.parseInline(tokens)}</p>\n`;
    },
    link({ href, title, tokens }) {
      return `<a href="${escapeHtml(href)}"${titleAttribute(title)} style="${styles.a}">${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, title, text }) {
      // The width attribute is what classic Outlook honours; the CSS keeps it fluid elsewhere.
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttribute(title)} width="${imageWidth}" style="${styles.img}">`;
    },
    list(token) {
      const tag = token.ordered ? "ol" : "ul";

      const start =
        token.ordered && token.start !== "" && token.start !== 1 ? ` start="${token.start}"` : "";

      const items = token.items
        .map((item) => `<li style="${styles.li}">${this.parser.parse(item.tokens)}</li>\n`)
        .join("");

      return `<${tag}${start} style="${styles.list}">\n${items}</${tag}>\n`;
    },
    blockquote({ tokens }) {
      return `<blockquote style="${styles.blockquote}">\n${this.parser.parse(tokens)}</blockquote>\n`;
    },
    codespan({ text }) {
      return `<code style="${styles.code}">${escapeHtml(text)}</code>`;
    },
    code({ text }) {
      return `<pre style="${styles.pre}">${escapeHtml(text)}</pre>\n`;
    },
    hr() {
      return `<hr style="${styles.hr}">\n`;
    },
    table(token) {
      const cell = (content: Tokens.TableCell, tag: "th" | "td") =>
        `<${tag} style="${styles.cell}text-align:${content.align ?? "left"};">${this.parser.parseInline(content.tokens)}</${tag}>`;

      const head = `<tr>${token.header.map((content) => cell(content, "th")).join("")}</tr>`;

      const rows = token.rows.map(
        (row) => `<tr>${row.map((content) => cell(content, "td")).join("")}</tr>`,
      );

      return `<table width="100%" cellpadding="0" cellspacing="0" style="${styles.table}">\n${[head, ...rows].join("\n")}\n</table>\n`;
    },
  },
});

// A backslash escape reaches the text renderer as an HTML entity; everything else stays raw.
const unescapeHtml = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const textRenderer = new Marked({
  renderer: {
    heading({ tokens }) {
      return `${this.parser.parseInline(tokens).toUpperCase()}\n\n`;
    },
    paragraph({ tokens }) {
      return `${this.parser.parseInline(tokens)}\n\n`;
    },
    strong({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    em({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    del({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    codespan({ text }) {
      return text;
    },
    br() {
      return "\n";
    },
    text(token) {
      if ("tokens" in token && token.tokens !== undefined) {
        return this.parser.parseInline(token.tokens);
      }

      return "escaped" in token && token.escaped === true ? unescapeHtml(token.text) : token.text;
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);

      return label === href ? href : `${label} (${href})`;
    },
    image({ text }) {
      return text === "" ? "" : `[${text}]`;
    },
    list(token) {
      const first = token.ordered && token.start !== "" ? token.start : 1;

      const items = token.items.map((item, index) => {
        const marker = token.ordered ? `${first + index}.` : "-";

        return `${marker} ${this.parser.parse(item.tokens).trim()}`;
      });

      return `${items.join("\n")}\n\n`;
    },
    blockquote({ tokens }) {
      const quoted = this.parser.parse(tokens).trim().split("\n");

      return `${quoted.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n")}\n\n`;
    },
    code({ text }) {
      return `${text}\n\n`;
    },
    hr() {
      return "---\n\n";
    },
    table(token) {
      const row = (cells: ReadonlyArray<Tokens.TableCell>) =>
        cells.map((content) => this.parser.parseInline(content.tokens)).join(" | ");

      return `${[row(token.header), ...token.rows.map(row)].join("\n")}\n\n`;
    },
    html({ text }) {
      return text;
    },
    space() {
      return "";
    },
  },
});

interface RenderedBody {
  readonly text: string;
  readonly html: string;
}

/** Both parts of a campaign from one Markdown source. The subject titles the HTML document. */
export const renderMarkdown = (markdown: string, subject: string): RenderedBody => ({
  text: textRenderer
    .parse(markdown, { async: false })
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim(),
  html: layout(subject, htmlRenderer.parse(markdown, { async: false })),
});
