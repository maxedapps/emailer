import { makeEmailerClient } from "@emailer/api/Client";
import type { EmailerClient } from "@emailer/api/Client";
import { Clock, DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { newIdentifier, nowIso } from "../Identifiers.ts";
import { CampaignChanged, RunSuperseded } from "../storage/Campaigns.ts";

import {
  accountSendQuota,
  awaitCampaignState,
  awaitStaleWakeLog,
  campaignMeta,
  campaignStateTimeout,
  configuration,
  disableDispatcherMapping,
  dispatchFailureCount,
  live,
  liveStorage,
  once,
  replayTransactWrite,
  sendRows,
  sendToSimulatorList,
  simulator,
  submitToSimulatorList,
} from "../../test/IntegrationSupport.ts";

import type { LiveStorage, TransactionCapture } from "../../test/IntegrationSupport.ts";

const sendTestTimeout = 480_000;

const mappingTestTimeout = 1_200_000;

const failIfPausedOrDraft = ["paused", "draft"] as const;

const importSimulatorContacts = (
  client: EmailerClient,
  listId: string,
  runId: string,
  count: number,
) =>
  client.lists.import({
    params: { listId },
    payload: {
      contacts: Array.from({ length: count }, (_, n) => ({
        email: simulator("success", runId, n),
      })),
    },
  });

const createSimulatorCampaign = (client: EmailerClient, runId: string, name: string, members = 2) =>
  Effect.gen(function* () {
    const list = yield* client.lists.create({ payload: { name: `${name}-${runId}` } });

    yield* importSimulatorContacts(client, list.id, runId, members);

    const campaign = yield* client.campaigns.create({
      payload: {
        listId: list.id,
        subject: `Queued cancel ${name} ${runId}`,
        text: `Simulator campaign ${runId} for ${name}.`,
      },
    });

    return { list, campaign };
  });

const requireMembers = (storage: LiveStorage, listId: string) =>
  Effect.gen(function* () {
    const listed = yield* storage.listMembers(listId, 25, undefined);

    if (listed.items[0] === undefined) {
      throw new Error(`list ${listId} has no members`);
    }

    return listed.items;
  });

const requireCapturedRequest = (capture: TransactionCapture) => {
  const request = capture.last;

  if (request === undefined) {
    throw new Error("no TransactWriteItems request was captured");
  }

  return request;
};

const enqueueDraft = (storage: LiveStorage, campaignId: string) =>
  Effect.gen(function* () {
    const token = yield* newIdentifier;

    yield* storage.newRun(
      campaignId,
      { state: "draft", runToken: undefined },
      token,
      "queued",
      yield* nowIso,
    );

    return token;
  });

describe("queued campaign cancellation", () => {
  it("conflicts cancel when beginRun commits first and does not reset history", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const ordinary = yield* liveStorage(settings.tableName);
        const runId = yield* newIdentifier;
        const { campaign } = yield* createSimulatorCampaign(client, runId, "begin-wins");
        const token = yield* enqueueDraft(ordinary, campaign.id);

        const interleaved = yield* liveStorage(
          settings.tableName,
          once(
            Effect.orDie(
              Effect.gen(function* () {
                yield* ordinary.beginRun(campaign.id, token, yield* nowIso);
              }),
            ),
          ),
        );

        const refused = yield* Effect.flip(
          interleaved.cancelCampaign(campaign.id, {
            state: "queued",
            runToken: token,
            started: false,
          }),
        );

        // The refused condition returned the campaign as DynamoDB held it: already sending.
        expect(refused).toBeInstanceOf(CampaignChanged);
        expect(refused).toMatchObject({ current: { state: "sending", runToken: token } });

        const control = yield* ordinary.getCampaignControl(campaign.id);

        expect(control.state).toBe("sending");
        expect(control.runToken).toBe(token);
        expect(control).toHaveProperty("startedAt");
        expect(yield* sendRows(campaign.id)).toHaveLength(0);
      }),
    ));

  it("treats beginRun as stale after cancel commits and writes no SEND rows", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const storage = yield* liveStorage(settings.tableName);
        const runId = yield* newIdentifier;
        const { campaign } = yield* createSimulatorCampaign(client, runId, "cancel-wins");
        const token = yield* enqueueDraft(storage, campaign.id);

        yield* storage.cancelCampaign(campaign.id, {
          state: "queued",
          runToken: token,
          started: false,
        });

        expect(
          yield* Effect.flip(storage.beginRun(campaign.id, token, yield* nowIso)),
        ).toStrictEqual(new RunSuperseded());

        const control = yield* storage.getCampaignControl(campaign.id);

        expect(control.state).toBe("draft");
        expect(control.runToken).toBe(token);
        expect(control).not.toHaveProperty("startedAt");
        expect(yield* sendRows(campaign.id)).toHaveLength(0);
      }),
    ));

  it(
    "cancels a seeded queued resume to manual-paused without rewriting history",
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
          const { list, campaign } = yield* createSimulatorCampaign(client, runId, "queued-resume");
          const members = yield* requireMembers(storage, list.id);
          const historic = members[0];
          const remaining = members[1];

          if (historic === undefined || remaining === undefined) {
            throw new Error("queued-resume campaign needs two members");
          }

          const seedToken = yield* enqueueDraft(storage, campaign.id);
          yield* storage.beginRun(campaign.id, seedToken, yield* nowIso);

          const sendId = yield* newIdentifier;
          const claimedAt = yield* nowIso;

          expect(
            yield* storage.claimRecipient(
              campaign.id,
              seedToken,
              historic.id,
              historic.email,
              sendId,
              claimedAt,
            ),
          ).toBe("claimed");
          yield* storage.settleRecipient(
            campaign.id,
            sendId,
            historic.id,
            { outcome: "accepted", messageId: "seeded-not-ses" },
            claimedAt,
          );

          const sliceId = yield* newIdentifier;

          yield* storage.checkpoint(campaign.id, seedToken, sliceId, undefined, historic.id);
          yield* storage.pauseRun(campaign.id, seedToken, "daily-quota", historic.id);

          const seededMeta = yield* campaignMeta(campaign.id);
          const seededRows = yield* sendRows(campaign.id);
          const seeded = yield* storage.getCampaignControl(campaign.id);

          if (seeded.state !== "paused") {
            throw new Error(`campaign ${campaign.id} was not seeded paused`);
          }

          expect(seeded.pausedReason).toBe("daily-quota");
          expect(seededRows).toHaveLength(1);
          expect(seededRows[0]).toMatchObject({
            contactId: historic.id,
            state: "accepted",
          });

          const resumeToken = yield* newIdentifier;

          yield* storage.newRun(
            campaign.id,
            { state: "paused", runToken: seedToken },
            resumeToken,
            "queued",
            yield* nowIso,
          );

          const cancelled = yield* client.campaigns.cancel({ params: { id: campaign.id } });

          expect(cancelled.submission.state).toBe("paused");

          if (cancelled.submission.state !== "paused") {
            throw new Error(`campaign ${campaign.id} was not manual-paused`);
          }

          expect(cancelled.submission.reason).toBe("manual");
          expect(cancelled.submission.startedAt).toBe(seeded.startedAt);
          expect(cancelled.submission.progress.accepted).toBe(1);
          expect(yield* storage.getCampaignControl(campaign.id)).toMatchObject({
            state: "paused",
            runToken: resumeToken,
            startedAt: seeded.startedAt,
            pausedReason: "manual",
          });
          expect((yield* campaignMeta(campaign.id)).cursor).toEqual(seededMeta.cursor);
          expect(yield* sendRows(campaign.id)).toStrictEqual(seededRows);

          yield* submitToSimulatorList(
            client,
            list.id,
            campaign.id,
            client.campaigns.resume({ params: { id: campaign.id } }),
          );

          const completed = yield* awaitCampaignState(
            client,
            campaign.id,
            "completed",
            timeout,
            failIfPausedOrDraft,
          );

          expect(completed.submission).toMatchObject({
            state: "completed",
            progress: { accepted: 2, rejected: 0, uncertain: 0, skipped: 0 },
          });

          const rows = yield* sendRows(campaign.id);

          expect(rows).toHaveLength(2);
          expect(rows.find((row) => row.contactId === historic.id)).toEqual(seededRows[0]);
          expect(rows.find((row) => row.contactId === remaining.id)?.state).toBe("accepted");
        }),
      ),
  );

  it("rejects a delayed first write after a draft-scheduled-draft cycle", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const storage = yield* liveStorage(settings.tableName);
        const runId = yield* newIdentifier;
        const { campaign } = yield* createSimulatorCampaign(client, runId, "stale-cycle");
        const token = yield* newIdentifier;

        const sendAt = DateTime.formatIso(
          DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 3_600_000),
        );

        yield* storage.newRun(
          campaign.id,
          { state: "draft", runToken: undefined },
          token,
          "scheduled",
          sendAt,
        );
        yield* storage.cancelCampaign(campaign.id, { state: "scheduled", runToken: token });

        expect(
          yield* Effect.flip(
            storage.newRun(
              campaign.id,
              { state: "draft", runToken: undefined },
              yield* newIdentifier,
              "queued",
              yield* nowIso,
            ),
          ),
        ).toBeInstanceOf(CampaignChanged);
        expect(
          yield* Effect.flip(
            storage.newRun(
              campaign.id,
              { state: "draft", runToken: undefined },
              yield* newIdentifier,
              "scheduled",
              sendAt,
            ),
          ),
        ).toBeInstanceOf(CampaignChanged);
        expect(
          yield* Effect.flip(storage.beginRun(campaign.id, token, yield* nowIso)),
        ).toStrictEqual(new RunSuperseded());

        const control = yield* storage.getCampaignControl(campaign.id);

        expect(control.state).toBe("draft");
        expect(control.runToken).toBe(token);
        expect(control).not.toHaveProperty("startedAt");
        expect((yield* campaignMeta(campaign.id)).queuedAt).toBeUndefined();
        expect(yield* sendRows(campaign.id)).toHaveLength(0);
      }),
    ));

  it("does not reapply a committed enqueue after cancellation", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const ordinary = yield* liveStorage(settings.tableName);
        const capture: TransactionCapture = { last: undefined };
        const capturing = yield* liveStorage(settings.tableName, Effect.void, capture);
        const runId = yield* newIdentifier;
        const { campaign } = yield* createSimulatorCampaign(client, runId, "enqueue-replay");
        const token = yield* newIdentifier;

        yield* capturing.newRun(
          campaign.id,
          { state: "draft", runToken: undefined },
          token,
          "queued",
          yield* nowIso,
        );

        const enqueueRequest = requireCapturedRequest(capture);

        yield* ordinary.cancelCampaign(campaign.id, {
          state: "queued",
          runToken: token,
          started: false,
        });

        yield* replayTransactWrite(enqueueRequest);

        const control = yield* ordinary.getCampaignControl(campaign.id);

        expect(control.state).toBe("draft");
        expect(control.runToken).toBe(token);
        expect(control).not.toHaveProperty("startedAt");
        expect(yield* sendRows(campaign.id)).toHaveLength(0);
      }),
    ));

  it("does not reapply a committed cancel after a replacement enqueue", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const ordinary = yield* liveStorage(settings.tableName);
        const capture: TransactionCapture = { last: undefined };
        const capturing = yield* liveStorage(settings.tableName, Effect.void, capture);
        const runId = yield* newIdentifier;
        const { campaign } = yield* createSimulatorCampaign(client, runId, "cancel-replay");
        const cancelledToken = yield* enqueueDraft(ordinary, campaign.id);

        yield* capturing.cancelCampaign(campaign.id, {
          state: "queued",
          runToken: cancelledToken,
          started: false,
        });

        const cancelRequest = requireCapturedRequest(capture);
        const replacement = yield* newIdentifier;

        yield* ordinary.newRun(
          campaign.id,
          { state: "draft", runToken: cancelledToken },
          replacement,
          "queued",
          yield* nowIso,
        );

        yield* replayTransactWrite(cancelRequest);

        const control = yield* ordinary.getCampaignControl(campaign.id);

        expect(control.state).toBe("queued");
        expect(control.runToken).toBe(replacement);
        expect(control).not.toHaveProperty("startedAt");
      }),
    ));

  it("keeps the original run baseline when feedback lands between resume commit and replay", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const ordinary = yield* liveStorage(settings.tableName);
        const capture: TransactionCapture = { last: undefined };
        const capturing = yield* liveStorage(settings.tableName, Effect.void, capture);
        const runId = yield* newIdentifier;

        const { list, campaign } = yield* createSimulatorCampaign(
          client,
          runId,
          "feedback-replay",
          1,
        );

        const members = yield* requireMembers(ordinary, list.id);
        const historic = members[0];

        if (historic === undefined) {
          throw new Error("feedback-replay campaign needs a member");
        }

        const seedToken = yield* enqueueDraft(ordinary, campaign.id);
        yield* ordinary.beginRun(campaign.id, seedToken, yield* nowIso);

        const sendId = yield* newIdentifier;
        const claimedAt = yield* nowIso;

        expect(
          yield* ordinary.claimRecipient(
            campaign.id,
            seedToken,
            historic.id,
            historic.email,
            sendId,
            claimedAt,
          ),
        ).toBe("claimed");
        yield* ordinary.settleRecipient(
          campaign.id,
          sendId,
          historic.id,
          { outcome: "accepted", messageId: "seeded-not-ses" },
          claimedAt,
        );
        yield* ordinary.pauseRun(campaign.id, seedToken, "daily-quota", historic.id);

        const resumeToken = yield* newIdentifier;

        yield* capturing.newRun(
          campaign.id,
          { state: "paused", runToken: seedToken },
          resumeToken,
          "queued",
          yield* nowIso,
        );

        const resumeRequest = requireCapturedRequest(capture);

        yield* ordinary.recordFeedback(
          {
            campaignId: campaign.id,
            kind: "bounce",
            feedbackId: yield* newIdentifier,
            recipient: historic.email,
            messageId: "seeded-feedback-not-ses",
            outcome: "recorded",
            receivedAt: yield* nowIso,
            bounceType: "Permanent",
            bounceSubType: "General",
          },
          { effect: "count", counter: "bounced" },
        );

        yield* replayTransactWrite(resumeRequest);

        const meta = yield* campaignMeta(campaign.id);

        expect(meta.bounced).toEqual({ N: "1" });
        expect(meta.runBounced).toEqual({ N: "0" });
        expect(meta.runAccepted).toEqual({ N: "1" });
        expect((yield* ordinary.getCampaignControl(campaign.id)).runToken).toBe(resumeToken);
      }),
    ));

  it(
    "consumes a cancelled queued wake as stale without SEND rows or startedAt",
    { timeout: mappingTestTimeout },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const storage = yield* liveStorage(settings.tableName);
          const runId = yield* newIdentifier;
          const { list, campaign } = yield* createSimulatorCampaign(client, runId, "queued-stale");
          const sinceMs = yield* Clock.currentTimeMillis;

          const token = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* disableDispatcherMapping;

              const sent = yield* sendToSimulatorList(client, list.id, campaign.id);

              expect(sent.submission.state).toBe("queued");

              const control = yield* storage.getCampaignControl(campaign.id);

              expect(control.state).toBe("queued");
              expect(control).not.toHaveProperty("startedAt");

              if (control.runToken === undefined) {
                throw new Error(`queued campaign ${campaign.id} has no run token`);
              }

              const cancelled = yield* client.campaigns.cancel({
                params: { id: campaign.id },
              });

              expect(cancelled.submission.state).toBe("draft");

              return control.runToken;
            }),
          );

          yield* awaitStaleWakeLog(campaign.id, token, sinceMs);

          const control = yield* storage.getCampaignControl(campaign.id);

          expect(control.state).toBe("draft");
          expect(control.runToken).toBe(token);
          expect(control).not.toHaveProperty("startedAt");
          expect(yield* sendRows(campaign.id)).toHaveLength(0);
          expect(yield* dispatchFailureCount).toBe(0);
        }),
      ),
  );
});
