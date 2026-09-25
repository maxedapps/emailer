import { ApiKeyNotFound } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Context, Crypto, Effect, Layer, Schema } from "effect";

import { itemReader, itemWriter, str, tableLogicalId } from "./Items.ts";
import { allPrimitives } from "./Primitives.ts";
import { AllTableOperationsHttp, allTableOperations } from "./Table.ts";

import type {
  QueryPrimitives,
  ReadPrimitives,
  TransactionPrimitives,
  WritePrimitives,
} from "./Primitives.ts";

const keysPartition = "APIKEY";

/**
 * Every scoped key sits in one partition, keyed by its identifier. Keys are few and read one at a
 * time, so they need neither the listing index nor a partition of their own.
 */
const apiKeyKey = (keyId: string) => ({ pk: str(keysPartition), sk: str(keyId) });

/** A key as stored: what it may do, and its secret's hash in place of the secret. */
const StoredApiKey = Schema.Struct({ ...Schemas.ApiKey.fields, secretHash: Schema.String });

export type StoredApiKey = typeof StoredApiKey.Type;

const writeKey = itemWriter(StoredApiKey);

const readKey = itemReader(StoredApiKey);

export const apiKeyOperations = (
  primitives: ReadPrimitives & WritePrimitives & QueryPrimitives & TransactionPrimitives,
) => {
  const { readItem, recordOnce, runQuery, transact } = primitives;

  /** The identifier is fresh, so an item already there is this same write landing twice. */
  const createKey = Effect.fn("Storage.createKey")(function* (key: StoredApiKey) {
    yield* recordOnce("createKey", { ...apiKeyKey(key.id), ...(yield* writeKey(key)) });
  });

  const getKey = Effect.fn("Storage.getKey")(function* (keyId: string) {
    const { Item } = yield* readItem("getKey", apiKeyKey(keyId));

    if (Item === undefined) {
      return yield* new ApiKeyNotFound();
    }

    return yield* readKey("getKey", Item);
  });

  const listKeys = Effect.fn("Storage.listKeys")(function* () {
    const page = yield* runQuery("listKeys", "base-table", {
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": str(keysPartition) },
    });

    return yield* Effect.forEach(page.Items ?? [], (item) =>
      Effect.map(
        readKey("listKeys", item),
        ({ secretHash: _secretHash, ...key }): Schemas.ApiKey => key,
      ),
    );
  });

  /**
   * `TableOperations` has no `DeleteItem`: every delete goes through a transaction, which is also
   * what gives a missing key its own answer.
   */
  const revokeKey = Effect.fn("Storage.revokeKey")(function* (keyId: string) {
    yield* transact("revokeKey", [
      {
        Delete: {
          Table: tableLogicalId,
          Key: apiKeyKey(keyId),
          ConditionExpression: "attribute_exists(pk)",
        },
        refused: () => new ApiKeyNotFound(),
      },
    ]);
  });

  return { createKey, getKey, listKeys, revokeKey } as const;
};

export type ApiKeyOperations = ReturnType<typeof apiKeyOperations>;

/**
 * The scoped keys, over the binding the API function already holds, so no new permission. The
 * function reads a key on every sign-up request and manages keys for the operator.
 */
export class ApiKeyStore extends Context.Service<ApiKeyStore, ApiKeyOperations>()(
  "emailer/backend/ApiKeyStore",
) {
  static readonly layer = Layer.effect(ApiKeyStore)(
    Effect.gen(function* () {
      const operations = yield* allTableOperations;
      const crypto = yield* Crypto.Crypto;

      return ApiKeyStore.of(
        apiKeyOperations(allPrimitives(operations, Effect.orDie(crypto.randomUUIDv4))),
      );
    }),
  ).pipe(Layer.provide(AllTableOperationsHttp));
}
