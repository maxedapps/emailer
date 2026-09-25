import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";

import * as Tokens from "../Tokens.ts";
import {
  maxPreviewTokenLength,
  mintPreviewToken,
  previewLink,
  verifyPreviewToken,
} from "./Previews.ts";

const signingKey = Redacted.make(
  "5d41402abc4b2a76b9719d911017c5925d41402abc4b2a76b9719d911017c592",
);

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const expiresAt = 1_790_000_000;

const minted = mintPreviewToken(signingKey, campaignId, expiresAt);

describe("preview tokens", () => {
  it("names the campaign until the second it expires", () => {
    expect(verifyPreviewToken(signingKey, minted, expiresAt - 1)).toStrictEqual(
      Option.some(campaignId),
    );
    expect(verifyPreviewToken(signingKey, minted, expiresAt)).toStrictEqual(Option.none());
  });

  it("has the derived length the route admits", () => {
    expect(maxPreviewTokenLength).toBe(115);
    expect(minted).toHaveLength(maxPreviewTokenLength);
  });

  it.each([
    ["a later expiry", minted.replace(String(expiresAt), String(expiresAt + 86_400))],
    ["another campaign", minted.replace(campaignId, "0195f0a0-1111-4222-8333-4444444ca40a")],
    ["another key", mintPreviewToken(Redacted.make("another key"), campaignId, expiresAt)],
    [
      "a signed id that is not a campaign id",
      Tokens.sign(signingKey, ["not-an-id", String(expiresAt)]),
    ],
    [
      "a signed expiry that is not ten digits",
      Tokens.sign(signingKey, [campaignId, "17900000000"]),
    ],
    ["a token of the unsubscribe shape", Tokens.sign(signingKey, [campaignId])],
  ])("refuses %s", (_label, token) => {
    expect(verifyPreviewToken(signingKey, token, expiresAt - 100)).toStrictEqual(Option.none());
  });
});

describe("previewLink", () => {
  it.effect("links under the configured base for twenty-four hours", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_790_000_000_000);

      const link = yield* previewLink(campaignId).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            EMAILER_PREVIEW_URL: "https://preview.example/",
            EMAILER_PREVIEW_SECRET: Redacted.value(signingKey),
          }),
        ),
      );

      const token = link.url.replace("https://preview.example/previews/", "");

      expect(link.url.startsWith("https://preview.example/previews/v1.")).toBe(true);
      expect(link.expiresAt).toBe("2026-09-22T14:13:20.000Z");
      expect(verifyPreviewToken(signingKey, token, 1_790_086_399)).toStrictEqual(
        Option.some(campaignId),
      );
      expect(verifyPreviewToken(signingKey, token, 1_790_086_400)).toStrictEqual(Option.none());
    }),
  );
});
