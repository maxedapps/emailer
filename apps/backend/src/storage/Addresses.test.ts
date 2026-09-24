import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { DateTime, Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";

import { addressReads, addressWrites, suppressionWrites, unsubscribeWrites } from "./Addresses.ts";
import { tableLogicalId } from "./Items.ts";
import {
  conditionFailed,
  createdAt,
  failureOf,
  scriptedTable,
  serverError,
  primitivesFor,
} from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { AddressSuppression, AddressUnsubscribe } from "./Addresses.ts";

const operationsFor = (table: Table) => {
  const primitives = primitivesFor(table);

  return {
    ...suppressionWrites(primitives),
    ...unsubscribeWrites(primitives),
    ...addressReads(primitives),
    ...addressWrites(primitives),
  } as const;
};

const suppression: AddressSuppression = {
  email: "User@Example.com",
  reason: "bounce",
  messageId: "0100019",
  feedbackId: "0100019a-6c6f-4a39-8f12-0b2f9c3d4e5f",
  bounceSubType: "General",
  suppressedAt: createdAt,
};

const unsubscribe: AddressUnsubscribe = {
  email: "User@Example.com",
  unsubscribedAt: createdAt,
};

const email = "user@example.com";

const now = Date.parse("2026-09-15T00:00:00.000Z");

const day = 86_400_000;

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const occurrence = (millis: number, id: string) => `${iso(millis)}#${id}`;

const itemOf = (write: ReturnType<typeof scriptedTable>): dynamodb.AttributeMap =>
  write.putItemRequests[0]?.Item ?? {};

const suppressionItem = Effect.gen(function* () {
  const written = scriptedTable({});

  yield* operationsFor(written).suppressAddress(suppression);

  return itemOf(written);
});

const unsubscribeItem = Effect.gen(function* () {
  const written = scriptedTable({});

  yield* operationsFor(written).unsubscribeAddress(unsubscribe);

  return itemOf(written);
});

const transientItem = (occurrences: ReadonlyArray<string>): dynamodb.AttributeMap => ({
  pk: { S: `SUPPRESSION#${email}` },
  sk: { S: "TRANSIENT" },
  v: { N: "1" },
  occurrences: { SS: [...occurrences] },
});

const batchReply = (items: ReadonlyArray<dynamodb.AttributeMap>) =>
  Effect.succeed({ Responses: { EmailerData: [...items] } });

describe("suppressAddress", () => {
  it.effect("keys the record on the fully lowercased address, local part included", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      yield* operationsFor(table).suppressAddress(suppression);

      const item = table.putItemRequests[0]?.Item ?? {};

      expect(item["pk"]).toStrictEqual({ S: "SUPPRESSION#user@example.com" });
      expect(item["sk"]).toStrictEqual({ S: "SUPPRESSION" });
      expect(item["email"]).toStrictEqual({ S: "user@example.com" });
      expect(table.putItemRequests[0]?.ConditionExpression).toBe("attribute_not_exists(pk)");
    }),
  );

  it.effect("omits a diagnostic attribute the event did not carry", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      yield* operationsFor(table).suppressAddress(suppression);

      const item = table.putItemRequests[0]?.Item ?? {};

      expect(item["bounceSubType"]).toStrictEqual({ S: "General" });
      expect(item).not.toHaveProperty("complaintFeedbackType");
      expect(item).not.toHaveProperty("complaintSubType");
    }),
  );

  it.effect("treats a repeated suppression as a no-op rather than a failure", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ putItem: [conditionFailed] });

      const attempt = yield* Effect.result(operationsFor(table).suppressAddress(suppression));

      expect(Result.isSuccess(attempt)).toBe(true);
    }),
  );

  it.effect("still reports a provider that is unavailable", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ putItem: [Effect.fail(serverError)] });

      const attempt = yield* Effect.result(operationsFor(table).suppressAddress(suppression));

      expect(failureOf(attempt).reason).toBe("unavailable");
      expect(failureOf(attempt).operationId).toBe("suppressAddress");
    }),
  );
});

describe("unsubscribeAddress", () => {
  it.effect("keys the record on the fully lowercased address and names no contact", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      yield* operationsFor(table).unsubscribeAddress(unsubscribe);

      const item = table.putItemRequests[0]?.Item ?? {};

      expect(item["pk"]).toStrictEqual({ S: "UNSUBSCRIBE#user@example.com" });
      expect(item["sk"]).toStrictEqual({ S: "UNSUBSCRIBE" });
      expect(item["email"]).toStrictEqual({ S: "user@example.com" });
      expect(item["contactId"]).toBeUndefined();
      expect(item["unsubscribedAt"]).toStrictEqual({ S: createdAt });
      expect(table.putItemRequests[0]?.ConditionExpression).toBe("attribute_not_exists(pk)");
    }),
  );

  it.effect("treats a repeated opt-out as a no-op that preserves the original timestamp", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ putItem: [conditionFailed] });

      const attempt = yield* Effect.result(
        operationsFor(table).unsubscribeAddress({
          ...unsubscribe,
          unsubscribedAt: "2026-09-12T11:00:00.000Z",
        }),
      );

      expect(Result.isSuccess(attempt)).toBe(true);
    }),
  );

  it.effect("still reports a provider that is unavailable", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ putItem: [Effect.fail(serverError)] });

      const attempt = yield* Effect.result(operationsFor(table).unsubscribeAddress(unsubscribe));

      expect(failureOf(attempt).reason).toBe("unavailable");
      expect(failureOf(attempt).operationId).toBe("unsubscribeAddress");
    }),
  );
});

describe("addressStatus", () => {
  it.effect("reads the three address rows in one consistent batch", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        batchGetItem: [batchReply([yield* suppressionItem])],
      });

      const status = yield* operationsFor(table).addressStatus(email);

      expect(table.batchGetItemRequests).toHaveLength(1);
      expect(table.batchGetItemRequests[0]?.RequestItems[tableLogicalId]?.ConsistentRead).toBe(
        true,
      );
      expect(table.batchGetItemRequests[0]?.RequestItems[tableLogicalId]?.Keys).toStrictEqual([
        { pk: { S: "UNSUBSCRIBE#user@example.com" }, sk: { S: "UNSUBSCRIBE" } },
        { pk: { S: "SUPPRESSION#user@example.com" }, sk: { S: "SUPPRESSION" } },
        { pk: { S: "SUPPRESSION#user@example.com" }, sk: { S: "TRANSIENT" } },
      ]);
      expect(status).toBe("suppressed");
    }),
  );

  it.effect("reads back an address unsubscribed under a different local-part case", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        batchGetItem: [batchReply([yield* unsubscribeItem])],
      });

      expect(yield* operationsFor(table).addressStatus(email)).toBe("unsubscribed");
    }),
  );

  it.effect("reports the human's decision ahead of the mail system's report", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        batchGetItem: [
          batchReply([
            yield* unsubscribeItem,
            yield* suppressionItem,
            transientItem([occurrence(now - day, "a")]),
          ]),
        ],
      });

      expect(yield* operationsFor(table).addressStatus(email)).toBe("unsubscribed");
    }),
  );

  it.effect("reports suppressed ahead of bouncing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      const table = scriptedTable({
        batchGetItem: [
          batchReply([
            yield* suppressionItem,
            transientItem([
              occurrence(now - day, "a"),
              occurrence(now - 2 * day, "b"),
              occurrence(now - 3 * day, "c"),
            ]),
          ]),
        ],
      });

      expect(yield* operationsFor(table).addressStatus(email)).toBe("suppressed");
    }),
  );

  it.effect("reports bouncing when exactly three occurrences fall inside thirty days", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      const table = scriptedTable({
        batchGetItem: [
          batchReply([
            transientItem([
              occurrence(now, "a"),
              occurrence(now - day, "b"),
              occurrence(now - 30 * day, "c"),
            ]),
          ]),
        ],
      });

      expect(yield* operationsFor(table).addressStatus(email)).toBe("bouncing");
    }),
  );

  it.effect(
    "reports mailable when two occurrences are inside the window and one is just outside",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);

        const table = scriptedTable({
          batchGetItem: [
            batchReply([
              transientItem([
                occurrence(now - day, "a"),
                occurrence(now - 2 * day, "b"),
                occurrence(now - 30 * day - 1, "c"),
              ]),
            ]),
          ],
        });

        expect(yield* operationsFor(table).addressStatus(email)).toBe("mailable");
      }),
  );

  it.effect("reports an address neither record mentions as mailable", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      expect(yield* operationsFor(table).addressStatus("sam@example.com")).toBe("mailable");
    }),
  );

  it.effect("never reports a mailable address when the batch failed", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ batchGetItem: [Effect.fail(serverError)] });

      const attempt = yield* Effect.result(operationsFor(table).addressStatus("sam@example.com"));

      expect(failureOf(attempt).reason).toBe("unavailable");
      expect(failureOf(attempt).operationId).toBe("addressStatus");
    }),
  );
});

describe("addressRecord", () => {
  it.effect("decodes the three rows and the derived status", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      const occurrences = [
        occurrence(now - day, "a"),
        occurrence(now - 2 * day, "b"),
        occurrence(now - 3 * day, "c"),
      ];

      const table = scriptedTable({
        batchGetItem: [
          batchReply([yield* unsubscribeItem, yield* suppressionItem, transientItem(occurrences)]),
        ],
      });

      expect(yield* operationsFor(table).addressRecord("User@Example.com")).toStrictEqual({
        email: "User@Example.com",
        status: "unsubscribed",
        unsubscribedAt: createdAt,
        suppression: {
          reason: "bounce",
          suppressedAt: createdAt,
          bounceSubType: "General",
        },
        transientBounces: occurrences,
        accountSuppression: null,
      });
    }),
  );

  it.effect("omits local rows that were never written", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      expect(yield* operationsFor(table).addressRecord(email)).toStrictEqual({
        email,
        status: "mailable",
        transientBounces: [],
        accountSuppression: null,
      });
    }),
  );
});

describe("unsuppress", () => {
  it.effect("deletes the suppression and transient rows and leaves the opt-out", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      yield* operationsFor(table).unsuppress(email);

      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        {
          Delete: {
            Table: tableLogicalId,
            Key: { pk: { S: "SUPPRESSION#user@example.com" }, sk: { S: "SUPPRESSION" } },
          },
        },
        {
          Delete: {
            Table: tableLogicalId,
            Key: { pk: { S: "SUPPRESSION#user@example.com" }, sk: { S: "TRANSIENT" } },
          },
        },
      ]);
    }),
  );
});
