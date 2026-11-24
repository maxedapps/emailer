import { InvalidTemplate } from "@emailer/api/Errors";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { compileCopy, validateParts } from "./Templates.ts";

import type { CopySource, Recipient } from "./Templates.ts";

const unsubscribeUrl = "https://unsubscribe.example.com/unsubscribe/token?a=1&b=2";

const postalAddress = "Example & Co, Example Street 1, 12345 Example City";

const footer = "\n{{ unsubscribe_url }}\n{{ postal_address }}";

const htmlFooter = '<a href="{{ unsubscribe_url }}">Unsubscribe</a> {{ postal_address }}';

const copy: CopySource = {
  subject: "{% if contact.name %}{{ contact.name }}, {% endif %}our news",
  text: `Hi{% if contact.name %} {{ contact.name }}{% endif %},
{% if contact["member since"] %}you joined in {{ contact["member since"] | date: "%B %Y" }}{% else %}you joined a while ago{% endif %}.${footer}`,
  html: `<p>Hi {{ contact.name | default: "there" }}</p>${htmlFooter}`,
};

const contact = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "ada@example.com",
  name: "Ada <Lovelace>",
  attributes: { "member since": "2024-03-15" },
  createdAt: "2024-01-01T00:00:00.000Z",
};

const as = (who: Recipient["contact"]): Recipient => ({
  contact: who,
  unsubscribeUrl,
  postalAddress,
});

const render = (source: CopySource, recipient: Recipient) =>
  compileCopy(source).pipe(Effect.flatMap((compiled) => compiled.render(recipient)));

describe("compileCopy", () => {
  it.effect("renders a contact's values, escaping them only in the HTML part", () =>
    Effect.gen(function* () {
      const message = yield* render(copy, as(contact));

      expect(message.subject).toBe("Ada <Lovelace>, our news");
      expect(message.text).toBe(
        `Hi Ada <Lovelace>,\nyou joined in March 2024.\n${unsubscribeUrl}\n${postalAddress}`,
      );
      expect(message.html).toBe(
        '<p>Hi Ada &lt;Lovelace&gt;</p><a href="https://unsubscribe.example.com/unsubscribe/token?a=1&amp;b=2">Unsubscribe</a> Example &amp; Co, Example Street 1, 12345 Example City',
      );
    }),
  );

  it.effect("renders every fallback for no contact, and for a blank value", () =>
    Effect.gen(function* () {
      const none = yield* render(copy, as(undefined));

      const blank = yield* render(
        copy,
        as({ ...contact, name: "  ", attributes: { "member since": "" } }),
      );

      for (const message of [none, blank]) {
        expect(message.subject).toBe("our news");
        expect(message.text.split("\n").slice(0, 2)).toStrictEqual([
          "Hi,",
          "you joined a while ago.",
        ]);
        expect(message.html?.startsWith("<p>Hi there</p>")).toBe(true);
      }
    }),
  );

  it.effect("prints a missing value as nothing and a number as text in the HTML part", () =>
    Effect.gen(function* () {
      const message = yield* render(
        {
          subject: "News",
          text: `News${footer}`,
          html: `<p>Hi {{ contact.name }}</p>{% for n in (1..2) %}<i>{{ forloop.index }}</i>{% endfor %}{{ 3 }}${htmlFooter}`,
        },
        as(undefined),
      );

      expect(message.html?.startsWith("<p>Hi </p><i>1</i><i>2</i>3<a href=")).toBe(true);
    }),
  );

  it.effect("names months in the copy's language", () =>
    Effect.gen(function* () {
      const message = yield* render({ ...copy, language: "de-DE" }, as(contact));

      expect(message.text).toContain("you joined in März 2024.");
    }),
  );

  it.effect("lets the contact's own fields win over same-named attributes", () =>
    Effect.gen(function* () {
      const message = yield* render(
        { subject: "{{ contact.email }}", text: `{{ contact.name }}${footer}` },
        as({ ...contact, attributes: { name: "Attribute", email: "other@example.com" } }),
      );

      expect(message.subject).toBe("ada@example.com");
      expect(message.text.startsWith("Ada <Lovelace>\n")).toBe(true);
    }),
  );

  it.effect("falls back for a contact without a name, never to a same-named attribute", () =>
    Effect.gen(function* () {
      const { name: _, ...unnamed } = contact;

      const message = yield* render(
        { subject: "News", text: `Hi {{ contact.name | default: "there" }}${footer}` },
        as({ ...unnamed, attributes: { name: "Attribute" } }),
      );

      expect(message.text.startsWith("Hi there\n")).toBe(true);
    }),
  );

  it.effect("lists the contact fields a copy reads", () =>
    Effect.gen(function* () {
      const compiled = yield* compileCopy(copy);

      expect([...compiled.fields].toSorted()).toStrictEqual(["member since", "name"]);
    }),
  );

  it.effect.each([
    [
      "a date it cannot read",
      { ...copy },
      { ...contact, attributes: { "member since": "sometime" } },
      'date: cannot read "sometime" as a date',
    ],
    [
      "a subject over several lines",
      { ...copy, subject: "{{ contact.name }}" },
      { ...contact, name: "Ada\nLovelace" },
      "the subject renders empty, longer than 200 characters or over several lines",
    ],
    [
      "a text that drops the link",
      { ...copy, text: `{% if contact.vip %}{{ unsubscribe_url }}{% endif %}{{ postal_address }}` },
      contact,
      "the text renders without the unsubscribe link or the postal address",
    ],
    [
      "an HTML part that drops the address",
      {
        ...copy,
        html: `{{ unsubscribe_url }}{% if contact.vip %}{{ postal_address }}{% endif %}`,
      },
      contact,
      "the HTML renders without the unsubscribe link or the postal address",
    ],
  ] satisfies Array<[string, CopySource, Recipient["contact"], string]>)(
    "refuses to render %s",
    ([, source, who, message]) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(render(source, as(who)));

        expect(error._tag).toBe("Unrenderable");
        expect(error.message).toContain(message);
      }),
  );
});

describe("validateParts", () => {
  it.effect.each([
    [{ text: `{{ contact.name | shout }}${footer}` }, "text", "undefined filter: shout", 1, 1],
    [{ text: `{% include "other" %}${footer}` }, "text", 'tag "include" is not available', 1, 1],
    [
      { subject: "Hi {% if contact.name %}" },
      "subject",
      "tag {% if contact.name %} not closed",
      1,
      4,
    ],
    [
      { html: `<p>{{ first_name }}</p>${htmlFooter}` },
      "html",
      'unknown variable "first_name": use contact.first_name',
      1,
      7,
    ],
    [
      { text: "Hi\n{{ postal_address }}" },
      "text",
      "must carry {{ unsubscribe_url }}",
      undefined,
      undefined,
    ],
    [
      { html: htmlFooter.replace("{{ postal_address }}", "") },
      "html",
      "must carry {{ postal_address }}",
      undefined,
      undefined,
    ],
  ] as const)("refuses %j", ([parts, part, reason, line, column]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(validateParts(parts));

      expect([error._tag, error.part, error.line, error.column]).toStrictEqual([
        "InvalidTemplate",
        part,
        line,
        column,
      ]);
      expect(error.reason).toContain(reason);
    }),
  );

  it.effect.each([
    ['<img src="hero.png" alt="Hero" width="552">', "hero.png"],
    ["<img alt='' src='./img/hero.png'>", "./img/hero.png"],
    ["<img src=/img/hero.png>", "/img/hero.png"],
    ['<img src="http://example.com/hero.png">', "http://example.com/hero.png"],
    ['<img src="//example.com/hero.png">', "//example.com/hero.png"],
    ['<img src="data:image/png;base64,iVBORw0KGgo=">', "data:image/png;base64,iVBORw0KGgo="],
    ['<img src="cid:hero">', "cid:hero"],
    ['<img src="">', ""],
    ['<img src="{{ contact.photo }}">', "{{ contact.photo }}"],
    ['<img alt="Revenue > costs" src="hero.png">', "hero.png"],
    ["<img alt=Hero src=hero.png/>", "hero.png/"],
  ] as const)("refuses the image in %s, naming its source and place", ([image, source]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        validateParts({ html: `<p>Hi</p>\n<p>News</p> ${image}${htmlFooter}` }),
      );

      expect(error).toStrictEqual(
        new InvalidTemplate({
          part: "html",
          reason: `image "${source}" must be an absolute https:// URL`,
          line: 2,
          column: 13,
        }),
      );
    }),
  );

  it.effect("accepts images from absolute https URLs, Liquid after the host included", () =>
    validateParts({
      html: [
        '<img src="https://example.com/hero.png" alt="Hero">',
        "<IMG SRC='HTTPS://example.com/logo.png'>",
        '<img data-src="lazy.png" src="https://cdn.example.com/{{ contact.plan }}.png">',
        '<img alt="Example src=hero.png" src="https://example.com/hero.png">',
        "<img alt='Hero'>",
        "<p>An <imgur> tag is no image</p>",
        htmlFooter,
      ].join("\n"),
    }),
  );

  it.effect("accepts loops, assignments and a subject without the required tags", () =>
    validateParts({
      subject: "News for {{ contact.name | default: 'you' }}",
      text: `{% assign greeting = "Hi" %}{{ greeting }}{% for word in contact.words %}{{ forloop.index }}{% endfor %}${footer}`,
      html: null,
    }),
  );
});
