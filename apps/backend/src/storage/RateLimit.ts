import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as AWS from "alchemy/AWS";
import { Clock, Data, Duration, Effect, Layer, Schema } from "effect";
import { RateLimiter } from "effect/unstable/persistence";

import { itemReader, num, recordVersion, str } from "./Items.ts";
import { updatePrimitives } from "./Primitives.ts";
import { dataTable } from "./Table.ts";

import type { TableOperations } from "./Items.ts";
import type { UpdatePrimitives } from "./Primitives.ts";
import type { StorageUnavailable } from "@emailer/api/Errors";

/**
 * Shared send-pacing counter. One item per limiter key; the live Layer binds
 * `UpdateItem` alone. Delay-mode `fixedWindow` is the only implemented algorithm.
 */
const rateLimitKey = (key: string) => ({
  pk: str(`RATELIMIT#${key}`),
  sk: str("RATELIMIT"),
});

const windowNames = { "#count": "count", "#expiresAt": "expiresAt" } as const;

const readWindow = itemReader(Schema.Struct({ count: Schema.Int, expiresAt: Schema.Finite }));

const unsupported = (method: string) =>
  new RateLimiter.RateLimiterError({
    reason: new RateLimiter.RateLimitStoreError({
      message: `${method} is not supported`,
    }),
  });

const storeFailure = (cause: StorageUnavailable) =>
  new RateLimiter.RateLimiterError({
    reason: new RateLimiter.RateLimitStoreError({
      message: "Failed to execute fixedWindow rate limiting command",
      cause,
    }),
  });

/** The window was not in the state a claim expected: it expired, or another claim reset it. */
class WindowMoved extends Data.TaggedError("WindowMoved") {}

export const rateLimitOperations = (primitives: Pick<UpdatePrimitives, "updateIf">) => {
  const { updateIf } = primitives;

  const fromAttributes = (now: number, attributes: dynamodb.AttributeMap | undefined) =>
    readWindow("fixedWindow", attributes).pipe(
      Effect.map((window) => [window.count, window.expiresAt - now] as const),
    );

  const claim = (request: AWS.DynamoDB.UpdateItemRequest) =>
    updateIf("fixedWindow", request, () => new WindowMoved());

  return RateLimiter.RateLimiterStore.of({
    fixedWindow: Effect.fnUntraced(function* ({ key, tokens, refillRate }) {
      const now = yield* Clock.currentTimeMillis;
      const extend = Math.max(1, Math.ceil(Duration.toMillis(refillRate) * tokens));
      const itemKey = rateLimitKey(key);

      const common = {
        Key: itemKey,
        UpdateExpression:
          "SET #count = if_not_exists(#count, :zero) + :tokens, #expiresAt = if_not_exists(#expiresAt, :now) + :extend, v = if_not_exists(v, :version)",
        ConditionExpression: "attribute_not_exists(pk) OR #expiresAt > :now",
        ExpressionAttributeNames: windowNames,
        ExpressionAttributeValues: {
          ":zero": num(0),
          ":tokens": num(tokens),
          ":now": num(now),
          ":extend": num(extend),
          ":version": num(recordVersion),
        },
        ReturnValues: "ALL_NEW" as const,
      };

      const reset = {
        Key: itemKey,
        UpdateExpression: "SET #count = :tokens, #expiresAt = :nowPlusExtend",
        ConditionExpression: "attribute_exists(pk) AND #expiresAt <= :now",
        ExpressionAttributeNames: windowNames,
        ExpressionAttributeValues: {
          ":tokens": num(tokens),
          ":now": num(now),
          ":nowPlusExtend": num(now + extend),
        },
        ReturnValues: "ALL_NEW" as const,
      };

      // Claim in the live window; else reset an expired one; else another claim just reset it,
      // so claim in that window.
      const window = yield* claim(common).pipe(
        Effect.catchTag("WindowMoved", () => claim(reset)),
        Effect.catchTag("WindowMoved", () => claim(common)),
        Effect.catchTags({
          WindowMoved: () =>
            Effect.fail(
              new RateLimiter.RateLimiterError({
                reason: new RateLimiter.RateLimitStoreError({
                  message: "fixedWindow lost the race after reset",
                }),
              }),
            ),
          StorageUnavailable: (failure) => Effect.fail(storeFailure(failure)),
        }),
      );

      return yield* fromAttributes(now, window);
    }),
    tokenBucket: () => Effect.fail(unsupported("tokenBucket")),
    adaptiveConsume: () => Effect.fail(unsupported("adaptiveConsume")),
    adaptiveFeedback: () => Effect.fail(unsupported("adaptiveFeedback")),
  });
};

const rateLimitStore = (updateItem: TableOperations["updateItem"]) =>
  rateLimitOperations(updatePrimitives({ updateItem }));

export const rateLimitStoreLayer = Layer.effect(RateLimiter.RateLimiterStore)(
  Effect.gen(function* () {
    const table = yield* dataTable;

    return rateLimitStore(yield* AWS.DynamoDB.UpdateItem(table));
  }),
).pipe(Layer.provide(AWS.DynamoDB.UpdateItemHttp));
