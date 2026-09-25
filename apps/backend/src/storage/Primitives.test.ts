import * as Errors from "@emailer/api/Errors";
import { Data, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";

import * as dynamodb from "@distilled.cloud/aws/dynamodb";

import { str, tableLogicalId } from "./Items.ts";
import { allPrimitives, UnexpectedCondition } from "./Primitives.ts";
import { cancelled, defectOf, scriptedTable, tokensFor, serverError } from "./Testing.ts";

import type { StoredItem } from "./Primitives.ts";
import type { ScriptedReplies } from "./Testing.ts";

/**
 * Backoff between attempts is real time in production and would be real waiting here. A test that
 * retries forks the operation and advances the test clock past every delay, so the retries are
 * exercised without the suite sleeping.
 */
const pastEveryDelay = "30 seconds";

/** A plausible physical table name: what AWS keys batch responses by, and the binding never maps back. */
const physicalName = "emailer-test-EmailerData-9f3c";

const contactId = "0195f0a0-1111-4222-8333-44444444c001";

const otherContactId = "0195f0a0-1111-4222-8333-44444444c002";

const contactKey = (id: string) => ({ pk: str(`CONTACT#${id}`), sk: str("META") });

const itemFor = (id: string) => ({ ...contactKey(id), id: str(id) });

const withTable = (replies: ScriptedReplies) => {
  const table = scriptedTable(replies);

  return {
    table,
    primitives: allPrimitives(table.operations, tokensFor(table.transactionRequests)),
  };
};

describe("readItems", () => {
  it.effect(
    "reads responses keyed by the physical table name while requesting by the logical id",
    () =>
      Effect.gen(function* () {
        const { table, primitives } = withTable({
          batchGetItem: [Effect.succeed({ Responses: { [physicalName]: [itemFor(contactId)] } })],
        });

        const items = yield* primitives.readItems("listContacts", [contactKey(contactId)]);

        expect(items).toStrictEqual([itemFor(contactId)]);
        expect(Object.keys(table.batchGetItemRequests[0]?.RequestItems ?? {})).toStrictEqual([
          tableLogicalId,
        ]);
      }),
  );

  it.effect("carries the consistent read inside the per-table block, not at the top level", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({});

      yield* primitives.readItems("listContacts", [contactKey(contactId)]);

      const request = table.batchGetItemRequests[0];

      expect(request?.RequestItems[tableLogicalId]?.ConsistentRead).toBe(true);
      expect(request).not.toHaveProperty("ConsistentRead");
    }),
  );

  it.live(
    "re-keys unprocessed keys to the logical id rather than replaying the physical name",
    () =>
      Effect.gen(function* () {
        const pending = { Keys: [contactKey(otherContactId)], ConsistentRead: true };

        const { table, primitives } = withTable({
          batchGetItem: [
            Effect.succeed({
              Responses: { [physicalName]: [itemFor(contactId)] },
              UnprocessedKeys: { [physicalName]: pending },
            }),
            Effect.succeed({ Responses: { [physicalName]: [itemFor(otherContactId)] } }),
          ],
        });

        const items = yield* primitives.readItems("listContacts", [
          contactKey(contactId),
          contactKey(otherContactId),
        ]);

        expect(items).toStrictEqual([itemFor(contactId), itemFor(otherContactId)]);
        expect(table.batchGetItemRequests[1]?.RequestItems).toStrictEqual({
          [tableLogicalId]: pending,
        });
      }),
  );

  // AWS leaves keys unprocessed when it is shedding load, and it can do so on the retry of a
  // retry. Returning what arrived would answer a partial hydration as a complete one, which is a
  // listing silently dropping members.
  it.effect("keeps retrying the pending keys and returns every item once they all arrive", () =>
    Effect.gen(function* () {
      const pendingFor = (id: string) => ({ Keys: [contactKey(id)], ConsistentRead: true });

      const { table, primitives } = withTable({
        batchGetItem: [
          Effect.succeed({
            Responses: { [physicalName]: [itemFor(contactId)] },
            UnprocessedKeys: { [physicalName]: pendingFor(otherContactId) },
          }),
          Effect.succeed({ UnprocessedKeys: { [physicalName]: pendingFor(otherContactId) } }),
          Effect.succeed({ Responses: { [physicalName]: [itemFor(otherContactId)] } }),
        ],
      });

      const running = yield* Effect.forkChild(
        primitives.readItems("listContacts", [contactKey(contactId), contactKey(otherContactId)]),
      );

      yield* TestClock.adjust(pastEveryDelay);

      const items = yield* Fiber.join(running);

      expect(items).toStrictEqual([itemFor(contactId), itemFor(otherContactId)]);
      expect(table.batchGetItemRequests).toHaveLength(3);

      // Only the keys still outstanding are re-requested; the item already read is not re-read.
      for (const request of table.batchGetItemRequests.slice(1)) {
        expect(request.RequestItems[tableLogicalId]?.Keys).toStrictEqual([
          contactKey(otherContactId),
        ]);
      }
    }),
  );

  it.effect("fails rather than reporting a short read when the attempts run out", () =>
    Effect.gen(function* () {
      const pending = { Keys: [contactKey(otherContactId)], ConsistentRead: true };

      const partial = Effect.succeed({
        Responses: { [physicalName]: [itemFor(contactId)] },
        UnprocessedKeys: { [physicalName]: pending },
      });

      const { table, primitives } = withTable({
        batchGetItem: [partial, partial, partial, partial, partial],
      });

      const running = yield* Effect.forkChild(
        primitives.readItems("listContacts", [contactKey(contactId), contactKey(otherContactId)]),
      );

      yield* TestClock.adjust(pastEveryDelay);

      const failure = yield* Effect.flip(Fiber.join(running));

      expect(failure).toBeInstanceOf(Errors.StorageUnavailable);
      expect(failure).toMatchObject({ operation: "listContacts" });
      expect(table.batchGetItemRequests).toHaveLength(4);
    }),
  );

  // One deadline for the whole operation, retries included: a caller's budget does not grow
  // because the store needed several rounds.
  it.effect("bounds the whole operation rather than each attempt", () =>
    Effect.gen(function* () {
      const pending = { Keys: [contactKey(otherContactId)], ConsistentRead: true };

      const slow = Effect.succeed({ UnprocessedKeys: { [physicalName]: pending } }).pipe(
        Effect.delay("2 seconds"),
      );

      const { table, primitives } = withTable({ batchGetItem: [slow, slow, slow, slow] });

      const running = yield* Effect.forkChild(
        primitives.readItems("listContacts", [contactKey(otherContactId)]),
      );

      yield* TestClock.adjust(pastEveryDelay);

      const failure = yield* Effect.flip(Fiber.join(running));

      expect(failure).toBeInstanceOf(Errors.StorageUnavailable);
      expect(table.batchGetItemRequests.length).toBeLessThan(4);
    }),
  );

  it.effect("sends no request at all for an empty key set, which the service would reject", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({});

      expect(yield* primitives.readItems("listContacts", [])).toStrictEqual([]);
      expect(table.batchGetItemRequests).toStrictEqual([]);
    }),
  );

  it.effect("drops a key the response omits instead of matching results by position", () =>
    Effect.gen(function* () {
      const { primitives } = withTable({
        batchGetItem: [
          Effect.succeed({ Responses: { [physicalName]: [itemFor(otherContactId)] } }),
        ],
      });

      const items = yield* primitives.readItems("listContacts", [
        contactKey(contactId),
        contactKey(otherContactId),
      ]);

      expect(items).toStrictEqual([itemFor(otherContactId)]);
    }),
  );
});

describe("runQuery", () => {
  const request = {
    KeyConditionExpression: "gsi1pk = :kind",
    ExpressionAttributeValues: { ":kind": str("contact") },
  };

  it.effect("reads the base table strongly consistently", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({});

      yield* primitives.runQuery("listMembers", "base-table", request);

      expect(table.queryRequests[0]?.ConsistentRead).toBe(true);
    }),
  );

  it.effect("never asks an index for a consistent read, which the service rejects at runtime", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({});

      yield* primitives.runQuery("listContacts", "index", request);

      expect(table.queryRequests[0]).not.toHaveProperty("ConsistentRead");
    }),
  );
});

describe("readEntityPage", () => {
  const kind = "contact";

  const keyOf = (id: string) => ({ pk: str(`CONTACT#${id}`), sk: str("META") });

  const indexEntry = (id: string, createdAt: string) => ({
    pk: str(`CONTACT#${id}`),
    sk: str("META"),
    gsi1pk: str(kind),
    gsi1sk: str(`${createdAt}#${id}`),
  });

  const createdAt = "2026-09-11T10:00:00.000Z";

  it.effect("queries the index for keys and hydrates them from the base table", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({
        query: [Effect.succeed({ Items: [indexEntry(contactId, createdAt)] })],
        batchGetItem: [Effect.succeed({ Responses: { [physicalName]: [itemFor(contactId)] } })],
      });

      const page = yield* primitives.readEntityPage("listContacts", kind, keyOf, 25, undefined);

      expect(table.queryRequests[0]?.IndexName).toBe("gsi1");
      expect(table.queryRequests[0]?.Limit).toBe(25);
      expect(table.batchGetItemRequests[0]?.RequestItems[tableLogicalId]?.Keys).toStrictEqual([
        keyOf(contactId),
      ]);
      expect(page.items).toStrictEqual([itemFor(contactId)]);
    }),
  );

  it.effect("derives the next cursor from the continuation key, never from the page's length", () =>
    Effect.gen(function* () {
      // DynamoDB can return an empty page that still has more to give.
      const { primitives } = withTable({
        query: [
          Effect.succeed({
            Items: [],
            LastEvaluatedKey: indexEntry(contactId, createdAt),
          }),
        ],
      });

      const page = yield* primitives.readEntityPage("listContacts", kind, keyOf, 25, undefined);

      expect(page.items).toStrictEqual([]);
      expect(page.nextCursor).toBe(`${createdAt}#${contactId}`);
    }),
  );

  it.effect("omits the next cursor on a full page that happens to be the last", () =>
    Effect.gen(function* () {
      const { primitives } = withTable({
        query: [Effect.succeed({ Items: [indexEntry(contactId, createdAt)] })],
        batchGetItem: [Effect.succeed({ Responses: { [physicalName]: [itemFor(contactId)] } })],
      });

      const page = yield* primitives.readEntityPage("listContacts", kind, keyOf, 1, undefined);

      // Absent rather than `undefined`, which the API would encode as `null`.
      expect(page).not.toHaveProperty("nextCursor");
    }),
  );

  it.effect("resumes from the index key and the table key the cursor names", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({});

      yield* primitives.readEntityPage(
        "listContacts",
        kind,
        keyOf,
        25,
        `${createdAt}#${contactId}`,
      );

      expect(table.queryRequests[0]?.ExclusiveStartKey).toStrictEqual({
        gsi1pk: str(kind),
        gsi1sk: str(`${createdAt}#${contactId}`),
        pk: str(`CONTACT#${contactId}`),
        sk: str("META"),
      });
    }),
  );

  it.effect(
    "drops an index entry the base table no longer holds, rather than failing the page",
    () =>
      Effect.gen(function* () {
        const { primitives } = withTable({
          query: [
            Effect.succeed({
              Items: [indexEntry(contactId, createdAt), indexEntry(otherContactId, createdAt)],
            }),
          ],
          batchGetItem: [Effect.succeed({ Responses: { [physicalName]: [itemFor(contactId)] } })],
        });

        const page = yield* primitives.readEntityPage("listContacts", kind, keyOf, 25, undefined);

        expect(page.items).toStrictEqual([itemFor(contactId)]);
      }),
  );

  it.effect("returns a page in index order when the batch answers reversed", () =>
    Effect.gen(function* () {
      const first = itemFor(contactId);
      const second = itemFor(otherContactId);

      const { primitives } = withTable({
        query: [
          Effect.succeed({
            Items: [indexEntry(contactId, createdAt), indexEntry(otherContactId, createdAt)],
          }),
        ],
        batchGetItem: [Effect.succeed({ Responses: { [physicalName]: [second, first] } })],
      });

      const page = yield* primitives.readEntityPage("listContacts", kind, keyOf, 25, undefined);

      expect(page.items).toStrictEqual([first, second]);
    }),
  );

  it.effect("never asks the index for a consistent read", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({});

      yield* primitives.readEntityPage("listContacts", kind, keyOf, 25, undefined);

      expect(table.queryRequests[0]).not.toHaveProperty("ConsistentRead");
    }),
  );
});

describe("updateIf", () => {
  const request = {
    Key: contactKey(contactId),
    UpdateExpression: "SET #state = :sending",
    ConditionExpression: "#state = :queued",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: {
      ":sending": str("sending"),
      ":queued": str("queued"),
    },
    ReturnValues: "ALL_NEW" as const,
  };

  class Refused extends Data.TaggedError("Refused")<{ readonly current: StoredItem }> {}

  const refused = (current: StoredItem) => new Refused({ current });

  it.effect("returns the new attributes when ReturnValues is ALL_NEW", () =>
    Effect.gen(function* () {
      const attributes = { ...contactKey(contactId), state: str("sending") };

      const { table, primitives } = withTable({
        updateItem: [Effect.succeed({ Attributes: attributes })],
      });

      expect(yield* primitives.updateIf("beginRun", request, refused)).toStrictEqual(attributes);
      expect(table.updateItemRequests[0]?.ReturnValues).toBe("ALL_NEW");
    }),
  );

  it.effect("fails a failed condition with the refusal, given the item it found", () =>
    Effect.gen(function* () {
      const found = { ...contactKey(contactId), state: str("paused") };

      const { primitives } = withTable({
        updateItem: [
          Effect.fail(
            new dynamodb.ConditionalCheckFailedException({ message: "refused", Item: found }),
          ),
        ],
      });

      expect(yield* Effect.flip(primitives.updateIf("beginRun", request, refused))).toStrictEqual(
        new Refused({ current: found }),
      );
    }),
  );

  it.effect("keeps a server error unavailable", () =>
    Effect.gen(function* () {
      const { primitives } = withTable({ updateItem: [Effect.fail(serverError)] });

      const failure = yield* Effect.flip(primitives.updateIf("beginRun", request, refused));

      expect(failure).toBeInstanceOf(Errors.StorageUnavailable);
      expect(failure).toMatchObject({ operation: "beginRun" });
    }),
  );

  it.effect("leaves a TransactionConflictException to the client's retry policy", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({
        updateItem: [
          Effect.fail(new dynamodb.TransactionConflictException({ message: "conflict" })),
        ],
      });

      const failure = yield* Effect.flip(primitives.updateIf("beginRun", request, refused));

      // The scripted table sits above the client, whose default policy retries this class;
      // the primitive itself sends once and reports what came back.
      expect(failure).toBeInstanceOf(Errors.StorageUnavailable);
      expect(table.updateItemRequests).toHaveLength(1);
    }),
  );
});

describe("transact", () => {
  class First extends Data.TaggedError("First")<{ readonly current: StoredItem }> {}

  class Second extends Data.TaggedError("Second") {}

  const put = {
    Put: {
      Table: tableLogicalId,
      Item: contactKey(contactId),
      ConditionExpression: "attribute_not_exists(pk)",
    },
  };

  const update = {
    Update: {
      Table: tableLogicalId,
      Key: contactKey(otherContactId),
      UpdateExpression: "ADD skipped :one",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":one": str("1") },
    },
  };

  const actions = [
    { ...put, refused: (current: StoredItem) => new First({ current }) },
    { ...update, refused: () => new Second() },
  ] as const;

  it.effect("sends one idempotency token per logical call, and no refusal", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({});

      yield* primitives.transact("claimRecipient", actions);
      yield* primitives.transact("claimRecipient", actions);

      expect(table.transactionRequests.map((sent) => sent.ClientRequestToken)).toStrictEqual([
        "token-1",
        "token-2",
      ]);
      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([put, update]);
    }),
  );

  it.effect("retries a conflict-only cancellation as a new call, with a new token", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({
        transactWriteItems: [cancelled("TransactionConflict", "None"), Effect.succeed({})],
      });

      const running = yield* Effect.forkChild(primitives.transact("claimRecipient", actions));

      yield* TestClock.adjust(pastEveryDelay);

      yield* Fiber.join(running);

      expect(table.transactionRequests.map((sent) => sent.ClientRequestToken)).toStrictEqual([
        "token-1",
        "token-2",
      ]);
    }),
  );

  it.effect("fails a condition-only cancellation with the refusal, without retrying it", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({
        transactWriteItems: [cancelled("None", "ConditionalCheckFailed")],
      });

      expect(yield* Effect.flip(primitives.transact("claimRecipient", actions))).toStrictEqual(
        new Second(),
      );
      expect(table.transactionRequests).toHaveLength(1);
    }),
  );

  it.effect("lets the first refused action in declaration order decide", () =>
    Effect.gen(function* () {
      const { primitives } = withTable({
        transactWriteItems: [cancelled("ConditionalCheckFailed", "ConditionalCheckFailed")],
      });

      expect(yield* Effect.flip(primitives.transact("claimRecipient", actions))).toStrictEqual(
        new First({ current: undefined }),
      );
    }),
  );

  it.effect("passes the item the failed condition returned to its refusal", () =>
    Effect.gen(function* () {
      const found = { ...contactKey(contactId), state: str("paused") };

      const { primitives } = withTable({
        transactWriteItems: [cancelled({ Code: "ConditionalCheckFailed", Item: found }, "None")],
      });

      expect(yield* Effect.flip(primitives.transact("claimRecipient", actions))).toStrictEqual(
        new First({ current: found }),
      );
    }),
  );

  it.effect("skips a failed action that declares no refusal for one that does", () =>
    Effect.gen(function* () {
      const { primitives } = withTable({
        transactWriteItems: [cancelled("ConditionalCheckFailed", "ConditionalCheckFailed")],
      });

      const failure = yield* Effect.flip(
        primitives.transact("claimRecipient", [put, { ...update, refused: () => new Second() }]),
      );

      expect(failure).toStrictEqual(new Second());
    }),
  );

  it.effect("dies when only an action without a refusal failed", () =>
    Effect.gen(function* () {
      const { primitives } = withTable({
        transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
      });

      expect(yield* defectOf(primitives.transact("createContact", [put, update]))).toStrictEqual(
        new UnexpectedCondition({ operation: "createContact" }),
      );
    }),
  );

  it.effect("does not retry a mix of ConditionalCheckFailed and TransactionConflict", () =>
    Effect.gen(function* () {
      const { table, primitives } = withTable({
        transactWriteItems: [cancelled("ConditionalCheckFailed", "TransactionConflict")],
      });

      const failure = yield* Effect.flip(primitives.transact("claimRecipient", actions));

      expect(failure).toBeInstanceOf(Errors.StorageUnavailable);
      expect(table.transactionRequests).toHaveLength(1);
    }),
  );

  it.effect("reports seven conflicts in a row as unavailable", () =>
    Effect.gen(function* () {
      const conflicts = Array.from({ length: 7 }, () => cancelled("TransactionConflict", "None"));

      const { table, primitives } = withTable({ transactWriteItems: conflicts });

      const running = yield* Effect.forkChild(primitives.transact("claimRecipient", actions));

      yield* TestClock.adjust(pastEveryDelay);

      const failure = yield* Effect.flip(Fiber.join(running));

      expect(failure).toBeInstanceOf(Errors.StorageUnavailable);
      expect(table.transactionRequests).toHaveLength(7);
    }),
  );
});
