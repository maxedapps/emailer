import * as AWS from "alchemy/AWS";
import { Context, Effect, Layer } from "effect";

import { unsubscribeWrites } from "./Addresses.ts";
import { writePrimitives } from "./Primitives.ts";
import { dataTable } from "./Table.ts";

import type { TableOperations } from "./Items.ts";

/**
 * The public unsubscribe function's entire relationship with storage: one conditional write of one
 * address-keyed item. It constructs `PutItem` and nothing else, so the one surface that accepts
 * unauthenticated requests holds no permission to read, query, update or delete anything.
 */
const unsubscribeStoreOperations = (operations: Pick<TableOperations, "putItem">) =>
  unsubscribeWrites(writePrimitives(operations));

export type UnsubscribeOperations = ReturnType<typeof unsubscribeStoreOperations>;

export class UnsubscribeStore extends Context.Service<UnsubscribeStore, UnsubscribeOperations>()(
  "emailer/backend/UnsubscribeStore",
) {}

export const UnsubscribeStoreLive = Layer.effect(UnsubscribeStore)(
  Effect.gen(function* () {
    const table = yield* dataTable;

    return UnsubscribeStore.of(
      unsubscribeStoreOperations({ putItem: yield* AWS.DynamoDB.PutItem(table) }),
    );
  }),
).pipe(Layer.provide(AWS.DynamoDB.PutItemHttp));
