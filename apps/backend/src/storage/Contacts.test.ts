import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { tableLogicalId } from "./Items.ts";
import { contactOperations } from "./Contacts.ts";
import {
  cancelled,
  conditionFailed,
  contactId,
  createdAt,
  failureOf,
  scriptedTable,
  serverError,
  primitivesFor,
} from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { ScriptedReplies } from "./Testing.ts";

const operationsFor = (table: Table) => contactOperations(primitivesFor(table));

const email = "max@example.com";

const contactItem = {
  pk: { S: `CONTACT#${contactId}` },
  sk: { S: "META" },
  gsi1pk: { S: "contact" },
  gsi1sk: { S: `${createdAt}#${contactId}` },
  v: { N: "1" },
  id: { S: contactId },
  email: { S: email },
  name: { S: "Max" },
  createdAt: { S: createdAt },
};

const reservationItem = {
  pk: { S: `EMAIL#${email}` },
  sk: { S: "META" },
  v: { N: "1" },
  contactId: { S: contactId },
};

const create = (replies: ScriptedReplies) => {
  const table = scriptedTable(replies);

  return {
    table,
    run: operationsFor(table).createContact({ id: contactId, email, createdAt }),
  };
};

describe("createContact", () => {
  it("writes the contact and its address reservation in one transaction", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = create({});

        expect(yield* run).toBe("created");

        const request = table.transactionRequests[0];

        expect(request?.ClientRequestToken).toBe("token-1");
        expect(request?.TransactItems).toStrictEqual([
          {
            Put: {
              Table: tableLogicalId,
              Item: {
                pk: { S: `CONTACT#${contactId}` },
                sk: { S: "META" },
                gsi1pk: { S: "contact" },
                gsi1sk: { S: `${createdAt}#${contactId}` },
                v: { N: "1" },
                id: { S: contactId },
                email: { S: email },
                createdAt: { S: createdAt },
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              Table: tableLogicalId,
              Item: {
                pk: { S: `EMAIL#${email}` },
                sk: { S: "META" },
                v: { N: "1" },
                contactId: { S: contactId },
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ]);
      }),
    ));

  it("keys the reservation on the fully lowercased address, local part included", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({});

        yield* operationsFor(table).createContact({
          id: contactId,
          email: "Max.S@example.com",
          createdAt,
        });

        expect(table.transactionRequests[0]?.TransactItems[1]?.Put?.Item?.["pk"]).toStrictEqual({
          S: "EMAIL#max.s@example.com",
        });
        expect(table.transactionRequests[0]?.TransactItems[0]?.Put?.Item?.["email"]).toStrictEqual({
          S: "Max.S@example.com",
        });
      }),
    ));

  it("stores bounded attributes as a map and omits an absent name", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({});

        yield* operationsFor(table).createContact({
          id: contactId,
          email,
          createdAt,
          attributes: { plan: "pro" },
        });

        const item = table.transactionRequests[0]?.TransactItems[0]?.Put?.Item ?? {};

        expect(item["attributes"]).toStrictEqual({ M: { plan: { S: "pro" } } });
        expect(item).not.toHaveProperty("name");
      }),
    ));

  it("reports a taken address as an outcome rather than a failure", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = create({
          transactWriteItems: [cancelled("None", "ConditionalCheckFailed")],
        });

        expect(yield* run).toBe("email-taken");
      }),
    ));

  it("keeps a colliding identifier on the failure channel, where it is not an answer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = create({
          transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
        });

        expect(failureOf(yield* Effect.result(run)).reason).toBe("unavailable");
      }),
    ));

  it("reports an unavailable provider instead of pretending the write happened", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = create({ transactWriteItems: [Effect.fail(serverError)] });

        // Captured once: the stub serves replies by call order, so running the same effect twice
        // would take the default reply and report a success that never happened.
        const attempt = yield* Effect.result(run);

        expect(failureOf(attempt).reason).toBe("unavailable");
        expect(failureOf(attempt).operationId).toBe("createContact");
      }),
    ));
});

describe("getContact", () => {
  it("reads strongly consistently and decodes the stored record", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({ getItem: [Effect.succeed({ Item: contactItem })] });
        const storage = operationsFor(table);

        const contact = yield* storage.getContact(contactId);

        expect(table.getItemRequests).toStrictEqual([
          { Key: { pk: { S: `CONTACT#${contactId}` }, sk: { S: "META" } }, ConsistentRead: true },
        ]);
        expect(Option.getOrUndefined(contact)).toStrictEqual({
          id: contactId,
          email,
          name: "Max",
          createdAt,
        });
      }),
    ));

  it("decodes a stored attribute map back into the contract shape", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          getItem: [
            Effect.succeed({
              Item: { ...contactItem, attributes: { M: { plan: { S: "pro" } } } },
            }),
          ],
        });

        const contact = yield* operationsFor(table).getContact(contactId);

        expect(Option.getOrUndefined(contact)?.attributes).toStrictEqual({ plan: "pro" });
      }),
    ));

  it("returns none for a missing record", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const storage = operationsFor(scriptedTable({}));

        expect(Option.isNone(yield* storage.getContact(contactId))).toBe(true);
      }),
    ));

  it("treats a record that no longer satisfies the contract as corrupt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          getItem: [Effect.succeed({ Item: { ...contactItem, email: { S: "not-an-address" } } })],
        });

        const storage = operationsFor(table);

        const attempt = yield* Effect.result(storage.getContact(contactId));

        expect(failureOf(attempt).reason).toBe("corrupt");
      }),
    ));

  it("treats a record written by an unknown schema version as corrupt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          getItem: [Effect.succeed({ Item: { ...contactItem, v: { N: "2" } } })],
        });

        const storage = operationsFor(table);

        expect(failureOf(yield* Effect.result(storage.getContact(contactId))).reason).toBe(
          "corrupt",
        );
      }),
    ));
});

describe("getContactByEmail", () => {
  it("reads the reservation, then the contact it names", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          getItem: [
            Effect.succeed({ Item: reservationItem }),
            Effect.succeed({ Item: contactItem }),
          ],
        });

        const found = yield* operationsFor(table).getContactByEmail("MAX@example.com");

        expect(table.getItemRequests[0]?.Key).toStrictEqual({
          pk: { S: `EMAIL#${email}` },
          sk: { S: "META" },
        });
        expect(table.getItemRequests[1]?.Key).toStrictEqual({
          pk: { S: `CONTACT#${contactId}` },
          sk: { S: "META" },
        });
        expect(Option.getOrUndefined(found)?.id).toBe(contactId);
      }),
    ));

  it("returns none when no reservation holds the address, without a second read", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({});

        const found = yield* operationsFor(table).getContactByEmail(email);

        expect(Option.isNone(found)).toBe(true);
        expect(table.getItemRequests).toHaveLength(1);
      }),
    ));

  it("returns none when the reservation names a contact that is not there", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          getItem: [Effect.succeed({ Item: reservationItem }), Effect.succeed({})],
        });

        const found = yield* operationsFor(table).getContactByEmail(email);

        expect(Option.isNone(found)).toBe(true);
      }),
    ));

  it("never answers with a contact that does not hold the address asked for", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          getItem: [
            Effect.succeed({ Item: reservationItem }),
            Effect.succeed({ Item: { ...contactItem, email: { S: "someone@example.com" } } }),
          ],
        });

        const found = yield* operationsFor(table).getContactByEmail(email);

        expect(Option.isNone(found)).toBe(true);
      }),
    ));

  it("treats a reservation with no contact reference as corrupt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const table = scriptedTable({
          getItem: [Effect.succeed({ Item: { pk: { S: `EMAIL#${email}` }, sk: { S: "META" } } })],
        });

        const attempt = yield* Effect.result(operationsFor(table).getContactByEmail(email));

        expect(failureOf(attempt).reason).toBe("corrupt");
      }),
    ));
});

describe("updateContact", () => {
  const found: ScriptedReplies = { getItem: [Effect.succeed({ Item: contactItem })] };

  const update = (
    replies: ScriptedReplies,
    payload: Parameters<ReturnType<typeof contactOperations>["updateContact"]>[1],
  ) => {
    const table = scriptedTable(replies);

    return {
      table,
      run: operationsFor(table).updateContact(contactId, payload),
    };
  };

  it("reports a contact that is not there rather than writing anything", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = update({}, { name: "Maxi" });

        expect(yield* run).toStrictEqual({ outcome: "contact-missing" });
        expect(table.updateItemRequests).toStrictEqual([]);
        expect(table.transactionRequests).toStrictEqual([]);
      }),
    ));

  it("replaces the whole attribute map rather than merging into it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = update(found, { attributes: { city: "Berlin" } });

        expect(yield* run).toStrictEqual({
          outcome: "updated",
          contact: { id: contactId, email, name: "Max", attributes: { city: "Berlin" }, createdAt },
        });

        const request = table.updateItemRequests[0];

        expect(request?.UpdateExpression).toBe("SET #attributes = :attributes");
        expect(request?.ExpressionAttributeValues?.[":attributes"]).toStrictEqual({
          M: { city: { S: "Berlin" } },
        });
      }),
    ));

  it("clears a field on an explicit null and leaves an absent one alone", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = update(found, { name: null });

        expect(yield* run).toStrictEqual({
          outcome: "updated",
          contact: { id: contactId, email, createdAt },
        });
        expect(table.updateItemRequests[0]?.UpdateExpression).toBe("REMOVE #name");
      }),
    ));

  it("conditions every update on the address just read, so a clear-only one still binds a value", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = update(found, { name: null, attributes: null });

        yield* run;

        expect(table.updateItemRequests).toStrictEqual([
          {
            Key: { pk: { S: `CONTACT#${contactId}` }, sk: { S: "META" } },
            UpdateExpression: "REMOVE #name, #attributes",
            ConditionExpression: "attribute_exists(pk) AND #email = :currentEmail",
            ExpressionAttributeNames: {
              "#name": "name",
              "#attributes": "attributes",
              "#email": "email",
            },
            ExpressionAttributeValues: { ":currentEmail": { S: email } },
          },
        ]);
      }),
    ));

  it("still binds values when a change sets something alongside a clear", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = update(found, { name: null, attributes: { plan: "pro" } });

        yield* run;

        const request = table.updateItemRequests[0];

        expect(request?.UpdateExpression).toBe("SET #attributes = :attributes REMOVE #name");
        expect(request?.ExpressionAttributeValues).toStrictEqual({
          ":attributes": { M: { plan: { S: "pro" } } },
          ":currentEmail": { S: email },
        });
      }),
    ));

  it("writes nothing at all when the payload asks for no change", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = update(found, {});

        expect(yield* run).toStrictEqual({
          outcome: "updated",
          contact: { id: contactId, email, name: "Max", createdAt },
        });
        expect(table.updateItemRequests).toStrictEqual([]);
        expect(table.transactionRequests).toStrictEqual([]);
      }),
    ));

  it("moves the reservation when the address changes, unless the address left is opted out", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = update(found, { email: "new@example.com" });

        expect(yield* run).toStrictEqual({
          outcome: "updated",
          contact: { id: contactId, email: "new@example.com", name: "Max", createdAt },
        });

        expect(table.transactionRequests).toStrictEqual([
          {
            ClientRequestToken: "token-1",
            TransactItems: [
              {
                ConditionCheck: {
                  Table: tableLogicalId,
                  Key: { pk: { S: `UNSUBSCRIBE#${email}` }, sk: { S: "UNSUBSCRIBE" } },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              {
                Update: {
                  Table: tableLogicalId,
                  Key: { pk: { S: `CONTACT#${contactId}` }, sk: { S: "META" } },
                  UpdateExpression: "SET #email = :email",
                  ConditionExpression:
                    "attribute_exists(pk) AND (#email = :currentEmail OR #email = :email)",
                  ExpressionAttributeNames: { "#email": "email" },
                  ExpressionAttributeValues: {
                    ":email": { S: "new@example.com" },
                    ":currentEmail": { S: email },
                  },
                },
              },
              {
                Delete: {
                  Table: tableLogicalId,
                  Key: { pk: { S: `EMAIL#${email}` }, sk: { S: "META" } },
                },
              },
              {
                Put: {
                  Table: tableLogicalId,
                  Item: {
                    pk: { S: "EMAIL#new@example.com" },
                    sk: { S: "META" },
                    v: { N: "1" },
                    contactId: { S: contactId },
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ],
          },
        ]);
      }),
    ));

  it("never rewrites the attributes created order is built from", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = update(found, { email: "new@example.com", name: "Maxi" });

        yield* run;

        const expression = table.transactionRequests[0]?.TransactItems[1]?.Update?.UpdateExpression;

        expect(expression).toBe("SET #email = :email, #name = :name");
        expect(expression).not.toContain("gsi1sk");
        expect(expression).not.toContain("createdAt");
      }),
    ));

  it("takes the plain path when only the spelling of the address changes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, run } = update(found, { email: "MAX@example.com" });

        expect(yield* run).toStrictEqual({
          outcome: "updated",
          contact: { id: contactId, email: "MAX@example.com", name: "Max", createdAt },
        });
        expect(table.transactionRequests).toStrictEqual([]);
        expect(table.updateItemRequests[0]?.UpdateExpression).toBe("SET #email = :email");
        // Also true once the write has applied, so a lost response and a retry is not a lost race.
        expect(table.updateItemRequests[0]?.ConditionExpression).toBe(
          "attribute_exists(pk) AND (#email = :currentEmail OR #email = :email)",
        );
      }),
    ));

  it("keeps an update that lost a race on the plain path on the failure channel", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = update({ ...found, updateItem: [conditionFailed] }, { name: "Maxi" });

        expect(failureOf(yield* Effect.result(run)).reason).toBe("unavailable");
      }),
    ));

  it("reports an address another contact already holds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = update(
          {
            ...found,
            transactWriteItems: [cancelled("None", "None", "None", "ConditionalCheckFailed")],
          },
          { email: "new@example.com" },
        );

        expect(yield* run).toStrictEqual({ outcome: "email-taken", email: "new@example.com" });
      }),
    ));

  it("refuses to move a contact off an address that opted out", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = update(
          {
            ...found,
            transactWriteItems: [cancelled("ConditionalCheckFailed", "None", "None", "None")],
          },
          { email: "new@example.com" },
        );

        expect(yield* run).toStrictEqual({ outcome: "opted-out", email });
      }),
    ));

  it("answers the opt-out first when the new address is taken as well", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = update(
          {
            ...found,
            transactWriteItems: [
              cancelled("ConditionalCheckFailed", "None", "None", "ConditionalCheckFailed"),
            ],
          },
          { email: "new@example.com" },
        );

        expect(yield* run).toStrictEqual({ outcome: "opted-out", email });
      }),
    ));

  it("keeps a contact changed underneath the read on the failure channel", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = update(
          {
            ...found,
            transactWriteItems: [cancelled("None", "ConditionalCheckFailed", "None", "None")],
          },
          { email: "new@example.com" },
        );

        expect(failureOf(yield* Effect.result(run)).reason).toBe("unavailable");
      }),
    ));
});
