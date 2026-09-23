import * as AWS from "alchemy/AWS";

import { listingIndexName, tableLogicalId } from "./Items.ts";

/**
 * The table itself, and nothing else. Capabilities are declared beside the items they own —
 * `Audience.ts`, `Campaigns.ts`, `Feedback.ts` and `Unsubscribe.ts` — so that each binds only the
 * DynamoDB operations it actually performs. Alchemy registers IAM while a binding is constructed,
 * so a single shared service would hand every consumer every permission.
 */
export const dataTable = AWS.DynamoDB.Table(tableLogicalId, {
  partitionKey: "pk",
  sortKey: "sk",
  attributes: { pk: "S", sk: "S", gsi1pk: "S", gsi1sk: "S" },
  billingMode: "PAY_PER_REQUEST",
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
});
