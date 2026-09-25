import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import {
  Clock,
  ConfigProvider,
  Crypto,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Predicate,
  Result,
} from "effect";
import { TestClock } from "effect/testing";

import { unsubscribeLink } from "../consent/Unsubscribe.ts";
import { memberPageSize, runSlice, SliceOverrun } from "./Dispatching.ts";
import { CampaignWake } from "./Dispatch.ts";
import {
  Mailer,
  SendingSuspended,
  SendRejected,
  SendThrottled,
  SubmissionUncertain,
} from "./Mailer.ts";
import { SendGuard } from "./SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore, RunSuperseded, SettlementNotApplied } from "../storage/Campaigns.ts";
import { unusedAudience, unusedCampaigns } from "../storage/Testing.ts";

import type { AddressStatus, PauseReason, SkipReason } from "@emailer/api/Schemas";
import type { SendError, SendPurpose } from "./Mailer.ts";
import type { MessageContent } from "./Message.ts";
import type { SendAllowance } from "./SendGuard.ts";
import type { SubmissionOutcome } from "../storage/Campaigns.ts";

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

const defaultGuard: SendAllowance = { limit: 8 };

const sliceTimeout = Duration.minutes(5);

const unsubscribeEnv = {
  EMAILER_UNSUBSCRIBE_URL: "https://unsubscribe.example.com/",
  EMAILER_UNSUBSCRIBE_SECRET: "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718293a4b5c6d7e8f90",
};

const configurationOf = (env: Readonly<Record<string, string>>) =>
  Layer.succeed(ConfigProvider.ConfigProvider)(ConfigProvider.fromEnvRecord(env));

interface RecipientRow {
  readonly sendId?: string;
  readonly contactId: string;
  readonly recipient: string;
  readonly state: "unconfirmed" | "accepted" | "rejected" | "uncertain" | "skipped";
  readonly skipReason?: SkipReason;
  readonly rejectionCode?: Schemas.RejectionCode;
  readonly messageId?: string;
}

interface RunFeedback {
  readonly accepted: number;
  readonly bounced: number;
  readonly complained: number;
}

interface World {
  readonly runToken: string;
  readonly beginOutcome: "running" | "stale";
  readonly checkpointOutcome: "updated" | "condition-failed";
  cursor: string | undefined;
  readonly html: string | undefined;
  readonly listMissing: boolean;
  readonly members: ReadonlyArray<Schemas.Contact>;
  readonly nextCursor: string | undefined;
  readonly statuses: ReadonlyMap<string, AddressStatus>;
  readonly rows: Map<string, RecipientRow>;
  readonly counters: { accepted: number; rejected: number; uncertain: number; skipped: number };
  readonly claims: Array<string>;
  readonly skips: Array<{ readonly contactId: string; readonly reason: SkipReason }>;
  readonly settlements: Array<{
    readonly contactId: string;
    readonly settlement: SubmissionOutcome;
  }>;
  readonly checkpoints: Array<{
    readonly sliceId: string;
    readonly previous: string | undefined;
    readonly next: string;
  }>;
  readonly paused: Array<{ readonly reason: PauseReason; readonly cursor: string | undefined }>;
  completed: number;
  readonly listCalls: Array<{
    readonly listId: string;
    readonly limit: number;
    readonly cursor: string | undefined;
  }>;
  readonly statusCalls: Array<string>;
  readonly filter: Schemas.ContactAttributes | undefined;
  readonly run: RunFeedback;
}

const storageLayer = (world: World): Layer.Layer<AudienceStore | CampaignStore> =>
  Layer.mergeAll(
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      listMembers: (id, limit, cursor) =>
        Effect.gen(function* () {
          world.listCalls.push({ listId: id, limit, cursor });

          if (world.listMissing) {
            return yield* new Errors.ListNotFound();
          }

          const items = [...world.members];

          return world.nextCursor === undefined
            ? { items }
            : { items, nextCursor: world.nextCursor };
        }),
      addressStatus: (email) =>
        Effect.sync(() => {
          world.statusCalls.push(email);

          return world.statuses.get(email) ?? ("mailable" as const);
        }),
    }),
    Layer.succeed(CampaignStore)({
      ...unusedCampaigns,
      getCampaignBody: () =>
        Effect.succeed(world.html === undefined ? { text } : { text, html: world.html }),
      beginRun: (_id, token) =>
        world.beginOutcome === "stale" || token !== world.runToken
          ? Effect.fail(new RunSuperseded())
          : Effect.succeed({
              listId,
              subject,
              cursor: world.cursor,
              filter: world.filter,
              run: world.run,
            }),
      claimRecipient: (_id, token, contactId, recipient, sendId) =>
        Effect.suspend(() => {
          if (token !== world.runToken) {
            return Effect.fail(new RunSuperseded());
          }

          if (world.rows.has(contactId)) {
            return Effect.succeed("already-claimed" as const);
          }

          world.rows.set(contactId, {
            sendId,
            contactId,
            recipient,
            state: "unconfirmed",
          });
          world.claims.push(contactId);

          return Effect.succeed("claimed" as const);
        }),
      skipRecipient: (_id, token, contactId, recipient, reason) =>
        Effect.suspend(() => {
          if (token !== world.runToken) {
            return Effect.fail(new RunSuperseded());
          }

          if (world.rows.has(contactId)) {
            return Effect.succeed("already-claimed" as const);
          }

          world.rows.set(contactId, {
            contactId,
            recipient,
            state: "skipped",
            skipReason: reason,
          });
          world.skips.push({ contactId, reason });
          world.counters.skipped += 1;

          return Effect.succeed("skipped" as const);
        }),
      settleRecipient: (_id, sendId, contactId, settlement) =>
        Effect.suspend(() => {
          const row = world.rows.get(contactId);

          if (row === undefined || row.sendId !== sendId || row.state !== "unconfirmed") {
            return Effect.fail(new SettlementNotApplied());
          }

          const settled: RecipientRow = {
            sendId: row.sendId,
            contactId,
            recipient: row.recipient,
            state: settlement.outcome,
          };

          if (settlement.outcome === "accepted") {
            world.rows.set(contactId, { ...settled, messageId: settlement.messageId });
          } else if (settlement.outcome === "rejected") {
            world.rows.set(contactId, { ...settled, rejectionCode: settlement.rejectionCode });
          } else {
            world.rows.set(contactId, settled);
          }

          world.settlements.push({ contactId, settlement });
          world.counters[settlement.outcome] += 1;

          return Effect.void;
        }),
      checkpoint: (_id, token, sliceId, previous, next) =>
        Effect.suspend(() => {
          if (token !== world.runToken) {
            return Effect.fail(new RunSuperseded());
          }

          world.checkpoints.push({ sliceId, previous, next });

          if (world.checkpointOutcome === "condition-failed") {
            return Effect.fail(new RunSuperseded());
          }

          world.cursor = next;

          return Effect.void;
        }),
      completeRun: (_id, token) =>
        Effect.suspend(() => {
          if (token !== world.runToken) {
            return Effect.fail(new RunSuperseded());
          }

          world.completed += 1;

          return Effect.void;
        }),
      pauseRun: (_id, token, reason, cursor) =>
        Effect.suspend(() => {
          if (token !== world.runToken) {
            return Effect.fail(new RunSuperseded());
          }

          world.paused.push({ reason, cursor });

          return Effect.void;
        }),
    }),
  );

interface GuardDouble {
  readonly layer: Layer.Layer<SendGuard>;
  /** The limit each pacing slot was taken with. */
  readonly slots: Array<number>;
}

const guardDouble = (
  allowance: SendAllowance,
  delays: ReadonlyArray<Duration.Duration> = [],
): GuardDouble => {
  const slots: Array<number> = [];
  const remaining = [...delays];

  const layer = Layer.succeed(SendGuard)({
    current: Effect.succeed(allowance),
    slot: (limit) =>
      Effect.sync(() => {
        slots.push(limit);

        return remaining.shift() ?? Duration.zero;
      }),
  });

  return { layer, slots };
};

interface SentMessage extends MessageContent {
  readonly recipient: string;
  readonly unsubscribeUrl: string;
  readonly purpose: SendPurpose;
}

interface MailerDouble {
  readonly layer: Layer.Layer<Mailer>;
  readonly sent: Array<SentMessage>;
}

/** SES's answer to a send: the message ID it accepted under, or the error it failed with. */
type Answer = string | SendError;

const mailerDouble = (answers: ReadonlyArray<Answer> = []): MailerDouble => {
  const sent: Array<SentMessage> = [];
  const remaining = [...answers];

  const layer = Layer.succeed(Mailer)({
    send: (recipient, content, unsubscribeUrl, purpose) =>
      Effect.suspend(() => {
        sent.push({ recipient, ...content, unsubscribeUrl, purpose });

        const answer = remaining.shift() ?? "ses-message";

        return Predicate.isString(answer) ? Effect.succeed(answer) : Effect.fail(answer);
      }),
  });

  return { layer, sent };
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
  readonly env?: Readonly<Record<string, string>>;
  readonly members?: ReadonlyArray<Schemas.Contact>;
  readonly nextCursor?: string;
  readonly cursor?: string;
  readonly filter?: Schemas.ContactAttributes;
  readonly html?: string | undefined;
  readonly beginOutcome?: "running" | "stale";
  readonly checkpointOutcome?: "updated" | "condition-failed";
  readonly listMissing?: boolean;
  readonly statuses?: ReadonlyArray<readonly [string, AddressStatus]>;
  /** Members a previous delivery of the slice already claimed. */
  readonly claimed?: ReadonlyArray<Schemas.Contact>;
  readonly guard?: SendAllowance;
  readonly run?: RunFeedback;
  readonly delays?: ReadonlyArray<Duration.Duration>;
  readonly answers?: ReadonlyArray<Answer>;
}

interface Fixture {
  readonly world: World;
  readonly wake: WakeDouble;
  readonly mailer: MailerDouble;
  readonly guard: GuardDouble;
  readonly layer: Layer.Layer<
    CampaignWake | AudienceStore | CampaignStore | Mailer | SendGuard | Crypto.Crypto
  >;
}

const fixture = (scenario: Scenario = {}): Fixture => {
  const world: World = {
    runToken,
    beginOutcome: scenario.beginOutcome ?? "running",
    checkpointOutcome: scenario.checkpointOutcome ?? "updated",
    cursor: scenario.cursor,
    html: scenario.html,
    listMissing: scenario.listMissing ?? false,
    members: scenario.members ?? [memberA],
    nextCursor: scenario.nextCursor,
    statuses: new Map(scenario.statuses ?? []),
    rows: new Map(
      (scenario.claimed ?? []).map((member): [string, RecipientRow] => [
        member.id,
        {
          sendId: "already-claimed",
          contactId: member.id,
          recipient: member.email,
          state: "unconfirmed",
        },
      ]),
    ),
    counters: { accepted: 0, rejected: 0, uncertain: 0, skipped: 0 },
    claims: [],
    skips: [],
    settlements: [],
    checkpoints: [],
    paused: [],
    completed: 0,
    listCalls: [],
    statusCalls: [],
    filter: scenario.filter,
    run: scenario.run ?? { accepted: 0, bounced: 0, complained: 0 },
  };

  const wake = wakeDouble();
  const mailer = mailerDouble(scenario.answers);
  const guard = guardDouble(scenario.guard ?? defaultGuard, scenario.delays);

  return {
    world,
    wake,
    mailer,
    guard,
    layer: Layer.mergeAll(
      storageLayer(world),
      wake.layer,
      mailer.layer,
      guard.layer,
      NodeCrypto.layer,
      configurationOf(scenario.env ?? unsubscribeEnv),
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

interface LogEntry {
  readonly level: string;
  readonly message: unknown;
}

/** A slice run with its log lines kept, and the lines a message names. */
const runSliceLogged = (
  fix: Fixture,
  replaced: Layer.Layer<never> | Layer.Layer<Mailer> = Layer.empty,
) =>
  Effect.gen(function* () {
    const entries: Array<LogEntry> = [];

    const logger = Logger.layer([
      Logger.make((options) => {
        entries.push({ level: options.logLevel, message: options.message });
      }),
    ]);

    const now = yield* Clock.currentTimeMillis;

    const attempt = yield* Effect.result(
      runSlice({ campaignId, runToken }, now + Duration.toMillis(sliceTimeout)),
    ).pipe(Effect.provide(Layer.mergeAll(fix.layer, replaced, logger)));

    const named = (name: string) =>
      entries.filter((entry) => {
        // SAFETY: Effect.logInfo(message, data) reaches a logger as [message, data].
        const recorded = entry.message as ReadonlyArray<unknown> | string | undefined;

        return Array.isArray(recorded) ? recorded[0] === name : recorded === name;
      });

    return { attempt, named };
  });

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
  it.effect(
    "settles each member of a page, increments counters, and enqueues one continuation",
    () =>
      Effect.gen(function* () {
        const fix = fixture({ members: [memberA, memberB], nextCursor: memberC.id });

        successOf(yield* runSliceNow(fix));

        expect(fix.world.listCalls).toStrictEqual([
          { listId, limit: memberPageSize, cursor: undefined },
        ]);
        expect(fix.world.claims).toStrictEqual([memberA.id, memberB.id]);
        expect(fix.world.settlements).toHaveLength(2);
        expect(fix.world.counters.accepted).toBe(2);
        expect(fix.mailer.sent.map((message) => message.recipient)).toStrictEqual([
          memberA.email,
          memberB.email,
        ]);
        expect(fix.guard.slots).toStrictEqual([defaultGuard.limit, defaultGuard.limit]);
        expect(fix.world.checkpoints).toMatchObject([{ previous: undefined, next: memberC.id }]);
        expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken }]);
        expect(fix.world.completed).toBe(0);
      }),
  );

  it.effect.each([
    { parts: "no html", html: undefined },
    { parts: "html", html: "<p>Hello there</p>" },
  ])("hands the mailer the subject and the stored body when the campaign has $parts", ({ html }) =>
    Effect.gen(function* () {
      const fix = fixture({ html });

      successOf(yield* runSliceNow(fix));

      expect(fix.mailer.sent).toMatchObject([{ subject, text, html }]);
    }),
  );

  it.effect("sends as the campaign, under the send id of the row it claimed", () =>
    Effect.gen(function* () {
      const fix = fixture({ members: [memberA] });

      successOf(yield* runSliceNow(fix));

      expect(fix.mailer.sent.map((message) => message.purpose)).toStrictEqual([
        { kind: "campaign", campaignId, sendId: fix.world.rows.get(memberA.id)?.sendId },
      ]);
      expect(fix.mailer.sent[0]?.subject).toBe(subject);
      expect(fix.mailer.sent[0]?.unsubscribeUrl).toBe(
        yield* unsubscribeLink(memberA.email).pipe(Effect.provide(configurationOf(unsubscribeEnv))),
      );
    }),
  );

  it.effect("completes the last page and enqueues nothing", () =>
    Effect.gen(function* () {
      const fix = fixture({ members: [memberA] });

      successOf(yield* runSliceNow(fix));

      expect(fix.world.counters.accepted).toBe(1);
      expect(fix.world.completed).toBe(1);
      expect(fix.world.checkpoints).toHaveLength(0);
      expect(fix.wake.messages).toHaveLength(0);
    }),
  );

  it.effect("skips unsubscribed and suppressed members", () =>
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
      expect(fix.mailer.sent).toHaveLength(1);
      expect(fix.world.completed).toBe(1);
    }),
  );

  it.effect("claims nothing and submits nothing on a redelivered slice, then completes", () =>
    Effect.gen(function* () {
      const fix = fixture({ members: [memberA, memberB], claimed: [memberA, memberB] });

      successOf(yield* runSliceNow(fix));

      expect(fix.world.claims).toHaveLength(0);
      expect(fix.mailer.sent).toHaveLength(0);
      expect(fix.guard.slots).toHaveLength(2);
      expect(fix.world.completed).toBe(1);
      expect(fix.wake.messages).toHaveLength(0);
    }),
  );

  it.effect("submits nothing when the run token is stale", () =>
    Effect.gen(function* () {
      const fix = fixture({ beginOutcome: "stale" });
      const { attempt, named } = yield* runSliceLogged(fix);

      successOf(attempt);
      expect(fix.world.claims).toHaveLength(0);
      expect(fix.mailer.sent).toHaveLength(0);
      expect(fix.world.listCalls).toHaveLength(0);
      expect(fix.world.settlements).toHaveLength(0);
      expect(fix.world.completed).toBe(0);
      expect(fix.wake.messages).toHaveLength(0);
      expect(named("stale wake discarded")).toStrictEqual([
        {
          level: "Info",
          message: ["stale wake discarded", { campaignId, runToken, disposition: "stale" }],
        },
      ]);
    }),
  );

  it.effect("checkpoints at the last processed member when a later delay would overrun", () =>
    Effect.gen(function* () {
      const fix = fixture({
        members: [memberA, memberB],
        delays: [Duration.zero, Duration.hours(1)],
      });

      successOf(yield* runSliceNow(fix));

      expect(fix.world.counters.accepted).toBe(1);
      expect(fix.world.claims).toStrictEqual([memberA.id]);
      expect(fix.mailer.sent).toHaveLength(1);
      expect(fix.world.checkpoints).toMatchObject([{ previous: undefined, next: memberA.id }]);
      expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken }]);
      expect(fix.world.completed).toBe(0);
    }),
  );

  it.effect("submits the unclaimed member on the slice after a budget overrun", () =>
    Effect.gen(function* () {
      const continuation = fixture({
        members: [memberA, memberB],
        claimed: [memberA],
      });

      successOf(yield* runSliceNow(continuation));

      expect(continuation.world.claims).toStrictEqual([memberB.id]);
      expect(continuation.mailer.sent).toHaveLength(1);
      expect(continuation.mailer.sent[0]?.recipient).toBe(memberB.email);
      expect(continuation.world.completed).toBe(1);
    }),
  );

  it.effect("fails the invocation when the first member already overruns", () =>
    Effect.gen(function* () {
      const fix = fixture({ delays: [Duration.hours(1)] });

      const attempt = yield* runSliceNow(fix);

      expect(failureOf(attempt)).toBeInstanceOf(SliceOverrun);
      expect(fix.world.claims).toHaveLength(0);
      expect(fix.mailer.sent).toHaveLength(0);
      expect(fix.world.checkpoints).toHaveLength(0);
      expect(fix.wake.messages).toHaveLength(0);
    }),
  );

  it.effect("claims no recipient when the unsubscribe link cannot be minted", () =>
    Effect.gen(function* () {
      const fix = fixture({
        env: { EMAILER_UNSUBSCRIBE_SECRET: unsubscribeEnv.EMAILER_UNSUBSCRIBE_SECRET },
      });

      const now = yield* Clock.currentTimeMillis;

      const exit = yield* Effect.exit(
        runSlice({ campaignId, runToken }, now + Duration.toMillis(sliceTimeout)),
      ).pipe(Effect.provide(fix.layer));

      expect(Exit.hasDies(exit)).toBe(true);
      expect(fix.world.claims).toHaveLength(0);
      expect(fix.world.rows.size).toBe(0);
      expect(fix.mailer.sent).toHaveLength(0);
    }),
  );

  it.effect("ends the slice as stale, enqueueing nothing, when its checkpoint is lost", () =>
    Effect.gen(function* () {
      const fix = fixture({
        members: [memberA],
        nextCursor: memberB.id,
        checkpointOutcome: "condition-failed",
      });

      const { attempt, named } = yield* runSliceLogged(fix);

      successOf(attempt);
      expect(fix.world.counters.accepted).toBe(1);
      expect(fix.world.checkpoints).toHaveLength(1);
      expect(fix.wake.messages).toHaveLength(0);
      expect(fix.world.completed).toBe(0);
      expect(named("stale wake discarded")).toHaveLength(1);
    }),
  );

  it.effect("logs a settlement another attempt already applied, and carries on", () =>
    Effect.gen(function* () {
      const fix = fixture({ members: [memberA, memberB] });

      // Another attempt settles memberA's row while this one's submission is in flight.
      const racing = Layer.succeed(Mailer)({
        send: (recipient) =>
          Effect.sync(() => {
            const row = fix.world.rows.get(memberA.id);

            if (recipient === memberA.email && row !== undefined) {
              fix.world.rows.set(memberA.id, { ...row, sendId: "another-attempt" });
            }

            return `message-${recipient}`;
          }),
      });

      const { attempt, named } = yield* runSliceLogged(fix, racing);

      successOf(attempt);
      expect(named("settlement not applied")).toHaveLength(1);
      expect(named("settlement not applied")[0]?.level).toBe("Warn");
      expect(fix.world.settlements.map((settled) => settled.contactId)).toStrictEqual([memberB.id]);
      expect(fix.world.completed).toBe(1);
    }),
  );

  it.effect("retries throttled submissions with 1s, 2s, 4s backoff then pauses", () =>
    Effect.gen(function* () {
      const fix = fixture({
        answers: [
          new SendThrottled(),
          new SendThrottled(),
          new SendThrottled(),
          new SendThrottled(),
        ],
      });

      const fiber = yield* Effect.forkChild(runSliceNow(fix));

      yield* TestClock.adjust("6999 millis");

      expect(fix.mailer.sent).toHaveLength(3);

      yield* TestClock.adjust("1 millis");

      successOf(yield* Fiber.join(fiber));

      expect(fix.mailer.sent).toHaveLength(4);
      expect(fix.guard.slots).toHaveLength(4);
      expect(fix.guard.slots.every((limit) => limit === defaultGuard.limit)).toBe(true);
      expect(fix.world.counters.rejected).toBe(1);
      expect(fix.world.rows.get(memberA.id)?.state).toBe("rejected");
      expect(fix.world.paused).toStrictEqual([{ reason: "rate-limited", cursor: memberA.id }]);
      expect(fix.wake.messages).toHaveLength(0);
    }),
  );

  it.effect("backs a throttled submission off 1s, then reserves a slot and sends again", () =>
    Effect.gen(function* () {
      const fix = fixture({ answers: [new SendThrottled(), "second"] });

      const fiber = yield* Effect.forkChild(runSliceNow(fix));

      yield* TestClock.adjust("999 millis");

      // Sent once, and the retry has not yet reserved its slot: it backs off first.
      expect(fix.mailer.sent).toHaveLength(1);
      expect(fix.guard.slots).toHaveLength(1);

      yield* TestClock.adjust("1 millis");

      successOf(yield* Fiber.join(fiber));

      expect(fix.mailer.sent).toHaveLength(2);
      expect(fix.guard.slots).toHaveLength(2);
      expect(fix.world.settlements).toStrictEqual([
        { contactId: memberA.id, settlement: { outcome: "accepted", messageId: "second" } },
      ]);
      expect(fix.world.paused).toStrictEqual([]);
    }),
  );

  it.effect("settles an uncertain submission without resending it and moves on", () =>
    Effect.gen(function* () {
      const fix = fixture({
        members: [memberA, memberB],
        answers: [new SubmissionUncertain({ reason: "timeout" })],
      });

      successOf(yield* runSliceNow(fix));

      expect(fix.mailer.sent.map((message) => message.recipient)).toStrictEqual([
        memberA.email,
        memberB.email,
      ]);
      expect(fix.world.settlements).toStrictEqual([
        { contactId: memberA.id, settlement: { outcome: "uncertain" } },
        {
          contactId: memberB.id,
          settlement: { outcome: "accepted", messageId: "ses-message" },
        },
      ]);
      expect(fix.world.paused).toStrictEqual([]);
      expect(fix.world.completed).toBe(1);
    }),
  );

  it.effect("pauses at once on a suspension, after settling the recipient rejected", () =>
    Effect.gen(function* () {
      const fix = fixture({ answers: [new SendingSuspended()] });

      successOf(yield* runSliceNow(fix));

      expect(fix.mailer.sent).toHaveLength(1);
      expect(fix.guard.slots).toHaveLength(1);
      expect(fix.world.counters.rejected).toBe(1);
      expect(fix.world.paused).toStrictEqual([{ reason: "sending-paused", cursor: memberA.id }]);
      expect(fix.wake.messages).toHaveLength(0);
      expect(fix.world.completed).toBe(0);
    }),
  );

  // The breaker rows here and in the next table are ADR-0012's boundaries: a bounce trip at 200
  // accepted and 5 percent, a complaint trip at 1000 accepted and 1 per mille. The guard is read
  // first and wins over both.
  it.effect.each<{
    readonly cause: string;
    readonly scenario: Scenario;
    readonly reason: PauseReason;
  }>([
    {
      cause: "a daily-quota refusal",
      scenario: { guard: { limit: 8, refusal: "daily-quota" } },
      reason: "daily-quota",
    },
    {
      cause: "a reputation refusal",
      scenario: { guard: { limit: 8, refusal: "reputation" } },
      reason: "reputation",
    },
    {
      cause: "200 accepted with 10 bounced",
      scenario: { run: { accepted: 200, bounced: 10, complained: 0 } },
      reason: "feedback",
    },
    {
      cause: "1000 accepted with 1 complaint",
      scenario: { run: { accepted: 1000, bounced: 0, complained: 1 } },
      reason: "feedback",
    },
    {
      cause: "a reputation refusal over the breaker",
      scenario: {
        guard: { limit: 8, refusal: "reputation" },
        run: { accepted: 200, bounced: 200, complained: 0 },
      },
      reason: "reputation",
    },
    {
      cause: "a daily-quota refusal over the breaker",
      scenario: {
        guard: { limit: 8, refusal: "daily-quota" },
        run: { accepted: 200, bounced: 200, complained: 0 },
      },
      reason: "daily-quota",
    },
  ])(
    "pauses as $reason on $cause, before any page read, claim, pacing slot or send",
    ({ scenario, reason }) =>
      Effect.gen(function* () {
        const fix = fixture({ ...scenario, cursor: memberA.id });

        successOf(yield* runSliceNow(fix));

        expect(fix.world.listCalls).toHaveLength(0);
        expect(fix.world.claims).toHaveLength(0);
        expect(fix.guard.slots).toHaveLength(0);
        expect(fix.mailer.sent).toHaveLength(0);
        expect(fix.world.paused).toStrictEqual([{ reason, cursor: memberA.id }]);
      }),
  );

  it.effect.each([
    {
      counts: "199 accepted with 199 bounced",
      run: { accepted: 199, bounced: 199, complained: 0 },
    },
    { counts: "200 accepted with 9 bounced", run: { accepted: 200, bounced: 9, complained: 0 } },
    { counts: "999 accepted with 1 complaint", run: { accepted: 999, bounced: 0, complained: 1 } },
  ])("does not trip the breaker at $counts", ({ run }) =>
    Effect.gen(function* () {
      const fix = fixture({ run });

      successOf(yield* runSliceNow(fix));

      expect(fix.world.paused).toHaveLength(0);
      expect(fix.world.claims).toStrictEqual([memberA.id]);
      expect(fix.world.completed).toBe(1);
    }),
  );

  it.effect("completes when the list is missing", () =>
    Effect.gen(function* () {
      const fix = fixture({ listMissing: true });

      successOf(yield* runSliceNow(fix));

      expect(fix.world.completed).toBe(1);
      expect(fix.world.claims).toHaveLength(0);
      expect(fix.wake.messages).toHaveLength(0);
    }),
  );

  it.effect("takes one pacing slot per attempt with the run's limit", () =>
    Effect.gen(function* () {
      const fix = fixture({
        members: [memberA, memberB],
        guard: { limit: 3 },
        answers: [new SendRejected({ code: "message-rejected" }), "ses-message"],
      });

      successOf(yield* runSliceNow(fix));

      expect(fix.guard.slots).toStrictEqual([3, 3]);
      expect(fix.world.counters.rejected).toBe(1);
      expect(fix.world.counters.accepted).toBe(1);
    }),
  );

  it.effect("skips bouncing members", () =>
    Effect.gen(function* () {
      const fix = fixture({
        members: [memberA],
        statuses: [[memberA.email, "bouncing"]],
      });

      successOf(yield* runSliceNow(fix));

      expect(fix.world.skips).toStrictEqual([{ contactId: memberA.id, reason: "bouncing" }]);
      expect(fix.world.claims).toHaveLength(0);
      expect(fix.mailer.sent).toHaveLength(0);
      expect(fix.world.completed).toBe(1);
    }),
  );

  it.effect(
    "skips members a two-entry filter does not match without a row, a status read, a pacing slot or a submission",
    () =>
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
        expect(fix.guard.slots).toHaveLength(1);
        expect(fix.mailer.sent.map((message) => message.recipient)).toStrictEqual([memberA.email]);
        expect(fix.world.checkpoints).toMatchObject([{ previous: undefined, next: later }]);
        expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken }]);
        expect(fix.world.completed).toBe(0);
      }),
  );

  it.effect("checkpoints at a filtered member when the next delay would overrun", () =>
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
      expect(fix.mailer.sent).toHaveLength(0);
      expect(fix.guard.slots).toHaveLength(1);
      expect(fix.world.statusCalls).toStrictEqual([memberA.email]);
      expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken }]);
      expect(fix.world.completed).toBe(0);
    }),
  );
});
