import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { makeEmailerClient } from "@emailer/api/Client";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Redacted } from "effect";
import { describe, expect } from "vitest";

import { newIdentifier, nowIso } from "../Identifiers.ts";
import { hashSecret, issueSecret } from "../Tokens.ts";

import {
  configuration,
  Deployment,
  liveStorage,
  simulator,
  uniqueAddress,
  type LiveTest,
} from "../../test/IntegrationSupport.ts";

const consent = { source: "Live suite", wording: "Send me the live suite's test mail." };

const sevenDays = 7 * 24 * 60 * 60_000;

export const subscriptionsSuite = (test: LiveTest) => {
  describe("sign-ups", () => {
    test(
      "signs up through a scoped key, confirms a link once, and keeps the key to its lists",
      Effect.gen(function* () {
        const settings = yield* configuration;
        const admin = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const storage = yield* liveStorage(settings.tableName);
        const runId = yield* newIdentifier;
        const list = yield* admin.lists.create({ payload: { name: `signup-${runId}` } });
        const other = yield* admin.lists.create({ payload: { name: `signup-other-${runId}` } });

        const created = yield* admin.keys.create({
          payload: {
            name: `live-${runId}`,
            lists: [list.id],
            confirmUrl: "https://www.example.com/newsletter/confirm",
          },
        });

        const site = yield* makeEmailerClient(settings.apiUrl, Redacted.make(created.key));

        // The one sign-up that mails, to the simulator.
        const address = simulator("success", runId);
        const signUp = { listId: list.id, email: address, consent, ip: "203.0.113.7" };

        expect(yield* site.subscriptions.subscribe({ payload: signUp })).toStrictEqual(
          Schemas.ConfirmationSent.make({}),
        );

        const [pending] = (yield* storage.addressRecord(address)).pending;

        expect(pending?.listId).toBe(list.id);
        // The TTL is whole seconds, so it can fall up to a second short of seven days.
        expect(
          Date.parse(pending?.expiresAt ?? "") - Date.parse(pending?.requestedAt ?? ""),
        ).toBeGreaterThan(sevenDays - 1000);

        expect(
          yield* Effect.flip(site.subscriptions.subscribe({ payload: signUp })),
        ).toBeInstanceOf(Errors.ConfirmationRecentlySent);

        // The real link exists only in the mail, so a pending sign-up with a known secret is planted
        // for an address that left the list, and confirmed through the API.
        const probe = yield* uniqueAddress;
        const secret = yield* issueSecret;

        yield* storage.optOut({ email: probe, listId: list.id });

        yield* storage.requestSubscription({
          email: probe,
          listId: list.id,
          source: consent.source,
          wording: consent.wording,
          ip: "203.0.113.7",
          requestedAt: yield* nowIso,
          secretHash: yield* hashSecret(secret),
        });

        const confirmation = {
          token: `${probe}.${list.id}.${Redacted.value(secret)}`,
          ip: "203.0.113.8",
        };

        expect(yield* site.subscriptions.confirm({ payload: confirmation })).toStrictEqual(
          Schemas.Subscribed.make({ listId: list.id }),
        );

        const confirmed = yield* storage.addressRecord(probe);
        const contact = yield* admin.contacts.getByEmail({ query: { email: probe } });

        const members = yield* admin.lists.listMembers({
          params: { listId: list.id },
          query: {},
        });

        expect(members.items.map((member) => member.id)).toStrictEqual([contact.id]);
        expect(confirmed.optOuts).toStrictEqual([]);
        expect(confirmed.pending).toStrictEqual([]);
        expect(confirmed.consents).toMatchObject([
          { listId: list.id, ...consent, ip: "203.0.113.7", confirmIp: "203.0.113.8" },
        ]);
        expect(yield* storage.addressStatus(probe, list.id)).toBe("mailable");

        expect(
          yield* Effect.flip(site.subscriptions.confirm({ payload: confirmation })),
        ).toStrictEqual(new Errors.ConfirmationNotFound());

        expect(
          yield* Effect.flip(
            site.subscriptions.subscribe({ payload: { ...signUp, listId: other.id } }),
          ),
        ).toStrictEqual(new Errors.Forbidden());

        expect(yield* Effect.flip(site.lists.list({ query: {} }))).toStrictEqual(
          new Errors.Unauthorized(),
        );

        yield* admin.keys.revoke({ params: { id: created.id } });

        expect(yield* Effect.flip(site.subscriptions.subscribe({ payload: signUp }))).toStrictEqual(
          new Errors.Unauthorized(),
        );
      }),
    );

    test(
      "expires pending sign-ups through the table's TTL",
      Effect.gen(function* () {
        const { tableName } = yield* Deployment;
        const describeTimeToLive = yield* dynamodb.describeTimeToLive;

        const { TimeToLiveDescription } = yield* describeTimeToLive({ TableName: tableName });

        expect(TimeToLiveDescription?.AttributeName).toBe("ttl");
        expect(["ENABLING", "ENABLED"]).toContain(TimeToLiveDescription?.TimeToLiveStatus);
      }),
    );
  });
};
