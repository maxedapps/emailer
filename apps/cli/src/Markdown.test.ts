import { describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { readFileSync } from "node:fs";

import { renderMarkdown, styles } from "./Markdown.ts";

const html = (markdown: string) => renderMarkdown(markdown, "Subject").html;

const text = (markdown: string) => renderMarkdown(markdown, "Subject").text;

const newsletter = readFileSync(new URL("../test/newsletter.md", import.meta.url), "utf8");

describe("renderMarkdown html", () => {
  // Gmail drops <style> for most accounts, so a rule that is not inline is not applied at all.
  it("gives every block, link and table cell in the reference newsletter an inline style", () => {
    const tags = [
      // Outlook's conditional wrapper is sized by attributes, as only Outlook reads it.
      ...html(newsletter)
        .replaceAll(/<!--\[if mso\]>.*?<!\[endif\]-->/gs, "")
        .matchAll(/<(h1|h2|p|a|ul|ol|li|blockquote|code|pre|hr|img|table|th|td)\b[^>]*>/g),
    ];

    expect(new Set(tags.map(([, name]) => name))).toStrictEqual(
      new Set(["h1", "h2", "p", "a", "img", "ul", "li", "code", "blockquote", "ol", "pre"])
        .add("table")
        .add("th")
        .add("td")
        .add("hr"),
    );

    for (const [tag] of tags) {
      expect(tag).toContain(' style="');
    }
  });

  it("keeps an ordered list's start number", () => {
    expect(html("3. three\n4. four")).toContain('<ol start="3"');
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
    ['<div align="center"><img src="https://example.com/logo.png"></div>\n\nafter', "after"],
    ["Salt &amp; pepper, a &lt; b", "Salt & pepper, a < b"],
    // Raw HTML reads as the HTML part does: a tag that ends a line there ends one here, while
    // inline tags and source line breaks inside a block leave the words as they flow.
    ["Line one<br>Line two", "Line one\nLine two"],
    ["The Example team<br>\nExample Street 1", "The Example team\nExample Street 1"],
    ["One<br><br>Two", "One\n\nTwo"],
    ["<p>First<br/>Second</p>", "First\nSecond"],
    ["<div>First</div><div>Second</div>", "First\nSecond"],
    ["<ul><li>One</li><li>Two</li></ul>", "One\nTwo"],
    ["<table><tr><td>Pro<br>$19</td><td>Team<br>$49</td></tr></table>", "Pro\n$19\nTeam\n$49"],
    ["<p>\n  Wrapped\n  source lines\n</p>", "Wrapped source lines"],
    ["<strong>Bold</strong>ly", "Boldly"],
    ["<style>p { color: red; }</style>\n\nHello", "Hello"],
    // A raw link reads like a Markdown link: its URL decoded once, and said once when it is the label.
    [
      'Read <a href="https://example.com/offer">the offer</a> today',
      "Read the offer (https://example.com/offer) today",
    ],
    [
      '<p align="center"><a href="https://example.com/offer">Get the offer</a></p>',
      "Get the offer (https://example.com/offer)",
    ],
    [
      '<a href="https://example.com/?a=1&amp;b=2">Deals</a>',
      "Deals (https://example.com/?a=1&b=2)",
    ],
    ['<a href="https://example.com">https://example.com</a>', "https://example.com"],
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

describe("renderMarkdown text against its html", () => {
  // A reader of either part can follow the same links, wherever the source puts them.
  it.each([
    ["a paragraph", "See [the offer](https://example.com/offer?a=1&b=2) now"],
    ["a heading", "## [Launch](https://example.com/launch)"],
    ["a nested list", "- top\n  - [inner](https://example.com/inner)"],
    ["a quote", "> Read [this](https://example.com/quote)"],
    ["a table cell", "| Plan |\n| - |\n| [Pro](https://example.com/pro) |"],
    ["an image link", "[![Logo](https://example.com/logo.png)](https://example.com/home)"],
    ["inline raw HTML", 'Read <a href="https://example.com/raw">this</a>'],
    [
      "a raw HTML button",
      '<table role="presentation"><tr><td style="padding:12px"><a href="https://example.com/cta?a=1&amp;b=2" style="color:#fff">Start now</a></td></tr></table>',
    ],
    [
      "a raw image link",
      '<p><a href="https://example.com/home"><img src="https://example.com/logo.png" alt="Logo"></a></p>',
    ],
    ["the reference newsletter", newsletter],
  ])("keeps every link of %s followable, with no markup left", (_, markdown) => {
    const rendered = renderMarkdown(markdown, "Subject");

    const hrefs = Array.from(rendered.html.matchAll(/href="([^"]*)"/g), ([, href = ""]) =>
      href.replaceAll("&amp;", "&"),
    );

    expect(hrefs).not.toStrictEqual([]);

    for (const href of hrefs) {
      expect(rendered.text).toContain(href);
    }

    expect(rendered.text).not.toMatch(/<\/?[a-z][^>]*>/i);
  });
});
