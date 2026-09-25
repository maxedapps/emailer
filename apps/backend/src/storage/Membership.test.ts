import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { tableLogicalId } from "./Items.ts";
import { membershipOperations } from "./Membership.ts";
import {
  cancelled,
  contactId,
  createdAt,
  listId,
  scriptedTable,
  serverError,
  primitivesFor,
} from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { ScriptedReplies } from "./Testing.ts";

const operationsFor = (table: Table) => membershipOperations(primitivesFor(table));

/** A membership row as a query returns it: either direction stores the same record. */
const memberRow = (list: string, member: string) => ({
  v: { N: "1" },
  listId: { S: list },
  contactId: { S: member },
  addedAt: { S: createdAt },
});

/** Joining a list: an upsert that keeps the time the contact first joined. */
const join = (key: Record<string, { readonly S: string }>) => ({
  Update: {
    Table: tableLogicalId,
    Key: key,
    UpdateExpression:
      "SET v = :v, listId = :listId, contactId = :contactId, addedAt = if_not_exists(addedAt, :addedAt)",
    ExpressionAttributeValues: {
      ":v": { N: "1" },
      ":listId": { S: listId },
      ":contactId": { S: contactId },
      ":addedAt": { S: createdAt },
    },
  },
});

describe("addMember", () => {
  const addMember = (replies: ScriptedReplies) => {
    const table = scriptedTable(replies);

    return {
      table,
      run: operationsFor(table).addMember(listId, contactId, createdAt),
    };
  };

  it.effect("checks both parents and writes both membership directions", () =>
    Effect.gen(function* () {
      const { table, run } = addMember({});

      yield* run;

      const request = table.transactionRequests[0];

      expect(request?.ClientRequestToken).toBe("token-1");
      expect(request?.TransactItems).toStrictEqual([
        {
          ConditionCheck: {
            Table: tableLogicalId,
            Key: { pk: { S: `CONTACT#${contactId}` }, sk: { S: "META" } },
            ConditionExpression: "attribute_exists(pk)",
          },
        },
        {
          ConditionCheck: {
            Table: tableLogicalId,
            Key: { pk: { S: `LIST#${listId}` }, sk: { S: "META" } },
            ConditionExpression: "attribute_exists(pk)",
          },
        },
        join({ pk: { S: `LIST#${listId}` }, sk: { S: `MEMBER#${contactId}` } }),
        join({ pk: { S: `CONTACT#${contactId}` }, sk: { S: `LISTOF#${listId}` } }),
      ]);
    }),
  );

  it.effect("answers NotFound for a missing contact", () =>
    Effect.gen(function* () {
      const { run } = addMember({
        transactWriteItems: [cancelled("ConditionalCheckFailed", "None", "None", "None")],
      });

      expect(yield* Effect.flip(run)).toStrictEqual(new Errors.ContactNotFound());
    }),
  );

  it.effect("answers NotFound for a missing list", () =>
    Effect.gen(function* () {
      const { run } = addMember({
        transactWriteItems: [cancelled("None", "ConditionalCheckFailed", "None", "None")],
      });

      expect(yield* Effect.flip(run)).toStrictEqual(new Errors.ListNotFound());
    }),
  );

  it.effect("joins again without failing and without rewriting when the contact joined", () =>
    Effect.gen(function* () {
      const { table, run } = addMember({});

      yield* run;
      yield* run;

      expect(table.transactionRequests).toHaveLength(2);
      expect(table.transactionRequests[1]?.TransactItems[2]?.Update?.UpdateExpression).toContain(
        "addedAt = if_not_exists(addedAt, :addedAt)",
      );
    }),
  );

  it.effect("does not turn an unrecognized cancellation reason into a business answer", () =>
    Effect.gen(function* () {
      const { run } = addMember({
        transactWriteItems: [cancelled("None", "None", "None", "ValidationError")],
      });

      expect(yield* Effect.flip(run)).toBeInstanceOf(Errors.StorageUnavailable);
    }),
  );

  it.effect("does not turn a lost transaction response into a business answer", () =>
    Effect.gen(function* () {
      const { run } = addMember({ transactWriteItems: [Effect.fail(serverError)] });

      expect(yield* Effect.flip(run)).toBeInstanceOf(Errors.StorageUnavailable);
    }),
  );
});

describe("removeMember", () => {
  const removeMember = (replies: ScriptedReplies) => {
    const table = scriptedTable(replies);

    return {
      table,
      run: operationsFor(table).removeMember(listId, contactId),
    };
  };

  it.effect("removes both directions and checks the list in one transaction", () =>
    Effect.gen(function* () {
      const { table, run } = removeMember({});

      expect(yield* run).toBeUndefined();

      const request = table.transactionRequests[0];

      expect(request?.ClientRequestToken).toBe("token-1");
      expect(request?.TransactItems).toStrictEqual([
        {
          Delete: {
            Table: tableLogicalId,
            Key: { pk: { S: `LIST#${listId}` }, sk: { S: `MEMBER#${contactId}` } },
          },
        },
        {
          Delete: {
            Table: tableLogicalId,
            Key: { pk: { S: `CONTACT#${contactId}` }, sk: { S: `LISTOF#${listId}` } },
          },
        },
        {
          ConditionCheck: {
            Table: tableLogicalId,
            Key: { pk: { S: `LIST#${listId}` }, sk: { S: "META" } },
            ConditionExpression: "attribute_exists(pk)",
          },
        },
      ]);
    }),
  );

  it.effect("answers NotFound for a missing list", () =>
    Effect.gen(function* () {
      const { run } = removeMember({
        transactWriteItems: [cancelled("None", "None", "ConditionalCheckFailed")],
      });

      expect(yield* Effect.flip(run)).toStrictEqual(new Errors.ListNotFound());
    }),
  );

  it.effect("stays harmless when the contact was never a member", () =>
    Effect.gen(function* () {
      const { table, run } = removeMember({});

      expect(yield* run).toBeUndefined();
      expect(table.transactionRequests[0]?.TransactItems[0]?.Delete).not.toHaveProperty(
        "ConditionExpression",
      );
      expect(table.transactionRequests[0]?.TransactItems[1]?.Delete).not.toHaveProperty(
        "ConditionExpression",
      );
    }),
  );

  it.effect("does not turn a lost transaction response into a business answer", () =>
    Effect.gen(function* () {
      const { run } = removeMember({ transactWriteItems: [Effect.fail(serverError)] });

      expect(yield* Effect.flip(run)).toBeInstanceOf(Errors.StorageUnavailable);
    }),
  );
});

describe("listMembers", () => {
  const physicalName = "emailer-test-EmailerData-9f3c";

  const otherContactId = "0195f0a0-1111-4222-8333-44444444c002";

  const listItem = { pk: { S: `LIST#${listId}` }, sk: { S: "META" } };

  const contactItem = (id: string) => ({
    pk: { S: `CONTACT#${id}` },
    sk: { S: "META" },
    v: { N: "1" },
    id: { S: id },
    email: { S: `${id}@example.com` },
    createdAt: { S: createdAt },
  });

  it.effect("answers NotFound for a list that is not there, which is not an empty list", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      expect(
        yield* Effect.flip(operationsFor(table).listMembers(listId, 25, undefined)),
      ).toStrictEqual(new Errors.ListNotFound());
      expect(table.queryRequests).toStrictEqual([]);
    }),
  );

  it.effect("answers an empty page for a list with no members, with no nextCursor key at all", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ getItem: [Effect.succeed({ Item: listItem })] });

      const page = yield* operationsFor(table).listMembers(listId, 25, undefined);

      // Absent rather than `undefined`, which the API would encode as `null`.
      expect(page).toStrictEqual({ items: [] });
    }),
  );

  it.effect(
    "reads members from the base table and hydrates them into whole contacts in query order",
    () =>
      Effect.gen(function* () {
        const table = scriptedTable({
          getItem: [Effect.succeed({ Item: listItem })],
          query: [
            Effect.succeed({
              Items: [memberRow(listId, contactId), memberRow(listId, otherContactId)],
            }),
          ],
          batchGetItem: [
            Effect.succeed({
              Responses: { [physicalName]: [contactItem(otherContactId), contactItem(contactId)] },
            }),
          ],
        });

        const page = yield* operationsFor(table).listMembers(listId, 25, undefined);

        expect(table.queryRequests[0]?.ConsistentRead).toBe(true);
        expect(table.queryRequests[0]?.Limit).toBe(25);
        expect(page.items.map((contact) => contact.id)).toStrictEqual([contactId, otherContactId]);
      }),
  );

  it.effect("derives the next cursor from the continuation key, as the contact identifier", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [Effect.succeed({ Item: listItem })],
        query: [
          Effect.succeed({
            Items: [],
            LastEvaluatedKey: {
              pk: { S: `LIST#${listId}` },
              sk: { S: `MEMBER#${contactId}` },
            },
          }),
        ],
      });

      const page = yield* operationsFor(table).listMembers(listId, 25, undefined);

      expect(page.items).toStrictEqual([]);
      expect(page.nextCursor).toBe(contactId);
    }),
  );

  it.effect("resumes from the member key the cursor names", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ getItem: [Effect.succeed({ Item: listItem })] });

      yield* operationsFor(table).listMembers(listId, 25, contactId);

      expect(table.queryRequests[0]?.ExclusiveStartKey).toStrictEqual({
        pk: { S: `LIST#${listId}` },
        sk: { S: `MEMBER#${contactId}` },
      });
    }),
  );

  it.effect("drops a member whose contact has since gone rather than failing the page", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [Effect.succeed({ Item: listItem })],
        query: [
          Effect.succeed({
            Items: [memberRow(listId, contactId), memberRow(listId, otherContactId)],
          }),
        ],
        batchGetItem: [Effect.succeed({ Responses: { [physicalName]: [contactItem(contactId)] } })],
      });

      const page = yield* operationsFor(table).listMembers(listId, 25, undefined);

      expect(page.items.map((contact) => contact.id)).toStrictEqual([contactId]);
    }),
  );
});

describe("deleteContact", () => {
  const email = "sam@example.com";

  const contactMeta = {
    pk: { S: `CONTACT#${contactId}` },
    sk: { S: "META" },
    v: { N: "1" },
    id: { S: contactId },
    email: { S: email },
    createdAt: { S: createdAt },
  };

  const reverseItem = (list: string) => ({
    pk: { S: `CONTACT#${contactId}` },
    sk: { S: `LISTOF#${list}` },
    ...memberRow(list, contactId),
  });

  const found: ScriptedReplies = { getItem: [Effect.succeed({ Item: contactMeta })] };

  it.effect("answers NotFound for a contact that is not there without writing anything", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      expect(yield* Effect.flip(operationsFor(table).deleteContact(contactId))).toStrictEqual(
        new Errors.ContactNotFound(),
      );
      expect(table.transactionRequests).toStrictEqual([]);
    }),
  );

  it.effect(
    "removes each membership in its own unconditioned transaction and deletes META last",
    () =>
      Effect.gen(function* () {
        const table = scriptedTable({
          ...found,
          query: [Effect.succeed({ Items: [reverseItem(listId)] })],
        });

        expect(yield* operationsFor(table).deleteContact(contactId)).toBeUndefined();

        expect(table.transactionRequests).toHaveLength(2);
        expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
          {
            Delete: {
              Table: tableLogicalId,
              Key: { pk: { S: `LIST#${listId}` }, sk: { S: `MEMBER#${contactId}` } },
            },
          },
          {
            Delete: {
              Table: tableLogicalId,
              Key: { pk: { S: `CONTACT#${contactId}` }, sk: { S: `LISTOF#${listId}` } },
            },
          },
        ]);

        const last = table.transactionRequests[1]?.TransactItems ?? [];

        expect(last[0]?.Delete?.Key).toStrictEqual({
          pk: { S: `CONTACT#${contactId}` },
          sk: { S: "META" },
        });
        expect(last[1]?.Delete?.Key).toStrictEqual({
          pk: { S: `EMAIL#${email}` },
          sk: { S: "META" },
        });
      }),
  );

  it.effect(
    "conditions the final delete on the address it read, so no reservation is stranded",
    () =>
      Effect.gen(function* () {
        const table = scriptedTable(found);

        yield* operationsFor(table).deleteContact(contactId);

        const final = table.transactionRequests[0]?.TransactItems[0]?.Delete;

        expect(final?.ConditionExpression).toBe("attribute_exists(pk) AND #email = :email");
        expect(final?.ExpressionAttributeValues?.[":email"]).toStrictEqual({ S: email });
      }),
  );

  it.effect("retries a lost final condition from a fresh read, which finds the contact gone", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        ...found,
        transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
      });

      const failure = yield* Effect.flip(operationsFor(table).deleteContact(contactId));

      expect(failure).toStrictEqual(new Errors.ContactNotFound());
      expect(table.getItemRequests).toHaveLength(2);
    }),
  );

  it.effect("answers ContactChanged when the contact keeps changing under the delete", () =>
    Effect.gen(function* () {
      const read = Effect.succeed({ Item: contactMeta });
      const lost = cancelled("ConditionalCheckFailed", "None");

      const table = scriptedTable({
        getItem: [read, read, read],
        transactWriteItems: [lost, lost, lost],
      });

      const failure = yield* Effect.flip(operationsFor(table).deleteContact(contactId));

      expect(failure).toStrictEqual(new Errors.ContactChanged());
    }),
  );

  it.effect(
    "completes on a repeat after an interrupted cascade, because META outlives the memberships",
    () =>
      Effect.gen(function* () {
        // The state a timed-out DELETE leaves behind: memberships gone, META still there. The
        // repeat discovers nothing to cascade and finishes the job.
        const table = scriptedTable({ ...found, query: [Effect.succeed({ Items: [] })] });

        expect(yield* operationsFor(table).deleteContact(contactId)).toBeUndefined();

        expect(table.transactionRequests).toHaveLength(1);
        expect(table.transactionRequests[0]?.TransactItems[0]?.Delete?.Key).toStrictEqual({
          pk: { S: `CONTACT#${contactId}` },
          sk: { S: "META" },
        });
      }),
  );

  it.effect("follows the continuation key so a contact in many lists is fully drained", () =>
    Effect.gen(function* () {
      const otherListId = "0195f0a0-1111-4222-8333-4444444410af";

      const table = scriptedTable({
        ...found,
        query: [
          Effect.succeed({
            Items: [reverseItem(listId)],
            LastEvaluatedKey: reverseItem(listId),
          }),
          Effect.succeed({ Items: [reverseItem(otherListId)] }),
        ],
      });

      yield* operationsFor(table).deleteContact(contactId);

      expect(table.queryRequests).toHaveLength(2);
      expect(table.queryRequests[0]?.Limit).toBe(40);
      expect(table.transactionRequests).toHaveLength(3);
    }),
  );
});

describe("deleteList", () => {
  const listMeta = { pk: { S: `LIST#${listId}` }, sk: { S: "META" } };

  const found: ScriptedReplies = { getItem: [Effect.succeed({ Item: listMeta })] };

  const memberItems = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      memberRow(listId, `0195f0a0-1111-4222-8333-4444444${String(index).padStart(5, "0")}`),
    );

  it.effect("answers NotFound for a list that is not there without writing anything", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      expect(yield* Effect.flip(operationsFor(table).deleteList(listId))).toStrictEqual(
        new Errors.ListNotFound(),
      );
      expect(table.transactionRequests).toStrictEqual([]);
    }),
  );

  it.effect("deletes an empty list in one transaction carrying only its META", () =>
    Effect.gen(function* () {
      const table = scriptedTable(found);

      expect(yield* operationsFor(table).deleteList(listId)).toBeUndefined();
      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        { Delete: { Table: tableLogicalId, Key: listMeta } },
      ]);
    }),
  );

  it.effect("pages at a bound that keeps every transaction inside the action limit", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        ...found,
        query: [
          Effect.succeed({
            Items: memberItems(40),
            LastEvaluatedKey: { pk: { S: `LIST#${listId}` }, sk: { S: "MEMBER#x" } },
          }),
          Effect.succeed({ Items: memberItems(3) }),
        ],
      });

      expect(yield* operationsFor(table).deleteList(listId)).toBeUndefined();

      expect(table.queryRequests[0]?.Limit).toBe(40);
      expect(
        table.transactionRequests.map((request) => request.TransactItems.length),
      ).toStrictEqual([80, 6, 1]);
    }),
  );

  it.effect("deletes META last and alone, and sends nothing for a page with no members", () =>
    Effect.gen(function* () {
      // A page that ends exactly on the limit still carries a continuation key; the page after
      // it is empty, and an empty transaction would be refused on every repeat.
      const table = scriptedTable({
        ...found,
        query: [
          Effect.succeed({
            Items: memberItems(40),
            LastEvaluatedKey: { pk: { S: `LIST#${listId}` }, sk: { S: "MEMBER#x" } },
          }),
          Effect.succeed({ Items: [] }),
        ],
      });

      expect(yield* operationsFor(table).deleteList(listId)).toBeUndefined();

      expect(table.queryRequests).toHaveLength(2);
      expect(table.transactionRequests).toHaveLength(2);
      expect(table.transactionRequests[0]?.TransactItems).toHaveLength(80);
      expect(table.transactionRequests[1]?.TransactItems).toStrictEqual([
        { Delete: { Table: tableLogicalId, Key: listMeta } },
      ]);
    }),
  );

  it.effect("removes both directions for every member", () =>
    Effect.gen(function* () {
      const memberId = "0195f0a0-1111-4222-8333-44444444c001";

      const table = scriptedTable({
        ...found,
        query: [Effect.succeed({ Items: [memberRow(listId, memberId)] })],
      });

      yield* operationsFor(table).deleteList(listId);

      const items = table.transactionRequests[0]?.TransactItems ?? [];

      expect(items[0]?.Delete?.Key).toStrictEqual({
        pk: { S: `LIST#${listId}` },
        sk: { S: `MEMBER#${memberId}` },
      });
      expect(items[1]?.Delete?.Key).toStrictEqual({
        pk: { S: `CONTACT#${memberId}` },
        sk: { S: `LISTOF#${listId}` },
      });
    }),
  );
});

describe("importContacts", () => {
  const physicalName = "emailer-test-EmailerData-9f3c";

  const otherContactId = "0195f0a0-1111-4222-8333-44444444c002";

  const candidate = (id: string, email: string) => ({ id, email, createdAt });

  const reservationFor = (email: string, holder: string) => ({
    pk: { S: `EMAIL#${email}` },
    sk: { S: "META" },
    v: { N: "1" },
    contactId: { S: holder },
  });

  const listKey = { pk: { S: `LIST#${listId}` }, sk: { S: "META" } };

  const listFound = Effect.succeed({ Item: listKey });

  /** The list is there for the first read and for the one a raced import retries with. */
  const importInto = (replies: ScriptedReplies, candidates: ReadonlyArray<Schemas.Contact>) => {
    const table = scriptedTable({ getItem: [listFound, listFound], ...replies });

    return {
      table,
      run: operationsFor(table).importContacts(listId, candidates, createdAt),
    };
  };

  it.effect("creates a contact, reserves its address and joins it, in one transaction", () =>
    Effect.gen(function* () {
      const { table, run } = importInto({}, [candidate(contactId, "sam@example.com")]);

      expect(yield* run).toStrictEqual({
        contacts: [{ email: "sam@example.com", contactId, member: true }],
      });

      // The list is read, strongly consistent, and never locked by the transaction: its META shares
      // the partition every member write lands on.
      expect(table.getItemRequests).toStrictEqual([{ Key: listKey, ConsistentRead: true }]);

      const items = table.transactionRequests[0]?.TransactItems ?? [];

      expect(items).toHaveLength(4);
      expect(items[0]?.Put?.Item?.["pk"]).toStrictEqual({ S: `CONTACT#${contactId}` });
      expect(items[1]?.Put?.Item?.["pk"]).toStrictEqual({ S: "EMAIL#sam@example.com" });
      expect(items[2]?.Update?.Key).toStrictEqual({
        pk: { S: `LIST#${listId}` },
        sk: { S: `MEMBER#${contactId}` },
      });
      expect(items[3]?.Update?.Key).toStrictEqual({
        pk: { S: `CONTACT#${contactId}` },
        sk: { S: `LISTOF#${listId}` },
      });
    }),
  );

  it.effect("guards an existing contact with a condition check instead of rewriting it", () =>
    Effect.gen(function* () {
      const { table, run } = importInto(
        {
          batchGetItem: [
            Effect.succeed({
              Responses: {
                [physicalName]: [reservationFor("sam@example.com", otherContactId)],
              },
            }),
          ],
        },
        [candidate(contactId, "sam@example.com")],
      );

      expect(yield* run).toStrictEqual({
        contacts: [{ email: "sam@example.com", contactId: otherContactId, member: true }],
      });

      const items = table.transactionRequests[0]?.TransactItems ?? [];

      expect(items).toHaveLength(4);
      expect(items[0]?.ConditionCheck).toStrictEqual({
        Table: tableLogicalId,
        Key: { pk: { S: `CONTACT#${otherContactId}` }, sk: { S: "META" } },
        ConditionExpression: "attribute_exists(pk)",
      });
      // The contact existing is not enough: it must still be the address's holder, or this
      // import would add it to the list under an address it has since moved off.
      expect(items[1]?.ConditionCheck).toStrictEqual({
        Table: tableLogicalId,
        Key: { pk: { S: "EMAIL#sam@example.com" }, sk: { S: "META" } },
        ConditionExpression: "contactId = :holder",
        ExpressionAttributeValues: { ":holder": { S: otherContactId } },
      });
      expect(items.some((item) => item.Put !== undefined)).toBe(false);
    }),
  );

  it.effect("re-running an identical import writes no new item and answers identically", () =>
    Effect.gen(function* () {
      const reserved: ScriptedReplies = {
        batchGetItem: [
          Effect.succeed({
            Responses: { [physicalName]: [reservationFor("sam@example.com", contactId)] },
          }),
        ],
      };

      const first = importInto(reserved, [candidate(contactId, "sam@example.com")]);
      const firstResult = yield* first.run;

      const second = importInto(reserved, [candidate(otherContactId, "sam@example.com")]);
      const secondResult = yield* second.run;

      expect(secondResult).toStrictEqual(firstResult);

      const items = second.table.transactionRequests[0]?.TransactItems ?? [];

      // Members are upserted and the holder only checked, so nothing new is created.
      expect(items.some((item) => item.Put !== undefined)).toBe(false);
    }),
  );

  it.effect("keeps the original join time when a member is imported again", () =>
    Effect.gen(function* () {
      const { table, run } = importInto({}, [candidate(contactId, "sam@example.com")]);

      yield* run;

      expect(table.transactionRequests[0]?.TransactItems[2]?.Update?.UpdateExpression).toContain(
        "addedAt = if_not_exists(addedAt, :addedAt)",
      );
    }),
  );

  it.effect("stays inside the transaction action limit at a full batch", () =>
    Effect.gen(function* () {
      const candidates = Array.from({ length: 20 }, (_, index) =>
        candidate(
          `0195f0a0-1111-4222-8333-4444444${String(index).padStart(5, "0")}`,
          `contact${index}@example.com`,
        ),
      );

      const { table, run } = importInto({}, candidates);

      yield* run;

      expect(table.transactionRequests[0]?.TransactItems).toHaveLength(80);
    }),
  );

  it.effect("answers NotFound for a list that is not there, before writing anything", () =>
    Effect.gen(function* () {
      const { table, run } = importInto({ getItem: [Effect.succeed({})] }, [
        candidate(contactId, "sam@example.com"),
      ]);

      expect(yield* Effect.flip(run)).toStrictEqual(new Errors.ListNotFound());
      expect(table.transactionRequests).toHaveLength(0);
    }),
  );

  it.effect("retries an import that raced a contact delete, from a fresh pre-read", () =>
    Effect.gen(function* () {
      const { table, run } = importInto(
        {
          // The first pre-read finds the holder; by the retry, the contact and its address are gone.
          batchGetItem: [
            Effect.succeed({
              Responses: { [physicalName]: [reservationFor("sam@example.com", contactId)] },
            }),
          ],
          transactWriteItems: [cancelled("ConditionalCheckFailed", "None", "None", "None")],
        },
        [candidate(otherContactId, "sam@example.com")],
      );

      expect(yield* run).toStrictEqual({
        contacts: [{ email: "sam@example.com", contactId: otherContactId, member: true }],
      });
      expect(table.transactionRequests).toHaveLength(2);
      expect(table.transactionRequests[1]?.TransactItems[0]?.Put?.Item?.["id"]).toStrictEqual({
        S: otherContactId,
      });
    }),
  );
});
