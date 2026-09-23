import { NodeCrypto } from "@effect/platform-node";
import { Stack } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Clock, Duration, Effect, Layer, Stream } from "effect";
import { RateLimiter } from "effect/unstable/persistence";

import { CampaignWake } from "../campaigns/Campaigns.ts";
import { reportedAndFatal } from "../Diagnostics.ts";
import { decodeDispatchMessage, dispatchQueue, encodeDispatchMessage } from "./Dispatch.ts";
import { runSlice } from "./Dispatching.ts";
import { Mailer, MailerLive } from "./Mailer.ts";
import { SendGuard, SendGuardLive, SendPacingLive } from "./SendGuard.ts";
import { AudienceStore, AudienceStoreLive } from "../storage/Audience.ts";
import { CampaignStore, CampaignStoreLive } from "../storage/Campaigns.ts";
import { unavailable } from "../storage/Errors.ts";
import { UnsubscribeFunction, unsubscribeSecret } from "../consent/Unsubscribe.ts";

const logRetention = Duration.days(7);

const invocationTimeout = Duration.minutes(5);

const dispatcherProps = Effect.gen(function* () {
  const { stage } = yield* Stack;
  const functionName = `emailer-${stage}-dispatcher`;

  const logGroup = yield* AWS.Logs.LogGroup("DispatcherLogs", {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logRetention,
  });

  const unsubscribe = yield* UnsubscribeFunction;
  const secret = yield* unsubscribeSecret;

  return {
    functionName,
    main: import.meta.url,
    runtime: "nodejs24.x",
    architecture: "arm64",
    memorySize: 512,
    timeout: invocationTimeout,
    functionUrl: false,
    env: {
      EMAILER_LOG_GROUP: logGroup.logGroupName,
      EMAILER_UNSUBSCRIBE_URL: unsubscribe.functionUrl,
      EMAILER_UNSUBSCRIBE_SECRET: secret.text,
    },
  } as const;
});

export default class DispatcherFunction extends AWS.Lambda.Function<DispatcherFunction>()(
  "Dispatcher",
  dispatcherProps,
  Effect.gen(function* () {
    const audience = yield* AudienceStore;
    const campaigns = yield* CampaignStore;
    const mailer = yield* Mailer;
    const limiter = yield* RateLimiter.RateLimiter;
    const queue = yield* dispatchQueue;
    const sendMessage = yield* AWS.SQS.SendMessage(queue);
    const guard = yield* SendGuard;

    const capabilities = Layer.mergeAll(
      Layer.succeed(AudienceStore)(audience),
      Layer.succeed(CampaignStore)(campaigns),
      Layer.succeed(Mailer)(mailer),
      Layer.succeed(RateLimiter.RateLimiter)(limiter),
      Layer.succeed(CampaignWake)({
        enqueue: (campaignId, runToken) =>
          encodeDispatchMessage({ campaignId, runToken }).pipe(
            Effect.orDie,
            Effect.flatMap((MessageBody) => sendMessage({ MessageBody })),
            Effect.mapError(unavailable("dispatch")),
            Effect.asVoid,
          ),
      }),
      Layer.succeed(SendGuard)(guard),
      NodeCrypto.layer,
    );

    yield* AWS.SQS.consumeQueueMessages(queue, { batchSize: 1 }, (records) =>
      Stream.runForEach(records, (record) =>
        Effect.gen(function* () {
          const message = yield* decodeDispatchMessage(record.body);
          const now = yield* Clock.currentTimeMillis;

          yield* runSlice(message, now + Duration.toMillis(invocationTimeout));
        }),
      ).pipe(Effect.provide(capabilities), reportedAndFatal),
    );

    return {};
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        MailerLive,
        CampaignStoreLive,
        AudienceStoreLive,
        SendGuardLive,
        SendPacingLive,
        AWS.Lambda.QueueEventSource,
        AWS.SQS.SendMessageHttp,
      ).pipe(Layer.provide(NodeCrypto.layer)),
    ),
  ),
) {}
