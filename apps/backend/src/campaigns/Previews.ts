import * as Schemas from "@emailer/api/Schemas";
import { Random } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Clock, Config, DateTime, Duration, Effect, Option, Redacted, Schema } from "effect";

import * as SignedToken from "../SignedToken.ts";

/** Its own secret, so replacing it revokes every preview link without touching unsubscribe links. */
export const previewSecret = Random("PreviewSecret");

/** The bare tag: the API references the preview function's URL without bundling its handler. */
export class PreviewFunction extends AWS.Lambda.Function<PreviewFunction>()("Preview") {}

export const previewSigningKey = Config.Redacted("EMAILER_PREVIEW_SECRET");

/** Long enough for a day of editing, short enough that a forwarded link stops working by itself. */
const previewLifetime = Duration.hours(24);

const uuidLength = 36;

/** Epoch seconds keep ten digits until the year 2286. */
const epochSecondsLength = 10;

/** 115 characters: longer than the router's default parameter cap, which the page raises to this. */
export const maxPreviewTokenLength = SignedToken.lengthFor([uuidLength, epochSecondsLength]);

const isEntityId = Schema.is(Schemas.EntityId);

const epochSecondsPattern = /^\d{10}$/;

export const mintPreviewToken = (
  signingKey: Redacted.Redacted<string>,
  campaignId: string,
  expiresAtSeconds: number,
): string => SignedToken.sign(signingKey, [campaignId, String(expiresAtSeconds)]);

/** The campaign a token names, if this system issued it and it has not expired by `nowSeconds`. */
export const verifyPreviewToken = (
  signingKey: Redacted.Redacted<string>,
  token: string,
  nowSeconds: number,
): Option.Option<string> =>
  Option.flatMap(
    SignedToken.verify(signingKey, token, { fields: 2, maxLength: maxPreviewTokenLength }),
    ([campaignId = "", expires = ""]) =>
      isEntityId(campaignId) && epochSecondsPattern.test(expires) && Number(expires) > nowSeconds
        ? Option.some(campaignId)
        : Option.none(),
  );

/** Read per call, like the unsubscribe link: the URL exists only once the preview function does. */
export const previewLink = Effect.fn("Previews.previewLink")(function* (campaignId: string) {
  const configured = yield* Config.all({
    baseUrl: Config.String("EMAILER_PREVIEW_URL"),
    signingKey: previewSigningKey,
  });

  const now = yield* Clock.currentTimeMillis;
  const expiresAtSeconds = Math.floor((now + Duration.toMillis(previewLifetime)) / 1000);
  const token = mintPreviewToken(configured.signingKey, campaignId, expiresAtSeconds);

  // AWS reports a Function URL with a trailing slash.
  const base = configured.baseUrl.replace(/\/+$/, "");

  return {
    url: `${base}/previews/${token}`,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtSeconds * 1000)),
  } satisfies Schemas.PreviewLink;
});
