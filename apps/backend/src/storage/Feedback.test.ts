import * as Errors from "@emailer/api/Errors";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { FeedbackAlreadyRecorded, feedbackWrites } from "./Feedback.ts";
import { tableLogicalId } from "./Items.ts";
import {
  campaignId,
  cancelled,
  createdAt,
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
