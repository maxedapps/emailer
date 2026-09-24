import { describe, expect, it } from "@effect/vitest";
import * as Schemas from "@emailer/api/Schemas";
import type * as AWS from "alchemy/AWS";
import { ConfigProvider, Effect, Layer, Logger, References, Result } from "effect";

import { expectedConfigurationSet, handleMessage } from "./Feedback.ts";
import { StorageFailure } from "../storage/Errors.ts";
import { FeedbackStore } from "../storage/Feedback.ts";

import type { AddressSuppression } from "../storage/Addresses.ts";
import type { FeedbackRow, FeedbackWrite, FeedbackWriteOutcome } from "../storage/Feedback.ts";

const configurationSetName = "emailer-test-mail";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const messageId = "0100019-deadbeef";

const feedbackId = "0100019a-6c6f-4a39-8f12-0b2f9c3d4e5f";

interface RecordedWrite {
  readonly row: FeedbackRow;
  readonly write: FeedbackWrite;
}

interface LogEntry {
  readonly level: string;
  readonly message: unknown;
}

interface World {
  readonly suppressions: Map<string, AddressSuppression>;
  readonly writes: Array<RecordedWrite>;
  readonly historyKeys: Set<string>;
  readonly writeOutcomes: Array<FeedbackWriteOutcome>;
  readonly repeated: Array<string>;
  readonly logs: Array<LogEntry>;
}

const historyKey = (row: FeedbackRow) =>
  `${row.campaignId}#${row.kind}#${row.feedbackId}#${Schemas.mailboxKey(row.recipient)}`;

const rememberWrite = (world: World, key: string): FeedbackWriteOutcome => {
  if (world.historyKeys.has(key)) {
    world.repeated.push(key);
    world.writeOutcomes.push("duplicate");

    return "duplicate";
  }

  world.historyKeys.add(key);
  world.writeOutcomes.push("committed");

  return "committed";
};

const storageOperations = (world: World): FeedbackStore["Service"] => ({
  suppressAddress: (suppression) =>
    Effect.sync(() => {
      const key = Schemas.mailboxKey(suppression.email);

      if (world.suppressions.has(key)) {
        world.repeated.push(key);

        return;
      }

      world.suppressions.set(key, suppression);
    }),
  recordFeedback: (row, write) =>
    Effect.sync(() => {
      world.writes.push({ row, write });

      return rememberWrite(world, historyKey(row));
    }),
});

const storageLayer = (world: World): Layer.Layer<FeedbackStore> =>
  Layer.succeed(FeedbackStore)(storageOperations(world));

const configuration = Layer.succeed(ConfigProvider.ConfigProvider)(
  ConfigProvider.fromEnvRecord({ EMAILER_CONFIGURATION_SET: configurationSetName }),
);

const emptyWorld = (): World => ({
  suppressions: new Map(),
  writes: [],
  historyKeys: new Set(),
  writeOutcomes: [],
  repeated: [],
  logs: [],
});

const collectingLogs = (world: World) =>
  Logger.layer([
    Logger.make((options) => {
      world.logs.push({ level: options.logLevel, message: options.message });
    }),
  ]);

const logsNamed = (world: World, name: string) =>
  world.logs.filter((entry) => {
    // SAFETY: Effect.logInfo(message, data) reaches a logger as [message, data].
    const recorded = entry.message as ReadonlyArray<unknown> | string | undefined;

    return Array.isArray(recorded) ? recorded[0] === name : recorded === name;
  });

const tags = (extra: Record<string, Array<string>> = {}) => ({
  "ses:configuration-set": [configurationSetName],
  campaignId: [campaignId],
  sendId: ["0195f0a0-1111-4222-8333-44444444e5d1"],
  ...extra,
});

const bounceEvent = (
  bounceType: string,
  bounceSubType: string | null,
  recipients: ReadonlyArray<string> = ["hard@example.com"],
  messageTags: Record<string, Array<string>> = tags(),
): AWS.SES.EmailEventDetail => ({
  eventType: "Bounce",
  mail: { messageId, destination: [...recipients], tags: { ...messageTags } },
  bounce: {
    bounceType,
    bounceSubType,
    feedbackId,
    timestamp: "2026-09-11T10:00:00.000Z",
    bouncedRecipients: recipients.map((emailAddress) => ({
      emailAddress,
      action: "failed",
      status: "5.1.1",
    })),
  },
});

const complaintEvent = (
  complaintFeedbackType: string | null,
  complaintSubType: string | null = null,
  messageTags: Record<string, Array<string>> = tags(),
): AWS.SES.EmailEventDetail => ({
  eventType: "Complaint",
  mail: { messageId, destination: ["angry@example.com"], tags: { ...messageTags } },
  complaint: {
    complainedRecipients: [{ emailAddress: "angry@example.com" }],
    feedbackId,
    complaintFeedbackType,
    complaintSubType,
    timestamp: "2026-09-11T10:00:00.000Z",
  },
});

const delayEvent = (
  delayType: string,
  recipients: ReadonlyArray<string> = ["late@example.com", "later@example.com"],
  expirationTime?: string,
  messageTags: Record<string, Array<string>> = tags(),
): AWS.SES.EmailEventDetail => {
  const delayedRecipients = recipients.map((emailAddress) => ({ emailAddress }));
  const mail = { messageId, destination: [...recipients], tags: { ...messageTags } };
  const timestamp = "2026-09-11T10:00:00.000Z";

  if (expirationTime === undefined) {
    return {
      eventType: "DeliveryDelay",
      mail,
      deliveryDelay: { delayType, delayedRecipients, timestamp },
    };
  }

  return {
    eventType: "DeliveryDelay",
    mail,
    deliveryDelay: { delayType, delayedRecipients, expirationTime, timestamp },
  };
};

/** The queue message the rule delivers: the whole EventBridge event, with SES's event as `detail`. */
const envelope = (detail: AWS.SES.EmailEventDetail, envelopeId = "envelope-1") =>
  JSON.stringify({ version: "0", id: envelopeId, source: "aws.ses", detail });

/** A message that is not an EventBridge event: a Lambda failure record nests the event instead. */
const lambdaFailureRecord = JSON.stringify({
  requestContext: { requestId: "request-1", condition: "RetriesExhausted" },
  requestPayload: { id: "envelope-1", detail: bounceEvent("Permanent", "General") },
});

const handling = (
  world: World,
  body: string,
  store: Layer.Layer<FeedbackStore> = storageLayer(world),
) =>
  Effect.gen(function* () {
    const expected = yield* expectedConfigurationSet;

    yield* handleMessage(expected, body);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        store,
        configuration,
        collectingLogs(world),
        Layer.succeed(References.MinimumLogLevel)("Debug"),
      ),
    ),
  );

const run = (detail: AWS.SES.EmailEventDetail) =>
  Effect.gen(function* () {
    const world = emptyWorld();

    yield* handling(world, envelope(detail));

    return world;
  });

const countBounced: FeedbackWrite = { effect: "count", counter: "bounced" };

const countComplained: FeedbackWrite = { effect: "count", counter: "complained" };

describe("bounces", () => {
  it.effect("suppresses a permanent bounce and hands the store a counted, suppressed row", () =>
    Effect.gen(function* () {
      const world = yield* run(bounceEvent("Permanent", "General"));

      expect(world.suppressions.get("hard@example.com")?.reason).toBe("bounce");
      expect(world.suppressions.get("hard@example.com")?.messageId).toBe(messageId);
      expect(world.suppressions.get("hard@example.com")?.bounceSubType).toBe("General");
      expect(world.writes).toHaveLength(1);
      expect(world.writes[0]?.write).toStrictEqual(countBounced);
      expect(world.writes[0]?.row).toStrictEqual({
        campaignId,
        kind: "bounce",
        feedbackId,
        recipient: "hard@example.com",
        messageId,
        outcome: "suppressed",
        receivedAt: world.writes[0]?.row.receivedAt,
        bounceType: "Permanent",
        bounceSubType: "General",
        complaintFeedbackType: undefined,
        complaintSubType: undefined,
      });
      expect(world.writes[0]?.row.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }),
  );

  it.effect("does not suppress a transient bounce and hands the store a transient row", () =>
    Effect.gen(function* () {
      const world = yield* run(bounceEvent("Transient", "MailboxFull"));

      expect(world.suppressions.size).toBe(0);
      expect(world.writes).toHaveLength(1);
      expect(world.writes[0]?.write).toStrictEqual({ effect: "transient" });
      expect(world.writes[0]?.row).toMatchObject({
        campaignId,
        recipient: "hard@example.com",
        outcome: "recorded",
        bounceType: "Transient",
        bounceSubType: "MailboxFull",
      });
    }),
  );

  it.effect("writes one row per listed recipient and suppresses each", () =>
    Effect.gen(function* () {
      const world = yield* run(
        bounceEvent("Permanent", "General", ["one@example.com", "two@example.com"]),
      );

      expect([...world.suppressions.keys()]).toStrictEqual(["one@example.com", "two@example.com"]);
      expect(world.writes.map((it) => it.row.recipient)).toStrictEqual([
        "one@example.com",
        "two@example.com",
      ]);
    }),
  );
});

describe("complaints", () => {
  it.effect("suppresses a complaint and hands the store a counted row", () =>
    Effect.gen(function* () {
      const world = yield* run(complaintEvent("abuse"));

      expect(world.suppressions.get("angry@example.com")?.reason).toBe("complaint");
      expect(world.suppressions.get("angry@example.com")?.complaintFeedbackType).toBe("abuse");
      expect(world.writes).toHaveLength(1);
      expect(world.writes[0]?.write).toStrictEqual(countComplained);
      expect(world.writes[0]?.row).toMatchObject({
        kind: "complaint",
        outcome: "suppressed",
        complaintFeedbackType: "abuse",
      });
    }),
  );

  // The one case whose complaint subtype reaches both the suppression and the row.
  it.effect("suppresses the complaint echo and hands the store a history-only row", () =>
    Effect.gen(function* () {
      const world = yield* run(complaintEvent(null, "OnAccountSuppressionList"));

      expect(world.suppressions.get("angry@example.com")?.complaintSubType).toBe(
        "OnAccountSuppressionList",
      );
      expect(world.writes[0]?.write).toStrictEqual({ effect: "history" });
      expect(world.writes[0]?.row.complaintSubType).toBe("OnAccountSuppressionList");
    }),
  );

  it.effect("records a not-spam report without suppressing or counting", () =>
    Effect.gen(function* () {
      const world = yield* run(complaintEvent("not-spam"));

      expect(world.suppressions.size).toBe(0);
      expect(world.writes).toHaveLength(1);
      expect(world.writes[0]?.write).toStrictEqual({ effect: "history" });
      expect(world.writes[0]?.row.outcome).toBe("recorded");
    }),
  );
});

describe("events the handler must not act on", () => {
  it.effect("ignores an event published through another configuration set", () =>
    Effect.gen(function* () {
      const world = yield* run(
        bounceEvent("Permanent", "General", ["hard@example.com"], {
          ...tags(),
          "ses:configuration-set": ["someone-elses-set"],
        }),
      );

      expect(world.suppressions.size).toBe(0);
      expect(world.writes).toHaveLength(0);
    }),
  );

  it.effect("ignores an event it cannot decode without failing the invocation", () =>
    Effect.gen(function* () {
      const world = yield* run({ eventType: "Bounce", mail: { messageId } });

      expect(world.suppressions.size).toBe(0);
      expect(world.writes).toHaveLength(0);
    }),
  );

  it.effect(
    "fails the invocation for a message that is not an EventBridge event, and writes nothing",
    () =>
      Effect.gen(function* () {
        const world = emptyWorld();

        const attempt = yield* Effect.result(handling(world, lambdaFailureRecord));

        expect(Result.isFailure(attempt)).toBe(true);
        expect(world.suppressions.size).toBe(0);
        expect(world.writes).toHaveLength(0);
      }),
  );

  it.effect("ignores an event kind it does not classify", () =>
    Effect.gen(function* () {
      const world = yield* run({
        eventType: "Delivery",
        mail: { messageId, tags: { ...tags() } },
        delivery: { recipients: ["sam@example.com"] },
      });

      expect(world.suppressions.size).toBe(0);
      expect(world.writes).toHaveLength(0);
    }),
  );
});

describe("idempotence and the campaign tag", () => {
  it.effect("changes nothing when the same event is delivered twice", () =>
    Effect.gen(function* () {
      const world = emptyWorld();
      const event = bounceEvent("Permanent", "General");

      yield* handling(world, envelope(event, "envelope-1"));
      yield* handling(world, envelope(event, "envelope-2"));

      expect(world.suppressions.size).toBe(1);
      expect(world.writes).toHaveLength(2);
      expect(world.writeOutcomes).toStrictEqual(["committed", "duplicate"]);
      expect(world.repeated).toHaveLength(2);
      expect(logsNamed(world, "duplicate feedback event")).toHaveLength(1);
      expect(logsNamed(world, "duplicate feedback event")[0]?.level).toBe("Debug");
    }),
  );

  it.effect("fails the invocation when the suppression write is unavailable", () =>
    Effect.gen(function* () {
      const world = emptyWorld();

      const unavailable = Layer.succeed(FeedbackStore)({
        ...storageOperations(world),
        suppressAddress: () =>
          Effect.fail(
            new StorageFailure({
              operationId: "suppressAddress",
              reason: "unavailable",
              cause: "boom",
            }),
          ),
      });

      const attempt = yield* Effect.result(
        handling(world, envelope(bounceEvent("Permanent", "General")), unavailable),
      );

      expect(Result.isFailure(attempt)).toBe(true);
      expect(world.writes).toHaveLength(0);
    }),
  );

  it.effect("still suppresses when the event carries no campaign tag", () =>
    Effect.gen(function* () {
      const untagged = {
        "ses:configuration-set": [configurationSetName],
      };

      const world = yield* run(bounceEvent("Permanent", "General", ["hard@example.com"], untagged));

      expect(world.suppressions.has("hard@example.com")).toBe(true);
      expect(world.writes).toHaveLength(0);
      expect(logsNamed(world, "feedback without a campaign tag (a test send)")).toHaveLength(1);
      expect(logsNamed(world, "feedback without a campaign tag (a test send)")[0]?.level).toBe(
        "Info",
      );
    }),
  );

  // The case the dead-letter queue exists for: the suppression persisted, the history write did
  // not. The invocation fails, SQS redelivers the message until it dead-letters it, and a redrive
  // then completes the history without writing the suppression a second time.
  it.effect(
    "completes a half-written event on replay without duplicating what already landed",
    () =>
      Effect.gen(function* () {
        const world = emptyWorld();
        let historyFails = true;

        const flaky = Layer.succeed(FeedbackStore)({
          ...storageOperations(world),
          recordFeedback: (row, write) =>
            historyFails
              ? Effect.fail(
                  new StorageFailure({
                    operationId: "recordFeedback",
                    reason: "unavailable",
                    cause: "boom",
                  }),
                )
              : storageOperations(world).recordFeedback(row, write),
        });

        const first = yield* Effect.result(
          handling(world, envelope(bounceEvent("Permanent", "General")), flaky),
        );

        expect(Result.isFailure(first)).toBe(true);
        expect(world.suppressions.size).toBe(1);
        expect(world.writes).toHaveLength(0);

        historyFails = false;

        const replayed = yield* Effect.result(
          handling(world, envelope(bounceEvent("Permanent", "General")), flaky),
        );

        expect(Result.isSuccess(replayed)).toBe(true);
        expect(world.writes).toHaveLength(1);
        // The suppression was already there, so the replay's conditional write was a no-op rather
        // than a second record — which is what makes replaying safe.
        expect(world.suppressions.size).toBe(1);
        expect(world.repeated).toStrictEqual(["hard@example.com"]);
      }),
  );
});

describe("delivery delays", () => {
  it.effect("logs a delivery delay once for two recipients and writes nothing", () =>
    Effect.gen(function* () {
      const world = yield* run(
        delayEvent(
          "SpamDetected",
          ["late@example.com", "later@example.com"],
          "2026-09-11T12:00:00.000Z",
        ),
      );

      expect(world.suppressions.size).toBe(0);
      expect(world.writes).toHaveLength(0);

      const delayed = logsNamed(world, "delivery delayed");

      expect(delayed).toHaveLength(1);
      expect(delayed[0]?.level).toBe("Info");
      expect(delayed[0]?.message).toStrictEqual([
        "delivery delayed",
        {
          delayType: "SpamDetected",
          recipients: 2,
          campaignId,
          messageId,
          expirationTime: "2026-09-11T12:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("logs a delivery delay without an expirationTime", () =>
    Effect.gen(function* () {
      const world = yield* run(delayEvent("MailboxFull"));

      expect(world.writes).toHaveLength(0);
      expect(logsNamed(world, "delivery delayed")[0]?.message).toEqual([
        "delivery delayed",
        expect.objectContaining({
          delayType: "MailboxFull",
          recipients: 2,
          expirationTime: undefined,
        }),
      ]);
    }),
  );

  it.effect(
    "still logs a delivery delay when the event carries no campaign tag, and writes nothing",
    () =>
      Effect.gen(function* () {
        const world = yield* run(
          delayEvent("IPFailure", ["late@example.com"], "2026-09-11T12:00:00.000Z", {
            "ses:configuration-set": [configurationSetName],
          }),
        );

        expect(world.suppressions.size).toBe(0);
        expect(world.writes).toHaveLength(0);
        expect(logsNamed(world, "feedback without a campaign tag (a test send)")).toHaveLength(0);
        expect(logsNamed(world, "delivery delayed")[0]?.message).toEqual([
          "delivery delayed",
          expect.objectContaining({
            delayType: "IPFailure",
            recipients: 1,
            campaignId: undefined,
          }),
        ]);
      }),
  );
});

describe("write outcomes and summary", () => {
  it.effect("logs a warning when the campaign is unknown", () =>
    Effect.gen(function* () {
      const world = emptyWorld();

      const unknown = Layer.succeed(FeedbackStore)({
        ...storageOperations(world),
        recordFeedback: (row, write) =>
          Effect.sync(() => {
            world.writes.push({ row, write });
            world.writeOutcomes.push("unknown-campaign");

            return "unknown-campaign";
          }),
      });

      yield* handling(world, envelope(bounceEvent("Permanent", "General")), unknown);

      expect(world.suppressions.has("hard@example.com")).toBe(true);
      expect(world.writes).toHaveLength(1);
      expect(world.writeOutcomes).toStrictEqual(["unknown-campaign"]);

      const warnings = logsNamed(world, "feedback event for unknown campaign");

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.level).toBe("Warn");
      expect(warnings[0]?.message).toStrictEqual([
        "feedback event for unknown campaign",
        { campaignId, kind: "bounce" },
      ]);
    }),
  );

  it.effect.each([
    ["Permanent", "General", "permanent-bounce"],
    ["Permanent", "OnAccountSuppressionList", "suppression-echo"],
    ["Permanent", "Suppressed", "suppression-echo"],
    ["Transient", "MailboxFull", "transient-bounce"],
  ] as const)("summarises a %s/%s bounce as %s", ([bounceType, bounceSubType, classification]) =>
    Effect.gen(function* () {
      const world = yield* run(bounceEvent(bounceType, bounceSubType));

      expect(logsNamed(world, "feedback recorded")[0]?.message).toEqual([
        "feedback recorded",
        expect.objectContaining({ classification }),
      ]);
    }),
  );

  it.effect("summarises a complaint as a complaint", () =>
    Effect.gen(function* () {
      const world = yield* run(complaintEvent("abuse"));

      expect(logsNamed(world, "feedback recorded")[0]?.message).toEqual([
        "feedback recorded",
        expect.objectContaining({ classification: "complaint" }),
      ]);
    }),
  );
});
