import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Integration } from "@emailer/api/Api";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { DateTime, Duration, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createHash } from "node:crypto";

import { confirm, subscribe } from "./Subscriptions.ts";
import { Mail, Mailer, SendRejected, SubmissionUncertain } from "../sending/Mailer.ts";
import { recentAllowance, SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { SubscriptionState } from "../storage/Subscriptions.ts";
import { unusedAudience } from "../storage/Testing.ts";

import type { SendError } from "../sending/Mailer.ts";
import type { SubscriptionConfirmation, SubscriptionRequest } from "../storage/Subscriptions.ts";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const otherListId = "0195f0a0-1111-4222-8333-44444444209e";

const now = Date.parse("2026-09-25T10:00:00.000Z");

const confirmPage = "https://www.example.com/newsletter/confirm?lang=en";

const payload: Schemas.SubscribePayload = {
  listId,
  email: "Sam@example.com",
  name: "Sam",
  consent: { source: "Website footer", wording: "Send me the monthly newsletter." },
  ip: "203.0.113.7",
};

interface Scenario {
  readonly state?: SubscriptionState;
  readonly recent?: SendGuard["Service"]["recent"];
  readonly sendFailure?: SendError;
  readonly listMissing?: boolean;
}

interface Sent {
  readonly recipient: string;
  readonly mail: Mail;
}

/**
 * The sign-up's services. The store keeps the hour rule as storage does, by the `requestedAt` it is
 * given, so the clock the domain reads decides.
 */
const fixture = (scenario: Scenario = {}) => {
  const requests: Array<SubscriptionRequest> = [];
  const sent: Array<Sent> = [];

  const layer = Layer.mergeAll(
    Layer.succeed(Integration)({
      keyId: "key",
      lists: [listId, otherListId],
      confirmUrl: confirmPage,
    }),
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      getList: (id) =>
        scenario.listMissing === true
          ? Effect.fail(new Errors.ListNotFound())
          : Effect.succeed({ id, name: "Monthly <News>", createdAt: "2026-09-11T10:00:00.000Z" }),
      subscriptionState: () => Effect.succeed(scenario.state ?? SubscriptionState.NotSubscribed()),
      requestSubscription: (request) =>
        Effect.gen(function* () {
          const last = requests.at(-1);

          if (last !== undefined) {
            const retryAfter = DateTime.addDuration(
              DateTime.makeUnsafe(last.requestedAt),
              Duration.hours(1),
            );

            if (DateTime.isLessThan(DateTime.makeUnsafe(request.requestedAt), retryAfter)) {
              return yield* new Errors.ConfirmationRecentlySent({
                retryAfter: DateTime.formatIso(retryAfter),
              });
            }
          }

          requests.push(request);
        }),
    }),
    Layer.succeed(SendGuard)({
      current: Effect.die(new Error("A sign-up reads the recent allowance, not the current one")),
      recent: scenario.recent ?? Effect.succeed({ limit: 3 }),
      slot: () => Effect.succeed(Duration.zero),
    }),
    Layer.succeed(Mailer)({
      send: (recipient, mail) =>
        Effect.suspend(() => {
          sent.push({ recipient, mail });

          return scenario.sendFailure === undefined
            ? Effect.succeed("message-1")
            : Effect.fail(scenario.sendFailure);
        }),
    }),
    NodeCrypto.layer,
  );

  return { layer, requests, sent };
};

const signingUp = (fix: ReturnType<typeof fixture>, request = payload) =>
  subscribe(request).pipe(Effect.provide(fix.layer));

/** The token the confirmation link carries, split into what it names and its secret. */
const tokenOf = (mail: Mail | undefined) => {
  const link = new URL(Mail.$is("Confirmation")(mail) ? mail.confirmUrl : "https://missing");
  const token = link.searchParams.get("token") ?? "";

  return { link, token, secret: token.slice(token.lastIndexOf(".") + 1) };
};

describe("subscribe", () => {
  it.effect("stores the pending sign-up, then mails its link to the address, and answers 202", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      const fix = fixture();

      expect(yield* signingUp(fix)).toStrictEqual(Schemas.ConfirmationSent.make({}));

      const { link, token, secret } = tokenOf(fix.sent[0]?.mail);

      // Only the secret's hash is stored; the secret itself travels in the mail alone.
      expect(fix.requests).toStrictEqual([
        {
          email: "Sam@example.com",
          listId,
          name: "Sam",
          attributes: undefined,
          source: "Website footer",
          wording: "Send me the monthly newsletter.",
          ip: "203.0.113.7",
          requestedAt: "2026-09-25T10:00:00.000Z",
          secretHash: createHash("sha256").update(secret).digest("hex"),
        },
      ]);
      expect(fix.sent).toStrictEqual([
        {
          recipient: "Sam@example.com",
          mail: Mail.Confirmation({ listName: "Monthly <News>", confirmUrl: link.toString() }),
        },
      ]);
      // The key's page keeps its own query; the token names the mailbox and the list.
      expect(`${link.origin}${link.pathname}`).toBe("https://www.example.com/newsletter/confirm");
      expect(link.searchParams.get("lang")).toBe("en");
      expect(token).toBe(`sam@example.com.${listId}.${secret}`);
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }),
  );

  it.effect("answers 429 to a second sign-up within the hour, and mails again after it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      const fix = fixture();

      yield* signingUp(fix);

      expect(yield* Effect.flip(signingUp(fix))).toStrictEqual(
        new Errors.ConfirmationRecentlySent({ retryAfter: "2026-09-25T11:00:00.000Z" }),
      );
      expect(fix.sent).toHaveLength(1);

      yield* TestClock.adjust("1 hour");

      expect(yield* signingUp(fix)).toStrictEqual(Schemas.ConfirmationSent.make({}));
      expect(fix.sent).toHaveLength(2);
    }),
  );

  it.effect("reads the send guard once for sign-ups within 30 seconds, and again after", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      let reads = 0;

      // Built once, as the API instance builds it; each sign-up gets its own store for the hour rule.
      const recent = yield* recentAllowance(
        Effect.sync(() => {
          reads += 1;

          return { limit: 3 };
        }),
      );

      const signUp = () => signingUp(fixture({ recent }));

      yield* signUp();
      yield* TestClock.adjust("29 seconds");
      yield* signUp();

      expect(reads).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* signUp();

      expect(reads).toBe(2);
    }),
  );

  it.effect("answers an address already on the list with 200 and mails nothing", () =>
    Effect.gen(function* () {
      const fix = fixture({ state: SubscriptionState.Subscribed() });

      expect(yield* signingUp(fix)).toStrictEqual(Schemas.AlreadySubscribed.make({}));
      expect(fix.requests).toHaveLength(0);
      expect(fix.sent).toHaveLength(0);
    }),
  );

  it.effect.each([
    [
      "a list the key does not cover",
      {},
      { ...payload, listId: "0195f0a0-1111-4222-8333-44444444309e" },
      new Errors.Forbidden(),
    ],
    ["a list that is gone", { listMissing: true }, payload, new Errors.ListNotFound()],
    [
      "an undeliverable address",
      { state: SubscriptionState.Undeliverable({ reason: "bouncing" }) },
      payload,
      new Errors.AddressUndeliverable({ reason: "bouncing" }),
    ],
    [
      "a paused account",
      { recent: Effect.succeed({ limit: 3, refusal: "reputation" as const }) },
      payload,
      new Errors.SendingPaused({ reason: "reputation" }),
    ],
  ] as const)(
    "refuses %s, writing nothing and mailing nothing",
    ([_label, scenario, request, error]) =>
      Effect.gen(function* () {
        const fix = fixture(scenario);

        expect(yield* Effect.flip(signingUp(fix, request))).toStrictEqual(error);
        expect(fix.requests).toHaveLength(0);
        expect(fix.sent).toHaveLength(0);
      }),
  );

  it.effect("answers 503 when SES refuses the mail", () =>
    Effect.gen(function* () {
      const fix = fixture({ sendFailure: new SendRejected({ code: "message-rejected" }) });

      expect(yield* Effect.flip(signingUp(fix))).toStrictEqual(
        new Errors.EmailServiceUnavailable({
          operation: "sendConfirmation",
          failure: "SendRejected",
        }),
      );
    }),
  );

  it.effect("counts a submission whose outcome is unknown as sent", () =>
    Effect.gen(function* () {
      const fix = fixture({ sendFailure: new SubmissionUncertain({ reason: "timeout" }) });

      expect(yield* signingUp(fix)).toStrictEqual(Schemas.ConfirmationSent.make({}));
    }),
  );
});

describe("confirm", () => {
  const secret = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk-Ll_MmNnOoP";

  const confirmFixture = () => {
    const confirmations: Array<SubscriptionConfirmation> = [];

    const layer = Layer.mergeAll(
      Layer.succeed(Integration)({ keyId: "key", lists: [listId], confirmUrl: confirmPage }),
      Layer.succeed(AudienceStore)({
        ...unusedAudience,
        confirmSubscription: (confirmation) =>
          Effect.sync(() => {
            confirmations.push(confirmation);

            return confirmation.listId;
          }),
      }),
      NodeCrypto.layer,
    );

    return { layer, confirmations };
  };

  const confirming = (fix: ReturnType<typeof confirmFixture>, token: string) =>
    confirm({ token, ip: "203.0.113.8" }).pipe(Effect.provide(fix.layer));

  it.effect("confirms the mailbox and list the token names, with its secret's hash only", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      const fix = confirmFixture();

      expect(yield* confirming(fix, `first.last@example.com.${listId}.${secret}`)).toStrictEqual(
        Schemas.Subscribed.make({ listId }),
      );
      // A fresh identifier, which the contact takes only if no one holds the address yet.
      const contactId = fix.confirmations[0]?.contactId ?? "";

      expect(Schema.is(Schemas.EntityId)(contactId)).toBe(true);
      expect(fix.confirmations).toStrictEqual([
        {
          email: "first.last@example.com",
          listId,
          secretHash: createHash("sha256").update(secret).digest("hex"),
          contactId,
          confirmedAt: "2026-09-25T10:00:00.000Z",
          confirmIp: "203.0.113.8",
        },
      ]);
    }),
  );

  it.effect.each([
    ["no token at all", "not-a-token", new Errors.ConfirmationNotFound()],
    [
      "a short secret",
      `sam@example.com.${listId}.${secret.slice(1)}`,
      new Errors.ConfirmationNotFound(),
    ],
    ["a list outside the key", `sam@example.com.${otherListId}.${secret}`, new Errors.Forbidden()],
  ] as const)("refuses %s before any storage", ([_label, token, error]) =>
    Effect.gen(function* () {
      const fix = confirmFixture();

      expect(yield* Effect.flip(confirming(fix, token))).toStrictEqual(error);
      expect(fix.confirmations).toHaveLength(0);
    }),
  );
});
