import * as Schemas from "@emailer/api/Schemas";
import { Clock, Effect, Option } from "effect";

import { newIdentifier, nowIso } from "../Identifiers.ts";
import { CampaignWake } from "../sending/Dispatch.ts";
import { CampaignSchedule } from "./CampaignSchedule.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { corrupt } from "../storage/Errors.ts";

import type { CampaignControl } from "../storage/Campaigns.ts";

export const get = Effect.fn("Campaigns.get")(function* (campaignId: string) {
  const campaigns = yield* CampaignStore;

  const found = yield* campaigns.getCampaign(campaignId);

  if (Option.isNone(found)) {
    return yield* new Schemas.NotFound({ entity: "campaign" });
  }

  return found.value;
});

export const list = Effect.fn("Campaigns.list")(function* (
  limit: number,
  cursor: Schemas.EntityCursor | undefined,
) {
  const campaigns = yield* CampaignStore;

  const page = yield* campaigns.listCampaigns(limit, cursor);

  return page.nextCursor === undefined
    ? { items: page.items }
    : { items: page.items, nextCursor: page.nextCursor };
});

export const create = Effect.fn("Campaigns.create")(function* (
  payload: Schemas.CreateCampaignPayload,
) {
  const audience = yield* AudienceStore;
  const campaigns = yield* CampaignStore;

  const list = yield* audience.getList(payload.listId);

  if (Option.isNone(list)) {
    return yield* new Schemas.NotFound({ entity: "list" });
  }

  const id = yield* newIdentifier;
  const createdAt = yield* nowIso;

  const campaign = {
    id,
    listId: payload.listId,
    subject: payload.subject,
    text: payload.text,
    createdAt,
    submission: { state: "draft" } as const,
  };

  const withHtml = payload.html === undefined ? campaign : { ...campaign, html: payload.html };

  const created: Schemas.Campaign =
    payload.filter === undefined ? withHtml : { ...withHtml, filter: payload.filter };

  yield* campaigns.createCampaign(created);

  return created;
});

const readControl = Effect.fn("Campaigns.readControl")(function* (campaignId: string) {
  const campaigns = yield* CampaignStore;
  const control = yield* campaigns.getCampaignControl(campaignId);

  if (Option.isNone(control)) {
    return yield* new Schemas.NotFound({ entity: "campaign" });
  }

  return control.value;
});

/** A draft write whose condition failed: the campaign left draft, or was deleted, meanwhile. */
const draftConflict = Effect.fn("Campaigns.draftConflict")(function* (campaignId: string) {
  const control = yield* readControl(campaignId);

  return yield* new Schemas.CampaignStateConflict({ state: control.state });
});

/** Absent fields keep their value; null removes the HTML body or the filter. */
const edited = (
  current: Schemas.Campaign,
  change: Schemas.UpdateCampaignPayload,
): Schemas.Campaign => {
  const { html, filter, ...rest } = current;

  const campaign = {
    ...rest,
    listId: change.listId ?? current.listId,
    subject: change.subject ?? current.subject,
    text: change.text ?? current.text,
  };

  const nextHtml = change.html === undefined ? html : (change.html ?? undefined);
  const nextFilter = change.filter === undefined ? filter : (change.filter ?? undefined);
  const withHtml = nextHtml === undefined ? campaign : { ...campaign, html: nextHtml };

  return nextFilter === undefined ? withHtml : { ...withHtml, filter: nextFilter };
};

/** Edits a draft. The whole merged campaign is written, and only while it is still a draft. */
export const update = Effect.fn("Campaigns.update")(function* (
  campaignId: string,
  change: Schemas.UpdateCampaignPayload,
) {
  const audience = yield* AudienceStore;
  const campaigns = yield* CampaignStore;
  const current = yield* get(campaignId);

  if (current.submission.state !== "draft") {
    return yield* new Schemas.CampaignStateConflict({ state: current.submission.state });
  }

  if (change.listId !== undefined && Option.isNone(yield* audience.getList(change.listId))) {
    return yield* new Schemas.NotFound({ entity: "list" });
  }

  const next = edited(current, change);

  if ((yield* campaigns.updateDraft(next)) === "conflict") {
    return yield* draftConflict(campaignId);
  }

  return next;
});

/**
 * Deletes a draft and its body together. A schedule left behind by an earlier cancel is not
 * chased: if it fires, its wake finds no campaign, is discarded as stale, and the schedule deletes
 * itself.
 */
export const remove = Effect.fn("Campaigns.remove")(function* (campaignId: string) {
  const campaigns = yield* CampaignStore;
  const control = yield* readControl(campaignId);

  if (control.state !== "draft") {
    return yield* new Schemas.CampaignStateConflict({ state: control.state });
  }

  if ((yield* campaigns.deleteDraft(campaignId)) === "conflict") {
    return yield* draftConflict(campaignId);
  }
});

const requireRunToken = (control: CampaignControl) => {
  if (control.runToken === undefined) {
    return corrupt("getCampaignControl")(`${control.state} campaign has no run token`);
  }

  return Effect.succeed(control.runToken);
};

/**
 * Re-sends the wake-up for a campaign that is already queued. Both `send` and `resume` reach this
 * when an earlier call wrote `queued` but its enqueue or its response was lost, which is what
 * makes repeating either call the repair. The token is taken from the same control snapshot that
 * observed queued state, so a concurrent cancel or replacement is not woken from this path.
 */
const wakeQueued = Effect.fn("Campaigns.wakeQueued")(function* (
  campaignId: string,
  control: CampaignControl,
) {
  const wake = yield* CampaignWake;
  const runToken = yield* requireRunToken(control);

  yield* wake.enqueue(campaignId, runToken);

  return yield* get(campaignId);
});

export const send = Effect.fn("Campaigns.send")(function* (campaignId: string) {
  const campaigns = yield* CampaignStore;
  const wake = yield* CampaignWake;
  const schedules = yield* CampaignSchedule;
  const control = yield* readControl(campaignId);

  switch (control.state) {
    case "draft":
    case "scheduled": {
      if (control.state === "scheduled") {
        yield* requireRunToken(control);
      }

      const predecessor = control.runToken;
      const runToken = yield* newIdentifier;
      const now = yield* nowIso;

      const outcome = yield* campaigns.enqueueCampaign(
        campaignId,
        { state: control.state, runToken: predecessor },
        runToken,
        now,
      );

      if (outcome === "queued") {
        // Wake first so a later cleanup 503 cannot unpublish; the queued write may already be durable.
        yield* wake.enqueue(campaignId, runToken);

        if (predecessor !== undefined) {
          yield* schedules.remove(predecessor);
        }
      }

      return yield* get(campaignId);
    }

    case "queued":
      return yield* wakeQueued(campaignId, control);

    default:
      return yield* get(campaignId);
  }
});

export const resume = Effect.fn("Campaigns.resume")(function* (campaignId: string) {
  const campaigns = yield* CampaignStore;
  const wake = yield* CampaignWake;
  const control = yield* readControl(campaignId);

  switch (control.state) {
    case "paused": {
      const observed = yield* requireRunToken(control);
      const runToken = yield* newIdentifier;
      const now = yield* nowIso;

      const outcome = yield* campaigns.resumeCampaign(
        campaignId,
        { state: "paused", runToken: observed },
        runToken,
        now,
      );

      if (outcome === "queued") {
        yield* wake.enqueue(campaignId, runToken);
      }

      return yield* get(campaignId);
    }

    case "queued":
      return yield* wakeQueued(campaignId, control);

    default:
      return yield* get(campaignId);
  }
});

export const schedule = Effect.fn("Campaigns.schedule")(function* (
  campaignId: string,
  sendAt: string,
) {
  const campaigns = yield* CampaignStore;
  const schedules = yield* CampaignSchedule;
  const control = yield* readControl(campaignId);

  if (Date.parse(sendAt) <= (yield* Clock.currentTimeMillis)) {
    return yield* new Schemas.SendAtNotInFuture({ sendAt });
  }

  switch (control.state) {
    case "draft":
    case "scheduled": {
      if (control.state === "scheduled") {
        yield* requireRunToken(control);
      }

      const predecessor = control.runToken;
      const runToken = yield* newIdentifier;

      const outcome = yield* campaigns.scheduleCampaign(
        campaignId,
        { state: control.state, runToken: predecessor },
        runToken,
        sendAt,
      );

      if (outcome === "scheduled") {
        // Durable scheduled intent may precede create or cleanup failure.
        yield* schedules.create(campaignId, runToken, sendAt);

        const current = yield* campaigns.getCampaignControl(campaignId);

        const stillScheduled =
          Option.isSome(current) &&
          current.value.state === "scheduled" &&
          current.value.runToken === runToken;

        if (!stillScheduled) {
          yield* schedules.remove(runToken);
        }

        if (predecessor !== undefined && predecessor !== runToken) {
          yield* schedules.remove(predecessor);
        }
      }

      return yield* get(campaignId);
    }

    default:
      return yield* get(campaignId);
  }
});

const cancellationReachedDestination = (source: CampaignControl, current: CampaignControl) => {
  if (current.runToken !== source.runToken) {
    return false;
  }

  if (source.state === "scheduled" || source.startedAt === undefined) {
    return current.state === "draft";
  }

  return current.state === "paused" && current.pausedReason === "manual";
};

export const cancel = Effect.fn("Campaigns.cancel")(function* (campaignId: string) {
  const campaigns = yield* CampaignStore;
  const schedules = yield* CampaignSchedule;
  const control = yield* readControl(campaignId);

  switch (control.state) {
    case "draft":
    case "paused": {
      if (control.runToken !== undefined) {
        yield* schedules.remove(control.runToken);
      }

      return yield* get(campaignId);
    }

    case "sending":
    case "completed":
      return yield* new Schemas.CampaignStateConflict({ state: control.state });

    case "scheduled":
    case "queued": {
      const runToken = yield* requireRunToken(control);

      const source =
        control.state === "scheduled"
          ? { state: "scheduled" as const, runToken }
          : {
              state: "queued" as const,
              runToken,
              started: control.startedAt !== undefined,
            };

      const outcome = yield* campaigns.cancelCampaign(campaignId, source);

      if (outcome === "applied") {
        // Durable cancellation may precede cleanup failure; repeating cancel retries this token.
        yield* schedules.remove(runToken);

        return yield* get(campaignId);
      }

      const current = yield* campaigns.getCampaignControl(campaignId);

      if (Option.isNone(current)) {
        return yield* new Schemas.NotFound({ entity: "campaign" });
      }

      if (!cancellationReachedDestination(control, current.value)) {
        return yield* new Schemas.CampaignStateConflict({
          state: current.value.state,
        });
      }

      yield* schedules.remove(runToken);

      return yield* get(campaignId);
    }
  }
});
