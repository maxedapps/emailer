import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { str } from "./Items.ts";
import { listOperations } from "./Lists.ts";
import { createdAt, listId, scriptedTable, primitivesFor } from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { ScriptedReplies } from "./Testing.ts";

const operationsFor = (table: Table) => listOperations(primitivesFor(table));

/** A plausible physical table name: what AWS keys batch responses by, and the binding never maps back. */
const physicalName = "emailer-test-EmailerData-9f3c";

const otherListId = "0195f0a0-1111-4222-8333-4444444010ff";

const olderCreatedAt = "2026-09-10T10:00:00.000Z";

const listItem = (id: string, name: string, at: string) => ({
  pk: { S: `LIST#${id}` },
  sk: { S: "META" },
  gsi1pk: { S: "list" },
  gsi1sk: { S: `${at}#${id}` },
  v: { N: "1" },
  id: { S: id },
  name: { S: name },
  createdAt: { S: at },
});

const withTable = (replies: ScriptedReplies) => {
  const table = scriptedTable(replies);

  return { table, operations: operationsFor(table) };
};

describe("createList", () => {
  it("writes the list with the listing attributes, without which it is invisible to the index", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, operations } = withTable({});

        yield* operations.createList({ id: listId, name: "Subscribers", createdAt });

        expect(table.putItemRequests[0]?.Item).toStrictEqual(
          listItem(listId, "Subscribers", createdAt),
        );
      }),
    ));
});

describe("getList", () => {
  it("reads the list itself, leaving its key and index attributes behind", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { operations } = withTable({
          getItem: [Effect.succeed({ Item: listItem(listId, "Subscribers", createdAt) })],
        });

        expect(Option.getOrUndefined(yield* operations.getList(listId))).toStrictEqual({
          id: listId,
          name: "Subscribers",
          createdAt,
        });
      }),
    ));
});

describe("listLists", () => {
  it("queries its own index partition and yields the page in index order", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const older = listItem(otherListId, "Older", olderCreatedAt);
        const newer = listItem(listId, "Newer", createdAt);

        const { table, operations } = withTable({
          query: [Effect.succeed({ Items: [older, newer] })],
          // A batch read answers in no particular order; the newer list comes back first.
          batchGetItem: [Effect.succeed({ Responses: { [physicalName]: [newer, older] } })],
        });

        const page = yield* operations.listLists(25, undefined);

        expect(table.queryRequests[0]?.ExpressionAttributeValues?.[":kind"]).toStrictEqual(
          str("list"),
        );
        expect(page.items.map((list) => list.id)).toStrictEqual([otherListId, listId]);
      }),
    ));
});

describe("renameList", () => {
  it("touches the name and nothing else, on a list that still exists", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, operations } = withTable({
          getItem: [Effect.succeed({ Item: listItem(listId, "Subscribers", createdAt) })],
        });

        expect(
          Option.getOrUndefined(yield* operations.renameList(listId, "Members")),
        ).toStrictEqual({ id: listId, name: "Members", createdAt });

        // Asserted whole: an added `gsi1sk` clause would keep the index out of step with the item,
        // and a dropped condition would let a rename resurrect a list deleted underneath it.
        expect(table.updateItemRequests[0]).toStrictEqual({
          Key: { pk: str(`LIST#${listId}`), sk: str("META") },
          UpdateExpression: "SET #name = :name",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#name": "name" },
          ExpressionAttributeValues: { ":name": str("Members") },
        });
      }),
    ));

  it("reports a missing list rather than writing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, operations } = withTable({});

        expect(Option.isNone(yield* operations.renameList(listId, "Members"))).toBe(true);
        expect(table.updateItemRequests).toStrictEqual([]);
      }),
    ));
});
