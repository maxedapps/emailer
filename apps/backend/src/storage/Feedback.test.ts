import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { feedbackWrites } from "./Feedback.ts";
import { tableLogicalId } from "./Items.ts";
import { campaignId, cancelled, createdAt, primitivesFor, scriptedTable } from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { FeedbackRow, FeedbackWrite } from "./Feedback.ts";

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

const count = (counter: "bounced" | "complained"): FeedbackWrite => ({
  effect: "count",
  counter,
});

const transient: FeedbackWrite = { effect: "transient" };

const history: FeedbackWrite = { effect: "history" };

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

const transientUpdate = {
  Update: {
    Table: tableLogicalId,
    Key: { pk: { S: `SUPPRESSION#${mailbox}` }, sk: { S: "TRANSIENT" } },
    UpdateExpression: "SET v = if_not_exists(v, :v) ADD occurrences :set",
    ExpressionAttributeValues: {
      ":v": { N: "1" },
      ":set": { SS: [`${createdAt}#${feedbackId}`] },
    },
  },
};

describe("recordFeedback", () => {
  it.effect("puts the history row and adds the bounced counter on META for a count write", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      expect(yield* operationsFor(table).recordFeedback(bounceRow, count("bounced"))).toBe(
        "committed",
      );

      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        historyPut("bounce", "suppressed", {
          bounceType: { S: "Permanent" },
          bounceSubType: { S: "General" },
        }),
        counterUpdate("bounced"),
      ]);
    }),
  );

  it.effect("adds the complained counter for a complaint count write", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      expect(yield* operationsFor(table).recordFeedback(complaintRow, count("complained"))).toBe(
        "committed",
      );

      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        historyPut("complaint", "suppressed", { complaintFeedbackType: { S: "abuse" } }),
        counterUpdate("complained"),
      ]);
    }),
  );

  it.effect(
    "writes the history row alone for a history write and copies the outcome it was given",
    () =>
      Effect.gen(function* () {
        const table = scriptedTable({});

        expect(
          yield* operationsFor(table).recordFeedback(
            {
              ...complaintRow,
              outcome: "recorded",
              complaintFeedbackType: "not-spam",
              complaintSubType: "OnAccountSuppressionList",
            },
            history,
          ),
        ).toBe("committed");

        expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
          historyPut("complaint", "recorded", {
            complaintFeedbackType: { S: "not-spam" },
            complaintSubType: { S: "OnAccountSuppressionList" },
          }),
        ]);
      }),
  );

  it.effect("sets v, adds a string-set occurrence and touches no META for a transient write", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      expect(
        yield* operationsFor(table).recordFeedback(
          { ...bounceRow, outcome: "recorded", bounceType: "Transient" },
          transient,
        ),
      ).toBe("committed");

      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        historyPut("bounce", "recorded", {
          bounceType: { S: "Transient" },
          bounceSubType: { S: "General" },
        }),
        transientUpdate,
      ]);
    }),
  );

  it.effect("omits every provider field that is undefined", () =>
    Effect.gen(function* () {
      const table = scriptedTable({});

      yield* operationsFor(table).recordFeedback(
        { ...bounceRow, bounceSubType: undefined },
        count("bounced"),
      );

      expect(table.transactionRequests[0]?.TransactItems[0]).toStrictEqual(
        historyPut("bounce", "suppressed", { bounceType: { S: "Permanent" } }),
      );
    }),
  );

  it.effect("reports a duplicate from a condition failure on the history row", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
      });

      expect(yield* operationsFor(table).recordFeedback(bounceRow, count("bounced"))).toBe(
        "duplicate",
      );
    }),
  );

  it.effect("reports a duplicate for a history write whose only item already exists", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        transactWriteItems: [cancelled("ConditionalCheckFailed")],
      });

      expect(yield* operationsFor(table).recordFeedback(bounceRow, history)).toBe("duplicate");
    }),
  );

  it.effect("reports an unknown campaign from a condition failure on META", () =>
    Effect.gen(function* () {
      const table = scriptedTable({
        transactWriteItems: [cancelled("None", "ConditionalCheckFailed")],
      });

      expect(yield* operationsFor(table).recordFeedback(complaintRow, count("complained"))).toBe(
        "unknown-campaign",
      );
    }),
  );
});
