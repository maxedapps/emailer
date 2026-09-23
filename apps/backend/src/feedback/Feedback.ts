import { NodeCrypto } from "@effect/platform-node";
import * as AWS from "alchemy/AWS";
import { Config, Duration, Effect, Layer, Stream } from "effect";

import { reportedAndFatal } from "../Diagnostics.ts";
import { classify, decodeEmailEvent } from "./FeedbackClassification.ts";
import { nowIso } from "../Identifiers.ts";
import { lambdaBasics } from "../Lambda.ts";
import { configurationSet } from "../sending/Mailer.ts";
import { FeedbackStore, FeedbackStoreLive } from "../storage/Feedback.ts";

import type { ClassifiedFeedback, EmailEvent } from "./FeedbackClassification.ts";

const invocationTimeout = Duration.seconds(30);

/**
 * Where Lambda puts an event it accepted and could not process after its retries.
 *
 * Without this the event was simply gone: a suppression that failed to persist because the table
 * was briefly unavailable took the bounce with it, and nothing recorded that it had happened. The
 * queue does not repair anything by itself — `ReplayFeedback.ts` is the repair — but it keeps the
 * original event long enough for someone to act on it.
 *
 * Fourteen days is the maximum SQS allows, and the point here is retention rather than throughput.
 * The visibility timeout is longer than the replay's own invoke bound so that a message being
 * replayed is not handed to a second operator mid-flight.
 */
export const feedbackFailures = AWS.SQS.Queue("FeedbackFailures", {
  messageRetentionPeriod: Duration.days(14),
  visibilityTimeout: Duration.seconds(120),
  sqsManagedSseEnabled: true,
});

const configurationSetTag = "ses:configuration-set";

const campaignTag = "campaignId";

export const expectedConfigurationSet = Config.string("EMAILER_CONFIGURATION_SET");

const countsOf = (classified: ClassifiedFeedback) => ({
  bounced: classified.classification === "permanent-bounce" ? classified.recipients.length : 0,
  complained: classified.classification === "complaint" ? classified.recipients.length : 0,
  echoes: classified.classification === "suppression-echo" ? classified.recipients.length : 0,
  transient: classified.classification === "transient-bounce" ? classified.recipients.length : 0,
});

const record = (event: EmailEvent) =>
  Effect.gen(function* () {
    const classified = classify(event);
    const campaignId = event.mail.tags?.[campaignTag]?.[0];
    const messageId = event.mail.messageId;

    if (classified.classification === "delay") {
      return yield* Effect.logInfo("delivery delayed", {
        delayType: classified.delayType,
        recipients: classified.recipients.length,
        campaignId,
        messageId,
        expirationTime: classified.expirationTime,
      });
    }

    const storage = yield* FeedbackStore;
    const receivedAt = yield* nowIso;

    if (classified.suppress) {
      for (const recipient of classified.recipients) {
        yield* storage.suppressAddress({
          email: recipient,
          reason: classified.kind,
          messageId,
          feedbackId: classified.feedbackId,
          bounceSubType: classified.bounceSubType,
          complaintFeedbackType: classified.complaintFeedbackType,
          complaintSubType: classified.complaintSubType,
          suppressedAt: receivedAt,
        });
      }
    }

    // Every campaign send is tagged with its campaign; a test send deliberately is not, so its
    // bounces and complaints suppress the address without reaching any campaign's counters.
    if (campaignId === undefined) {
      return yield* Effect.logInfo("feedback without a campaign tag (a test send)", {
        messageId,
        kind: classified.kind,
        suppressed: classified.suppress,
      });
    }

    for (const recipient of classified.recipients) {
      const outcome = yield* storage.recordFeedback(
        {
          campaignId,
          kind: classified.kind,
          feedbackId: classified.feedbackId,
          recipient,
          messageId,
          outcome: classified.outcome,
          receivedAt,
          bounceType: classified.bounceType,
          bounceSubType: classified.bounceSubType,
          complaintFeedbackType: classified.complaintFeedbackType,
          complaintSubType: classified.complaintSubType,
        },
        classified.write,
      );

      if (outcome === "unknown-campaign") {
        yield* Effect.logWarning("feedback event for unknown campaign", {
          campaignId,
          kind: classified.kind,
        });
      } else if (outcome === "duplicate") {
        yield* Effect.logDebug("duplicate feedback event", {
          campaignId,
          kind: classified.kind,
        });
      }
    }

    yield* Effect.logInfo("feedback recorded", {
      campaignId,
      kind: classified.kind,
      recipients: classified.recipients.length,
      suppressed: classified.suppress,
      ...countsOf(classified),
    });
  });

export const handleEvent = Effect.fn("Feedback.handleEvent")((
  expected: string,
  detail: AWS.SES.EmailEventDetail,
  envelopeId: string,
) => {
  const messageId = detail.mail?.messageId;

  if (detail.mail?.tags?.[configurationSetTag]?.[0] !== expected) {
    return Effect.logInfo("feedback event from another configuration set", {
      envelopeId,
      messageId,
    });
  }

  return decodeEmailEvent(detail).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.logWarning("feedback event ignored", {
          envelopeId,
          messageId,
          eventType: detail.eventType,
          reason: "undecodable",
        }),
      onSuccess: record,
    }),
  );
});

const feedbackProps = Effect.gen(function* () {
  const { logGroupName, ...basics } = yield* lambdaBasics("Feedback", "feedback");

  const mail = yield* configurationSet;
  const failures = yield* feedbackFailures;

  return {
    ...basics,
    main: import.meta.url,
    memorySize: 256,
    timeout: invocationTimeout,
    functionUrl: false,
    // Lambda's own retry schedule is unchanged; this is what happens after it gives up. It covers
    // events Lambda accepted, and nothing upstream of that: an event SES or EventBridge never
    // delivered was never Lambda's to retain.
    eventInvokeConfig: { destinationConfig: { OnFailure: { Destination: failures.queueArn } } },
    env: {
      EMAILER_LOG_GROUP: logGroupName,
      EMAILER_CONFIGURATION_SET: mail.configurationSetName,
    },
  } as const;
});

/** Every service an event uses, bound once per instance. */
export const FeedbackLive = FeedbackStoreLive.pipe(Layer.provideMerge(NodeCrypto.layer));

export default class FeedbackFunction extends AWS.Lambda.Function<FeedbackFunction>()(
  "Feedback",
  feedbackProps,
  Effect.gen(function* () {
    const services = yield* Layer.build(FeedbackLive);

    // Constructed, never called. `OnFailure` names the queue but grants nothing, so without this
    // binding Lambda would be unable to deliver the failure record and the retention would be a
    // configuration that quietly does not work. Delivery is Lambda's to perform; duplicating it
    // here would write the event twice.
    yield* AWS.SQS.SendMessage(yield* feedbackFailures);

    yield* AWS.SES.consumeEmailEvents(
      { kinds: ["bounce", "complaint", "delivery-delay"] },
      (events) =>
        Effect.gen(function* () {
          const expected = yield* expectedConfigurationSet;

          yield* Stream.runForEach(events, (event) =>
            handleEvent(expected, event.detail, event.id),
          );
        }).pipe(Effect.provideContext(services), reportedAndFatal),
    );

    return {};
  }).pipe(Effect.provide(Layer.mergeAll(AWS.Lambda.EventSource, AWS.SQS.SendMessageHttp))),
) {}
