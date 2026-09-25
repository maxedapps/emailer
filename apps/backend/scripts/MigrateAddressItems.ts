/**
 * One-off (ADR-0024): moves each mailbox's `UNSUBSCRIBE#`, `SUPPRESSION#` and `TRANSIENT` rows onto
 * its `ADDRESS#` item. Every merge keeps what the address item already holds, so it is safe to run
 * again, and running it again after the deploy picks up what the old code wrote in between.
 *
 *   node apps/backend/scripts/MigrateAddressItems.ts               merge every old row
 *   node apps/backend/scripts/MigrateAddressItems.ts --verify      check every old fact is merged
 *   node apps/backend/scripts/MigrateAddressItems.ts --delete-old  verify, then delete the old rows
 *
 * Reads `EMAILER_TABLE_NAME`, the AWS credential chain and region. Prints counts, never addresses.
 */
import { fromChain } from "@distilled.cloud/aws/Credentials";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { NodeRuntime } from "@effect/platform-node";
import { Config, Console, Data, Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { addressKey, stamped } from "../src/storage/Addresses.ts";
import { itemReader, str, strMap, strSet } from "../src/storage/Items.ts";

/** An old row, decoded, with the key it is deleted by. */
export type OldRow =
  | { readonly kind: "unsubscribe"; readonly mailbox: string; readonly unsubscribedAt: string }
  | {
      readonly kind: "suppression";
      readonly mailbox: string;
      readonly suppression: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "transient";
      readonly mailbox: string;
      readonly bounces: ReadonlyArray<string>;
    };

/** What the address item holds of an old row's fact. */
export interface AddressFacts {
  readonly unsubscribedAt?: unknown;
  readonly suppression?: unknown;
  readonly transientBounces?: ReadonlyArray<string>;
}

const readUnsubscribe = itemReader(
  Schema.Struct({ pk: Schema.String, unsubscribedAt: Schema.String }),
);

const readSuppression = itemReader(
  Schema.Struct({
    pk: Schema.String,
    reason: Schema.String,
    suppressedAt: Schema.String,
    messageId: Schema.optionalKey(Schema.String),
    feedbackId: Schema.optionalKey(Schema.String),
    bounceSubType: Schema.optionalKey(Schema.String),
    complaintFeedbackType: Schema.optionalKey(Schema.String),
    complaintSubType: Schema.optionalKey(Schema.String),
  }),
);

const readTransient = itemReader(
  Schema.Struct({
    pk: Schema.String,
    occurrences: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

const readFacts = itemReader(
  Schema.Struct({
    unsubscribedAt: Schema.optionalKey(Schema.Unknown),
    suppression: Schema.optionalKey(Schema.Unknown),
    transientBounces: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

/** The old row a stored item is, decoded; an item that is not an old address row is none. */
const oldRowOf = (item: dynamodb.AttributeMap) =>
  Effect.gen(function* () {
    const pk = item["pk"]?.S ?? "";
    const sk = item["sk"]?.S ?? "";

    if (pk.startsWith("UNSUBSCRIBE#") && sk === "UNSUBSCRIBE") {
      const row = yield* readUnsubscribe("migrateAddresses", item);

      return {
        kind: "unsubscribe",
        mailbox: row.pk.slice("UNSUBSCRIBE#".length),
        unsubscribedAt: row.unsubscribedAt,
      } satisfies OldRow;
    }

    if (pk.startsWith("SUPPRESSION#") && sk === "SUPPRESSION") {
      const { pk: suppressionPk, ...suppression } = yield* readSuppression(
        "migrateAddresses",
        item,
      );

      return {
        kind: "suppression",
        mailbox: suppressionPk.slice("SUPPRESSION#".length),
        suppression,
      } satisfies OldRow;
    }

    if (pk.startsWith("SUPPRESSION#") && sk === "TRANSIENT") {
      const row = yield* readTransient("migrateAddresses", item);

      return {
        kind: "transient",
        mailbox: row.pk.slice("SUPPRESSION#".length),
        bounces: row.occurrences ?? [],
      } satisfies OldRow;
    }

    return undefined;
  });

/** The key an old row is deleted by. */
export const oldKeyOf = (row: OldRow) => {
  switch (row.kind) {
    case "unsubscribe":
      return { pk: str(`UNSUBSCRIBE#${row.mailbox}`), sk: str("UNSUBSCRIBE") };
    case "suppression":
      return { pk: str(`SUPPRESSION#${row.mailbox}`), sk: str("SUPPRESSION") };
    case "transient":
      return { pk: str(`SUPPRESSION#${row.mailbox}`), sk: str("TRANSIENT") };
  }
};

/**
 * The update that merges an old row into its mailbox's address item. It keeps whatever the item
 * already holds, as the new code's own writes do, so the first fact recorded stands.
 */
export const mergeOf = (row: OldRow) => {
  const stamp = stamped(row.mailbox);
  const Key = addressKey(row.mailbox);

  switch (row.kind) {
    case "unsubscribe":
      return {
        Key,
        UpdateExpression: `SET ${stamp.expression}, unsubscribedAt = if_not_exists(unsubscribedAt, :at)`,
        ExpressionAttributeValues: { ...stamp.values, ":at": str(row.unsubscribedAt) },
      };
    case "suppression":
      return {
        Key,
        UpdateExpression: `SET ${stamp.expression}, suppression = if_not_exists(suppression, :s)`,
        ExpressionAttributeValues: { ...stamp.values, ":s": strMap(row.suppression) },
      };
    case "transient":
      return {
        Key,
        UpdateExpression: `SET ${stamp.expression} ADD transientBounces :bounces`,
        ExpressionAttributeValues: { ...stamp.values, ":bounces": strSet(row.bounces) },
      };
  }
};

/** Whether the address item holds the old row's fact: present, or for bounces, every one of them. */
export const holds = (row: OldRow, facts: AddressFacts | undefined): boolean => {
  switch (row.kind) {
    case "unsubscribe":
      return facts?.unsubscribedAt !== undefined;
    case "suppression":
      return facts?.suppression !== undefined;
    case "transient": {
      const merged = new Set(facts?.transientBounces ?? []);

      return row.bounces.every((bounce) => merged.has(bounce));
    }
  }
};

class NotMerged extends Data.TaggedError("NotMerged")<{ readonly rows: number }> {}

const tableName = Config.String("EMAILER_TABLE_NAME");

/** Every old row, from a strongly consistent scan that follows each page to the end. */
const oldRows = Effect.gen(function* () {
  const TableName = yield* tableName;

  const rows = yield* dynamodb.scan
    .items({
      TableName,
      ConsistentRead: true,
      FilterExpression: "begins_with(pk, :unsubscribe) OR begins_with(pk, :suppression)",
      ExpressionAttributeValues: {
        ":unsubscribe": str("UNSUBSCRIBE#"),
        ":suppression": str("SUPPRESSION#"),
      },
    })
    .pipe(Stream.mapEffect(oldRowOf), Stream.runCollect);

  return rows.filter((row) => row !== undefined);
});

const merge = Effect.gen(function* () {
  const TableName = yield* tableName;
  const updateItem = yield* dynamodb.updateItem;
  const rows = yield* oldRows;
  // A transient row without bounces has nothing to carry over.
  const mergeable = rows.filter((row) => row.kind !== "transient" || row.bounces.length > 0);

  yield* Effect.forEach(mergeable, (row) => updateItem({ TableName, ...mergeOf(row) }), {
    discard: true,
  });

  yield* Console.log(`old rows: ${rows.length}, merged: ${mergeable.length}`);
});

/** Every old row whose fact its address item does not hold. Fails if there is any. */
const verify = Effect.gen(function* () {
  const TableName = yield* tableName;
  const getItem = yield* dynamodb.getItem;
  const rows = yield* oldRows;

  const missing = yield* Effect.filter(rows, (row) =>
    getItem({ TableName, Key: addressKey(row.mailbox), ConsistentRead: true }).pipe(
      Effect.flatMap(({ Item }) =>
        Item === undefined ? Effect.undefined : readFacts("migrateAddresses", Item),
      ),
      Effect.map((facts) => !holds(row, facts)),
    ),
  );

  yield* Console.log(`old rows: ${rows.length}, not merged: ${missing.length}`);

  if (missing.length > 0) {
    return yield* new NotMerged({ rows: missing.length });
  }

  return rows;
});

/** Verified in this same run, so nothing is deleted on the strength of an earlier check. */
const deleteOld = Effect.gen(function* () {
  const TableName = yield* tableName;
  const deleteItem = yield* dynamodb.deleteItem;
  const rows = yield* verify;

  yield* Effect.forEach(rows, (row) => deleteItem({ TableName, Key: oldKeyOf(row) }), {
    discard: true,
  });

  yield* Console.log(`deleted: ${rows.length}`);
});

// Run only as a script: its tests import the functions above.
if (import.meta.main) {
  const program = process.argv.includes("--delete-old")
    ? deleteOld
    : process.argv.includes("--verify")
      ? Effect.asVoid(verify)
      : merge;

  NodeRuntime.runMain(
    program.pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, fromChain()))),
  );
}
