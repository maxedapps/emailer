import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Clock, ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import { HttpEffect } from "effect/unstable/http";

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

const notRead = (what: string) => () => Effect.die(new Error(`the page reads no ${what}`));

/**
 * The page at `path` built inside the test's scope, as the deployed function builds it, reading
 * `stored` and its variants' content.
 */
const fetchPage = Effect.fnUntraced(function* (
  stored: Schemas.Campaign | undefined,
  variants: ReadonlyArray<Schemas.Variant>,
  path: string,
  sender: typeof settings = settings,
) {
  const reads: Array<string> = [];
  const handle = yield* makePreviewHandler(sender).pipe(Effect.provide(configuration));

  const handler = HttpEffect.toWebHandler(
    handle.pipe(
      Effect.provideService(CampaignReader, {
        getCampaign: (id) =>
          Effect.gen(function* () {
            reads.push(id);

            return stored ?? (yield* new Errors.CampaignNotFound());
          }),
        getVariant: (id, key) =>
          Effect.gen(function* () {
            reads.push(`${id} ${key}`);

            if (stored === undefined) {
              return yield* new Errors.CampaignNotFound();
            }

            const variant = variants.find((candidate) => candidate.key === key);

            return variant ?? (yield* new Errors.VariantNotFound({ variant: key }));
          }),
        getRoutes: notRead("rules alone"),
        getSummary: notRead("summary alone"),
        getBody: notRead("body alone"),
      }),
      Effect.provide(configuration),
    ),
  );

  const response = yield* Effect.promise(() => handler(new Request(`${baseUrl}${path}`)));

  return { response, body: yield* Effect.promise(() => response.text()), reads };
});

/** The overview page a link opens. */
const pageFor = (stored: Schemas.Campaign | undefined, token: string, sender = settings) =>
  fetchPage(stored, [], `/previews/${token}`, sender);

const berlin: Schemas.Variant = {
  key: "berlin",
  when: { city: "Berlin" },
  subject: "Hallo Berlin",
  text: "Berlin",
};

const half: Schemas.Variant = { key: "half", percent: 50, subject: "Half & half", text: "Split" };

const withVariants: Schemas.Campaign = {
  ...campaign,
  variants: [
    { key: "berlin", when: { city: "Berlin" } },
    { key: "half", percent: 50 },
  ],
};

// Live throughout: the web handler runs on its own runtime and reads the real clock, so tokens are
// minted against real time. On the test clock every token would arrive already expired.
describe("GET /previews/:token", () => {
  it.live("renders the current campaign with all four protective headers", () =>
    Effect.gen(function* () {
      const { response, reads } = yield* pageFor(campaign, yield* tokenFor(campaignId));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(reads).toStrictEqual([campaignId]);
    }),
  );

  it.live("shows From, the escaped subject, the HTML in a sandboxed srcdoc and the text part", () =>
    Effect.gen(function* () {
      const { body } = yield* pageFor(campaign, yield* tokenFor(campaignId));

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
  );

  it.live("shows the sender's name as a mail client would, not encoded", () =>
    Effect.gen(function* () {
      const { body } = yield* pageFor(campaign, yield* tokenFor(campaignId), {
        ...settings,
        senderName: Option.some("Café Example"),
      });

      expect(body).toContain("<dd>Café Example &lt;news@example.com&gt;</dd>");
    }),
  );

  it.live("composes the footer with the placeholder link, never a real one", () =>
    Effect.gen(function* () {
      const { body } = yield* pageFor(campaign, yield* tokenFor(campaignId));

      expect(body).toContain(placeholderUnsubscribeUrl);
      expect(body).not.toContain("/unsubscribe/v1.");
    }),
  );

  it.live("says there is no HTML part when the campaign has none", () =>
    Effect.gen(function* () {
      const { html: _html, ...textOnly } = campaign;
      const { body } = yield* pageFor(textOnly, yield* tokenFor(campaignId));

      expect(body).not.toContain("<iframe");
      expect(body).toContain("This campaign has no HTML part");
    }),
  );

  it.live("lists every variant with its rule and a link to its page, beside the own copy", () =>
    Effect.gen(function* () {
      const token = yield* tokenFor(campaignId);
      const { body, reads } = yield* fetchPage(withVariants, [berlin, half], `/previews/${token}`);

      const listedBerlin = body.indexOf(
        `<li><a href="/previews/${token}/berlin">berlin</a>, for contacts with city = Berlin</li>`,
      );

      const listedHalf = body.indexOf(
        `<li><a href="/previews/${token}/half">half</a>, for 50% of everyone no targeted variant takes</li>`,
      );

      expect(listedBerlin).toBeGreaterThan(-1);
      expect(listedHalf).toBeGreaterThan(listedBerlin);
      expect(body).toContain("<dd>default, for everyone no variant takes</dd>");
      expect(body).not.toContain("Hallo Berlin");
      expect(reads).toStrictEqual([campaignId]);
    }),
  );

  it.live("shows one variant's copy on its own page, reading only that variant", () =>
    Effect.gen(function* () {
      const token = yield* tokenFor(campaignId);

      const { response, body, reads } = yield* fetchPage(
        withVariants,
        [berlin, half],
        `/previews/${token}/half`,
      );

      expect(response.status).toBe(200);
      expect(body).toContain(`<a href="/previews/${token}">All copies</a>`);
      expect(body).toContain("<dd>half, for 50% of everyone no targeted variant takes</dd>");
      expect(body).toContain("<dd>Half &amp; half</dd>");
      expect(body).toContain(
        `<pre>Split${footerFor(placeholderUnsubscribeUrl, settings.postalAddress)}</pre>`,
      );
      expect(body).not.toContain("Hello &lt;there&gt;");
      expect(reads).toStrictEqual([`${campaignId} half`]);
    }),
  );

  it.live.each([
    ["a variant the campaign lacks", withVariants, "gone"],
    ["a variant of a deleted campaign", undefined, "half"],
  ] as const)("answers 404 for %s", ([_label, stored, key]) =>
    Effect.gen(function* () {
      const token = yield* tokenFor(campaignId);
      const { response } = yield* fetchPage(stored, [half], `/previews/${token}/${key}`);

      expect(response.status).toBe(404);
    }),
  );

  it.live("answers 404 for a forged token on a variant's page without reading storage", () =>
    Effect.gen(function* () {
      const token = yield* tokenFor(campaignId, 3600, "another key");
      const { response, reads } = yield* fetchPage(withVariants, [half], `/previews/${token}/half`);

      expect(response.status).toBe(404);
      expect(reads).toHaveLength(0);
    }),
  );

  it.live.each([
    ["an expired token", tokenFor(campaignId, -1)],
    ["a forged token", tokenFor(campaignId, 3600, "another key")],
    ["a truncated token", Effect.map(tokenFor(campaignId), (token) => token.slice(0, -1))],
  ] as const)("answers %s with 404 without reading storage", ([_label, presented]) =>
    Effect.gen(function* () {
      const { response, body, reads } = yield* pageFor(campaign, yield* presented);

      expect(response.status).toBe(404);
      expect(body).toContain("This preview link is not valid or has expired.");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(reads).toHaveLength(0);
    }),
  );

  it.live("answers 404 for a campaign deleted since the link was made", () =>
    Effect.gen(function* () {
      const { response } = yield* pageFor(undefined, yield* tokenFor(campaignId));

      expect(response.status).toBe(404);
    }),
  );
});
