import * as Schemas from "@emailer/api/Schemas";
import { Effect, Option, Schema } from "effect";

import { corrupt } from "./Errors.ts";
import {
  attributeOf,
  listingAttributes,
  num,
  recordVersion,
  str,
  StoredVersionAttribute,
} from "./Items.ts";

import type {
  PagePrimitives,
  ReadPrimitives,
  StoredPage,
  UpdatePrimitives,
  WritePrimitives,
} from "./Primitives.ts";

const listKind = "list";

export const listKey = (listId: string) => ({ pk: str(`LIST#${listId}`), sk: str("META") });

const StoredList = Schema.Struct({
  v: StoredVersionAttribute,
  id: attributeOf(Schemas.EntityId),
  name: attributeOf(Schemas.EntityName),
  createdAt: attributeOf(Schemas.Timestamp),
});

const decodeStoredList = Schema.decodeUnknownEffect(StoredList);

export const listOperations = (
  primitives: ReadPrimitives & WritePrimitives & UpdatePrimitives & PagePrimitives,
) => {
  const { readEntityPage, readItem, recordOnce, updateRecord } = primitives;

  // A fresh identifier as the key: an item already there is this request landing again.
  const createList = Effect.fn("Storage.createList")((list: Schemas.ContactList) =>
    recordOnce("createList", {
      ...listKey(list.id),
      ...listingAttributes(listKind, list.createdAt, list.id),
      v: num(recordVersion),
      id: str(list.id),
      name: str(list.name),
      createdAt: str(list.createdAt),
    }),
  );

  const getList = Effect.fn("Storage.getList")(function* (listId: string) {
    const response = yield* readItem("getList", listKey(listId));

    if (response.Item === undefined) {
      return Option.none<Schemas.ContactList>();
    }

    const stored = yield* decodeStoredList(response.Item).pipe(Effect.mapError(corrupt("getList")));

    return Option.some<Schemas.ContactList>({
      id: stored.id,
      name: stored.name,
      createdAt: stored.createdAt,
    });
  });

  const listLists = Effect.fn("Storage.listLists")(function* (
    limit: number,
    cursor: string | undefined,
  ) {
    const page = yield* readEntityPage("listLists", listKind, listKey, limit, cursor);
    const lists: Array<Schemas.ContactList> = [];

    for (const item of page.items) {
      const stored = yield* decodeStoredList(item).pipe(Effect.mapError(corrupt("listLists")));

      lists.push({ id: stored.id, name: stored.name, createdAt: stored.createdAt });
    }

    return { items: lists, nextCursor: page.nextCursor } satisfies StoredPage<
      Schemas.ContactList,
      string
    >;
  });

  /**
   * A rename touches `name` and nothing else. `gsi1sk` is built from `createdAt` and `id`, both
   * immutable, so the list keeps its place in created order and no index entry has to move.
   */
  const renameList = Effect.fn("Storage.renameList")(function* (listId: string, name: string) {
    const found = yield* getList(listId);

    if (Option.isNone(found)) {
      return Option.none<Schemas.ContactList>();
    }

    yield* updateRecord("renameList", {
      Key: listKey(listId),
      UpdateExpression: "SET #name = :name",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":name": str(name) },
    });

    return Option.some<Schemas.ContactList>({ ...found.value, name });
  });

  return { createList, getList, listLists, renameList } as const;
};
