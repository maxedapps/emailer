import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { sendGuard } from "./SendGuard.ts";

import type { SendQuota } from "./SendGuard.ts";

const account = (quota: SendQuota | undefined, enforcement?: string) => () =>
  Effect.succeed({ SendQuota: quota, EnforcementStatus: enforcement });

const described = (states: ReadonlyArray<string>) => () =>
  Effect.succeed({ MetricAlarms: states.map((StateValue) => ({ StateValue })) });

const silent = described([]);

const healthy = { MaxSendRate: 14, Max24HourSend: 200, SentLast24Hours: 0 } as const;

describe("sendGuard", () => {
  it("takes 80 percent of MaxSendRate, floored, and is not exhausted below 90 percent of Max24HourSend", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* sendGuard(
            account({ MaxSendRate: 14, Max24HourSend: 200, SentLast24Hours: 179 }),
            silent,
            undefined,
          ),
        ).toStrictEqual({ limit: 11, dailyExhausted: false, halted: false });
        expect(
          yield* sendGuard(
            account({ MaxSendRate: 14, Max24HourSend: 200, SentLast24Hours: 180 }),
            silent,
            undefined,
          ),
        ).toStrictEqual({ limit: 11, dailyExhausted: true, halted: false });
      }),
    ));

  it("uses 1 when MaxSendRate is undefined", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* sendGuard(account({ Max24HourSend: 200, SentLast24Hours: 0 }), silent, undefined),
        ).toStrictEqual({ limit: 1, dailyExhausted: false, halted: false });
        expect(yield* sendGuard(account(undefined), silent, undefined)).toStrictEqual({
          limit: 1,
          dailyExhausted: false,
          halted: false,
        });
      }),
    ));

  it("is never exhausted when Max24HourSend is undefined", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* sendGuard(account({ MaxSendRate: 10, SentLast24Hours: 1_000_000 }), silent, 1),
        ).toStrictEqual({ limit: 8, dailyExhausted: false, halted: false });
      }),
    ));

  it("exhausts at the lower of the 90 percent quota and the daily ceiling", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* sendGuard(
            account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 50 }),
            silent,
            50,
          ),
        ).toStrictEqual({ limit: 8, dailyExhausted: true, halted: false });
        expect(
          yield* sendGuard(
            account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 49 }),
            silent,
            50,
          ),
        ).toStrictEqual({ limit: 8, dailyExhausted: false, halted: false });
        expect(
          yield* sendGuard(
            account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 180 }),
            silent,
            500,
          ),
        ).toStrictEqual({ limit: 8, dailyExhausted: true, halted: false });
        expect(
          yield* sendGuard(
            account({ MaxSendRate: 10, Max24HourSend: 200, SentLast24Hours: 179 }),
            silent,
            500,
          ),
        ).toStrictEqual({ limit: 8, dailyExhausted: false, halted: false });
      }),
    ));

  it("is not exhausted when Max24HourSend is -1, which SES reports for an unlimited quota", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* sendGuard(
            account({ MaxSendRate: 10, Max24HourSend: -1, SentLast24Hours: 1_000_000 }),
            silent,
            undefined,
          ),
        ).toStrictEqual({ limit: 8, dailyExhausted: false, halted: false });
      }),
    ));

  it("exhausts an unlimited quota at the daily ceiling", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* sendGuard(
            account({ MaxSendRate: 10, Max24HourSend: -1, SentLast24Hours: 50 }),
            silent,
            50,
          ),
        ).toStrictEqual({ limit: 8, dailyExhausted: true, halted: false });
        expect(
          yield* sendGuard(
            account({ MaxSendRate: 10, Max24HourSend: -1, SentLast24Hours: 49 }),
            silent,
            50,
          ),
        ).toStrictEqual({ limit: 8, dailyExhausted: false, halted: false });
      }),
    ));

  it("is halted when any of four metric alarms is in ALARM", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* sendGuard(
            account(healthy),
            described(["OK", "ALARM", "INSUFFICIENT_DATA", "OK"]),
            undefined,
          ),
        ).toStrictEqual({ limit: 11, dailyExhausted: false, halted: true });
      }),
    ));

  it("is not halted when every alarm is OK or INSUFFICIENT_DATA", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* sendGuard(
            account(healthy),
            described(["OK", "OK", "INSUFFICIENT_DATA", "OK"]),
            undefined,
          ),
        ).toStrictEqual({ limit: 11, dailyExhausted: false, halted: false });
      }),
    ));

  it("is halted when EnforcementStatus is PROBATION or SHUTDOWN", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* sendGuard(account(healthy, "PROBATION"), silent, undefined)).toStrictEqual({
          limit: 11,
          dailyExhausted: false,
          halted: true,
        });
        expect(yield* sendGuard(account(healthy, "SHUTDOWN"), silent, undefined)).toStrictEqual({
          limit: 11,
          dailyExhausted: false,
          halted: true,
        });
      }),
    ));

  it("is not halted when EnforcementStatus is HEALTHY, which every sending account reports", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* sendGuard(account(healthy, "HEALTHY"), silent, undefined)).toStrictEqual({
          limit: 11,
          dailyExhausted: false,
          halted: false,
        });
      }),
    ));

  it("is not halted when EnforcementStatus is missing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* sendGuard(account(healthy), silent, undefined)).toStrictEqual({
          limit: 11,
          dailyExhausted: false,
          halted: false,
        });
      }),
    ));
});
