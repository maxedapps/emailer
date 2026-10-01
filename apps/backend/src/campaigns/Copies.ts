import * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";

import { CampaignStore } from "../storage/Campaigns.ts";

import type { MessageContent } from "../sending/Message.ts";

/** Who a variant's rule sends its copy to. */
export const describeRule = (route: Schemas.VariantRoute): string =>
  route.when === undefined
    ? `${route.percent}% of everyone no targeted variant takes`
    : `contacts with ${Object.entries(route.when)
        .map(([key, value]) => `${key} = ${value}`)
        .join(" and ")}`;

/** Who the campaign's own copy goes to, beside these variants. */
export const describeDefault = (routes: ReadonlyArray<Schemas.VariantRoute>): string =>
  routes.length === 0 ? "every recipient" : "everyone no variant takes";

export const variantContent = (variant: Schemas.Variant): MessageContent => ({
  subject: variant.subject,
  text: variant.text,
  html: variant.html,
});

/** The content of one of a campaign's copies, read alone: its own, or the variant `key` names. */
export const copyContent = Effect.fn("Copies.copyContent")(function* (
  campaign: Schemas.CampaignSummary,
  key: Schemas.CopyKey,
) {
  const campaigns = yield* CampaignStore;

  if (key !== Schemas.defaultCopy) {
    return variantContent(yield* campaigns.getVariant(campaign.id, key));
  }

  const body = yield* campaigns.getBody(campaign.id);

  return { subject: campaign.subject, text: body.text, html: body.html } satisfies MessageContent;
});
