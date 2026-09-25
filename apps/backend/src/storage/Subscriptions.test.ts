import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import { Effect } from "effect";

import { allPrimitives } from "./Primitives.ts";
import { SubscriptionState, subscriptionOperations } from "./Subscriptions.ts";
import { tableLogicalId } from "./Items.ts";
import { cancelled, contactId, listId, scriptedTable, tokensFor } from "./Testing.ts";

import type { SubscriptionConfirmation, SubscriptionRequest } from "./Subscriptions.ts";
import type { Table, TransactionReply } from "./Testing.ts";

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

/**
 * A table holding exactly `items`, answering each read by its key whatever the call order, and each
 * transaction as scripted.
 */
const holding = (
  items: ReadonlyArray<dynamodb.AttributeMap>,
  transactions: ReadonlyArray<TransactionReply> = [],
): Table => {
  const table = scriptedTable({ transactWriteItems: transactions });
  const byKey = new Map(items.map((item) => [`${item.pk?.S} ${item.sk?.S}`, item]));
  const held = (key: dynamodb.AttributeMap) => byKey.get(`${key["pk"]?.S} ${key["sk"]?.S}`);

  return {
    ...table,
    operations: {
      ...table.operations,
      getItem: (read) =>
        Effect.sync(() => {
          table.getItemRequests.push(read);

          const item = held(read.Key);

          return item === undefined ? {} : { Item: item };
        }),
      batchGetItem: (read) =>
        Effect.sync(() => {
          table.batchGetItemRequests.push(read);

          const keys = Object.values(read.RequestItems).flatMap((entry) => entry?.Keys ?? []);

          return {
            Responses: {
              [tableLogicalId]: keys.flatMap((key) => {
                const item = held(key);

                return item === undefined ? [] : [item];
              }),
            },
          };
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

const newContactId = "0195f0a0-1111-4222-8333-44444444c0de";

const otherListId = "0195f0a0-1111-4222-8333-44444444209e";

const confirmedAt = "2026-09-25T10:30:00.000Z";

const confirmation: SubscriptionConfirmation = {
  email,
  listId,
  secretHash,
  contactId: newContactId,
  confirmedAt,
  confirmIp: "203.0.113.8",
};

const list = {
  pk: { S: `LIST#${listId}` },
  sk: { S: "META" },
  v: { N: "1" },
  id: { S: listId },
  name: { S: "Monthly" },
  createdAt: { S: requestedAt },
};

const pendingDelete = {
  Delete: {
    Table: tableLogicalId,
    Key: { pk: { S: addressPk }, sk: { S: `PENDING#${listId}` } },
    ConditionExpression: "secretHash = :secretHash",
    ExpressionAttributeValues: { ":secretHash": { S: secretHash } },
  },
};

const consentPut = {
  Put: {
    Table: tableLogicalId,
    Item: {
      pk: { S: addressPk },
      sk: { S: `CONSENT#${listId}#${confirmedAt}` },
      v: { N: "1" },
      listId: { S: listId },
      source: { S: "Website footer" },
      wording: { S: "Send me the monthly newsletter." },
      ip: { S: "203.0.113.7" },
      requestedAt: { S: requestedAt },
      confirmedAt: { S: confirmedAt },
      confirmIp: { S: "203.0.113.8" },
    },
  },
};

const joins = (joinedId: string) =>
  [`LIST#${listId}|MEMBER#${joinedId}`, `CONTACT#${joinedId}|LISTOF#${listId}`].map((key) => {
    const [pk = "", sk = ""] = key.split("|");

    return {
      Update: {
        Table: tableLogicalId,
        Key: { pk: { S: pk }, sk: { S: sk } },
        UpdateExpression:
          "SET v = :v, listId = :listId, contactId = :contactId, addedAt = if_not_exists(addedAt, :addedAt)",
        ExpressionAttributeValues: {
          ":v": { N: "1" },
          ":listId": { S: listId },
          ":contactId": { S: joinedId },
          ":addedAt": { S: confirmedAt },
        },
      },
    };
  });

const confirming = (table: Table) => operationsFor(table).confirmSubscription(confirmation);

describe("confirmSubscription", () => {
  it.effect(
    "creates the contact, joins it, records the consent and consumes the link at once",
    () =>
      Effect.gen(function* () {
        const table = holding([pendingItem, list]);

        expect(yield* confirming(table)).toBe(listId);
        expect(table.transactionRequests.map((sent) => sent.TransactItems)).toStrictEqual([
          [
            pendingDelete,
            {
              Put: {
                Table: tableLogicalId,
                Item: {
                  pk: { S: `CONTACT#${newContactId}` },
                  sk: { S: "META" },
                  gsi1pk: { S: "contact" },
                  gsi1sk: { S: `${confirmedAt}#${newContactId}` },
                  v: { N: "1" },
                  id: { S: newContactId },
                  email: { S: email },
                  name: { S: "Sam" },
                  createdAt: { S: confirmedAt },
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                Table: tableLogicalId,
                Item: {
                  pk: { S: `EMAIL#${email}` },
                  sk: { S: "META" },
                  v: { N: "1" },
                  contactId: { S: newContactId },
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            ...joins(newContactId),
            consentPut,
          ],
        ]);
      }),
  );

  it.effect("joins the contact holding the address, and lifts only this list's opt-out", () =>
    Effect.gen(function* () {
      const table = holding([
        pendingItem,
        list,
        reservation,
        addressItem({ optOuts: { SS: [listId, otherListId] } }),
      ]);

      yield* confirming(table);

      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        pendingDelete,
        {
          ConditionCheck: {
            Table: tableLogicalId,
            Key: { pk: { S: `CONTACT#${contactId}` }, sk: { S: "META" } },
            ConditionExpression: "attribute_exists(pk)",
          },
        },
        {
          ConditionCheck: {
            Table: tableLogicalId,
            Key: { pk: { S: `EMAIL#${email}` }, sk: { S: "META" } },
            ConditionExpression: "contactId = :holder",
            ExpressionAttributeValues: { ":holder": { S: contactId } },
          },
        },
        ...joins(contactId),
        consentPut,
        {
          Update: {
            Table: tableLogicalId,
            Key: { pk: { S: addressPk }, sk: { S: "ADDRESS" } },
            UpdateExpression: "DELETE optOuts :list",
            ExpressionAttributeValues: { ":list": { SS: [listId] } },
          },
        },
      ]);
    }),
  );

  it.effect.each([
    ["a link never issued or already used", [list]],
    ["a link with another secret", [{ ...pendingItem, secretHash: { S: "0".repeat(64) } }, list]],
    // Expired at 10:30 exactly: TTL has not yet deleted it.
    ["an expired link", [{ ...pendingItem, ttl: { N: "1790332200" } }, list]],
  ] as const)("refuses %s as ConfirmationNotFound, writing nothing", ([_label, items]) =>
    Effect.gen(function* () {
      const table = holding(items);

      expect(yield* Effect.flip(confirming(table))).toStrictEqual(
        new Errors.ConfirmationNotFound(),
      );
      expect(table.transactionRequests).toHaveLength(0);
    }),
  );

  it.effect("answers ListNotFound for a list deleted since the sign-up", () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(confirming(holding([pendingItem])))).toStrictEqual(
        new Errors.ListNotFound(),
      );
    }),
  );

  it.effect("does not retry a link another request used first", () =>
    Effect.gen(function* () {
      const table = holding([pendingItem, list], [cancelled("ConditionalCheckFailed", "None")]);

      expect(yield* Effect.flip(confirming(table))).toStrictEqual(
        new Errors.ConfirmationNotFound(),
      );
      expect(table.transactionRequests).toHaveLength(1);
    }),
  );

  it.effect("retries a lost race for the address from fresh reads", () =>
    Effect.gen(function* () {
      const table = holding(
        [pendingItem, list],
        [cancelled("None", "None", "ConditionalCheckFailed"), Effect.succeed({})],
      );

      expect(yield* confirming(table)).toBe(listId);
      expect(table.transactionRequests).toHaveLength(2);
    }),
  );
});
