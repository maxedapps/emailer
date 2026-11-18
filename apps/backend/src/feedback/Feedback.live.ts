import { makeEmailerClient } from "@emailer/api/Client";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { newIdentifier } from "../Identifiers.ts";

import {
  accountSendQuota,
  awaitAddressStatus,
  awaitCampaignFeedback,
  awaitCampaignOpens,
  awaitCampaignState,
  campaignStateTimeout,
  configuration,
  injectOpen,
  liveStorage,
  sendRows,
  sendToSimulatorList,
  simulator,
  textFooter,
  type LiveTest,
} from "../../test/IntegrationSupport.ts";

const sendTestTimeout = 480_000;

export const feedbackSuite = (test: LiveTest) => {
  describe("feedback and suppression", () => {
    test(
      "skips previously bounced and complained addresses on the next campaign",
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const storage = yield* liveStorage(settings.tableName);
        const quota = yield* accountSendQuota;
        const timeout = campaignStateTimeout(2, quota?.MaxSendRate);
        const runId = yield* newIdentifier;
        const bounce = simulator("bounce", runId);
        const complaint = simulator("complaint", runId);
        const list = yield* client.lists.create({ payload: { name: `feedback-${runId}` } });

        yield* client.lists.import({
          params: { listId: list.id },
          payload: { contacts: [{ email: bounce }, { email: complaint }] },
        });

        const first = yield* client.campaigns.create({
          payload: {
            listId: list.id,
            subject: `Emailer feedback ${runId}`,
            text: `This message drives bounce and complaint through the SES mailbox simulator.${textFooter}`,
          },
        });

        yield* sendToSimulatorList(client, list.id, first.id);

        const completed = yield* awaitCampaignState(client, first.id, "completed", timeout);

        expect(completed.submission).toMatchObject({
          state: "completed",
          progress: { accepted: 2, rejected: 0, uncertain: 0, skipped: 0 },
        });

        const counted = yield* awaitCampaignFeedback(client, first.id, {
          bounced: 1,
          complained: 1,
        });

        expect(counted.submission).toMatchObject({
          feedback: { bounced: 1, complained: 1 },
        });

        expect(yield* awaitAddressStatus(storage, bounce, list.id, "suppressed")).toBe(
          "suppressed",
        );
        expect(yield* awaitAddressStatus(storage, complaint, list.id, "suppressed")).toBe(
          "suppressed",
        );

        const second = yield* client.campaigns.create({
          payload: {
            listId: list.id,
            subject: `Emailer feedback skipped ${runId}`,
            text: `These two recipients must be skipped.${textFooter}`,
          },
        });

        yield* sendToSimulatorList(client, list.id, second.id);

        const skipped = yield* awaitCampaignState(client, second.id, "completed", timeout);

        expect(skipped.submission).toMatchObject({
          state: "completed",
          progress: { accepted: 0, rejected: 0, uncertain: 0, skipped: 2 },
        });

        const rows = yield* sendRows(second.id);

        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.state === "skipped")).toBe(true);
      }),
      sendTestTimeout,
    );

    test(
      "counts injected opens per campaign and copy, and lists who opened first when",
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const quota = yield* accountSendQuota;
        const runId = yield* newIdentifier;
        const reader = simulator("success", runId);
        const list = yield* client.lists.create({ payload: { name: `opens-${runId}` } });

        yield* client.lists.import({
          params: { listId: list.id },
          payload: { contacts: [{ email: reader }] },
        });

        const campaign = yield* client.campaigns.create({
          payload: {
            listId: list.id,
            subject: `Emailer opens ${runId}`,
            text: `This message is opened by injected SES events.${textFooter}`,
          },
        });

        yield* sendToSimulatorList(client, list.id, campaign.id);
        yield* awaitCampaignState(
          client,
          campaign.id,
          "completed",
          campaignStateTimeout(1, quota?.MaxSendRate),
        );

        const [row] = yield* sendRows(campaign.id);

        if (row?.sendId === undefined || row.variant === undefined) {
          throw new Error(`campaign ${campaign.id} has no sent mail`);
        }

        const send = { contactId: row.contactId, sendId: row.sendId, variant: row.variant };

        // The second open arrives later but happened earlier: it becomes the first open.
        yield* injectOpen(campaign.id, send, "2026-09-11T10:05:00.000Z");
        yield* awaitCampaignOpens(client, campaign.id, 1);
        yield* injectOpen(campaign.id, send, "2026-09-11T10:01:00.000Z");

        const opened = yield* awaitCampaignOpens(client, campaign.id, 2);

        expect(opened.opens).toStrictEqual({
          unique: 1,
          total: 2,
          copies: { default: { unique: 1, total: 2 } },
        });
        expect(
          yield* client.campaigns.opens({ params: { id: campaign.id }, query: {} }),
        ).toStrictEqual({
          items: [
            {
              contactId: send.contactId,
              email: reader,
              copy: "default",
              firstOpenedAt: "2026-09-11T10:01:00.000Z",
              opens: 2,
            },
          ],
        });
      }),
      sendTestTimeout,
    );
  });
};
