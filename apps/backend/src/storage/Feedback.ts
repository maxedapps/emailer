import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { CampaignNotFound } from "@emailer/api/Errors";
import { Context, Crypto, Data, Effect, Layer, Schema } from "effect";

import { suppressionWrites, transientKey } from "./Addresses.ts";
import {
  campaignKey,
  itemWriter,
  num,
  recordVersion,
  str,
  strSet,
  tableLogicalId,
} from "./Items.ts";
import { transactionPrimitives, writePrimitives } from "./Primitives.ts";
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
  outcome: FeedbackOutcome,
  receivedAt: Schemas.Timestamp,
  bounceType: Schema.optional(Schema.String),
  bounceSubType: Schema.optional(Schema.String),
  complaintFeedbackType: Schema.optional(Schema.String),
  complaintSubType: Schema.optional(Schema.String),
});

export type FeedbackRow = typeof FeedbackRow.Type;

const writeRow = itemWriter(FeedbackRow);

/**
 * What the row changes beside itself: a campaign counter, the recipient's transient-bounce window,
 * or nothing. The consumer's classification chooses; the store only knows the three shapes.
 */
export type FeedbackWrite =
  | { readonly effect: "count"; readonly counter: "bounced" | "complained" }
  | { readonly effect: "transient" }
  | { readonly effect: "history" };

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

const addCampaignCounter = (campaignId: string, counter: "bounced" | "complained") => ({
  Update: {
    Table: tableLogicalId,
    Key: campaignKey(campaignId),
    UpdateExpression: `ADD ${counter} :one`,
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":one": num(1) },
  },
  refused: () => new CampaignNotFound(),
});

const addTransientOccurrence = (row: FeedbackRow) => ({
  Update: {
    Table: tableLogicalId,
    Key: transientKey(row.recipient),
    UpdateExpression: "SET v = if_not_exists(v, :v) ADD occurrences :set",
    ExpressionAttributeValues: {
      ":v": num(recordVersion),
      ":set": strSet([`${row.receivedAt}#${row.feedbackId}`]),
    },
  },
});

const sideEffectOf = (row: FeedbackRow, write: FeedbackWrite) => {
  switch (write.effect) {
    case "count":
      return [addCampaignCounter(row.campaignId, write.counter)];
    case "transient":
      return [addTransientOccurrence(row)];
    case "history":
      return [];
  }
};

export const feedbackWrites = (primitives: TransactionPrimitives) => {
  const { transact } = primitives;

  /**
   * One transaction per recipient: the history row, conditioned on not existing, plus whatever the
   * write adds. A redelivered event fails the row's condition and the whole transaction with it, so
   * a counter is never added twice and a window entry is never re-added. The row comes first, so a
   * redelivery is `FeedbackAlreadyRecorded` even when the campaign has gone since.
   */
  const recordFeedback = Effect.fn("Storage.recordFeedback")(function* (
    row: FeedbackRow,
    write: FeedbackWrite,
  ) {
    yield* transact("recordFeedback", [yield* putHistory(row), ...sideEffectOf(row, write)]);
  });

  return { recordFeedback } as const;
};

/**
 * What the SES event consumer persists: a conditional suppression for the address, and a
 * transaction that writes the event's history row together with the campaign counter or the
 * transient window. Suppression stays a single conditional Put; history and counters share
 * `TransactWriteItems`.
 */
const feedbackStoreOperations = (
  operations: Pick<TableOperations, "putItem" | "transactWriteItems">,
  tokens: TransactionTokens,
) => {
  const writes = writePrimitives(operations);
  const transactions = transactionPrimitives(operations, tokens);

  return { ...suppressionWrites(writes), ...feedbackWrites(transactions) } as const;
};

export type FeedbackStoreOperations = ReturnType<typeof feedbackStoreOperations>;

export class FeedbackStore extends Context.Service<FeedbackStore, FeedbackStoreOperations>()(
  "emailer/backend/FeedbackStore",
) {}

export const FeedbackStoreLive = Layer.effect(FeedbackStore)(
  Effect.gen(function* () {
    const table = yield* dataTable;
    const crypto = yield* Crypto.Crypto;

    return FeedbackStore.of(
      feedbackStoreOperations(
        {
          putItem: yield* AWS.DynamoDB.PutItem(table),
          transactWriteItems: yield* AWS.DynamoDB.TransactWriteItems(table),
        },
        Effect.orDie(crypto.randomUUIDv4),
      ),
    );
  }),
).pipe(
  Layer.provide(Layer.mergeAll(AWS.DynamoDB.PutItemHttp, AWS.DynamoDB.TransactWriteItemsHttp)),
);
