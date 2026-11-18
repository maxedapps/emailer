import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Schemas from "@emailer/api/Schemas";
import { ConfigProvider, Effect, Layer } from "effect";

import { checkPage } from "./Checks.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { unusedAudience, unusedCampaigns } from "../storage/Testing.ts";

import type { AddressStatus } from "@emailer/api/Schemas";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const footer = "\n{{ unsubscribe_url }}\n{{ postal_address }}";

const campaign: Schemas.Campaign = {
  id: campaignId,
  listId,
  subject: "Release notes",
  text: `Hi {{ contact.name | default: "there" }}${footer}`,
  filter: { plan: "pro" },
  createdAt: "2026-09-11T10:00:00.000Z",
  submission: { state: "draft" },
  variants: [{ key: "berlin", when: { city: "Berlin" } }],
};

const berlin: Schemas.Variant = {
  key: "berlin",
  when: { city: "Berlin" },
  subject: "Berlin notes",
  text: `Hallo {{ contact.name }}, since {{ contact.since | date: "%B %Y" }}${footer}`,
  language: "de-DE",
};

const member = (
  index: number,
  name: string | undefined,
  attributes: Readonly<Record<string, string>>,
): Schemas.Contact => {
  const contact = {
    id: `0195f0a0-1111-4222-8333-44444444c00${index}`,
    email: `member${index}@example.com`,
    attributes,
    createdAt: "2026-09-11T09:00:00.000Z",
  };

  return name === undefined ? contact : { ...contact, name };
};

const renders = member(1, "Ada", { plan: "pro", city: "Berlin", since: "2024-03-15" });

const unreadable = member(2, "Bob", { plan: "pro", city: "Berlin", since: "some day" });

const unnamed = member(3, undefined, { plan: "pro" });

const padded = member(4, " Dee", { plan: "pro" });

const filtered = member(5, "Eve", { plan: "free" });

const unsubscribed = member(6, "Fay", { plan: "pro" });

const members = [renders, unreadable, unnamed, padded, filtered, unsubscribed];

const statuses = new Map<string, AddressStatus>([[unsubscribed.email, "unsubscribed"]]);

const configuration = Layer.succeed(ConfigProvider.ConfigProvider)(
  ConfigProvider.fromEnvRecord({
    EMAILER_POSTAL_ADDRESS: "Example Street 1, 12345 Example City",
  }),
);

const fixture = () => {
  const reads: Array<string> = [];

  const layer = Layer.mergeAll(
    configuration,
    NodeCrypto.layer,
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      listMembers: (list, limit, cursor) =>
        Effect.sync(() => {
          reads.push(`members ${list} ${limit} ${cursor ?? "start"}`);

          return { items: members, nextCursor: "0195f0a0-1111-4222-8333-44444444c006" };
        }),
      addressStatus: (email) => Effect.succeed(statuses.get(email) ?? ("mailable" as const)),
    }),
    Layer.succeed(CampaignStore)({
      ...unusedCampaigns,
      getSummary: () => Effect.succeed(campaign),
      getRoutes: () => Effect.succeed({ routes: campaign.variants ?? [], revision: 1 }),
      getBody: () =>
        Effect.sync(() => {
          reads.push("body");

          return { text: campaign.text };
        }),
      getVariant: () =>
        Effect.sync(() => {
          reads.push("variant");

          return berlin;
        }),
    }),
  );

  return { layer, reads };
};

describe("checkPage", () => {
  it.effect(
    "renders every mailable member the filter keeps, naming failures, fallbacks and odd values",
    () =>
      Effect.gen(function* () {
        const fix = fixture();

        const page = yield* checkPage(campaignId, {
          cursor: "0195f0a0-1111-4222-8333-44444444c000",
        }).pipe(Effect.provide(fix.layer));

        expect(page).toStrictEqual({
          members: 6,
          filteredOut: 1,
          skipped: { unsubscribed: 1, suppressed: 0, bouncing: 0 },
          rendered: { berlin: 1, [Schemas.defaultCopy]: 2 },
          findings: [
            {
              kind: "failure",
              email: unreadable.email,
              copy: "berlin",
              message: 'date: cannot read "some day" as a date',
            },
            { kind: "fallback", email: unnamed.email, copy: Schemas.defaultCopy, field: "name" },
            {
              kind: "odd-value",
              email: padded.email,
              copy: Schemas.defaultCopy,
              field: "name",
              problem: "surrounding-whitespace",
            },
          ],
          nextCursor: "0195f0a0-1111-4222-8333-44444444c006",
        });
        // One page read from the cursor given, and each copy read once for all its members.
        expect(fix.reads).toStrictEqual([
          `members ${listId} 100 0195f0a0-1111-4222-8333-44444444c000`,
          "variant",
          "body",
        ]);
      }),
  );
});
