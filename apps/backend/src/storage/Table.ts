import { RemovalPolicy, Stack } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Effect, Layer } from "effect";

import { listingIndexName, tableLogicalId } from "./Items.ts";

import type { TableOperations } from "./Items.ts";

/**
 * The table itself. Capabilities are declared beside the items they own — `Audience.ts`,
 * `Campaigns.ts`, `Feedback.ts`, `RateLimit.ts` and `Unsubscribe.ts` — so that each binds only the
 * DynamoDB operations it actually performs. Alchemy registers IAM while a binding is constructed,
 * so a single shared service would hand every consumer every permission.
 *
 * Stage `prod` retains it on destroy: it holds every opt-out and suppression, and losing them would
 * make re-imported contacts mailable again. Every other stage deletes it with the stage.
 */
export const dataTable = AWS.DynamoDB.Table(tableLogicalId, {
  partitionKey: "pk",
  sortKey: "sk",
  attributes: { pk: "S", sk: "S", gsi1pk: "S", gsi1sk: "S" },
  billingMode: "PAY_PER_REQUEST",
  // Pending sign-ups expire through it, at no cost. Its own attribute, in epoch seconds: the rate
  // limiter's `expiresAt` is in milliseconds, which TTL would read as a date far in the future.
  timeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
  globalSecondaryIndexes: [
    {
      indexName: listingIndexName,
      partitionKey: "gsi1pk",
      sortKey: "gsi1sk",
      // KEYS_ONLY, and effectively permanent: the provider compares projections and a change
      // replaces the table. Hydrating through a strongly-consistent BatchGetItem is also
      // self-correcting, where a served projection of an eventually consistent index is not.
      projection: { ProjectionType: "KEYS_ONLY" },
    },
  ],
}).pipe(RemovalPolicy.retain(Effect.map(Stack, ({ stage }) => stage === "prod")));

/**
 * All six operations, bound, for the two capabilities that genuinely perform every one of them: the
 * audience store and the campaign store. Sharing the binding grants neither anything it does not
 * use; every narrower capability still binds its own.
 */
export const allTableOperations = Effect.gen(function* () {
  const table = yield* dataTable;

  const operations: TableOperations = {
    getItem: yield* AWS.DynamoDB.GetItem(table),
    batchGetItem: yield* AWS.DynamoDB.BatchGetItem(table),
    putItem: yield* AWS.DynamoDB.PutItem(table),
    updateItem: yield* AWS.DynamoDB.UpdateItem(table),
    query: yield* AWS.DynamoDB.Query(table),
    transactWriteItems: yield* AWS.DynamoDB.TransactWriteItems(table),
  };

  return operations;
});

/** The implementations `allTableOperations` binds against. */
export const AllTableOperationsHttp = Layer.mergeAll(
  AWS.DynamoDB.GetItemHttp,
  AWS.DynamoDB.BatchGetItemHttp,
  AWS.DynamoDB.PutItemHttp,
  AWS.DynamoDB.UpdateItemHttp,
  AWS.DynamoDB.QueryHttp,
  AWS.DynamoDB.TransactWriteItemsHttp,
);
