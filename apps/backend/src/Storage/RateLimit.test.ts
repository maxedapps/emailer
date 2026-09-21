import { Duration, Effect, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import { RateLimiter } from "effect/unstable/persistence";
import { describe, expect, it } from "vitest";

import { num, str } from "./Items.ts";
import { rateLimitOperations } from "./RateLimit.ts";
import { conditionFailed, primitivesFor, scriptedTable, serverError } from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { ScriptedReplies } from "./Testing.ts";

const now = 1_700_000_000_000;

const key = "ses-send";

const tokens = 1;

const refillRate = Duration.millis(1000);

const extend = 1000;

const reservedCount = /(?<![:#])\bcount\b/;

const windowAttributes = (count: number, expiresAt: number) =>
  Effect.succeed({
    Attributes: {
      count: num(count),
      expiresAt: num(expiresAt),
    },
  });

const storeFor = (table: Table) => rateLimitOperations(primitivesFor(table));

const withStore = (replies: ScriptedReplies) => {
  const table = scriptedTable(replies);

  return { table, store: storeFor(table) };
};

const onTestClock = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);

    return yield* operation;
  }).pipe(Effect.provide(TestClock.layer()));

const limiterError = <A>(attempt: Result.Result<A, RateLimiter.RateLimiterError>) => {
  if (Result.isSuccess(attempt)) {
    throw new Error("Expected the operation to fail");
  }

  return attempt.failure.reason;
};

const commonPath = {
  Key: { pk: str(`RATELIMIT#${key}`), sk: str("RATELIMIT") },
  UpdateExpression:
    "SET #count = if_not_exists(#count, :zero) + :tokens, #expiresAt = if_not_exists(#expiresAt, :now) + :extend, v = if_not_exists(v, :version)",
  ConditionExpression: "attribute_not_exists(pk) OR #expiresAt > :now",
  ExpressionAttributeNames: { "#count": "count", "#expiresAt": "expiresAt" },
  ExpressionAttributeValues: {
    ":zero": num(0),
    ":tokens": num(tokens),
    ":now": num(now),
    ":extend": num(extend),
    ":version": num(1),
  },
  ReturnValues: "UPDATED_NEW",
} as const;

describe("fixedWindow", () => {
  it("issues the common-path UpdateItem and returns [tokens, extend] for a fresh item", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const { table, store } = withStore({
            updateItem: [windowAttributes(tokens, now + extend)],
          });

          expect(
            yield* store.fixedWindow({ key, tokens, refillRate, limit: undefined }),
          ).toStrictEqual([tokens, extend]);
          expect(table.updateItemRequests).toHaveLength(1);
          expect(table.updateItemRequests[0]).toStrictEqual(commonPath);
          expect(table.updateItemRequests[0]?.UpdateExpression).not.toMatch(reservedCount);
          expect(table.updateItemRequests[0]?.ConditionExpression).not.toMatch(reservedCount);
        }),
      ),
    ));

  it("resets an expired item conditioned on #expiresAt <= :now", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const { table, store } = withStore({
            updateItem: [conditionFailed, windowAttributes(tokens, now + extend)],
          });

          expect(
            yield* store.fixedWindow({ key, tokens, refillRate, limit: undefined }),
          ).toStrictEqual([tokens, extend]);
          expect(table.updateItemRequests).toHaveLength(2);
          expect(table.updateItemRequests[0]?.ConditionExpression).toBe(
            "attribute_not_exists(pk) OR #expiresAt > :now",
          );
          expect(table.updateItemRequests[1]).toStrictEqual({
            Key: { pk: str(`RATELIMIT#${key}`), sk: str("RATELIMIT") },
            UpdateExpression: "SET #count = :tokens, #expiresAt = :nowPlusExtend",
            ConditionExpression: "attribute_exists(pk) AND #expiresAt <= :now",
            ExpressionAttributeNames: { "#count": "count", "#expiresAt": "expiresAt" },
            ExpressionAttributeValues: {
              ":tokens": num(tokens),
              ":now": num(now),
              ":nowPlusExtend": num(now + extend),
            },
            ReturnValues: "UPDATED_NEW",
          });
          expect(table.updateItemRequests[1]?.UpdateExpression).not.toMatch(reservedCount);
          expect(table.updateItemRequests[1]?.ConditionExpression).not.toMatch(reservedCount);
        }),
      ),
    ));

  it("retries the common path once after a lost reset and then fails", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const { table, store } = withStore({
            updateItem: [conditionFailed, conditionFailed, conditionFailed],
          });

          const attempt = yield* Effect.result(
            store.fixedWindow({ key, tokens, refillRate, limit: undefined }),
          );

          expect(limiterError(attempt)._tag).toBe("RateLimitStoreError");
          expect(table.updateItemRequests).toHaveLength(3);
          expect(table.updateItemRequests[0]?.ConditionExpression).toBe(
            "attribute_not_exists(pk) OR #expiresAt > :now",
          );
          expect(table.updateItemRequests[1]?.ConditionExpression).toBe(
            "attribute_exists(pk) AND #expiresAt <= :now",
          );
          expect(table.updateItemRequests[2]?.ConditionExpression).toBe(
            "attribute_not_exists(pk) OR #expiresAt > :now",
          );
        }),
      ),
    ));

  it("maps a storage failure to RateLimiterError", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const { store } = withStore({ updateItem: [Effect.fail(serverError)] });

          const attempt = yield* Effect.result(
            store.fixedWindow({ key, tokens, refillRate, limit: undefined }),
          );

          const reason = limiterError(attempt);

          expect(reason._tag).toBe("RateLimitStoreError");
          expect(reason.message).toBe("Failed to execute fixedWindow rate limiting command");
        }),
      ),
    ));
});

describe("unsupported algorithms", () => {
  it("fails tokenBucket, adaptiveConsume and adaptiveFeedback with RateLimitStoreError", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { store } = withStore({});

        const tokenBucket = limiterError(
          yield* Effect.result(
            store.tokenBucket({
              key,
              tokens,
              limit: 1,
              refillRate,
              allowOverflow: true,
            }),
          ),
        );

        const adaptiveConsume = limiterError(
          yield* Effect.result(
            store.adaptiveConsume({
              key,
              tokens,
              fallbackLimit: 1,
              fallbackWindow: refillRate,
            }),
          ),
        );

        const adaptiveFeedback = limiterError(
          yield* Effect.result(
            store.adaptiveFeedback({
              key,
              epoch: 0,
              tokens,
              status: 429,
              retryAfter: refillRate,
            }),
          ),
        );

        expect(tokenBucket._tag).toBe("RateLimitStoreError");
        expect(tokenBucket.message).toBe("tokenBucket is not supported");
        expect(adaptiveConsume._tag).toBe("RateLimitStoreError");
        expect(adaptiveConsume.message).toBe("adaptiveConsume is not supported");
        expect(adaptiveFeedback._tag).toBe("RateLimitStoreError");
        expect(adaptiveFeedback.message).toBe("adaptiveFeedback is not supported");
      }),
    ));
});

describe("RateLimiter.consume", () => {
  it("returns the delay implied by the store count in delay mode", () => {
    const count = 3;
    const refillMs = 500;

    const { store } = withStore({
      updateItem: [windowAttributes(count, now + count * refillMs)],
    });

    return Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const limiter = yield* RateLimiter.RateLimiter;

          const result = yield* limiter.consume({
            key,
            window: "1 second",
            limit: 2,
            onExceeded: "delay",
            algorithm: "fixed-window",
          });

          expect(Duration.toMillis(result.delay)).toBe(1000);
        }).pipe(
          Effect.provide(
            RateLimiter.layer.pipe(
              Layer.provide(Layer.succeed(RateLimiter.RateLimiterStore, store)),
            ),
          ),
        ),
      ),
    );
  });
});
