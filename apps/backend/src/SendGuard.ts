import { Effect, Layer } from "effect";
import { RateLimiter } from "effect/unstable/persistence";

import { RateLimitStoreLive } from "./Storage/RateLimit.ts";

export interface SendQuota {
  readonly MaxSendRate?: number | undefined;
  readonly Max24HourSend?: number | undefined;
  readonly SentLast24Hours?: number | undefined;
}

export interface SendGuard {
  readonly limit: number;
  readonly dailyExhausted: boolean;
  readonly halted: boolean;
}

export const SendPacingLive = RateLimiter.layer.pipe(Layer.provide(RateLimitStoreLive));

/**
 * Per-run send guard from a SES `GetAccount` response and CloudWatch alarm
 * states. `ceiling` is the optional `EMAILER_DAILY_SEND_CEILING`; the dispatcher
 * reads Config and passes it in.
 */
export const sendGuard = <EA, RA, ED, RD>(
  getAccount: () => Effect.Effect<
    {
      readonly SendQuota?: SendQuota | undefined;
      readonly EnforcementStatus?: string | undefined;
    },
    EA,
    RA
  >,
  describeAlarms: () => Effect.Effect<
    {
      readonly MetricAlarms?:
        | ReadonlyArray<{ readonly StateValue?: string | undefined }>
        | undefined;
    },
    ED,
    RD
  >,
  ceiling: number | undefined,
): Effect.Effect<SendGuard, EA | ED, RA | RD> =>
  Effect.gen(function* () {
    // Two independent reads at every slice start; neither depends on the other.
    const [account, described] = yield* Effect.all([getAccount(), describeAlarms()], {
      concurrency: 2,
    });

    const quota = account.SendQuota;
    const maxSendRate = quota?.MaxSendRate;
    const max24HourSend = quota?.Max24HourSend;
    const sentLast24Hours = quota?.SentLast24Hours ?? 0;
    const alarmed = (described.MetricAlarms ?? []).some((alarm) => alarm.StateValue === "ALARM");

    const enforcement =
      account.EnforcementStatus !== undefined && account.EnforcementStatus !== "HEALTHY";

    return {
      limit: maxSendRate === undefined ? 1 : Math.max(1, Math.floor(maxSendRate * 0.8)),
      dailyExhausted:
        max24HourSend === undefined
          ? false
          : sentLast24Hours >=
            (ceiling === undefined ? max24HourSend * 0.9 : Math.min(max24HourSend * 0.9, ceiling)),
      halted: alarmed || enforcement,
    };
  });
