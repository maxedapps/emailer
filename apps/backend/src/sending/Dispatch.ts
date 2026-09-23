import { EntityId } from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Context, Duration, Effect, Layer, Schema } from "effect";

import { unavailable } from "../storage/Errors.ts";

import type { StorageFailure } from "../storage/Errors.ts";

/**
 * Campaign wake-up queue, message and sender. This module must not grow a Function class: the API
 * and the dispatcher both import it to wake campaigns, and an inline Function would pull the
 * dispatcher handler into the API bundle.
 */

/**
 * Where SQS parks a campaign wake-up the dispatcher accepted and could not process after its
 * retries. Five receives is the AWS starting point; a deterministic failure lands here and leaves
 * the campaign `sending`. Recovery is an SQS redrive of that message, not a resume. Fourteen days
 * is the maximum SQS allows, and the point here is retention rather than throughput.
 */
export const dispatchFailures = AWS.SQS.Queue("DispatchFailures", {
  messageRetentionPeriod: Duration.days(14),
  sqsManagedSseEnabled: true,
});

/**
 * Standard queue of campaign wake-ups. Visibility is 30 minutes so a 5-minute dispatcher
 * invocation is covered by AWS's 6×-timeout recommendation; a failed invocation delays the
 * campaign by that lease before SQS redelivers. Source retention is the SQS default of four days,
 * shorter than the dead-letter queue.
 *
 * The dead-letter ARN is taken from the yielded `dispatchFailures` resource: Queue attributes
 * exist only after registration, and a module-level resource re-yielded across modules registers
 * once.
 */
export const dispatchQueue = AWS.SQS.Queue(
  "Dispatch",
  Effect.gen(function* () {
    const failures = yield* dispatchFailures;

    return {
      visibilityTimeout: Duration.minutes(30),
      redrivePolicy: {
        deadLetterTargetArn: failures.queueArn,
        maxReceiveCount: 5,
      },
      sqsManagedSseEnabled: true,
      messageRetentionPeriod: Duration.days(4),
    };
  }),
);

/**
 * Stage-owned group for one-shot campaign schedules minted at runtime. A runtime-minted
 * schedule belongs to no Alchemy resource, so alchemy destroy cannot see it; putting every
 * schedule here means DeleteScheduleGroup removes them with the stage. The API function's
 * scheduler:CreateSchedule, scheduler:DeleteSchedule and iam:PassRole grants come from the
 * bindings, not from this module.
 */
export const scheduleGroup = AWS.Scheduler.ScheduleGroup("Schedules", {});

/**
 * Role EventBridge Scheduler assumes to send a wake-up to the dispatch queue.
 */
export const schedulerRole = AWS.IAM.Role(
  "SchedulerRole",
  Effect.gen(function* () {
    const queue = yield* dispatchQueue;

    return {
      assumeRolePolicyDocument: {
        Version: "2012-10-17" as const,
        Statement: [
          {
            Effect: "Allow" as const,
            Principal: { Service: "scheduler.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        DispatchWakeUp: {
          Version: "2012-10-17" as const,
          Statement: [
            {
              Effect: "Allow" as const,
              Action: ["sqs:SendMessage"],
              Resource: [queue.queueArn],
            },
          ],
        },
      },
    };
  }),
);

export const DispatchMessage = Schema.Struct({
  campaignId: EntityId,
  runToken: EntityId,
});

export type DispatchMessage = typeof DispatchMessage.Type;

export const decodeDispatchMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DispatchMessage),
);

export const encodeDispatchMessage = Schema.encodeUnknownEffect(
  Schema.fromJsonString(DispatchMessage),
);

/** Wakes a campaign's dispatcher run: the API when a send starts, the dispatcher per next slice. */
export class CampaignWake extends Context.Service<
  CampaignWake,
  {
    readonly enqueue: (campaignId: string, runToken: string) => Effect.Effect<void, StorageFailure>;
  }
>()("emailer/backend/CampaignWake") {}

export const CampaignWakeLive = Layer.effect(CampaignWake)(
  Effect.gen(function* () {
    const sendMessage = yield* AWS.SQS.SendMessage(yield* dispatchQueue);

    return CampaignWake.of({
      enqueue: (campaignId, runToken) =>
        encodeDispatchMessage({ campaignId, runToken }).pipe(
          Effect.orDie,
          Effect.flatMap((MessageBody) => sendMessage({ MessageBody })),
          Effect.mapError(unavailable("dispatch")),
          Effect.asVoid,
        ),
    });
  }),
).pipe(Layer.provide(AWS.SQS.SendMessageHttp));
