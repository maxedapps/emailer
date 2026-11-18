import { RenderFailed } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";

import { postalAddress } from "../sending/Message.ts";
import { compileCopy } from "../sending/Templates.ts";
import { chooseVariant } from "../sending/Variants.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";

import type { MessageContent } from "../sending/Message.ts";
import type { CopySource, Recipient } from "../sending/Templates.ts";

/** Stands in for the per-recipient unsubscribe link wherever nothing is sent. */
export const placeholderUnsubscribeUrl =
  "https://unsubscribe.invalid/each-recipient-gets-their-own-link";

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

export const variantContent = (variant: Schemas.Variant): CopySource => ({
  subject: variant.subject,
  text: variant.text,
  html: variant.html,
  language: variant.language,
});

/** The templates of one of a campaign's copies, read alone: its own, or the variant `key` names. */
export const copyContent = Effect.fn("Copies.copyContent")(function* (
  campaign: Schemas.CampaignSummary,
  key: Schemas.CopyKey,
) {
  const campaigns = yield* CampaignStore;

  if (key !== Schemas.defaultCopy) {
    return variantContent(yield* campaigns.getVariant(campaign.id, key));
  }

  const body = yield* campaigns.getBody(campaign.id);

  return { subject: campaign.subject, ...body } satisfies CopySource;
});

/**
 * The copy a preview or test shows: the one named, else the one the campaign's rules choose for
 * the contact, as a send would, else the campaign's own. Only the copy it picks is read.
 */
const pickCopy = Effect.fn("Copies.pickCopy")(function* (
  campaign: Schemas.CampaignSummary,
  contact: Schemas.Contact | undefined,
  named: Schemas.CopyKey | undefined,
) {
  if (named !== undefined) {
    return named;
  }

  if (contact === undefined) {
    return Schemas.defaultCopy;
  }

  const campaigns = yield* CampaignStore;
  const { routes } = yield* campaigns.getRoutes(campaign.id);

  return (yield* chooseVariant(campaign.id, contact, routes))?.key ?? Schemas.defaultCopy;
});

/** One of a campaign's copies, compiled, with the contact a preview or test renders it as. */
interface ChosenCopy {
  readonly key: Schemas.CopyKey;
  readonly contact: Schemas.Contact | undefined;
  readonly render: (unsubscribeUrl: string) => Effect.Effect<MessageContent, RenderFailed>;
}

/**
 * The copy a preview or test of `campaign` renders, as the contact holding `as`, or as no contact,
 * so every fallback shows. A copy saved before templates were checked, or one this contact's values
 * break, fails as `RenderFailed`.
 */
export const chooseCopy = Effect.fn("Copies.chooseCopy")(function* (
  campaign: Schemas.CampaignSummary,
  as: string | undefined,
  named: Schemas.CopyKey | undefined,
) {
  const audience = yield* AudienceStore;
  const postal = yield* postalAddress;

  const contact = as === undefined ? undefined : yield* audience.getContactByEmail(as);
  const key = yield* pickCopy(campaign, contact, named);

  const failed = (reason: string) => new RenderFailed({ copy: key, reason });

  const compiled = yield* copyContent(campaign, key).pipe(
    Effect.flatMap(compileCopy),
    Effect.catchTag("InvalidTemplate", ({ reason }) => Effect.fail(failed(reason))),
  );

  const render = (unsubscribeUrl: string) =>
    compiled
      .render({ contact, unsubscribeUrl, postalAddress: postal } satisfies Recipient)
      .pipe(Effect.mapError(({ message }) => failed(message)));

  return { key, contact, render } satisfies ChosenCopy;
});

/**
 * What the contact holding `as` gets from the campaign, rendered with the placeholder unsubscribe
 * link: nothing is sent, and no real link is minted for anyone.
 */
export const renderAs = Effect.fn("Copies.renderAs")(function* (
  campaignId: string,
  payload: Schemas.RenderPayload,
) {
  const campaigns = yield* CampaignStore;
  const campaign = yield* campaigns.getSummary(campaignId);
  const copy = yield* chooseCopy(campaign, payload.as, payload.variant);
  const content = yield* copy.render(placeholderUnsubscribeUrl);

  return { copy: copy.key, ...content } satisfies Schemas.RenderedCopy;
});
