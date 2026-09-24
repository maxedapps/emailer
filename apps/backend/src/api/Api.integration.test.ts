import { Unauthorized } from "@emailer/api/Api";
import { makeEmailerClient } from "@emailer/api/Client";
import type { EmailerClient } from "@emailer/api/Client";
import * as Schemas from "@emailer/api/Schemas";
import {
  Clock,
  Config,
  DateTime,
  Duration,
  Effect,
  Exit,
  Option,
  Redacted,
  Result,
  Schedule,
} from "effect";
import { describe, expect, it } from "vitest";

import { newIdentifier, nowIso } from "../Identifiers.ts";
import { StorageFailure } from "../storage/Errors.ts";

import {
  accountSendQuota,
  addressRecord,
  awaitCampaignFeedback,
  awaitCampaignState,
  campaignStateTimeout,
  configuration,
  contactFor,
  deleteSuppressedDestination,
  describeAlarms,
  dispatchFailureCount,
  getSuppressedDestination,
  live,
  liveStorage,
  pacedSendLimit,
  putSuppressedDestination,
  rateLimitItem,
  sendRows,
  sendToSimulatorList,
  setAlarmState,
  simulator,
  submitted,
  submitToSimulatorList,
  uniqueAddress,
  unsuppress,
} from "../../test/IntegrationSupport.ts";

const sendTestTimeout = 480_000;

const breakerTestTimeout = 1_200_000;

const failIfCompleted = ["completed"] as const;

const failIfPausedOrDraft = ["paused", "draft"] as const;

const importSuccessContacts = (
  client: EmailerClient,
  listId: string,
  runId: string,
  count: number,
) =>
  Effect.gen(function* () {
    const contacts: Array<{ readonly email: string }> = [];

    for (let n = 0; n < count; n += 1) {
      contacts.push({ email: simulator("success", runId, n) });
    }

    const batchSize = Schemas.maxImportEntries;

    for (let start = 0; start < contacts.length; start += batchSize) {
      yield* client.lists.import({
        params: { listId },
        payload: { contacts: contacts.slice(start, start + batchSize) },
      });
    }
  });

const finishedAtSecond = (finishedAt: string | undefined, contactId: string): string => {
  if (finishedAt === undefined) {
    throw new Error(`SEND#${contactId} is missing finishedAt`);
  }

  return finishedAt.slice(0, 19);
};

describe("the deployed service", () => {
  it(
    "imports sixty simulator contacts, completes across two pages, and paces under the account ceiling",
    { timeout: sendTestTimeout },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const quota = yield* accountSendQuota;
          const limit = pacedSendLimit(quota?.MaxSendRate);
          const timeout = campaignStateTimeout(60, quota?.MaxSendRate);
          const runId = yield* newIdentifier;

          yield* Effect.logInfo("send quota", {
            maxSendRate: quota?.MaxSendRate,
            pacedLimit: limit,
            timeoutMs: Duration.toMillis(timeout),
          });

          const list = yield* client.lists.create({ payload: { name: `sixty-${runId}` } });

          yield* importSuccessContacts(client, list.id, runId, 60);

          const campaign = yield* client.campaigns.create({
            payload: {
              listId: list.id,
              subject: `Emailer integration ${runId}`,
              text: `Sixty labelled simulator recipients for campaign ${runId}.`,
            },
          });

          expect(campaign.submission.state).toBe("draft");

          const runStart = yield* Clock.currentTimeMillis;
          const sent = yield* sendToSimulatorList(client, list.id, campaign.id);

          expect(submitted.includes(sent.submission.state)).toBe(true);

          const completed = yield* awaitCampaignState(client, campaign.id, "completed", timeout);

          expect(completed.submission).toMatchObject({
            state: "completed",
            progress: { accepted: 60, rejected: 0, uncertain: 0, skipped: 0 },
            feedback: { bounced: 0, complained: 0 },
          });

          const rows = yield* sendRows(campaign.id);

          expect(rows).toHaveLength(60);
          expect(rows.every((row) => row.state === "accepted")).toBe(true);

          const limiter = yield* rateLimitItem;

          expect(limiter.expiresAt).toBeGreaterThanOrEqual(runStart);

          const buckets = new Map<string, number>();

          for (const row of rows) {
            const second = finishedAtSecond(row.finishedAt, row.contactId);
            const count = buckets.get(second) ?? 0;

            buckets.set(second, count + 1);
          }

          for (const count of buckets.values()) {
            expect(count).toBeLessThanOrEqual(limit);
          }

          expect(yield* dispatchFailureCount).toBe(0);

          yield* Effect.logInfo("integration campaign", {
            campaignId: campaign.id,
            pacedLimit: limit,
            buckets: buckets.size,
          });
        }),
      ),
  );

  it(
    "lets two concurrent sends both queue, then settles exactly one row per member",
    {
      timeout: sendTestTimeout,
    },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const quota = yield* accountSendQuota;
          const timeout = campaignStateTimeout(2, quota?.MaxSendRate);
          const runId = yield* newIdentifier;
          const list = yield* client.lists.create({ payload: { name: `race-${runId}` } });

          yield* importSuccessContacts(client, list.id, runId, 2);

          const campaign = yield* client.campaigns.create({
            payload: {
              listId: list.id,
              subject: `Emailer concurrency ${runId}`,
              text: "Two requests raced for this campaign; only one row may exist per member.",
            },
          });

          const outcomes = yield* Effect.all(
            [
              sendToSimulatorList(client, list.id, campaign.id),
              sendToSimulatorList(client, list.id, campaign.id),
            ],
            { concurrency: 2, mode: "result" },
          );

          const states = outcomes.flatMap((outcome) =>
            Result.isSuccess(outcome) ? [outcome.success.submission.state] : [],
          );

          // Both calls succeed. The API re-reads after enqueue, so a fast dispatcher can
          // already have moved a two-member campaign to sending, or completed it, before the
          // second response.
          expect(outcomes.every(Result.isSuccess)).toBe(true);
          expect(states).toHaveLength(2);
          expect(states.every((state) => submitted.includes(state))).toBe(true);

          yield* awaitCampaignState(client, campaign.id, "completed", timeout);

          const rows = yield* sendRows(campaign.id);
          const contactIds = rows.map((row) => row.contactId);

          expect(rows).toHaveLength(2);
          expect(new Set(contactIds).size).toBe(2);
        }),
      ),
  );

  it(
    "creates a text+html campaign, keeps html through a completed two-member send, and accepts both rows",
    { timeout: sendTestTimeout },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const quota = yield* accountSendQuota;
          const timeout = campaignStateTimeout(2, quota?.MaxSendRate);
          const runId = yield* newIdentifier;
          const list = yield* client.lists.create({ payload: { name: `html-${runId}` } });
          const html = "<html><body><p>Hello</p></body></html>";

          yield* importSuccessContacts(client, list.id, runId, 2);

          const created = yield* client.campaigns.create({
            payload: {
              listId: list.id,
              subject: `Emailer html ${runId}`,
              text: `Two labelled simulator recipients for html campaign ${runId}.`,
              html,
            },
          });

          expect(created.html).toBe(html);

          yield* sendToSimulatorList(client, list.id, created.id);

          const completed = yield* awaitCampaignState(client, created.id, "completed", timeout);

          expect(completed.html).toBe(html);

          const rows = yield* sendRows(created.id);

          expect(rows).toHaveLength(2);
          expect(rows.every((row) => row.state === "accepted")).toBe(true);
        }),
      ),
  );

  it(
    "creates a campaign filtered to plan=pro, lists the filter, and accepts only the two matching members",
    { timeout: sendTestTimeout },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const quota = yield* accountSendQuota;
          const timeout = campaignStateTimeout(3, quota?.MaxSendRate);
          const runId = yield* newIdentifier;
          const filter = { plan: "pro" };
          const list = yield* client.lists.create({ payload: { name: `filter-${runId}` } });

          const proA = yield* client.contacts.create({
            payload: {
              email: simulator("success", runId, 0),
              attributes: { plan: "pro" },
            },
          });

          const proB = yield* client.contacts.create({
            payload: {
              email: simulator("success", runId, 1),
              attributes: { plan: "pro" },
            },
          });

          const free = yield* client.contacts.create({
            payload: {
              email: simulator("success", runId, 2),
              attributes: { plan: "free" },
            },
          });

          yield* client.lists.addContact({ params: { listId: list.id, contactId: proA.id } });
          yield* client.lists.addContact({ params: { listId: list.id, contactId: proB.id } });
          yield* client.lists.addContact({ params: { listId: list.id, contactId: free.id } });

          const campaign = yield* client.campaigns.create({
            payload: {
              listId: list.id,
              subject: `Emailer filter ${runId}`,
              text: `Three labelled simulator recipients, two matching plan=pro, for campaign ${runId}.`,
              filter,
            },
          });

          expect(campaign.filter).toStrictEqual(filter);

          // The index is eventually consistent, so the entry may take a moment to appear. After
          // other campaigns the first page of 100 is older drafts, so walk cursors until this id.
          const found = yield* Effect.gen(function* () {
            let cursor: string | undefined;

            for (;;) {
              const page = yield* client.campaigns.list({
                query: cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
              });

              const match = page.items.find((item) => item.id === campaign.id);

              if (match !== undefined) {
                return Option.some(match);
              }

              if (page.nextCursor === undefined) {
                return Option.none();
              }

              cursor = page.nextCursor;
            }
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: Option.isSome,
            }),
            Effect.timeoutOrElse({
              duration: "45 seconds",
              orElse: () => Effect.succeedNone,
            }),
          );

          expect(Option.getOrUndefined(found)?.filter).toStrictEqual(filter);

          yield* sendToSimulatorList(client, list.id, campaign.id);

          const completed = yield* awaitCampaignState(client, campaign.id, "completed", timeout);

          expect(completed.submission).toMatchObject({
            state: "completed",
            progress: { accepted: 2, rejected: 0, uncertain: 0, skipped: 0 },
          });

          const rows = yield* sendRows(campaign.id);

          expect(rows).toHaveLength(2);
          expect(rows.every((row) => row.state === "accepted")).toBe(true);
          expect(new Set(rows.map((row) => row.contactId))).toStrictEqual(
            new Set([proA.id, proB.id]),
          );
        }),
      ),
  );

  it(
    "schedules two simulator contacts for the next whole minute, fires, and accepts both rows",
    { timeout: sendTestTimeout + 180_000 },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const quota = yield* accountSendQuota;

          const timeout = Duration.sum(
            campaignStateTimeout(2, quota?.MaxSendRate),
            Duration.minutes(3),
          );

          const runId = yield* newIdentifier;
          const list = yield* client.lists.create({ payload: { name: `schedule-${runId}` } });

          yield* importSuccessContacts(client, list.id, runId, 2);

          const campaign = yield* client.campaigns.create({
            payload: {
              listId: list.id,
              subject: `Emailer schedule ${runId}`,
              text: `Two labelled simulator recipients for scheduled campaign ${runId}.`,
            },
          });

          const now = yield* Clock.currentTimeMillis;
          const sendAtMs = Math.ceil((now + 90_000) / 60_000) * 60_000;
          const sendAt = DateTime.formatIso(DateTime.makeUnsafe(sendAtMs));

          const scheduled = yield* submitToSimulatorList(
            client,
            list.id,
            campaign.id,
            client.campaigns.schedule({ params: { id: campaign.id }, payload: { sendAt } }),
          );

          expect(scheduled.submission).toStrictEqual({ state: "scheduled", sendAt });

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

          if (completed.submission.state !== "completed") {
            throw new Error(`campaign ${campaign.id} was not completed`);
          }

          expect(Date.parse(completed.submission.startedAt)).toBeGreaterThanOrEqual(
            Date.parse(sendAt) - 1000,
          );

          yield* Effect.logInfo("schedule fire offset", {
            campaignId: campaign.id,
            sendAt,
            startedAt: completed.submission.startedAt,
            offsetMs: Date.parse(completed.submission.startedAt) - Date.parse(sendAt),
          });

          const rows = yield* sendRows(campaign.id);

          expect(rows).toHaveLength(2);
          expect(rows.every((row) => row.state === "accepted")).toBe(true);
        }),
      ),
  );

  it(
    "cancels a scheduled campaign back to a usable draft and refuses a past sendAt",
    { timeout: sendTestTimeout },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const quota = yield* accountSendQuota;
          const timeout = campaignStateTimeout(2, quota?.MaxSendRate);
          const runId = yield* newIdentifier;
          const list = yield* client.lists.create({ payload: { name: `cancel-${runId}` } });

          yield* importSuccessContacts(client, list.id, runId, 2);

          const campaign = yield* client.campaigns.create({
            payload: {
              listId: list.id,
              subject: `Emailer cancel ${runId}`,
              text: `Two labelled simulator recipients for cancelled campaign ${runId}.`,
            },
          });

          const pastSendAt = "2020-01-01T00:00:00.000Z";

          const past = yield* Effect.result(
            client.campaigns.schedule({
              params: { id: campaign.id },
              payload: { sendAt: pastSendAt },
            }),
          );

          expect(Result.isFailure(past) ? past.failure : undefined).toStrictEqual(
            new Schemas.SendAtNotInFuture({ sendAt: pastSendAt }),
          );

          const now = yield* Clock.currentTimeMillis;
          const sendAt = DateTime.formatIso(DateTime.makeUnsafe(now + 3_600_000));

          const scheduled = yield* submitToSimulatorList(
            client,
            list.id,
            campaign.id,
            client.campaigns.schedule({ params: { id: campaign.id }, payload: { sendAt } }),
          );

          expect(scheduled.submission).toStrictEqual({ state: "scheduled", sendAt });

          const cancelled = yield* client.campaigns.cancel({ params: { id: campaign.id } });

          expect(cancelled.submission.state).toBe("draft");

          yield* sendToSimulatorList(client, list.id, campaign.id);

          const completed = yield* awaitCampaignState(client, campaign.id, "completed", timeout);

          expect(completed.submission).toMatchObject({
            state: "completed",
            progress: { accepted: 2, rejected: 0, uncertain: 0, skipped: 0 },
          });

          const rows = yield* sendRows(campaign.id);

          expect(rows).toHaveLength(2);
          expect(rows.every((row) => row.state === "accepted")).toBe(true);
        }),
      ),
  );

  it(
    "completes a send against an empty list with every counter at zero",
    {
      timeout: sendTestTimeout,
    },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const quota = yield* accountSendQuota;
          const timeout = campaignStateTimeout(0, quota?.MaxSendRate);
          const list = yield* client.lists.create({ payload: { name: "empty audience" } });

          const campaign = yield* client.campaigns.create({
            payload: { listId: list.id, subject: "Never sent", text: "Never sent." },
          });

          const sent = yield* sendToSimulatorList(client, list.id, campaign.id);

          expect(submitted.includes(sent.submission.state)).toBe(true);

          const completed = yield* awaitCampaignState(client, campaign.id, "completed", timeout);

          expect(completed.submission).toMatchObject({
            state: "completed",
            progress: { accepted: 0, rejected: 0, uncertain: 0, skipped: 0 },
          });

          expect(yield* sendRows(campaign.id)).toStrictEqual([]);
        }),
      ),
  );

  it(
    "pauses a 400-member campaign when bounce feedback trips the breaker",
    { timeout: breakerTestTimeout },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const quota = yield* accountSendQuota;
          const timeout = campaignStateTimeout(400, quota?.MaxSendRate);
          const runId = yield* newIdentifier;
          const list = yield* client.lists.create({ payload: { name: `breaker-${runId}` } });
          const contacts: Array<{ readonly email: string }> = [];

          for (let n = 0; n < 200; n += 1) {
            contacts.push({ email: simulator("bounce", runId, n) });
          }

          for (let n = 0; n < 200; n += 1) {
            contacts.push({ email: simulator("success", runId, n) });
          }

          const batchSize = Schemas.maxImportEntries;

          for (let start = 0; start < contacts.length; start += batchSize) {
            yield* client.lists.import({
              params: { listId: list.id },
              payload: { contacts: contacts.slice(start, start + batchSize) },
            });
          }

          const campaign = yield* client.campaigns.create({
            payload: {
              listId: list.id,
              subject: `Emailer breaker ${runId}`,
              text: "Half of these labelled simulator recipients bounce.",
            },
          });

          const sent = yield* sendToSimulatorList(client, list.id, campaign.id);

          expect(submitted.includes(sent.submission.state)).toBe(true);

          const paused = yield* awaitCampaignState(
            client,
            campaign.id,
            "paused",
            timeout,
            failIfCompleted,
          );

          if (paused.submission.state !== "paused") {
            throw new Error(`campaign ${campaign.id} was not paused`);
          }

          expect(paused.submission.reason).toBe("feedback");
          expect(paused.submission.progress.accepted).toBeGreaterThanOrEqual(200);
          expect(paused.submission.feedback.bounced).toBeGreaterThanOrEqual(10);

          const rows = yield* sendRows(campaign.id);
          const accepted = rows.filter((row) => row.state === "accepted");
          const skipped = rows.filter((row) => row.state === "skipped");

          const bounceAccepted = accepted.filter((row) =>
            row.recipient.startsWith(`bounce+${runId}-`),
          );

          expect(rows).toHaveLength(
            paused.submission.progress.accepted + paused.submission.progress.skipped,
          );
          expect(accepted).toHaveLength(paused.submission.progress.accepted);
          expect(skipped).toHaveLength(paused.submission.progress.skipped);
          expect(rows.every((row) => row.state === "accepted" || row.state === "skipped")).toBe(
            true,
          );

          yield* awaitCampaignFeedback(
            client,
            campaign.id,
            { bounced: bounceAccepted.length, complained: 0 },
            timeout,
          );

          const sample = bounceAccepted[0];

          if (sample === undefined) {
            throw new Error("breaker campaign accepted no bounce recipients");
          }

          const record = yield* addressRecord(client, sample.recipient);

          expect(record.status).toBe("suppressed");
          expect(record.accountSuppression).toBeNull();
        }),
      ),
  );

  it(
    "pauses a send when the set bounce alarm is in ALARM and resumes after it is cleared",
    { timeout: sendTestTimeout },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const alarmName = yield* Config.String("EMAILER_TEST_SET_BOUNCE_ALARM");
          const quota = yield* accountSendQuota;
          const timeout = campaignStateTimeout(5, quota?.MaxSendRate);
          const runId = yield* newIdentifier;

          yield* Effect.gen(function* () {
            yield* setAlarmState(alarmName, "ALARM");

            expect((yield* describeAlarms(alarmName)).StateValue).toBe("ALARM");

            const list = yield* client.lists.create({ payload: { name: `gate-${runId}` } });

            yield* importSuccessContacts(client, list.id, runId, 5);

            const campaign = yield* client.campaigns.create({
              payload: {
                listId: list.id,
                subject: `Emailer gate ${runId}`,
                text: "Five labelled simulator recipients behind a forced set bounce alarm.",
              },
            });

            const sent = yield* sendToSimulatorList(client, list.id, campaign.id);

            // The alarm pauses the run at its first slice, which can land before the send re-reads.
            expect([...submitted, "paused"].includes(sent.submission.state)).toBe(true);

            const paused = yield* awaitCampaignState(
              client,
              campaign.id,
              "paused",
              timeout,
              failIfCompleted,
            );

            if (paused.submission.state !== "paused") {
              throw new Error(`campaign ${campaign.id} was not paused`);
            }

            expect(paused.submission.reason).toBe("reputation");

            yield* setAlarmState(alarmName, "OK");

            const resumed = yield* client.campaigns.resume({ params: { id: campaign.id } });

            expect(
              resumed.submission.state === "queued" || resumed.submission.state === "sending",
            ).toBe(true);

            const completed = yield* awaitCampaignState(client, campaign.id, "completed", timeout);

            expect(completed.submission.state).toBe("completed");
          }).pipe(Effect.ensuring(setAlarmState(alarmName, "OK").pipe(Effect.orDie)));
        }),
      ),
  );

  it("reads and clears a seeded account suppression entry", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const runId = yield* newIdentifier;
        // SES PutSuppressedDestination rejects mailbox-simulator addresses as invalid.
        const seed = `seed+${runId}@example.com`;

        yield* Effect.gen(function* () {
          yield* putSuppressedDestination(seed);

          yield* getSuppressedDestination(seed).pipe(
            Effect.asSome,
            Effect.catchTag("NotFoundException", () => Effect.succeedNone),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: Option.isSome,
            }),
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.die(new Error(`${seed} did not appear on the account suppression list`)),
            }),
          );

          const listed = yield* addressRecord(client, seed);

          expect(listed.status).toBe("mailable");
          expect(listed.accountSuppression).not.toBeNull();

          const cleared = yield* unsuppress(client, seed);

          expect(cleared.accountSuppression).toBeNull();

          const missing = yield* getSuppressedDestination(seed).pipe(
            Effect.as(false),
            Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
          );

          expect(missing).toBe(true);
        }).pipe(
          Effect.ensuring(
            deleteSuppressedDestination(seed).pipe(
              Effect.catchTag("NotFoundException", () => Effect.void),
              Effect.orDie,
            ),
          ),
        );
      }),
    ));

  it("refuses to send a list that contains a non-simulator member", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const storage = yield* liveStorage(settings.tableName);
        const email = yield* uniqueAddress;
        const contactId = yield* contactFor(storage, email);
        const list = yield* client.lists.create({ payload: { name: "invalid audience" } });

        yield* client.lists.addContact({ params: { listId: list.id, contactId } });

        const campaign = yield* client.campaigns.create({
          payload: {
            listId: list.id,
            subject: "Must not send",
            text: "A non-simulator member must be refused before send.",
          },
        });

        const attempt = yield* Effect.exit(sendToSimulatorList(client, list.id, campaign.id));

        expect(Exit.isFailure(attempt)).toBe(true);

        const stored = yield* client.campaigns.get({ params: { id: campaign.id } });

        expect(stored.submission.state).toBe("draft");
      }),
    ));

  it("refuses a wrong credential", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;

        const client = yield* makeEmailerClient(
          settings.apiUrl,
          Redacted.make("Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp_Oo-NnMmLlK"),
        );

        const attempt = yield* Effect.result(
          client.lists.create({ payload: { name: "should not exist" } }),
        );

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toBeInstanceOf(
          Unauthorized,
        );
      }),
    ));
});

describe("the deployed table", () => {
  it("treats a repeated membership as a no-op", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const storage = yield* liveStorage(settings.tableName);

        const listId = yield* newIdentifier;
        const now = yield* nowIso;
        const contactId = yield* contactFor(storage, yield* uniqueAddress);
        yield* storage.createList({ id: listId, name: "condition probe", createdAt: now });

        expect(yield* storage.addMember(listId, contactId, now)).toBe("added");
        expect(yield* storage.addMember(listId, contactId, now)).toBe("already-member");

        const members = yield* storage.listMembers(listId, 100, undefined);

        expect(members.items.map((contact) => contact.id)).toStrictEqual([contactId]);

        yield* storage.deleteList(listId);
        yield* storage.deleteContact(contactId);
      }),
    ));

  it("refuses a membership in a list that is not there and writes neither direction", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const storage = yield* liveStorage(settings.tableName);

        const listId = yield* newIdentifier;
        const now = yield* nowIso;
        // The contact exists, so the refusal can only come from the list check: slot 0 checks the
        // contact and would answer a missing contact first whatever the list slot holds.
        const contactId = yield* contactFor(storage, yield* uniqueAddress);

        expect(yield* Effect.flip(storage.addMember(listId, contactId, now))).toStrictEqual(
          new Schemas.NotFound({ entity: "list" }),
        );

        // No read path shows a membership of a list that is not there, so the absence of both
        // directions is proven by creating the list and adding the contact again: both member
        // `Put`s are conditional on absence, and `addMember` reports `already-member` if the
        // refused attempt had left either behind.
        yield* storage.createList({ id: listId, name: "missing-list probe", createdAt: now });

        expect(yield* storage.addMember(listId, contactId, now)).toBe("added");

        yield* storage.deleteList(listId);
        yield* storage.deleteContact(contactId);
      }),
    ));
});

describe("the deployed listing index", () => {
  it("queries the index without a consistent read and hydrates whole entities", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const storage = yield* liveStorage(settings.tableName);

        const id = yield* newIdentifier;
        const now = yield* nowIso;
        const email = yield* uniqueAddress;

        yield* storage.createContact({ id, email, createdAt: now });

        // The index is eventually consistent, so the entry may take a moment to appear. After a
        // large import the first page of 100 is older contacts, so walk cursors until this id.
        const found = yield* Effect.gen(function* () {
          let cursor: string | undefined;

          for (;;) {
            const page = yield* storage.listContacts(100, cursor);
            const match = page.items.find((contact) => contact.id === id);

            if (match !== undefined) {
              return Option.some(match);
            }

            if (page.nextCursor === undefined) {
              return Option.none();
            }

            cursor = page.nextCursor;
          }
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: Option.isSome,
          }),
          Effect.timeoutOrElse({
            duration: "45 seconds",
            orElse: () => Effect.succeedNone,
          }),
        );

        expect(Option.getOrUndefined(found)?.email).toBe(email);

        yield* storage.deleteContact(id);
      }),
    ));

  it("pages lists through a cursor built from domain values", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const storage = yield* liveStorage(settings.tableName);

        const now = yield* nowIso;
        const created: Array<string> = [];

        for (let index = 0; index < 2; index += 1) {
          const id = yield* newIdentifier;

          yield* storage.createList({ id, name: `cursor probe ${index}`, createdAt: now });
          created.push(id);
        }

        const first = yield* storage.listLists(1, undefined);

        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toBeDefined();

        const second = yield* storage.listLists(1, first.nextCursor);

        expect(second.items[0]?.id).not.toBe(first.items[0]?.id);

        for (const id of created) {
          yield* storage.deleteList(id);
        }
      }),
    ));

  it("includes a campaign created through the API", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const runId = yield* newIdentifier;

        const list = yield* client.lists.create({ payload: { name: `listing-${runId}` } });

        const campaign = yield* client.campaigns.create({
          payload: {
            listId: list.id,
            subject: `Listing ${runId}`,
            text: `Index probe ${runId}.`,
          },
        });

        // The index is eventually consistent, so the entry may take a moment to appear. After
        // other campaigns the first page of 100 is older drafts, so walk cursors until this id.
        const found = yield* Effect.gen(function* () {
          let cursor: string | undefined;

          for (;;) {
            const page = yield* client.campaigns.list({
              query: cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
            });

            const match = page.items.find((item) => item.id === campaign.id);

            if (match !== undefined) {
              return Option.some(match);
            }

            if (page.nextCursor === undefined) {
              return Option.none();
            }

            cursor = page.nextCursor;
          }
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: Option.isSome,
          }),
          Effect.timeoutOrElse({
            duration: "45 seconds",
            orElse: () => Effect.succeedNone,
          }),
        );

        expect(Option.getOrUndefined(found)?.id).toBe(campaign.id);
        expect(Option.getOrUndefined(found)).not.toHaveProperty("text");

        const fetched = yield* client.campaigns.get({ params: { id: campaign.id } });

        expect(fetched.text).toBe(`Index probe ${runId}.`);
      }),
    ));
});

describe("the deployed contact identity", () => {
  it("refuses a second contact on one address and finds the first by it", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const storage = yield* liveStorage(settings.tableName);

        const id = yield* newIdentifier;
        const now = yield* nowIso;
        const email = yield* uniqueAddress;

        yield* storage.createContact({ id, email, createdAt: now });

        expect(
          yield* Effect.flip(
            storage.createContact({
              id: yield* newIdentifier,
              email: email.toUpperCase(),
              createdAt: now,
            }),
          ),
        ).toStrictEqual(new Schemas.EmailAlreadyUsed({ email: email.toUpperCase() }));

        const found = yield* storage.getContactByEmail(email.toUpperCase());

        expect(found.id).toBe(id);

        yield* storage.deleteContact(id);
      }),
    ));

  it("moves the reservation with the address, freeing the old one", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const storage = yield* liveStorage(settings.tableName);

        const id = yield* newIdentifier;
        const now = yield* nowIso;
        const original = yield* uniqueAddress;
        const replacement = yield* uniqueAddress;

        yield* storage.createContact({ id, email: original, createdAt: now });

        const updated = yield* storage.updateContact(id, { email: replacement });

        expect(updated.email).toBe(replacement);
        expect(yield* Effect.flip(storage.getContactByEmail(original))).toStrictEqual(
          new Schemas.NotFound({ entity: "contact" }),
        );
        expect((yield* storage.getContactByEmail(replacement)).id).toBe(id);

        yield* storage.deleteContact(id);
      }),
    ));

  it("clears fields by writing the contact without them", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const storage = yield* liveStorage(settings.tableName);

        const id = yield* newIdentifier;
        const now = yield* nowIso;

        yield* storage.createContact({
          id,
          email: yield* uniqueAddress,
          name: "Clearable",
          createdAt: now,
          attributes: { plan: "pro" },
        });

        // The whole item is written, so a cleared field is simply absent from it.
        const cleared = yield* storage.updateContact(id, { name: null, attributes: null });
        const stored = yield* storage.getContact(id);

        expect(stored).toStrictEqual({ id, email: stored.email, createdAt: now });
        expect(cleared).toStrictEqual(stored);

        yield* storage.deleteContact(id);
      }),
    ));

  it("removes both membership directions when a contact is deleted", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const storage = yield* liveStorage(settings.tableName);

        const id = yield* newIdentifier;
        const listId = yield* newIdentifier;
        const now = yield* nowIso;
        const email = yield* uniqueAddress;

        yield* storage.createContact({ id, email, createdAt: now });
        yield* storage.createList({ id: listId, name: "cascade probe", createdAt: now });
        yield* storage.addMember(listId, id, now);

        yield* storage.deleteContact(id);

        const members = yield* storage.listMembers(listId, 100, undefined);

        expect(members.items).toStrictEqual([]);
        expect(yield* Effect.flip(storage.getContact(id))).toStrictEqual(
          new Schemas.NotFound({ entity: "contact" }),
        );

        // The reverse item is gone too. No read path exposes it, so it is proven by rebuilding the
        // contact and re-adding it: both member `Put`s are conditional on absence, and `addMember`
        // reports `already-member` if either survives. Asserting a missing contact before the
        // rebuild would prove nothing — the contact check is slot 0 and answers first whatever the
        // membership slots hold.
        yield* storage.createContact({ id, email, createdAt: now });

        expect(yield* storage.addMember(listId, id, now)).toBe("added");

        yield* storage.deleteList(listId);
        yield* storage.deleteContact(id);
      }),
    ));
});

describe("the deployed delete cascade", () => {
  it("clears a list larger than one cascade page, in both directions", { timeout: 300_000 }, () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const storage = yield* liveStorage(settings.tableName);

        const listId = yield* newIdentifier;
        const now = yield* nowIso;

        yield* storage.createList({ id: listId, name: "page probe", createdAt: now });

        // Three batches of twenty: more members than one cascade page of forty clears, so the
        // list delete must run at least two transactions and follow its continuation key.
        const members: Array<string> = [];

        for (let batch = 0; batch < 3; batch += 1) {
          const candidates = yield* Effect.forEach(Array.from({ length: 20 }), () =>
            Effect.gen(function* () {
              return { id: yield* newIdentifier, email: yield* uniqueAddress, createdAt: now };
            }),
          );

          const result = yield* storage.importContacts(listId, candidates, now);

          members.push(...result.contacts.map((entry) => entry.contactId));
        }

        expect(members).toHaveLength(60);

        const before = yield* storage.listMembers(listId, 100, undefined);

        expect(before.items).toHaveLength(60);

        yield* storage.deleteList(listId);

        expect(yield* Effect.flip(storage.getList(listId))).toStrictEqual(
          new Schemas.NotFound({ entity: "list" }),
        );
        expect(yield* Effect.flip(storage.listMembers(listId, 100, undefined))).toStrictEqual(
          new Schemas.NotFound({ entity: "list" }),
        );

        // `listMembers` reads the list's META first, so its `NotFound` says the list is gone and
        // nothing about the members. The reverse items are proven separately: rebuilding the list
        // under the same identifier and re-adding a former member can only report `added` if the
        // `CONTACT#…/LISTOF#<listId>` item went with the cascade, since that member `Put` is
        // conditional on absence.
        const rebuilt = members[0];

        if (rebuilt === undefined) {
          throw new Error("the probe list produced no members");
        }

        yield* storage.createList({ id: listId, name: "page probe", createdAt: now });

        expect(yield* storage.addMember(listId, rebuilt, now)).toBe("added");

        yield* storage.deleteList(listId);

        for (const contactId of members) {
          yield* storage.deleteContact(contactId);
        }
      }),
    ),
  );

  /**
   * `importContacts` reads each address's current holder, then commits. Between those two moments
   * the holder can change — a contact moved off the address, or deleted and the address taken by
   * another. The import's advice is then stale, and without the reservation check it would join a
   * contact to the list under an address it no longer holds.
   *
   * The move is made from inside the import's own commit, after its advisory read, rather than by
   * racing two clients — so this asserts that DynamoDB evaluates the condition, not the scheduler.
   */
  it("refuses an import whose address changed hands after it read the holder", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const storage = yield* liveStorage(settings.tableName);

        const address = yield* uniqueAddress;
        const elsewhere = yield* uniqueAddress;

        const listId = yield* newIdentifier;
        const now = yield* nowIso;

        yield* storage.createList({ id: listId, name: `stale-import-${listId}`, createdAt: now });

        // The holder the import will read.
        const original = yield* contactFor(storage, address);

        // Everything the import reads is true when it reads it — and stops being true before it
        // commits: this storage moves the contact off the address just before sending the import's
        // transaction.
        const moveBeforeCommit = Effect.orDie(
          storage.updateContact(original, { email: elsewhere }),
        );

        const interleaved = yield* liveStorage(settings.tableName, moveBeforeCommit);

        const attempt = yield* Effect.result(
          interleaved.importContacts(
            listId,
            [{ id: original, email: address, createdAt: now }],
            yield* nowIso,
          ),
        );

        // Slot 0 checks the list, slot 1 checks the contact exists, slot 2 is the holder check.
        // Exactly that slot failing says DynamoDB refused the stale holder and nothing else.
        const refusal = Result.isFailure(attempt) ? attempt.failure : undefined;

        expect(refusal).toBeInstanceOf(StorageFailure);
        expect(refusal).toMatchObject({
          operationId: "importContacts",
          reason: "unavailable",
          cause: new Set([2]),
        });

        const members = yield* storage.listMembers(listId, 25, undefined);

        expect(members.items.map((contact) => contact.id)).not.toContain(original);

        yield* storage.deleteList(listId);
        yield* storage.deleteContact(original);
      }),
    ));
});
