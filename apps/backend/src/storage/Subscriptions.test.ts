import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import { Effect } from "effect";

import { allPrimitives } from "./Primitives.ts";
import { SubscriptionState, subscriptionOperations } from "./Subscriptions.ts";
import { contactId, listId, scriptedTable, tokensFor } from "./Testing.ts";

import type { SubscriptionRequest } from "./Subscriptions.ts";
import type { Table } from "./Testing.ts";

const email = "sam@example.com";

const requestedAt = "2026-09-25T10:00:00.000Z";

const secretHash = "8ff2188e7463211f1a0af5b018552b52a593961c9d2787014067565a31862a83";

const request: SubscriptionRequest = {
  email,
  listId,
  name: "Sam",
  source: "Website footer",
  wording: "Send me the monthly newsletter.",
  ip: "203.0.113.7",
  requestedAt,
  secretHash,
};

const addressPk = `ADDRESS#${email}`;

/** The pending item as `request` leaves it, expiring seven days later. */
const pendingItem: dynamodb.AttributeMap = {
  pk: { S: addressPk },
  sk: { S: `PENDING#${listId}` },
  v: { N: "1" },
  email: { S: email },
  listId: { S: listId },
  name: { S: "Sam" },
  source: { S: "Website footer" },
  wording: { S: "Send me the monthly newsletter." },
  ip: { S: "203.0.113.7" },
  requestedAt: { S: requestedAt },
  secretHash: { S: secretHash },
  // 2026-10-02T10:00:00.000Z
  ttl: { N: "1790935200" },
};

const operationsFor = (table: Table) =>
  subscriptionOperations(allPrimitives(table.operations, tokensFor(table.transactionRequests)));

describe("requestSubscription", () => {
  it.effect(
    "puts the pending sign-up with a TTL seven days on, unless one is under an hour old",
    () =>
      Effect.gen(function* () {
        const table = scriptedTable({});

        yield* operationsFor(table).requestSubscription(request);

        expect(table.putItemRequests).toStrictEqual([
          {
            Item: pendingItem,
            ConditionExpression:
              "attribute_not_exists(pk) OR requestedAt < :hourAgo OR secretHash = :secretHash",
            ExpressionAttributeValues: {
              ":hourAgo": { S: "2026-09-25T09:00:00.000Z" },
              ":secretHash": { S: secretHash },
            },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        ]);
      }),
  );

  it.effect("refuses a sign-up within the hour, naming when the next mail may go", () =>
    Effect.gen(function* () {
      const earlier = { ...pendingItem, requestedAt: { S: "2026-09-25T09:40:00.000Z" } };

      const table = scriptedTable({
        putItem: [
          Effect.fail(
            new dynamodb.ConditionalCheckFailedException({ message: "refused", Item: earlier }),
          ),
        ],
      });

      expect(yield* Effect.flip(operationsFor(table).requestSubscription(request))).toStrictEqual(
        new Errors.ConfirmationRecentlySent({ retryAfter: "2026-09-25T10:40:00.000Z" }),
      );
    }),
  );
});

/** A table holding exactly `items`, answering each read by its key whatever the call order. */
const holding = (items: ReadonlyArray<dynamodb.AttributeMap>): Table => {
  const table = scriptedTable({});
  const byKey = new Map(items.map((item) => [`${item.pk?.S} ${item.sk?.S}`, item]));

  return {
    ...table,
    operations: {
      ...table.operations,
      getItem: (read) =>
        Effect.sync(() => {
          table.getItemRequests.push(read);

          const item = byKey.get(`${read.Key["pk"]?.S} ${read.Key["sk"]?.S}`);

          return item === undefined ? {} : { Item: item };
        }),
    },
  };
};

const addressItem = (facts: dynamodb.AttributeMap = {}) => ({
  pk: { S: addressPk },
  sk: { S: "ADDRESS" },
  v: { N: "1" },
  email: { S: email },
  ...facts,
});

const reservation = {
  pk: { S: `EMAIL#${email}` },
  sk: { S: "META" },
  v: { N: "1" },
  contactId: { S: contactId },
};

const membership = {
  pk: { S: `LIST#${listId}` },
  sk: { S: `MEMBER#${contactId}` },
  v: { N: "1" },
  listId: { S: listId },
  contactId: { S: contactId },
  addedAt: { S: requestedAt },
};

const suppression = {
  suppression: {
    M: { reason: { S: "bounce" }, suppressedAt: { S: requestedAt } },
  },
};

describe("subscriptionState", () => {
  it.effect.each([
    ["nothing recorded", [], SubscriptionState.NotSubscribed()],
    ["a contact who is not a member", [reservation], SubscriptionState.NotSubscribed()],
    ["a member", [reservation, membership], SubscriptionState.Subscribed()],
    [
      "a member who left the list",
      [addressItem({ optOuts: { SS: [listId] } }), reservation, membership],
      SubscriptionState.NotSubscribed(),
    ],
    [
      "a member who left another list",
      [addressItem({ optOuts: { SS: [contactId] } }), reservation, membership],
      SubscriptionState.Subscribed(),
    ],
    [
      "a suppressed member",
      [addressItem(suppression), reservation, membership],
      SubscriptionState.Undeliverable({ reason: "suppressed" }),
    ],
  ] as const)("answers %s", ([_label, items, expected]) =>
    Effect.gen(function* () {
      const table = holding(items);

      expect(yield* operationsFor(table).subscriptionState(listId, email)).toStrictEqual(expected);
      expect(table.getItemRequests.every((read) => read.ConsistentRead === true)).toBe(true);
    }),
  );
});
