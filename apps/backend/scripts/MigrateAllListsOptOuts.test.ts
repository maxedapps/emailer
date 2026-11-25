import { describe, expect, it } from "@effect/vitest";

import { leftBeforePerList, mayHaveRejoined, migrationOf } from "./MigrateAllListsOptOuts.ts";

describe("MigrateAllListsOptOuts", () => {
  it("marks the address item as having left every list", () => {
    const key = { pk: { S: "ADDRESS#sam@example.com" }, sk: { S: "ADDRESS" } };

    expect(migrationOf({ ...key, optOuts: { SS: ["list-a"] } })).toStrictEqual({
      Key: key,
      UpdateExpression: "SET leftAllLists = :left",
      ExpressionAttributeValues: { ":left": { BOOL: true } },
    });
  });

  it.each([
    ["a list that predates the per-list rule", ["list-old"], true],
    ["a list that is gone", ["list-deleted"], true],
    ["only lists created since", ["list-new"], false],
    ["a list created since and an older one", ["list-new", "list-old"], true],
  ] as const)("counts an opt-out from %s", (_label, optOuts, expected) => {
    expect(leftBeforePerList(optOuts, new Set(["list-new"]))).toBe(expected);
  });

  it.each([
    [
      "consent to an older list since the deploy",
      "list-old",
      "2026-11-25T09:00:00.000Z",
      "consent",
      true,
    ],
    ["consent before the deploy", "list-old", "2026-11-24T09:00:00.000Z", "consent", false],
    ["consent to a list created since", "list-new", "2026-11-25T09:00:00.000Z", "consent", false],
    [
      "an existing customer since the deploy",
      "list-old",
      "2026-11-25T09:00:00.000Z",
      "existingCustomer",
      false,
    ],
  ] as const)("counts %s as a possible rejoin: %s", (_label, listId, joinedAt, basis, expected) => {
    expect(mayHaveRejoined({ listId, joinedAt, basis }, new Set(["list-new"]))).toBe(expected);
  });
});
