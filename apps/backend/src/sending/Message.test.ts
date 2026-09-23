import { Cause, ConfigProvider, Effect, Exit, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  belongsToIdentity,
  compose,
  footerFor,
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
    expect(composedHtml("<p>&lt;/body&gt; is text</p><body></body>")).toBe(
      `<p>&lt;/body&gt; is text</p><body>${footer}</body>`,
    );
  });

  it("appends the HTML footer when the document has no closing body tag", () => {
    expect(composedHtml("<p>Hallo</p>")).toBe(`<p>Hallo</p>${footer}`);
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

  it("refuses a blank postal address rather than sending non-compliant mail", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(Result.isFailure(yield* resolving("   "))).toBe(true);
      }),
    ));

  it("trims the configured postal address", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* resolving(`  ${postalAddress}  `);

        expect(Result.isSuccess(outcome) && outcome.success.postalAddress).toBe(postalAddress);
      }),
    ));

  it("dies when the From address is not on the identity", () =>
    Effect.runPromise(
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

        expect(Result.isSuccess(defect) && defect.success instanceof SenderNotOnIdentity).toBe(
          true,
        );
      }),
    ));
});
