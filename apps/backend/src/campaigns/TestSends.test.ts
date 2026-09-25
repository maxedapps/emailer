import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Clock, ConfigProvider, Duration, Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";

import { sendTest } from "./TestSends.ts";
import { unsubscribeLink } from "../consent/Unsubscribe.ts";
import {
  Mailer,
  SendingSuspended,
  SendRejected,
  SendThrottled,
  SubmissionUncertain,
} from "../sending/Mailer.ts";
import { SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { unusedAudience, unusedCampaigns } from "../storage/Testing.ts";

import type { SendError, SendPurpose } from "../sending/Mailer.ts";
import type { MessageContent } from "../sending/Message.ts";
import type { SendAllowance } from "../sending/SendGuard.ts";
import type { MailboxStatus } from "@emailer/api/Schemas";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const otherListId = "0195f0a0-1111-4222-8333-44444444209e";

const campaign: Schemas.Campaign = {
  id: campaignId,
  listId,
  subject: "Release notes",
  text: "Hello there",
  html: "<p>Hello there</p>",
  createdAt: "2026-09-11T10:00:00.000Z",
  submission: { state: "draft" },
};

const healthy: SendAllowance = { limit: 3 };

const configuration = Layer.succeed(ConfigProvider.ConfigProvider)(
  ConfigProvider.fromEnvRecord({
    EMAILER_UNSUBSCRIBE_URL: "https://unsubscribe.example.com/",
    EMAILER_UNSUBSCRIBE_SECRET: "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718293a4b5c6d7e8f90",
  }),
);

const member = (n: number): Schemas.Contact => ({
  id: `0195f0a0-1111-4222-8333-4444444c${String(n).padStart(4, "0")}`,
  email: `member${n}@example.com`,
  createdAt: "2026-09-11T09:00:00.000Z",
});

interface Scenario {
  readonly allowance?: SendAllowance;
  readonly statuses?: ReadonlyArray<readonly [string, MailboxStatus]>;
  readonly optOuts?: ReadonlyArray<readonly [email: string, listId: string]>;
  /** How SES answers each send in turn: an error, or acceptance once they run out. */
  readonly failures?: ReadonlyArray<SendError>;
  readonly members?: ReadonlyArray<Schemas.Contact>;
  readonly nextCursor?: string;
  readonly listMissing?: boolean;
  /** How long each pacing slot asks the sender to wait. */
  readonly slotDelay?: Duration.Duration;
}

interface Sent {
  readonly recipient: string;
  readonly content: MessageContent;
  readonly unsubscribeUrl: string;
  readonly purpose: SendPurpose;
}

const fixture = (scenario: Scenario = {}) => {
  const sent: Array<Sent> = [];
  const sentAt: Array<number> = [];
  const slots: Array<number> = [];
  const pageRequests: Array<number> = [];
  const failures = [...(scenario.failures ?? [])];
  const statuses = new Map(scenario.statuses ?? []);
  const optOuts = new Set((scenario.optOuts ?? []).map(([email, list]) => `${email} ${list}`));

  const layer = Layer.mergeAll(
    configuration,
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      listMembers: (_listId, limit) =>
        Effect.gen(function* () {
          pageRequests.push(limit);

          if (scenario.listMissing === true) {
            return yield* new Errors.ListNotFound();
          }

          const items = [...(scenario.members ?? [])];

          return scenario.nextCursor === undefined
            ? { items }
            : { items, nextCursor: scenario.nextCursor };
        }),
      addressStatus: (email, list) =>
        Effect.succeed(
          optOuts.has(`${email} ${list}`)
            ? ("unsubscribed" as const)
            : (statuses.get(email) ?? ("mailable" as const)),
        ),
    }),
    Layer.succeed(CampaignStore)({
      ...unusedCampaigns,
      getCampaign: (id) =>
        id === campaignId ? Effect.succeed(campaign) : Effect.fail(new Errors.CampaignNotFound()),
    }),
    Layer.succeed(Mailer)({
      send: (recipient, content, unsubscribeUrl, purpose) =>
        Effect.gen(function* () {
          sent.push({ recipient, content, unsubscribeUrl, purpose });
          sentAt.push(yield* Clock.currentTimeMillis);

          const failure = failures.shift();

          return failure === undefined ? `message-${sent.length}` : yield* failure;
        }),
    }),
    Layer.succeed(SendGuard)({
      current: Effect.succeed(scenario.allowance ?? healthy),
      slot: (limit) =>
        Effect.sync(() => {
          slots.push(limit);

          return scenario.slotDelay ?? Duration.zero;
        }),
    }),
  );

  return { layer, sent, sentAt, slots, pageRequests };
};

const run = (fix: ReturnType<typeof fixture>, payload: Schemas.TestSendPayload) =>
  Effect.result(sendTest(campaignId, payload)).pipe(Effect.provide(fix.layer));

const failureOf = <A, E>(attempt: Result.Result<A, E>): E => {
  if (Result.isSuccess(attempt)) {
    throw new Error("Expected the test send to fail");
  }

  return attempt.failure;
};

describe("sendTest", () => {
  it.effect(
    "sends a [Test] copy of the campaign to each address in order, untagged, one paced slot each",
    () =>
      Effect.gen(function* () {
        const fix = fixture();

        const attempt = yield* run(fix, { to: ["b@example.com", "a@example.com"] });

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual({
          recipients: [
            { email: "b@example.com", outcome: "accepted", messageId: "message-1" },
            { email: "a@example.com", outcome: "accepted", messageId: "message-2" },
          ],
        });
        const recipients = ["b@example.com", "a@example.com"];

        const links = yield* Effect.forEach(recipients, (recipient) =>
          unsubscribeLink({ mailbox: recipient, listId }).pipe(Effect.provide(configuration)),
        );

        expect(fix.sent).toStrictEqual(
          recipients.map((recipient, index) => ({
            recipient,
            content: { subject: "[Test] Release notes", text: campaign.text, html: campaign.html },
            unsubscribeUrl: links[index],
            purpose: { kind: "test" },
          })),
        );
        expect(fix.slots).toStrictEqual([healthy.limit, healthy.limit]);
      }),
  );

  it.effect("sends each address only once its pacing slot's delay has passed", () =>
    Effect.gen(function* () {
      const fix = fixture({ slotDelay: Duration.millis(500) });
      const started = yield* Clock.currentTimeMillis;
      const sending = yield* Effect.forkChild(run(fix, { to: ["a@example.com", "b@example.com"] }));

      yield* TestClock.adjust("2 seconds");

      expect(Result.isSuccess(yield* Fiber.join(sending))).toBe(true);
      expect(fix.sentAt.map((at) => at - started)).toStrictEqual([500, 1000]);
    }),
  );

  it.effect("skips addresses that are not mailable, without taking a slot", () =>
    Effect.gen(function* () {
      const fix = fixture({
        optOuts: [["gone@example.com", listId]],
        statuses: [
          ["hard@example.com", "suppressed"],
          ["soft@example.com", "bouncing"],
        ],
      });

      const attempt = yield* run(fix, {
        to: ["gone@example.com", "hard@example.com", "soft@example.com", "ok@example.com"],
      });

      expect(Result.isSuccess(attempt) && attempt.success.recipients).toStrictEqual([
        { email: "gone@example.com", outcome: "skipped", reason: "unsubscribed" },
        { email: "hard@example.com", outcome: "skipped", reason: "suppressed" },
        { email: "soft@example.com", outcome: "skipped", reason: "bouncing" },
        { email: "ok@example.com", outcome: "accepted", messageId: "message-1" },
      ]);
      expect(fix.slots).toHaveLength(1);
    }),
  );

  it.effect("reports each send error as its outcome, per recipient, and carries on", () =>
    Effect.gen(function* () {
      const fix = fixture({
        failures: [
          new SendRejected({ code: "message-rejected" }),
          new SendThrottled(),
          new SendingSuspended(),
          new SubmissionUncertain({ reason: "transport" }),
        ],
      });

      const attempt = yield* run(fix, {
        to: ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"],
      });

      expect(Result.isSuccess(attempt) && attempt.success.recipients).toStrictEqual([
        { email: "a@example.com", outcome: "rejected", rejectionCode: "message-rejected" },
        { email: "b@example.com", outcome: "rejected", rejectionCode: "rate-limited" },
        { email: "c@example.com", outcome: "rejected", rejectionCode: "sending-paused" },
        { email: "d@example.com", outcome: "uncertain" },
        { email: "e@example.com", outcome: "accepted", messageId: "message-5" },
      ]);
      // One attempt each: a test is repeated by the operator, not retried by the API.
      expect(fix.sent).toHaveLength(5);
    }),
  );

  it.effect("sends to every member of a list that fits, asking for one member past the limit", () =>
    Effect.gen(function* () {
      const fix = fixture({ members: [member(1), member(2)] });

      const attempt = yield* run(fix, { listId });

      expect(fix.pageRequests).toStrictEqual([Schemas.maxTestRecipients + 1]);
      expect(Result.isSuccess(attempt) && attempt.success.recipients).toStrictEqual([
        { email: "member1@example.com", outcome: "accepted", messageId: "message-1" },
        { email: "member2@example.com", outcome: "accepted", messageId: "message-2" },
      ]);
    }),
  );

  // A test copy stands in for the campaign's mail, so the campaign's list decides, whichever list
  // the copy goes to.
  it.effect("skips members who left the campaign's list, not the list the test went to", () =>
    Effect.gen(function* () {
      const fix = fixture({
        members: [member(1), member(2)],
        optOuts: [
          ["member1@example.com", listId],
          ["member2@example.com", otherListId],
        ],
      });

      const attempt = yield* run(fix, { listId: otherListId });

      expect(Result.isSuccess(attempt) && attempt.success.recipients).toStrictEqual([
        { email: "member1@example.com", outcome: "skipped", reason: "unsubscribed" },
        { email: "member2@example.com", outcome: "accepted", messageId: "message-1" },
      ]);
      expect(fix.sent[0]?.unsubscribeUrl).toBe(
        yield* unsubscribeLink({ mailbox: "member2@example.com", listId }).pipe(
          Effect.provide(configuration),
        ),
      );
    }),
  );

  it.effect("refuses a list with a second page, even when orphaned members thinned the first", () =>
    Effect.gen(function* () {
      const fix = fixture({
        members: Array.from({ length: 19 }, (_, n) => member(n)),
        nextCursor: member(21).id,
      });

      const attempt = yield* run(fix, { listId });

      expect(failureOf(attempt)).toStrictEqual(
        new Errors.TestAudienceTooLarge({ limit: Schemas.maxTestRecipients }),
      );
      expect(fix.sent).toHaveLength(0);
    }),
  );

  it.effect("answers NotFound for a missing list and a missing campaign", () =>
    Effect.gen(function* () {
      const fix = fixture({ listMissing: true });

      expect(failureOf(yield* run(fix, { listId }))).toStrictEqual(new Errors.ListNotFound());

      const missing = yield* Effect.result(
        sendTest("0195f0a0-1111-4222-8333-4444444ca40a", { to: ["a@example.com"] }),
      ).pipe(Effect.provide(fix.layer));

      expect(failureOf(missing)).toStrictEqual(new Errors.CampaignNotFound());
      expect(fix.sent).toHaveLength(0);
    }),
  );

  it.effect.each([
    ["a reputation halt", "reputation"],
    ["a spent daily budget", "daily-quota"],
  ] as const)("refuses to send during %s", ([_label, reason]) =>
    Effect.gen(function* () {
      const fix = fixture({ allowance: { limit: 3, refusal: reason } });

      const attempt = yield* run(fix, { to: ["a@example.com"] });

      expect(failureOf(attempt)).toStrictEqual(new Errors.SendingPaused({ reason }));
      expect(fix.sent).toHaveLength(0);
      expect(fix.slots).toHaveLength(0);
    }),
  );
});
