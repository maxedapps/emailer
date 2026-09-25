import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { decodeCsvContacts } from "./CsvContacts.ts";

const failureOf = (text: string) =>
  Effect.map(Effect.flip(decodeCsvContacts(text)), (error) => error.message);

describe("reading a CSV export as an import file", () => {
  it.effect("matches email and name in any case and takes other columns as attributes", () =>
    Effect.gen(function* () {
      expect(yield* decodeCsvContacts("EMAIL,Name,plan\nada@example.com,Ada,pro\n")).toStrictEqual({
        contacts: [{ email: "ada@example.com", name: "Ada", attributes: { plan: "pro" } }],
      });
    }),
  );

  it.effect("reads a quoted field holding a comma and a line break as one value", () =>
    Effect.gen(function* () {
      const file = yield* decodeCsvContacts(
        'email,note\nada@example.com,"likes, commas\nand lines"\n',
      );

      expect(file.contacts[0]?.attributes).toStrictEqual({ note: "likes, commas\nand lines" });
    }),
  );

  it.effect("finds the email column behind a byte-order mark", () =>
    Effect.gen(function* () {
      expect(yield* decodeCsvContacts("﻿email\nada@example.com\n")).toStrictEqual({
        contacts: [{ email: "ada@example.com" }],
      });
    }),
  );

  it.effect("leaves empty cells out rather than importing empty values", () =>
    Effect.gen(function* () {
      expect(yield* decodeCsvContacts("email,name,plan\nada@example.com,,\n")).toStrictEqual({
        contacts: [{ email: "ada@example.com" }],
      });
    }),
  );

  it.effect("skips blank lines", () =>
    Effect.gen(function* () {
      const file = yield* decodeCsvContacts("email\n\nada@example.com\n\ngrace@example.com\n");

      expect(file.contacts).toHaveLength(2);
    }),
  );

  it.effect("rejects a header without an email column", () =>
    Effect.gen(function* () {
      expect(yield* failureOf("name\nAda\n")).toBe("The header has no email column");
    }),
  );

  it.effect("rejects a column named twice, counting email in any case as one", () =>
    Effect.gen(function* () {
      expect(yield* failureOf("email,Email\nada@example.com,ada@example.com\n")).toBe(
        'The column "email" appears twice',
      );
    }),
  );

  it.effect("names the line of a row that fails an entry's checks", () =>
    Effect.gen(function* () {
      expect(yield* failureOf("email\nada@example.com\nnot-an-address\n")).toMatch(/^line 3: /);
    }),
  );

  it.effect("rejects one mailbox on two rows", () =>
    Effect.gen(function* () {
      expect(yield* failureOf("email\nAda@example.com\nada@EXAMPLE.com\n")).toContain(
        "Expected each address to appear at most once",
      );
    }),
  );
});
