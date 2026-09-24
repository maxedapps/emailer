import { NodeCrypto } from "@effect/platform-node";
import { Stack } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Config, Duration, Effect, Layer, Schema, Stream } from "effect";

import { reportedAndFatal } from "../Diagnostics.ts";
import { classify, decodeEmailEvent } from "./FeedbackClassification.ts";
import { nowIso } from "../Identifiers.ts";
import { lambdaBasics } from "../Lambda.ts";
import { configurationSet } from "../sending/Mailer.ts";
import { FeedbackStore, FeedbackStoreLive } from "../storage/Feedback.ts";

import type { EmailEvent } from "./FeedbackClassification.ts";

const invocationTimeout = Duration.seconds(30);

/**
 * Where SQS parks a feedback event the consumer accepted and could not process after its retries.
 * Five receives is the AWS starting point. Without it, a suppression that fails to persist because
 * the table is briefly unavailable would take the bounce with it. Recovery is an SQS redrive of
 * that message. Fourteen days is the maximum SQS allows, and the point here is retention rather
 * than throughput.
 */
export const feedbackFailures = AWS.SQS.Queue("FeedbackFailures", {
  messageRetentionPeriod: Duration.days(14),
  sqsManagedSseEnabled: true,
});

/** Named, so the queue policy below can state the queue's ARN without waiting on the queue. */
const feedbackEventsName = Effect.map(Stack, ({ stage }) => `emailer-${stage}-feedback-events`);

/**
 * Standard queue of SES feedback events. Visibility is 3 minutes so a 30-second feedback
 * invocation is covered by AWS's 6×-timeout recommendation. Source retention is the SQS default of
 * four days, shorter than the dead-letter queue.
 */
const feedbackEvents = AWS.SQS.Queue(
  "FeedbackEvents",
  Effect.gen(function* () {
    const failures = yield* feedbackFailures;

    return {
      queueName: yield* feedbackEventsName,
      visibilityTimeout: Duration.minutes(3),
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
 * The default-bus rule that puts SES bounce, complaint and delivery-delay events on the queue, and
 * the queue policy that lets EventBridge send them. Deploy-time only, like `feedbackPublishing`:
 * `alchemy.run.ts` yields this and the function's constructor does not.
 *
 * `events(...).toQueue(...)` would write the queue's policy against its own ARN output and the
 * rule's, while the rule targets the queue: cycles Alchemy beta.79 cannot create on a fresh stage,
 * since neither a queue nor a rule can be created ahead of its inputs. Both are named instead, so
 * the policy states both ARNs up front and the queue is created before the rule.
 */
export const feedbackRouting = Effect.gen(function* () {
  const queue = yield* feedbackEvents;
  const { stage } = yield* Stack;
  const { accountId, region } = yield* AWS.AWSEnvironment.current;
  const ruleName = `emailer-${stage}-ses-feedback`;
  const queueArn = `arn:aws:sqs:${region}:${accountId}:${yield* feedbackEventsName}`;

  yield* AWS.EventBridge.Rule("SESFeedbackEvents", {
    name: ruleName,
    eventPattern: {
      source: ["aws.ses"],
      "detail-type": ["Email Bounced", "Email Complaint Received", "Email Delivery Delayed"],
    },
    targets: [{ Id: "FeedbackEvents", Arn: queue.queueArn }],
  });

  yield* queue.bind`Allow(SESFeedbackEvents, SendMessage(${queue}))`({
    policyStatements: [
      {
        Effect: "Allow",
        Principal: { Service: "events.amazonaws.com" },
        Action: ["sqs:SendMessage"],
        Resource: [queueArn],
        Condition: {
          ArnEquals: {
            "aws:SourceArn": [`arn:aws:events:${region}:${accountId}:rule/${ruleName}`],
          },
        },
      },
    ],
  });
});

/**
 * The EventBridge event as the rule delivers it. `detail` is decoded separately, so an SES event
 * this system does not model is ignored rather than failing the whole message.
 */
const decodeEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, detail: Schema.Unknown })),
);

const configurationSetTag = "ses:configuration-set";

const campaignTag = "campaignId";

export const expectedConfigurationSet = Config.String("EMAILER_CONFIGURATION_SET");

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
      classification: classified.classification,
    });
  });

const handleEvent = Effect.fn("Feedback.handleEvent")((
  expected: string,
  event: EmailEvent,
  envelopeId: string,
) => {
  if (event.mail.tags?.[configurationSetTag]?.[0] !== expected) {
    return Effect.logInfo("feedback event from another configuration set", {
      envelopeId,
      messageId: event.mail.messageId,
    });
  }

  return record(event);
});

/**
 * One queue message: the EventBridge envelope around an SES event. A body that is not an envelope
 * fails the invocation, so SQS dead-letters it like any other failure.
 */
export const handleMessage = (expected: string, body: string) =>
  decodeEnvelope(body).pipe(
    Effect.flatMap((envelope) =>
      decodeEmailEvent(envelope.detail).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.logWarning("feedback event ignored", {
              envelopeId: envelope.id,
              reason: "undecodable",
            }),
          onSuccess: (event) => handleEvent(expected, event, envelope.id),
        }),
      ),
    ),
  );

const feedbackProps = Effect.gen(function* () {
  const { logGroupName, ...basics } = yield* lambdaBasics("Feedback", "feedback");

  const mail = yield* configurationSet;

  return {
    ...basics,
    main: import.meta.url,
    memorySize: 256,
    timeout: invocationTimeout,
    functionUrl: false,
    env: {
      EMAILER_LOG_GROUP: logGroupName,
      EMAILER_CONFIGURATION_SET: mail.configurationSetName,
    },
  } as const;
});

/** Every service an event uses, bound once per instance. */
const FeedbackLive = FeedbackStoreLive.pipe(Layer.provideMerge(NodeCrypto.layer));

export default class FeedbackFunction extends AWS.Lambda.Function<FeedbackFunction>()(
  "Feedback",
  feedbackProps,
  Effect.gen(function* () {
    const services = yield* Layer.build(FeedbackLive);

    yield* AWS.SQS.consumeQueueMessages(yield* feedbackEvents, { batchSize: 1 }, (records) =>
      Effect.gen(function* () {
        const expected = yield* expectedConfigurationSet;

        yield* Stream.runForEach(records, (message) => handleMessage(expected, message.body));
      }).pipe(Effect.provideContext(services), reportedAndFatal),
    );

    return {};
  }).pipe(Effect.provide(AWS.Lambda.QueueEventSource)),
) {}
