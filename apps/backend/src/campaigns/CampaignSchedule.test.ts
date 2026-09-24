import * as scheduler from "@distilled.cloud/aws/scheduler";
import { describe, expect, it } from "@effect/vitest";
import type * as AWS from "alchemy/AWS";
import { Effect, Result } from "effect";

import { campaignSchedule } from "./CampaignSchedule.ts";
import { decodeDispatchMessage, encodeDispatchMessage } from "../sending/Dispatch.ts";
import { StorageFailure } from "../storage/Errors.ts";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const runToken = "0195f0a0-1111-4222-8333-44444444e5d2";

const sendAt = "2099-01-01T00:00:00.000Z";

const queueArn = "arn:aws:sqs:eu-west-1:123456789012:jobs";

interface AwsDouble {
  readonly created: Array<AWS.Scheduler.CreateScheduleRequest>;
  readonly failCreate: (error: scheduler.CreateScheduleError) => void;
  readonly create: (
    request: AWS.Scheduler.CreateScheduleRequest,
  ) => Effect.Effect<scheduler.CreateScheduleOutput, scheduler.CreateScheduleError>;
}

const awsDouble = (): AwsDouble => {
  const created: Array<AWS.Scheduler.CreateScheduleRequest> = [];
  let createError: scheduler.CreateScheduleError | undefined;

  return {
    created,
    failCreate: (error) => {
      createError = error;
    },
    create: (request) =>
      Effect.gen(function* () {
        created.push(request);

        if (createError !== undefined) {
          return yield* createError;
        }

        return {
          ScheduleArn: `arn:aws:scheduler:eu-west-1:123456789012:schedule/${request.Name}`,
        };
      }),
  };
};

const adapterFor = (aws: AwsDouble) => campaignSchedule(aws.create, Effect.succeed(queueArn));

describe("campaignSchedule", () => {
  it.effect("creates a generation-named one-shot schedule that deletes itself after it fires", () =>
    Effect.gen(function* () {
      const aws = awsDouble();
      const schedules = adapterFor(aws);

      yield* schedules.create(campaignId, runToken, sendAt);

      expect(aws.created).toHaveLength(1);

      const request = aws.created[0];

      expect(request?.Name).toBe(runToken);
      expect(request?.ClientToken).toBe(runToken);
      expect(request?.ScheduleExpression).toBe(`at(${sendAt.slice(0, 19)})`);
      expect(request?.ScheduleExpressionTimezone).toBe("UTC");
      expect(request?.ActionAfterCompletion).toBe("DELETE");
      expect(request?.Target.Arn).toBe(queueArn);
      expect(request?.Target.Input).toBe(yield* encodeDispatchMessage({ campaignId, runToken }));
      expect(yield* decodeDispatchMessage(request?.Target.Input ?? "")).toStrictEqual({
        campaignId,
        runToken,
      });
    }),
  );

  it.effect("surfaces a create error as schedule unavailable", () =>
    Effect.gen(function* () {
      const aws = awsDouble();
      const schedules = adapterFor(aws);
      const conflict = new scheduler.ConflictException({ message: "exists" });

      aws.failCreate(conflict);

      const attempt = yield* Effect.result(schedules.create(campaignId, runToken, sendAt));

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
        new StorageFailure({
          operationId: "schedule",
          reason: "unavailable",
          cause: conflict,
        }),
      );
      expect(aws.created).toHaveLength(1);
    }),
  );
});
