import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Clock, ConfigProvider, Duration, Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";

import { sendTest } from "./TestSends.ts";
import { unsubscribeLink } from "../consent/Unsubscribe.ts";
import {
  Mail,
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

import type { SendError } from "../sending/Mailer.ts";
import type { SendAllowance } from "../sending/SendGuard.ts";
import type { MailboxStatus } from "@emailer/api/Schemas";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const postalAddress = "Example Street 1, 12345 Example City";

const footer = "\n{{ unsubscribe_url }}\n{{ postal_address }}";

const html =
  '<p>Hi {{ contact.name | default: "there" }}</p><a href="{{ unsubscribe_url }}">Unsubscribe</a> {{ postal_address }}';

const campaign: Schemas.Campaign = {
  id: campaignId,
  listId,
  subject: "Release notes",
  text: `Hi{% if contact.name %} {{ contact.name }}{% endif %}${footer}`,
  html,
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

/** The contact a test renders as: the Berlin rule picks their copy. */
const ada: Schemas.Contact = {
  id: "0195f0a0-1111-4222-8333-44444444c001",
  email: "ada@example.com",
  name: "Ada",
  attributes: { city: "Berlin", since: "2024-03-15" },
  createdAt: "2026-09-11T09:00:00.000Z",
};

/** Lives in Berlin too, but their date cannot be read. */
const bob: Schemas.Contact = {
  id: "0195f0a0-1111-4222-8333-44444444c002",
  email: "bob@example.com",
  name: "Bob",
  attributes: { city: "Berlin", since: "some day" },
  createdAt: "2026-09-11T09:00:00.000Z",
};

const healthy: SendAllowance = { limit: 3 };

const configuration = Layer.succeed(ConfigProvider.ConfigProvider)(
  ConfigProvider.fromEnvRecord({
    EMAILER_UNSUBSCRIBE_URL: "https://unsubscribe.example.com/",
    EMAILER_UNSUBSCRIBE_SECRET: "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718293a4b5c6d7e8f90",
    EMAILER_POSTAL_ADDRESS: postalAddress,
  }),
);

const linkFor = (mailbox: string) =>
  unsubscribeLink({ mailbox, listId }).pipe(Effect.provide(configuration));

interface Scenario {
  readonly allowance?: SendAllowance;
  readonly statuses?: ReadonlyArray<readonly [string, MailboxStatus]>;
  readonly optOuts?: ReadonlyArray<readonly [email: string, listId: string]>;
  /** How SES answers each send in turn: an error, or acceptance once they run out. */
  readonly failures?: ReadonlyArray<SendError>;
  /** How long each pacing slot asks the sender to wait. */
  readonly slotDelay?: Duration.Duration;
}

interface Sent {
  readonly recipient: string;
  readonly mail: Mail;
}

const fixture = (scenario: Scenario = {}) => {
  const sent: Array<Sent> = [];
  const sentAt: Array<number> = [];
  const slots: Array<number> = [];
  const failures = [...(scenario.failures ?? [])];
  const statuses = new Map(scenario.statuses ?? []);
  const optOuts = new Set((scenario.optOuts ?? []).map(([email, list]) => `${email} ${list}`));
  const reads: Array<string> = [];

  const layer = Layer.mergeAll(
    configuration,
    NodeCrypto.layer,
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      getContactByEmail: (email) =>
        Effect.suspend(() => {
          const found = [ada, bob].find((contact) => contact.email === email);

          return found === undefined
            ? Effect.fail(new Errors.ContactNotFound())
            : Effect.succeed(found);
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
      getSummary: (id) =>
        Effect.suspend(() => {
          reads.push("summary");

          return id === campaignId
            ? Effect.succeed(campaign)
            : Effect.fail(new Errors.CampaignNotFound());
        }),
      getRoutes: () =>
        Effect.sync(() => {
          reads.push("routes");

          return { routes: campaign.variants ?? [], revision: 1 };
        }),
      getBody: () =>
        Effect.sync(() => {
          reads.push("body");

          return { text: campaign.text, html };
        }),
      getVariant: (_id, key) =>
        Effect.suspend(() => {
          reads.push(`variant ${key}`);

          return key === berlin.key
            ? Effect.succeed(berlin)
            : Effect.fail(new Errors.VariantNotFound({ variant: key }));
        }),
    }),
    Layer.succeed(Mailer)({
      send: (recipient, mail) =>
        Effect.gen(function* () {
          sent.push({ recipient, mail });
          sentAt.push(yield* Clock.currentTimeMillis);

          const failure = failures.shift();

          return failure === undefined ? `message-${sent.length}` : yield* failure;
        }),
    }),
    Layer.succeed(SendGuard)({
      current: Effect.succeed(scenario.allowance ?? healthy),
      recent: Effect.die(new Error("Only sign-ups read the recent allowance")),
      slot: (limit) =>
        Effect.sync(() => {
          slots.push(limit);

          return scenario.slotDelay ?? Duration.zero;
        }),
    }),
  );

  return { layer, sent, sentAt, slots, reads };
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
    "sends a [Test] of the campaign, rendered as no contact, to each address in order, untagged, one paced slot each",
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

        const links = yield* Effect.forEach(recipients, linkFor);

        expect(fix.sent).toStrictEqual(
          recipients.map((recipient, index) => {
            const link = links[index] ?? "";

            return {
              recipient,
              mail: Mail.Test({
                content: {
                  subject: "[Test] Release notes",
                  text: `Hi\n${link}\n${postalAddress}`,
                  html: `<p>Hi there</p><a href="${link.replaceAll("&", "&amp;")}">Unsubscribe</a> ${postalAddress}`,
                },
                unsubscribeUrl: link,
              }),
            };
          }),
        );
        expect(fix.slots).toStrictEqual([healthy.limit, healthy.limit]);
      }),
  );

  it.effect(
    "renders as the contact `as` names, with the copy their attributes choose, linked for the test address",
    () =>
      Effect.gen(function* () {
        const fix = fixture();

        yield* run(fix, { to: ["tester@example.com"], as: ada.email });

        const link = yield* linkFor("tester@example.com");

        expect(fix.sent).toStrictEqual([
          {
            recipient: "tester@example.com",
            mail: Mail.Test({
              content: {
                subject: "[Test] Berlin notes",
                text: `Hallo Ada, since März 2024\n${link}\n${postalAddress}`,
                html: undefined,
              },
              unsubscribeUrl: link,
            }),
          },
        ]);
        expect(fix.reads).toStrictEqual(["summary", "routes", "variant berlin"]);
      }),
  );

  it.effect("sends the copy the payload names, reading only it, and refuses an unknown key", () =>
    Effect.gen(function* () {
      const fix = fixture();

      yield* run(fix, { to: ["a@example.com"], as: ada.email, variant: "default" });

      const [sent] = fix.sent;

      expect(sent?.mail._tag === "Test" && sent.mail.content.subject).toBe("[Test] Release notes");
      expect(sent?.mail._tag === "Test" && sent.mail.content.html).toContain("<p>Hi Ada</p>");
      expect(fix.reads).toStrictEqual(["summary", "body"]);

      const missing = fixture();

      expect(
        failureOf(yield* run(missing, { to: ["a@example.com"], variant: "half" })),
      ).toStrictEqual(new Errors.VariantNotFound({ variant: "half" }));
      expect(missing.sent).toStrictEqual([]);
    }),
  );

  it.effect(
    "sends nothing when the copy cannot render for the contact, or the contact is unknown",
    () =>
      Effect.gen(function* () {
        const fix = fixture();

        expect(
          failureOf(yield* run(fix, { to: ["a@example.com", "b@example.com"], as: bob.email })),
        ).toStrictEqual(
          new Errors.RenderFailed({
            copy: "berlin",
            message: 'date: cannot read "some day" as a date',
          }),
        );
        expect(
          failureOf(yield* run(fix, { to: ["a@example.com"], as: "nobody@example.com" })),
        ).toStrictEqual(new Errors.ContactNotFound());
        expect(fix.sent).toStrictEqual([]);
        expect(fix.slots).toStrictEqual([]);
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

  // A test copy stands in for the campaign's mail, so the campaign's list decides.
  it.effect("skips addresses unsubscribed from the campaign's list, linking the rest to it", () =>
    Effect.gen(function* () {
      const fix = fixture({ optOuts: [["gone@example.com", listId]] });

      const attempt = yield* run(fix, { to: ["gone@example.com", "ok@example.com"] });

      expect(Result.isSuccess(attempt) && attempt.success.recipients).toStrictEqual([
        { email: "gone@example.com", outcome: "skipped", reason: "unsubscribed" },
        { email: "ok@example.com", outcome: "accepted", messageId: "message-1" },
      ]);
      expect(fix.sent[0]?.mail).toMatchObject({ unsubscribeUrl: yield* linkFor("ok@example.com") });
    }),
  );

  it.effect("answers CampaignNotFound for a missing campaign", () =>
    Effect.gen(function* () {
      const fix = fixture();

      const missing = yield* Effect.result(
        sendTest("0195f0a0-1111-4222-8333-4444444ca40a", { to: ["a@example.com"] }),
      ).pipe(Effect.provide(fix.layer));

      expect(failureOf(missing)).toStrictEqual(new Errors.CampaignNotFound());
      expect(fix.sent).toHaveLength(0);
    }),
  );

  it.effect.each([
    ["a reputation halt", "reputation"],
    ["a paused SES account", "sending-paused"],
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
