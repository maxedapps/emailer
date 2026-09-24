import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { describe, expect, it } from "@effect/vitest";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Schema } from "effect";

import { CorruptItem } from "../Errors.ts";
import { contactItem, readContact } from "./Contacts.ts";
import { itemReader, itemWriter, keyCodec } from "./Items.ts";
import { defectOf } from "./Testing.ts";

const contactId = "0195f0a0-1111-4222-8333-44444444c001";

const createdAt = "2026-09-11T10:00:00.000Z";

const contact: Schemas.Contact = {
  id: contactId,
  email: "sam@example.com",
  name: "Sam",
  attributes: { tier: "gold" },
  createdAt,
};

const read = (item: dynamodb.AttributeMap) => readContact("getContact", item);

describe("the item codec", () => {
  it.effect("writes a record's values as attributes of their kind, stamped with the version", () =>
    Effect.gen(function* () {
      const written = yield* itemWriter(
        Schema.Struct({
          text: Schema.String,
          count: Schema.Int,
          attributes: Schemas.ContactAttributes,
          occurrences: Schema.NonEmptyArray(Schema.String),
        }),
      )({ text: "hello", count: 3, attributes: { tier: "gold" }, occurrences: ["a#1"] });

      expect(written).toStrictEqual({
        v: { N: "1" },
        text: { S: "hello" },
        count: { N: "3" },
        attributes: { M: { tier: { S: "gold" } } },
        occurrences: { SS: ["a#1"] },
      });
    }),
  );

  it.effect("round trips a record, omitting what was never written", () =>
    Effect.gen(function* () {
      const bare = { id: contactId, email: "sam@example.com", createdAt };

      expect(yield* read(yield* contactItem(contact))).toStrictEqual(contact);
      expect(yield* read(yield* contactItem(bare))).toStrictEqual(bare);
    }),
  );

  it.effect("writes no attribute for an optional value left undefined", () =>
    Effect.gen(function* () {
      const item = yield* contactItem({ ...contact, name: undefined });

      expect(item).not.toHaveProperty("name");
    }),
  );

  it.effect("ignores the key and index attributes that travel on the same item", () =>
    Effect.gen(function* () {
      const item = yield* contactItem(contact);

      expect(item["pk"]).toBeDefined();
      expect(item["gsi1pk"]).toBeDefined();
      expect(yield* read(item)).toStrictEqual(contact);
    }),
  );

  it.effect.each([
    ["an attribute of the wrong kind", { name: { N: "7" } }],
    ["a required value of the wrong kind", { email: { N: "7" } }],
    ["an address that is not one", { email: { S: "not-an-address" } }],
    ["a version this code cannot read", { v: { N: "99" } }],
    ["no version at all", { v: undefined }],
  ] as const)("reads an item carrying %s as the CorruptItem defect", ([_label, overrides]) =>
    Effect.gen(function* () {
      const item = { ...(yield* contactItem(contact)), ...overrides };

      expect(yield* defectOf(read(item))).toStrictEqual(
        new CorruptItem({ operation: "getContact" }),
      );
    }),
  );

  it.effect("reads an item missing a required attribute as the CorruptItem defect", () =>
    Effect.gen(function* () {
      const { createdAt: _absent, ...item } = yield* contactItem(contact);

      expect(yield* defectOf(read(item))).toStrictEqual(
        new CorruptItem({ operation: "getContact" }),
      );
    }),
  );

  // DynamoDB refuses an empty set, so writing one is a bug, never a request.
  it.effect("refuses to write an empty set", () =>
    Effect.gen(function* () {
      const write = itemWriter(Schema.Struct({ occurrences: Schema.Array(Schema.String) }));

      expect(yield* defectOf(write({ occurrences: [] }))).toBeDefined();
    }),
  );

  it.effect("reads a key, which carries no version", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeEffect(keyCodec(Schema.Struct({ sk: Schema.String })));

      expect(yield* decode({ pk: { S: "LIST#1" }, sk: { S: "MEMBER#2" } })).toStrictEqual({
        sk: "MEMBER#2",
      });
    }),
  );

  // A map key of `__proto__` arrives as a real own property from parsed JSON. It must survive as
  // an ordinary key and must not become anyone's prototype.
  it.effect("keeps a __proto__ map key as data and pollutes nothing", () =>
    Effect.gen(function* () {
      const decode = itemReader(Schema.Struct({ attributes: Schemas.ContactAttributes }));

      const stored = yield* decode(
        "getContact",
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          '{"v":{"N":"1"},"attributes":{"M":{"__proto__":{"S":"evil"},"tier":{"S":"gold"}}}}',
        ).pipe(
          // SAFETY: the parsed JSON is an attribute map by construction.
          Effect.map((parsed) => parsed as Parameters<typeof decode>[1]),
        ),
      );

      expect(Object.keys(stored.attributes)).toStrictEqual(["__proto__", "tier"]);
      expect(Object.prototype.hasOwnProperty.call(stored.attributes, "__proto__")).toBe(true);
      // The decisive half: the key stayed data instead of becoming the object's prototype.
      expect(Object.getPrototypeOf(stored.attributes)).toBe(Object.prototype);
    }),
  );
});
