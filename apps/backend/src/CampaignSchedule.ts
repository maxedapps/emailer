import type * as scheduler from "@distilled.cloud/aws/scheduler";
import type * as AWS from "alchemy/AWS";
import { Effect } from "effect";

import { encodeDispatchMessage } from "./Dispatch.ts";
import { unavailable } from "./Storage/Errors.ts";

export const campaignSchedule = (
  createSchedule: (
    request: AWS.Scheduler.CreateScheduleRequest,
  ) => Effect.Effect<scheduler.CreateScheduleOutput, scheduler.CreateScheduleError>,
  deleteSchedule: (
    request: AWS.Scheduler.DeleteScheduleRequest,
  ) => Effect.Effect<scheduler.DeleteScheduleOutput, scheduler.DeleteScheduleError>,
  queueArn: Effect.Effect<string>,
) => ({
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
