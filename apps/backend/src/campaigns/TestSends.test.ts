import * as Schemas from "@emailer/api/Schemas";
import { ConfigProvider, Duration, Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { sendTest } from "./TestSends.ts";
import { unsubscribeLink } from "../consent/Unsubscribe.ts";
import { Mailer } from "../sending/Mailer.ts";
import { SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { unusedAudience } from "../storage/Testing.ts";

import type { SendPurpose } from "../sending/Mailer.ts";
import type { MessageContent } from "../sending/Message.ts";
import type { SendAllowance } from "../sending/SendGuard.ts";
import type { SubmissionOutcome } from "../storage/Campaigns.ts";
import type { AddressStatus } from "@emailer/api/Schemas";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

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

const written = (operation: string) =>
  Effect.die(new Error(`a test send must not reach CampaignStore.${operation}`));

interface Scenario {
  readonly allowance?: SendAllowance;
  readonly statuses?: ReadonlyArray<readonly [string, AddressStatus]>;
  readonly outcomes?: ReadonlyArray<SubmissionOutcome>;
  readonly members?: ReadonlyArray<Schemas.Contact>;
  readonly nextCursor?: string;
  readonly listMissing?: boolean;
}

interface Sent {
  readonly recipient: string;
  readonly content: MessageContent;
  readonly unsubscribeUrl: string;
  readonly purpose: SendPurpose;
}

const fixture = (scenario: Scenario = {}) => {
  const sent: Array<Sent> = [];
  const slots: Array<number> = [];
  const pageRequests: Array<number> = [];
  const outcomes = [...(scenario.outcomes ?? [])];
  const statuses = new Map(scenario.statuses ?? []);

  const layer = Layer.mergeAll(
    configuration,
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      listMembers: (_listId, limit) =>
        Effect.gen(function* () {
          pageRequests.push(limit);

          if (scenario.listMissing === true) {
            return yield* new Schemas.NotFound({ entity: "list" });
          }

          const items = [...(scenario.members ?? [])];

          return scenario.nextCursor === undefined
            ? { items }
            : { items, nextCursor: scenario.nextCursor };
        }),
      addressStatus: (email) => Effect.succeed(statuses.get(email) ?? ("mailable" as const)),
    }),
    Layer.succeed(CampaignStore)({
      getCampaign: (id) =>
        id === campaignId
          ? Effect.succeed(campaign)
          : Effect.fail(new Schemas.NotFound({ entity: "campaign" })),
      getCampaignBody: () => written("getCampaignBody"),
      createCampaign: () => written("createCampaign"),
      listCampaigns: () => written("listCampaigns"),
      getCampaignControl: () => written("getCampaignControl"),
      newRun: () => written("newRun"),
      cancelCampaign: () => written("cancelCampaign"),
      beginRun: () => written("beginRun"),
      claimRecipient: () => written("claimRecipient"),
      skipRecipient: () => written("skipRecipient"),
      settleRecipient: () => written("settleRecipient"),
      checkpoint: () => written("checkpoint"),
      completeRun: () => written("completeRun"),
      pauseRun: () => written("pauseRun"),
      updateDraft: () => written("updateDraft"),
      deleteDraft: () => written("deleteDraft"),
    }),
    Layer.succeed(Mailer)({
      send: (recipient, content, unsubscribeUrl, purpose) =>
        Effect.sync(() => {
          sent.push({ recipient, content, unsubscribeUrl, purpose });

          return (
            outcomes.shift() ?? {
              outcome: "accepted" as const,
              messageId: `message-${sent.length}`,
            }
          );
        }),
    }),
    Layer.succeed(SendGuard)({
      current: Effect.succeed(scenario.allowance ?? healthy),
      slot: (limit) =>
        Effect.sync(() => {
          slots.push(limit);

          return Duration.zero;
        }),
    }),
  );

  return { layer, sent, slots, pageRequests };
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
  it("sends a [Test] copy of the campaign to each address in order, untagged, one paced slot each", () =>
    Effect.runPromise(
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
          unsubscribeLink(recipient).pipe(Effect.provide(configuration)),
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
    ));

  it("skips addresses that are not mailable, without taking a slot", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({
          statuses: [
            ["gone@example.com", "unsubscribed"],
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
    ));

  it("reports a rejection and an uncertain submission per recipient and carries on", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({
          outcomes: [
            { outcome: "rejected", rejectionCode: "rate-limited" },
            { outcome: "uncertain" },
          ],
        });

        const attempt = yield* run(fix, {
          to: ["a@example.com", "b@example.com", "c@example.com"],
        });

        expect(Result.isSuccess(attempt) && attempt.success.recipients).toStrictEqual([
          { email: "a@example.com", outcome: "rejected", rejectionCode: "rate-limited" },
          { email: "b@example.com", outcome: "uncertain" },
          { email: "c@example.com", outcome: "accepted", messageId: "message-3" },
        ]);
        expect(fix.sent).toHaveLength(3);
      }),
    ));

  it("sends to every member of a list that fits, asking for one member past the limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ members: [member(1), member(2)] });

        const attempt = yield* run(fix, { listId });

        expect(fix.pageRequests).toStrictEqual([Schemas.maxTestRecipients + 1]);
        expect(Result.isSuccess(attempt) && attempt.success.recipients).toStrictEqual([
          { email: "member1@example.com", outcome: "accepted", messageId: "message-1" },
          { email: "member2@example.com", outcome: "accepted", messageId: "message-2" },
        ]);
      }),
    ));

  it("refuses a list with a second page, even when orphaned members thinned the first", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({
          members: Array.from({ length: 19 }, (_, n) => member(n)),
          nextCursor: member(21).id,
        });

        const attempt = yield* run(fix, { listId });

        expect(failureOf(attempt)).toStrictEqual(
          new Schemas.TestAudienceTooLarge({ limit: Schemas.maxTestRecipients }),
        );
        expect(fix.sent).toHaveLength(0);
      }),
    ));

  it("answers NotFound for a missing list and a missing campaign", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ listMissing: true });

        expect(failureOf(yield* run(fix, { listId }))).toStrictEqual(
          new Schemas.NotFound({ entity: "list" }),
        );

        const missing = yield* Effect.result(
          sendTest("0195f0a0-1111-4222-8333-4444444ca40a", { to: ["a@example.com"] }),
        ).pipe(Effect.provide(fix.layer));

        expect(failureOf(missing)).toStrictEqual(new Schemas.NotFound({ entity: "campaign" }));
        expect(fix.sent).toHaveLength(0);
      }),
    ));

  it.each([
    ["a reputation halt", "reputation"],
    ["a spent daily budget", "daily-quota"],
  ] as const)("refuses to send during %s", (_label, reason) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ allowance: { limit: 3, refusal: reason } });

        const attempt = yield* run(fix, { to: ["a@example.com"] });

        expect(failureOf(attempt)).toStrictEqual(new Schemas.SendingPaused({ reason }));
        expect(fix.sent).toHaveLength(0);
        expect(fix.slots).toHaveLength(0);
      }),
    ),
  );
});
