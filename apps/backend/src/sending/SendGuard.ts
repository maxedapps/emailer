import * as AWS from "alchemy/AWS";
import { Config, Context, Effect, Layer, Option } from "effect";
import { RateLimiter } from "effect/unstable/persistence";

import { reputationAlarms } from "./Reputation.ts";
import { RateLimitStoreLive } from "../storage/RateLimit.ts";

export interface SendQuota {
  readonly MaxSendRate?: number | undefined;
  readonly Max24HourSend?: number | undefined;
  readonly SentLast24Hours?: number | undefined;
}

export interface AccountStatus {
  readonly SendQuota?: SendQuota | undefined;
  readonly EnforcementStatus?: string | undefined;
}

export interface AlarmStates {
  readonly MetricAlarms?: ReadonlyArray<{ readonly StateValue?: string | undefined }> | undefined;
}

export interface SendAllowance {
  readonly limit: number;
  readonly dailyExhausted: boolean;
  readonly halted: boolean;
}

/**
 * Account-wide admission. Every sender — each dispatch slice and each test send — asks for the
 * current allowance before its first message, so no path can outrun the reputation guardrails or
 * the daily budget. Tests stub the service instead of the two AWS reads behind it.
 */
export class SendGuard extends Context.Service<
  SendGuard,
  {
    readonly current: Effect.Effect<SendAllowance>;
  }
>()("emailer/backend/SendGuard") {}

/**
 * The allowance a SES `GetAccount` response and the reputation alarms' states leave. `ceiling` is
 * the optional `EMAILER_DAILY_SEND_CEILING`.
 */
export const sendGuard = (
  account: AccountStatus,
  alarms: AlarmStates,
  ceiling: number | undefined,
): SendAllowance => {
  const quota = account.SendQuota;
  const maxSendRate = quota?.MaxSendRate;
  const max24HourSend = quota?.Max24HourSend;
  const sentLast24Hours = quota?.SentLast24Hours ?? 0;
  const alarmed = (alarms.MetricAlarms ?? []).some((alarm) => alarm.StateValue === "ALARM");

  const enforcement =
    account.EnforcementStatus !== undefined && account.EnforcementStatus !== "HEALTHY";

  // SES reports -1 for an account without a daily quota; only the ceiling then limits the day.
  const quotaLimit =
    max24HourSend === undefined || max24HourSend < 0 ? Infinity : max24HourSend * 0.9;

  return {
    limit: maxSendRate === undefined ? 1 : Math.max(1, Math.floor(maxSendRate * 0.8)),
    dailyExhausted:
      max24HourSend !== undefined && sentLast24Hours >= Math.min(quotaLimit, ceiling ?? Infinity),
    halted: alarmed || enforcement,
  };
};

const dailySendCeiling = Config.option(Config.Int("EMAILER_DAILY_SEND_CEILING"));

export const SendGuardLive = Layer.effect(SendGuard)(
  Effect.gen(function* () {
    const getAccount = yield* AWS.SES.GetAccount();
    const describeAlarms = yield* AWS.CloudWatch.DescribeAlarms(...(yield* reputationAlarms));
    // Constructor Config is a deploy-time capture, which is what the optional
    // daily ceiling wants: the value is fixed for the function's lifetime.
    const ceiling = Option.getOrUndefined(yield* dailySendCeiling);

    // The binding types its failure as `any`; like the account read, it is a defect here.
    const alarmStates: Effect.Effect<AlarmStates> = Effect.orDie(describeAlarms());

    return SendGuard.of({
      // Two independent reads; neither depends on the other.
      current: Effect.zip(getAccount(), alarmStates, { concurrent: true }).pipe(
        Effect.map(([account, alarms]) => sendGuard(account, alarms, ceiling)),
        Effect.orDie,
      ),
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(AWS.SES.GetAccountHttp, AWS.CloudWatch.DescribeAlarmsHttp)));

export const SendPacingLive = RateLimiter.layer.pipe(Layer.provide(RateLimitStoreLive));

const limiterWindow = "1 second";

/** One key for the whole account: campaigns and test sends draw on the same SES rate. */
const limiterKey = "ses-send";

/** Reserves the next send slot and answers how long to wait before using it. */
export const consumeSlot = (limit: number) =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter.RateLimiter;

    const consumed = yield* limiter.consume({
      key: limiterKey,
      window: limiterWindow,
      limit,
      onExceeded: "delay",
      algorithm: "fixed-window",
    });

    return consumed.delay;
  });
