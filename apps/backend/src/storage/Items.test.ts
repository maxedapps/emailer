import * as Schemas from "@emailer/api/Schemas";
import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { contactItem, decodeContactItem } from "./Contacts.ts";
import {
  attributeOf,
  NumberAttribute,
  recordVersion,
  StoredVersionAttribute,
  StringAttribute,
  StringMapAttribute,
} from "./Items.ts";

const contactId = "0195f0a0-1111-4222-8333-44444444c001";

const createdAt = "2026-09-11T10:00:00.000Z";

const contact: Schemas.Contact = {
  id: contactId,
  email: "max@example.com",
  name: "Max",
  attributes: { tier: "gold" },
  createdAt,
};

const decodeString = Schema.decodeUnknownResult(StringAttribute);

const decodeNumber = Schema.decodeUnknownResult(NumberAttribute);

const decodeStringMap = Schema.decodeUnknownResult(StringMapAttribute);

const decodeEntityId = Schema.decodeUnknownResult(attributeOf(Schemas.EntityId));

const decodeVersion = Schema.decodeUnknownResult(StoredVersionAttribute);

describe("wire codecs", () => {
  it("decodes each attribute kind to its value", () => {
    expect(decodeString({ S: "value" })).toStrictEqual(Result.succeed("value"));
    expect(decodeNumber({ N: "42" })).toStrictEqual(Result.succeed(42));
    expect(decodeNumber({ N: "-7" })).toStrictEqual(Result.succeed(-7));
    expect(decodeStringMap({ M: { tier: { S: "gold" } } })).toStrictEqual(
      Result.succeed({ tier: "gold" }),
    );
    expect(decodeStringMap({ M: {} })).toStrictEqual(Result.succeed({}));
  });

  // The helpers these replaced answered `undefined` for an attribute of the wrong kind, so a
  // corrupt value and a value that was never written were indistinguishable.
  it.each([
    ["a number where a string belongs", { N: "42" }],
    ["a bare value carrying no attribute kind", "value"],
    ["an absent attribute", undefined],
  ])("refuses %s", (_label, wire) => {
    expect(Result.isFailure(decodeString(wire))).toBe(true);
  });

  it.each([
    ["a string where a number belongs", { S: "42" }],
    ["a number that is not one", { N: "not-a-number" }],
    ["an infinite number", { N: "Infinity" }],
  ])("refuses %s", (_label, wire) => {
    expect(Result.isFailure(decodeNumber(wire))).toBe(true);
  });

  it.each([
    ["a list where a map belongs", { L: [] }],
    ["a map whose value is the wrong kind", { M: { tier: { N: "1" } } }],
  ])("refuses %s", (_label, wire) => {
    expect(Result.isFailure(decodeStringMap(wire))).toBe(true);
  });

  it("applies the domain rule as well as the wire kind", () => {
    expect(decodeEntityId({ S: contactId })).toStrictEqual(Result.succeed(contactId));
    expect(Result.isFailure(decodeEntityId({ S: "not-a-uuid" }))).toBe(true);
    expect(Result.isFailure(decodeEntityId({ N: "1" }))).toBe(true);
  });

  it("accepts only the record version this code can read", () => {
    expect(decodeVersion({ N: String(recordVersion) })).toStrictEqual(
      Result.succeed(recordVersion),
    );
    expect(Result.isFailure(decodeVersion({ N: "99" }))).toBe(true);
  });

  // A map key of `__proto__` arrives as a real own property from parsed JSON. It must survive as
  // an ordinary key and must not become anyone's prototype.
  it("keeps a __proto__ map key as data and pollutes nothing", () => {
    const decoded = decodeStringMap(
      JSON.parse('{"M":{"__proto__":{"S":"evil"},"tier":{"S":"gold"}}}'),
    );

    const value = Result.isSuccess(decoded) ? decoded.success : {};

    expect(Object.keys(value)).toStrictEqual(["__proto__", "tier"]);
    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
    // The decisive half: the key stayed data instead of becoming the object's prototype.
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});

describe("stored contact items", () => {
  it("round trips a contact through the writer and the reader", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const stored = yield* decodeContactItem(contactItem(contact));

        expect(stored).toMatchObject({
          v: recordVersion,
          id: contactId,
          email: "max@example.com",
          name: "Max",
          attributes: { tier: "gold" },
          createdAt,
        });
      }),
    ));

  it("omits an optional field the writer never wrote rather than reading it as undefined", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const item = contactItem({ id: contactId, email: "max@example.com", createdAt });

        const stored = yield* decodeContactItem(item);

        expect("name" in stored).toBe(false);
        expect("attributes" in stored).toBe(false);
      }),
    ));

  it("ignores the key and index attributes that travel on the same item", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const item = contactItem(contact);

        expect(item["pk"]).toBeDefined();
        expect(item["gsi1pk"]).toBeDefined();
        expect((yield* decodeContactItem(item)).id).toBe(contactId);
      }),
    ));

  it.each([
    ["a malformed optional value", { name: { N: "7" } }],
    ["a malformed required value", { email: { N: "7" } }],
    ["an address that is not one", { email: { S: "not-an-address" } }],
    ["a version this code cannot read", { v: { N: "99" } }],
  ])("refuses an item carrying %s", (_label, overrides) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const item = { ...contactItem(contact), ...overrides };

        expect(Result.isFailure(yield* Effect.result(decodeContactItem(item)))).toBe(true);
      }),
    ),
  );

  it("refuses an item missing a required attribute", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { createdAt: _absent, ...item } = contactItem(contact);

        expect(Result.isFailure(yield* Effect.result(decodeContactItem(item)))).toBe(true);
      }),
    ));
});
