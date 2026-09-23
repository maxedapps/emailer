import { NodeCrypto } from "@effect/platform-node";
import * as Schemas from "@emailer/api/Schemas";
import {
  Clock,
  ConfigProvider,
  Duration,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Result,
} from "effect";
import { TestClock } from "effect/testing";
import { RateLimiter } from "effect/unstable/persistence";
import { describe, expect, it } from "vitest";

import { CampaignWake } from "../campaigns/Campaigns.ts";
import { DispatchGuard, memberPageSize, runSlice, SliceOverrun } from "./Dispatching.ts";
import { Mailer, SubmissionUncertain } from "./Mailer.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { unusedAudience } from "../storage/Testing.ts";

import type { PauseReason } from "@emailer/api/Schemas";
import type { OutgoingMessage, SubmissionOutcome } from "./Mailer.ts";
import type { SendGuard } from "./SendGuard.ts";
import type { AddressStatus } from "../storage/Addresses.ts";
import type { RecipientSettlement, SkipReason } from "../storage/Campaigns.ts";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const runToken = "0195f0a0-1111-4222-8333-44444444e5d1";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const createdAt = "2026-09-11T10:00:00.000Z";

const memberA: Schemas.Contact = {
  id: "0195f0a0-1111-4222-8333-44444444c001",
  email: "success+a@simulator.amazonses.com",
  createdAt,
  attributes: { plan: "pro", city: "Berlin" },
};

const memberB: Schemas.Contact = {
  id: "0195f0a0-1111-4222-8333-44444444c002",
  email: "success+b@simulator.amazonses.com",
  createdAt,
  attributes: { plan: "pro" },
};

const memberC: Schemas.Contact = {
  id: "0195f0a0-1111-4222-8333-44444444c003",
  email: "success+c@simulator.amazonses.com",
  createdAt,
};

const subject = "Release notes";

const text = "Hello there";

const defaultGuard: SendGuard = {
  limit: 8,
  dailyExhausted: false,
  halted: Option.none(),
};

const zeros = { accepted: 0, bounced: 0, complained: 0 };

const sliceTimeout = Duration.minutes(5);

const unsubscribeEnv = {
  EMAILER_UNSUBSCRIBE_URL: "https://unsubscribe.example.com/",
  EMAILER_UNSUBSCRIBE_SECRET: "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718293a4b5c6d7e8f90",
};

const configuration = Layer.succeed(ConfigProvider.ConfigProvider)(
  ConfigProvider.fromEnvRecord(unsubscribeEnv),
);

interface RecipientRow {
  readonly sendId?: string;
  readonly contactId: string;
  readonly recipient: string;
  readonly state: "unconfirmed" | "accepted" | "rejected" | "uncertain" | "skipped";
  readonly skipReason?: SkipReason;
  readonly rejectionCode?: Schemas.RejectionCode;
  readonly messageId?: string;
}

interface World {
  readonly runToken: string;
  beginOutcome: "running" | "stale";
  checkpointOutcome: "updated" | "condition-failed";
  cursor: string | undefined;
  html: string | undefined;
  listMissing: boolean;
  members: ReadonlyArray<Schemas.Contact>;
  nextCursor: string | undefined;
  statuses: Map<string, AddressStatus>;
  rows: Map<string, RecipientRow>;
  counters: { accepted: number; rejected: number; uncertain: number; skipped: number };
  claims: Array<string>;
  skips: Array<{ readonly contactId: string; readonly reason: SkipReason }>;
  settlements: Array<{ readonly contactId: string; readonly settlement: RecipientSettlement }>;
  checkpoints: Array<{
    readonly sliceId: string;
    readonly previous: string | undefined;
    readonly next: string;
  }>;
  paused: Array<{ readonly reason: PauseReason; readonly cursor: string | undefined }>;
  completed: number;
  listCalls: Array<{
    readonly listId: string;
    readonly limit: number;
    readonly cursor: string | undefined;
  }>;
  statusCalls: Array<string>;
  filter: Schemas.ContactAttributes | undefined;
  run: { accepted: number; bounced: number; complained: number };
}

const emptyCounters = () => ({
  accepted: 0,
  rejected: 0,
  uncertain: 0,
  skipped: 0,
});

const emptyWorld = (): World => ({
  runToken,
  beginOutcome: "running",
  checkpointOutcome: "updated",
  cursor: undefined,
  html: undefined,
  listMissing: false,
  members: [memberA],
  nextCursor: undefined,
  statuses: new Map(),
  rows: new Map(),
  counters: emptyCounters(),
  claims: [],
  skips: [],
  settlements: [],
  checkpoints: [],
  paused: [],
  completed: 0,
  listCalls: [],
  statusCalls: [],
  filter: undefined,
  run: { ...zeros },
});

const notExercised = (operation: string) =>
  Effect.die(new Error(`CampaignStore.${operation} is not exercised by this test`));

const storageLayer = (world: World): Layer.Layer<AudienceStore | CampaignStore> =>
  Layer.mergeAll(
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      listMembers: (id, limit, cursor) =>
        Effect.sync(() => {
          world.listCalls.push({ listId: id, limit, cursor });

          if (world.listMissing) {
            return Option.none();
          }

          return Option.some({ items: world.members, nextCursor: world.nextCursor });
        }),
      addressStatus: (email) =>
        Effect.sync(() => {
          world.statusCalls.push(email);

          return world.statuses.get(email) ?? ("mailable" as const);
        }),
    }),
    Layer.succeed(CampaignStore)({
      createCampaign: () => notExercised("createCampaign"),
      getCampaignBody: () =>
        Effect.succeed(world.html === undefined ? { text } : { text, html: world.html }),
      getCampaign: () => notExercised("getCampaign"),
      listCampaigns: () => notExercised("listCampaigns"),
      getCampaignControl: () => notExercised("getCampaignControl"),
      enqueueCampaign: () => notExercised("enqueueCampaign"),
      scheduleCampaign: () => notExercised("scheduleCampaign"),
      resumeCampaign: () => notExercised("resumeCampaign"),
      cancelCampaign: () => notExercised("cancelCampaign"),
      beginRun: (_id, token) =>
        Effect.sync(() => {
          if (world.beginOutcome === "stale" || token !== world.runToken) {
            return "stale" as const;
          }

          return {
            outcome: "running" as const,
            campaign: {
              listId,
              subject,
              cursor: world.cursor,
              filter: world.filter,
              run: world.run,
            },
          };
        }),
      claimRecipient: (_id, token, contactId, recipient, sendId) =>
        Effect.sync(() => {
          if (token !== world.runToken) {
            return "stale" as const;
          }

          if (world.rows.has(contactId)) {
            return "already-claimed" as const;
          }

          world.rows.set(contactId, {
            sendId,
            contactId,
            recipient,
            state: "unconfirmed",
          });
          world.claims.push(contactId);

          return "claimed" as const;
        }),
      skipRecipient: (_id, token, contactId, recipient, reason) =>
        Effect.sync(() => {
          if (token !== world.runToken) {
            return "stale" as const;
          }

          if (world.rows.has(contactId)) {
            return "already-claimed" as const;
          }

          world.rows.set(contactId, {
            contactId,
            recipient,
            state: "skipped",
            skipReason: reason,
          });
          world.skips.push({ contactId, reason });
          world.counters.skipped += 1;

          return "skipped" as const;
        }),
      settleRecipient: (_id, sendId, contactId, settlement) =>
        Effect.sync(() => {
          const row = world.rows.get(contactId);

          if (row === undefined || row.sendId !== sendId || row.state !== "unconfirmed") {
            return "not-current" as const;
          }

          const settled: RecipientRow = {
            sendId: row.sendId,
            contactId,
            recipient: row.recipient,
            state: settlement.state,
          };

          if (settlement.state === "accepted") {
            world.rows.set(contactId, { ...settled, messageId: settlement.messageId });
          } else if (settlement.state === "rejected") {
            world.rows.set(contactId, { ...settled, rejectionCode: settlement.rejectionCode });
          } else {
            world.rows.set(contactId, settled);
          }

          world.settlements.push({ contactId, settlement });
          world.counters[settlement.state] += 1;

          return "settled" as const;
        }),
      checkpoint: (_id, token, sliceId, previous, next) =>
        Effect.sync(() => {
          if (token !== world.runToken) {
            return "condition-failed" as const;
          }

          world.checkpoints.push({ sliceId, previous, next });

          if (world.checkpointOutcome === "condition-failed") {
            return "condition-failed" as const;
          }

          world.cursor = next;

          return "updated" as const;
        }),
      completeRun: (_id, token) =>
        Effect.sync(() => {
          if (token !== world.runToken) {
            return "stale" as const;
          }

          world.completed += 1;

          return "completed" as const;
        }),
      pauseRun: (_id, token, reason, cursor) =>
        Effect.sync(() => {
          if (token !== world.runToken) {
            return "stale" as const;
          }

          world.paused.push({ reason, cursor });

          return "paused" as const;
        }),
    }),
  );

interface LimiterDouble {
  readonly layer: Layer.Layer<RateLimiter.RateLimiter>;
  readonly consumes: Array<{
    readonly key: string;
    readonly window: Duration.Input;
    readonly limit: number;
    readonly onExceeded: "delay" | "fail" | undefined;
    readonly algorithm: "fixed-window" | "token-bucket" | undefined;
  }>;
}

const limiterDouble = (delays: ReadonlyArray<Duration.Duration> = []): LimiterDouble => {
  const consumes: LimiterDouble["consumes"] = [];
  const remaining = [...delays];

  const layer = Layer.succeed(RateLimiter.RateLimiter)({
    [RateLimiter.TypeId]: RateLimiter.TypeId,
    consume: (options) =>
      Effect.sync(() => {
        consumes.push({
          key: options.key,
          window: options.window,
          limit: options.limit,
          onExceeded: options.onExceeded,
          algorithm: options.algorithm,
        });

        return {
          delay: remaining.shift() ?? Duration.zero,
          limit: options.limit,
          remaining: options.limit,
          resetAfter: Duration.zero,
        };
      }),
    adaptiveConsume: () =>
      Effect.die(new Error("RateLimiter.adaptiveConsume is not exercised by this test")),
    adaptiveFeedback: () =>
      Effect.die(new Error("RateLimiter.adaptiveFeedback is not exercised by this test")),
  });

  return { layer, consumes };
};

interface MailerDouble {
  readonly layer: Layer.Layer<Mailer>;
  readonly submits: Array<OutgoingMessage>;
}

const mailerDouble = (
  outcomes: ReadonlyArray<SubmissionOutcome | SubmissionUncertain> = [],
): MailerDouble => {
  const submits: Array<OutgoingMessage> = [];
  const remaining = [...outcomes];

  const layer = Layer.succeed(Mailer)({
    sender: "no-reply@example.com",
    submit: (message) =>
      Effect.gen(function* () {
        submits.push(message);

        const next = remaining.shift();

        if (next instanceof SubmissionUncertain) {
          return yield* next;
        }

        return next ?? { outcome: "accepted" as const, messageId: "ses-message" };
      }),
  });

  return { layer, submits };
};

interface WakeDouble {
  readonly layer: Layer.Layer<CampaignWake>;
  readonly messages: Array<{ readonly campaignId: string; readonly runToken: string }>;
}

const wakeDouble = (): WakeDouble => {
  const messages: Array<{ readonly campaignId: string; readonly runToken: string }> = [];

  const layer = Layer.succeed(CampaignWake)({
    enqueue: (id, token) =>
      Effect.sync(() => {
        messages.push({ campaignId: id, runToken: token });
      }),
  });

  return { layer, messages };
};

interface Scenario {
  readonly members?: ReadonlyArray<Schemas.Contact>;
  readonly nextCursor?: string;
  readonly cursor?: string;
  readonly filter?: Schemas.ContactAttributes;
  readonly html?: string;
  readonly beginOutcome?: "running" | "stale";
  readonly checkpointOutcome?: "updated" | "condition-failed";
  readonly listMissing?: boolean;
  readonly statuses?: ReadonlyArray<readonly [string, AddressStatus]>;
  readonly claimed?: ReadonlyArray<string>;
  readonly guard?: SendGuard;
  readonly run?: { accepted: number; bounced: number; complained: number };
  readonly delays?: ReadonlyArray<Duration.Duration>;
  readonly outcomes?: ReadonlyArray<SubmissionOutcome | SubmissionUncertain>;
}

interface Fixture {
  readonly world: World;
  readonly wake: WakeDouble;
  readonly mailer: MailerDouble;
  readonly limiter: LimiterDouble;
  readonly layer: Layer.Layer<
    CampaignWake | AudienceStore | CampaignStore | Mailer | RateLimiter.RateLimiter | DispatchGuard
  >;
}

const fixture = (scenario: Scenario = {}): Fixture => {
  const world = emptyWorld();

  world.members = scenario.members ?? [memberA];
  world.nextCursor = scenario.nextCursor;
  world.cursor = scenario.cursor;
  world.filter = scenario.filter;
  world.html = scenario.html;
  world.beginOutcome = scenario.beginOutcome ?? "running";
  world.checkpointOutcome = scenario.checkpointOutcome ?? "updated";
  world.listMissing = scenario.listMissing ?? false;
  world.run = scenario.run ?? { ...zeros };

  for (const [email, status] of scenario.statuses ?? []) {
    world.statuses.set(email, status);
  }

  for (const contactId of scenario.claimed ?? []) {
    const member = world.members.find((item) => item.id === contactId);

    world.rows.set(contactId, {
      sendId: "already-claimed",
      contactId,
      recipient: member?.email ?? "unknown@example.com",
      state: "unconfirmed",
    });
  }

  const wake = wakeDouble();
  const mailer = mailerDouble(scenario.outcomes);
  const limiter = limiterDouble(scenario.delays);
  const guard = scenario.guard ?? defaultGuard;

  return {
    world,
    wake,
    mailer,
    limiter,
    layer: Layer.mergeAll(
      storageLayer(world),
      wake.layer,
      mailer.layer,
      limiter.layer,
      Layer.succeed(DispatchGuard)({ current: Effect.succeed(guard) }),
      NodeCrypto.layer,
      configuration,
    ),
  };
};

const runSliceNow = (fix: Fixture, extraDeadline = sliceTimeout) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    return yield* Effect.result(
      runSlice({ campaignId, runToken }, now + Duration.toMillis(extraDeadline)),
    ).pipe(Effect.provide(fix.layer));
  });

const onTestClock = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.provide(Layer.mergeAll(TestClock.layer(), NodeCrypto.layer, configuration)),
  );

const successOf = <A, E>(attempt: Result.Result<A, E>): A => {
  if (Result.isFailure(attempt)) {
    throw new Error("Expected the slice to succeed");
  }

  return attempt.success;
};

const failureOf = <A, E>(attempt: Result.Result<A, E>): E => {
  if (Result.isSuccess(attempt)) {
    throw new Error("Expected the slice to fail");
  }

  return attempt.failure;
};

describe("runSlice", () => {
  it("settles each member of a page, increments counters, and enqueues one continuation", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ members: [memberA, memberB], nextCursor: memberC.id });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.listCalls).toStrictEqual([
            { listId, limit: memberPageSize, cursor: undefined },
          ]);
          expect(fix.world.claims).toStrictEqual([memberA.id, memberB.id]);
          expect(fix.world.settlements).toHaveLength(2);
          expect(fix.world.counters.accepted).toBe(2);
          expect(fix.mailer.submits.map((submit) => submit.recipient)).toStrictEqual([
            memberA.email,
            memberB.email,
          ]);
          expect(fix.limiter.consumes).toHaveLength(2);
          expect(
            fix.limiter.consumes.every((consumed) => consumed.limit === defaultGuard.limit),
          ).toBe(true);
          expect(fix.limiter.consumes[0]).toMatchObject({
            key: "ses-send",
            window: "1 second",
            onExceeded: "delay",
            algorithm: "fixed-window",
          });
          expect(fix.world.checkpoints).toMatchObject([{ previous: undefined, next: memberC.id }]);
          expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken }]);
          expect(fix.world.completed).toBe(0);
        }),
      ),
    ));

  it("hands the mailer the body the store's body read returned", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ members: [memberA] });

          successOf(yield* runSliceNow(fix));

          expect(fix.mailer.submits.map((submit) => submit.text)).toStrictEqual([text]);
        }),
      ),
    ));

  it("completes the last page and enqueues nothing", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ members: [memberA] });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.counters.accepted).toBe(1);
          expect(fix.world.completed).toBe(1);
          expect(fix.world.checkpoints).toHaveLength(0);
          expect(fix.wake.messages).toHaveLength(0);
        }),
      ),
    ));

  it("submits the campaign html on the outgoing message", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const html = "<p>Hello there</p>";
          const fix = fixture({ html });

          successOf(yield* runSliceNow(fix));

          expect(fix.mailer.submits).toHaveLength(1);
          expect(fix.mailer.submits[0]?.html).toBe(html);
        }),
      ),
    ));

  it("submits html undefined when the campaign has no html", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture();

          successOf(yield* runSliceNow(fix));

          expect(fix.mailer.submits).toHaveLength(1);
          expect(fix.mailer.submits[0]?.html).toBeUndefined();
        }),
      ),
    ));

  it("skips unsubscribed and suppressed members", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            members: [memberA, memberB, memberC],
            statuses: [
              [memberA.email, "unsubscribed"],
              [memberB.email, "suppressed"],
            ],
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.skips).toStrictEqual([
            { contactId: memberA.id, reason: "unsubscribed" },
            { contactId: memberB.id, reason: "suppressed" },
          ]);
          expect(fix.world.counters.skipped).toBe(2);
          expect(fix.world.counters.accepted).toBe(1);
          expect(fix.mailer.submits).toHaveLength(1);
          expect(fix.world.completed).toBe(1);
        }),
      ),
    ));

  it("claims nothing and submits nothing on a redelivered slice, then completes", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ members: [memberA, memberB], claimed: [memberA.id, memberB.id] });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.claims).toHaveLength(0);
          expect(fix.mailer.submits).toHaveLength(0);
          expect(fix.limiter.consumes).toHaveLength(2);
          expect(fix.world.completed).toBe(1);
          expect(fix.wake.messages).toHaveLength(0);
        }),
      ),
    ));

  it("submits nothing when the run token is stale", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ beginOutcome: "stale" });
          const entries: Array<{ readonly level: string; readonly message: unknown }> = [];
          const now = yield* Clock.currentTimeMillis;

          const attempt = yield* Effect.result(
            runSlice({ campaignId, runToken }, now + Duration.toMillis(sliceTimeout)),
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                fix.layer,
                Logger.layer([
                  Logger.make((options) => {
                    entries.push({ level: options.logLevel, message: options.message });
                  }),
                ]),
              ),
            ),
          );

          successOf(attempt);

          expect(fix.world.claims).toHaveLength(0);
          expect(fix.mailer.submits).toHaveLength(0);
          expect(fix.world.listCalls).toHaveLength(0);
          expect(fix.world.settlements).toHaveLength(0);
          expect(fix.world.completed).toBe(0);
          expect(fix.wake.messages).toHaveLength(0);

          const stale = entries.filter((entry) => {
            // SAFETY: Effect.logInfo(message, data) reaches a logger as [message, data].
            const recorded = entry.message as ReadonlyArray<unknown> | string | undefined;

            return Array.isArray(recorded)
              ? recorded[0] === "stale wake discarded"
              : recorded === "stale wake discarded";
          });

          expect(stale).toHaveLength(1);
          expect(stale[0]?.level).toBe("Info");
          expect(stale[0]?.message).toStrictEqual([
            "stale wake discarded",
            { campaignId, runToken, disposition: "stale" },
          ]);
        }),
      ),
    ));

  it("still settles an already-claimed recipient after a stale begin", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ beginOutcome: "stale", claimed: [memberA.id] });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.claims).toHaveLength(0);
          expect(fix.mailer.submits).toHaveLength(0);
          expect(fix.wake.messages).toHaveLength(0);

          const outcome = yield* CampaignStore.pipe(
            Effect.flatMap((campaigns) =>
              campaigns.settleRecipient(
                campaignId,
                "already-claimed",
                memberA.id,
                { state: "accepted", messageId: "late-ses" },
                createdAt,
              ),
            ),
            Effect.provide(fix.layer),
          );

          expect(outcome).toBe("settled");
          expect(fix.world.settlements).toStrictEqual([
            {
              contactId: memberA.id,
              settlement: { state: "accepted", messageId: "late-ses" },
            },
          ]);
        }),
      ),
    ));

  it("checkpoints at the last processed member when a later delay would overrun", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            members: [memberA, memberB],
            delays: [Duration.zero, Duration.hours(1)],
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.counters.accepted).toBe(1);
          expect(fix.world.claims).toStrictEqual([memberA.id]);
          expect(fix.mailer.submits).toHaveLength(1);
          expect(fix.world.checkpoints).toMatchObject([{ previous: undefined, next: memberA.id }]);
          expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken }]);
          expect(fix.world.completed).toBe(0);
        }),
      ),
    ));

  it("submits the unclaimed member on the slice after a budget overrun", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const continuation = fixture({
            members: [memberA, memberB],
            claimed: [memberA.id],
          });

          successOf(yield* runSliceNow(continuation));

          expect(continuation.world.claims).toStrictEqual([memberB.id]);
          expect(continuation.mailer.submits).toHaveLength(1);
          expect(continuation.mailer.submits[0]?.recipient).toBe(memberB.email);
          expect(continuation.world.completed).toBe(1);
        }),
      ),
    ));

  it("fails the invocation when the first member already overruns", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ delays: [Duration.hours(1)] });

          const attempt = yield* runSliceNow(fix);

          expect(failureOf(attempt)).toBeInstanceOf(SliceOverrun);
          expect(fix.world.claims).toHaveLength(0);
          expect(fix.mailer.submits).toHaveLength(0);
          expect(fix.world.checkpoints).toHaveLength(0);
          expect(fix.wake.messages).toHaveLength(0);
        }),
      ),
    ));

  it("enqueues nothing when a checkpoint is lost", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            members: [memberA],
            nextCursor: memberB.id,
            checkpointOutcome: "condition-failed",
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.counters.accepted).toBe(1);
          expect(fix.world.checkpoints).toHaveLength(1);
          expect(fix.wake.messages).toHaveLength(0);
          expect(fix.world.completed).toBe(0);
        }),
      ),
    ));

  it("retries rate-limited submissions with 1s, 2s, 4s backoff then pauses", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            outcomes: [
              { outcome: "rejected", rejectionCode: "rate-limited" },
              { outcome: "rejected", rejectionCode: "rate-limited" },
              { outcome: "rejected", rejectionCode: "rate-limited" },
              { outcome: "rejected", rejectionCode: "rate-limited" },
            ],
          });

          const fiber = yield* Effect.forkChild(runSliceNow(fix));

          yield* TestClock.adjust("7 seconds");

          successOf(yield* Fiber.join(fiber));

          expect(fix.mailer.submits).toHaveLength(4);
          expect(fix.limiter.consumes).toHaveLength(4);
          expect(
            fix.limiter.consumes.every((consumed) => consumed.limit === defaultGuard.limit),
          ).toBe(true);
          expect(fix.world.counters.rejected).toBe(1);
          expect(fix.world.rows.get(memberA.id)?.state).toBe("rejected");
          expect(fix.world.paused).toStrictEqual([{ reason: "rate-limited", cursor: memberA.id }]);
          expect(fix.wake.messages).toHaveLength(0);
        }),
      ),
    ));

  it("pauses on sending-paused after settling the recipient rejected", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            outcomes: [{ outcome: "rejected", rejectionCode: "sending-paused" }],
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.counters.rejected).toBe(1);
          expect(fix.world.paused).toStrictEqual([
            { reason: "sending-paused", cursor: memberA.id },
          ]);
          expect(fix.wake.messages).toHaveLength(0);
          expect(fix.world.completed).toBe(0);
        }),
      ),
    ));

  it("pauses for the daily quota before any claim", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            cursor: memberA.id,
            guard: { limit: 8, dailyExhausted: true, halted: Option.none() },
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.claims).toHaveLength(0);
          expect(fix.world.listCalls).toHaveLength(0);
          expect(fix.mailer.submits).toHaveLength(0);
          expect(fix.world.paused).toStrictEqual([{ reason: "daily-quota", cursor: memberA.id }]);
        }),
      ),
    ));

  it("completes when the list is missing", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ listMissing: true });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.completed).toBe(1);
          expect(fix.world.claims).toHaveLength(0);
          expect(fix.wake.messages).toHaveLength(0);
        }),
      ),
    ));

  it("consumes the limiter once per attempt with the run's limit", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            members: [memberA, memberB],
            guard: { limit: 3, dailyExhausted: false, halted: Option.none() },
            outcomes: [
              { outcome: "rejected", rejectionCode: "message-rejected" },
              { outcome: "accepted", messageId: "ses-message" },
            ],
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.limiter.consumes.map((consumed) => consumed.limit)).toStrictEqual([3, 3]);
          expect(fix.world.counters.rejected).toBe(1);
          expect(fix.world.counters.accepted).toBe(1);
        }),
      ),
    ));

  it("pauses for reputation before any claim or limiter call", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            cursor: memberA.id,
            guard: { limit: 8, dailyExhausted: false, halted: Option.some("alarm") },
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.claims).toHaveLength(0);
          expect(fix.world.listCalls).toHaveLength(0);
          expect(fix.limiter.consumes).toHaveLength(0);
          expect(fix.mailer.submits).toHaveLength(0);
          expect(fix.world.paused).toStrictEqual([{ reason: "reputation", cursor: memberA.id }]);
        }),
      ),
    ));

  it("does not trip the breaker at 199 accepted with 199 bounced", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ run: { accepted: 199, bounced: 199, complained: 0 } });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.paused).toHaveLength(0);
          expect(fix.world.claims).toStrictEqual([memberA.id]);
          expect(fix.world.completed).toBe(1);
        }),
      ),
    ));

  it("trips the breaker at 200 accepted with 10 bounced", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            cursor: memberA.id,
            run: { accepted: 200, bounced: 10, complained: 0 },
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.claims).toHaveLength(0);
          expect(fix.world.listCalls).toHaveLength(0);
          expect(fix.limiter.consumes).toHaveLength(0);
          expect(fix.world.paused).toStrictEqual([{ reason: "feedback", cursor: memberA.id }]);
        }),
      ),
    ));

  it("does not trip the breaker at 200 accepted with 9 bounced", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ run: { accepted: 200, bounced: 9, complained: 0 } });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.paused).toHaveLength(0);
          expect(fix.world.claims).toStrictEqual([memberA.id]);
        }),
      ),
    ));

  it("trips the breaker at 1000 accepted with 1 complaint", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            cursor: memberA.id,
            run: { accepted: 1000, bounced: 0, complained: 1 },
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.claims).toHaveLength(0);
          expect(fix.world.listCalls).toHaveLength(0);
          expect(fix.limiter.consumes).toHaveLength(0);
          expect(fix.world.paused).toStrictEqual([{ reason: "feedback", cursor: memberA.id }]);
        }),
      ),
    ));

  it("does not trip the breaker at 999 accepted with 1 complaint", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({ run: { accepted: 999, bounced: 0, complained: 1 } });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.paused).toHaveLength(0);
          expect(fix.world.claims).toStrictEqual([memberA.id]);
        }),
      ),
    ));

  it("pauses for reputation, not daily quota, when the guard is halted and the quota is exhausted", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            cursor: memberA.id,
            guard: { limit: 8, dailyExhausted: true, halted: Option.some("enforcement") },
            run: { accepted: 200, bounced: 200, complained: 0 },
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.claims).toHaveLength(0);
          expect(fix.world.paused).toStrictEqual([{ reason: "reputation", cursor: memberA.id }]);
        }),
      ),
    ));

  it("pauses for daily quota before the breaker is evaluated", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            cursor: memberA.id,
            guard: { limit: 8, dailyExhausted: true, halted: Option.none() },
            run: { accepted: 200, bounced: 200, complained: 0 },
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.paused).toStrictEqual([{ reason: "daily-quota", cursor: memberA.id }]);
        }),
      ),
    ));

  it("skips bouncing members", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            members: [memberA],
            statuses: [[memberA.email, "bouncing"]],
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.skips).toStrictEqual([{ contactId: memberA.id, reason: "bouncing" }]);
          expect(fix.world.claims).toHaveLength(0);
          expect(fix.mailer.submits).toHaveLength(0);
          expect(fix.world.completed).toBe(1);
        }),
      ),
    ));

  it("skips members a two-entry filter does not match without a row, a status read, a limiter slot or a submission", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const later = "0195f0a0-1111-4222-8333-44444444c099";

          const fix = fixture({
            members: [memberA, memberB, memberC],
            filter: { plan: "pro", city: "Berlin" },
            nextCursor: later,
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.counters.accepted).toBe(1);
          expect(fix.world.rows.get(memberA.id)?.state).toBe("accepted");
          expect(fix.world.rows.has(memberB.id)).toBe(false);
          expect(fix.world.rows.has(memberC.id)).toBe(false);
          expect(fix.world.counters.skipped).toBe(0);
          expect(fix.world.statusCalls).toStrictEqual([memberA.email]);
          expect(fix.limiter.consumes).toHaveLength(1);
          expect(fix.mailer.submits.map((submit) => submit.recipient)).toStrictEqual([
            memberA.email,
          ]);
          expect(fix.world.checkpoints).toMatchObject([{ previous: undefined, next: later }]);
          expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken }]);
          expect(fix.world.completed).toBe(0);
        }),
      ),
    ));

  it("checkpoints at a filtered member when the next delay would overrun", () =>
    Effect.runPromise(
      onTestClock(
        Effect.gen(function* () {
          const fix = fixture({
            members: [memberB, memberA],
            filter: { plan: "pro", city: "Berlin" },
            delays: [Duration.hours(1)],
          });

          successOf(yield* runSliceNow(fix));

          expect(fix.world.checkpoints).toMatchObject([{ previous: undefined, next: memberB.id }]);
          expect(fix.world.rows.has(memberB.id)).toBe(false);
          expect(fix.world.claims).toHaveLength(0);
          expect(fix.mailer.submits).toHaveLength(0);
          expect(fix.limiter.consumes).toHaveLength(1);
          expect(fix.world.statusCalls).toStrictEqual([memberA.email]);
          expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken }]);
          expect(fix.world.completed).toBe(0);
        }),
      ),
    ));
});
