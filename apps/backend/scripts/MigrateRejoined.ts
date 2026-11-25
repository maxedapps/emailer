/**
 * One-off (ADR-0045): an opt-out now keeps an address from its own list only, so the lists an
 * address rejoined leave its `optOuts`, and `rejoined` goes. Run it after the deploy: the new code
 * no longer writes `rejoined`, so a second run finds nothing.
 *
 *   node apps/backend/scripts/MigrateRejoined.ts
 *
 * Reads `EMAILER_TABLE_NAME`, the AWS credential chain and region. Prints counts, never addresses.
 */
import { fromChain } from "@distilled.cloud/aws/Credentials";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { NodeRuntime } from "@effect/platform-node";
import { Config, Console, Effect, Layer, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

import { strSet } from "../src/storage/Items.ts";

/**
 * The update that takes an address item's rejoined lists out of its opt-outs. DynamoDB removes
 * `optOuts` itself once the set is empty.
 */
export const migrationOf = (item: dynamodb.AttributeMap) => ({
  Key: { pk: item["pk"], sk: item["sk"] },
  UpdateExpression: "DELETE optOuts :rejoined REMOVE rejoined",
  ExpressionAttributeValues: { ":rejoined": strSet(item["rejoined"]?.SS ?? []) },
});

const migrate = Effect.gen(function* () {
  const TableName = yield* Config.String("EMAILER_TABLE_NAME");
  const updateItem = yield* dynamodb.updateItem;

  const items = yield* dynamodb.scan
    .items({
      TableName,
      ConsistentRead: true,
      FilterExpression: "attribute_exists(rejoined)",
      ProjectionExpression: "pk, sk, rejoined",
    })
    .pipe(Stream.runCollect);

  yield* Effect.forEach(items, (item) => updateItem({ TableName, ...migrationOf(item) }), {
    discard: true,
  });

  yield* Console.log(`migrated address items: ${items.length}`);
});

// Run only as a script: its test imports the function above.
if (import.meta.main) {
  NodeRuntime.runMain(
    migrate.pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, fromChain()))),
  );
}
