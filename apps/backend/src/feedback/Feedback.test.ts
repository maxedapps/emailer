import { describe, expect, it } from "@effect/vitest";
import { CampaignNotFound, StorageUnavailable } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import type * as AWS from "alchemy/AWS";
import { ConfigProvider, Effect, Layer, Logger, References, Result } from "effect";
import { TestClock } from "effect/testing";

import { expectedConfigurationSet, handleMessage } from "./Feedback.ts";
import { FeedbackAlreadyRecorded, FeedbackStore } from "../storage/Feedback.ts";

import type { AddressSuppression } from "../storage/Addresses.ts";
import type { FeedbackCounter, FeedbackRow } from "../storage/Feedback.ts";

type WriteOutcome = "committed" | "duplicate" | "unknown-campaign";

const configurationSetName = "emailer-test-mail";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const messageId = "0100019-deadbeef";

const feedbackId = "0100019a-6c6f-4a39-8f12-0b2f9c3d4e5f";

interface RecordedWrite {
  readonly row: FeedbackRow;
  readonly counter: FeedbackCounter | undefined;
}

interface LogEntry {
  readonly level: string;
  readonly message: unknown;
}

interface World {
  readonly suppressions: Map<string, AddressSuppression>;
  /** Each mailbox's transient window, as the string set the store adds to. */
  readonly transients: Map<string, Set<string>>;
  readonly writes: Array<RecordedWrite>;
  readonly historyKeys: Set<string>;
  readonly writeOutcomes: Array<WriteOutcome>;
  readonly repeated: Array<string>;
  readonly logs: Array<LogEntry>;
}

const historyKey = (row: FeedbackRow) =>
  `${row.campaignId}#${row.kind}#${row.feedbackId}#${Schemas.mailboxKey(row.recipient)}`;

const rememberWrite = (world: World, key: string) =>
  Effect.suspend(() => {
    if (world.historyKeys.has(key)) {
      world.repeated.push(key);
      world.writeOutcomes.push("duplicate");

      return Effect.fail(new FeedbackAlreadyRecorded());
    }

    world.historyKeys.add(key);
    world.writeOutcomes.push("committed");

    return Effect.void;
  });

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
  addTransientBounce: (bounce) =>
    Effect.sync(() => {
      const key = Schemas.mailboxKey(bounce.email);
      const window = world.transients.get(key) ?? new Set<string>();

      window.add(`${bounce.occurredAt}#${bounce.feedbackId}`);
      world.transients.set(key, window);
    }),
  recordFeedback: (row, counter) =>
    Effect.suspend(() => {
      world.writes.push({ row, counter });

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
  transients: new Map(),
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
  variant: ["half"],
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

const untagged = { "ses:configuration-set": [configurationSetName] };

/** The window entry `bounceEvent` adds: its bounce time and its feedback id. */
const windowEntry = `2026-09-11T10:00:00.000Z#${feedbackId}`;

describe("bounces", () => {
  it.effect(
    "suppresses a permanent bounce and hands the store a counted, suppressed row naming its copy",
    () =>
      Effect.gen(function* () {
        const world = yield* run(bounceEvent("Permanent", "General"));

        expect(world.suppressions.get("hard@example.com")?.reason).toBe("bounce");
        expect(world.suppressions.get("hard@example.com")?.messageId).toBe(messageId);
        expect(world.suppressions.get("hard@example.com")?.bounceSubType).toBe("General");
        expect(world.writes).toHaveLength(1);
        expect(world.writes[0]?.counter).toBe("bounced");
        expect(world.transients.size).toBe(0);
        expect(world.writes[0]?.row).toStrictEqual({
          campaignId,
          kind: "bounce",
          feedbackId,
          recipient: "hard@example.com",
          messageId,
          variant: "half",
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

  it.effect(
    "adds a transient bounce to the mailbox's window at its bounce time, and records it uncounted",
    () =>
      Effect.gen(function* () {
        const world = yield* run(bounceEvent("Transient", "MailboxFull"));

        expect(world.suppressions.size).toBe(0);
        expect(world.transients.get("hard@example.com")).toStrictEqual(new Set([windowEntry]));
        expect(world.writes).toHaveLength(1);
        expect(world.writes[0]?.counter).toBeUndefined();
        expect(world.writes[0]?.row).toMatchObject({
          campaignId,
          recipient: "hard@example.com",
          outcome: "recorded",
          bounceType: "Transient",
          bounceSubType: "MailboxFull",
        });
      }),
  );

  it.effect("adds an untagged transient bounce to the window and writes no campaign row", () =>
    Effect.gen(function* () {
      const world = yield* run(bounceEvent("Transient", "General", ["soft@example.com"], untagged));

      expect(world.suppressions.size).toBe(0);
      expect(world.transients.get("soft@example.com")).toStrictEqual(new Set([windowEntry]));
      expect(world.writes).toHaveLength(0);
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
      expect(world.writes[0]?.counter).toBe("complained");
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
      expect(world.writes[0]?.counter).toBeUndefined();
      expect(world.writes[0]?.row.complaintSubType).toBe("OnAccountSuppressionList");
    }),
  );

  it.effect("records a not-spam report without suppressing or counting", () =>
    Effect.gen(function* () {
      const world = yield* run(complaintEvent("not-spam"));

      expect(world.suppressions.size).toBe(0);
      expect(world.writes).toHaveLength(1);
      expect(world.writes[0]?.counter).toBeUndefined();
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

  it.effect("adds a transient bounce delivered again later only once", () =>
    Effect.gen(function* () {
      const world = emptyWorld();
      const event = bounceEvent("Transient", "General", ["soft@example.com"], untagged);

      yield* handling(world, envelope(event, "envelope-1"));
      // A redelivery is processed later: the entry must follow the bounce, not the processing.
      yield* TestClock.adjust("2 hours");
      yield* handling(world, envelope(event, "envelope-2"));

      expect(world.transients.get("soft@example.com")).toStrictEqual(new Set([windowEntry]));
    }),
  );

  it.effect("fails the invocation when the suppression write is unavailable", () =>
    Effect.gen(function* () {
      const world = emptyWorld();

      const unavailable = Layer.succeed(FeedbackStore)({
        ...storageOperations(world),
        suppressAddress: () =>
          Effect.fail(
            new StorageUnavailable({
              operation: "suppressAddress",
              failure: "InternalServerError",
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
      const world = yield* run(bounceEvent("Permanent", "General", ["hard@example.com"], untagged));

      expect(world.suppressions.has("hard@example.com")).toBe(true);
      expect(world.writes).toHaveLength(0);
      expect(logsNamed(world, "feedback without a campaign tag")).toHaveLength(1);
      expect(logsNamed(world, "feedback without a campaign tag")[0]?.level).toBe("Info");
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
          recordFeedback: (row, counter) =>
            historyFails
              ? Effect.fail(
                  new StorageUnavailable({
                    operation: "recordFeedback",
                    failure: "InternalServerError",
                  }),
                )
              : storageOperations(world).recordFeedback(row, counter),
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

describe("write outcomes and summary", () => {
  it.effect("logs a warning when the campaign is unknown", () =>
    Effect.gen(function* () {
      const world = emptyWorld();

      const unknown = Layer.succeed(FeedbackStore)({
        ...storageOperations(world),
        recordFeedback: (row, counter) =>
          Effect.suspend(() => {
            world.writes.push({ row, counter });
            world.writeOutcomes.push("unknown-campaign");

            return Effect.fail(new CampaignNotFound());
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
});
