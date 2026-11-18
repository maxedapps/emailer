import { NodeCrypto } from "@effect/platform-node";
import { Stack } from "alchemy";
import * as AWS from "@alchemy.run/aws";
import { Config, DateTime, Duration, Effect, Layer, Schema } from "effect";

import { classify, decodeEmailEvent } from "./FeedbackClassification.ts";
import { nowIso } from "../Identifiers.ts";
import { functionServicesLayer, lambdaBasics } from "../Lambda.ts";
import { failingInvocation } from "../Reporting.ts";
import { trackedConfigurationSet, untrackedConfigurationSet } from "../sending/Mailer.ts";
import { queueBacklogAlarm } from "../sending/Reputation.ts";
import { FeedbackStore } from "../storage/Feedback.ts";

import type { EmailEvent, FeedbackEvent, OpenEvent } from "./FeedbackClassification.ts";

const invocationTimeout = Duration.seconds(30);

/**
 * Where SQS parks a feedback event the consumer accepted and could not process after its retries.
 * Five receives is the AWS starting point. Without it, a suppression that fails to persist because
 * the table is briefly unavailable would take the bounce with it. Recovery is an SQS redrive of
 * that message. Fourteen days is the maximum SQS allows, and the point here is retention rather
 * than throughput.
 */
const feedbackFailures = AWS.SQS.Queue("FeedbackFailures", {
  messageRetentionPeriod: Duration.days(14),
  sqsManagedSseEnabled: true,
});

/** Deploy-time only: the stack yields it, no function does. */
export const feedbackFailuresAlarm = queueBacklogAlarm(
  "FeedbackFailuresVisible",
  "Feedback events Lambda could not process are waiting to be redriven.",
  feedbackFailures,
);

/** Named, so the queue policy below can state the queue's ARN without waiting on the queue. */
const feedbackEventsName = Effect.map(Stack, ({ stage }) => `emailer-${stage}-feedback-events`);

/**
 * The queue's visibility timeout: a message whose invocation failed is delivered again after this.
 * Three minutes covers a 30-second feedback invocation by AWS's 6×-timeout recommendation.
 */
export const feedbackRedelivery = Duration.minutes(3);

/**
 * Standard queue of SES feedback events, redelivered after `feedbackRedelivery`. Source retention
 * is the SQS default of four days, shorter than the dead-letter queue.
 */
const feedbackEvents = AWS.SQS.Queue(
  "FeedbackEvents",
  Effect.gen(function* () {
    const failures = yield* feedbackFailures;

    return {
      queueName: yield* feedbackEventsName,
      visibilityTimeout: feedbackRedelivery,
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
 * The default-bus rule that puts SES bounce, complaint and open events on the queue, and
 * the queue policy that lets EventBridge send them. Deploy-time only, like `feedbackPublishing`:
 * `alchemy.run.ts` yields this and the function's constructor does not.
 *
 * `events(...).toQueue(...)` would write the queue's policy against its own ARN output and the
 * rule's, while the rule targets the queue: cycles Alchemy beta.87 cannot create on a fresh stage,
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
      "detail-type": ["Email Bounced", "Email Complaint Received", "Email Opened"],
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

const contactTag = "contactId";

const sendTag = "sendId";

const variantTag = "variant";

/**
 * This stage's configuration sets. The default bus carries every stage's SES events in the
 * account and region, so an event from any other set is not this stage's.
 */
export const expectedConfigurationSets = Config.all([
  Config.String("EMAILER_TRACKED_CONFIGURATION_SET"),
  Config.String("EMAILER_UNTRACKED_CONFIGURATION_SET"),
]);

type ConfigurationSets = ReadonlyArray<string>;

const tagOf = (event: EmailEvent, name: string) => event.mail.tags?.[name]?.[0];

const record = Effect.fn("Feedback.record")(function* (event: FeedbackEvent) {
  const classified = classify(event);
  const campaignId = tagOf(event, campaignTag);
  const variant = tagOf(event, variantTag);
  const messageId = event.mail.messageId;

  const storage = yield* FeedbackStore;
  const receivedAt = yield* nowIso;

  // The mailbox comes first and holds for every mail, campaign or not, so it does not depend on a
  // campaign that may be unknown or gone, nor on the history write.
  for (const recipient of classified.recipients) {
    if (classified.suppress) {
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

    if (classified.transientAt !== undefined) {
      yield* storage.addTransientBounce({
        email: recipient,
        occurredAt: classified.transientAt,
        feedbackId: classified.feedbackId,
      });
    }
  }

  // Every campaign send is tagged with its campaign; a test copy and a sign-up's confirmation
  // deliberately are not, so their feedback reaches the mailbox and no campaign's counters.
  if (campaignId === undefined) {
    return yield* Effect.logInfo("feedback without a campaign tag", {
      messageId,
      kind: classified.kind,
      suppressed: classified.suppress,
    });
  }

  for (const recipient of classified.recipients) {
    yield* storage
      .recordFeedback(
        {
          campaignId,
          kind: classified.kind,
          feedbackId: classified.feedbackId,
          recipient,
          messageId,
          variant,
          outcome: classified.outcome,
          receivedAt,
          bounceType: classified.bounceType,
          bounceSubType: classified.bounceSubType,
          complaintFeedbackType: classified.complaintFeedbackType,
          complaintSubType: classified.complaintSubType,
        },
        classified.counter,
      )
      .pipe(
        Effect.catchTags({
          FeedbackAlreadyRecorded: () =>
            Effect.logDebug("duplicate feedback event", { campaignId, kind: classified.kind }),
          CampaignNotFound: () =>
            Effect.logWarning("feedback event for unknown campaign", {
              campaignId,
              kind: classified.kind,
            }),
        }),
      );
  }

  yield* Effect.logInfo("feedback recorded", {
    campaignId,
    kind: classified.kind,
    recipients: classified.recipients.length,
    suppressed: classified.suppress,
    classification: classified.classification,
  });
});

/**
 * One open of a campaign's mail, recorded on its send row and its copy's counters. Neither the IP
 * address nor the user agent is kept or logged (ADR-0042).
 */
const recordOpen = Effect.fn("Feedback.recordOpen")(function* (
  event: OpenEvent,
  envelopeId: string,
) {
  const messageId = event.mail.messageId;

  // SES's own guess: a link scanner or a security gateway loading the pixel is nobody reading.
  if (event.open.isBotEvent === "Likely") {
    return yield* Effect.logInfo("open ignored", { envelopeId, messageId, reason: "bot" });
  }

  const campaignId = tagOf(event, campaignTag);
  const contactId = tagOf(event, contactTag);
  const sendId = tagOf(event, sendTag);

  if (campaignId === undefined || contactId === undefined || sendId === undefined) {
    return yield* Effect.logInfo("open ignored", { envelopeId, messageId, reason: "untagged" });
  }

  const storage = yield* FeedbackStore;

  yield* storage
    .recordOpen({
      campaignId,
      contactId,
      sendId,
      eventId: envelopeId,
      openedAt: DateTime.formatIso(event.open.timestamp),
    })
    .pipe(
      Effect.flatMap((open) => Effect.logInfo("open recorded", { campaignId, sendId, open })),
      Effect.catchTag("SendNotFound", () =>
        Effect.logWarning("open ignored", { campaignId, sendId, reason: "no send row" }),
      ),
    );
});

const handleEvent = Effect.fn("Feedback.handleEvent")((
  expected: ConfigurationSets,
  event: EmailEvent,
  envelopeId: string,
) => {
  const configurationSet = tagOf(event, configurationSetTag);

  if (configurationSet === undefined || !expected.includes(configurationSet)) {
    return Effect.logInfo("feedback event from another configuration set", {
      envelopeId,
      messageId: event.mail.messageId,
    });
  }

  return event.eventType === "Open" ? recordOpen(event, envelopeId) : record(event);
});

/**
 * One queue message: the EventBridge envelope around an SES event. A body that is not an envelope
 * fails the invocation, so SQS dead-letters it like any other failure.
 */
export const handleMessage = (expected: ConfigurationSets, body: string) =>
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
  const basics = yield* lambdaBasics("feedback");

  const tracked = yield* trackedConfigurationSet;
  const untracked = yield* untrackedConfigurationSet;

  return {
    ...basics,
    main: import.meta.url,
    memorySize: 256,
    timeout: invocationTimeout,
    functionUrl: false,
    env: {
      EMAILER_TRACKED_CONFIGURATION_SET: tracked.configurationSetName,
      EMAILER_UNTRACKED_CONFIGURATION_SET: untracked.configurationSetName,
    },
  } as const;
});

/** Every service an event uses, bound once per instance. */
const feedbackLayer = Layer.mergeAll(FeedbackStore.layer, functionServicesLayer).pipe(
  Layer.provideMerge(NodeCrypto.layerSecureRandom),
);

export default class FeedbackFunction extends AWS.Lambda.Function<FeedbackFunction>()(
  "Feedback",
  feedbackProps,
  Effect.gen(function* () {
    const services = yield* Layer.build(feedbackLayer);

    yield* AWS.SQS.consumeQueueMessages(yield* feedbackEvents, { batchSize: 1 }, (event) =>
      Effect.gen(function* () {
        const expected = yield* expectedConfigurationSets;

        yield* Effect.forEach(event.Records, (message) => handleMessage(expected, message.body), {
          discard: true,
        });
      }).pipe(failingInvocation, Effect.provideContext(services)),
    );

    return {};
  }).pipe(Effect.provide(AWS.Lambda.QueueEventSource)),
) {}
