import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decodeDispatchMessage, encodeDispatchMessage } from "./Dispatch.ts";

const isRejected = <A>(attempt: Effect.Effect<A, Schema.SchemaError>) =>
  Effect.map(Effect.result(attempt), Result.isFailure);

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const runToken = "0195f0a0-1111-4222-8333-44444444e5d1";

describe("DispatchMessage", () => {
  it("round trips a wake-up so the dispatcher reads the ids the API wrote", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const message = { campaignId, runToken };

        expect(yield* decodeDispatchMessage(yield* encodeDispatchMessage(message))).toStrictEqual(
          message,
        );
      }),
    ));

  it("rejects a malformed body", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decodeDispatchMessage("{"))).toBe(true);
        expect(yield* isRejected(decodeDispatchMessage("{}"))).toBe(true);
        expect(
          yield* isRejected(
            decodeDispatchMessage(`{"campaignId":"${campaignId}","runToken":"not-a-uuid"}`),
          ),
        ).toBe(true);
      }),
    ));
});
