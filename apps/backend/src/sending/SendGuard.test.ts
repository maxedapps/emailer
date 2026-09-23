import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { RateLimiter } from "effect/unstable/persistence";
import { describe, expect, it } from "vitest";

import { consumeSlot, sendGuard } from "./SendGuard.ts";

import type { SendQuota } from "./SendGuard.ts";

const account = (quota: SendQuota | undefined, enforcement?: string) => ({
  SendQuota: quota,
  EnforcementStatus: enforcement,
});

const described = (states: ReadonlyArray<string>) => ({
  MetricAlarms: states.map((StateValue) => ({ StateValue })),
});

const silent = described([]);

const healthy = { MaxSendRate: 14, Max24HourSend: 200, SentLast24Hours: 0 } as const;

describe("sendGuard", () => {
  it("takes 80 percent of MaxSendRate, floored, and is not exhausted below 90 percent of Max24HourSend", () => {
    expect(
      sendGuard(
        account({ MaxSendRate: 14, Max24HourSend: 200, SentLast24Hours: 179 }),
        silent,
        undefined,
      ),
    ).toStrictEqual({ limit: 11, dailyExhausted: false, halted: false });
    expect(
      sendGuard(
        account({ MaxSendRate: 14, Max24HourSend: 200, SentLast24Hours: 180 }),
        silent,
        undefined,
      ),
    ).toStrictEqual({ limit: 11, dailyExhausted: true, halted: false });
  });

  it("uses 1 when MaxSendRate is undefined", () => {
    expect(
      sendGuard(account({ Max24HourSend: 200, SentLast24Hours: 0 }), silent, undefined),
    ).toStrictEqual({ limit: 1, dailyExhausted: false, halted: false });
    expect(sendGuard(account(undefined), silent, undefined)).toStrictEqual({
      limit: 1,
      dailyExhausted: false,
      halted: false,
    });
  });

  it("is never exhausted when Max24HourSend is undefined", () => {
    expect(
      sendGuard(account({ MaxSendRate: 10, SentLast24Hours: 1_000_000 }), silent, 1),
    ).toStrictEqual({ limit: 8, dailyExhausted: false, halted: false });
  });

  it("exhausts at the lower of the 90 percent quota and the daily ceiling", () => {
    expect(
      sendGuard(account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 50 }), silent, 50),
    ).toStrictEqual({ limit: 8, dailyExhausted: true, halted: false });
    expect(
      sendGuard(account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 49 }), silent, 50),
    ).toStrictEqual({ limit: 8, dailyExhausted: false, halted: false });
    expect(
      sendGuard(
        account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 180 }),
        silent,
        500,
      ),
    ).toStrictEqual({ limit: 8, dailyExhausted: true, halted: false });
    expect(
      sendGuard(
        account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 179 }),
        silent,
        500,
      ),
    ).toStrictEqual({ limit: 8, dailyExhausted: false, halted: false });
  });

  it("is not exhausted when Max24HourSend is -1, which SES reports for an unlimited quota", () => {
    expect(
      sendGuard(
        account({ MaxSendRate: 10, Max24HourSend: -1, SentLast24Hours: 1_000_000 }),
        silent,
        undefined,
      ),
    ).toStrictEqual({ limit: 8, dailyExhausted: false, halted: false });
  });

  it("exhausts an unlimited quota at the daily ceiling", () => {
    expect(
      sendGuard(account({ MaxSendRate: 10, Max24HourSend: -1, SentLast24Hours: 50 }), silent, 50),
    ).toStrictEqual({ limit: 8, dailyExhausted: true, halted: false });
    expect(
      sendGuard(account({ MaxSendRate: 10, Max24HourSend: -1, SentLast24Hours: 49 }), silent, 50),
    ).toStrictEqual({ limit: 8, dailyExhausted: false, halted: false });
  });

  it("is halted when any of four metric alarms is in ALARM", () => {
    expect(
      sendGuard(account(healthy), described(["OK", "ALARM", "INSUFFICIENT_DATA", "OK"]), undefined),
    ).toStrictEqual({ limit: 11, dailyExhausted: false, halted: true });
  });

  it("is not halted when every alarm is OK or INSUFFICIENT_DATA", () => {
    expect(
      sendGuard(account(healthy), described(["OK", "OK", "INSUFFICIENT_DATA", "OK"]), undefined),
    ).toStrictEqual({ limit: 11, dailyExhausted: false, halted: false });
  });

  it("is halted when EnforcementStatus is PROBATION or SHUTDOWN", () => {
    expect(sendGuard(account(healthy, "PROBATION"), silent, undefined)).toStrictEqual({
      limit: 11,
      dailyExhausted: false,
      halted: true,
    });
    expect(sendGuard(account(healthy, "SHUTDOWN"), silent, undefined)).toStrictEqual({
      limit: 11,
      dailyExhausted: false,
      halted: true,
    });
  });

  it("is not halted when EnforcementStatus is HEALTHY, which every sending account reports", () => {
    expect(sendGuard(account(healthy, "HEALTHY"), silent, undefined)).toStrictEqual({
      limit: 11,
      dailyExhausted: false,
      halted: false,
    });
  });

  it("is not halted when EnforcementStatus is missing", () => {
    expect(sendGuard(account(healthy), silent, undefined)).toStrictEqual({
      limit: 11,
      dailyExhausted: false,
      halted: false,
    });
  });
});

describe("consumeSlot", () => {
  it("admits the limit within one window and delays the next caller to the following one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const delays = yield* Effect.all([consumeSlot(2), consumeSlot(2), consumeSlot(2)]);

        expect(delays.map(Duration.toMillis)).toStrictEqual([0, 0, 1000]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
            TestClock.layer(),
          ),
        ),
      ),
    ));
});
