import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import { Effect } from "effect";

import { apiKeyOperations } from "./ApiKeys.ts";
import { cancelled, createdAt, listId, primitivesFor, scriptedTable } from "./Testing.ts";

import type { StoredApiKey } from "./ApiKeys.ts";

const keyId = "0195f0a0-1111-4222-8333-44444444ce01";

const confirmUrl = "https://www.example.com/newsletter/confirm";

const secretHash = "8ff2188e7463211f1a0af5b018552b52a593961c9d2787014067565a31862a83";

const key: StoredApiKey = {
  id: keyId,
  name: "Website",
  lists: [listId],
  confirmUrl,
  createdAt,
  secretHash,
};

const itemKey = { pk: { S: "APIKEY" }, sk: { S: keyId } };

/** The key as the table holds it. */
const item = {
  ...itemKey,
  v: { N: "1" },
  id: { S: keyId },
  name: { S: "Website" },
  lists: { SS: [listId] },
  confirmUrl: { S: confirmUrl },
  createdAt: { S: createdAt },
  secretHash: { S: secretHash },
};

describe("apiKeyOperations", () => {
  it.effect("stores a key under the one keys partition, with its secret's hash only", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      yield* apiKeyOperations(primitivesFor(table)).createKey(key);

      expect(table.putItemRequests).toStrictEqual([
        { Item: item, ConditionExpression: "attribute_not_exists(pk)" },
      ]);
    }),
  );

  it.effect("reads a key strongly consistently, and answers ApiKeyNotFound for a missing one", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ getItem: [Effect.succeed({ Item: item })] });
      const operations = apiKeyOperations(primitivesFor(table));

      expect(yield* operations.getKey(keyId)).toStrictEqual(key);
      expect(yield* Effect.flip(operations.getKey(keyId))).toStrictEqual(
        new Errors.ApiKeyNotFound(),
      );
      expect(table.getItemRequests[0]).toStrictEqual({ Key: itemKey, ConsistentRead: true });
    }),
  );

  it.effect("lists the keys from their partition without their hashes", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ query: [Effect.succeed({ Items: [item] })] });

      const { secretHash: _secretHash, ...listed } = key;

      expect(yield* apiKeyOperations(primitivesFor(table)).listKeys()).toStrictEqual([listed]);
      expect(table.queryRequests).toStrictEqual([
        {
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": { S: "APIKEY" } },
          ConsistentRead: true,
        },
      ]);
    }),
  );

  it.effect("revokes a key by deleting it, and answers ApiKeyNotFound for a missing one", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        transactWriteItems: [Effect.succeed({}), cancelled("ConditionalCheckFailed")],
      });

      const operations = apiKeyOperations(primitivesFor(table));

      yield* operations.revokeKey(keyId);

      expect(yield* Effect.flip(operations.revokeKey(keyId))).toStrictEqual(
        new Errors.ApiKeyNotFound(),
      );
      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        {
          Delete: {
            Table: "EmailerData",
            Key: itemKey,
            ConditionExpression: "attribute_exists(pk)",
          },
        },
      ]);
    }),
  );
});
