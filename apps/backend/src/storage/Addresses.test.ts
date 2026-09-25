import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as Errors from "@emailer/api/Errors";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";

import { addressReads, addressWrites, suppressionWrites, unsubscribeWrites } from "./Addresses.ts";
import {
  conditionFailed,
  createdAt,
  listId,
  primitivesFor,
  scriptedTable,
  serverError,
} from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { AddressOptOut, AddressSuppression } from "./Addresses.ts";

const operationsFor = (table: Table) => {
  const primitives = primitivesFor(table);

  return {
    ...suppressionWrites(primitives),
    ...unsubscribeWrites(primitives),
    ...addressReads(primitives),
    ...addressWrites(primitives),
  } as const;
};

const email = "user@example.com";

const key = { pk: { S: `ADDRESS#${email}` }, sk: { S: "ADDRESS" } };

/** What every write sets when it may be the item's first. */
const stampValues = { ":v": { N: "1" }, ":email": { S: email } };

const suppression: AddressSuppression = {
  email: "User@Example.com",
  reason: "bounce",
  messageId: "0100019",
  feedbackId: "0100019a-6c6f-4a39-8f12-0b2f9c3d4e5f",
  bounceSubType: "General",
  suppressedAt: createdAt,
};

const optOut: AddressOptOut = { email: "User@Example.com", listId };

const otherListId = "0195f0a0-1111-4222-8333-44444444209e";

const now = Date.parse("2026-09-15T00:00:00.000Z");

const day = 86_400_000;

const bounce = (millis: number, id: string) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(millis))}#${id}`;

/** The address item with the facts a test gives it, as the writes above leave it. */
const stored = (facts: dynamodb.AttributeMap = {}): dynamodb.AttributeMap => ({
  ...key,
  v: { N: "1" },
  email: { S: email },
  ...facts,
});

const optedOut = { optOuts: { SS: [listId] } };

const suppressed = {
  suppression: {
    M: {
      reason: { S: "bounce" },
      messageId: { S: "0100019" },
      feedbackId: { S: "0100019a" },
      suppressedAt: { S: createdAt },
      bounceSubType: { S: "General" },
    },
  },
};

const bounces = (...occurrences: ReadonlyArray<string>) => ({
  transientBounces: { SS: [...occurrences] },
});

const holding = (item: dynamodb.AttributeMap) =>
  scriptedTable({ getItem: [Effect.succeed({ Item: item })] });

describe("suppressAddress", () => {
  it.effect(
    "records the first suppression on the mailbox's item, stamping version and mailbox",
    () =>
      Effect.gen(function* () {
        const table = scriptedTable({});

        yield* operationsFor(table).suppressAddress(suppression);

        expect(table.updateItemRequests).toStrictEqual([
          {
            Key: key,
            UpdateExpression:
              "SET v = if_not_exists(v, :v), email = if_not_exists(email, :email), suppression = if_not_exists(suppression, :s)",
            ExpressionAttributeValues: {
              ...stampValues,
              ":s": {
                M: {
                  reason: { S: "bounce" },
                  messageId: { S: "0100019" },
                  feedbackId: { S: "0100019a-6c6f-4a39-8f12-0b2f9c3d4e5f" },
                  suppressedAt: { S: createdAt },
                  bounceSubType: { S: "General" },
                },
              },
            },
          },
        ]);
      }),
  );
});

describe("optOut", () => {
  it.effect("adds the list to the mailbox's opt-outs in one update and names no contact", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      yield* operationsFor(table).optOut(optOut);

      expect(table.updateItemRequests).toStrictEqual([
        {
          Key: key,
          UpdateExpression:
            "SET v = if_not_exists(v, :v), email = if_not_exists(email, :email) ADD optOuts :list",
          ExpressionAttributeValues: { ...stampValues, ":list": { SS: [listId] } },
        },
      ]);
    }),
  );

  it.effect("still reports a provider that is unavailable", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ updateItem: [Effect.fail(serverError)] });

      const failure = yield* Effect.flip(operationsFor(table).optOut(optOut));

      expect(failure).toBeInstanceOf(Errors.StorageUnavailable);
      expect(failure).toMatchObject({ operation: "optOut" });
    }),
  );
});

describe("addressStatus", () => {
  it.effect("reads the mailbox's one item, strongly consistently", () =>
    Effect.gen(function* () {
      const table = holding(stored(optedOut));

      expect(yield* operationsFor(table).addressStatus("User@Example.com", listId)).toBe(
        "unsubscribed",
      );
      expect(table.getItemRequests).toStrictEqual([{ Key: key, ConsistentRead: true }]);
    }),
  );

  it.effect("reports an address that left another list as mailable on this one", () =>
    Effect.gen(function* () {
      const table = holding(stored(optedOut));

      expect(yield* operationsFor(table).addressStatus(email, otherListId)).toBe("mailable");
    }),
  );

  it.effect("reports a mailbox nothing was ever recorded for as mailable", () =>
    Effect.gen(function* () {
      expect(yield* operationsFor(scriptedTable({})).addressStatus(email, listId)).toBe("mailable");
    }),
  );

  it.effect("reports the human's decision ahead of the mail system's report", () =>
    Effect.gen(function* () {
      const table = holding(stored({ ...optedOut, ...suppressed, ...bounces(bounce(now, "a")) }));

      expect(yield* operationsFor(table).addressStatus(email, listId)).toBe("unsubscribed");
    }),
  );

  it.effect("reports suppressed ahead of bouncing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      const table = holding(
        stored({
          ...suppressed,
          ...bounces(
            bounce(now - day, "a"),
            bounce(now - 2 * day, "b"),
            bounce(now - 3 * day, "c"),
          ),
        }),
      );

      expect(yield* operationsFor(table).addressStatus(email, listId)).toBe("suppressed");
    }),
  );

  it.effect("reports bouncing when exactly three bounces fall inside thirty days", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      const table = holding(
        stored(bounces(bounce(now, "a"), bounce(now - day, "b"), bounce(now - 30 * day, "c"))),
      );

      expect(yield* operationsFor(table).addressStatus(email, listId)).toBe("bouncing");
    }),
  );

  it.effect("reports mailable when one of three bounces is just outside the window", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      const table = holding(
        stored(
          bounces(
            bounce(now - day, "a"),
            bounce(now - 2 * day, "b"),
            bounce(now - 30 * day - 1, "c"),
          ),
        ),
      );

      expect(yield* operationsFor(table).addressStatus(email, listId)).toBe("mailable");
    }),
  );

  it.effect("never reports a mailable address when the read failed", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ getItem: [Effect.fail(serverError)] });

      const failure = yield* Effect.flip(operationsFor(table).addressStatus(email, listId));

      expect(failure).toBeInstanceOf(Errors.StorageUnavailable);
      expect(failure).toMatchObject({ operation: "addressStatus" });
    }),
  );
});

describe("addressRecord", () => {
  it.effect("reads the address's partition and reports every fact the item holds", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);

      const occurrences = [bounce(now - day, "a"), bounce(now - 2 * day, "b")];

      const table = scriptedTable({
        query: [
          Effect.succeed({
            Items: [stored({ ...optedOut, ...suppressed, ...bounces(...occurrences) })],
          }),
        ],
      });

      expect(yield* operationsFor(table).addressRecord("User@Example.com")).toStrictEqual({
        email: "User@Example.com",
        status: "suppressed",
        optOuts: [listId],
        suppression: { reason: "bounce", suppressedAt: createdAt, bounceSubType: "General" },
        transientBounces: occurrences,
        accountSuppression: null,
      });
      expect(table.queryRequests).toStrictEqual([
        {
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": key.pk },
          ConsistentRead: true,
        },
      ]);
    }),
  );

  it.effect("reports a mailbox nothing was recorded for as mailable and empty", () =>
    Effect.gen(function* () {
      expect(yield* operationsFor(scriptedTable({})).addressRecord(email)).toStrictEqual({
        email,
        status: "mailable",
        optOuts: [],
        transientBounces: [],
        accountSuppression: null,
      });
    }),
  );
});

describe("unsuppress", () => {
  it.effect(
    "clears the suppression and the bounces of an existing item, and keeps the opt-out",
    () =>
      Effect.gen(function* () {
        const table = scriptedTable({});

        yield* operationsFor(table).unsuppress(email);

        expect(table.updateItemRequests).toStrictEqual([
          {
            Key: key,
            UpdateExpression: "REMOVE suppression, transientBounces",
            ConditionExpression: "attribute_exists(pk)",
          },
        ]);
      }),
  );

  it.effect("does nothing, successfully, for a mailbox with no item", () =>
    operationsFor(scriptedTable({ updateItem: [conditionFailed] })).unsuppress(email),
  );
});
