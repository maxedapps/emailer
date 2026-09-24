import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Layer, Result } from "effect";

import { CampaignSchedule } from "./CampaignSchedule.ts";
import * as Campaigns from "./Campaigns.ts";
import { CampaignWake } from "../sending/Dispatch.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignChanged, CampaignStore } from "../storage/Campaigns.ts";
import { unusedAudience, unusedCampaigns } from "../storage/Testing.ts";

import type { CampaignControl } from "../storage/Campaigns.ts";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const existingRunToken = "0195f0a0-1111-4222-8333-44444444e5d2";

const queuedAt = "2026-09-11T10:00:01.000Z";

const startedAt = "2026-09-11T10:00:02.000Z";

const finishedAt = "2026-09-11T10:00:03.000Z";

const progress: Schemas.CampaignProgress = {
  accepted: 0,
  rejected: 0,
  uncertain: 0,
  skipped: 0,
};

const feedback: Schemas.CampaignFeedback = {
  bounced: 0,
  complained: 0,
};

interface RunHistory {
  readonly queuedAt: string;
  readonly startedAt: string;
  readonly progress: Schemas.CampaignProgress;
  readonly feedback: Schemas.CampaignFeedback;
}

interface World {
  readonly lists: Map<string, Schemas.ContactList>;
  readonly campaigns: Map<string, Schemas.Campaign>;
  readonly runTokens: Map<string, string>;
  readonly startedAt: Map<string, string>;
  readonly history: Map<string, RunHistory>;
  readonly control: Map<string, Array<CampaignControl>>;
  readonly order: Array<string>;
  /** Every read of a campaign's control, in order. */
  readonly controlReads: Array<string>;
  beforeWrite?: Effect.Effect<void>;
}

const emptyWorld = (): World => ({
  lists: new Map(),
  campaigns: new Map(),
  runTokens: new Map(),
  startedAt: new Map(),
  history: new Map(),
  control: new Map(),
  order: [],
  controlReads: [],
});

const draftCampaign: Schemas.Campaign = {
  id: campaignId,
  listId,
  subject: "Release notes",
  text: "Hello there",
  createdAt: "2026-09-11T10:00:00.000Z",
  submission: { state: "draft" },
};

const futureSendAt = "2099-01-01T00:00:00.000Z";

const scheduledCampaign: Schemas.Campaign = {
  ...draftCampaign,
  submission: { state: "scheduled", sendAt: futureSendAt },
};

const queuedCampaign: Schemas.Campaign = {
  ...draftCampaign,
  submission: { state: "queued", queuedAt },
};

const sendingCampaign: Schemas.Campaign = {
  ...draftCampaign,
  submission: { state: "sending", queuedAt, startedAt, progress, feedback },
};

const pausedCampaign: Schemas.Campaign = {
  ...draftCampaign,
  submission: { state: "paused", queuedAt, startedAt, progress, feedback, reason: "rate-limited" },
};

const completedCampaign: Schemas.Campaign = {
  ...draftCampaign,
  submission: { state: "completed", queuedAt, startedAt, finishedAt, progress, feedback },
};

const startedAtOf = (world: World, campaign: Schemas.Campaign): string | undefined =>
  world.startedAt.get(campaign.id) ??
  ("startedAt" in campaign.submission ? campaign.submission.startedAt : undefined);

/** The control snapshot the store would read for the world's campaign. */
const controlOfCampaign = (world: World, campaign: Schemas.Campaign): CampaignControl => {
  const submission = campaign.submission;
  const observed = world.runTokens.get(campaign.id);

  if (submission.state === "draft") {
    return observed === undefined ? { state: "draft" } : { state: "draft", runToken: observed };
  }

  if (observed === undefined) {
    throw new Error(`a ${submission.state} campaign in this world needs a run token`);
  }

  const startedAt = startedAtOf(world, campaign);

  switch (submission.state) {
    case "scheduled":
      return { state: "scheduled", runToken: observed };
    case "queued":
      return startedAt === undefined
        ? { state: "queued", runToken: observed }
        : { state: "queued", runToken: observed, startedAt };
    case "sending":
    case "completed":
      return { state: submission.state, runToken: observed, startedAt: submission.startedAt };
    case "paused":
      return {
        state: "paused",
        runToken: observed,
        startedAt: submission.startedAt,
        pausedReason: submission.reason,
      };
  }
};

const tokenMatches = (world: World, id: string, expected: string | undefined) =>
  world.runTokens.get(id) === expected;

const rememberHistory = (world: World, campaign: Schemas.Campaign) => {
  const submission = campaign.submission;

  if (
    submission.state === "paused" ||
    submission.state === "sending" ||
    submission.state === "completed"
  ) {
    world.startedAt.set(campaign.id, submission.startedAt);
    world.history.set(campaign.id, {
      queuedAt: submission.queuedAt,
      startedAt: submission.startedAt,
      progress: submission.progress,
      feedback: submission.feedback,
    });
  }
};

/** A stored entity, or the store's answer for one that is not there. */
const found = <A, E>(value: A | undefined, missing: E) =>
  value === undefined ? Effect.fail(missing) : Effect.succeed(value);

const afterWrite = <E>(world: World, apply: () => Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    if (world.beforeWrite !== undefined) {
      yield* world.beforeWrite;
    }

    return yield* apply();
  });

/** A refused command's answer: the campaign as the world now holds it. */
const changed = (world: World, id: string) => {
  const campaign = world.campaigns.get(id);

  return Effect.fail(
    new CampaignChanged({
      current: campaign === undefined ? undefined : controlOfCampaign(world, campaign),
    }),
  );
};

/** A refused draft write: the campaign is gone, or is no longer a draft. */
const notADraft = (
  campaign: Schemas.Campaign | undefined,
): Effect.Effect<never, Errors.CampaignNotFound | Errors.CampaignStateConflict> =>
  campaign === undefined
    ? Effect.fail(new Errors.CampaignNotFound())
    : Effect.fail(new Errors.CampaignStateConflict({ state: campaign.submission.state }));

const storageLayer = (world: World): Layer.Layer<AudienceStore | CampaignStore> =>
  Layer.mergeAll(
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      getList: (id) => found(world.lists.get(id), new Errors.ListNotFound()),
    }),
    Layer.succeed(CampaignStore)({
      ...unusedCampaigns,
      createCampaign: (campaign) =>
        Effect.sync(() => {
          world.campaigns.set(campaign.id, { ...campaign, submission: { state: "draft" } });
        }),
      getCampaign: (id) => found(world.campaigns.get(id), new Errors.CampaignNotFound()),
      getCampaignControl: (id) =>
        Effect.gen(function* () {
          world.controlReads.push(id);

          const scripted = world.control.get(id)?.shift();

          if (scripted !== undefined) {
            return scripted;
          }

          return controlOfCampaign(
            world,
            yield* found(world.campaigns.get(id), new Errors.CampaignNotFound()),
          );
        }),
      newRun: (id, expected, newToken, target, at) =>
        afterWrite(world, () => {
          const campaign = world.campaigns.get(id);

          if (
            campaign === undefined ||
            campaign.submission.state !== expected.state ||
            !tokenMatches(world, id, expected.runToken)
          ) {
            return changed(world, id);
          }

          world.order.push(`newRun:${target}`);
          rememberHistory(world, campaign);
          world.campaigns.set(id, {
            ...campaign,
            submission:
              target === "queued"
                ? { state: "queued", queuedAt: at }
                : { state: "scheduled", sendAt: at },
          });
          world.runTokens.set(id, newToken);

          return Effect.void;
        }),
      cancelCampaign: (id, source) =>
        afterWrite(world, () => {
          const campaign = world.campaigns.get(id);

          world.order.push("cancelCampaign");

          if (campaign === undefined || !tokenMatches(world, id, source.runToken)) {
            return changed(world, id);
          }

          if (source.state === "scheduled") {
            if (campaign.submission.state !== "scheduled") {
              return changed(world, id);
            }

            world.campaigns.set(id, { ...campaign, submission: { state: "draft" } });

            return Effect.void;
          }

          if (campaign.submission.state !== "queued") {
            return changed(world, id);
          }

          const started = startedAtOf(world, campaign) !== undefined;

          if (started !== source.started) {
            return changed(world, id);
          }

          if (!started) {
            world.campaigns.set(id, { ...campaign, submission: { state: "draft" } });

            return Effect.void;
          }

          const history = world.history.get(id);
          const startedAt = startedAtOf(world, campaign);

          if (history === undefined || startedAt === undefined) {
            return changed(world, id);
          }

          world.campaigns.set(id, {
            ...campaign,
            submission: {
              state: "paused",
              queuedAt: history.queuedAt,
              startedAt,
              progress: history.progress,
              feedback: history.feedback,
              reason: "manual",
            },
          });

          return Effect.void;
        }),
      updateDraft: (campaign) =>
        afterWrite(world, () => {
          const current = world.campaigns.get(campaign.id);

          if (current?.submission.state !== "draft") {
            return notADraft(current);
          }

          world.order.push("updateDraft");
          world.campaigns.set(campaign.id, campaign);

          return Effect.void;
        }),
      deleteDraft: (id) =>
        afterWrite(world, () => {
          const current = world.campaigns.get(id);

          if (current?.submission.state !== "draft") {
            return notADraft(current);
          }

          world.order.push("deleteDraft");
          world.campaigns.delete(id);

          return Effect.void;
        }),
    }),
  );

interface WakeDouble {
  readonly layer: Layer.Layer<CampaignWake>;
  readonly messages: Array<{ readonly campaignId: string; readonly runToken: string }>;
}

const wakeDouble = (world: World, failure?: Errors.QueueUnavailable): WakeDouble => {
  const messages: Array<{ readonly campaignId: string; readonly runToken: string }> = [];

  const layer = Layer.succeed(CampaignWake)({
    enqueue: (campaignId, runToken) =>
      Effect.gen(function* () {
        if (failure !== undefined) {
          return yield* failure;
        }

        world.order.push("enqueue");
        messages.push({ campaignId, runToken });
      }),
  });

  return { layer, messages };
};

interface ScheduleDouble {
  readonly layer: Layer.Layer<CampaignSchedule>;
  readonly created: Array<{
    readonly campaignId: string;
    readonly runToken: string;
    readonly sendAt: string;
  }>;
}

const scheduleDouble = (world: World, failure?: Errors.SchedulerUnavailable): ScheduleDouble => {
  const created: Array<{
    readonly campaignId: string;
    readonly runToken: string;
    readonly sendAt: string;
  }> = [];

  const layer = Layer.succeed(CampaignSchedule)({
    create: (campaignId, runToken, sendAt) =>
      Effect.gen(function* () {
        if (failure !== undefined) {
          return yield* failure;
        }

        world.order.push("create");
        created.push({ campaignId, runToken, sendAt });
      }),
  });

  return { layer, created };
};

interface Scenario {
  readonly campaign?: Schemas.Campaign;
  readonly runToken?: string;
  readonly startedAt?: string;
  readonly history?: RunHistory;
  readonly wakeFailure?: Errors.QueueUnavailable;
  readonly scheduleFailure?: Errors.SchedulerUnavailable;
}

interface Fixture {
  readonly world: World;
  readonly wake: WakeDouble;
  readonly schedules: ScheduleDouble;
  readonly layer: Layer.Layer<CampaignWake | CampaignSchedule | AudienceStore | CampaignStore>;
}

const fixture = (scenario: Scenario = {}): Fixture => {
  const world = emptyWorld();

  world.lists.set(listId, { id: listId, name: "Readers", createdAt: "2026-09-11T09:00:00.000Z" });
  const campaign = scenario.campaign ?? draftCampaign;

  world.campaigns.set(campaignId, campaign);
  rememberHistory(world, campaign);

  // Every state past draft holds its run's token; a draft holds one only if a test gives it.
  const runToken =
    scenario.runToken ?? (campaign.submission.state === "draft" ? undefined : existingRunToken);

  if (runToken !== undefined) {
    world.runTokens.set(campaignId, runToken);
  }

  if (scenario.startedAt !== undefined) {
    world.startedAt.set(campaignId, scenario.startedAt);
  }

  if (scenario.history !== undefined) {
    world.history.set(campaignId, scenario.history);
  }

  const wake = wakeDouble(world, scenario.wakeFailure);
  const schedules = scheduleDouble(world, scenario.scheduleFailure);

  return {
    world,
    wake,
    schedules,
    layer: Layer.mergeAll(storageLayer(world), wake.layer, schedules.layer),
  };
};

const runWith = <A, E, R>(fix: Fixture, effect: Effect.Effect<A, E, R>) =>
  Effect.result(effect).pipe(Effect.provide(Layer.mergeAll(fix.layer, NodeServices.layer)));

const storedCampaign = (fix: Fixture): Schemas.Campaign => {
  const campaign = fix.world.campaigns.get(campaignId);

  if (campaign === undefined) {
    throw new Error("Expected the campaign to still exist");
  }

  return campaign;
};

const queueUnavailable = new Errors.QueueUnavailable({
  operation: "dispatch",
  failure: "ServiceUnavailable",
});

const schedulerUnavailable = new Errors.SchedulerUnavailable({
  operation: "schedule",
  failure: "ServiceUnavailable",
});

const failureOf = <A, E>(attempt: Result.Result<A, E>): E => {
  if (Result.isSuccess(attempt)) {
    throw new Error("Expected the operation to fail");
  }

  return attempt.failure;
};

describe("create", () => {
  it.effect("refuses a campaign for a list that does not exist", () =>
    Effect.gen(function* () {
      const fix = fixture();

      fix.world.lists.clear();

      const attempt = yield* runWith(
        fix,
        Campaigns.create({ listId, subject: "Hi", text: "There" }),
      );

      expect(failureOf(attempt)).toStrictEqual(new Errors.ListNotFound());
    }),
  );

  it.effect("creates a draft", () =>
    Effect.gen(function* () {
      const fix = fixture();

      const attempt = yield* runWith(
        fix,
        Campaigns.create({ listId, subject: "Hi", text: "There" }),
      );

      const created = Result.isSuccess(attempt) ? attempt.success : undefined;

      expect(created?.submission).toStrictEqual({ state: "draft" });
      expect(created).not.toHaveProperty("html");
      expect(created).not.toHaveProperty("filter");
    }),
  );

  it.effect("creates a draft carrying html", () =>
    Effect.gen(function* () {
      const fix = fixture();
      const html = "<p>Hello there</p>";

      const attempt = yield* runWith(
        fix,
        Campaigns.create({ listId, subject: "Hi", text: "There", html }),
      );

      expect(Result.isSuccess(attempt) && attempt.success.html).toBe(html);
      expect(Result.isSuccess(attempt) && attempt.success.submission).toStrictEqual({
        state: "draft",
      });
    }),
  );

  it.effect("creates a draft carrying a filter", () =>
    Effect.gen(function* () {
      const fix = fixture();
      const filter = { plan: "pro" };

      const attempt = yield* runWith(
        fix,
        Campaigns.create({ listId, subject: "Hi", text: "There", filter }),
      );

      expect(Result.isSuccess(attempt) && attempt.success.filter).toStrictEqual(filter);
      expect(Result.isSuccess(attempt) && attempt.success.submission).toStrictEqual({
        state: "draft",
      });
    }),
  );
});

describe("send", () => {
  it.effect("enqueues a draft once and returns queued", () =>
    Effect.gen(function* () {
      const fix = fixture();

      const attempt = yield* runWith(fix, Campaigns.send(campaignId));
      const sent = Result.isSuccess(attempt) ? attempt.success : undefined;

      expect(sent?.submission.state).toBe("queued");
      expect(fix.wake.messages).toHaveLength(1);
      expect(fix.wake.messages[0]?.campaignId).toBe(campaignId);
      expect(fix.world.runTokens.get(campaignId)).toBe(fix.wake.messages[0]?.runToken);
      expect(storedCampaign(fix).submission.state).toBe("queued");
    }),
  );

  it.effect("queues a draft that retains a token under a fresh one", () =>
    Effect.gen(function* () {
      const fix = fixture({ runToken: existingRunToken });

      const attempt = yield* runWith(fix, Campaigns.send(campaignId));

      expect(Result.isSuccess(attempt) && attempt.success?.submission.state).toBe("queued");
      expect(fix.wake.messages).toHaveLength(1);
      expect(fix.wake.messages[0]?.runToken).not.toBe(existingRunToken);
      expect(fix.world.order).toStrictEqual(["newRun:queued", "enqueue"]);
    }),
  );

  it.effect("re-enqueues a queued campaign with its stored run token", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

      const attempt = yield* runWith(fix, Campaigns.send(campaignId));

      expect(Result.isSuccess(attempt) && attempt.success.submission).toStrictEqual({
        state: "queued",
        queuedAt,
      });
      expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
    }),
  );

  it.effect.each([
    ["sending", sendingCampaign],
    ["completed", completedCampaign],
  ] as const)("enqueues nothing when the campaign is %s", ([_label, campaign]) =>
    Effect.gen(function* () {
      const fix = fixture({ campaign });

      const attempt = yield* runWith(fix, Campaigns.send(campaignId));

      expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(campaign);
      expect(fix.wake.messages).toHaveLength(0);
    }),
  );

  it.effect("fails QueueUnavailable when the wake fails after the queued write", () =>
    Effect.gen(function* () {
      const fix = fixture({ wakeFailure: queueUnavailable });

      const attempt = yield* runWith(fix, Campaigns.send(campaignId));

      expect(failureOf(attempt)).toStrictEqual(queueUnavailable);
      expect(fix.wake.messages).toHaveLength(0);
      expect(storedCampaign(fix).submission.state).toBe("queued");
    }),
  );

  it.effect("queues a scheduled campaign under a fresh token and wakes it", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });

      const attempt = yield* runWith(fix, Campaigns.send(campaignId));
      const sent = Result.isSuccess(attempt) ? attempt.success : undefined;

      expect(sent?.submission.state).toBe("queued");
      expect(fix.wake.messages).toHaveLength(1);
      expect(fix.wake.messages[0]?.campaignId).toBe(campaignId);
      expect(fix.wake.messages[0]?.runToken).not.toBe(existingRunToken);
      expect(fix.world.runTokens.get(campaignId)).toBe(fix.wake.messages[0]?.runToken);
      expect(storedCampaign(fix).submission.state).toBe("queued");
      expect(fix.world.order).toStrictEqual(["newRun:queued", "enqueue"]);
    }),
  );

  it.effect("returns the current campaign without publishing when enqueue loses the source", () =>
    Effect.gen(function* () {
      const fix = fixture();

      fix.world.beforeWrite = Effect.sync(() => {
        fix.world.campaigns.set(campaignId, sendingCampaign);
        fix.world.runTokens.set(campaignId, existingRunToken);
      });

      const attempt = yield* runWith(fix, Campaigns.send(campaignId));

      expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(sendingCampaign);
      expect(fix.wake.messages).toHaveLength(0);
      expect(fix.world.order).toHaveLength(0);
    }),
  );
});

describe("update", () => {
  const filtered: Schemas.Campaign = {
    ...draftCampaign,
    html: "<p>Hello there</p>",
    filter: { plan: "pro" },
  };

  it.effect("merges the change: absent fields stay, null removes the html and the filter", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: filtered });

      const attempt = yield* runWith(
        fix,
        Campaigns.update(campaignId, { subject: "New subject", html: null, filter: null }),
      );

      const expected: Schemas.Campaign = { ...draftCampaign, subject: "New subject" };

      expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(expected);
      expect(storedCampaign(fix)).toStrictEqual(expected);
    }),
  );

  it.effect("replaces the body and the filter it is given, keeping the rest", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: filtered });

      yield* runWith(
        fix,
        Campaigns.update(campaignId, { text: "New text", html: "<p>New</p>", filter: {} }),
      );

      expect(storedCampaign(fix)).toStrictEqual({
        ...filtered,
        text: "New text",
        html: "<p>New</p>",
        filter: {},
      });
    }),
  );

  it.effect("moves the draft to another list only when that list exists", () =>
    Effect.gen(function* () {
      const fix = fixture();
      const otherList = "0195f0a0-1111-4222-8333-44444444109f";

      const missing = yield* runWith(fix, Campaigns.update(campaignId, { listId: otherList }));

      expect(failureOf(missing)).toStrictEqual(new Errors.ListNotFound());
      expect(fix.world.order).toHaveLength(0);

      fix.world.lists.set(otherList, {
        id: otherList,
        name: "Others",
        createdAt: "2026-09-11T09:00:00.000Z",
      });

      yield* runWith(fix, Campaigns.update(campaignId, { listId: otherList }));

      expect(storedCampaign(fix).listId).toBe(otherList);
    }),
  );

  it.effect("answers NotFound for a campaign that does not exist", () =>
    Effect.gen(function* () {
      const fix = fixture();

      fix.world.campaigns.clear();

      const attempt = yield* runWith(fix, Campaigns.update(campaignId, { subject: "x" }));

      expect(failureOf(attempt)).toStrictEqual(new Errors.CampaignNotFound());
    }),
  );

  it.effect.each([
    scheduledCampaign,
    queuedCampaign,
    sendingCampaign,
    pausedCampaign,
    completedCampaign,
  ])("refuses to edit a $submission.state campaign", (campaign) =>
    Effect.gen(function* () {
      const fix = fixture({ campaign });

      const attempt = yield* runWith(fix, Campaigns.update(campaignId, { subject: "x" }));

      expect(failureOf(attempt)).toStrictEqual(
        new Errors.CampaignStateConflict({ state: campaign.submission.state }),
      );
      expect(storedCampaign(fix)).toStrictEqual(campaign);
    }),
  );

  it.effect("reports the state a concurrent send left when the write loses", () =>
    Effect.gen(function* () {
      const fix = fixture();

      fix.world.beforeWrite = Effect.sync(() => {
        fix.world.campaigns.set(campaignId, queuedCampaign);
        fix.world.runTokens.set(campaignId, existingRunToken);
      });

      const attempt = yield* runWith(fix, Campaigns.update(campaignId, { subject: "x" }));

      expect(failureOf(attempt)).toStrictEqual(
        new Errors.CampaignStateConflict({ state: "queued" }),
      );
      expect(storedCampaign(fix)).toStrictEqual(queuedCampaign);
    }),
  );
});

describe("remove", () => {
  it.effect("deletes a draft", () =>
    Effect.gen(function* () {
      const fix = fixture();

      const attempt = yield* runWith(fix, Campaigns.remove(campaignId));

      expect(Result.isSuccess(attempt)).toBe(true);
      expect(fix.world.campaigns.has(campaignId)).toBe(false);
    }),
  );

  it.effect.each([
    scheduledCampaign,
    queuedCampaign,
    sendingCampaign,
    pausedCampaign,
    completedCampaign,
  ])("refuses to delete a $submission.state campaign", (campaign) =>
    Effect.gen(function* () {
      const fix = fixture({ campaign, runToken: existingRunToken });

      const attempt = yield* runWith(fix, Campaigns.remove(campaignId));

      expect(failureOf(attempt)).toStrictEqual(
        new Errors.CampaignStateConflict({ state: campaign.submission.state }),
      );
      expect(storedCampaign(fix)).toStrictEqual(campaign);
    }),
  );

  it.effect("answers NotFound when a concurrent delete removed the draft first", () =>
    Effect.gen(function* () {
      const fix = fixture();

      fix.world.beforeWrite = Effect.sync(() => {
        fix.world.campaigns.delete(campaignId);
      });

      const attempt = yield* runWith(fix, Campaigns.remove(campaignId));

      expect(failureOf(attempt)).toStrictEqual(new Errors.CampaignNotFound());
    }),
  );
});

describe("queued wake repair", () => {
  const replacementToken = "0195f0a0-1111-4222-8333-44444444e5d3";

  const queuedRepair = {
    send: Campaigns.send,
    resume: Campaigns.resume,
  } as const;

  const queuedControl = (runToken: string): CampaignControl => ({ state: "queued", runToken });

  it.effect.each(["send", "resume"] as const)(
    "%s re-wakes only the token observed with queued state",
    (command) =>
      Effect.gen(function* () {
        const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

        const attempt = yield* runWith(fix, queuedRepair[command](campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(queuedCampaign);
        expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
      }),
  );

  it.effect.each(["send", "resume"] as const)(
    "%s does not enqueue a replacement scheduled token presented after the queued observation",
    (command) =>
      Effect.gen(function* () {
        const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

        fix.world.control.set(campaignId, [
          queuedControl(existingRunToken),
          { state: "scheduled", runToken: replacementToken },
        ]);

        const attempt = yield* runWith(fix, queuedRepair[command](campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(queuedCampaign);
        expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
        expect(fix.world.control.get(campaignId)).toStrictEqual([
          { state: "scheduled", runToken: replacementToken },
        ]);
      }),
  );

  it.effect.each(["send", "resume"] as const)(
    "%s does not treat a later cancelled draft snapshot as corruption",
    (command) =>
      Effect.gen(function* () {
        const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

        fix.world.control.set(campaignId, [queuedControl(existingRunToken), { state: "draft" }]);

        const attempt = yield* runWith(fix, queuedRepair[command](campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(queuedCampaign);
        expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
      }),
  );
});

describe("resume", () => {
  it.effect("enqueues a paused campaign and returns queued", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: pausedCampaign, runToken: existingRunToken });

      const attempt = yield* runWith(fix, Campaigns.resume(campaignId));
      const resumed = Result.isSuccess(attempt) ? attempt.success : undefined;

      expect(resumed?.submission.state).toBe("queued");
      expect(fix.wake.messages).toHaveLength(1);
      expect(fix.wake.messages[0]?.campaignId).toBe(campaignId);
      expect(fix.wake.messages[0]?.runToken).not.toBe(existingRunToken);
      expect(fix.world.runTokens.get(campaignId)).toBe(fix.wake.messages[0]?.runToken);
      expect(fix.schedules.created).toHaveLength(0);
      expect(storedCampaign(fix).submission.state).toBe("queued");
    }),
  );

  it.effect("re-sends the wake-up for a queued campaign, as send does", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

      const attempt = yield* runWith(fix, Campaigns.resume(campaignId));

      expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(queuedCampaign);
      expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
    }),
  );

  it.effect.each([
    ["draft", draftCampaign],
    ["scheduled", scheduledCampaign],
    ["sending", sendingCampaign],
    ["completed", completedCampaign],
  ] as const)("returns a %s campaign unchanged", ([_label, campaign]) =>
    Effect.gen(function* () {
      const fix = fixture({ campaign });

      const attempt = yield* runWith(fix, Campaigns.resume(campaignId));

      expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(campaign);
      expect(fix.wake.messages).toHaveLength(0);
    }),
  );

  it.effect("returns the current campaign without waking when resume loses the paused token", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: pausedCampaign, runToken: existingRunToken });

      fix.world.beforeWrite = Effect.sync(() => {
        fix.world.campaigns.set(campaignId, sendingCampaign);
      });

      const attempt = yield* runWith(fix, Campaigns.resume(campaignId));

      expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(sendingCampaign);
      expect(fix.wake.messages).toHaveLength(0);
      expect(fix.world.order).toHaveLength(0);
    }),
  );
});

describe("schedule", () => {
  it.effect("moves a draft to scheduled with sendAt, mints a token, and creates a schedule", () =>
    Effect.gen(function* () {
      const fix = fixture();

      const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt));
      const scheduled = Result.isSuccess(attempt) ? attempt.success : undefined;

      expect(scheduled?.submission).toStrictEqual({ state: "scheduled", sendAt: futureSendAt });
      expect(fix.schedules.created).toHaveLength(1);
      expect(fix.schedules.created[0]?.campaignId).toBe(campaignId);
      expect(fix.schedules.created[0]?.sendAt).toBe(futureSendAt);
      expect(fix.world.runTokens.get(campaignId)).toBe(fix.schedules.created[0]?.runToken);
      expect(storedCampaign(fix).submission).toStrictEqual({
        state: "scheduled",
        sendAt: futureSendAt,
      });
      expect(fix.world.order).toStrictEqual(["newRun:scheduled", "create"]);
    }),
  );

  it.effect("reschedules under a fresh generation and leaves the predecessor schedule alone", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });
      const sendAt = "2099-06-01T00:00:00.000Z";

      const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, sendAt));
      const scheduled = Result.isSuccess(attempt) ? attempt.success : undefined;
      const createdToken = fix.schedules.created[0]?.runToken;

      expect(scheduled?.submission).toStrictEqual({ state: "scheduled", sendAt });
      expect(fix.schedules.created).toHaveLength(1);
      expect(fix.schedules.created[0]?.sendAt).toBe(sendAt);
      expect(createdToken).not.toBe(existingRunToken);
      expect(fix.world.runTokens.get(campaignId)).toBe(createdToken);
      expect(fix.world.order).toStrictEqual(["newRun:scheduled", "create"]);
    }),
  );

  // Live: `now` is the wall clock, which is past the fixture's 2026 timestamps.
  it.live("refuses a sendAt at or before now", () =>
    Effect.gen(function* () {
      const fix = fixture();

      const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, queuedAt));

      expect(failureOf(attempt)).toStrictEqual(new Errors.SendAtNotInFuture({ sendAt: queuedAt }));
      expect(fix.schedules.created).toHaveLength(0);
      expect(storedCampaign(fix)).toStrictEqual(draftCampaign);
      expect(fix.world.runTokens.has(campaignId)).toBe(false);
      expect(fix.world.order).toHaveLength(0);
    }),
  );

  it.effect.each([
    ["queued", queuedCampaign],
    ["sending", sendingCampaign],
    ["paused", pausedCampaign],
    ["completed", completedCampaign],
  ] as const)("returns a %s campaign unchanged", ([_label, campaign]) =>
    Effect.gen(function* () {
      const fix = fixture({ campaign });

      const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt));

      expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(campaign);
      expect(fix.schedules.created).toHaveLength(0);
      expect(fix.world.order).toHaveLength(0);
    }),
  );

  it.effect("fails SchedulerUnavailable when the schedule service fails after the write", () =>
    Effect.gen(function* () {
      const fix = fixture({ scheduleFailure: schedulerUnavailable });

      const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt));

      expect(failureOf(attempt)).toStrictEqual(schedulerUnavailable);
      expect(fix.schedules.created).toHaveLength(0);
      expect(storedCampaign(fix).submission).toStrictEqual({
        state: "scheduled",
        sendAt: futureSendAt,
      });
      expect(fix.world.order).toStrictEqual(["newRun:scheduled"]);
    }),
  );

  it.effect(
    "returns the current campaign without creating a schedule when the write loses the source",
    () =>
      Effect.gen(function* () {
        const fix = fixture();

        fix.world.beforeWrite = Effect.sync(() => {
          fix.world.campaigns.set(campaignId, sendingCampaign);
          fix.world.runTokens.set(campaignId, existingRunToken);
        });

        const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(sendingCampaign);
        expect(fix.schedules.created).toHaveLength(0);
        expect(fix.world.order).toHaveLength(0);
      }),
  );
});

describe("cancel", () => {
  const replacementToken = "0195f0a0-1111-4222-8333-44444444e5d3";

  const resumedHistory: RunHistory = {
    queuedAt,
    startedAt,
    progress,
    feedback,
  };

  const workerPauses = (world: World, reason: Schemas.PauseReason = "rate-limited") => {
    const campaign = world.campaigns.get(campaignId);

    if (campaign === undefined) {
      throw new Error("Expected the campaign to exist before the worker pause");
    }

    const history = world.history.get(campaignId) ?? {
      queuedAt,
      startedAt,
      progress,
      feedback,
    };

    world.startedAt.set(campaignId, history.startedAt);
    world.history.set(campaignId, history);
    world.campaigns.set(campaignId, {
      ...campaign,
      submission: {
        state: "paused",
        queuedAt: history.queuedAt,
        startedAt: history.startedAt,
        progress: history.progress,
        feedback: history.feedback,
        reason,
      },
    });
  };

  it.effect("returns a scheduled campaign to draft and retains the token", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });

      const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

      expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(draftCampaign);
      expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
      expect(storedCampaign(fix).submission).toStrictEqual({ state: "draft" });
      expect(fix.world.order).toStrictEqual(["cancelCampaign"]);
    }),
  );

  it.effect("returns a never-started queued campaign to draft and retains the token", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

      const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

      expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(draftCampaign);
      expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
      expect(storedCampaign(fix).submission).toStrictEqual({ state: "draft" });
      expect(fix.world.order).toStrictEqual(["cancelCampaign"]);
    }),
  );

  it.effect("pauses a queued resume as manual and preserves startedAt, progress and feedback", () =>
    Effect.gen(function* () {
      const fix = fixture({
        campaign: queuedCampaign,
        runToken: existingRunToken,
        startedAt,
        history: resumedHistory,
      });

      const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

      expect(Result.isSuccess(attempt) && attempt.success?.submission).toStrictEqual({
        state: "paused",
        queuedAt,
        startedAt,
        progress,
        feedback,
        reason: "manual",
      });
      expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
      expect(fix.world.order).toStrictEqual(["cancelCampaign"]);
    }),
  );

  it.effect.each([
    ["draft", draftCampaign],
    ["paused", pausedCampaign],
  ] as const)(
    "returns an already-inactive %s campaign unchanged and keeps its token",
    ([_label, campaign]) =>
      Effect.gen(function* () {
        const fix = fixture({ campaign, runToken: existingRunToken });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(campaign);
        expect(fix.world.order).toHaveLength(0);
        expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
      }),
  );

  it.effect.each([
    ["sending", sendingCampaign],
    ["completed", completedCampaign],
  ] as const)("conflicts with a %s campaign without mutating it", ([_label, campaign]) =>
    Effect.gen(function* () {
      const fix = fixture({ campaign, runToken: existingRunToken });

      const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

      expect(failureOf(attempt)).toStrictEqual(
        new Errors.CampaignStateConflict({ state: campaign.submission.state }),
      );
      expect(storedCampaign(fix)).toStrictEqual(campaign);
      expect(fix.world.order).toHaveLength(0);
    }),
  );

  it.effect.each([
    ["draft", draftCampaign],
    ["paused", pausedCampaign],
    ["sending", sendingCampaign],
  ] as const)("conflicts with a replacement %s generation", ([_label, replacement]) =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });

      fix.world.beforeWrite = Effect.sync(() => {
        fix.world.campaigns.set(campaignId, replacement);
        fix.world.runTokens.set(campaignId, replacementToken);
        rememberHistory(fix.world, replacement);
      });

      const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

      expect(failureOf(attempt)).toStrictEqual(
        new Errors.CampaignStateConflict({ state: replacement.submission.state }),
      );
      expect(storedCampaign(fix)).toStrictEqual(replacement);
      expect(fix.world.runTokens.get(campaignId)).toBe(replacementToken);
      // The refused write answered the campaign as it now is: no second read.
      expect(fix.world.controlReads).toHaveLength(1);
    }),
  );

  it.effect(
    "succeeds idempotently when a concurrent cancel already drafted the same scheduled token",
    () =>
      Effect.gen(function* () {
        const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });

        fix.world.beforeWrite = Effect.sync(() => {
          fix.world.campaigns.set(campaignId, draftCampaign);
        });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(draftCampaign);
        expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
      }),
  );

  it.effect(
    "succeeds idempotently when a concurrent cancel already paused the same resumed token as manual",
    () =>
      Effect.gen(function* () {
        const manualPaused: Schemas.Campaign = {
          ...draftCampaign,
          submission: {
            state: "paused",
            queuedAt,
            startedAt,
            progress,
            feedback,
            reason: "manual",
          },
        };

        const fix = fixture({
          campaign: queuedCampaign,
          runToken: existingRunToken,
          startedAt,
          history: resumedHistory,
        });

        fix.world.beforeWrite = Effect.sync(() => {
          fix.world.campaigns.set(campaignId, manualPaused);
        });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(manualPaused);
        expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
      }),
  );

  it.effect(
    "conflicts when a worker pauses a never-started queued run before the cancel reread",
    () =>
      Effect.gen(function* () {
        const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

        fix.world.beforeWrite = Effect.sync(() => {
          workerPauses(fix.world);
        });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(failureOf(attempt)).toStrictEqual(
          new Errors.CampaignStateConflict({ state: "paused" }),
        );
        expect(storedCampaign(fix).submission).toStrictEqual({
          state: "paused",
          queuedAt,
          startedAt,
          progress,
          feedback,
          reason: "rate-limited",
        });
        expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
      }),
  );

  it.effect(
    "conflicts when a worker pauses a queued resume before the cancel reread and keeps its history",
    () =>
      Effect.gen(function* () {
        const historic: RunHistory = {
          queuedAt,
          startedAt,
          progress: { accepted: 2, rejected: 1, uncertain: 0, skipped: 3 },
          feedback: { bounced: 1, complained: 0 },
        };

        const fix = fixture({
          campaign: queuedCampaign,
          runToken: existingRunToken,
          startedAt,
          history: historic,
        });

        fix.world.beforeWrite = Effect.sync(() => {
          workerPauses(fix.world);
        });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(failureOf(attempt)).toStrictEqual(
          new Errors.CampaignStateConflict({ state: "paused" }),
        );
        expect(storedCampaign(fix).submission).toStrictEqual({
          state: "paused",
          queuedAt: historic.queuedAt,
          startedAt: historic.startedAt,
          progress: historic.progress,
          feedback: historic.feedback,
          reason: "rate-limited",
        });
        expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
      }),
  );

  it.effect("conflicts when begin wins the generation before cancel commits", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

      fix.world.beforeWrite = Effect.sync(() => {
        const campaign = storedCampaign(fix);

        fix.world.startedAt.set(campaignId, startedAt);
        fix.world.campaigns.set(campaignId, {
          ...campaign,
          submission: { state: "sending", queuedAt, startedAt, progress, feedback },
        });
      });

      const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

      expect(failureOf(attempt)).toStrictEqual(
        new Errors.CampaignStateConflict({ state: "sending" }),
      );
      expect(storedCampaign(fix).submission.state).toBe("sending");
    }),
  );
});
