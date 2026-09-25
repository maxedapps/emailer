import type * as scheduler from "@distilled.cloud/aws/scheduler";
import { SchedulerUnavailable } from "@emailer/api/Errors";
import * as AWS from "alchemy/AWS";
import { Context, Effect, Layer } from "effect";

import {
  dispatchQueue,
  encodeDispatchMessage,
  scheduleGroup,
  schedulerRole,
} from "../sending/Dispatch.ts";
import { unavailable } from "../Errors.ts";

export const campaignSchedule = (
  createSchedule: (
    request: AWS.Scheduler.CreateScheduleRequest,
  ) => Effect.Effect<scheduler.CreateScheduleOutput, scheduler.CreateScheduleError>,
  queueArn: Effect.Effect<string>,
) =>
  ({
    create: (campaignId: string, runToken: string, sendAt: string) =>
      encodeDispatchMessage({ campaignId, runToken }).pipe(
        Effect.orDie,
        Effect.flatMap((Input) =>
          Effect.flatMap(queueArn, (Arn) =>
            createSchedule({
              Name: runToken,
              // at() takes seconds; the contract's timestamp carries milliseconds.
              ScheduleExpression: `at(${sendAt.slice(0, 19)})`,
              ScheduleExpressionTimezone: "UTC",
              ActionAfterCompletion: "DELETE",
              ClientToken: runToken,
              Target: { Arn, Input },
            }),
          ),
        ),
        Effect.mapError(unavailable(SchedulerUnavailable, "schedule")),
        Effect.asVoid,
      ),
  }) as const;

/**
 * One-shot EventBridge schedules that wake a campaign at its send time, each named by its run
 * token. Nothing deletes one: it deletes itself once it has fired, and the fire of a schedule its
 * campaign has moved on from is discarded as stale.
 */
export class CampaignSchedule extends Context.Service<CampaignSchedule>()(
  "emailer/backend/CampaignSchedule",
  {
    make: Effect.gen(function* () {
      const group = yield* scheduleGroup;
      const queue = yield* dispatchQueue;

      return campaignSchedule(
        yield* AWS.Scheduler.CreateSchedule(yield* schedulerRole, group),
        yield* queue.queueArn,
      );
    }),
  },
) {}

export const CampaignScheduleLive = Layer.effect(CampaignSchedule)(CampaignSchedule.make).pipe(
  Layer.provide(AWS.Scheduler.CreateScheduleHttp),
);
