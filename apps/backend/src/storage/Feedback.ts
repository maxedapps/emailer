import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Context, Crypto, Effect, Layer } from "effect";

import { suppressionWrites, transientKey } from "./Addresses.ts";
import {
  campaignKey,
  num,
  recordVersion,
  str,
  strSet,
  tableLogicalId,
  withOptional,
} from "./Items.ts";
import { transactionPrimitives, writePrimitives } from "./Primitives.ts";
import { dataTable } from "./Table.ts";

import type { TableOperations } from "./Items.ts";
import type { TransactionPrimitives, TransactionTokens } from "./Primitives.ts";

export type FeedbackKind = "bounce" | "complaint";

export type FeedbackOutcome = "suppressed" | "recorded";

const feedbackKey = (
  campaignId: string,
  kind: FeedbackKind,
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
export interface FeedbackRow {
  readonly campaignId: string;
  readonly kind: FeedbackKind;
  readonly feedbackId: string;
  readonly recipient: string;
  readonly messageId: string;
  readonly outcome: FeedbackOutcome;
  readonly receivedAt: string;
  readonly bounceType?: string | undefined;
  readonly bounceSubType?: string | undefined;
  readonly complaintFeedbackType?: string | undefined;
  readonly complaintSubType?: string | undefined;
}

/**
 * What the row changes beside itself: a campaign counter, the recipient's transient-bounce window,
 * or nothing. The consumer's classification chooses; the store only knows the three shapes.
 */
export type FeedbackWrite =
  | { readonly effect: "count"; readonly counter: "bounced" | "complained" }
  | { readonly effect: "transient" }
  | { readonly effect: "history" };

export type FeedbackWriteOutcome = "committed" | "duplicate" | "unknown-campaign";

const putHistory = (row: FeedbackRow) => ({
  Put: {
    Table: tableLogicalId,
    Item: withOptional(
      {
        ...feedbackKey(row.campaignId, row.kind, row.feedbackId, row.recipient),
        v: num(recordVersion),
        campaignId: str(row.campaignId),
        kind: str(row.kind),
        feedbackId: str(row.feedbackId),
        recipient: str(Schemas.mailboxKey(row.recipient)),
        messageId: str(row.messageId),
        outcome: str(row.outcome),
        receivedAt: str(row.receivedAt),
      },
      [
        ["bounceType", row.bounceType],
        ["bounceSubType", row.bounceSubType],
        ["complaintFeedbackType", row.complaintFeedbackType],
        ["complaintSubType", row.complaintSubType],
      ],
    ),
    ConditionExpression: "attribute_not_exists(pk)",
  },
});

const addCampaignCounter = (campaignId: string, counter: "bounced" | "complained") => ({
  Update: {
    Table: tableLogicalId,
    Key: campaignKey(campaignId),
    UpdateExpression: `ADD ${counter} :one`,
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":one": num(1) },
  },
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

/**
 * The history row is item 0 and carries the only condition that means "already recorded"; the
 * campaign counter, when present, is item 1 and its condition means "no such campaign".
 */
const writeOutcome = (outcome: {
  readonly committed: boolean;
  readonly conditionFailures?: ReadonlySet<number>;
}): FeedbackWriteOutcome => {
  if (outcome.committed) {
    return "committed";
  }

  if (outcome.conditionFailures?.has(0) === true) {
    return "duplicate";
  }

  return "unknown-campaign";
};

export const feedbackWrites = (primitives: TransactionPrimitives) => {
  const { runTransaction } = primitives;

  /**
   * One transaction per recipient: the history row, conditioned on not existing, plus whatever the
   * write adds. A redelivered event fails the row's condition and the whole transaction with it, so
   * a counter is never added twice and a window entry is never re-added.
   */
  const recordFeedback = Effect.fn("Storage.recordFeedback")(function* (
    row: FeedbackRow,
    write: FeedbackWrite,
  ) {
    const outcome = yield* runTransaction("recordFeedback", {
      TransactItems: [putHistory(row), ...sideEffectOf(row, write)],
    });

    return writeOutcome(outcome);
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
