// oxlint-disable-next-line effecttsgo/node-builtin-import
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { renderMarkdown, styles } from "./Markdown.ts";

const html = (markdown: string) => renderMarkdown(markdown, "Subject").html;

const text = (markdown: string) => renderMarkdown(markdown, "Subject").text;

const newsletter = readFileSync(new URL("../test/newsletter.md", import.meta.url), "utf8");

describe("renderMarkdown html", () => {
  it.each([
    ["# Title", `<h1 style="${styles.h1}">Title</h1>`],
    ["## Section", `<h2 style="${styles.h2}">Section</h2>`],
    ["### Detail", `<h3 style="${styles.h3}">Detail</h3>`],
    ["#### Deeper", `<h4 style="${styles.h3}">Deeper</h4>`],
    ["Plain words", `<p style="${styles.p}">Plain words</p>`],
    ["[label](https://example.com)", `<a href="https://example.com" style="${styles.a}">label</a>`],
    [
      "- one\n- two",
      `<ul style="${styles.list}">\n<li style="${styles.li}">one</li>\n<li style="${styles.li}">two</li>\n</ul>`,
    ],
    ["3. three\n4. four", `<ol start="3" style="${styles.list}">`],
    [
      "> quoted",
      `<blockquote style="${styles.blockquote}">\n<p style="${styles.p}">quoted</p>\n</blockquote>`,
    ],
    ["`code`", `<code style="${styles.code}">code</code>`],
    ["```\nblock\n```", `<pre style="${styles.pre}">block</pre>`],
    ["---", `<hr style="${styles.hr}">`],
  ])("styles %j inline", (markdown, expected) => {
    expect(html(markdown)).toContain(expected);
  });

  it("gives images the width attribute classic Outlook honours, and fluid CSS", () => {
    expect(html("![A chart](https://example.com/chart.png)")).toContain(
      `<img src="https://example.com/chart.png" alt="A chart" width="552" style="${styles.img}">`,
    );
  });

  it("renders a table with aligned, bordered cells", () => {
    const rendered = html("| Plan | Price |\n| ---- | ----: |\n| Pro | $19 |");

    expect(rendered).toContain(
      `<table width="100%" cellpadding="0" cellspacing="0" style="${styles.table}">`,
    );
    expect(rendered).toContain(`<th style="${styles.cell}text-align:left;">Plan</th>`);
    expect(rendered).toContain(`<th style="${styles.cell}text-align:right;">Price</th>`);
    expect(rendered).toContain(`<td style="${styles.cell}text-align:right;">$19</td>`);
  });

  it("escapes text, code spans and fenced code", () => {
    expect(html("A <b & c")).toContain("A &lt;b &amp; c");
    expect(html("`a < b && c`")).toContain(">a &lt; b &amp;&amp; c</code>");
    expect(html('```\n<div>"x"</div>\n```')).toContain(
      ">&lt;div&gt;&quot;x&quot;&lt;/div&gt;</pre>",
    );
  });

  it("escapes link and image attributes, and a query string's ampersand exactly once", () => {
    expect(html('[x](https://example.com/a?b=1&c=2 "Say \\"hi\\"")')).toContain(
      `href="https://example.com/a?b=1&amp;c=2" title="Say &quot;hi&quot;"`,
    );
    expect(html('![a "quoted" <alt>](https://example.com/i.png)')).toContain(
      `alt="a &quot;quoted&quot; &lt;alt&gt;"`,
    );
  });

  it("wraps the body in the light, fixed-width layout titled by the subject", () => {
    const rendered = renderMarkdown("Hello", 'Deals & "news"').html;

    expect(rendered.startsWith('<!doctype html>\n<html lang="en"')).toBe(true);
    expect(rendered).toContain('<meta name="color-scheme" content="light">');
    expect(rendered).toContain("<title>Deals &amp; &quot;news&quot;</title>");
    expect(rendered).toContain('<!--[if mso]><table role="presentation" width="600"');
    expect(rendered).toContain("max-width:600px;");
    expect(rendered.trimEnd().endsWith("</body>\n</html>")).toBe(true);
  });

  it("keeps the reference newsletter far below Gmail's clipping size", () => {
    expect(Buffer.byteLength(renderMarkdown(newsletter, "News").html)).toBeLessThan(20_000);
  });
});

describe("renderMarkdown text", () => {
  it.each([
    ["# Title", "Title"],
    ["Some **strong** and _soft_ ~~gone~~ words", "Some strong and soft gone words"],
    ["[label](https://example.com)", "label (https://example.com)"],
    ["<https://example.com>", "https://example.com"],
    ["![A chart](https://example.com/chart.png)", "[A chart]"],
    ["- one\n- two", "- one\n- two"],
    ["3. three\n4. four", "3. three\n4. four"],
    ["> first\n>\n> second", "> first\n>\n> second"],
    ["Press `?` to see", "Press ? to see"],
    ["```\nconst a = 1 < 2;\n```", "const a = 1 < 2;"],
    ["| a | b |\n| - | - |\n| 1 | 2 |", "a | b\n1 | 2"],
    ["A \\*literal\\* & <raw>", "A *literal* &"],
    ["---", "---"],
    ["- a\n  - b\n  - c\n- d", "- a\n  - b\n  - c\n- d"],
    ["1. one\n   continued\n2. two", "1. one\n   continued\n2. two"],
    ["- [x] done\n- [ ] todo", "- [x] done\n- [ ] todo"],
    ["- [x] done\n\n- [ ] todo", "- [x] done\n- [ ] todo"],
    [
      "## See [the Docs](https://example.com/Docs/Page?Ref=A)",
      "See the Docs (https://example.com/Docs/Page?Ref=A)",
    ],
    ['<div align="center"><img src="https://x/y.png"></div>\n\nafter', "after"],
    ["Tom &amp; Jerry, a &lt; b", "Tom & Jerry, a < b"],
  ])("renders %j as %j", (markdown, expected) => {
    expect(text(markdown)).toBe(expected);
  });

  it("separates blocks by one blank line and carries no Markdown syntax", () => {
    const rendered = renderMarkdown(newsletter, "News").text;

    expect(rendered).not.toMatch(/\n{3,}/);
    expect(rendered).not.toContain("**");
    expect(rendered).not.toContain("](");
    expect(rendered).toContain(
      "full release notes (https://example.com/blog/player-v3?utm_source=nl&utm_medium=email)",
    );
  });
});
