import { NodeServices } from "@effect/platform-node";
import * as Schemas from "@emailer/api/Schemas";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { CampaignSchedule } from "./CampaignSchedule.ts";
import * as Campaigns from "./Campaigns.ts";
import { CampaignWake } from "../sending/Dispatch.ts";
import { publicly } from "../Diagnostics.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { StorageFailure } from "../storage/Errors.ts";
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
  beforeWrite?: Effect.Effect<void>;
  beforeScheduleCreate?: Effect.Effect<void>;
  afterScheduleCreate?: Effect.Effect<void>;
  beforeScheduleRemove?: Effect.Effect<void>;
}

const emptyWorld = (): World => ({
  lists: new Map(),
  campaigns: new Map(),
  runTokens: new Map(),
  startedAt: new Map(),
  history: new Map(),
  control: new Map(),
  order: [],
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

const controlOfCampaign = (world: World, campaign: Schemas.Campaign): CampaignControl => ({
  state: campaign.submission.state,
  runToken: world.runTokens.get(campaign.id),
  startedAt: startedAtOf(world, campaign),
  pausedReason: campaign.submission.state === "paused" ? campaign.submission.reason : undefined,
});

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
const found = <A>(value: A | undefined, entity: Schemas.NotFound["entity"]) =>
  value === undefined ? Effect.fail(new Schemas.NotFound({ entity })) : Effect.succeed(value);

const afterWrite = <A>(world: World, apply: () => A) =>
  Effect.gen(function* () {
    if (world.beforeWrite !== undefined) {
      yield* world.beforeWrite;
    }

    return apply();
  });

const storageLayer = (world: World): Layer.Layer<AudienceStore | CampaignStore> =>
  Layer.mergeAll(
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      getList: (id) => found(world.lists.get(id), "list"),
    }),
    Layer.succeed(CampaignStore)({
      ...unusedCampaigns,
      createCampaign: (campaign) =>
        Effect.sync(() => {
          world.campaigns.set(campaign.id, { ...campaign, submission: { state: "draft" } });
        }),
      getCampaign: (id) => found(world.campaigns.get(id), "campaign"),
      getCampaignControl: (id) =>
        Effect.gen(function* () {
          const scripted = world.control.get(id)?.shift();

          if (scripted !== undefined) {
            return scripted;
          }

          return controlOfCampaign(world, yield* found(world.campaigns.get(id), "campaign"));
        }),
      newRun: (id, expected, newToken, target, at) =>
        afterWrite(world, () => {
          const campaign = world.campaigns.get(id);

          if (
            campaign === undefined ||
            campaign.submission.state !== expected.state ||
            !tokenMatches(world, id, expected.runToken)
          ) {
            return "conflict" as const;
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

          return target;
        }),
      cancelCampaign: (id, source) =>
        afterWrite(world, () => {
          const campaign = world.campaigns.get(id);

          world.order.push("cancelCampaign");

          if (campaign === undefined || !tokenMatches(world, id, source.runToken)) {
            return "conflict" as const;
          }

          if (source.state === "scheduled") {
            if (campaign.submission.state !== "scheduled") {
              return "conflict" as const;
            }

            world.campaigns.set(id, { ...campaign, submission: { state: "draft" } });

            return "applied" as const;
          }

          if (campaign.submission.state !== "queued") {
            return "conflict" as const;
          }

          const started = startedAtOf(world, campaign) !== undefined;

          if (started !== source.started) {
            return "conflict" as const;
          }

          if (!started) {
            world.campaigns.set(id, { ...campaign, submission: { state: "draft" } });

            return "applied" as const;
          }

          const history = world.history.get(id);
          const startedAt = startedAtOf(world, campaign);

          if (history === undefined || startedAt === undefined) {
            return "conflict" as const;
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

          return "applied" as const;
        }),
      updateDraft: (campaign) =>
        afterWrite(world, () => {
          if (world.campaigns.get(campaign.id)?.submission.state !== "draft") {
            return "conflict" as const;
          }

          world.order.push("updateDraft");
          world.campaigns.set(campaign.id, campaign);

          return "updated" as const;
        }),
      deleteDraft: (id) =>
        afterWrite(world, () => {
          if (world.campaigns.get(id)?.submission.state !== "draft") {
            return "conflict" as const;
          }

          world.order.push("deleteDraft");
          world.campaigns.delete(id);

          return "deleted" as const;
        }),
    }),
  );

interface WakeDouble {
  readonly layer: Layer.Layer<CampaignWake>;
  readonly messages: Array<{ readonly campaignId: string; readonly runToken: string }>;
}

const wakeDouble = (world: World, failure?: StorageFailure): WakeDouble => {
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
  readonly removed: Array<string>;
}

const scheduleDouble = (world: World, failure?: StorageFailure): ScheduleDouble => {
  const created: Array<{
    readonly campaignId: string;
    readonly runToken: string;
    readonly sendAt: string;
  }> = [];

  const removed: Array<string> = [];

  const layer = Layer.succeed(CampaignSchedule)({
    create: (campaignId, runToken, sendAt) =>
      Effect.gen(function* () {
        if (world.beforeScheduleCreate !== undefined) {
          yield* world.beforeScheduleCreate;
        }

        if (failure !== undefined) {
          return yield* failure;
        }

        world.order.push("create");
        created.push({ campaignId, runToken, sendAt });

        if (world.afterScheduleCreate !== undefined) {
          yield* world.afterScheduleCreate;
        }
      }),
    remove: (runToken) =>
      Effect.gen(function* () {
        if (world.beforeScheduleRemove !== undefined) {
          yield* world.beforeScheduleRemove;
        }

        if (failure !== undefined) {
          return yield* failure;
        }

        world.order.push("remove");
        removed.push(runToken);
      }),
  });

  return { layer, created, removed };
};

interface Scenario {
  readonly campaign?: Schemas.Campaign;
  readonly runToken?: string;
  readonly startedAt?: string;
  readonly history?: RunHistory;
  readonly wakeFailure?: StorageFailure;
  readonly scheduleFailure?: StorageFailure;
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

  if (scenario.runToken !== undefined) {
    world.runTokens.set(campaignId, scenario.runToken);
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

const runPublicly = <A, E, R>(fix: Fixture, effect: Effect.Effect<A, E, R>) =>
  runWith(fix, publicly(effect));

const storedCampaign = (fix: Fixture): Schemas.Campaign => {
  const campaign = fix.world.campaigns.get(campaignId);

  if (campaign === undefined) {
    throw new Error("Expected the campaign to still exist");
  }

  return campaign;
};

const failureOf = <A, E>(attempt: Result.Result<A, E>): E => {
  if (Result.isSuccess(attempt)) {
    throw new Error("Expected the operation to fail");
  }

  return attempt.failure;
};

describe("create", () => {
  it("refuses a campaign for a list that does not exist", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        fix.world.lists.clear();

        const attempt = yield* runWith(
          fix,
          Campaigns.create({ listId, subject: "Hi", text: "There" }),
        );

        expect(failureOf(attempt)).toBeInstanceOf(Schemas.NotFound);
      }),
    ));

  it("creates a draft", () =>
    Effect.runPromise(
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
    ));

  it("creates a draft carrying html", () =>
    Effect.runPromise(
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
    ));

  it("creates a draft carrying a filter", () =>
    Effect.runPromise(
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
    ));
});

describe("send", () => {
  it("enqueues a draft once and returns queued", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        const attempt = yield* runWith(fix, Campaigns.send(campaignId));
        const sent = Result.isSuccess(attempt) ? attempt.success : undefined;

        expect(sent?.submission.state).toBe("queued");
        expect(fix.wake.messages).toHaveLength(1);
        expect(fix.wake.messages[0]?.campaignId).toBe(campaignId);
        expect(fix.world.runTokens.get(campaignId)).toBe(fix.wake.messages[0]?.runToken);
        expect(fix.schedules.removed).toHaveLength(0);
        expect(storedCampaign(fix).submission.state).toBe("queued");
      }),
    ));

  it("removes a retained predecessor token after enqueueing a draft", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ runToken: existingRunToken });

        const attempt = yield* runWith(fix, Campaigns.send(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success?.submission.state).toBe("queued");
        expect(fix.wake.messages).toHaveLength(1);
        expect(fix.wake.messages[0]?.runToken).not.toBe(existingRunToken);
        expect(fix.schedules.removed).toStrictEqual([existingRunToken]);
        expect(fix.world.order).toStrictEqual(["newRun:queued", "enqueue", "remove"]);
      }),
    ));

  it("re-enqueues a queued campaign with its stored run token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

        const attempt = yield* runWith(fix, Campaigns.send(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success.submission).toStrictEqual({
          state: "queued",
          queuedAt,
        });
        expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
        expect(fix.schedules.removed).toHaveLength(0);
      }),
    ));

  it.each([
    ["sending", sendingCampaign],
    ["completed", completedCampaign],
  ] as const)("enqueues nothing when the campaign is %s", (_label, campaign) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign });

        const attempt = yield* runWith(fix, Campaigns.send(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(campaign);
        expect(fix.wake.messages).toHaveLength(0);
      }),
    ),
  );

  it("fails StorageUnavailable when the wake fails after the queued write", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({
          wakeFailure: new StorageFailure({
            operationId: "dispatch",
            reason: "unavailable",
            cause: "lost",
          }),
        });

        const attempt = yield* runPublicly(fix, Campaigns.send(campaignId));

        expect(failureOf(attempt)).toStrictEqual(
          new Schemas.StorageUnavailable({ operationId: "dispatch" }),
        );
        expect(fix.wake.messages).toHaveLength(0);
        expect(storedCampaign(fix).submission.state).toBe("queued");
      }),
    ));

  it("queues a scheduled campaign under a fresh token, wakes it, then removes the predecessor schedule", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });

        const attempt = yield* runWith(fix, Campaigns.send(campaignId));
        const sent = Result.isSuccess(attempt) ? attempt.success : undefined;

        expect(sent?.submission.state).toBe("queued");
        expect(fix.wake.messages).toHaveLength(1);
        expect(fix.wake.messages[0]?.campaignId).toBe(campaignId);
        expect(fix.wake.messages[0]?.runToken).not.toBe(existingRunToken);
        expect(fix.world.runTokens.get(campaignId)).toBe(fix.wake.messages[0]?.runToken);
        expect(fix.schedules.removed).toStrictEqual([existingRunToken]);
        expect(storedCampaign(fix).submission.state).toBe("queued");
        expect(fix.world.order).toStrictEqual(["newRun:queued", "enqueue", "remove"]);
      }),
    ));

  it("still publishes the wake when predecessor cleanup fails after send", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({
          campaign: scheduledCampaign,
          runToken: existingRunToken,
          scheduleFailure: new StorageFailure({
            operationId: "schedule",
            reason: "unavailable",
            cause: "lost",
          }),
        });

        const attempt = yield* runPublicly(fix, Campaigns.send(campaignId));

        expect(failureOf(attempt)).toStrictEqual(
          new Schemas.StorageUnavailable({ operationId: "schedule" }),
        );
        expect(fix.wake.messages).toHaveLength(1);
        expect(fix.wake.messages[0]?.runToken).not.toBe(existingRunToken);
        expect(fix.schedules.removed).toHaveLength(0);
        expect(storedCampaign(fix).submission.state).toBe("queued");
        expect(fix.world.order).toStrictEqual(["newRun:queued", "enqueue"]);
      }),
    ));

  it("returns the current campaign without publishing when enqueue loses the source", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        fix.world.beforeWrite = Effect.sync(() => {
          fix.world.campaigns.set(campaignId, sendingCampaign);
          fix.world.runTokens.set(campaignId, existingRunToken);
        });

        const attempt = yield* runWith(fix, Campaigns.send(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(sendingCampaign);
        expect(fix.wake.messages).toHaveLength(0);
        expect(fix.schedules.removed).toHaveLength(0);
        expect(fix.world.order).toHaveLength(0);
      }),
    ));
});

describe("update", () => {
  const filtered: Schemas.Campaign = {
    ...draftCampaign,
    html: "<p>Hello there</p>",
    filter: { plan: "pro" },
  };

  it("merges the change: absent fields stay, null removes the html and the filter", () =>
    Effect.runPromise(
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
    ));

  it("replaces the body and the filter it is given, keeping the rest", () =>
    Effect.runPromise(
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
    ));

  it("moves the draft to another list only when that list exists", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();
        const otherList = "0195f0a0-1111-4222-8333-44444444109f";

        const missing = yield* runWith(fix, Campaigns.update(campaignId, { listId: otherList }));

        expect(failureOf(missing)).toStrictEqual(new Schemas.NotFound({ entity: "list" }));
        expect(fix.world.order).toHaveLength(0);

        fix.world.lists.set(otherList, {
          id: otherList,
          name: "Others",
          createdAt: "2026-09-11T09:00:00.000Z",
        });

        yield* runWith(fix, Campaigns.update(campaignId, { listId: otherList }));

        expect(storedCampaign(fix).listId).toBe(otherList);
      }),
    ));

  it("answers NotFound for a campaign that does not exist", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        fix.world.campaigns.clear();

        const attempt = yield* runWith(fix, Campaigns.update(campaignId, { subject: "x" }));

        expect(failureOf(attempt)).toStrictEqual(new Schemas.NotFound({ entity: "campaign" }));
      }),
    ));

  it.each([scheduledCampaign, queuedCampaign, sendingCampaign, pausedCampaign, completedCampaign])(
    "refuses to edit a $submission.state campaign",
    (campaign) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fix = fixture({ campaign });

          const attempt = yield* runWith(fix, Campaigns.update(campaignId, { subject: "x" }));

          expect(failureOf(attempt)).toStrictEqual(
            new Schemas.CampaignStateConflict({ state: campaign.submission.state }),
          );
          expect(storedCampaign(fix)).toStrictEqual(campaign);
        }),
      ),
  );

  it("reports the state a concurrent send left when the write loses", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        fix.world.beforeWrite = Effect.sync(() => {
          fix.world.campaigns.set(campaignId, queuedCampaign);
        });

        const attempt = yield* runWith(fix, Campaigns.update(campaignId, { subject: "x" }));

        expect(failureOf(attempt)).toStrictEqual(
          new Schemas.CampaignStateConflict({ state: "queued" }),
        );
        expect(storedCampaign(fix)).toStrictEqual(queuedCampaign);
      }),
    ));
});

describe("remove", () => {
  it("deletes a draft", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        const attempt = yield* runWith(fix, Campaigns.remove(campaignId));

        expect(Result.isSuccess(attempt)).toBe(true);
        expect(fix.world.campaigns.has(campaignId)).toBe(false);
        expect(fix.schedules.removed).toHaveLength(0);
      }),
    ));

  it.each([scheduledCampaign, queuedCampaign, sendingCampaign, pausedCampaign, completedCampaign])(
    "refuses to delete a $submission.state campaign",
    (campaign) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fix = fixture({ campaign, runToken: existingRunToken });

          const attempt = yield* runWith(fix, Campaigns.remove(campaignId));

          expect(failureOf(attempt)).toStrictEqual(
            new Schemas.CampaignStateConflict({ state: campaign.submission.state }),
          );
          expect(storedCampaign(fix)).toStrictEqual(campaign);
        }),
      ),
  );

  it("answers NotFound when a concurrent delete removed the draft first", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        fix.world.beforeWrite = Effect.sync(() => {
          fix.world.campaigns.delete(campaignId);
        });

        const attempt = yield* runWith(fix, Campaigns.remove(campaignId));

        expect(failureOf(attempt)).toStrictEqual(new Schemas.NotFound({ entity: "campaign" }));
      }),
    ));
});

describe("queued wake repair", () => {
  const replacementToken = "0195f0a0-1111-4222-8333-44444444e5d3";

  const queuedRepair = {
    send: Campaigns.send,
    resume: Campaigns.resume,
  } as const;

  const queuedControl = (runToken: string | undefined): CampaignControl => ({
    state: "queued",
    runToken,
    startedAt: undefined,
    pausedReason: undefined,
  });

  it.each(["send", "resume"] as const)(
    "%s re-wakes only the token observed with queued state",
    (command) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

          const attempt = yield* runWith(fix, queuedRepair[command](campaignId));

          expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(queuedCampaign);
          expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
        }),
      ),
  );

  it.each(["send", "resume"] as const)(
    "%s does not enqueue a replacement scheduled token presented after the queued observation",
    (command) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

          fix.world.control.set(campaignId, [
            queuedControl(existingRunToken),
            {
              state: "scheduled",
              runToken: replacementToken,
              startedAt: undefined,
              pausedReason: undefined,
            },
          ]);

          const attempt = yield* runWith(fix, queuedRepair[command](campaignId));

          expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(queuedCampaign);
          expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
          expect(fix.world.control.get(campaignId)).toStrictEqual([
            {
              state: "scheduled",
              runToken: replacementToken,
              startedAt: undefined,
              pausedReason: undefined,
            },
          ]);
        }),
      ),
  );

  it.each(["send", "resume"] as const)(
    "%s does not treat a later cancelled draft snapshot as corruption",
    (command) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

          fix.world.control.set(campaignId, [
            queuedControl(existingRunToken),
            {
              state: "draft",
              runToken: undefined,
              startedAt: undefined,
              pausedReason: undefined,
            },
          ]);

          const attempt = yield* runWith(fix, queuedRepair[command](campaignId));

          expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(queuedCampaign);
          expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
        }),
      ),
  );

  it.each(["send", "resume"] as const)(
    "%s reports corruption when control is still queued without a run token",
    (command) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fix = fixture({ campaign: queuedCampaign });

          const attempt = yield* runWith(fix, queuedRepair[command](campaignId));

          expect(failureOf(attempt)).toStrictEqual(
            new StorageFailure({
              operationId: "getCampaignControl",
              reason: "corrupt",
              cause: "queued campaign has no run token",
            }),
          );
          expect(fix.wake.messages).toHaveLength(0);
        }),
      ),
  );
});

describe("resume", () => {
  it("enqueues a paused campaign and returns queued", () =>
    Effect.runPromise(
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
        expect(fix.schedules.removed).toHaveLength(0);
        expect(storedCampaign(fix).submission.state).toBe("queued");
      }),
    ));

  it("re-sends the wake-up for a queued campaign, as send does", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

        const attempt = yield* runWith(fix, Campaigns.resume(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(queuedCampaign);
        expect(fix.wake.messages).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
      }),
    ));

  it.each([
    ["draft", draftCampaign],
    ["scheduled", scheduledCampaign],
    ["sending", sendingCampaign],
    ["completed", completedCampaign],
  ] as const)("returns a %s campaign unchanged", (_label, campaign) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign });

        const attempt = yield* runWith(fix, Campaigns.resume(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(campaign);
        expect(fix.wake.messages).toHaveLength(0);
      }),
    ),
  );

  it("returns the current campaign without waking when resume loses the paused token", () =>
    Effect.runPromise(
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
    ));
});

describe("schedule", () => {
  it("moves a draft to scheduled with sendAt, mints a token, and creates a schedule", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt));
        const scheduled = Result.isSuccess(attempt) ? attempt.success : undefined;

        expect(scheduled?.submission).toStrictEqual({ state: "scheduled", sendAt: futureSendAt });
        expect(fix.schedules.created).toHaveLength(1);
        expect(fix.schedules.created[0]?.campaignId).toBe(campaignId);
        expect(fix.schedules.created[0]?.sendAt).toBe(futureSendAt);
        expect(fix.world.runTokens.get(campaignId)).toBe(fix.schedules.created[0]?.runToken);
        expect(fix.schedules.removed).toHaveLength(0);
        expect(storedCampaign(fix).submission).toStrictEqual({
          state: "scheduled",
          sendAt: futureSendAt,
        });
        expect(fix.world.order).toStrictEqual(["newRun:scheduled", "create"]);
      }),
    ));

  it("creates the new generation before removing the predecessor token", () =>
    Effect.runPromise(
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
        expect(fix.schedules.removed).toStrictEqual([existingRunToken]);
        expect(fix.schedules.removed).not.toContain(createdToken);
        expect(fix.world.order).toStrictEqual(["newRun:scheduled", "create", "remove"]);
      }),
    ));

  it("keeps a delayed predecessor delete aimed at the old token, not the new one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* Deferred.make<void>();
        const allowRemove = yield* Deferred.make<void>();
        const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });
        const sendAt = "2099-06-01T00:00:00.000Z";

        fix.world.afterScheduleCreate = Deferred.succeed(created, undefined);
        fix.world.beforeScheduleRemove = Deferred.await(allowRemove);

        const running = yield* Effect.forkChild(
          runWith(fix, Campaigns.schedule(campaignId, sendAt)),
        );

        yield* Deferred.await(created);

        const newToken = fix.schedules.created[0]?.runToken;

        expect(newToken).not.toBe(existingRunToken);
        expect(fix.schedules.removed).toHaveLength(0);

        yield* Deferred.succeed(allowRemove, undefined);

        const attempt = yield* Fiber.join(running);

        expect(Result.isSuccess(attempt)).toBe(true);
        expect(fix.schedules.removed).toStrictEqual([existingRunToken]);
        expect(fix.schedules.removed).not.toContain(newToken);
        expect(fix.world.order).toStrictEqual(["newRun:scheduled", "create", "remove"]);
      }),
    ));

  it("deletes only its own late create when a reread shows a different generation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const replacementToken = "0195f0a0-1111-4222-8333-44444444e5d3";
        const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });
        const sendAt = "2099-06-01T00:00:00.000Z";

        fix.world.afterScheduleCreate = Effect.sync(() => {
          fix.world.control.set(campaignId, [
            {
              state: "scheduled",
              runToken: replacementToken,
              startedAt: undefined,
              pausedReason: undefined,
            },
          ]);
        });

        const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, sendAt));
        const createdToken = fix.schedules.created[0]?.runToken;

        expect(Result.isSuccess(attempt)).toBe(true);
        expect(createdToken).not.toBe(existingRunToken);
        expect(createdToken).not.toBe(replacementToken);
        expect(fix.schedules.removed).toContain(createdToken);
        expect(fix.schedules.removed).toContain(existingRunToken);
        expect(fix.schedules.removed).not.toContain(replacementToken);
        expect(fix.world.order).toStrictEqual(["newRun:scheduled", "create", "remove", "remove"]);
      }),
    ));

  it("refuses a sendAt at or before now", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, queuedAt));

        expect(failureOf(attempt)).toStrictEqual(
          new Schemas.SendAtNotInFuture({ sendAt: queuedAt }),
        );
        expect(fix.schedules.created).toHaveLength(0);
        expect(fix.schedules.removed).toHaveLength(0);
        expect(storedCampaign(fix)).toStrictEqual(draftCampaign);
        expect(fix.world.runTokens.has(campaignId)).toBe(false);
        expect(fix.world.order).toHaveLength(0);
      }),
    ));

  it.each([
    ["queued", queuedCampaign],
    ["sending", sendingCampaign],
    ["paused", pausedCampaign],
    ["completed", completedCampaign],
  ] as const)("returns a %s campaign unchanged", (_label, campaign) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign });

        const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(campaign);
        expect(fix.schedules.created).toHaveLength(0);
        expect(fix.schedules.removed).toHaveLength(0);
        expect(fix.world.order).toHaveLength(0);
      }),
    ),
  );

  it("fails StorageUnavailable when the schedule service fails after the write", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({
          scheduleFailure: new StorageFailure({
            operationId: "schedule",
            reason: "unavailable",
            cause: "lost",
          }),
        });

        const attempt = yield* runPublicly(fix, Campaigns.schedule(campaignId, futureSendAt));

        expect(failureOf(attempt)).toStrictEqual(
          new Schemas.StorageUnavailable({ operationId: "schedule" }),
        );
        expect(fix.schedules.created).toHaveLength(0);
        expect(fix.schedules.removed).toHaveLength(0);
        expect(storedCampaign(fix).submission).toStrictEqual({
          state: "scheduled",
          sendAt: futureSendAt,
        });
        expect(fix.world.order).toStrictEqual(["newRun:scheduled"]);
      }),
    ));

  it("returns the current campaign without creating a schedule when the write loses the source", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        fix.world.beforeWrite = Effect.sync(() => {
          fix.world.campaigns.set(campaignId, sendingCampaign);
          fix.world.runTokens.set(campaignId, existingRunToken);
        });

        const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(sendingCampaign);
        expect(fix.schedules.created).toHaveLength(0);
        expect(fix.schedules.removed).toHaveLength(0);
        expect(fix.world.order).toHaveLength(0);
      }),
    ));
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

  it("returns a scheduled campaign to draft, retains the token, and removes the schedule after the write", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(draftCampaign);
        expect(fix.schedules.removed).toStrictEqual([existingRunToken]);
        expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
        expect(storedCampaign(fix).submission).toStrictEqual({ state: "draft" });
        expect(fix.world.order).toStrictEqual(["cancelCampaign", "remove"]);
      }),
    ));

  it("returns a never-started queued campaign to draft and retains the token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(draftCampaign);
        expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
        expect(storedCampaign(fix).submission).toStrictEqual({ state: "draft" });
        expect(fix.schedules.removed).toStrictEqual([existingRunToken]);
        expect(fix.world.order).toStrictEqual(["cancelCampaign", "remove"]);
      }),
    ));

  it("pauses a queued resume as manual and preserves startedAt, progress and feedback", () =>
    Effect.runPromise(
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
        expect(fix.schedules.removed).toStrictEqual([existingRunToken]);
        expect(fix.world.order).toStrictEqual(["cancelCampaign", "remove"]);
      }),
    ));

  it.each([
    ["draft", draftCampaign],
    ["paused", pausedCampaign],
  ] as const)(
    "retries deletion of a retained token on an already-inactive %s campaign",
    (_label, campaign) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fix = fixture({ campaign, runToken: existingRunToken });

          const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

          expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(campaign);
          expect(fix.schedules.removed).toStrictEqual([existingRunToken]);
          expect(fix.world.order).toStrictEqual(["remove"]);
          expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
        }),
      ),
  );

  it("leaves a tokenless draft inactive without schedule cleanup", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture();

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(draftCampaign);
        expect(fix.schedules.removed).toHaveLength(0);
        expect(fix.world.order).toHaveLength(0);
      }),
    ));

  it.each([
    ["sending", sendingCampaign],
    ["completed", completedCampaign],
  ] as const)("conflicts with a %s campaign without mutating or cleaning up", (_label, campaign) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign, runToken: existingRunToken });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(failureOf(attempt)).toStrictEqual(
          new Schemas.CampaignStateConflict({ state: campaign.submission.state }),
        );
        expect(storedCampaign(fix)).toStrictEqual(campaign);
        expect(fix.schedules.removed).toHaveLength(0);
        expect(fix.world.order).toHaveLength(0);
      }),
    ),
  );

  it.each([
    ["draft", draftCampaign],
    ["paused", pausedCampaign],
    ["sending", sendingCampaign],
  ] as const)(
    "conflicts with a replacement %s generation and does not clean it up",
    (_label, replacement) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });

          fix.world.beforeWrite = Effect.sync(() => {
            fix.world.campaigns.set(campaignId, replacement);
            fix.world.runTokens.set(campaignId, replacementToken);
            rememberHistory(fix.world, replacement);
          });

          const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

          expect(failureOf(attempt)).toStrictEqual(
            new Schemas.CampaignStateConflict({ state: replacement.submission.state }),
          );
          expect(storedCampaign(fix)).toStrictEqual(replacement);
          expect(fix.world.runTokens.get(campaignId)).toBe(replacementToken);
          expect(fix.schedules.removed).toHaveLength(0);
        }),
      ),
  );

  it("succeeds idempotently when a concurrent cancel already drafted the same scheduled token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign: scheduledCampaign, runToken: existingRunToken });

        fix.world.beforeWrite = Effect.sync(() => {
          fix.world.campaigns.set(campaignId, draftCampaign);
        });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(Result.isSuccess(attempt) && attempt.success).toStrictEqual(draftCampaign);
        expect(fix.world.runTokens.get(campaignId)).toBe(existingRunToken);
        expect(fix.schedules.removed).toStrictEqual([existingRunToken]);
      }),
    ));

  it("succeeds idempotently when a concurrent cancel already paused the same resumed token as manual", () =>
    Effect.runPromise(
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
        expect(fix.schedules.removed).toStrictEqual([existingRunToken]);
      }),
    ));

  it("conflicts when a worker pauses a never-started queued run before the cancel reread", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fix = fixture({ campaign: queuedCampaign, runToken: existingRunToken });

        fix.world.beforeWrite = Effect.sync(() => {
          workerPauses(fix.world);
        });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(failureOf(attempt)).toStrictEqual(
          new Schemas.CampaignStateConflict({ state: "paused" }),
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
        expect(fix.schedules.removed).toHaveLength(0);
      }),
    ));

  it("conflicts when a worker pauses a queued resume before the cancel reread and keeps its history", () =>
    Effect.runPromise(
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
          new Schemas.CampaignStateConflict({ state: "paused" }),
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
        expect(fix.schedules.removed).toHaveLength(0);
      }),
    ));

  it("conflicts when begin wins the generation before cancel commits", () =>
    Effect.runPromise(
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
          new Schemas.CampaignStateConflict({ state: "sending" }),
        );
        expect(storedCampaign(fix).submission.state).toBe("sending");
        expect(fix.schedules.removed).toHaveLength(0);
      }),
    ));
});
