import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Result } from "effect";

import { classify, decodeEmailEvent } from "./FeedbackClassification.ts";

import type { EmailEvent } from "./FeedbackClassification.ts";

const mail = { messageId: "0100019" };

const feedbackId = "0100019a-6c6f-4a39-8f12-0b2f9c3d4e5f";

const bouncedAt = DateTime.makeUnsafe("2026-09-11T10:00:00.250Z");

const bounce = (bounceType: string, bounceSubType: string | null): EmailEvent => ({
  eventType: "Bounce",
  mail,
  bounce: {
    bounceType,
    bounceSubType,
    bouncedRecipients: [{ emailAddress: "hard@example.com" }],
    feedbackId,
    timestamp: bouncedAt,
  },
});

const complaint = (
  complaintFeedbackType: string | null,
  complaintSubType: string | null = null,
): EmailEvent => ({
  eventType: "Complaint",
  mail,
  complaint: {
    complainedRecipients: [{ emailAddress: "angry@example.com" }],
    feedbackId,
    complaintFeedbackType,
    complaintSubType,
  },
});

describe("bounces", () => {
  it("counts a permanent bounce and suppresses", () => {
    expect(classify(bounce("Permanent", "General"))).toStrictEqual({
      classification: "permanent-bounce",
      suppress: true,
      outcome: "suppressed",
      counter: "bounced",
      kind: "bounce",
      feedbackId,
      recipients: ["hard@example.com"],
      transientAt: undefined,
      bounceType: "Permanent",
      bounceSubType: "General",
    });
  });

  it("counts a permanent bounce without a subtype", () => {
    const classified = classify(bounce("Permanent", null));

    expect(classified.classification).toBe("permanent-bounce");
    expect(classified).toHaveProperty("bounceSubType", undefined);
  });

  it.each(["OnAccountSuppressionList", "Suppressed"])(
    "treats a permanent %s bounce as an echo: suppressed, recorded, never counted",
    (subtype) => {
      expect(classify(bounce("Permanent", subtype))).toMatchObject({
        classification: "suppression-echo",
        suppress: true,
        outcome: "suppressed",
        counter: undefined,
        transientAt: undefined,
      });
    },
  );

  it.each([
    ["Transient", "MailboxFull"],
    ["Transient", "General"],
    ["Undetermined", "Undetermined"],
  ])("sends a %s/%s bounce to the transient window at its bounce time", (type, subtype) => {
    expect(classify(bounce(type, subtype))).toMatchObject({
      classification: "transient-bounce",
      suppress: false,
      outcome: "recorded",
      counter: undefined,
      transientAt: "2026-09-11T10:00:00.250Z",
      bounceType: type,
      bounceSubType: subtype,
    });
  });

  it("does not treat a transient bounce as an echo whatever its subtype says", () => {
    expect(classify(bounce("Transient", "OnAccountSuppressionList")).classification).toBe(
      "transient-bounce",
    );
  });
});

describe("complaints", () => {
  it("counts a complaint and suppresses", () => {
    expect(classify(complaint("abuse"))).toStrictEqual({
      classification: "complaint",
      suppress: true,
      outcome: "suppressed",
      counter: "complained",
      kind: "complaint",
      feedbackId,
      recipients: ["angry@example.com"],
      complaintFeedbackType: "abuse",
      complaintSubType: undefined,
    });
  });

  it("counts a complaint that carries no feedback type", () => {
    expect(classify(complaint(null)).classification).toBe("complaint");
  });

  it.each(["not-spam", "auth-failure"])(
    "records a %s report without suppressing or counting",
    (feedbackType) => {
      expect(classify(complaint(feedbackType))).toMatchObject({
        classification: "ignored-complaint",
        suppress: false,
        outcome: "recorded",
        counter: undefined,
      });
    },
  );

  it("treats the account-suppression-list echo as an echo even when its type is ignorable", () => {
    expect(classify(complaint("not-spam", "OnAccountSuppressionList"))).toMatchObject({
      classification: "suppression-echo",
      suppress: true,
      outcome: "suppressed",
      counter: undefined,
    });
  });
});

describe("decoding", () => {
  const detail = (timestamp: string | undefined) => ({
    eventType: "Bounce",
    mail,
    bounce: {
      bounceType: "Transient",
      bouncedRecipients: [{ emailAddress: "soft@example.com" }],
      feedbackId,
      timestamp,
    },
  });

  it.effect("reads a bounce's timestamp in canonical form, whatever precision SES sent", () =>
    Effect.gen(function* () {
      const event = yield* decodeEmailEvent(detail("2026-09-11T10:00:00Z"));

      expect(classify(event).transientAt).toBe("2026-09-11T10:00:00.000Z");
    }),
  );

  it.effect("refuses a bounce without a readable timestamp", () =>
    Effect.gen(function* () {
      expect(Result.isFailure(yield* Effect.result(decodeEmailEvent(detail("soon"))))).toBe(true);
      expect(Result.isFailure(yield* Effect.result(decodeEmailEvent(detail(undefined))))).toBe(
        true,
      );
    }),
  );
});
