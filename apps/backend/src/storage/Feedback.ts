import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { CampaignNotFound } from "@emailer/api/Errors";
import { Context, Crypto, Data, Effect, Layer, Schema } from "effect";

import { mailboxFeedbackWrites } from "./Addresses.ts";
import { campaignKey, itemWriter, num, str, tableLogicalId } from "./Items.ts";
import { transactionPrimitives, updatePrimitives } from "./Primitives.ts";
import { dataTable } from "./Table.ts";

import type { TableOperations } from "./Items.ts";
import type { TransactionPrimitives, TransactionTokens } from "./Primitives.ts";

const FeedbackOutcome = Schema.Literals(["suppressed", "recorded"]);

export type FeedbackOutcome = typeof FeedbackOutcome.Type;

const feedbackKey = (
  campaignId: string,
  kind: Schemas.SuppressionReason,
  feedbackId: string,
  recipient: string,
) => ({
  pk: str(`CAMPAIGN#${campaignId}`),
  sk: str(`FEEDBACK#${kind}#${feedbackId}#${Schemas.mailboxKey(recipient)}`),
});

/**
 * One event's history row for one recipient, as the consumer classified it. The store copies it;
 * it decides nothing about what the event means.
 */
const FeedbackRow = Schema.Struct({
  campaignId: Schemas.EntityId,
  kind: Schemas.SuppressionReason,
  feedbackId: Schema.String,
  recipient: Schema.String,
  messageId: Schema.String,
  /** The copy the mail was, from its tag; mail sent before copies were tagged has none. */
  variant: Schema.optional(Schema.String),
  outcome: FeedbackOutcome,
  receivedAt: Schemas.Timestamp,
  bounceType: Schema.optional(Schema.String),
  bounceSubType: Schema.optional(Schema.String),
  complaintFeedbackType: Schema.optional(Schema.String),
  complaintSubType: Schema.optional(Schema.String),
});

export type FeedbackRow = typeof FeedbackRow.Type;

const writeRow = itemWriter(FeedbackRow);

/** The campaign counter a history row adds to, when the consumer's classification counts it. */
export type FeedbackCounter = "bounced" | "complained";

/** The event's history row for this recipient is already there: SQS delivered it again. */
export class FeedbackAlreadyRecorded extends Data.TaggedError("FeedbackAlreadyRecorded") {}

const putHistory = (row: FeedbackRow) =>
  Effect.map(writeRow({ ...row, recipient: Schemas.mailboxKey(row.recipient) }), (attributes) => ({
    Put: {
      Table: tableLogicalId,
      Item: {
        ...feedbackKey(row.campaignId, row.kind, row.feedbackId, row.recipient),
        ...attributes,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    },
    refused: () => new FeedbackAlreadyRecorded(),
  }));

const addCampaignCounter = (campaignId: string, counter: FeedbackCounter) => ({
  Update: {
    Table: tableLogicalId,
    Key: campaignKey(campaignId),
    UpdateExpression: `ADD ${counter} :one`,
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":one": num(1) },
  },
  refused: () => new CampaignNotFound(),
});

export const feedbackWrites = (primitives: TransactionPrimitives) => {
  const { transact } = primitives;

  /**
   * One transaction per recipient: the history row, conditioned on not existing, plus the counter
   * it adds to, if any. A redelivered event fails the row's condition and the whole transaction
   * with it, so a counter is never added twice. The row comes first, so a redelivery is
   * `FeedbackAlreadyRecorded` even when the campaign has gone since.
   */
  const recordFeedback = Effect.fn("Storage.recordFeedback")(function* (
    row: FeedbackRow,
    counter: FeedbackCounter | undefined,
  ) {
    const history = yield* putHistory(row);

    yield* transact(
      "recordFeedback",
      counter === undefined ? [history] : [history, addCampaignCounter(row.campaignId, counter)],
    );
  });

  return { recordFeedback } as const;
};

/**
 * What the SES event consumer persists: the mailbox's suppression or transient-window entry, each a
 * single update that holds for every mail, and for a campaign's mail a transaction that writes the
 * event's history row together with the campaign counter.
 */
const feedbackStoreOperations = (
  operations: Pick<TableOperations, "updateItem" | "transactWriteItems">,
  tokens: TransactionTokens,
) => {
  const updates = updatePrimitives(operations);
  const transactions = transactionPrimitives(operations, tokens);

  return { ...mailboxFeedbackWrites(updates), ...feedbackWrites(transactions) } as const;
};

export type FeedbackStoreOperations = ReturnType<typeof feedbackStoreOperations>;

export class FeedbackStore extends Context.Service<FeedbackStore, FeedbackStoreOperations>()(
  "emailer/backend/FeedbackStore",
) {
  static readonly layer = Layer.effect(FeedbackStore)(
    Effect.gen(function* () {
      const table = yield* dataTable;
      const crypto = yield* Crypto.Crypto;

      return FeedbackStore.of(
        feedbackStoreOperations(
          {
            updateItem: yield* AWS.DynamoDB.UpdateItem(table),
            transactWriteItems: yield* AWS.DynamoDB.TransactWriteItems(table),
          },
          Effect.orDie(crypto.randomUUIDv4),
        ),
      );
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(AWS.DynamoDB.UpdateItemHttp, AWS.DynamoDB.TransactWriteItemsHttp)),
  );
}
