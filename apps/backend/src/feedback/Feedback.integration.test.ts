import { makeEmailerClient } from "@emailer/api/Client";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { newIdentifier } from "../Identifiers.ts";

import {
  accountSendQuota,
  awaitAddressStatus,
  awaitCampaignFeedback,
  awaitCampaignState,
  campaignStateTimeout,
  configuration,
  live,
  liveStorage,
  sendRows,
  sendToSimulatorList,
  simulator,
} from "../../test/IntegrationSupport.ts";

const sendTestTimeout = 480_000;

describe("feedback and suppression", () => {
  it(
    "skips previously bounced and complained addresses on the next campaign",
    { timeout: sendTestTimeout },
    () =>
      live(
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
              text: "This message drives bounce and complaint through the SES mailbox simulator.",
            },
          });

          yield* sendToSimulatorList(client, list.id, first.id);

          const completed = yield* awaitCampaignState(client, first.id, "completed", timeout);

          expect(completed.submission).toMatchObject({
            state: "completed",
            progress: { accepted: 2, rejected: 0, uncertain: 0, skipped: 0 },
          });

          const counted = yield* awaitCampaignFeedback(
            client,
            first.id,
            { bounced: 1, complained: 1 },
            timeout,
          );

          expect(counted.submission).toMatchObject({
            feedback: { bounced: 1, complained: 1 },
          });

          expect(yield* awaitAddressStatus(storage, bounce, "suppressed")).toBe("suppressed");
          expect(yield* awaitAddressStatus(storage, complaint, "suppressed")).toBe("suppressed");

          const second = yield* client.campaigns.create({
            payload: {
              listId: list.id,
              subject: `Emailer feedback skipped ${runId}`,
              text: "These two recipients must be skipped.",
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
      ),
  );
});
