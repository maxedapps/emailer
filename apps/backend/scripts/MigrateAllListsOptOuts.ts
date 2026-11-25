/**
 * One-off (ADR-0047): every opt-out recorded before ADR-0045's prod deploy, when an opt-out still
 * covered every list, covers every list again. An address item holding an opt-out from a list that
 * existed before the deploy gets `leftAllLists`; one whose opt-outs all name lists created since
 * was made under the per-list rule and stays as it is.
 *
 *   node apps/backend/scripts/MigrateAllListsOptOuts.ts           # counts only, writes nothing
 *   node apps/backend/scripts/MigrateAllListsOptOuts.ts --apply   # writes, then counts
 *
 * A consent sign-up since the deploy to a list from before it may have lifted an old opt-out if
 * its mailbox has an address item (an opt-out creates one, and lifting it leaves it), which
 * neither this scan nor the item can tell; and a scan has no snapshot, so one landing while
 * it runs can be missed or blocked. The script therefore refuses to write while any such record
 * exists, and runs again after writing to show none came in meanwhile.
 *
 * Reads `EMAILER_TABLE_NAME`, the AWS credential chain and region. Prints counts and list names,
 * never addresses.
 */
import { fromChain } from "@distilled.cloud/aws/Credentials";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { NodeRuntime } from "@effect/platform-node";
import { Config, Console, Effect, Layer, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

/** ADR-0045's prod deploy: opt-outs recorded before it covered every list. */
export const perListSince = "2026-11-25T07:55:50.000Z";

/** The update that marks an address item as having left every list. */
export const migrationOf = (item: dynamodb.AttributeMap) => ({
  Key: { pk: item["pk"], sk: item["sk"] },
  UpdateExpression: "SET leftAllLists = :left",
  ExpressionAttributeValues: { ":left": { BOOL: true } },
});

interface ConsentRecord {
  readonly listId: string;
  readonly joinedAt: string;
  readonly basis: string;
}

/**
 * Whether a consent record from since the deploy may have lifted an opt-out recorded before it,
 * given that its mailbox has an address item.
 */
export const mayHaveRejoined = (
  record: ConsentRecord,
  createdSince: ReadonlySet<string>,
): boolean =>
  record.joinedAt >= perListSince && record.basis === "consent" && !createdSince.has(record.listId);

/**
 * Whether an address's opt-outs include one recorded before the per-list rule: one from a list
 * that existed before the deploy, or that is gone (every deleted list predates it).
 */
export const leftBeforePerList = (
  optOuts: ReadonlyArray<string>,
  createdSince: ReadonlySet<string>,
): boolean => optOuts.some((listId) => !createdSince.has(listId));

const mailboxOf = (pk: string) => pk.slice(pk.indexOf("#") + 1);

const scanTable = (TableName: string) =>
  dynamodb.scan
    .items({
      TableName,
      ConsistentRead: true,
      ProjectionExpression:
        "pk, sk, optOuts, leftAllLists, suppression, contactId, createdAt, #name, basis",
      ExpressionAttributeNames: { "#name": "name" },
    })
    .pipe(Stream.runCollect);

const migrate = Effect.gen(function* () {
  const TableName = yield* Config.String("EMAILER_TABLE_NAME");
  const apply = process.argv.includes("--apply");
  const updateItem = yield* dynamodb.updateItem;
  const items = yield* scanTable(TableName);

  const listNames = new Map<string, string>();
  const createdSince = new Set<string>();
  const holders = new Map<string, string>();
  const membershipsOf = new Map<string, Array<string>>();
  const addressItems = new Set<string>();
  const laterConsents: Array<ConsentRecord & { readonly mailbox: string }> = [];
  const addresses: Array<dynamodb.AttributeMap> = [];

  for (const item of items) {
    const pk = item["pk"]?.S ?? "";
    const sk = item["sk"]?.S ?? "";

    if (pk.startsWith("LIST#") && sk === "META") {
      const listId = mailboxOf(pk);

      listNames.set(listId, item["name"]?.S ?? listId);

      if ((item["createdAt"]?.S ?? "") >= perListSince) {
        createdSince.add(listId);
      }
    } else if (pk.startsWith("LIST#") && sk.startsWith("MEMBER#")) {
      const contactId = sk.slice("MEMBER#".length);

      membershipsOf.set(contactId, [...(membershipsOf.get(contactId) ?? []), mailboxOf(pk)]);
    } else if (pk.startsWith("EMAIL#") && sk === "META") {
      holders.set(mailboxOf(pk), item["contactId"]?.S ?? "");
    } else if (pk.startsWith("ADDRESS#") && sk === "ADDRESS") {
      addressItems.add(mailboxOf(pk));

      if (item["optOuts"] !== undefined) {
        addresses.push(item);
      }
    } else if (pk.startsWith("ADDRESS#") && sk.startsWith("CONSENT#")) {
      const [, listId = "", joinedAt = ""] = sk.split("#");

      laterConsents.push({
        mailbox: mailboxOf(pk),
        listId,
        joinedAt,
        basis: item["basis"]?.S ?? "consent",
      });
    }
  }

  const affected = addresses.filter(
    (item) =>
      item["leftAllLists"] === undefined &&
      leftBeforePerList(item["optOuts"]?.SS ?? [], createdSince),
  );

  const byList = new Map<string, number>();
  let mailableElsewhere = 0;

  for (const item of affected) {
    const mailbox = mailboxOf(item["pk"]?.S ?? "");
    const optOuts = item["optOuts"]?.SS ?? [];

    for (const listId of optOuts) {
      const name = listNames.get(listId) ?? `(deleted list ${listId})`;

      byList.set(name, (byList.get(name) ?? 0) + 1);
    }

    const memberships = membershipsOf.get(holders.get(mailbox) ?? "") ?? [];

    if (
      item["suppression"] === undefined &&
      memberships.some((listId) => !optOuts.includes(listId))
    ) {
      mailableElsewhere += 1;
    }
  }

  yield* Console.log(`address items with opt-outs: ${addresses.length}`);
  yield* Console.log(`lists created since the per-list deploy: ${createdSince.size}`);
  yield* Console.log(`leaving all lists: ${affected.length}`);
  yield* Console.log(`  of them still mailable on a list they did not leave: ${mailableElsewhere}`);
  yield* Console.log("  by the list they left:");

  for (const [name, count] of byList) {
    yield* Console.log(`    ${count}  ${name}`);
  }

  const rejoins = laterConsents.filter(
    (record) => addressItems.has(record.mailbox) && mayHaveRejoined(record, createdSince),
  ).length;

  yield* Console.log(`consent sign-ups since the deploy to a list from before it: ${rejoins}`);

  if (apply && rejoins > 0) {
    return yield* Effect.die("Refusing to write: reconcile those sign-ups first (ADR-0047).");
  }

  if (apply) {
    yield* Effect.forEach(affected, (item) => updateItem({ TableName, ...migrationOf(item) }), {
      concurrency: 16,
      discard: true,
    });

    yield* Console.log(`migrated address items: ${affected.length}`);
  }
});

// Run only as a script: its test imports the functions above.
if (import.meta.main) {
  NodeRuntime.runMain(
    migrate.pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, fromChain()))),
  );
}
