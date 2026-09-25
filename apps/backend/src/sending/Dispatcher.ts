import { NodeCrypto } from "@effect/platform-node";
import * as AWS from "alchemy/AWS";
import { Clock, Duration, Effect, Layer, Stream } from "effect";

import { UnsubscribeFunction, unsubscribeSecret } from "../consent/Unsubscribe.ts";
import { functionServicesLayer, lambdaBasics } from "../Lambda.ts";
import { failingInvocation } from "../Reporting.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { decodeDispatchMessage, dispatchQueue, CampaignWake } from "./Dispatch.ts";
import { runSlice } from "./Dispatching.ts";
import { Mailer } from "./Mailer.ts";
import { SendGuard } from "./SendGuard.ts";

const invocationTimeout = Duration.minutes(5);

const sliceMargin = Duration.seconds(30);

const dispatcherProps = Effect.gen(function* () {
  const basics = yield* lambdaBasics("Dispatcher", "dispatcher");

  const unsubscribe = yield* UnsubscribeFunction;
  const secret = yield* unsubscribeSecret;

  return {
    ...basics,
    main: import.meta.url,
    memorySize: 512,
    timeout: invocationTimeout,
    functionUrl: false,
    env: {
      EMAILER_UNSUBSCRIBE_URL: unsubscribe.functionUrl,
      EMAILER_UNSUBSCRIBE_SECRET: secret.text,
    },
  } as const;
});

/** Every service a slice uses, bound once per instance. */
const dispatcherLayer = Layer.mergeAll(
  AudienceStore.layer,
  CampaignStore.layer,
  Mailer.layer,
  SendGuard.layer,
  CampaignWake.layer,
  functionServicesLayer,
).pipe(Layer.provideMerge(NodeCrypto.layer));

export default class DispatcherFunction extends AWS.Lambda.Function<DispatcherFunction>()(
  "Dispatcher",
  dispatcherProps,
  Effect.gen(function* () {
    const services = yield* Layer.build(dispatcherLayer);

    yield* AWS.SQS.consumeQueueMessages(yield* dispatchQueue, { batchSize: 1 }, (records) =>
      Stream.runForEach(records, (record) =>
        Effect.gen(function* () {
          const message = yield* decodeDispatchMessage(record.body);
          const now = yield* Clock.currentTimeMillis;

          // The reservation covers one attempt; the margin covers a rate-limited retry tail.
          yield* runSlice(
            message,
            now + Duration.toMillis(invocationTimeout) - Duration.toMillis(sliceMargin),
          );
        }),
      ).pipe(failingInvocation, Effect.provideContext(services)),
    );

    return {};
  }).pipe(Effect.provide(AWS.Lambda.QueueEventSource)),
) {}
