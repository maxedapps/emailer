import { describe, expect, it } from "@effect/vitest";

import { holds, mergeOf, oldKeyOf } from "./MigrateAddressItems.ts";

import type { OldRow } from "./MigrateAddressItems.ts";

const mailbox = "user@example.com";

const key = { pk: { S: `ADDRESS#${mailbox}` }, sk: { S: "ADDRESS" } };

const stamp = "v = if_not_exists(v, :v), email = if_not_exists(email, :email)";

const stampValues = { ":v": { N: "1" }, ":email": { S: mailbox } };

const optOut: OldRow = {
  kind: "unsubscribe",
  mailbox,
  unsubscribedAt: "2026-09-11T10:00:00.000Z",
};

const suppression: OldRow = {
  kind: "suppression",
  mailbox,
  suppression: { reason: "bounce", suppressedAt: "2026-09-11T10:00:00.000Z" },
};

const transient: OldRow = { kind: "transient", mailbox, bounces: ["a#1", "b#2"] };

describe("mergeOf", () => {
  it("keeps an opt-out the address item already holds, stamping version and mailbox", () => {
    expect(mergeOf(optOut)).toStrictEqual({
      Key: key,
      UpdateExpression: `SET ${stamp}, unsubscribedAt = if_not_exists(unsubscribedAt, :at)`,
      ExpressionAttributeValues: { ...stampValues, ":at": { S: "2026-09-11T10:00:00.000Z" } },
    });
  });

  it("keeps a suppression the address item already holds", () => {
    expect(mergeOf(suppression)).toStrictEqual({
      Key: key,
      UpdateExpression: `SET ${stamp}, suppression = if_not_exists(suppression, :s)`,
      ExpressionAttributeValues: {
        ...stampValues,
        ":s": { M: { reason: { S: "bounce" }, suppressedAt: { S: "2026-09-11T10:00:00.000Z" } } },
      },
    });
  });

  it("adds transient bounces to those the address item holds", () => {
    expect(mergeOf(transient)).toStrictEqual({
      Key: key,
      UpdateExpression: `SET ${stamp} ADD transientBounces :bounces`,
      ExpressionAttributeValues: { ...stampValues, ":bounces": { SS: ["a#1", "b#2"] } },
    });
  });
});

describe("holds", () => {
  it.each([
    ["an opt-out", optOut, { unsubscribedAt: "any" }],
    ["a suppression", suppression, { suppression: {} }],
    ["every bounce, among others", transient, { transientBounces: ["a#1", "b#2", "c#3"] }],
  ] as const)("finds %s merged", (_label, row, facts) => {
    expect(holds(row, facts)).toBe(true);
  });

  it.each([
    ["an opt-out on a missing item", optOut, undefined],
    ["an opt-out the item lacks", optOut, { suppression: {} }],
    ["a suppression the item lacks", suppression, { unsubscribedAt: "any" }],
    ["a bounce the item lacks", transient, { transientBounces: ["a#1"] }],
  ] as const)("reports %s as not merged", (_label, row, facts) => {
    expect(holds(row, facts)).toBe(false);
  });
});

describe("oldKeyOf", () => {
  it("names each old row by the key it was written under", () => {
    expect(oldKeyOf(optOut)).toStrictEqual({
      pk: { S: `UNSUBSCRIBE#${mailbox}` },
      sk: { S: "UNSUBSCRIBE" },
    });
    expect(oldKeyOf(suppression)).toStrictEqual({
      pk: { S: `SUPPRESSION#${mailbox}` },
      sk: { S: "SUPPRESSION" },
    });
    expect(oldKeyOf(transient)).toStrictEqual({
      pk: { S: `SUPPRESSION#${mailbox}` },
      sk: { S: "TRANSIENT" },
    });
  });
});
