import type * as Schemas from "@emailer/api/Schemas";
import { DateTime, Schema } from "effect";

import type { FeedbackCounter, FeedbackOutcome } from "../storage/Feedback.ts";

/**
 * What an SES feedback event means for this system, decided once. Everything downstream — the
 * suppression or transient-window write, the history row's outcome, the campaign counter, and the
 * summary log — reads the decision from here and derives nothing of its own.
 */

const Recipient = Schema.Struct({ emailAddress: Schema.String });

const Mail = Schema.Struct({
  messageId: Schema.NonEmptyString,
  tags: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
});

const BounceEvent = Schema.Struct({
  eventType: Schema.Literal("Bounce"),
  mail: Mail,
  bounce: Schema.Struct({
    bounceType: Schema.String,
    bounceSubType: Schema.optional(Schema.NullOr(Schema.String)),
    bouncedRecipients: Schema.Array(Recipient),
    feedbackId: Schema.NonEmptyString,
    /** When the receiving server sent the bounce. */
    timestamp: Schema.DateTimeUtcFromString,
  }),
});

const ComplaintEvent = Schema.Struct({
  eventType: Schema.Literal("Complaint"),
  mail: Mail,
  complaint: Schema.Struct({
    complainedRecipients: Schema.Array(Recipient),
    feedbackId: Schema.NonEmptyString,
    complaintFeedbackType: Schema.optional(Schema.NullOr(Schema.String)),
    complaintSubType: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

/**
 * A load of the open pixel. Its IP address and user agent are left undecoded: emailer keeps
 * neither (ADR-0042).
 */
const OpenEvent = Schema.Struct({
  eventType: Schema.Literal("Open"),
  mail: Mail,
  open: Schema.Struct({
    timestamp: Schema.DateTimeUtcFromString,
    /** SES's guess whether a machine rather than a person loaded the pixel. */
    isBotEvent: Schema.optional(Schema.Literals(["Likely", "Unlikely"])),
  }),
});

export const EmailEvent = Schema.Union([BounceEvent, ComplaintEvent, OpenEvent]);

export type EmailEvent = typeof EmailEvent.Type;

/** A bounce or complaint: what `classify` decides on. */
export type FeedbackEvent = typeof BounceEvent.Type | typeof ComplaintEvent.Type;

export type OpenEvent = typeof OpenEvent.Type;

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
  /** What a campaign's mail adds to the campaign's counters, beside its history row. */
  readonly counter: FeedbackCounter | undefined;
}

/**
 * The one table. Suppression and the history outcome always agree. Echoes suppress locally (that
 * heals a lost event) and record, but count nowhere: nothing reached a mailbox, and SES leaves them
 * out of its own rates too. A transient bounce neither suppresses nor counts; it goes into the
 * mailbox's window instead.
 */
const decisions: Record<FeedbackClassification, Decision> = {
  "permanent-bounce": {
    classification: "permanent-bounce",
    suppress: true,
    outcome: "suppressed",
    counter: "bounced",
  },
  "suppression-echo": {
    classification: "suppression-echo",
    suppress: true,
    outcome: "suppressed",
    counter: undefined,
  },
  "transient-bounce": {
    classification: "transient-bounce",
    suppress: false,
    outcome: "recorded",
    counter: undefined,
  },
  complaint: {
    classification: "complaint",
    suppress: true,
    outcome: "suppressed",
    counter: "complained",
  },
  "ignored-complaint": {
    classification: "ignored-complaint",
    suppress: false,
    outcome: "recorded",
    counter: undefined,
  },
};

export interface Classified extends Decision {
  readonly kind: Schemas.SuppressionReason;
  readonly feedbackId: string;
  readonly recipients: ReadonlyArray<string>;
  /**
   * When the bounce happened, for a transient bounce: it goes into each recipient's window, whichever
   * mail it answered. Absent for every other event.
   */
  readonly transientAt?: string | undefined;
  readonly bounceType?: string | undefined;
  readonly bounceSubType?: string | undefined;
  readonly complaintFeedbackType?: string | undefined;
  readonly complaintSubType?: string | undefined;
}

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

export const classify = (event: FeedbackEvent): Classified => {
  switch (event.eventType) {
    case "Bounce": {
      const bounceSubType = orUndefined(event.bounce.bounceSubType);
      const decision = classifyBounce(event.bounce.bounceType, bounceSubType);

      return {
        ...decision,
        kind: "bounce",
        feedbackId: event.bounce.feedbackId,
        recipients: event.bounce.bouncedRecipients.map((it) => it.emailAddress),
        transientAt:
          decision.classification === "transient-bounce"
            ? DateTime.formatIso(event.bounce.timestamp)
            : undefined,
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
