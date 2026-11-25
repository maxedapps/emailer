import { describe, expect, it } from "@effect/vitest";

import { migrationOf } from "./MigrateRejoined.ts";

describe("MigrateRejoined", () => {
  it("takes the rejoined lists out of the opt-outs and drops rejoined", () => {
    const key = { pk: { S: "ADDRESS#sam@example.com" }, sk: { S: "ADDRESS" } };

    expect(migrationOf({ ...key, rejoined: { SS: ["list-a", "list-b"] } })).toStrictEqual({
      Key: key,
      UpdateExpression: "DELETE optOuts :rejoined REMOVE rejoined",
      ExpressionAttributeValues: { ":rejoined": { SS: ["list-a", "list-b"] } },
    });
  });
});
