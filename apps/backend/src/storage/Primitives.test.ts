import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import * as dynamodb from "@distilled.cloud/aws/dynamodb";

import { str, tableLogicalId } from "./Items.ts";
import { allPrimitives } from "./Primitives.ts";
import {
  cancelled,
  conditionFailed,
  failureOf,
  scriptedTable,
  tokensFor,
  serverError,
} from "./Testing.ts";

import type { ScriptedReplies } from "./Testing.ts";

/**
 * Backoff between batch attempts is real time in production and would be real waiting here. The
 * operation runs on a test clock instead, advanced past every delay but well inside the five-second
 * deadline, so the retries are exercised without the suite sleeping.
 */
const onTestClock = <A, E>(operation: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const running = yield* Effect.forkChild(operation);

    yield* TestClock.adjust("30 seconds");

    return yield* Fiber.join(running);
  }).pipe(Effect.provide(TestClock.layer()));

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
  it("reads responses keyed by the physical table name while requesting by the logical id", () =>
    Effect.runPromise(
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
    ));

  it("carries the consistent read inside the per-table block, not at the top level", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, primitives } = withTable({});

        yield* primitives.readItems("listContacts", [contactKey(contactId)]);

        const request = table.batchGetItemRequests[0];

        expect(request?.RequestItems[tableLogicalId]?.ConsistentRead).toBe(true);
        expect(request).not.toHaveProperty("ConsistentRead");
      }),
    ));

  it("re-keys unprocessed keys to the logical id rather than replaying the physical name", () =>
    Effect.runPromise(
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
    ));

  // AWS leaves keys unprocessed when it is shedding load, and it can do so on the retry of a
  // retry. Returning what arrived would answer a partial hydration as a complete one, which is a
  // listing silently dropping members.
  it("keeps retrying the pending keys and returns every item once they all arrive", () =>
    Effect.runPromise(
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

        const items = yield* onTestClock(
          primitives.readItems("listContacts", [contactKey(contactId), contactKey(otherContactId)]),
        );

        expect(items).toStrictEqual([itemFor(contactId), itemFor(otherContactId)]);
        expect(table.batchGetItemRequests).toHaveLength(3);

        // Only the keys still outstanding are re-requested; the item already read is not re-read.
        for (const request of table.batchGetItemRequests.slice(1)) {
          expect(request.RequestItems[tableLogicalId]?.Keys).toStrictEqual([
            contactKey(otherContactId),
          ]);
        }
      }),
    ));

  it("fails rather than reporting a short read when the attempts run out", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const pending = { Keys: [contactKey(otherContactId)], ConsistentRead: true };

        const partial = Effect.succeed({
          Responses: { [physicalName]: [itemFor(contactId)] },
          UnprocessedKeys: { [physicalName]: pending },
        });

        const { table, primitives } = withTable({
          batchGetItem: [partial, partial, partial, partial, partial],
        });

        const attempt = yield* Effect.result(
          onTestClock(
            primitives.readItems("listContacts", [
              contactKey(contactId),
              contactKey(otherContactId),
            ]),
          ),
        );

        expect(failureOf(attempt).operationId).toBe("listContacts");
        expect(failureOf(attempt).reason).toBe("unavailable");
        expect(table.batchGetItemRequests).toHaveLength(4);
      }),
    ));

  // One deadline for the whole operation, retries included: a caller's budget does not grow
  // because the store needed several rounds.
  it("bounds the whole operation rather than each attempt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const pending = { Keys: [contactKey(otherContactId)], ConsistentRead: true };

        const slow = Effect.succeed({ UnprocessedKeys: { [physicalName]: pending } }).pipe(
          Effect.delay("2 seconds"),
        );

        const { table, primitives } = withTable({ batchGetItem: [slow, slow, slow, slow] });

        const attempt = yield* Effect.result(
          onTestClock(primitives.readItems("listContacts", [contactKey(otherContactId)])),
        );

        expect(failureOf(attempt).reason).toBe("unavailable");
        expect(table.batchGetItemRequests.length).toBeLessThan(4);
      }),
    ));

  it("sends no request at all for an empty key set, which the service would reject", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, primitives } = withTable({});

        expect(yield* primitives.readItems("listContacts", [])).toStrictEqual([]);
        expect(table.batchGetItemRequests).toStrictEqual([]);
      }),
    ));

  it("drops a key the response omits instead of matching results by position", () =>
    Effect.runPromise(
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
    ));
});

describe("runQuery", () => {
  const request = {
    KeyConditionExpression: "gsi1pk = :kind",
    ExpressionAttributeValues: { ":kind": str("contact") },
  };

  it("reads the base table strongly consistently", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, primitives } = withTable({});

        yield* primitives.runQuery("listMembers", "base-table", request);

        expect(table.queryRequests[0]?.ConsistentRead).toBe(true);
      }),
    ));

  it("never asks an index for a consistent read, which the service rejects at runtime", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, primitives } = withTable({});

        yield* primitives.runQuery("listContacts", "index", request);

        expect(table.queryRequests[0]).not.toHaveProperty("ConsistentRead");
      }),
    ));
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

  it("queries the index for keys and hydrates them from the base table", () =>
    Effect.runPromise(
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
    ));

  it("derives the next cursor from the continuation key, never from the page's length", () =>
    Effect.runPromise(
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
    ));

  it("omits the next cursor on a full page that happens to be the last", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { primitives } = withTable({
          query: [Effect.succeed({ Items: [indexEntry(contactId, createdAt)] })],
          batchGetItem: [Effect.succeed({ Responses: { [physicalName]: [itemFor(contactId)] } })],
        });

        const page = yield* primitives.readEntityPage("listContacts", kind, keyOf, 1, undefined);

        // Absent rather than `undefined`, which the API would encode as `null`.
        expect(page).not.toHaveProperty("nextCursor");
      }),
    ));

  it("resumes from the index key and the table key the cursor names", () =>
    Effect.runPromise(
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
    ));

  it("drops an index entry the base table no longer holds, rather than failing the page", () =>
    Effect.runPromise(
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
    ));

  it("returns a page in index order when the batch answers reversed", () =>
    Effect.runPromise(
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
    ));

  it("never asks the index for a consistent read", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, primitives } = withTable({});

        yield* primitives.readEntityPage("listContacts", kind, keyOf, 25, undefined);

        expect(table.queryRequests[0]).not.toHaveProperty("ConsistentRead");
      }),
    ));
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

  it("returns the new attributes when ReturnValues is ALL_NEW", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attributes = { ...contactKey(contactId), state: str("sending") };

        const { table, primitives } = withTable({
          updateItem: [Effect.succeed({ Attributes: attributes })],
        });

        expect(yield* primitives.updateIf("beginRun", request)).toStrictEqual({
          applied: true,
          attributes,
        });
        expect(table.updateItemRequests[0]?.ReturnValues).toBe("ALL_NEW");
      }),
    ));

  it("reports a failed condition as not applied rather than unavailable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { primitives } = withTable({ updateItem: [conditionFailed] });

        expect(yield* primitives.updateIf("beginRun", request)).toStrictEqual({ applied: false });
      }),
    ));

  it("keeps a server error unavailable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { primitives } = withTable({ updateItem: [Effect.fail(serverError)] });

        const attempt = yield* Effect.result(primitives.updateIf("beginRun", request));

        expect(failureOf(attempt).reason).toBe("unavailable");
        expect(failureOf(attempt).operationId).toBe("beginRun");
      }),
    ));

  it("leaves a TransactionConflictException to the client's retry policy", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, primitives } = withTable({
          updateItem: [
            Effect.fail(new dynamodb.TransactionConflictException({ message: "conflict" })),
          ],
        });

        const attempt = yield* Effect.result(primitives.updateIf("beginRun", request));

        // The scripted table sits above the client, whose default policy retries this class;
        // the primitive itself sends once and reports what came back.
        expect(failureOf(attempt).reason).toBe("unavailable");
        expect(table.updateItemRequests).toHaveLength(1);
      }),
    ));
});

describe("runTransaction", () => {
  const request = {
    TransactItems: [
      {
        Put: {
          Table: tableLogicalId,
          Item: contactKey(contactId),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Update: {
          Table: tableLogicalId,
          Key: contactKey(otherContactId),
          UpdateExpression: "ADD skipped :one",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":one": str("1") },
        },
      },
    ],
  };

  it("sends one idempotency token per logical call, generated by the primitive", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, primitives } = withTable({});

        yield* primitives.runTransaction("claimRecipient", request);
        yield* primitives.runTransaction("claimRecipient", request);

        expect(table.transactionRequests.map((sent) => sent.ClientRequestToken)).toStrictEqual([
          "token-1",
          "token-2",
        ]);
        expect(table.transactionRequests[0]?.TransactItems).toStrictEqual(request.TransactItems);
      }),
    ));

  it("retries a conflict-only cancellation as a new call, with a new token", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const { table, primitives } = withTable({
            transactWriteItems: [cancelled("TransactionConflict", "None"), Effect.succeed({})],
          });

          expect(yield* primitives.runTransaction("claimRecipient", request)).toStrictEqual({
            committed: true,
          });
          expect(table.transactionRequests.map((sent) => sent.ClientRequestToken)).toStrictEqual([
            "token-1",
            "token-2",
          ]);
        }),
      ),
    ));

  it("does not retry a condition-only cancellation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, primitives } = withTable({
          transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
        });

        expect(yield* primitives.runTransaction("claimRecipient", request)).toStrictEqual({
          committed: false,
          conditionFailures: new Set([0]),
        });
        expect(table.transactionRequests).toHaveLength(1);
      }),
    ));

  it("does not retry a mix of ConditionalCheckFailed and TransactionConflict", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, primitives } = withTable({
          transactWriteItems: [cancelled("ConditionalCheckFailed", "TransactionConflict")],
        });

        const attempt = yield* Effect.result(primitives.runTransaction("claimRecipient", request));

        expect(failureOf(attempt).reason).toBe("unavailable");
        expect(table.transactionRequests).toHaveLength(1);
      }),
    ));

  it("reports seven conflicts in a row as unavailable", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const conflicts = Array.from({ length: 7 }, () =>
            cancelled("TransactionConflict", "None"),
          );

          const { table, primitives } = withTable({ transactWriteItems: conflicts });

          const attempt = yield* Effect.result(
            primitives.runTransaction("claimRecipient", request),
          );

          expect(failureOf(attempt).reason).toBe("unavailable");
          expect(table.transactionRequests).toHaveLength(7);
        }),
      ),
    ));
});
