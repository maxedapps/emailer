import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Context, Data, Duration, Effect, Layer } from "effect";

import { describeCause } from "../Diagnostics.ts";
import { sendingIdentity } from "../identity/SendingIdentity.ts";
import { compose, fromHeader, senderSettings } from "./Message.ts";

import type { MessageContent } from "./Message.ts";

const configurationSetLogicalId = "EmailerMail";

const eventDestinationLogicalId = "EmailerMailFeedback";

export const configurationSet = AWS.SES.ConfigurationSet(configurationSetLogicalId, {
  suppressedReasons: ["BOUNCE", "COMPLAINT"],
  reputationMetricsEnabled: true,
});

export const submissionTimeout = Duration.seconds(8);

/**
 * Why a message goes out. A campaign send is tagged so its feedback lands on the campaign's
 * counters; a test send carries no tags, so its bounces and complaints never reach them.
 */
export type SendPurpose =
  | { readonly kind: "campaign"; readonly campaignId: string; readonly sendId: string }
  | { readonly kind: "test" };

export type SubmissionOutcome =
  | { readonly outcome: "accepted"; readonly messageId: string }
  | { readonly outcome: "rejected"; readonly rejectionCode: Schemas.RejectionCode };

export class SubmissionUncertain extends Data.TaggedError("SubmissionUncertain")<{
  readonly reason: "timeout" | "transport" | "malformed-response";
  readonly cause: unknown;
}> {}

const rejectionCodes: Partial<Record<sesv2.SendEmailError["_tag"], Schemas.RejectionCode>> = {
  MessageRejected: "message-rejected",
  BadRequestException: "invalid-request",
  MailFromDomainNotVerifiedException: "identity-not-verified",
  NotFoundException: "identity-not-verified",
  SendingPausedException: "sending-paused",
  AccountSuspendedException: "sending-paused",
  TooManyRequestsException: "rate-limited",
  ThrottlingException: "rate-limited",
  LimitExceededException: "rate-limited",
};

export class Mailer extends Context.Service<
  Mailer,
  {
    readonly send: (
      recipient: string,
      content: MessageContent,
      unsubscribeUrl: string,
      purpose: SendPurpose,
    ) => Effect.Effect<SubmissionOutcome, SubmissionUncertain>;
  }
>()("emailer/backend/Mailer") {}

export const feedbackPublishing = Effect.gen(function* () {
  const mail = yield* configurationSet;
  const { accountId, region } = yield* AWS.AWSEnvironment.current;

  return yield* AWS.SES.ConfigurationSetEventDestination(eventDestinationLogicalId, {
    configurationSetName: mail.configurationSetName,
    matchingEventTypes: ["BOUNCE", "COMPLAINT", "DELIVERY_DELAY"],
    eventBridgeDestination: {
      eventBusArn: `arn:aws:events:${region}:${accountId}:event-bus/default`,
    },
  });
});

const tagsFor = (purpose: SendPurpose & { readonly kind: "campaign" }) => [
  { Name: "campaignId", Value: purpose.campaignId },
  { Name: "sendId", Value: purpose.sendId },
];

export const makeSend =
  (
    sendEmail: (
      request: AWS.SES.SendEmailRequest,
    ) => Effect.Effect<sesv2.SendEmailResponse, sesv2.SendEmailError>,
    from: string,
    postal: string,
  ) =>
  (
    recipient: string,
    content: MessageContent,
    unsubscribeUrl: string,
    purpose: SendPurpose,
  ): Effect.Effect<SubmissionOutcome, SubmissionUncertain> =>
    Effect.gen(function* () {
      const message = compose(content, unsubscribeUrl, postal);
      const text = { Text: { Data: message.text, Charset: "UTF-8" } };

      const request: AWS.SES.SendEmailRequest = {
        FromEmailAddress: from,
        Destination: { ToAddresses: [recipient] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body:
              message.html === undefined
                ? text
                : { ...text, Html: { Data: message.html, Charset: "UTF-8" } },
            Headers: message.headers.map(({ name, value }) => ({ Name: name, Value: value })),
          },
        },
      };

      return yield* sendEmail(
        purpose.kind === "campaign" ? { ...request, EmailTags: tagsFor(purpose) } : request,
      ).pipe(
        Retry.none,
        Effect.matchEffect({
          onFailure: (error): Effect.Effect<SubmissionOutcome, SubmissionUncertain> => {
            const rejectionCode = rejectionCodes[error._tag];

            return rejectionCode === undefined
              ? Effect.fail(new SubmissionUncertain({ reason: "transport", cause: error }))
              : Effect.succeed({ outcome: "rejected", rejectionCode });
          },
          onSuccess: (response): Effect.Effect<SubmissionOutcome, SubmissionUncertain> => {
            const messageId = response.MessageId;

            return messageId === undefined || messageId.length === 0
              ? Effect.fail(
                  new SubmissionUncertain({ reason: "malformed-response", cause: response }),
                )
              : Effect.succeed({ outcome: "accepted", messageId });
          },
        }),
        Effect.timeout(submissionTimeout),
        Effect.catchTag("TimeoutError", (cause) =>
          Effect.fail(new SubmissionUncertain({ reason: "timeout", cause })),
        ),
        // Callers record only that the outcome is unknown; why is logged here, where it is
        // classified, reduced so neither the recipient nor an SDK payload reaches the log.
        Effect.tapError((uncertain) =>
          Effect.logWarning("submission uncertain", {
            ...purpose,
            reason: uncertain.reason,
            cause: describeCause(uncertain.cause),
          }),
        ),
      );
    });

export const MailerLive = Layer.effect(Mailer)(
  Effect.gen(function* () {
    const settings = yield* senderSettings;

    const identity = yield* sendingIdentity;

    const mail = yield* configurationSet;
    const sendEmail = yield* AWS.SES.SendEmail(identity, mail);

    return Mailer.of({
      send: Effect.fn("Mailer.send")(
        makeSend(
          sendEmail,
          fromHeader(settings.sender, settings.senderName),
          settings.postalAddress,
        ),
      ),
    });
  }),
).pipe(Layer.provide(AWS.SES.SendEmailHttp));
