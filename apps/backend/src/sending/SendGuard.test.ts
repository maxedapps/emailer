import type * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { RateLimiter } from "effect/unstable/persistence";

import { makeSlot, recentAllowance, sendGuard } from "./SendGuard.ts";

import type { SendAllowance } from "./SendGuard.ts";

const account = (
  quota: sesv2.SendQuota | undefined,
  enforcement?: string,
): sesv2.GetAccountResponse => {
  const response: sesv2.GetAccountResponse = {};

  if (quota !== undefined) {
    response.SendQuota = quota;
  }

  if (enforcement !== undefined) {
    response.EnforcementStatus = enforcement;
  }

  return response;
};

const described = (
  states: ReadonlyArray<cloudwatch.StateValue>,
): cloudwatch.DescribeAlarmsOutput => ({
  // The SDK's output type makes these three required on every alarm; only the state matters here.
  MetricAlarms: states.map((StateValue) => ({
    StateValue,
    Dimensions: [],
    Metrics: [],
    WarmUpConfiguration: { WarmUpPeriodDurationInMinutes: 0 },
  })),
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
    ).toStrictEqual({ limit: 11 });
    expect(
      sendGuard(
        account({ MaxSendRate: 14, Max24HourSend: 200, SentLast24Hours: 180 }),
        silent,
        undefined,
      ),
    ).toStrictEqual({ limit: 11, refusal: "daily-quota" });
  });

  it("uses 1 when MaxSendRate is undefined", () => {
    expect(
      sendGuard(account({ Max24HourSend: 200, SentLast24Hours: 0 }), silent, undefined),
    ).toStrictEqual({ limit: 1 });
    expect(sendGuard(account(undefined), silent, undefined)).toStrictEqual({ limit: 1 });
  });

  it("is never exhausted when Max24HourSend is undefined", () => {
    expect(
      sendGuard(account({ MaxSendRate: 10, SentLast24Hours: 1_000_000 }), silent, 1),
    ).toStrictEqual({ limit: 8 });
  });

  it("exhausts at the lower of the 90 percent quota and the daily ceiling", () => {
    expect(
      sendGuard(account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 50 }), silent, 50),
    ).toStrictEqual({ limit: 8, refusal: "daily-quota" });
    expect(
      sendGuard(account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 49 }), silent, 50),
    ).toStrictEqual({ limit: 8 });
    expect(
      sendGuard(
        account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 180 }),
        silent,
        500,
      ),
    ).toStrictEqual({ limit: 8, refusal: "daily-quota" });
    expect(
      sendGuard(
        account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 179 }),
        silent,
        500,
      ),
    ).toStrictEqual({ limit: 8 });
  });

  it("is not exhausted when Max24HourSend is -1, which SES reports for an unlimited quota", () => {
    expect(
      sendGuard(
        account({ MaxSendRate: 10, Max24HourSend: -1, SentLast24Hours: 1_000_000 }),
        silent,
        undefined,
      ),
    ).toStrictEqual({ limit: 8 });
  });

  it("exhausts an unlimited quota at the daily ceiling", () => {
    expect(
      sendGuard(account({ MaxSendRate: 10, Max24HourSend: -1, SentLast24Hours: 50 }), silent, 50),
    ).toStrictEqual({ limit: 8, refusal: "daily-quota" });
    expect(
      sendGuard(account({ MaxSendRate: 10, Max24HourSend: -1, SentLast24Hours: 49 }), silent, 50),
    ).toStrictEqual({ limit: 8 });
  });

  it("is halted when any of four metric alarms is in ALARM", () => {
    expect(
      sendGuard(account(healthy), described(["OK", "ALARM", "INSUFFICIENT_DATA", "OK"]), undefined),
    ).toStrictEqual({ limit: 11, refusal: "reputation" });
  });

  it("is not halted when every alarm is OK or INSUFFICIENT_DATA", () => {
    expect(
      sendGuard(account(healthy), described(["OK", "OK", "INSUFFICIENT_DATA", "OK"]), undefined),
    ).toStrictEqual({ limit: 11 });
  });

  it("is halted when EnforcementStatus is PROBATION or SHUTDOWN", () => {
    expect(sendGuard(account(healthy, "PROBATION"), silent, undefined)).toStrictEqual({
      limit: 11,
      refusal: "reputation",
    });
    expect(sendGuard(account(healthy, "SHUTDOWN"), silent, undefined)).toStrictEqual({
      limit: 11,
      refusal: "reputation",
    });
  });

  it("is not halted when EnforcementStatus is HEALTHY, which every sending account reports", () => {
    expect(sendGuard(account(healthy, "HEALTHY"), silent, undefined)).toStrictEqual({ limit: 11 });
  });

  it("is not halted when EnforcementStatus is missing", () => {
    expect(sendGuard(account(healthy), silent, undefined)).toStrictEqual({ limit: 11 });
  });

  it("refuses for reputation, not the daily quota, when both apply", () => {
    expect(
      sendGuard(
        account({ MaxSendRate: 14, Max24HourSend: 200, SentLast24Hours: 200 }),
        described(["ALARM"]),
        undefined,
      ),
    ).toStrictEqual({ limit: 11, refusal: "reputation" });
  });
});

describe("makeSlot", () => {
  it.effect(
    "paces on the one ses-send key: the limit within one window, then a delay to the following one",
    () =>
      Effect.gen(function* () {
        const memory = yield* RateLimiter.RateLimiterStore;
        const keys: Array<string> = [];

        const recording = RateLimiter.RateLimiterStore.of({
          ...memory,
          fixedWindow: (options) => {
            keys.push(options.key);

            return memory.fixedWindow(options);
          },
        });

        const slot = makeSlot(
          yield* RateLimiter.make.pipe(
            Effect.provideService(RateLimiter.RateLimiterStore, recording),
          ),
        );

        const delays = yield* Effect.all([slot(2), slot(2), slot(2)]);

        expect(delays.map(Duration.toMillis)).toStrictEqual([0, 0, 1000]);
        expect(keys).toStrictEqual(["ses-send", "ses-send", "ses-send"]);
      }).pipe(Effect.provide(RateLimiter.layerStoreMemory)),
  );
});

describe("recentAllowance", () => {
  it.effect("keeps only a successful read, so the next caller retries a failed one", () =>
    Effect.gen(function* () {
      const outcomes: Array<Effect.Effect<SendAllowance, "throttled">> = [
        Effect.fail("throttled"),
        Effect.succeed({ limit: 11 }),
      ];

      let reads = 0;

      const recent = yield* recentAllowance(
        Effect.suspend(() => {
          reads += 1;

          return outcomes.shift() ?? Effect.die(new Error("read a third time"));
        }),
      );

      expect(yield* Effect.flip(recent)).toBe("throttled");
      expect(yield* recent).toStrictEqual({ limit: 11 });
      expect(yield* recent).toStrictEqual({ limit: 11 });
      expect(reads).toBe(2);
    }),
  );
});
