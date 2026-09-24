import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { tableLogicalId } from "./Items.ts";
import { membershipOperations } from "./Membership.ts";
import {
  cancelled,
  contactId,
  createdAt,
  failureOf,
  listId,
  scriptedTable,
  serverError,
  primitivesFor,
} from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { ImportCandidate } from "./Membership.ts";
import type { ScriptedReplies } from "./Testing.ts";

const operationsFor = (table: Table) => membershipOperations(primitivesFor(table));

describe("addMember", () => {
  const addMember = (replies: ScriptedReplies) => {
    const table = scriptedTable(replies);

    return {
      table,
      run: operationsFor(table).addMember(listId, contactId, createdAt),
    };
  };

  it("checks both parents and writes both membership directions", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = addMember({});

        expect(yield* run).toBe("added");

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
          {
            Put: {
              Table: tableLogicalId,
              Item: {
                pk: { S: `LIST#${listId}` },
                sk: { S: `MEMBER#${contactId}` },
                v: { N: "1" },
                listId: { S: listId },
                contactId: { S: contactId },
                addedAt: { S: createdAt },
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              Table: tableLogicalId,
              Item: {
                pk: { S: `CONTACT#${contactId}` },
                sk: { S: `LISTOF#${listId}` },
                v: { N: "1" },
                listId: { S: listId },
                contactId: { S: contactId },
                addedAt: { S: createdAt },
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ]);
      }),
    ));

  it("reports a missing contact", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = addMember({
          transactWriteItems: [cancelled("ConditionalCheckFailed", "None", "None", "None")],
        });

        expect(yield* run).toBe("contact-missing");
      }),
    ));

  it("reports a missing list", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = addMember({
          transactWriteItems: [cancelled("None", "ConditionalCheckFailed", "None", "None")],
        });

        expect(yield* run).toBe("list-missing");
      }),
    ));

  it("treats a repeated addition as a no-op", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = addMember({
          transactWriteItems: [
            cancelled("None", "None", "ConditionalCheckFailed", "ConditionalCheckFailed"),
          ],
        });

        expect(yield* run).toBe("already-member");
      }),
    ));

  it("does not turn an unrecognized cancellation reason into a business answer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = addMember({
          transactWriteItems: [cancelled("None", "None", "None", "ValidationError")],
        });

        expect(failureOf(yield* Effect.result(run)).reason).toBe("unavailable");
      }),
    ));

  it("does not turn a lost transaction response into a business answer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = addMember({ transactWriteItems: [Effect.fail(serverError)] });

        expect(failureOf(yield* Effect.result(run)).reason).toBe("unavailable");
      }),
    ));
});

describe("removeMember", () => {
  const removeMember = (replies: ScriptedReplies) => {
    const table = scriptedTable(replies);

    return {
      table,
      run: operationsFor(table).removeMember(listId, contactId),
    };
  };

  it("removes both directions and checks the list in one transaction", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = removeMember({});

        expect(yield* run).toBe("removed");

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
    ));

  it("reports a missing list", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = removeMember({
          transactWriteItems: [cancelled("None", "None", "ConditionalCheckFailed")],
        });

        expect(yield* run).toBe("list-missing");
      }),
    ));

  it("stays harmless when the contact was never a member", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = removeMember({});

        expect(yield* run).toBe("removed");
        expect(table.transactionRequests[0]?.TransactItems[0]?.Delete).not.toHaveProperty(
          "ConditionExpression",
        );
        expect(table.transactionRequests[0]?.TransactItems[1]?.Delete).not.toHaveProperty(
          "ConditionExpression",
        );
      }),
    ));

  it("does not turn a lost transaction response into a business answer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = removeMember({ transactWriteItems: [Effect.fail(serverError)] });

        expect(failureOf(yield* Effect.result(run)).reason).toBe("unavailable");
      }),
    ));
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

  it("answers none for a list that is not there, which is not an empty list", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({});

        const page = yield* operationsFor(table).listMembers(listId, 25, undefined);

        expect(Option.isNone(page)).toBe(true);
        expect(table.queryRequests).toStrictEqual([]);
      }),
    ));

  it("answers an empty page for a list with no members", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({ getItem: [Effect.succeed({ Item: listItem })] });

        const page = yield* operationsFor(table).listMembers(listId, 25, undefined);

        expect(Option.getOrUndefined(page)).toStrictEqual({ items: [], nextCursor: undefined });
      }),
    ));

  it("reads members from the base table and hydrates them into whole contacts", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          getItem: [Effect.succeed({ Item: listItem })],
          query: [
            Effect.succeed({
              Items: [{ contactId: { S: otherContactId } }, { contactId: { S: contactId } }],
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
        expect(Option.getOrUndefined(page)?.items.map((contact) => contact.id)).toStrictEqual([
          contactId,
          otherContactId,
        ]);
      }),
    ));

  it("derives the next cursor from the continuation key, as the contact identifier", () =>
    Effect.runPromise(
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

        expect(Option.getOrUndefined(page)?.items).toStrictEqual([]);
        expect(Option.getOrUndefined(page)?.nextCursor).toBe(contactId);
      }),
    ));

  it("resumes from the member key the cursor names", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({ getItem: [Effect.succeed({ Item: listItem })] });

        yield* operationsFor(table).listMembers(listId, 25, contactId);

        expect(table.queryRequests[0]?.ExclusiveStartKey).toStrictEqual({
          pk: { S: `LIST#${listId}` },
          sk: { S: `MEMBER#${contactId}` },
        });
      }),
    ));

  it("drops a member whose contact has since gone rather than failing the page", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          getItem: [Effect.succeed({ Item: listItem })],
          query: [
            Effect.succeed({
              Items: [{ contactId: { S: contactId } }, { contactId: { S: otherContactId } }],
            }),
          ],
          batchGetItem: [
            Effect.succeed({ Responses: { [physicalName]: [contactItem(contactId)] } }),
          ],
        });

        const page = yield* operationsFor(table).listMembers(listId, 25, undefined);

        expect(Option.getOrUndefined(page)?.items.map((contact) => contact.id)).toStrictEqual([
          contactId,
        ]);
      }),
    ));
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
    listId: { S: list },
    contactId: { S: contactId },
  });

  const found: ScriptedReplies = { getItem: [Effect.succeed({ Item: contactMeta })] };

  it("reports a contact that is not there without writing anything", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({});

        expect(yield* operationsFor(table).deleteContact(contactId)).toBe("contact-missing");
        expect(table.transactionRequests).toStrictEqual([]);
      }),
    ));

  it("removes each membership in its own unconditioned transaction and deletes META last", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          ...found,
          query: [Effect.succeed({ Items: [reverseItem(listId)] })],
        });

        expect(yield* operationsFor(table).deleteContact(contactId)).toBe("deleted");

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
    ));

  it("conditions the final delete on the address it read, so no reservation is stranded", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable(found);

        yield* operationsFor(table).deleteContact(contactId);

        const final = table.transactionRequests[0]?.TransactItems[0]?.Delete;

        expect(final?.ConditionExpression).toBe("attribute_exists(pk) AND #email = :email");
        expect(final?.ExpressionAttributeValues?.[":email"]).toStrictEqual({ S: email });
      }),
    ));

  it("surfaces a failed final condition rather than reporting the delete as done", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          ...found,
          transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
        });

        const attempt = yield* Effect.result(operationsFor(table).deleteContact(contactId));

        expect(failureOf(attempt).reason).toBe("unavailable");
      }),
    ));

  it("completes on a repeat after an interrupted cascade, because META outlives the memberships", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // The state a timed-out DELETE leaves behind: memberships gone, META still there. The
        // repeat discovers nothing to cascade and finishes the job.
        const table = scriptedTable({ ...found, query: [Effect.succeed({ Items: [] })] });

        expect(yield* operationsFor(table).deleteContact(contactId)).toBe("deleted");

        expect(table.transactionRequests).toHaveLength(1);
        expect(table.transactionRequests[0]?.TransactItems[0]?.Delete?.Key).toStrictEqual({
          pk: { S: `CONTACT#${contactId}` },
          sk: { S: "META" },
        });
      }),
    ));

  it("follows the continuation key so a contact in many lists is fully drained", () =>
    Effect.runPromise(
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
    ));
});

describe("deleteList", () => {
  const listMeta = { pk: { S: `LIST#${listId}` }, sk: { S: "META" } };

  const found: ScriptedReplies = { getItem: [Effect.succeed({ Item: listMeta })] };

  const memberItems = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      contactId: { S: `0195f0a0-1111-4222-8333-4444444${String(index).padStart(5, "0")}` },
    }));

  it("reports a list that is not there without writing anything", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({});

        expect(yield* operationsFor(table).deleteList(listId)).toBe("list-missing");
        expect(table.transactionRequests).toStrictEqual([]);
      }),
    ));

  it("deletes an empty list in one transaction carrying only its META", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable(found);

        expect(yield* operationsFor(table).deleteList(listId)).toBe("deleted");
        expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
          { Delete: { Table: tableLogicalId, Key: listMeta } },
        ]);
      }),
    ));

  it("pages at a bound that keeps every transaction inside the action limit", () =>
    Effect.runPromise(
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

        expect(yield* operationsFor(table).deleteList(listId)).toBe("deleted");

        expect(table.queryRequests[0]?.Limit).toBe(40);
        expect(
          table.transactionRequests.map((request) => request.TransactItems.length),
        ).toStrictEqual([80, 6, 1]);
      }),
    ));

  it("deletes META last and alone, and sends nothing for a page with no members", () =>
    Effect.runPromise(
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

        expect(yield* operationsFor(table).deleteList(listId)).toBe("deleted");

        expect(table.queryRequests).toHaveLength(2);
        expect(table.transactionRequests).toHaveLength(2);
        expect(table.transactionRequests[0]?.TransactItems).toHaveLength(80);
        expect(table.transactionRequests[1]?.TransactItems).toStrictEqual([
          { Delete: { Table: tableLogicalId, Key: listMeta } },
        ]);
      }),
    ));

  it("removes both directions for every member", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const memberId = "0195f0a0-1111-4222-8333-44444444c001";

        const table = scriptedTable({
          ...found,
          query: [Effect.succeed({ Items: [{ contactId: { S: memberId } }] })],
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
    ));
});

describe("importContacts", () => {
  const physicalName = "emailer-test-EmailerData-9f3c";

  const otherContactId = "0195f0a0-1111-4222-8333-44444444c002";

  const candidate = (id: string, email: string) => ({ id, email });

  const reservationFor = (email: string, holder: string) => ({
    pk: { S: `EMAIL#${email}` },
    sk: { S: "META" },
    v: { N: "1" },
    contactId: { S: holder },
  });

  const importInto = (replies: ScriptedReplies, candidates: ReadonlyArray<ImportCandidate>) => {
    const table = scriptedTable(replies);

    return {
      table,
      run: operationsFor(table).importContacts(listId, candidates, createdAt),
    };
  };

  it("creates a contact, reserves its address and joins it, in one transaction", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = importInto({}, [candidate(contactId, "sam@example.com")]);

        expect(yield* run).toStrictEqual({
          outcome: "imported",
          contacts: [{ email: "sam@example.com", contactId, member: true }],
        });

        const items = table.transactionRequests[0]?.TransactItems ?? [];

        expect(items).toHaveLength(5);
        expect(items[0]?.ConditionCheck).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: `LIST#${listId}` }, sk: { S: "META" } },
          ConditionExpression: "attribute_exists(pk)",
        });
        expect(items[1]?.Put?.Item?.["pk"]).toStrictEqual({ S: `CONTACT#${contactId}` });
        expect(items[2]?.Put?.Item?.["pk"]).toStrictEqual({ S: "EMAIL#sam@example.com" });
        expect(items[3]?.Update?.Key).toStrictEqual({
          pk: { S: `LIST#${listId}` },
          sk: { S: `MEMBER#${contactId}` },
        });
        expect(items[4]?.Update?.Key).toStrictEqual({
          pk: { S: `CONTACT#${contactId}` },
          sk: { S: `LISTOF#${listId}` },
        });
      }),
    ));

  it("guards an existing contact with a condition check instead of rewriting it", () =>
    Effect.runPromise(
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
          outcome: "imported",
          contacts: [{ email: "sam@example.com", contactId: otherContactId, member: true }],
        });

        const items = table.transactionRequests[0]?.TransactItems ?? [];

        expect(items).toHaveLength(5);
        expect(items[1]?.ConditionCheck).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: `CONTACT#${otherContactId}` }, sk: { S: "META" } },
          ConditionExpression: "attribute_exists(pk)",
        });
        // The contact existing is not enough: it must still be the address's holder, or this
        // import would add it to the list under an address it has since moved off.
        expect(items[2]?.ConditionCheck).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: "EMAIL#sam@example.com" }, sk: { S: "META" } },
          ConditionExpression: "contactId = :holder",
          ExpressionAttributeValues: { ":holder": { S: otherContactId } },
        });
        expect(items.some((item) => item.Put !== undefined)).toBe(false);
      }),
    ));

  it("re-running an identical import writes no new item and answers identically", () =>
    Effect.runPromise(
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

        // Members are upserted and the list is only checked, so nothing new is created.
        expect(items.some((item) => item.Put !== undefined)).toBe(false);
        expect(items[0]?.ConditionCheck?.Key).toStrictEqual({
          pk: { S: `LIST#${listId}` },
          sk: { S: "META" },
        });
      }),
    ));

  it("keeps the original join time when a member is imported again", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = importInto({}, [candidate(contactId, "sam@example.com")]);

        yield* run;

        expect(table.transactionRequests[0]?.TransactItems[3]?.Update?.UpdateExpression).toContain(
          "addedAt = if_not_exists(addedAt, :addedAt)",
        );
      }),
    ));

  it("stays inside the transaction action limit at a full batch", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const candidates = Array.from({ length: 20 }, (_, index) =>
          candidate(
            `0195f0a0-1111-4222-8333-4444444${String(index).padStart(5, "0")}`,
            `contact${index}@example.com`,
          ),
        );

        const { table, run } = importInto({}, candidates);

        yield* run;

        expect(table.transactionRequests[0]?.TransactItems).toHaveLength(81);
      }),
    ));

  it("reports a list that is not there rather than a storage failure", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = importInto(
          {
            transactWriteItems: [
              cancelled("ConditionalCheckFailed", "None", "None", "None", "None"),
            ],
          },
          [candidate(contactId, "sam@example.com")],
        );

        expect(yield* run).toStrictEqual({ outcome: "list-missing" });
      }),
    ));

  it("keeps an import racing a contact delete on the failure channel", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = importInto(
          {
            batchGetItem: [
              Effect.succeed({
                Responses: { [physicalName]: [reservationFor("sam@example.com", contactId)] },
              }),
            ],
            transactWriteItems: [cancelled("None", "ConditionalCheckFailed", "None", "None")],
          },
          [candidate(contactId, "sam@example.com")],
        );

        expect(failureOf(yield* Effect.result(run)).reason).toBe("unavailable");
      }),
    ));
});
