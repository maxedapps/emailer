import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import type * as Schemas from "@emailer/api/Schemas";
import { Effect, Layer, Result } from "effect";

import { CampaignSchedule } from "./CampaignSchedule.ts";
import * as Campaigns from "./Campaigns.ts";
import { CampaignWake } from "../sending/Dispatch.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignChanged, CampaignStore } from "../storage/Campaigns.ts";
import { unusedAudience, unusedCampaigns } from "../storage/Testing.ts";

import type { CampaignControl, CancelSource, RunSource } from "../storage/Campaigns.ts";

/**
 * What the commands decide: which store write they make, with which arguments, what they wake or
 * schedule, and how they answer a refused write. The store is a recording stub that answers what a
 * test scripts; its own conditions are the storage suite's and the live suite's to prove.
 */

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const otherListId = "0195f0a0-1111-4222-8333-44444444109f";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const existingRunToken = "0195f0a0-1111-4222-8333-44444444e5d2";

const replacementToken = "0195f0a0-1111-4222-8333-44444444e5d3";

const queuedAt = "2026-09-11T10:00:01.000Z";

const startedAt = "2026-09-11T10:00:02.000Z";

const finishedAt = "2026-09-11T10:00:03.000Z";

const futureSendAt = "2099-01-01T00:00:00.000Z";

const progress: Schemas.CampaignProgress = { accepted: 0, rejected: 0, uncertain: 0, skipped: 0 };

const feedback: Schemas.CampaignFeedback = { bounced: 0, complained: 0 };

const draftCampaign: Schemas.Campaign = {
  id: campaignId,
  listId,
  subject: "Release notes",
  text: "Hello there",
  createdAt: "2026-09-11T10:00:00.000Z",
  submission: { state: "draft" },
};

const sendingCampaign: Schemas.Campaign = {
  ...draftCampaign,
  submission: { state: "sending", queuedAt, startedAt, progress, feedback },
};

const completedCampaign: Schemas.Campaign = {
  ...draftCampaign,
  submission: { state: "completed", queuedAt, startedAt, finishedAt, progress, feedback },
};

const draft: CampaignControl = { state: "draft" };

const retainedDraft: CampaignControl = { state: "draft", runToken: existingRunToken };

const scheduled: CampaignControl = { state: "scheduled", runToken: existingRunToken };

const queued: CampaignControl = { state: "queued", runToken: existingRunToken };

const queuedResume: CampaignControl = { state: "queued", runToken: existingRunToken, startedAt };

const sending: CampaignControl = { state: "sending", runToken: existingRunToken, startedAt };

const paused = (pausedReason: Schemas.PauseReason): CampaignControl => ({
  state: "paused",
  runToken: existingRunToken,
  startedAt,
  pausedReason,
});

const completed: CampaignControl = { state: "completed", runToken: existingRunToken, startedAt };

interface Scenario {
  /** What the campaign's control item reads as. */
  readonly control?: CampaignControl;
  /** What reading the whole campaign answers, or `missing` for one that is not there. */
  readonly campaign?: Schemas.Campaign | "missing";
  readonly lists?: ReadonlyArray<string>;
  /** How `newRun` and `cancelCampaign` refuse, if they do. */
  readonly runRefusal?: CampaignChanged;
  /** How `updateDraft` and `deleteDraft` refuse, if they do. */
  readonly draftRefusal?: Errors.CampaignNotFound | Errors.CampaignStateConflict;
  readonly wakeFailure?: Errors.QueueUnavailable;
  readonly scheduleFailure?: Errors.SchedulerUnavailable;
}

interface NewRun {
  readonly expected: RunSource;
  readonly newToken: string;
  readonly target: "queued" | "scheduled";
  readonly at: string;
}

interface Recorded {
  /** Every write and side effect, in order. */
  readonly calls: Array<string>;
  readonly controlReads: Array<string>;
  readonly created: Array<Schemas.Campaign>;
  readonly runs: Array<NewRun>;
  readonly cancels: Array<CancelSource>;
  readonly drafts: Array<Schemas.Campaign>;
  readonly deleted: Array<string>;
  readonly wakes: Array<{ readonly campaignId: string; readonly runToken: string }>;
  readonly schedules: Array<{
    readonly campaignId: string;
    readonly runToken: string;
    readonly sendAt: string;
  }>;
}

const fixture = (scenario: Scenario = {}) => {
  const recorded: Recorded = {
    calls: [],
    controlReads: [],
    created: [],
    runs: [],
    cancels: [],
    drafts: [],
    deleted: [],
    wakes: [],
    schedules: [],
  };

  const lists = new Set(scenario.lists ?? [listId]);
  const campaign = scenario.campaign ?? draftCampaign;

  const layer = Layer.mergeAll(
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      getList: (id) =>
        lists.has(id)
          ? Effect.succeed({ id, name: "Readers", createdAt: "2026-09-11T09:00:00.000Z" })
          : Effect.fail(new Errors.ListNotFound()),
    }),
    Layer.succeed(CampaignStore)({
      ...unusedCampaigns,
      createCampaign: (created) =>
        Effect.sync(() => {
          recorded.calls.push("createCampaign");
          recorded.created.push(created);
        }),
      getCampaign: () =>
        campaign === "missing"
          ? Effect.fail(new Errors.CampaignNotFound())
          : Effect.succeed(campaign),
      getCampaignControl: (id) =>
        Effect.sync(() => {
          recorded.controlReads.push(id);

          return scenario.control ?? draft;
        }),
      newRun: (_id, expected, newToken, target, at) =>
        Effect.suspend(() => {
          if (scenario.runRefusal !== undefined) {
            return Effect.fail(scenario.runRefusal);
          }

          recorded.calls.push(`newRun:${target}`);
          recorded.runs.push({ expected, newToken, target, at });

          return Effect.void;
        }),
      cancelCampaign: (_id, source) =>
        Effect.suspend(() => {
          recorded.calls.push("cancelCampaign");
          recorded.cancels.push(source);

          return scenario.runRefusal === undefined ? Effect.void : Effect.fail(scenario.runRefusal);
        }),
      updateDraft: (next) =>
        Effect.suspend(() => {
          recorded.calls.push("updateDraft");
          recorded.drafts.push(next);

          return scenario.draftRefusal === undefined
            ? Effect.void
            : Effect.fail(scenario.draftRefusal);
        }),
      deleteDraft: (id) =>
        Effect.suspend(() => {
          recorded.calls.push("deleteDraft");
          recorded.deleted.push(id);

          return scenario.draftRefusal === undefined
            ? Effect.void
            : Effect.fail(scenario.draftRefusal);
        }),
    }),
    Layer.succeed(CampaignWake)({
      enqueue: (id, runToken) =>
        Effect.gen(function* () {
          if (scenario.wakeFailure !== undefined) {
            return yield* scenario.wakeFailure;
          }

          recorded.calls.push("enqueue");
          recorded.wakes.push({ campaignId: id, runToken });
        }),
    }),
    Layer.succeed(CampaignSchedule)({
      create: (id, runToken, sendAt) =>
        Effect.gen(function* () {
          if (scenario.scheduleFailure !== undefined) {
            return yield* scenario.scheduleFailure;
          }

          recorded.calls.push("schedule");
          recorded.schedules.push({ campaignId: id, runToken, sendAt });
        }),
    }),
    NodeServices.layer,
  );

  return { layer, recorded };
};

const runWith = <A, E, R>(fix: ReturnType<typeof fixture>, effect: Effect.Effect<A, E, R>) =>
  Effect.result(effect).pipe(Effect.provide(fix.layer));

const successOf = <A, E>(attempt: Result.Result<A, E>): A => {
  if (Result.isFailure(attempt)) {
    throw new Error("Expected the operation to succeed");
  }

  return attempt.success;
};

const failureOf = <A, E>(attempt: Result.Result<A, E>): E => {
  if (Result.isSuccess(attempt)) {
    throw new Error("Expected the operation to fail");
  }

  return attempt.failure;
};

const queueUnavailable = new Errors.QueueUnavailable({
  operation: "dispatch",
  failure: "ServiceUnavailable",
});

const schedulerUnavailable = new Errors.SchedulerUnavailable({
  operation: "schedule",
  failure: "ServiceUnavailable",
});

/** A refused write that found the campaign as `current`. */
const changedTo = (current: CampaignControl | undefined) => new CampaignChanged({ current });

describe("create", () => {
  it.effect("refuses a campaign for a list that does not exist", () =>
    Effect.gen(function* () {
      const fix = fixture({ lists: [] });

      const attempt = yield* runWith(
        fix,
        Campaigns.create({ listId, subject: "Hi", text: "There" }),
      );

      expect(failureOf(attempt)).toStrictEqual(new Errors.ListNotFound());
      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );

  it.effect("stores a draft carrying the payload's body and filter under a fresh id", () =>
    Effect.gen(function* () {
      const fix = fixture();
      const payload = { listId, subject: "Hi", text: "There", html: "<p>There</p>", filter: {} };

      const created = successOf(yield* runWith(fix, Campaigns.create(payload)));

      expect(created).toMatchObject({ ...payload, submission: { state: "draft" } });
      expect(fix.recorded.created).toStrictEqual([created]);
    }),
  );
});

describe("send", () => {
  it.effect.each([
    ["a draft", draft],
    ["a draft that retains a cancelled run's token", retainedDraft],
    ["a scheduled campaign", scheduled],
  ] as const)(
    "starts a queued run from %s, observing its token, and wakes it",
    ([_label, control]) =>
      Effect.gen(function* () {
        const fix = fixture({ control });

        expect(successOf(yield* runWith(fix, Campaigns.send(campaignId)))).toStrictEqual(
          draftCampaign,
        );

        const [run] = fix.recorded.runs;

        expect(run).toMatchObject({
          expected: { state: control.state, runToken: control.runToken },
          target: "queued",
        });
        expect(run?.newToken).not.toBe(existingRunToken);
        expect(fix.recorded.wakes).toStrictEqual([{ campaignId, runToken: run?.newToken }]);
        expect(fix.recorded.calls).toStrictEqual(["newRun:queued", "enqueue"]);
      }),
  );

  it.effect("re-wakes a queued campaign with the token its control holds", () =>
    Effect.gen(function* () {
      const fix = fixture({ control: queued });

      yield* runWith(fix, Campaigns.send(campaignId));

      expect(fix.recorded.wakes).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
      expect(fix.recorded.runs).toHaveLength(0);
    }),
  );

  it.effect.each([
    ["sending", sending, sendingCampaign],
    ["completed", completed, completedCampaign],
  ] as const)("returns a %s campaign unchanged", ([_label, control, campaign]) =>
    Effect.gen(function* () {
      const fix = fixture({ control, campaign });

      expect(successOf(yield* runWith(fix, Campaigns.send(campaignId)))).toStrictEqual(campaign);
      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );

  it.effect("fails QueueUnavailable when the wake fails after the queued write", () =>
    Effect.gen(function* () {
      const fix = fixture({ wakeFailure: queueUnavailable });

      const attempt = yield* runWith(fix, Campaigns.send(campaignId));

      expect(failureOf(attempt)).toStrictEqual(queueUnavailable);
      expect(fix.recorded.calls).toStrictEqual(["newRun:queued"]);
    }),
  );

  it.effect("wakes nothing when another command started a run first", () =>
    Effect.gen(function* () {
      const fix = fixture({ runRefusal: changedTo(sending), campaign: sendingCampaign });

      expect(successOf(yield* runWith(fix, Campaigns.send(campaignId)))).toStrictEqual(
        sendingCampaign,
      );
      expect(fix.recorded.calls).toStrictEqual([]);
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

      expect(successOf(attempt)).toStrictEqual(expected);
      expect(fix.recorded.drafts).toStrictEqual([expected]);
    }),
  );

  it.effect("replaces the body and the filter it is given, keeping the rest", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: filtered });

      yield* runWith(
        fix,
        Campaigns.update(campaignId, { text: "New text", html: "<p>New</p>", filter: {} }),
      );

      expect(fix.recorded.drafts).toStrictEqual([
        { ...filtered, text: "New text", html: "<p>New</p>", filter: {} },
      ]);
    }),
  );

  it.effect("moves the draft to another list only when that list exists", () =>
    Effect.gen(function* () {
      const missing = fixture();

      expect(
        failureOf(yield* runWith(missing, Campaigns.update(campaignId, { listId: otherListId }))),
      ).toStrictEqual(new Errors.ListNotFound());
      expect(missing.recorded.calls).toStrictEqual([]);

      const present = fixture({ lists: [listId, otherListId] });

      yield* runWith(present, Campaigns.update(campaignId, { listId: otherListId }));

      expect(present.recorded.drafts).toStrictEqual([{ ...draftCampaign, listId: otherListId }]);
    }),
  );

  it.effect("answers NotFound for a campaign that does not exist", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: "missing" });

      const attempt = yield* runWith(fix, Campaigns.update(campaignId, { subject: "x" }));

      expect(failureOf(attempt)).toStrictEqual(new Errors.CampaignNotFound());
    }),
  );

  it.effect("refuses to edit a campaign that is no longer a draft, writing nothing", () =>
    Effect.gen(function* () {
      const fix = fixture({ campaign: sendingCampaign });

      const attempt = yield* runWith(fix, Campaigns.update(campaignId, { subject: "x" }));

      expect(failureOf(attempt)).toStrictEqual(
        new Errors.CampaignStateConflict({ state: "sending" }),
      );
      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );

  it.effect("reports the state a concurrent send left when the draft write is refused", () =>
    Effect.gen(function* () {
      const refusal = new Errors.CampaignStateConflict({ state: "queued" });
      const fix = fixture({ draftRefusal: refusal });

      const attempt = yield* runWith(fix, Campaigns.update(campaignId, { subject: "x" }));

      expect(failureOf(attempt)).toStrictEqual(refusal);
    }),
  );
});

describe("remove", () => {
  it.effect("deletes a draft", () =>
    Effect.gen(function* () {
      const fix = fixture();

      successOf(yield* runWith(fix, Campaigns.remove(campaignId)));

      expect(fix.recorded.deleted).toStrictEqual([campaignId]);
    }),
  );

  it.effect("refuses to delete a campaign that is no longer a draft, writing nothing", () =>
    Effect.gen(function* () {
      const fix = fixture({ control: scheduled });

      const attempt = yield* runWith(fix, Campaigns.remove(campaignId));

      expect(failureOf(attempt)).toStrictEqual(
        new Errors.CampaignStateConflict({ state: "scheduled" }),
      );
      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );

  it.effect("answers NotFound when a concurrent delete removed the draft first", () =>
    Effect.gen(function* () {
      const fix = fixture({ draftRefusal: new Errors.CampaignNotFound() });

      const attempt = yield* runWith(fix, Campaigns.remove(campaignId));

      expect(failureOf(attempt)).toStrictEqual(new Errors.CampaignNotFound());
    }),
  );
});

describe("resume", () => {
  it.effect("starts a queued run from a paused campaign, observing its token, and wakes it", () =>
    Effect.gen(function* () {
      const fix = fixture({ control: paused("rate-limited") });

      yield* runWith(fix, Campaigns.resume(campaignId));

      const [run] = fix.recorded.runs;

      expect(run).toMatchObject({
        expected: { state: "paused", runToken: existingRunToken },
        target: "queued",
      });
      expect(run?.newToken).not.toBe(existingRunToken);
      expect(fix.recorded.wakes).toStrictEqual([{ campaignId, runToken: run?.newToken }]);
      expect(fix.recorded.schedules).toHaveLength(0);
    }),
  );

  it.effect("re-wakes a queued campaign with the token its control holds, as send does", () =>
    Effect.gen(function* () {
      const fix = fixture({ control: queued });

      yield* runWith(fix, Campaigns.resume(campaignId));

      expect(fix.recorded.wakes).toStrictEqual([{ campaignId, runToken: existingRunToken }]);
      expect(fix.recorded.runs).toHaveLength(0);
    }),
  );

  it.effect.each([
    ["draft", draft],
    ["scheduled", scheduled],
    ["sending", sending],
    ["completed", completed],
  ] as const)("returns a %s campaign unchanged", ([_label, control]) =>
    Effect.gen(function* () {
      const fix = fixture({ control });

      expect(successOf(yield* runWith(fix, Campaigns.resume(campaignId)))).toStrictEqual(
        draftCampaign,
      );
      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );

  it.effect("wakes nothing when the paused run it observed has moved on", () =>
    Effect.gen(function* () {
      const fix = fixture({
        control: paused("rate-limited"),
        runRefusal: changedTo(sending),
        campaign: sendingCampaign,
      });

      expect(successOf(yield* runWith(fix, Campaigns.resume(campaignId)))).toStrictEqual(
        sendingCampaign,
      );
      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );
});

describe("schedule", () => {
  it.effect.each([
    ["a draft", draft],
    ["a scheduled campaign", scheduled],
  ] as const)(
    "starts a scheduled run from %s under a fresh token and creates its schedule",
    ([_label, control]) =>
      Effect.gen(function* () {
        const fix = fixture({ control });

        yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt));

        const [run] = fix.recorded.runs;

        expect(run).toMatchObject({
          expected: { state: control.state, runToken: control.runToken },
          target: "scheduled",
          at: futureSendAt,
        });
        expect(run?.newToken).not.toBe(existingRunToken);
        expect(fix.recorded.schedules).toStrictEqual([
          { campaignId, runToken: run?.newToken, sendAt: futureSendAt },
        ]);
        expect(fix.recorded.calls).toStrictEqual(["newRun:scheduled", "schedule"]);
      }),
  );

  it.effect("refuses a sendAt of exactly now", () =>
    Effect.gen(function* () {
      const fix = fixture();
      // The test clock starts at the epoch, so this instant is now.
      const now = "1970-01-01T00:00:00.000Z";

      const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, now));

      expect(failureOf(attempt)).toStrictEqual(new Errors.SendAtNotInFuture({ sendAt: now }));
      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );

  it.effect.each([
    ["queued", queued],
    ["sending", sending],
    ["paused", paused("rate-limited")],
    ["completed", completed],
  ] as const)("returns a %s campaign unchanged", ([_label, control]) =>
    Effect.gen(function* () {
      const fix = fixture({ control });

      yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt));

      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );

  it.effect("fails SchedulerUnavailable when the schedule service fails after the write", () =>
    Effect.gen(function* () {
      const fix = fixture({ scheduleFailure: schedulerUnavailable });

      const attempt = yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt));

      expect(failureOf(attempt)).toStrictEqual(schedulerUnavailable);
      expect(fix.recorded.calls).toStrictEqual(["newRun:scheduled"]);
    }),
  );

  it.effect("creates no schedule when another command started a run first", () =>
    Effect.gen(function* () {
      const fix = fixture({ runRefusal: changedTo(sending), campaign: sendingCampaign });

      expect(
        successOf(yield* runWith(fix, Campaigns.schedule(campaignId, futureSendAt))),
      ).toStrictEqual(sendingCampaign);
      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );
});

describe("cancel", () => {
  it.effect.each([
    ["a scheduled run", scheduled, { state: "scheduled", runToken: existingRunToken }],
    [
      "a queued first send",
      queued,
      { state: "queued", runToken: existingRunToken, started: false },
    ],
    [
      "a queued resume",
      queuedResume,
      { state: "queued", runToken: existingRunToken, started: true },
    ],
  ] as const)("withdraws %s under the token it observed", ([_label, control, source]) =>
    Effect.gen(function* () {
      const fix = fixture({ control });

      successOf(yield* runWith(fix, Campaigns.cancel(campaignId)));

      expect(fix.recorded.cancels).toStrictEqual([source]);
    }),
  );

  it.effect.each([
    ["draft", draft],
    ["paused", paused("rate-limited")],
  ] as const)("returns an already-inactive %s campaign unchanged", ([_label, control]) =>
    Effect.gen(function* () {
      const fix = fixture({ control });

      successOf(yield* runWith(fix, Campaigns.cancel(campaignId)));

      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );

  it.effect.each([
    ["sending", sending],
    ["completed", completed],
  ] as const)("conflicts with a %s campaign without writing", ([label, control]) =>
    Effect.gen(function* () {
      const fix = fixture({ control });

      const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

      expect(failureOf(attempt)).toStrictEqual(new Errors.CampaignStateConflict({ state: label }));
      expect(fix.recorded.calls).toStrictEqual([]);
    }),
  );

  it.effect.each([
    ["draft", { state: "draft", runToken: replacementToken }],
    ["paused", { ...paused("rate-limited"), runToken: replacementToken }],
    ["sending", { ...sending, runToken: replacementToken }],
  ] as const)("conflicts with a replacement %s run", ([label, current]) =>
    Effect.gen(function* () {
      const fix = fixture({ control: scheduled, runRefusal: changedTo(current) });

      const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

      expect(failureOf(attempt)).toStrictEqual(new Errors.CampaignStateConflict({ state: label }));
      // The refusal answered the campaign as it now is: no second read.
      expect(fix.recorded.controlReads).toHaveLength(1);
    }),
  );

  it.effect.each([
    ["a scheduled run already back in draft", scheduled, retainedDraft],
    ["a queued resume already paused as manual", queuedResume, paused("manual")],
  ] as const)(
    "succeeds when a concurrent cancel already took %s under the same token",
    ([_label, control, current]) =>
      Effect.gen(function* () {
        const fix = fixture({ control, runRefusal: changedTo(current) });

        successOf(yield* runWith(fix, Campaigns.cancel(campaignId)));
      }),
  );

  it.effect.each([
    ["a queued first send", queued],
    ["a queued resume", queuedResume],
  ] as const)(
    "conflicts when a worker paused %s before the cancel committed",
    ([_label, control]) =>
      Effect.gen(function* () {
        const fix = fixture({ control, runRefusal: changedTo(paused("rate-limited")) });

        const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

        expect(failureOf(attempt)).toStrictEqual(
          new Errors.CampaignStateConflict({ state: "paused" }),
        );
      }),
  );

  it.effect("conflicts when the run began before the cancel committed", () =>
    Effect.gen(function* () {
      const fix = fixture({ control: queued, runRefusal: changedTo(sending) });

      const attempt = yield* runWith(fix, Campaigns.cancel(campaignId));

      expect(failureOf(attempt)).toStrictEqual(
        new Errors.CampaignStateConflict({ state: "sending" }),
      );
    }),
  );
});
