import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Config, Context, Data, Duration, Effect, Layer, Schema } from "effect";

import { sendingIdentity } from "./SendingIdentity.ts";

export const configurationSetLogicalId = "EmailerMail";

export const eventDestinationLogicalId = "EmailerMailFeedback";

export const configurationSet = AWS.SES.ConfigurationSet(configurationSetLogicalId, {
  suppressedReasons: ["BOUNCE", "COMPLAINT"],
  reputationMetricsEnabled: true,
});

export const submissionTimeout = Duration.seconds(8);

export interface OutgoingMessage {
  readonly recipient: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string | undefined;
  readonly unsubscribeUrl: string;
  readonly campaignId: string;
  readonly sendId: string;
}

export type SubmissionOutcome =
  | { readonly outcome: "accepted"; readonly messageId: string }
  | { readonly outcome: "rejected"; readonly rejectionCode: Schemas.RejectionCode };

export class SubmissionUncertain extends Data.TaggedError("SubmissionUncertain")<{
  readonly reason: "timeout" | "transport" | "malformed-response";
  readonly cause: unknown;
}> {}

const rejectionCodes = new Map<string, Schemas.RejectionCode>([
  ["MessageRejected", "message-rejected"],
  ["BadRequestException", "invalid-request"],
  ["MailFromDomainNotVerifiedException", "identity-not-verified"],
  ["NotFoundException", "identity-not-verified"],
  ["SendingPausedException", "sending-paused"],
  ["AccountSuspendedException", "sending-paused"],
  ["TooManyRequestsException", "rate-limited"],
  ["ThrottlingException", "rate-limited"],
  ["LimitExceededException", "rate-limited"],
]);

export class Mailer extends Context.Service<
  Mailer,
  {
    readonly sender: string;
    readonly submit: (
      message: OutgoingMessage,
    ) => Effect.Effect<SubmissionOutcome, SubmissionUncertain>;
  }
>()("emailer/backend/Mailer") {}

const decodeAddress = Schema.decodeUnknownEffect(Schemas.EmailAddress);

export class SenderNotOnIdentity extends Data.TaggedError("SenderNotOnIdentity")<{
  readonly identity: string;
}> {}

export const belongsToIdentity = (sender: string, identity: string): boolean => {
  const domain = sender.slice(sender.lastIndexOf("@") + 1);

  return domain === identity || domain.endsWith(`.${identity}`);
};

export const postalAddress = Config.schema(
  Schema.Trim.check(Schema.isNonEmpty()),
  "EMAILER_POSTAL_ADDRESS",
);

export const mailerAddresses = Effect.gen(function* () {
  const raw = yield* Config.all({
    identity: Config.string("EMAILER_SENDER_IDENTITY"),
    sender: Config.string("EMAILER_FROM_EMAIL"),
    postalAddress,
  });

  const identity = raw.identity.trim().toLowerCase();
  const sender = yield* Effect.orDie(decodeAddress(raw.sender));

  if (!belongsToIdentity(sender, identity)) {
    return yield* Effect.die(new SenderNotOnIdentity({ identity }));
  }

  return {
    identity,
    sender,
    postalAddress: raw.postalAddress,
  };
});

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

export const footerFor = (unsubscribeUrl: string, postalAddress: string): string =>
  `\n\n---\nUnsubscribe from these emails: ${unsubscribeUrl}\n\n${postalAddress}`;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const htmlFooterFor = (unsubscribeUrl: string, postalAddress: string): string => {
  const url = escapeHtml(unsubscribeUrl);

  return `<p>Unsubscribe from these emails: <a href="${url}">${url}</a></p><p>${escapeHtml(postalAddress)}</p>`;
};

// Matches on the original string, so the index is an original index even when a character such
// as `İ` would change length under `toLowerCase()`.
const bodyClose = /<\/body>/gi;

const withHtmlFooter = (html: string, footer: string): string => {
  let index = -1;

  for (const match of html.matchAll(bodyClose)) {
    index = match.index;
  }

  return index === -1 ? `${html}${footer}` : `${html.slice(0, index)}${footer}${html.slice(index)}`;
};

export const makeSubmit =
  (
    send: (
      request: AWS.SES.SendEmailRequest,
    ) => Effect.Effect<sesv2.SendEmailResponse, sesv2.SendEmailError>,
    sender: string,
    postal: string,
  ) =>
  (message: OutgoingMessage): Effect.Effect<SubmissionOutcome, SubmissionUncertain> => {
    const text = {
      Text: {
        Data: `${message.text}${footerFor(message.unsubscribeUrl, postal)}`,
        Charset: "UTF-8",
      },
    };

    const body =
      message.html === undefined
        ? text
        : {
            ...text,
            Html: {
              Data: withHtmlFooter(message.html, htmlFooterFor(message.unsubscribeUrl, postal)),
              Charset: "UTF-8",
            },
          };

    return send({
      FromEmailAddress: sender,
      Destination: { ToAddresses: [message.recipient] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: body,
          Headers: [
            { Name: "List-Unsubscribe", Value: `<${message.unsubscribeUrl}>` },
            { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
          ],
        },
      },
      EmailTags: [
        { Name: "campaignId", Value: message.campaignId },
        { Name: "sendId", Value: message.sendId },
      ],
    }).pipe(
      Retry.none,
      Effect.matchEffect({
        onFailure: (error): Effect.Effect<SubmissionOutcome, SubmissionUncertain> => {
          const rejectionCode = rejectionCodes.get(error._tag);

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
    );
  };

export const MailerLive = Layer.effect(Mailer)(
  Effect.gen(function* () {
    const addresses = yield* mailerAddresses;

    const identity = yield* sendingIdentity;

    const mail = yield* configurationSet;
    const send = yield* AWS.SES.SendEmail(identity, mail);

    return Mailer.of({
      sender: addresses.sender,
      submit: Effect.fn("Mailer.submit")(
        makeSubmit(send, addresses.sender, addresses.postalAddress),
      ),
    });
  }),
).pipe(Layer.provide(AWS.SES.SendEmailHttp));
