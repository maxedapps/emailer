import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
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
  succeeded,
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
  revision: { N: "3" },
};

/** What an update writes back: the item at the next revision, with `changes` applied. */
const rewritten = (changes: dynamodb.AttributeMap = {}) => ({
  ...contactItem,
  revision: { N: "4" },
  ...changes,
});

/** The condition every update of the fixture asserts: the revision it read. */
const atRevision3 = {
  ConditionExpression: "revision = :revision",
  ExpressionAttributeValues: { ":revision": { N: "3" } },
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
      const { table, run } = create({ transactWriteItems: [succeeded] });

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
              revision: { N: "1" },
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
      const table = scriptedTable({ transactWriteItems: [succeeded] });

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

  it.effect("answers NotFound for a missing record", () =>
    Effect.gen(function* () {
      const storage = operationsFor(scriptedTable({ getItem: [succeeded] }));

      expect(yield* Effect.flip(storage.getContact(contactId))).toStrictEqual(
        new Errors.ContactNotFound(),
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
      const table = scriptedTable({ getItem: [succeeded] });

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

  /** The contact read, then its write accepted. */
  const foundAndWritten: ScriptedReplies = { ...found, transactWriteItems: [succeeded] };

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
      const { table, run } = update({ getItem: [succeeded] }, { name: "Maxi" });

      expect(yield* Effect.flip(run)).toStrictEqual(new Errors.ContactNotFound());
      expect(table.transactionRequests).toStrictEqual([]);
    }),
  );

  it.effect(
    "writes the whole item back with the attributes created order is built from unchanged",
    () =>
      Effect.gen(function* () {
        const { table, run } = update(foundAndWritten, { email: "new@example.com", name: "Maxi" });

        yield* run;

        // Asserted whole: `gsi1sk`, `id` and `createdAt` carry the values just read, so the contact
        // keeps its place in created order.
        expect(contactPut(table)?.Item).toStrictEqual(
          rewritten({ email: { S: "new@example.com" }, name: { S: "Maxi" } }),
        );
      }),
  );

  it.effect("merges the attributes: a value sets a key, null removes one, the rest stay", () =>
    Effect.gen(function* () {
      const both = { ...contactItem, attributes: { M: { plan: { S: "pro" }, tier: { S: "a" } } } };

      const { table, run } = update(
        { getItem: [Effect.succeed({ Item: both })], transactWriteItems: [succeeded] },
        { attributes: { city: "Berlin", tier: null } },
      );

      expect(yield* run).toStrictEqual({
        id: contactId,
        email,
        name: "Sam",
        attributes: { plan: "pro", city: "Berlin" },
        createdAt,
      });
      expect(contactPut(table)?.Item).toStrictEqual(
        rewritten({ attributes: { M: { plan: { S: "pro" }, city: { S: "Berlin" } } } }),
      );
    }),
  );

  it.effect("clears every attribute on attributes: null", () =>
    Effect.gen(function* () {
      const { table, run } = update(
        { getItem: [Effect.succeed({ Item: withAttributes })], transactWriteItems: [succeeded] },
        { attributes: null },
      );

      expect(yield* run).not.toHaveProperty("attributes");
      expect(contactPut(table)?.Item).toStrictEqual(rewritten());
    }),
  );

  it.effect("refuses a merge that would leave more attributes than a contact holds", () =>
    Effect.gen(function* () {
      const patch = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`key${index}`, "v"]),
      );

      const { table, run } = update(
        { getItem: [Effect.succeed({ Item: withAttributes })] },
        {
          attributes: patch,
        },
      );

      expect(yield* Effect.flip(run)).toStrictEqual(
        new Errors.TooManyAttributes({ email, limit: 20 }),
      );
      expect(table.transactionRequests).toStrictEqual([]);
    }),
  );

  it.effect("keeps a concurrent merge of another key: the loser re-reads and merges again", () =>
    Effect.gen(function* () {
      // Both merges read {plan}; the other one added `source` and committed first.
      const afterOther = {
        ...withAttributes,
        attributes: { M: { plan: { S: "pro" }, source: { S: "csv" } } },
        revision: { N: "4" },
      };

      const { table, run } = update(
        {
          getItem: [Effect.succeed({ Item: withAttributes }), Effect.succeed({ Item: afterOther })],
          transactWriteItems: [cancelled("ConditionalCheckFailed"), succeeded],
        },
        { attributes: { city: "Berlin" } },
      );

      expect((yield* run).attributes).toStrictEqual({
        plan: "pro",
        source: "csv",
        city: "Berlin",
      });
      expect(table.transactionRequests[1]?.TransactItems[0]?.Put).toMatchObject({
        Item: { revision: { N: "5" } },
        ExpressionAttributeValues: { ":revision": { N: "4" } },
      });
    }),
  );

  it.effect(
    "writes a contact from before revisions only while it is there and still has none",
    () =>
      Effect.gen(function* () {
        const { revision: _revision, ...legacy } = contactItem;

        const { table, run } = update(
          { getItem: [Effect.succeed({ Item: legacy })], transactWriteItems: [succeeded] },
          {
            name: "Maxi",
          },
        );

        yield* run;

        expect(contactPut(table)).toStrictEqual({
          Table: tableLogicalId,
          Item: { ...legacy, name: { S: "Maxi" }, revision: { N: "1" } },
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revision)",
        });
      }),
  );

  it.effect("clears a field on an explicit null and leaves an absent one alone", () =>
    Effect.gen(function* () {
      const { table, run } = update(
        { getItem: [Effect.succeed({ Item: withAttributes })], transactWriteItems: [succeeded] },
        { name: null },
      );

      expect(yield* run).toStrictEqual({
        id: contactId,
        email,
        attributes: { plan: "pro" },
        createdAt,
      });
      expect(contactPut(table)?.Item).toStrictEqual({
        ...Struct.omit(withAttributes, ["name"]),
        revision: { N: "4" },
      });
    }),
  );

  it.effect("writes the contact alone when only the spelling of the address changes", () =>
    Effect.gen(function* () {
      const { table, run } = update(foundAndWritten, { email: "SAM@example.com" });

      expect(yield* run).toStrictEqual({
        id: contactId,
        email: "SAM@example.com",
        name: "Sam",
        createdAt,
      });

      // One reservation item holds both spellings, so there is nothing to move and no opt-out to
      // check.
      expect(table.transactionRequests).toStrictEqual([
        {
          ClientRequestToken: "token-1",
          TransactItems: [
            {
              Put: {
                Table: tableLogicalId,
                Item: rewritten({ email: { S: "SAM@example.com" } }),
                ...atRevision3,
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
        const { table, run } = update(foundAndWritten, { email: "new@example.com" });

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
                  Item: rewritten({ email: { S: "new@example.com" } }),
                  ...atRevision3,
                },
              },
              {
                ConditionCheck: {
                  Table: tableLogicalId,
                  Key: { pk: { S: `ADDRESS#${email}` }, sk: { S: "ADDRESS" } },
                  ConditionExpression: "attribute_not_exists(optOuts)",
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
          transactWriteItems: [cancelled("ConditionalCheckFailed"), succeeded],
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

describe("setAttributes", () => {
  const physicalName = "emailer-test-EmailerData-9f3c";

  const otherEmail = "kim@example.com";

  const batch = (...items: ReadonlyArray<dynamodb.AttributeMap>) =>
    Effect.succeed({ Responses: { [physicalName]: [...items] } });

  const withAttributes = { ...contactItem, attributes: { M: { plan: { S: "pro" } } } };

  const merge = (replies: ScriptedReplies) => {
    const table = scriptedTable(replies);

    return {
      table,
      run: operationsFor(table).setAttributes([
        { email, attributes: { segment: "a" } },
        { email: otherEmail, attributes: { segment: "b" } },
      ]),
    };
  };

  it.effect(
    "merges into each contact holding an address, at its next revision, and reports the rest",
    () =>
      Effect.gen(function* () {
        const { table, run } = merge({
          batchGetItem: [batch(reservationItem), batch(withAttributes)],
          transactWriteItems: [succeeded],
        });

        expect(yield* run).toStrictEqual({
          contacts: [
            { email, outcome: "updated", contactId },
            { email: otherEmail, outcome: "not-found" },
          ],
        });
        expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
          {
            Put: {
              Table: tableLogicalId,
              Item: rewritten({ attributes: { M: { plan: { S: "pro" }, segment: { S: "a" } } } }),
              ...atRevision3,
            },
          },
        ]);
      }),
  );

  it.effect("writes nothing when no contact holds any of the addresses", () =>
    Effect.gen(function* () {
      const { table, run } = merge({ batchGetItem: [batch(), batch()] });

      expect((yield* run).contacts.map((entry) => entry.outcome)).toStrictEqual([
        "not-found",
        "not-found",
      ]);
      expect(table.transactionRequests).toStrictEqual([]);
    }),
  );

  it.effect("keeps a name edit that landed first: the merge re-reads and writes over it", () =>
    Effect.gen(function* () {
      const renamed = { ...withAttributes, name: { S: "Samantha" }, revision: { N: "4" } };

      const { table, run } = merge({
        batchGetItem: [
          batch(reservationItem),
          batch(withAttributes),
          batch(reservationItem),
          batch(renamed),
        ],
        transactWriteItems: [cancelled("ConditionalCheckFailed"), succeeded],
      });

      yield* run;

      expect(table.transactionRequests[1]?.TransactItems[0]?.Put?.Item).toMatchObject({
        name: { S: "Samantha" },
        attributes: { M: { plan: { S: "pro" }, segment: { S: "a" } } },
        revision: { N: "5" },
      });
    }),
  );

  it.effect(
    "treats a contact that moved off the address since the reservation read as a race",
    () =>
      Effect.gen(function* () {
        const moved = batch({ ...contactItem, email: { S: "elsewhere@example.com" } });

        const { run } = merge({
          batchGetItem: [
            batch(reservationItem),
            moved,
            batch(reservationItem),
            moved,
            batch(reservationItem),
            moved,
          ],
        });

        expect(yield* Effect.flip(run)).toStrictEqual(new Errors.ContactChanged());
      }),
  );

  it.effect("refuses the whole batch when one merge would pass the attribute limit", () =>
    Effect.gen(function* () {
      const full = {
        ...contactItem,
        attributes: {
          M: Object.fromEntries(
            Array.from({ length: 20 }, (_, index) => [`key${index}`, { S: "v" }]),
          ),
        },
      };

      const { table, run } = merge({ batchGetItem: [batch(reservationItem), batch(full)] });

      expect(yield* Effect.flip(run)).toStrictEqual(
        new Errors.TooManyAttributes({ email, limit: 20 }),
      );
      expect(table.transactionRequests).toStrictEqual([]);
    }),
  );
});
