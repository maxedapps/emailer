import { ListNotFound } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";

import { itemReader, itemWriter, listingAttributes, str } from "./Items.ts";

import type {
  PagePrimitives,
  ReadPrimitives,
  StoredPage,
  UpdatePrimitives,
  WritePrimitives,
} from "./Primitives.ts";

const listKind = "list";

export const listKey = (listId: string) => ({ pk: str(`LIST#${listId}`), sk: str("META") });

const readList = itemReader(Schemas.ContactList);

const writeList = itemWriter(Schemas.ContactList);

export const listOperations = (
  primitives: ReadPrimitives & WritePrimitives & UpdatePrimitives & PagePrimitives,
) => {
  const { readEntityPage, readItem, recordOnce, updateIf } = primitives;

  // A fresh identifier as the key: an item already there is this request landing again.
  const createList = Effect.fn("Storage.createList")(function* (list: Schemas.ContactList) {
    yield* recordOnce("createList", {
      ...listKey(list.id),
      ...listingAttributes(listKind, list.createdAt, list.id),
      ...(yield* writeList(list)),
    });
  });

  const getList = Effect.fn("Storage.getList")(function* (listId: string) {
    const response = yield* readItem("getList", listKey(listId));

    if (response.Item === undefined) {
      return yield* new ListNotFound();
    }

    return yield* readList("getList", response.Item);
  });

  const listLists = Effect.fn("Storage.listLists")(function* (
    limit: number,
    cursor: string | undefined,
  ) {
    const page = yield* readEntityPage("listLists", listKind, listKey, limit, cursor);

    const lists = yield* Effect.forEach(page.items, (item) => readList("listLists", item));

    return { ...page, items: lists } satisfies StoredPage<Schemas.ContactList, string>;
  });

  /**
   * A rename touches `name` and nothing else. `gsi1sk` is built from `createdAt` and `id`, both
   * immutable, so the list keeps its place in created order and no index entry has to move. A
   * failed condition means the list is not there.
   */
  const renameList = Effect.fn("Storage.renameList")(function* (listId: string, name: string) {
    const outcome = yield* updateIf("renameList", {
      Key: listKey(listId),
      UpdateExpression: "SET #name = :name",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":name": str(name) },
      ReturnValues: "ALL_NEW",
    });

    if (!outcome.applied) {
      return yield* new ListNotFound();
    }

    return yield* readList("renameList", outcome.attributes);
  });

  return { createList, getList, listLists, renameList } as const;
};
