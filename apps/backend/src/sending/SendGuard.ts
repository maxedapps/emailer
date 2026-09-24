import type * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Config, Context, Duration, Effect, Layer, Option } from "effect";
import { RateLimiter } from "effect/unstable/persistence";

import { reputationAlarms } from "./Reputation.ts";
import { unavailable } from "../storage/Errors.ts";
import { RateLimitStoreLive } from "../storage/RateLimit.ts";

import type { StorageFailure } from "../storage/Errors.ts";

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
  /** Why nothing may be sent now. A reputation halt outranks a spent daily budget. */
  readonly refusal?: Schemas.SendingPaused["reason"];
}

/**
 * Account-wide admission. Every sender — each dispatch slice and each test send — asks for the
 * current allowance before its first message and takes a pacing slot before each one, so no path
 * can outrun the reputation guardrails, the daily budget or the account's send rate. Tests stub
 * the service instead of the AWS reads and the rate limiter behind it.
 */
export class SendGuard extends Context.Service<
  SendGuard,
  {
    readonly current: Effect.Effect<SendAllowance, StorageFailure>;
    /**
     * Reserves the next send slot at `limit` per second and answers how long to wait before using
     * it. It does not wait itself, so a dispatch slice can first check the wait against its budget.
     */
    readonly slot: (limit: number) => Effect.Effect<Duration.Duration, StorageFailure>;
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

  const limit = maxSendRate === undefined ? 1 : Math.max(1, Math.floor(maxSendRate * 0.8));

  if (alarmed || enforcement) {
    return { limit, refusal: "reputation" };
  }

  if (max24HourSend !== undefined && sentLast24Hours >= Math.min(quotaLimit, ceiling ?? Infinity)) {
    return { limit, refusal: "daily-quota" };
  }

  return { limit };
};

const limiterWindow = "1 second";

/** One key for the whole account: campaigns and test sends draw on the same SES rate. */
const limiterKey = "ses-send";

/** The pacing slot over a rate limiter: fixed windows in delay mode queue every sender in turn. */
export const makeSlot = (limiter: RateLimiter.RateLimiter) => (limit: number) =>
  limiter
    .consume({
      key: limiterKey,
      window: limiterWindow,
      limit,
      onExceeded: "delay",
      algorithm: "fixed-window",
    })
    .pipe(
      Effect.map((consumed) => consumed.delay),
      Effect.mapError(unavailable("pacing")),
    );

const dailySendCeiling = Config.option(Config.Int("EMAILER_DAILY_SEND_CEILING"));

export const SendGuardLive = Layer.effect(SendGuard)(
  Effect.gen(function* () {
    const getAccount = yield* AWS.SES.GetAccount();
    const describeAlarms = yield* AWS.CloudWatch.DescribeAlarms(...(yield* reputationAlarms));
    const limiter = yield* RateLimiter.make;
    // Constructor Config is a deploy-time capture, which is what the optional
    // daily ceiling wants: the value is fixed for the function's lifetime.
    const ceiling = Option.getOrUndefined(yield* dailySendCeiling);

    // The binding types its failure as `any`; mapping it here restores a typed failure.
    const alarmStates: Effect.Effect<AlarmStates, StorageFailure> = Effect.mapError(
      describeAlarms(),
      unavailable("describeAlarms"),
    );

    return SendGuard.of({
      // Two independent reads; neither depends on the other.
      current: Effect.zip(
        getAccount().pipe(Effect.mapError(unavailable("getAccount"))),
        alarmStates,
        { concurrent: true },
      ).pipe(Effect.map(([account, alarms]) => sendGuard(account, alarms, ceiling))),
      slot: makeSlot(limiter),
    });
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(AWS.SES.GetAccountHttp, AWS.CloudWatch.DescribeAlarmsHttp, RateLimitStoreLive),
  ),
);
