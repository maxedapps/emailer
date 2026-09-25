import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Option, Result } from "effect";

import {
  belongsToIdentity,
  compose,
  composeConfirmation,
  footerFor,
  fromHeader,
  htmlFooterFor,
  senderSettings,
  SenderNotOnIdentity,
} from "./Message.ts";

const unsubscribeUrl = "https://unsub.lambda-url.eu-central-1.on.aws/unsubscribe/token";

const postalAddress = "Example GmbH, Example Street 1, 12345 Example City, Germany";

const content = { subject: "Grüße 😀", text: "Hallo", html: undefined };

const footer = htmlFooterFor(unsubscribeUrl, postalAddress);

const composedHtml = (html: string) =>
  compose({ ...content, html }, unsubscribeUrl, postalAddress).html;

describe("compose", () => {
  it("keeps the subject, appends the text footer and sets both unsubscribe headers", () => {
    expect(compose(content, unsubscribeUrl, postalAddress)).toStrictEqual({
      subject: "Grüße 😀",
      text: `Hallo${footerFor(unsubscribeUrl, postalAddress)}`,
      html: undefined,
      headers: [
        { name: "List-Unsubscribe", value: `<${unsubscribeUrl}>` },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      ],
    });
  });

  it("inserts the HTML footer before the closing body tag", () => {
    expect(composedHtml("<html><body><p>Hallo</p></body></html>")).toBe(
      `<html><body><p>Hallo</p>${footer}</body></html>`,
    );
  });

  it("inserts the HTML footer before an uppercase closing body tag", () => {
    expect(composedHtml("<HTML><BODY><p>Hallo</p></BODY></HTML>")).toBe(
      `<HTML><BODY><p>Hallo</p>${footer}</BODY></HTML>`,
    );
  });

  it("inserts the HTML footer before </body> when the document contains İ", () => {
    expect(composedHtml("<html><body>İçerik</body></html>")).toBe(
      `<html><body>İçerik${footer}</body></html>`,
    );
  });

  it("inserts the HTML footer before the last closing body tag only", () => {
    expect(composedHtml("<body><p>One</p></body><body><p>Two</p></body>")).toBe(
      `<body><p>One</p></body><body><p>Two</p>${footer}</body>`,
    );
  });

  it("appends the HTML footer when the document has no closing body tag", () => {
    expect(composedHtml("<p>Hallo</p>")).toBe(`<p>Hallo</p>${footer}`);
  });
});

describe("composeConfirmation", () => {
  const confirmUrl = "https://www.example.com/confirm?token=sam%40example.com.a.b&lang=en";
  const message = composeConfirmation("News & <Updates>", confirmUrl, postalAddress);

  it("asks to confirm the list by name, and sets no unsubscribe headers", () => {
    expect(message.subject).toBe("Please confirm your subscription to News & <Updates>");
    expect(message.headers).toStrictEqual([]);
  });

  it("gives the link, its expiry, what to do if it wasn't you, and the postal address", () => {
    expect(message.text).toContain(`\n${confirmUrl}\n`);
    expect(message.text).toContain("7 days");
    expect(message.text).toContain("ignore this email and you won't be added");
    expect(message.text.endsWith(postalAddress)).toBe(true);
  });

  it("escapes the list name and the link in the HTML part", () => {
    const escapedUrl = confirmUrl.replaceAll("&", "&amp;");

    expect(message.html).toContain("<strong>News &amp; &lt;Updates&gt;</strong>");
    expect(message.html).toContain(`href="${escapedUrl}"`);
    expect(message.html).not.toContain("<Updates>");
    expect(message.html).toContain("7 days");
  });
});

describe("belongsToIdentity", () => {
  it("accepts an address whose domain is the identity", () => {
    expect(belongsToIdentity("no-reply@example.com", "example.com")).toBe(true);
  });

  it("accepts an address on a subdomain of the identity", () => {
    expect(belongsToIdentity("no-reply@mail.example.com", "example.com")).toBe(true);
  });

  it("refuses a domain that merely ends with the identity's characters", () => {
    expect(belongsToIdentity("no-reply@notexample.com", "example.com")).toBe(false);
  });

  it("refuses an unrelated domain", () => {
    expect(belongsToIdentity("no-reply@other.example.net", "example.com")).toBe(false);
  });

  it("refuses an address on the parent of a subdomain identity", () => {
    expect(belongsToIdentity("emailer-test@example.com", "mail.example.com")).toBe(false);
  });
});

describe("footerFor", () => {
  // The literal, not a composition of the same interpolations: asserting only
  // that the link and the address appear somewhere would pass if the two were
  // swapped, and every message would then label the postal address as the
  // unsubscribe link.
  it("labels the link and separates itself from the campaign body", () => {
    expect(footerFor(unsubscribeUrl, postalAddress)).toBe(
      `\n\n---\nUnsubscribe from these emails: ${unsubscribeUrl}\n\n${postalAddress}`,
    );
  });
});

describe("htmlFooterFor", () => {
  it("links the unsubscribe URL and escapes both interpolations", () => {
    const footer = htmlFooterFor("https://unsub.example/u?a=1&b=2", `Acme & Co <"O'Reilly">`);

    expect(footer).toContain(
      `<a href="https://unsub.example/u?a=1&amp;b=2" style="color:#6b7280;text-decoration:underline;">Unsubscribe from these emails</a>`,
    );
    expect(footer).toContain(
      `<p style="margin:0;">Acme &amp; Co &lt;&quot;O&#39;Reilly&quot;&gt;</p>`,
    );
  });

  it("is one self-styled table capped at the layout's width", () => {
    const footer = htmlFooterFor(unsubscribeUrl, postalAddress);

    expect(footer.startsWith(`<table role="presentation" width="100%"`)).toBe(true);
    expect(footer).toContain("max-width:600px;");
    expect(footer.endsWith("</table>")).toBe(true);
  });
});

describe("senderSettings", () => {
  const resolving = (postal: string = postalAddress) =>
    Effect.result(senderSettings).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          EMAILER_SENDER_IDENTITY: "Example.COM",
          EMAILER_FROM_EMAIL: "no-reply@example.com",
          EMAILER_POSTAL_ADDRESS: postal,
        }),
      ),
    );

  it.effect("refuses a blank postal address rather than sending non-compliant mail", () =>
    Effect.gen(function* () {
      expect(Result.isFailure(yield* resolving("   "))).toBe(true);
    }),
  );

  it.effect("trims the configured postal address", () =>
    Effect.gen(function* () {
      const outcome = yield* resolving(`  ${postalAddress}  `);

      expect(Result.isSuccess(outcome) && outcome.success.postalAddress).toBe(postalAddress);
    }),
  );

  it.effect("dies when the From address is not on the identity", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(senderSettings).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            EMAILER_SENDER_IDENTITY: "mail.example.com",
            EMAILER_FROM_EMAIL: "emailer-test@example.com",
            EMAILER_POSTAL_ADDRESS: postalAddress,
          }),
        ),
      );

      if (!Exit.isFailure(exit)) {
        throw new Error("Expected senderSettings to die");
      }

      const defect = Cause.findDefect(exit.cause);

      expect(Result.isSuccess(defect) && defect.success instanceof SenderNotOnIdentity).toBe(true);
    }),
  );
});

describe("the sender's name", () => {
  const baseEnv = {
    EMAILER_SENDER_IDENTITY: "example.com",
    EMAILER_FROM_EMAIL: "no-reply@example.com",
    EMAILER_POSTAL_ADDRESS: postalAddress,
  };

  const settingsFrom = (env: Readonly<Record<string, string>>) =>
    Effect.result(senderSettings).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
    );

  const nameFrom = (name: string) => settingsFrom({ ...baseEnv, EMAILER_FROM_NAME: name });

  it.effect.each([
    ["unset", settingsFrom(baseEnv)],
    ["blank", nameFrom("")],
  ] as const)("is absent when %s, so mail goes out from the bare address", ([_label, resolving]) =>
    Effect.gen(function* () {
      const outcome = yield* resolving;

      expect(Result.isSuccess(outcome) && outcome.success.senderName).toStrictEqual(Option.none());
    }),
  );

  it.effect.each([
    ["trimmed", "  Example News  ", "Example News"],
    ["45 UTF-8 bytes long", `${"ü".repeat(22)}x`, `${"ü".repeat(22)}x`],
  ] as const)("is accepted %s", ([_label, name, expected]) =>
    Effect.gen(function* () {
      const outcome = yield* nameFrom(name);

      expect(Result.isSuccess(outcome) && outcome.success.senderName).toStrictEqual(
        Option.some(expected),
      );
    }),
  );

  it.effect.each([
    ["only whitespace", "   "],
    ["a double quote", 'The "Example" News'],
    ["a backslash", "Back\\slash"],
    ["a line break", "Example News\r\nBcc: someone@example.com"],
    ["more than 45 UTF-8 bytes", "ü".repeat(23)],
  ] as const)("is refused at startup when it holds %s", ([_label, name]) =>
    Effect.gen(function* () {
      expect(Result.isFailure(yield* nameFrom(name))).toBe(true);
    }),
  );
});

describe("fromHeader", () => {
  const sender = "no-reply@example.com";

  it("is the bare address without a name", () => {
    expect(fromHeader(sender, Option.none())).toBe(sender);
  });

  it("quotes a printable ASCII name, specials included", () => {
    expect(fromHeader(sender, Option.some("Example, Inc."))).toBe(
      '"Example, Inc." <no-reply@example.com>',
    );
  });

  it("sends any other name as a base64 RFC 2047 encoded word", () => {
    expect(fromHeader(sender, Option.some("Café Example"))).toBe(
      "=?UTF-8?B?Q2Fmw6kgRXhhbXBsZQ==?= <no-reply@example.com>",
    );
  });

  it("keeps the longest accepted name within one 75-character encoded word", () => {
    const [word = ""] = fromHeader(sender, Option.some(`${"ü".repeat(22)}x`)).split(" ");

    expect(word.length).toBeLessThanOrEqual(75);
  });
});
