import * as Schemas from "@emailer/api/Schemas";

import type { MessageContent } from "../sending/Message.ts";

/** One of a campaign's copies, as the preview shows it and a test sends it. */
export interface Copy {
  readonly key: Schemas.CopyKey;
  readonly content: MessageContent;
  readonly rule: string;
}

const describeRule = (variant: Schemas.Variant): string =>
  variant.when === undefined
    ? `${variant.percent}% of everyone no targeted variant takes`
    : `contacts with ${Object.entries(variant.when)
        .map(([key, value]) => `${key} = ${value}`)
        .join(" and ")}`;

/** Every copy, the campaign's own first, each with the rule that sends it. */
export const copiesOf = (campaign: Schemas.Campaign): ReadonlyArray<Copy> => {
  const variants = campaign.variants ?? [];

  const own: Copy = {
    key: Schemas.defaultCopy,
    content: { subject: campaign.subject, text: campaign.text, html: campaign.html },
    rule: variants.length === 0 ? "every recipient" : "everyone no variant takes",
  };

  return [
    own,
    ...variants.map((variant) => ({
      key: variant.key,
      content: { subject: variant.subject, text: variant.text, html: variant.html },
      rule: describeRule(variant),
    })),
  ];
};
