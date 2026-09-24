import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Context, Data, Duration, Effect, Layer } from "effect";

import { describeCause } from "../Errors.ts";
import { sendingIdentity } from "../identity/SendingIdentity.ts";
import { compose, fromHeader, senderSettings } from "./Message.ts";

import type { MessageContent } from "./Message.ts";
import type { SubmissionOutcome } from "../storage/Campaigns.ts";

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

/** SES refused the message for good; the code is what a send row or a test report records. */
export class SendRejected extends Data.TaggedError("SendRejected")<{
  readonly code: Exclude<Schemas.RejectionCode, "rate-limited" | "sending-paused">;
}> {}

/** SES is shedding load: the same message may be sent again shortly. */
export class SendThrottled extends Data.TaggedError("SendThrottled") {}

/** SES has stopped sending for the account or the configuration set. */
export class SendingSuspended extends Data.TaggedError("SendingSuspended") {}

/** Whether the message went out is unknown, so it must not be sent again. */
export class SubmissionUncertain extends Data.TaggedError("SubmissionUncertain")<{
  readonly reason: "timeout" | "transport" | "malformed-response";
}> {}

export type SendError = SendRejected | SendThrottled | SendingSuspended | SubmissionUncertain;

/** The SES errors that are answers; any other means the outcome is unknown. */
const refusals: Partial<
  Record<sesv2.SendEmailError["_tag"], () => SendRejected | SendThrottled | SendingSuspended>
> = {
  MessageRejected: () => new SendRejected({ code: "message-rejected" }),
  BadRequestException: () => new SendRejected({ code: "invalid-request" }),
  MailFromDomainNotVerifiedException: () => new SendRejected({ code: "identity-not-verified" }),
  NotFoundException: () => new SendRejected({ code: "identity-not-verified" }),
  SendingPausedException: () => new SendingSuspended(),
  AccountSuspendedException: () => new SendingSuspended(),
  TooManyRequestsException: () => new SendThrottled(),
  ThrottlingException: () => new SendThrottled(),
  LimitExceededException: () => new SendThrottled(),
};

const rejected = (rejectionCode: Schemas.RejectionCode): SubmissionOutcome => ({
  outcome: "rejected",
  rejectionCode,
});

/** What a send row or a test report records for a message SES accepted. */
export const accepted = (messageId: string): SubmissionOutcome => ({
  outcome: "accepted",
  messageId,
});

/**
 * What a send row or a test report records for each send error, as `Effect.catchTags` handlers.
 * Throttled and suspended are rejections too, under the codes that also pause a run.
 */
export const failureOutcomes = {
  SendRejected: ({ code }: SendRejected) => Effect.succeed(rejected(code)),
  SendThrottled: () => Effect.succeed(rejected("rate-limited")),
  SendingSuspended: () => Effect.succeed(rejected("sending-paused")),
  SubmissionUncertain: () => Effect.succeed<SubmissionOutcome>({ outcome: "uncertain" }),
};

export const feedbackPublishing = Effect.gen(function* () {
  const mail = yield* configurationSet;
  const { accountId, region } = yield* AWS.AWSEnvironment.current;

  return yield* AWS.SES.ConfigurationSetEventDestination(eventDestinationLogicalId, {
    configurationSetName: mail.configurationSetName,
    matchingEventTypes: ["BOUNCE", "COMPLAINT"],
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
  ): Effect.Effect<string, SendError> =>
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

      // Callers learn only that the outcome is unknown; why is logged here, where it is
      // classified, reduced so neither the recipient nor an SDK payload reaches the log.
      const uncertain = (reason: SubmissionUncertain["reason"], cause: unknown) =>
        Effect.logWarning("submission uncertain", {
          ...purpose,
          reason,
          cause: describeCause(cause),
        }).pipe(Effect.andThen(Effect.fail(new SubmissionUncertain({ reason }))));

      const response = yield* sendEmail(
        purpose.kind === "campaign" ? { ...request, EmailTags: tagsFor(purpose) } : request,
      ).pipe(
        Retry.none,
        Effect.catch((error): Effect.Effect<never, SendError> => {
          const refusal = refusals[error._tag];

          return refusal === undefined ? uncertain("transport", error) : Effect.fail(refusal());
        }),
        Effect.timeout(submissionTimeout),
        Effect.catchTag("TimeoutError", (timeout) => uncertain("timeout", timeout)),
      );

      if (response.MessageId === undefined || response.MessageId.length === 0) {
        return yield* uncertain("malformed-response", response);
      }

      return response.MessageId;
    });

export class Mailer extends Context.Service<Mailer>()("emailer/backend/Mailer", {
  make: Effect.gen(function* () {
    const settings = yield* senderSettings;

    const identity = yield* sendingIdentity;

    const mail = yield* configurationSet;
    const sendEmail = yield* AWS.SES.SendEmail(identity, mail);

    return {
      send: Effect.fn("Mailer.send")(
        makeSend(
          sendEmail,
          fromHeader(settings.sender, settings.senderName),
          settings.postalAddress,
        ),
      ),
    } as const;
  }),
}) {}

export const MailerLive = Layer.effect(Mailer)(Mailer.make).pipe(
  Layer.provide(AWS.SES.SendEmailHttp),
);
