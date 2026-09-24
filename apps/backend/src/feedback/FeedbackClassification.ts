import { Schema } from "effect";

import type { FeedbackKind, FeedbackOutcome, FeedbackWrite } from "../storage/Feedback.ts";

/**
 * What an SES feedback event means for this system, decided once. Everything downstream — the
 * suppression write, the history row's outcome, the campaign counter or transient window, and the
 * summary log — reads the decision from here and derives nothing of its own.
 */

const Recipient = Schema.Struct({ emailAddress: Schema.String });

const Mail = Schema.Struct({
  messageId: Schema.NonEmptyString,
  tags: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
});

export const EmailEvent = Schema.Union([
  Schema.Struct({
    eventType: Schema.Literal("Bounce"),
    mail: Mail,
    bounce: Schema.Struct({
      bounceType: Schema.String,
      bounceSubType: Schema.optional(Schema.NullOr(Schema.String)),
      bouncedRecipients: Schema.Array(Recipient),
      feedbackId: Schema.NonEmptyString,
    }),
  }),
  Schema.Struct({
    eventType: Schema.Literal("Complaint"),
    mail: Mail,
    complaint: Schema.Struct({
      complainedRecipients: Schema.Array(Recipient),
      feedbackId: Schema.NonEmptyString,
      complaintFeedbackType: Schema.optional(Schema.NullOr(Schema.String)),
      complaintSubType: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
  Schema.Struct({
    eventType: Schema.Literal("DeliveryDelay"),
    mail: Mail,
    deliveryDelay: Schema.Struct({
      delayType: Schema.String,
      delayedRecipients: Schema.Array(Recipient),
      expirationTime: Schema.optionalKey(Schema.String),
      timestamp: Schema.String,
    }),
  }),
]);

export type EmailEvent = typeof EmailEvent.Type;

export const decodeEmailEvent = Schema.decodeUnknownEffect(EmailEvent);

/**
 * A complaint SES reports with one of these feedback types is not the recipient calling the mail
 * unwanted: `not-spam` retracts an earlier report, `auth-failure` is a DMARC failure report.
 */
const ignoredComplaintTypes = new Set(["not-spam", "auth-failure"]);

/**
 * A permanent bounce with one of these subtypes never reached a mailbox: SES accepted the send and
 * dropped it without attempting delivery. `OnAccountSuppressionList` means the address is on the
 * account-level suppression list; `Suppressed` means it is on the SES global suppression list.
 * Account-level suppression, which this configuration set enables, overrides the global list, so
 * the second is rare here — but no less an echo.
 */
const bounceEchoSubtypes = new Set(["OnAccountSuppressionList", "Suppressed"]);

const complaintEchoSubtype = "OnAccountSuppressionList";

type FeedbackClassification =
  | "permanent-bounce"
  | "suppression-echo"
  | "transient-bounce"
  | "complaint"
  | "ignored-complaint";

interface Decision {
  readonly classification: FeedbackClassification;
  readonly suppress: boolean;
  readonly outcome: FeedbackOutcome;
  readonly write: FeedbackWrite;
}

/**
 * The one table. Suppression and the history outcome always agree; the write says what the row
 * changes beside itself. Echoes suppress locally (that heals a lost event) and record, but count
 * nowhere: nothing reached a mailbox, and SES leaves them out of its own rates too.
 */
const decisions: Record<FeedbackClassification, Decision> = {
  "permanent-bounce": {
    classification: "permanent-bounce",
    suppress: true,
    outcome: "suppressed",
    write: { effect: "count", counter: "bounced" },
  },
  "suppression-echo": {
    classification: "suppression-echo",
    suppress: true,
    outcome: "suppressed",
    write: { effect: "history" },
  },
  "transient-bounce": {
    classification: "transient-bounce",
    suppress: false,
    outcome: "recorded",
    write: { effect: "transient" },
  },
  complaint: {
    classification: "complaint",
    suppress: true,
    outcome: "suppressed",
    write: { effect: "count", counter: "complained" },
  },
  "ignored-complaint": {
    classification: "ignored-complaint",
    suppress: false,
    outcome: "recorded",
    write: { effect: "history" },
  },
};

interface ClassifiedFeedback extends Decision {
  readonly kind: FeedbackKind;
  readonly feedbackId: string;
  readonly recipients: ReadonlyArray<string>;
  readonly bounceType?: string | undefined;
  readonly bounceSubType?: string | undefined;
  readonly complaintFeedbackType?: string | undefined;
  readonly complaintSubType?: string | undefined;
}

interface ClassifiedDelay {
  readonly classification: "delay";
  readonly recipients: ReadonlyArray<string>;
  readonly delayType: string;
  readonly expirationTime?: string | undefined;
}

export type Classified = ClassifiedFeedback | ClassifiedDelay;

const orUndefined = (value: string | null | undefined): string | undefined => value ?? undefined;

const classifyBounce = (bounceType: string, bounceSubType: string | undefined) => {
  if (bounceType !== "Permanent") {
    return decisions["transient-bounce"];
  }

  return bounceSubType !== undefined && bounceEchoSubtypes.has(bounceSubType)
    ? decisions["suppression-echo"]
    : decisions["permanent-bounce"];
};

const classifyComplaint = (
  complaintFeedbackType: string | undefined,
  complaintSubType: string | undefined,
) => {
  if (complaintSubType === complaintEchoSubtype) {
    return decisions["suppression-echo"];
  }

  return complaintFeedbackType !== undefined && ignoredComplaintTypes.has(complaintFeedbackType)
    ? decisions["ignored-complaint"]
    : decisions.complaint;
};

export const classify = (event: EmailEvent): Classified => {
  switch (event.eventType) {
    case "DeliveryDelay":
      return {
        classification: "delay",
        recipients: event.deliveryDelay.delayedRecipients.map((it) => it.emailAddress),
        delayType: event.deliveryDelay.delayType,
        expirationTime: event.deliveryDelay.expirationTime,
      };

    case "Bounce": {
      const bounceSubType = orUndefined(event.bounce.bounceSubType);

      return {
        ...classifyBounce(event.bounce.bounceType, bounceSubType),
        kind: "bounce",
        feedbackId: event.bounce.feedbackId,
        recipients: event.bounce.bouncedRecipients.map((it) => it.emailAddress),
        bounceType: event.bounce.bounceType,
        bounceSubType,
      };
    }

    case "Complaint": {
      const complaintFeedbackType = orUndefined(event.complaint.complaintFeedbackType);
      const complaintSubType = orUndefined(event.complaint.complaintSubType);

      return {
        ...classifyComplaint(complaintFeedbackType, complaintSubType),
        kind: "complaint",
        feedbackId: event.complaint.feedbackId,
        recipients: event.complaint.complainedRecipients.map((it) => it.emailAddress),
        complaintFeedbackType,
        complaintSubType,
      };
    }
  }
};
