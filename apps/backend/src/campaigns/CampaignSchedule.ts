import type * as scheduler from "@distilled.cloud/aws/scheduler";
import * as AWS from "alchemy/AWS";
import { Context, Effect, Layer } from "effect";

import {
  dispatchQueue,
  encodeDispatchMessage,
  scheduleGroup,
  schedulerRole,
} from "../sending/Dispatch.ts";
import { unavailable } from "../storage/Errors.ts";

import type { StorageFailure } from "../storage/Errors.ts";

/** One-shot EventBridge schedules that wake a campaign at its send time. */
export class CampaignSchedule extends Context.Service<
  CampaignSchedule,
  {
    readonly create: (
      campaignId: string,
      runToken: string,
      sendAt: string,
    ) => Effect.Effect<void, StorageFailure>;
    readonly remove: (runToken: string) => Effect.Effect<void, StorageFailure>;
  }
>()("emailer/backend/CampaignSchedule") {}

export const campaignSchedule = (
  createSchedule: (
    request: AWS.Scheduler.CreateScheduleRequest,
  ) => Effect.Effect<scheduler.CreateScheduleOutput, scheduler.CreateScheduleError>,
  deleteSchedule: (
    request: AWS.Scheduler.DeleteScheduleRequest,
  ) => Effect.Effect<scheduler.DeleteScheduleOutput, scheduler.DeleteScheduleError>,
  queueArn: Effect.Effect<string>,
) =>
  CampaignSchedule.of({
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
        Effect.mapError(unavailable("schedule")),
        Effect.asVoid,
      ),
    remove: (runToken: string) =>
      deleteSchedule({ Name: runToken }).pipe(
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.mapError(unavailable("schedule")),
        Effect.asVoid,
      ),
  });

export const CampaignScheduleLive = Layer.effect(CampaignSchedule)(
  Effect.gen(function* () {
    const group = yield* scheduleGroup;
    const queue = yield* dispatchQueue;

    return campaignSchedule(
      yield* AWS.Scheduler.CreateSchedule(yield* schedulerRole, group),
      yield* AWS.Scheduler.DeleteSchedule(group),
      yield* queue.queueArn,
    );
  }),
).pipe(
  Layer.provide(Layer.mergeAll(AWS.Scheduler.CreateScheduleHttp, AWS.Scheduler.DeleteScheduleHttp)),
);
