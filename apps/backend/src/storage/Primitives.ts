import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import type * as AWS from "alchemy/AWS";
import { Data, Duration, Effect, Predicate, Random, Schedule, Schema } from "effect";

import { StorageUnavailable } from "@emailer/api/Errors";

import { corrupt, unavailable } from "../Errors.ts";
import { keyCodec, listingIndexName, operationTimeout, str, tableLogicalId } from "./Items.ts";

import type { TableOperations } from "./Items.ts";

const conditionalCheckFailed = "ConditionalCheckFailed";

const CancellationCodes = Schema.UndefinedOr(
  Schema.Array(Schema.Struct({ Code: Schema.optional(Schema.String) })),
);

const decodeCancellationCodes = Schema.decodeUnknownEffect(CancellationCodes);

/** Every failure of a table call: the store was unreachable, timed out, or refused the request. */
const storageUnavailable = (operation: string) => unavailable(StorageUnavailable, operation);

type TransactionOutcome =
  | { readonly committed: true }
  | { readonly committed: false; readonly conditionFailures: ReadonlySet<number> };

const committed: TransactionOutcome = { committed: true };

/**
 * A transaction cancelled because its items collided with another in-flight transaction applied
 * nothing, so it is safe to send again. The AWS client does not classify that cancellation as
 * retryable, because the same exception also reports condition failures, so this is the one
 * retry the store owns: everything transient (throttling, server errors, lost responses) is the
 * client's default policy, which every write here can afford because every write is safe to
 * repeat.
 *
 * `Schedule.max` keeps going only while both the delay policy and the recurrence bound continue;
 * six recurrences after the first attempt is seven tries. The delays double from 50 ms and sum to
 * 3.15 s; jitter scales each by 0.8–1.2, so the worst case is about 3.8 s of waiting, inside the 5 s
 * operation timeout around the whole sequence.
 */
const conflictRetry = Schedule.max([
  Schedule.recurs(6),
  Schedule.exponential("50 millis").pipe(Schedule.jittered),
]);

type TaggedWriteFailure = {
  readonly _tag: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
};

const isConflictCancellation = (error: TaggedWriteFailure) => {
  const reasons = error.CancellationReasons ?? [];

  return (
    Predicate.isTagged("TransactionCanceledException")(error) &&
    reasons.length > 0 &&
    reasons.every((reason) => reason.Code === "TransactionConflict" || reason.Code === "None")
  );
};

/**
 * A page as the contract answers it. On the last page `nextCursor` is absent rather than
 * `undefined`, which the API would encode as `null`.
 */
export interface StoredPage<Item, Cursor> {
  readonly items: ReadonlyArray<Item>;
  readonly nextCursor?: Cursor;
}

const decodeIndexEntry = Schema.decodeUnknownEffect(
  keyCodec(Schema.Struct({ gsi1sk: Schema.String })),
);

/**
 * The next cursor is derived from `LastEvaluatedKey` and from nothing else. Deriving it from a
 * page's length is the documented trap: a query can return a short or even empty page and still
 * have more to give, and a caller that stopped there would silently see part of a list.
 *
 * An unreadable `LastEvaluatedKey` is corrupt rather than absent, for the same reason: reading it
 * as "no more pages" would truncate the listing silently.
 */
const nextCursorOf = (operation: string, lastEvaluatedKey: dynamodb.AttributeMap | undefined) =>
  lastEvaluatedKey === undefined
    ? Effect.undefined
    : decodeIndexEntry(lastEvaluatedKey).pipe(
        corrupt(operation),
        Effect.map((entry) => entry.gsi1sk),
      );

const responseItems = (response: dynamodb.BatchGetItemOutput): Array<dynamodb.AttributeMap> => {
  const items: Array<dynamodb.AttributeMap> = [];

  for (const page of Object.values(response.Responses ?? {})) {
    items.push(...(page ?? []));
  }

  return items;
};

/**
 * Each factory below builds from exactly one DynamoDB operation, so the permission a capability
 * needs is legible from the primitives it asks for rather than from a single bundle that binds
 * everything. Alchemy registers IAM while a binding is constructed, so a capability that never
 * constructs `Query` never receives `dynamodb:Query` — which is the point of splitting these at
 * all. Composed primitives take other primitives, never raw operations.
 */
export const readPrimitives = (operations: Pick<TableOperations, "getItem">) => {
  const readItem = (operationId: string, key: AWS.DynamoDB.GetItemRequest["Key"]) =>
    operations
      .getItem({ Key: key, ConsistentRead: true })
      .pipe(Effect.timeout(operationTimeout), Effect.mapError(storageUnavailable(operationId)));

  return { readItem } as const;
};

export type ReadPrimitives = ReturnType<typeof readPrimitives>;

export const writePrimitives = (operations: Pick<TableOperations, "putItem">) => {
  /**
   * A put that leaves an existing item alone. The key is either a mailbox the caller wants
   * recorded exactly once, or a freshly generated identifier that nobody else can hold, so an
   * item already there is the outcome the caller wanted — including when it is this same request
   * landing a second time after a lost response.
   */
  const recordOnce = (operationId: string, item: AWS.DynamoDB.PutItemRequest["Item"]) =>
    operations.putItem({ Item: item, ConditionExpression: "attribute_not_exists(pk)" }).pipe(
      Effect.timeout(operationTimeout),
      Effect.catchTag("ConditionalCheckFailedException", () => Effect.void),
      Effect.mapError(storageUnavailable(operationId)),
      Effect.asVoid,
    );

  return { recordOnce } as const;
};

export type WritePrimitives = ReturnType<typeof writePrimitives>;

type UpdateIfResult =
  | { readonly applied: true; readonly attributes: dynamodb.AttributeMap | undefined }
  | { readonly applied: false };

export const updatePrimitives = (operations: Pick<TableOperations, "updateItem">) => {
  /**
   * A conditional single-item update whose failed condition is a documented outcome. `ReturnValues`
   * is honoured so a caller can read the item that was written; any other error, including a
   * timeout, is still unavailable.
   *
   * The client retries transient answers, including a lost response, so the request may land
   * twice. `UpdateItem` has no idempotency token; what makes the repeat safe is the caller's
   * condition, which must hold both before and after the write for the actor that wrote it — a
   * run token, a slice identifier, the value being set — so a second landing applies the same
   * values or reports `applied` just as the first did.
   */
  const updateIf = (
    operationId: string,
    request: AWS.DynamoDB.UpdateItemRequest,
  ): Effect.Effect<UpdateIfResult, StorageUnavailable> =>
    operations.updateItem(request).pipe(
      Effect.map((output): UpdateIfResult => ({ applied: true, attributes: output.Attributes })),
      Effect.catchTag("ConditionalCheckFailedException", () =>
        Effect.succeed<UpdateIfResult>({ applied: false }),
      ),
      Effect.timeout(operationTimeout),
      Effect.mapError(storageUnavailable(operationId)),
    );

  return { updateIf } as const;
};

export type UpdatePrimitives = ReturnType<typeof updatePrimitives>;

const queryPrimitives = (operations: Pick<TableOperations, "query">) => {
  /**
   * `ConsistentRead` is invalid on a global secondary index and fails at runtime, not at compile
   * time — the SDK types let `IndexName` and `ConsistentRead` coexist. The request type therefore
   * excludes the field outright and this primitive is the only place that sets it, for the
   * base table alone.
   */
  const runQuery = (
    operationId: string,
    target: "base-table" | "index",
    request: Omit<AWS.DynamoDB.QueryRequest, "ConsistentRead">,
  ) =>
    operations
      .query(target === "index" ? request : { ...request, ConsistentRead: true })
      .pipe(Effect.timeout(operationTimeout), Effect.mapError(storageUnavailable(operationId)));

  return { runQuery } as const;
};

export type QueryPrimitives = ReturnType<typeof queryPrimitives>;

const batchAttempts = 4;

const batchRetryDelay = Duration.millis(100);

const batchDeadline = Duration.seconds(5);

/** Why a hydration failed after its last attempt: the items that did arrive and the keys that did not. */
class IncompleteBatch extends Data.TaggedError("IncompleteBatch")<{
  readonly items: ReadonlyArray<dynamodb.AttributeMap>;
  readonly pending: dynamodb.KeysAndAttributes;
}> {}

const batchPrimitives = (operations: Pick<TableOperations, "batchGetItem">) => {
  /**
   * `BatchGetItem` requests are keyed by the table's logical ID, which the binding rewrites to the
   * physical name; AWS then echoes both `Responses` and `UnprocessedKeys` under that **physical**
   * name, with no reverse mapping. Feeding `UnprocessedKeys` back verbatim would reach an unbound
   * logical ID and `Effect.die`, so the pending block is re-keyed before it is retried, and the
   * responses are read by value rather than by name.
   *
   * AWS may leave keys unprocessed on any response, including the retry of a retry — it is
   * throttling, not a one-off. Returning whatever arrived would answer a partial hydration as if it
   * were a complete one, and a listing would quietly drop members. So the pending block is retried
   * until it is empty, and if the attempts run out the operation fails. A short read is never a
   * successful read.
   */
  const readItems = (operationId: string, keys: ReadonlyArray<dynamodb.AttributeMap>) =>
    Effect.gen(function* () {
      // A page can legitimately hydrate nothing — an empty listing partition, or a page whose
      // every index entry has since been deleted. `KeysAndAttributes.Keys` must carry at least one
      // key, and neither the SDK nor the service tolerates an empty one, so the request is skipped
      // rather than sent: otherwise an empty list would answer 503.
      if (keys.length === 0) {
        return [];
      }

      const items: Array<dynamodb.AttributeMap> = [];
      let requested: dynamodb.KeysAndAttributes = { Keys: [...keys], ConsistentRead: true };

      for (let attempt = 1; attempt <= batchAttempts; attempt += 1) {
        const response = yield* operations
          .batchGetItem({ RequestItems: { [tableLogicalId]: requested } })
          .pipe(Effect.mapError(storageUnavailable(operationId)));

        items.push(...responseItems(response));

        const pending = Object.values(response.UnprocessedKeys ?? {})[0];

        if (pending === undefined || pending.Keys.length === 0) {
          return items;
        }

        // Re-keyed to the logical ID the binding expects, preserving ConsistentRead.
        requested = { Keys: pending.Keys, ConsistentRead: true };

        if (attempt < batchAttempts) {
          // Jittered exponential backoff: unprocessed keys mean the table is shedding load, and
          // retrying in lockstep with every other caller is how that gets worse.
          const jitter = yield* Random.next;

          yield* Effect.sleep(Duration.times(batchRetryDelay, 2 ** (attempt - 1) * (1 + jitter)));
        }
      }

      return yield* storageUnavailable(operationId)(
        new IncompleteBatch({ items, pending: requested }),
      );
    }).pipe(
      // One deadline for the whole operation, retries included, rather than one per attempt: the
      // caller's budget does not grow because the store needed several rounds.
      Effect.timeout(batchDeadline),
      Effect.catchTag("TimeoutError", (timeout) =>
        Effect.fail(storageUnavailable(operationId)(timeout)),
      ),
    );

  return { readItems } as const;
};

export type BatchPrimitives = ReturnType<typeof batchPrimitives>;

const pagePrimitives = (primitives: QueryPrimitives & BatchPrimitives) => {
  const { readItems, runQuery } = primitives;

  /**
   * One page of a listable entity kind: an index query for keys, then a strongly consistent
   * hydration of those keys from the base table. The index is eventually consistent and projects
   * keys only, so an entry that no longer resolves hydrates to nothing and drops out of the page —
   * the listing repairs itself rather than serving a stale projection. The page is in index order
   * (UTF-8 byte order of the string sort key); callers do not sort.
   */
  const readEntityPage = (
    operationId: string,
    kind: string,
    keyOf: (id: string) => dynamodb.AttributeMap,
    limit: number,
    cursor: string | undefined,
  ) =>
    Effect.gen(function* () {
      const request = {
        IndexName: listingIndexName,
        KeyConditionExpression: "gsi1pk = :kind",
        ExpressionAttributeValues: { ":kind": str(kind) },
        Limit: limit,
      };

      const page = yield* runQuery(
        operationId,
        "index",
        cursor === undefined
          ? request
          : {
              ...request,
              // The cursor *is* the index sort key, so an index query resumes from it directly —
              // and from the table key it points at, which the identifier half names.
              ExclusiveStartKey: {
                gsi1pk: str(kind),
                gsi1sk: str(cursor),
                ...keyOf(cursor.slice(cursor.indexOf("#") + 1)),
              },
            },
      );

      const keys: Array<dynamodb.AttributeMap> = [];

      for (const entry of page.Items ?? []) {
        const { gsi1sk } = yield* decodeIndexEntry(entry).pipe(corrupt(operationId));

        keys.push(keyOf(gsi1sk.slice(gsi1sk.indexOf("#") + 1)));
      }

      const hydrated = yield* readItems(operationId, keys);
      const byPk = new Map(hydrated.map((item) => [item.pk?.S, item] as const));

      const items = keys.flatMap((key): Array<dynamodb.AttributeMap> => {
        const item = byPk.get(key.pk?.S);

        return item === undefined ? [] : [item];
      });

      const nextCursor = yield* nextCursorOf(operationId, page.LastEvaluatedKey);

      return (nextCursor === undefined ? { items } : { items, nextCursor }) satisfies StoredPage<
        dynamodb.AttributeMap,
        string
      >;
    });

  return { readEntityPage } as const;
};

export type PagePrimitives = ReturnType<typeof pagePrimitives>;

/**
 * A transaction request as the store writes it: the idempotency token is the primitive's to add,
 * one per logical call, and never the caller's.
 */
export type TransactionRequest = Omit<AWS.DynamoDB.TransactWriteItemsRequest, "ClientRequestToken">;

/** A fresh token per logical transaction; at most 36 characters, which a UUID exactly fills. */
export type TransactionTokens = Effect.Effect<string>;

export const transactionPrimitives = (
  operations: Pick<TableOperations, "transactWriteItems">,
  tokens: TransactionTokens,
) => {
  /**
   * A transaction whose cancelled condition checks are a documented outcome.
   *
   * Every logical call carries its own `ClientRequestToken`. DynamoDB then treats a repeat of the
   * identical request within ten minutes as the same call and answers success without applying it
   * again, which is what makes the client's default transient retries safe here: a lost response
   * is resent, not misread as a condition failure. A cancellation whose reasons are only
   * `TransactionConflict` or `None` applied nothing and is retried as a **new** call with a new
   * token, since nothing documents how a cancelled token replays. A mix with
   * `ConditionalCheckFailed` is a business outcome, classified below; any other reason is
   * unavailable. The timeout wraps the whole sequence.
   */
  const runTransaction = (
    operationId: string,
    request: TransactionRequest,
  ): Effect.Effect<TransactionOutcome, StorageUnavailable> =>
    tokens.pipe(
      Effect.flatMap((token) =>
        operations.transactWriteItems({ ...request, ClientRequestToken: token }).pipe(
          Effect.as(committed),
          Effect.catchTag("TransactionCanceledException", (failure) =>
            decodeCancellationCodes(failure.CancellationReasons).pipe(
              Effect.mapError(() => failure),
              Effect.flatMap((reasons) => {
                const conditionFailures = new Set<number>();
                let hasOtherReason = false;

                (reasons ?? []).forEach((reason, index) => {
                  if (reason.Code === conditionalCheckFailed) {
                    conditionFailures.add(index);
                  } else if (reason.Code !== undefined && reason.Code !== "None") {
                    hasOtherReason = true;
                  }
                });

                if (hasOtherReason || conditionFailures.size === 0) {
                  return Effect.fail(failure);
                }

                return Effect.succeed<TransactionOutcome>({ committed: false, conditionFailures });
              }),
            ),
          ),
        ),
      ),
      Effect.retry({ schedule: conflictRetry, while: isConflictCancellation }),
      Effect.timeout(operationTimeout),
      Effect.mapError(storageUnavailable(operationId)),
    );

  return { runTransaction } as const;
};

export type TransactionPrimitives = ReturnType<typeof transactionPrimitives>;

/**
 * Every primitive, for a caller that genuinely uses every operation. The production callers are
 * the audience store and the campaign store; test suites use it to exercise an item factory
 * against a scripted table.
 */
export const allPrimitives = (operations: TableOperations, tokens: TransactionTokens) => {
  const queries = queryPrimitives(operations);
  const batches = batchPrimitives(operations);

  return {
    ...readPrimitives(operations),
    ...writePrimitives(operations),
    ...updatePrimitives(operations),
    ...queries,
    ...batches,
    ...pagePrimitives({ ...queries, ...batches }),
    ...transactionPrimitives(operations, tokens),
  } as const;
};
