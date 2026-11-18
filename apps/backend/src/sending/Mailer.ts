import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "@alchemy.run/aws";
import { Context, Data, Duration, Effect, Layer } from "effect";

import { describeCause } from "../Errors.ts";
import { sendingIdentity } from "../identity/SendingIdentity.ts";
import { compose, composeConfirmation, fromHeader, senderSettings } from "./Message.ts";

import type { MessageContent } from "./Message.ts";
import type { SubmissionOutcome } from "../storage/Campaigns.ts";

const suppression = {
  suppressedReasons: ["BOUNCE", "COMPLAINT"],
  reputationMetricsEnabled: true,
} satisfies AWS.SES.ConfigurationSetProps;

/**
 * Campaign mail. It publishes opens, which makes SES put its open pixel into every HTML part sent
 * through it (ADR-0042).
 */
export const trackedConfigurationSet = AWS.SES.ConfigurationSet("EmailerMail", suppression);

/**
 * Test copies and sign-up confirmations: the same suppression, and no open pixel, since publishing
 * no opens is what keeps SES from inserting one.
 */
export const untrackedConfigurationSet = AWS.SES.ConfigurationSet(
  "EmailerUntrackedMail",
  suppression,
);

export const submissionTimeout = Duration.seconds(8);

/**
 * What goes out, and why. Campaign and test mail carry content already rendered for their
 * recipient. A campaign mail goes through the tracked configuration set, tagged so its feedback
 * lands on the campaign's counters and its opens on the recipient's send row, and names the copy it
 * drew. A test copy and a sign-up's confirmation go untracked and carry no tags, so their bounces
 * and complaints reach no campaign.
 */
export type Mail = Data.TaggedEnum<{
  Campaign: {
    readonly content: MessageContent;
    readonly unsubscribeUrl: string;
    readonly campaignId: string;
    readonly contactId: string;
    readonly sendId: string;
    readonly variant: Schemas.CopyKey;
  };
  Test: { readonly content: MessageContent; readonly unsubscribeUrl: string };
  Confirmation: { readonly listName: string; readonly confirmUrl: string };
}>;

export const Mail = Data.taggedEnum<Mail>();

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

/** Both sets publish bounces and complaints to the default bus; only campaign mail its opens. */
export const feedbackPublishing = Effect.gen(function* () {
  const tracked = yield* trackedConfigurationSet;
  const untracked = yield* untrackedConfigurationSet;
  const { accountId, region } = yield* AWS.AWSEnvironment.current;

  const eventBridgeDestination = {
    eventBusArn: `arn:aws:events:${region}:${accountId}:event-bus/default`,
  };

  yield* AWS.SES.ConfigurationSetEventDestination("EmailerMailFeedback", {
    configurationSetName: tracked.configurationSetName,
    matchingEventTypes: ["BOUNCE", "COMPLAINT", "OPEN"],
    eventBridgeDestination,
  });

  yield* AWS.SES.ConfigurationSetEventDestination("EmailerUntrackedMailFeedback", {
    configurationSetName: untracked.configurationSetName,
    matchingEventTypes: ["BOUNCE", "COMPLAINT"],
    eventBridgeDestination,
  });
});

type SendEmail = (
  request: AWS.SES.SendEmailRequest,
) => Effect.Effect<sesv2.SendEmailResponse, sesv2.SendEmailError>;

/** The send binding of each configuration set. */
export interface SendEmails {
  readonly tracked: SendEmail;
  readonly untracked: SendEmail;
}

/**
 * A mail as SES is sent it: the composed message, the configuration set, its tags, and what a log
 * line may say about it. The log names neither the recipient nor a link: each is its action's
 * whole authorization.
 */
const prepare = (mail: Mail, postal: string) =>
  Mail.$match(mail, {
    Campaign: ({ content, unsubscribeUrl, campaignId, contactId, sendId, variant }) => ({
      message: compose(content, unsubscribeUrl),
      via: "tracked" as const,
      tags: [
        { Name: "campaignId", Value: campaignId },
        { Name: "contactId", Value: contactId },
        { Name: "sendId", Value: sendId },
        { Name: "variant", Value: variant },
      ],
      logged: { mail: "Campaign", campaignId, sendId, variant },
    }),
    Test: ({ content, unsubscribeUrl }) => ({
      message: compose(content, unsubscribeUrl),
      via: "untracked" as const,
      tags: [],
      logged: { mail: "Test" },
    }),
    Confirmation: ({ listName, confirmUrl }) => ({
      message: composeConfirmation(listName, confirmUrl, postal),
      via: "untracked" as const,
      tags: [],
      logged: { mail: "Confirmation" },
    }),
  });

export const makeSend =
  (sendEmails: SendEmails, from: string, postal: string) =>
  (recipient: string, mail: Mail): Effect.Effect<string, SendError> =>
    Effect.gen(function* () {
      const { message, via, tags, logged } = prepare(mail, postal);
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
          ...logged,
          reason,
          cause: describeCause(cause),
        }).pipe(Effect.andThen(Effect.fail(new SubmissionUncertain({ reason }))));

      const response = yield* sendEmails[via](
        tags.length === 0 ? request : { ...request, EmailTags: tags },
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

    const sendEmails: SendEmails = {
      tracked: yield* AWS.SES.SendEmail(identity, yield* trackedConfigurationSet),
      untracked: yield* AWS.SES.SendEmail(identity, yield* untrackedConfigurationSet),
    };

    return {
      send: Effect.fn("Mailer.send")(
        makeSend(
          sendEmails,
          fromHeader(settings.sender, settings.senderName),
          settings.postalAddress,
        ),
      ),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(Mailer)(Mailer.make).pipe(
    Layer.provide(AWS.SES.SendEmailHttp),
  );
}
