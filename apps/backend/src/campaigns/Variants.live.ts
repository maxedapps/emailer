import { NodeCrypto } from "@effect/platform-node";
import { makeEmailerClient } from "@emailer/api/Client";
import { CampaignNotFound, TooManyVariants } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Schedule } from "effect";
import { describe, expect } from "vitest";

import { newIdentifier } from "../Identifiers.ts";
import { bucketOf } from "../sending/Variants.ts";

import {
  accountSendQuota,
  awaitCampaignFeedback,
  awaitCampaignState,
  campaignItems,
  campaignStateTimeout,
  configuration,
  feedbackRows,
  fetchPage,
  sendRows,
  sendToSimulatorList,
  simulator,
  type LiveTest,
} from "../../test/IntegrationSupport.ts";

const sendTestTimeout = 480_000;

const splitMembers = 4;

export const variantsSuite = (test: LiveTest) => {
  describe("campaign variants", () => {
    test(
      "sends each member the copy its merged attributes or its bucket choose, and names it on send and feedback rows",
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const quota = yield* accountSendQuota;
        const timeout = campaignStateTimeout(splitMembers + 2, quota?.MaxSendRate);
        const runId = yield* newIdentifier;
        const list = yield* client.lists.create({ payload: { name: `variants-${runId}` } });
        const beginner = simulator("success", runId, 0);
        const bouncing = simulator("bounce", runId, 0);

        const split = Array.from({ length: splitMembers }, (_, index) =>
          simulator("success", runId, index + 1),
        );

        // Imported with a source, then made beginners by a merge that must keep the source.
        const imported = yield* client.lists.import({
          params: { listId: list.id },
          payload: {
            contacts: [beginner, bouncing, ...split].map((email) => ({
              email,
              attributes: { source: "import" },
            })),
          },
        });

        const merged = yield* client.contacts.setAttributes({
          payload: {
            contacts: [
              { email: beginner, attributes: { level: "beginner" } },
              { email: bouncing, attributes: { level: "beginner" } },
              { email: `nobody+${runId}@example.invalid`, attributes: { level: "beginner" } },
            ],
          },
        });

        expect(merged.contacts.map((entry) => entry.outcome)).toStrictEqual([
          "updated",
          "updated",
          "not-found",
        ]);
        expect(
          (yield* client.contacts.getByEmail({ query: { email: beginner } })).attributes,
        ).toStrictEqual({ source: "import", level: "beginner" });

        const campaign = yield* client.campaigns.create({
          payload: {
            listId: list.id,
            subject: `Emailer variants ${runId}`,
            text: "The campaign's own copy.",
          },
        });

        yield* client.campaigns.setVariant({
          params: { id: campaign.id, key: "beginners" },
          payload: {
            when: { level: "beginner" },
            subject: `Emailer variants for beginners ${runId}`,
            text: "The beginners' copy.",
          },
        });

        const withSplit = yield* client.campaigns.setVariant({
          params: { id: campaign.id, key: "half" },
          payload: {
            percent: 50,
            subject: `Emailer variants split ${runId}`,
            text: "The split copy.",
          },
        });

        expect(withSplit.variants).toStrictEqual([
          { key: "beginners", when: { level: "beginner" } },
          { key: "half", percent: 50 },
        ]);

        const link = yield* client.campaigns.preview({ params: { id: campaign.id } });
        const overview = yield* (yield* fetchPage(link.url)).text;
        const splitPage = yield* (yield* fetchPage(`${link.url}/half`)).text;

        expect(overview).toContain("default, for everyone no variant takes");
        expect(overview).toContain("beginners</a>, for contacts with level = beginner");
        expect(overview).toContain("half</a>, for 50% of everyone no targeted variant takes");
        expect(splitPage).toContain("half, for 50% of everyone no targeted variant takes");
        expect(splitPage).toContain("The split copy.");

        yield* sendToSimulatorList(client, list.id, campaign.id);

        const completed = yield* awaitCampaignState(client, campaign.id, "completed", timeout);

        expect(completed.submission).toMatchObject({
          progress: { accepted: splitMembers + 2, rejected: 0, uncertain: 0, skipped: 0 },
        });

        const expected = new Map<string, string>([
          [beginner, "beginners"],
          [bouncing, "beginners"],
        ]);

        for (const entry of imported.contacts) {
          if (!expected.has(entry.email)) {
            const bucket = yield* bucketOf(campaign.id, entry.contactId).pipe(
              Effect.provide(NodeCrypto.layer),
            );

            expected.set(entry.email, bucket < 50 ? "half" : Schemas.defaultCopy);
          }
        }

        const rows = yield* sendRows(campaign.id);

        expect(new Map(rows.map((row) => [row.recipient, row.variant]))).toStrictEqual(expected);

        yield* awaitCampaignFeedback(client, campaign.id, { bounced: 1, complained: 0 });

        // The history row follows the counter in one transaction, but read it until it is there.
        const bounces = yield* feedbackRows(campaign.id).pipe(
          Effect.repeat({
            schedule: Schedule.max([Schedule.recurs(15), Schedule.spaced("2 seconds")]),
            until: (found) => found.length > 0,
          }),
        );

        expect(bounces.map((row) => [row.kind, row.variant])).toStrictEqual([
          ["bounce", "beginners"],
        ]);
      }),
      sendTestTimeout,
    );

    test(
      "holds as many variants as a campaign may, each at its size limits, and deletes them together",
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const runId = yield* newIdentifier;
        const list = yield* client.lists.create({ payload: { name: `variants-full-${runId}` } });
        const text = "t".repeat(Schemas.maxTextBytes);
        const html = "h".repeat(Schemas.maxHtmlBytes);

        const campaign = yield* client.campaigns.create({
          payload: { listId: list.id, subject: `Emailer full ${runId}`, text, html },
        });

        const keys = Array.from({ length: Schemas.maxVariants }, (_, index) => `v${index}`);

        yield* Effect.forEach(
          keys,
          (key) =>
            client.campaigns.setVariant({
              params: { id: campaign.id, key },
              payload: { when: { segment: key }, subject: `Copy ${key}`, text, html },
            }),
          // One at a time, so the rules keep the keys' order.
          { discard: true },
        );

        // Replacing one keeps its place; one more is refused.
        yield* client.campaigns.setVariant({
          params: { id: campaign.id, key: "v7" },
          payload: { percent: 10, subject: "Copy v7 again", text, html },
        });

        const refused = yield* Effect.flip(
          client.campaigns.setVariant({
            params: { id: campaign.id, key: "extra" },
            payload: { percent: 1, subject: "One too many", text },
          }),
        );

        expect(refused).toStrictEqual(new TooManyVariants({ limit: Schemas.maxVariants }));

        const full = yield* client.campaigns.get({ params: { id: campaign.id } });

        expect(full.variants).toHaveLength(Schemas.maxVariants);
        expect(full.variants?.[7]).toStrictEqual({ key: "v7", percent: 10 });

        const v7 = yield* client.campaigns.getVariant({ params: { id: campaign.id, key: "v7" } });

        expect(v7).toMatchObject({ subject: "Copy v7 again", percent: 10 });
        expect(v7.text).toHaveLength(Schemas.maxTextBytes);
        expect(v7.html).toHaveLength(Schemas.maxHtmlBytes);

        const link = yield* client.campaigns.preview({ params: { id: campaign.id } });
        const overview = yield* fetchPage(link.url);
        const lastCopy = yield* fetchPage(`${link.url}/v49`);

        expect(overview.status).toBe(200);
        expect(lastCopy.status).toBe(200);
        expect(yield* lastCopy.text).toContain("Copy v49");

        yield* client.campaigns.remove({ params: { id: campaign.id } });

        expect(
          yield* Effect.flip(client.campaigns.get({ params: { id: campaign.id } })),
        ).toStrictEqual(new CampaignNotFound());
        expect(yield* campaignItems(campaign.id)).toStrictEqual([]);
      }),
      sendTestTimeout,
    );
  });
};
