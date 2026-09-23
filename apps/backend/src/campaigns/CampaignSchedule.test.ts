import * as scheduler from "@distilled.cloud/aws/scheduler";
import type * as AWS from "alchemy/AWS";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";

import { campaignSchedule } from "./CampaignSchedule.ts";
import { decodeDispatchMessage, encodeDispatchMessage } from "../sending/Dispatch.ts";
import { StorageFailure } from "../storage/Errors.ts";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const runToken = "0195f0a0-1111-4222-8333-44444444e5d2";

const sendAt = "2099-01-01T00:00:00.000Z";

const queueArn = "arn:aws:sqs:eu-west-1:123456789012:jobs";

interface AwsDouble {
  readonly created: Array<AWS.Scheduler.CreateScheduleRequest>;
  readonly deleted: Array<AWS.Scheduler.DeleteScheduleRequest>;
  readonly failCreate: (error: scheduler.CreateScheduleError) => void;
  readonly failDelete: (error: scheduler.DeleteScheduleError) => void;
  readonly create: (
    request: AWS.Scheduler.CreateScheduleRequest,
  ) => Effect.Effect<scheduler.CreateScheduleOutput, scheduler.CreateScheduleError>;
  readonly delete: (
    request: AWS.Scheduler.DeleteScheduleRequest,
  ) => Effect.Effect<scheduler.DeleteScheduleOutput, scheduler.DeleteScheduleError>;
}

const awsDouble = (): AwsDouble => {
  const created: Array<AWS.Scheduler.CreateScheduleRequest> = [];
  const deleted: Array<AWS.Scheduler.DeleteScheduleRequest> = [];
  let createError: scheduler.CreateScheduleError | undefined;
  let deleteError: scheduler.DeleteScheduleError | undefined;

  return {
    created,
    deleted,
    failCreate: (error) => {
      createError = error;
    },
    failDelete: (error) => {
      deleteError = error;
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
    delete: (request) =>
      Effect.gen(function* () {
        deleted.push(request);

        if (deleteError !== undefined) {
          return yield* deleteError;
        }

        return {};
      }),
  };
};

const adapterFor = (aws: AwsDouble) =>
  campaignSchedule(aws.create, aws.delete, Effect.succeed(queueArn));

describe("campaignSchedule", () => {
  it("creates a generation-named one-shot schedule and does not delete", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const aws = awsDouble();
        const schedules = adapterFor(aws);

        yield* schedules.create(campaignId, runToken, sendAt);

        expect(aws.created).toHaveLength(1);
        expect(aws.deleted).toHaveLength(0);

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
    ));

  it("removes by run token and treats ResourceNotFoundException as success", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const aws = awsDouble();
        const schedules = adapterFor(aws);

        aws.failDelete(new scheduler.ResourceNotFoundException({ message: "gone" }));

        yield* schedules.remove(runToken);

        expect(aws.deleted).toStrictEqual([{ Name: runToken }]);
        expect(aws.created).toHaveLength(0);
      }),
    ));

  it("surfaces a different delete error as schedule unavailable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const aws = awsDouble();
        const schedules = adapterFor(aws);
        const conflict = new scheduler.ConflictException({ message: "exists" });

        aws.failDelete(conflict);

        const attempt = yield* Effect.result(schedules.remove(runToken));

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
          new StorageFailure({
            operationId: "schedule",
            reason: "unavailable",
            cause: conflict,
          }),
        );
        expect(aws.deleted).toStrictEqual([{ Name: runToken }]);
      }),
    ));

  it("does not delete when create fails", () =>
    Effect.runPromise(
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
        expect(aws.deleted).toHaveLength(0);
      }),
    ));
});
