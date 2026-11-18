import * as Errors from "@emailer/api/Errors";
import { Effect, Predicate } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { FeedbackAlreadyRecorded, feedbackWrites, openWrites, SendNotFound } from "./Feedback.ts";
import { tableLogicalId } from "./Items.ts";
import {
  campaignId,
  cancelled,
  contactId,
  createdAt,
  defectOf,
  primitivesFor,
  scriptedTable,
  succeeded,
} from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { FeedbackRow } from "./Feedback.ts";

const operationsFor = (table: Table) => feedbackWrites(primitivesFor(table));

const feedbackId = "0100019a-6c6f-4a39-8f12-0b2f9c3d4e5f";

const recipient = "User@Example.com";

const mailbox = "user@example.com";

const bounceRow: FeedbackRow = {
  campaignId,
  kind: "bounce",
  feedbackId,
  recipient,
  messageId: "0100019",
  outcome: "suppressed",
  receivedAt: createdAt,
  bounceType: "Permanent",
  bounceSubType: "General",
};

const complaintRow: FeedbackRow = {
  campaignId,
  kind: "complaint",
  feedbackId,
  recipient,
  messageId: "0100019",
  outcome: "suppressed",
  receivedAt: createdAt,
  complaintFeedbackType: "abuse",
};

const historyPut = (
  kind: "bounce" | "complaint",
  outcome: "suppressed" | "recorded",
  extras: Record<string, { readonly S: string }>,
) => ({
  Put: {
    Table: tableLogicalId,
    Item: {
      pk: { S: `CAMPAIGN#${campaignId}` },
      sk: { S: `FEEDBACK#${kind}#${feedbackId}#${mailbox}` },
      v: { N: "1" },
      campaignId: { S: campaignId },
      kind: { S: kind },
      feedbackId: { S: feedbackId },
      recipient: { S: mailbox },
      messageId: { S: "0100019" },
      outcome: { S: outcome },
      receivedAt: { S: createdAt },
      ...extras,
    },
    ConditionExpression: "attribute_not_exists(pk)",
  },
});

const counterUpdate = (counter: "bounced" | "complained") => ({
  Update: {
    Table: tableLogicalId,
    Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
    UpdateExpression: `ADD ${counter} :one`,
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":one": { N: "1" } },
  },
});

describe("recordFeedback", () => {
  it.effect("puts the history row and adds the bounced counter on META", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ transactWriteItems: [succeeded] });

      yield* operationsFor(table).recordFeedback(bounceRow, "bounced");

      expect(table.transactionRequests).toHaveLength(1);
      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        historyPut("bounce", "suppressed", {
          bounceType: { S: "Permanent" },
          bounceSubType: { S: "General" },
        }),
        counterUpdate("bounced"),
      ]);
    }),
  );

  it.effect("adds the complained counter for a complaint", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ transactWriteItems: [succeeded] });

      yield* operationsFor(table).recordFeedback(complaintRow, "complained");

      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        historyPut("complaint", "suppressed", { complaintFeedbackType: { S: "abuse" } }),
        counterUpdate("complained"),
      ]);
    }),
  );

  it.effect(
    "writes the history row alone without a counter and copies the outcome it was given",
    () =>
      Effect.gen(function* () {
        const table = scriptedTable({ transactWriteItems: [succeeded] });

        yield* operationsFor(table).recordFeedback(
          {
            ...complaintRow,
            outcome: "recorded",
            complaintFeedbackType: "not-spam",
            complaintSubType: "OnAccountSuppressionList",
          },
          undefined,
        );

        expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
          historyPut("complaint", "recorded", {
            complaintFeedbackType: { S: "not-spam" },
            complaintSubType: { S: "OnAccountSuppressionList" },
          }),
        ]);
      }),
  );

  it.effect("omits every provider field that is undefined", () =>
    Effect.gen(function* () {
      const table = scriptedTable({ transactWriteItems: [succeeded] });

      yield* operationsFor(table).recordFeedback(
        { ...bounceRow, bounceSubType: undefined },
        "bounced",
      );

      expect(table.transactionRequests[0]?.TransactItems[0]).toStrictEqual(
        historyPut("bounce", "suppressed", { bounceType: { S: "Permanent" } }),
      );
    }),
  );

  it.effect("answers FeedbackAlreadyRecorded from a condition failure on the history row", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
      });

      expect(
        yield* Effect.flip(operationsFor(table).recordFeedback(bounceRow, "bounced")),
      ).toStrictEqual(new FeedbackAlreadyRecorded());
    }),
  );

  it.effect("answers FeedbackAlreadyRecorded for an uncounted row that already exists", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        transactWriteItems: [cancelled("ConditionalCheckFailed")],
      });

      expect(
        yield* Effect.flip(operationsFor(table).recordFeedback(bounceRow, undefined)),
      ).toStrictEqual(new FeedbackAlreadyRecorded());
    }),
  );

  it.effect("answers CampaignNotFound from a condition failure on META", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        transactWriteItems: [cancelled("None", "ConditionalCheckFailed")],
      });

      expect(
        yield* Effect.flip(operationsFor(table).recordFeedback(complaintRow, "complained")),
      ).toStrictEqual(new Errors.CampaignNotFound());
    }),
  );
});

describe("recordOpen", () => {
  const sendId = "0195f0a0-1111-4222-8333-44444444e5d1";
  const eventId = "4c1f1e0e-6a7e-4d0a-9b8c-2f3e4d5c6b7a";
  const openedAt = "2026-09-11T10:05:00.000Z";
  const open = { campaignId, contactId, sendId, eventId, openedAt };
  const sendRowKey = { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: `SEND#${contactId}` } };

  const sendRow = (opened: Record<string, { readonly S: string } | { readonly N: string }> = {}) =>
    Effect.succeed({
      Item: {
        ...sendRowKey,
        v: { N: "1" },
        sendId: { S: sendId },
        variant: { S: "half" },
        ...opened,
      },
    });

  const recordOpen = (table: Table) => openWrites(primitivesFor(table)).recordOpen(open);

  const counterUpdate = (first: 0 | 1) => ({
    Update: {
      Table: tableLogicalId,
      Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "OPENS#half" } },
      UpdateExpression: "SET v = :v ADD #total :one, #unique :first",
      ExpressionAttributeNames: { "#total": "total", "#unique": "unique" },
      ExpressionAttributeValues: {
        ":v": { N: "1" },
        ":one": { N: "1" },
        ":first": { N: String(first) },
      },
    },
  });

  it.effect(
    "records a first open on the send row and counts it once and uniquely for its copy",
    () =>
      Effect.gen(function* () {
        const table = scriptedTable({ getItem: [sendRow()], transactWriteItems: [succeeded] });

        expect(yield* recordOpen(table)).toBe("first");
        expect(table.getItemRequests).toStrictEqual([{ Key: sendRowKey, ConsistentRead: true }]);
        expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
          {
            Update: {
              Table: tableLogicalId,
              Key: sendRowKey,
              UpdateExpression: "SET openedAt = :openedAt, opens = :opens, lastOpen = :event",
              ConditionExpression: "sendId = :sendId AND attribute_not_exists(opens)",
              ExpressionAttributeValues: {
                ":openedAt": { S: openedAt },
                ":opens": { N: "1" },
                ":event": { S: eventId },
                ":sendId": { S: sendId },
              },
            },
          },
          counterUpdate(1),
        ]);
      }),
  );

  it.effect("counts a later open in the total only and keeps the earlier first open", () =>
    Effect.gen(function* () {
      const earlier = "2026-09-11T10:01:00.000Z";

      const table = scriptedTable({
        getItem: [
          sendRow({ openedAt: { S: earlier }, opens: { N: "2" }, lastOpen: { S: "other" } }),
        ],
        transactWriteItems: [succeeded],
      });

      expect(yield* recordOpen(table)).toBe("again");

      const [row, counter] = table.transactionRequests[0]?.TransactItems ?? [];

      expect(row?.Update?.ConditionExpression).toBe("sendId = :sendId AND opens = :read");
      expect(row?.Update?.ExpressionAttributeValues).toMatchObject({
        ":openedAt": { S: earlier },
        ":opens": { N: "3" },
        ":read": { N: "2" },
      });
      expect(counter).toStrictEqual(counterUpdate(0));
    }),
  );

  it.effect("takes an open that arrives after a later one as the first open", () =>
    Effect.gen(function* () {
      const later = "2026-09-11T11:00:00.000Z";

      const table = scriptedTable({
        getItem: [sendRow({ openedAt: { S: later }, opens: { N: "1" }, lastOpen: { S: "other" } })],
        transactWriteItems: [succeeded],
      });

      yield* recordOpen(table);

      expect(
        table.transactionRequests[0]?.TransactItems[0]?.Update?.ExpressionAttributeValues?.[
          ":openedAt"
        ],
      ).toStrictEqual({ S: openedAt });
    }),
  );

  it.effect("writes nothing for a redelivered event", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [
          sendRow({ openedAt: { S: openedAt }, opens: { N: "1" }, lastOpen: { S: eventId } }),
        ],
      });

      expect(yield* recordOpen(table)).toBe("repeated");
      expect(table.transactionRequests).toHaveLength(0);
    }),
  );

  it.effect("answers SendNotFound for a missing send row or one of another send", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [
          Effect.succeed({}),
          sendRow({ sendId: { S: "0195f0a0-1111-4222-8333-44444444e5d9" } }),
        ],
      });

      expect(yield* Effect.flip(recordOpen(table))).toStrictEqual(new SendNotFound());
      expect(yield* Effect.flip(recordOpen(table))).toStrictEqual(new SendNotFound());
      expect(table.transactionRequests).toHaveLength(0);
    }),
  );

  it.effect("reads the row again when another open of the same mail landed in between", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        getItem: [
          sendRow(),
          sendRow({ openedAt: { S: openedAt }, opens: { N: "1" }, lastOpen: { S: "other" } }),
        ],
        transactWriteItems: [cancelled("ConditionalCheckFailed", "None"), succeeded],
      });

      expect(yield* recordOpen(table)).toBe("again");
      expect(table.transactionRequests[1]?.TransactItems[1]).toStrictEqual(counterUpdate(0));
    }),
  );

  it.effect("dies when the row keeps changing under every retry", () =>
    Effect.gen(function* () {
      const raced = cancelled("ConditionalCheckFailed", "None");

      const table = scriptedTable({
        getItem: [sendRow(), sendRow(), sendRow(), sendRow()],
        transactWriteItems: [raced, raced, raced, raced],
      });

      expect(Predicate.isTagged(yield* defectOf(recordOpen(table)), "OpenRaced")).toBe(true);
      expect(table.transactionRequests).toHaveLength(4);
    }),
  );
});
