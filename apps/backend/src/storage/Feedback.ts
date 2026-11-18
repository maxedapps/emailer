import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "@alchemy.run/aws";
import { CampaignNotFound } from "@emailer/api/Errors";
import { Context, Data, Effect, Layer, Predicate, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { mailboxFeedbackWrites } from "./Addresses.ts";
import {
  campaignKey,
  itemReader,
  itemWriter,
  num,
  opensKey,
  recordVersion,
  sendKey,
  str,
  tableLogicalId,
} from "./Items.ts";
import { readPrimitives, transactionPrimitives, updatePrimitives } from "./Primitives.ts";
import { dataTable } from "./Table.ts";

import type { TableOperations } from "./Items.ts";
import type { ReadPrimitives, TransactionPrimitives, TransactionTokens } from "./Primitives.ts";

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

/** An open of one campaign mail, as its tags and its event name it. */
export interface Open {
  readonly campaignId: string;
  readonly contactId: string;
  readonly sendId: string;
  /** The EventBridge event's ID, which a redelivery repeats. */
  readonly eventId: string;
  readonly openedAt: string;
}

/** The send row an open names is not there, or belongs to another send. */
export class SendNotFound extends Data.TaggedError("SendNotFound") {}

/** Another open of the same mail was recorded since the row was read. */
class OpenRaced extends Data.TaggedError("OpenRaced") {}

/** What an open reads of its send row; the row's other attributes are the campaign store's. */
const readOpenedRow = itemReader(
  Schema.Struct({
    sendId: Schemas.EntityId,
    variant: Schemas.CopyKey,
    openedAt: Schema.optionalKey(Schemas.Timestamp),
    opens: Schema.optionalKey(Schema.Int),
    lastOpen: Schema.optionalKey(Schema.String),
  }),
);

/** `TOTAL` and `UNIQUE` are DynamoDB reserved words. */
const counterNames = { "#total": "total", "#unique": "unique" };

export const openWrites = (primitives: ReadPrimitives & TransactionPrimitives) => {
  const { readItem, transact } = primitives;

  /**
   * Records one open on the recipient's send row and on its copy's counters (ADR-0042): a strongly
   * consistent read of the row, then one transaction that updates it, conditioned on what was read,
   * and adds to the counters. The row keeps the earliest open's time, the count and the last
   * event's ID, so a redelivery of that event writes nothing. An open recorded in between fails the
   * condition, and the open is read again.
   */
  const recordOpen = Effect.fn("Storage.recordOpen")(
    function* (open: Open) {
      const key = sendKey(open.campaignId, open.contactId);
      const response = yield* readItem("recordOpen", key);

      if (response.Item === undefined) {
        return yield* new SendNotFound();
      }

      const row = yield* readOpenedRow("recordOpen", response.Item);

      if (row.sendId !== open.sendId) {
        return yield* new SendNotFound();
      }

      if (row.lastOpen === open.eventId) {
        return "repeated" as const;
      }

      const first = row.opens === undefined;

      const unchanged =
        row.opens === undefined
          ? { expression: "attribute_not_exists(opens)", values: {} }
          : { expression: "opens = :read", values: { ":read": num(row.opens) } };

      const openedAt =
        row.openedAt !== undefined && row.openedAt < open.openedAt ? row.openedAt : open.openedAt;

      yield* transact("recordOpen", [
        {
          Update: {
            Table: tableLogicalId,
            Key: key,
            UpdateExpression: "SET openedAt = :openedAt, opens = :opens, lastOpen = :event",
            ConditionExpression: `sendId = :sendId AND ${unchanged.expression}`,
            ExpressionAttributeValues: {
              ":openedAt": str(openedAt),
              ":opens": num((row.opens ?? 0) + 1),
              ":event": str(open.eventId),
              ":sendId": str(open.sendId),
              ...unchanged.values,
            },
          },
          refused: () => new OpenRaced(),
        },
        {
          Update: {
            Table: tableLogicalId,
            Key: opensKey(open.campaignId, row.variant),
            UpdateExpression: "SET v = :v ADD #total :one, #unique :first",
            ExpressionAttributeNames: counterNames,
            ExpressionAttributeValues: {
              ":v": num(recordVersion),
              ":one": num(1),
              ":first": num(first ? 1 : 0),
            },
          },
        },
      ]);

      return first ? ("first" as const) : ("again" as const);
    },
    // Each round needs another open of the same mail to land in between, so running out is a defect.
    (record) =>
      Effect.retry(record, { times: 3, while: Predicate.isTagged("OpenRaced") }).pipe(
        Effect.catchTag("OpenRaced", (raced) => Effect.die(raced)),
      ),
  );

  return { recordOpen } as const;
};

/**
 * What the SES event consumer persists: the mailbox's suppression or transient-window entry, each a
 * single update that holds for every mail, and for a campaign's mail a transaction that writes the
 * event's history row together with the campaign counter; and each open of a campaign's mail.
 */
const feedbackStoreOperations = (
  operations: Pick<TableOperations, "getItem" | "updateItem" | "transactWriteItems">,
  tokens: TransactionTokens,
) => {
  const updates = updatePrimitives(operations);
  const transactions = transactionPrimitives(operations, tokens);

  return {
    ...mailboxFeedbackWrites(updates),
    ...feedbackWrites(transactions),
    ...openWrites({ ...readPrimitives(operations), ...transactions }),
  } as const;
};

export type FeedbackStoreOperations = ReturnType<typeof feedbackStoreOperations>;

export class FeedbackStore extends Context.Service<FeedbackStore, FeedbackStoreOperations>()(
  "emailer/backend/FeedbackStore",
) {
  static readonly layer = Layer.effect(FeedbackStore)(
    Effect.gen(function* () {
      const table = yield* dataTable;
      const random = yield* SecureRandom.SecureRandom;

      return FeedbackStore.of(
        feedbackStoreOperations(
          {
            getItem: yield* AWS.DynamoDB.GetItem(table),
            updateItem: yield* AWS.DynamoDB.UpdateItem(table),
            transactWriteItems: yield* AWS.DynamoDB.TransactWriteItems(table),
          },
          random.uuidV4(),
        ),
      );
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AWS.DynamoDB.GetItemHttp,
        AWS.DynamoDB.UpdateItemHttp,
        AWS.DynamoDB.TransactWriteItemsHttp,
      ),
    ),
  );
}
