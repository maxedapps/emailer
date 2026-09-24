import * as Schemas from "@emailer/api/Schemas";
import { Clock, ConfigProvider, Effect, Layer, Option, Redacted, Scope } from "effect";
import { HttpEffect } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { footerFor } from "../sending/Message.ts";
import { CampaignReader } from "../storage/Campaigns.ts";
import { makePreviewHandler, placeholderUnsubscribeUrl } from "./PreviewPage.ts";
import { mintPreviewToken } from "./Previews.ts";

const baseUrl = "http://preview.test";

const signingKey = "5d41402abc4b2a76b9719d911017c5925d41402abc4b2a76b9719d911017c592";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const settings = {
  sender: "news@example.com",
  senderName: Option.none<string>(),
  postalAddress: "Example GmbH, Example Street 1, 12345 Example City",
};

const campaign: Schemas.Campaign = {
  id: campaignId,
  listId: "0195f0a0-1111-4222-8333-44444444109e",
  subject: `Deals & "news" <b>`,
  text: "Hello <there>",
  html: "<html><head><title>x</title></head><body><p>Hello &amp; welcome</p></body></html>",
  createdAt: "2026-09-11T10:00:00.000Z",
  submission: { state: "draft" },
};

const configuration = Layer.succeed(ConfigProvider.ConfigProvider)(
  ConfigProvider.fromEnvRecord({ EMAILER_PREVIEW_SECRET: signingKey }),
);

const secondsFromNow = (offset: number) =>
  Effect.map(Clock.currentTimeMillis, (now) => Math.floor(now / 1000) + offset);

/** A token for the campaign that expires `offset` seconds from now, signed with `key`. */
const tokenFor = (id: string, offset = 3600, key = signingKey) =>
  Effect.map(secondsFromNow(offset), (expiresAt) =>
    mintPreviewToken(Redacted.make(key), id, expiresAt),
  );

const pageFor = (stored: Option.Option<Schemas.Campaign>, token: string, sender = settings) => {
  const reads: Array<string> = [];
  const scope = Scope.makeUnsafe();

  const handle = Effect.runSync(
    makePreviewHandler(sender).pipe(
      Effect.provide(configuration),
      Effect.provideService(Scope.Scope, scope),
    ),
  );

  const handler = HttpEffect.toWebHandler(
    handle.pipe(
      Effect.provideService(CampaignReader, {
        getCampaign: (id) =>
          Effect.sync(() => {
            reads.push(id);

            return stored;
          }),
        getCampaignBody: () => Effect.die(new Error("the page reads the whole campaign")),
      }),
      Effect.provide(configuration),
    ),
  );

  return Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      handler(new Request(`${baseUrl}/previews/${token}`)),
    );

    return { response, body: yield* Effect.promise(() => response.text()), reads };
  });
};

describe("GET /previews/:token", () => {
  it("renders the current campaign with all four protective headers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { response, reads } = yield* pageFor(
          Option.some(campaign),
          yield* tokenFor(campaignId),
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("content-security-policy")).toContain("sandbox");
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(reads).toStrictEqual([campaignId]);
      }),
    ));

  it("shows From, the escaped subject, the HTML in a sandboxed srcdoc and the text part", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { body } = yield* pageFor(Option.some(campaign), yield* tokenFor(campaignId));

        expect(body).toContain("<dd>news@example.com</dd>");
        expect(body).toContain("<dd>Deals &amp; &quot;news&quot; &lt;b&gt;</dd>");
        expect(body).not.toContain("<b>");
        expect(body).toContain(
          '<iframe title="HTML part" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="&lt;html&gt;&lt;head&gt;&lt;base target=&quot;_blank&quot;&gt;',
        );
        expect(body).toContain("&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;");
        expect(body).toContain(
          `<pre>Hello &lt;there&gt;${footerFor(placeholderUnsubscribeUrl, settings.postalAddress)}</pre>`,
        );
      }),
    ));

  it("shows the sender's name as a mail client would, not encoded", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { body } = yield* pageFor(Option.some(campaign), yield* tokenFor(campaignId), {
          ...settings,
          senderName: Option.some("Café Example"),
        });

        expect(body).toContain("<dd>Café Example &lt;news@example.com&gt;</dd>");
      }),
    ));

  it("composes the footer with the placeholder link, never a real one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { body } = yield* pageFor(Option.some(campaign), yield* tokenFor(campaignId));

        expect(body).toContain(placeholderUnsubscribeUrl);
        expect(body).not.toContain("/unsubscribe/v1.");
      }),
    ));

  it("says there is no HTML part when the campaign has none", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { html: _html, ...textOnly } = campaign;
        const { body } = yield* pageFor(Option.some(textOnly), yield* tokenFor(campaignId));

        expect(body).not.toContain("<iframe");
        expect(body).toContain("This campaign has no HTML part");
      }),
    ));

  it.each([
    ["an expired token", tokenFor(campaignId, -1)],
    ["a forged token", tokenFor(campaignId, 3600, "another key")],
    ["a truncated token", Effect.map(tokenFor(campaignId), (token) => token.slice(0, -1))],
  ])("answers %s with 404 without reading storage", (_label, presented) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { response, body, reads } = yield* pageFor(Option.some(campaign), yield* presented);

        expect(response.status).toBe(404);
        expect(body).toContain("This preview link is not valid or has expired.");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(reads).toHaveLength(0);
      }),
    ),
  );

  it("answers 404 for a campaign deleted since the link was made", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { response } = yield* pageFor(Option.none(), yield* tokenFor(campaignId));

        expect(response.status).toBe(404);
      }),
    ));
});
