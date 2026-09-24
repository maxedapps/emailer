import * as Errors from "@emailer/api/Errors";
import { Effect, Struct } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { CorruptItem } from "../Errors.ts";
import { tableLogicalId } from "./Items.ts";
import { contactOperations } from "./Contacts.ts";
import { UnexpectedCondition } from "./Primitives.ts";
import {
  cancelled,
  contactId,
  createdAt,
  defectOf,
  primitivesFor,
  scriptedTable,
  serverError,
} from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { ScriptedReplies } from "./Testing.ts";

const operationsFor = (table: Table) => contactOperations(primitivesFor(table));

const email = "sam@example.com";

const contactItem = {
  pk: { S: `CONTACT#${contactId}` },
  sk: { S: "META" },
  gsi1pk: { S: "contact" },
  gsi1sk: { S: `${createdAt}#${contactId}` },
  v: { N: "1" },
  id: { S: contactId },
  email: { S: email },
  name: { S: "Sam" },
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
  it.effect("writes the contact and its address reservation in one transaction", () =>
    Effect.gen(function* () {
      const { table, run } = create({});

      expect(yield* run).toBeUndefined();

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
  );

  it.effect("keys the reservation on the fully lowercased address, local part included", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      yield* operationsFor(table).createContact({
        id: contactId,
        email: "Sam.R@example.com",
        createdAt,
      });

      expect(table.transactionRequests[0]?.TransactItems[1]?.Put?.Item?.["pk"]).toStrictEqual({
        S: "EMAIL#sam.r@example.com",
      });
      expect(table.transactionRequests[0]?.TransactItems[0]?.Put?.Item?.["email"]).toStrictEqual({
        S: "Sam.R@example.com",
      });
    }),
  );

  it.effect("stores bounded attributes as a map and omits an absent name", () =>
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
  );

  it.effect("answers a taken address with the contract's conflict, naming it", () =>
    Effect.gen(function* () {
      const { run } = create({
        transactWriteItems: [cancelled("None", "ConditionalCheckFailed")],
      });

      expect(yield* Effect.flip(run)).toStrictEqual(new Errors.EmailAlreadyUsed({ email }));
    }),
  );

  it.effect("dies on a colliding identifier, which a fresh identifier cannot be", () =>
    Effect.gen(function* () {
      const { run } = create({
        transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
      });

      expect(yield* defectOf(run)).toStrictEqual(
        new UnexpectedCondition({ operation: "createContact" }),
      );
    }),
  );

  it.effect("reports an unavailable provider instead of pretending the write happened", () =>
    Effect.gen(function* () {
      const { run } = create({ transactWriteItems: [Effect.fail(serverError)] });

      // Captured once: the stub serves replies by call order, so running the same effect twice
      // would take the default reply and report a success that never happened.
      const failure = yield* Effect.flip(run);

      expect(failure).toBeInstanceOf(Errors.StorageUnavailable);
      expect(failure).toMatchObject({ operation: "createContact" });
    }),
  );
});

describe("getContact", () => {
  it.effect("reads strongly consistently and decodes the stored record", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ getItem: [Effect.succeed({ Item: contactItem })] });
      const storage = operationsFor(table);

      const contact = yield* storage.getContact(contactId);

      expect(table.getItemRequests).toStrictEqual([
        { Key: { pk: { S: `CONTACT#${contactId}` }, sk: { S: "META" } }, ConsistentRead: true },
      ]);
      expect(contact).toStrictEqual({ id: contactId, email, name: "Sam", createdAt });
    }),
  );

  it.effect("decodes a stored attribute map back into the contract shape", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [
          Effect.succeed({
            Item: { ...contactItem, attributes: { M: { plan: { S: "pro" } } } },
          }),
        ],
      });

      const contact = yield* operationsFor(table).getContact(contactId);

      expect(contact.attributes).toStrictEqual({ plan: "pro" });
    }),
  );

  it.effect("answers NotFound for a missing record", () =>
    Effect.gen(function* () {
      const storage = operationsFor(scriptedTable({}));

      expect(yield* Effect.flip(storage.getContact(contactId))).toStrictEqual(
        new Errors.ContactNotFound(),
      );
    }),
  );

  it.effect("treats a record that no longer satisfies the contract as corrupt", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [Effect.succeed({ Item: { ...contactItem, email: { S: "not-an-address" } } })],
      });

      const storage = operationsFor(table);

      const defect = yield* defectOf(storage.getContact(contactId));

      expect(defect).toStrictEqual(new CorruptItem({ operation: "getContact" }));
    }),
  );

  it.effect("treats a record written by an unknown schema version as corrupt", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [Effect.succeed({ Item: { ...contactItem, v: { N: "2" } } })],
      });

      const storage = operationsFor(table);

      expect(yield* defectOf(storage.getContact(contactId))).toStrictEqual(
        new CorruptItem({ operation: "getContact" }),
      );
    }),
  );
});

describe("getContactByEmail", () => {
  it.effect("reads the reservation, then the contact it names", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [Effect.succeed({ Item: reservationItem }), Effect.succeed({ Item: contactItem })],
      });

      const found = yield* operationsFor(table).getContactByEmail("SAM@example.com");

      expect(table.getItemRequests[0]?.Key).toStrictEqual({
        pk: { S: `EMAIL#${email}` },
        sk: { S: "META" },
      });
      expect(table.getItemRequests[1]?.Key).toStrictEqual({
        pk: { S: `CONTACT#${contactId}` },
        sk: { S: "META" },
      });
      expect(found.id).toBe(contactId);
    }),
  );

  it.effect("answers NotFound when no reservation holds the address, without a second read", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      expect(yield* Effect.flip(operationsFor(table).getContactByEmail(email))).toStrictEqual(
        new Errors.ContactNotFound(),
      );
      expect(table.getItemRequests).toHaveLength(1);
    }),
  );

  it.effect("answers NotFound when the reservation names a contact that is not there", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [Effect.succeed({ Item: reservationItem }), Effect.succeed({})],
      });

      expect(yield* Effect.flip(operationsFor(table).getContactByEmail(email))).toStrictEqual(
        new Errors.ContactNotFound(),
      );
    }),
  );

  it.effect("never answers with a contact that does not hold the address asked for", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [
          Effect.succeed({ Item: reservationItem }),
          Effect.succeed({ Item: { ...contactItem, email: { S: "someone@example.com" } } }),
        ],
      });

      expect(yield* Effect.flip(operationsFor(table).getContactByEmail(email))).toStrictEqual(
        new Errors.ContactNotFound(),
      );
    }),
  );

  it.effect("treats a reservation with no contact reference as corrupt", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [Effect.succeed({ Item: { pk: { S: `EMAIL#${email}` }, sk: { S: "META" } } })],
      });

      const defect = yield* defectOf(operationsFor(table).getContactByEmail(email));

      expect(defect).toStrictEqual(new CorruptItem({ operation: "getContactByEmail" }));
    }),
  );
});

describe("updateContact", () => {
  const found: ScriptedReplies = { getItem: [Effect.succeed({ Item: contactItem })] };

  const withAttributes = { ...contactItem, attributes: { M: { plan: { S: "pro" } } } };

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

  const contactPut = (table: Table) => table.transactionRequests[0]?.TransactItems[0]?.Put;

  it.effect("reports a contact that is not there rather than writing anything", () =>
    Effect.gen(function* () {
      const { table, run } = update({}, { name: "Maxi" });

      expect(yield* Effect.flip(run)).toStrictEqual(new Errors.ContactNotFound());
      expect(table.transactionRequests).toStrictEqual([]);
    }),
  );

  it.effect(
    "writes the whole item back with the attributes created order is built from unchanged",
    () =>
      Effect.gen(function* () {
        const { table, run } = update(found, { email: "new@example.com", name: "Maxi" });

        yield* run;

        // Asserted whole: `gsi1sk`, `id` and `createdAt` carry the values just read, so the contact
        // keeps its place in created order.
        expect(contactPut(table)?.Item).toStrictEqual({
          ...contactItem,
          email: { S: "new@example.com" },
          name: { S: "Maxi" },
        });
      }),
  );

  it.effect("replaces the whole attribute map rather than merging into it", () =>
    Effect.gen(function* () {
      const { table, run } = update(
        { getItem: [Effect.succeed({ Item: withAttributes })] },
        { attributes: { city: "Berlin" } },
      );

      expect(yield* run).toStrictEqual({
        id: contactId,
        email,
        name: "Sam",
        attributes: { city: "Berlin" },
        createdAt,
      });
      expect(contactPut(table)?.Item).toStrictEqual({
        ...contactItem,
        attributes: { M: { city: { S: "Berlin" } } },
      });
    }),
  );

  it.effect("clears a field on an explicit null and leaves an absent one alone", () =>
    Effect.gen(function* () {
      const { table, run } = update(
        { getItem: [Effect.succeed({ Item: withAttributes })] },
        { name: null },
      );

      expect(yield* run).toStrictEqual({
        id: contactId,
        email,
        attributes: { plan: "pro" },
        createdAt,
      });
      expect(contactPut(table)?.Item).toStrictEqual(Struct.omit(withAttributes, ["name"]));
    }),
  );

  it.effect("writes the contact alone when only the spelling of the address changes", () =>
    Effect.gen(function* () {
      const { table, run } = update(found, { email: "SAM@example.com" });

      expect(yield* run).toStrictEqual({
        id: contactId,
        email: "SAM@example.com",
        name: "Sam",
        createdAt,
      });

      // One reservation item holds both spellings, so there is nothing to move and no opt-out to
      // check. The condition also holds once the write has applied, so a repeat is no lost race.
      expect(table.transactionRequests).toStrictEqual([
        {
          ClientRequestToken: "token-1",
          TransactItems: [
            {
              Put: {
                Table: tableLogicalId,
                Item: { ...contactItem, email: { S: "SAM@example.com" } },
                ConditionExpression:
                  "attribute_exists(pk) AND (#email = :currentEmail OR #email = :email)",
                ExpressionAttributeNames: { "#email": "email" },
                ExpressionAttributeValues: {
                  ":currentEmail": { S: email },
                  ":email": { S: "SAM@example.com" },
                },
              },
            },
          ],
        },
      ]);
    }),
  );

  it.effect(
    "moves the reservation when the address changes, unless the address left is opted out",
    () =>
      Effect.gen(function* () {
        const { table, run } = update(found, { email: "new@example.com" });

        expect(yield* run).toStrictEqual({
          id: contactId,
          email: "new@example.com",
          name: "Sam",
          createdAt,
        });

        expect(table.transactionRequests).toStrictEqual([
          {
            ClientRequestToken: "token-1",
            TransactItems: [
              {
                Put: {
                  Table: tableLogicalId,
                  Item: { ...contactItem, email: { S: "new@example.com" } },
                  ConditionExpression:
                    "attribute_exists(pk) AND (#email = :currentEmail OR #email = :email)",
                  ExpressionAttributeNames: { "#email": "email" },
                  ExpressionAttributeValues: {
                    ":currentEmail": { S: email },
                    ":email": { S: "new@example.com" },
                  },
                },
              },
              {
                ConditionCheck: {
                  Table: tableLogicalId,
                  Key: { pk: { S: `UNSUBSCRIBE#${email}` }, sk: { S: "UNSUBSCRIBE" } },
                  ConditionExpression: "attribute_not_exists(pk)",
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
  );

  it.effect("retries an update that lost a race from a fresh read", () =>
    Effect.gen(function* () {
      const { table, run } = update(
        {
          getItem: [Effect.succeed({ Item: contactItem }), Effect.succeed({ Item: contactItem })],
          transactWriteItems: [cancelled("ConditionalCheckFailed")],
        },
        { name: "Maxi" },
      );

      expect((yield* run).name).toBe("Maxi");
      expect(table.getItemRequests).toHaveLength(2);
      expect(table.transactionRequests).toHaveLength(2);
    }),
  );

  it.effect("answers ContactChanged when the contact keeps changing", () =>
    Effect.gen(function* () {
      const read = Effect.succeed({ Item: contactItem });
      const lost = cancelled("ConditionalCheckFailed");

      const { table, run } = update(
        { getItem: [read, read, read], transactWriteItems: [lost, lost, lost] },
        { name: "Maxi" },
      );

      expect(yield* Effect.flip(run)).toStrictEqual(new Errors.ContactChanged());
      expect(table.transactionRequests).toHaveLength(3);
    }),
  );

  it.effect("answers an address another contact already holds with a conflict naming it", () =>
    Effect.gen(function* () {
      const { run } = update(
        {
          ...found,
          transactWriteItems: [cancelled("None", "None", "None", "ConditionalCheckFailed")],
        },
        { email: "new@example.com" },
      );

      expect(yield* Effect.flip(run)).toStrictEqual(
        new Errors.EmailAlreadyUsed({ email: "new@example.com" }),
      );
    }),
  );

  it.effect(
    "refuses to move a contact off an address that opted out, naming the address left",
    () =>
      Effect.gen(function* () {
        const { run } = update(
          {
            ...found,
            transactWriteItems: [cancelled("None", "ConditionalCheckFailed", "None", "None")],
          },
          { email: "new@example.com" },
        );

        expect(yield* Effect.flip(run)).toStrictEqual(new Errors.AddressOptedOut({ email }));
      }),
  );

  it.effect("answers the opt-out first when the new address is taken as well", () =>
    Effect.gen(function* () {
      const { run } = update(
        {
          ...found,
          transactWriteItems: [
            cancelled("None", "ConditionalCheckFailed", "None", "ConditionalCheckFailed"),
          ],
        },
        { email: "new@example.com" },
      );

      expect(yield* Effect.flip(run)).toStrictEqual(new Errors.AddressOptedOut({ email }));
    }),
  );

  it.effect("lets a lost race decide over the address checks computed from the stale read", () =>
    Effect.gen(function* () {
      const read = Effect.succeed({ Item: contactItem });
      const lost = cancelled("ConditionalCheckFailed", "ConditionalCheckFailed", "None", "None");

      const { run } = update(
        { getItem: [read, read, read], transactWriteItems: [lost, lost, lost] },
        { email: "new@example.com" },
      );

      expect(yield* Effect.flip(run)).toStrictEqual(new Errors.ContactChanged());
    }),
  );
});
