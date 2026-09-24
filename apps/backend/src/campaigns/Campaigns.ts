import { CampaignStateConflict, SendAtNotInFuture } from "@emailer/api/Errors";
import type * as Schemas from "@emailer/api/Schemas";
import { Clock, Effect } from "effect";

import { newIdentifier, nowIso } from "../Identifiers.ts";
import { CampaignWake } from "../sending/Dispatch.ts";
import { CampaignSchedule } from "./CampaignSchedule.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";

import type { CampaignControl } from "../storage/Campaigns.ts";

export const create = Effect.fn("Campaigns.create")(function* (
  payload: Schemas.CreateCampaignPayload,
) {
  const audience = yield* AudienceStore;
  const campaigns = yield* CampaignStore;

  // Read only to answer NotFound for a list that does not exist.
  yield* audience.getList(payload.listId);

  const id = yield* newIdentifier;
  const createdAt = yield* nowIso;

  const created: Schemas.Campaign = { id, ...payload, createdAt, submission: { state: "draft" } };

  yield* campaigns.createCampaign(created);

  return created;
});

/** A draft write whose condition failed: the campaign left draft, or was deleted, meanwhile. */
const draftConflict = Effect.fn("Campaigns.draftConflict")(function* (campaignId: string) {
  const campaigns = yield* CampaignStore;
  const control = yield* campaigns.getCampaignControl(campaignId);

  return yield* new CampaignStateConflict({ state: control.state });
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
  const current = yield* campaigns.getCampaign(campaignId);

  if (current.submission.state !== "draft") {
    return yield* new CampaignStateConflict({ state: current.submission.state });
  }

  // Read only to answer NotFound for a list that does not exist.
  if (change.listId !== undefined) {
    yield* audience.getList(change.listId);
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
  const control = yield* campaigns.getCampaignControl(campaignId);

  if (control.state !== "draft") {
    return yield* new CampaignStateConflict({ state: control.state });
  }

  if ((yield* campaigns.deleteDraft(campaignId)) === "conflict") {
    return yield* draftConflict(campaignId);
  }
});

/**
 * Re-sends the wake-up for a campaign that is already queued. Both `send` and `resume` reach this
 * when an earlier call wrote `queued` but its enqueue or its response was lost, which is what
 * makes repeating either call the repair. The token is taken from the same control snapshot that
 * observed queued state, so a concurrent cancel or replacement is not woken from this path.
 */
const wakeQueued = Effect.fn("Campaigns.wakeQueued")(function* (
  campaignId: string,
  runToken: string,
) {
  const campaigns = yield* CampaignStore;
  const wake = yield* CampaignWake;

  yield* wake.enqueue(campaignId, runToken);

  return yield* campaigns.getCampaign(campaignId);
});

export const send = Effect.fn("Campaigns.send")(function* (campaignId: string) {
  const campaigns = yield* CampaignStore;
  const wake = yield* CampaignWake;
  const control = yield* campaigns.getCampaignControl(campaignId);

  switch (control.state) {
    case "draft":
    case "scheduled": {
      const runToken = yield* newIdentifier;
      const now = yield* nowIso;

      const outcome = yield* campaigns.newRun(
        campaignId,
        { state: control.state, runToken: control.runToken },
        runToken,
        "queued",
        now,
      );

      if (outcome === "queued") {
        yield* wake.enqueue(campaignId, runToken);
      }

      return yield* campaigns.getCampaign(campaignId);
    }

    case "queued":
      return yield* wakeQueued(campaignId, control.runToken);

    default:
      return yield* campaigns.getCampaign(campaignId);
  }
});

export const resume = Effect.fn("Campaigns.resume")(function* (campaignId: string) {
  const campaigns = yield* CampaignStore;
  const wake = yield* CampaignWake;
  const control = yield* campaigns.getCampaignControl(campaignId);

  switch (control.state) {
    case "paused": {
      const runToken = yield* newIdentifier;
      const now = yield* nowIso;

      const outcome = yield* campaigns.newRun(
        campaignId,
        { state: "paused", runToken: control.runToken },
        runToken,
        "queued",
        now,
      );

      if (outcome === "queued") {
        yield* wake.enqueue(campaignId, runToken);
      }

      return yield* campaigns.getCampaign(campaignId);
    }

    case "queued":
      return yield* wakeQueued(campaignId, control.runToken);

    default:
      return yield* campaigns.getCampaign(campaignId);
  }
});

export const schedule = Effect.fn("Campaigns.schedule")(function* (
  campaignId: string,
  sendAt: string,
) {
  const campaigns = yield* CampaignStore;
  const schedules = yield* CampaignSchedule;
  const control = yield* campaigns.getCampaignControl(campaignId);

  if (Date.parse(sendAt) <= (yield* Clock.currentTimeMillis)) {
    return yield* new SendAtNotInFuture({ sendAt });
  }

  switch (control.state) {
    case "draft":
    case "scheduled": {
      const runToken = yield* newIdentifier;

      const outcome = yield* campaigns.newRun(
        campaignId,
        { state: control.state, runToken: control.runToken },
        runToken,
        "scheduled",
        sendAt,
      );

      if (outcome === "scheduled") {
        // Durable scheduled intent may precede a create failure. The predecessor's schedule, and
        // this one if a cancel lands first, fire stale and delete themselves.
        yield* schedules.create(campaignId, runToken, sendAt);
      }

      return yield* campaigns.getCampaign(campaignId);
    }

    default:
      return yield* campaigns.getCampaign(campaignId);
  }
});

type Pending = Extract<CampaignControl, { readonly state: "scheduled" | "queued" }>;

const cancellationReachedDestination = (source: Pending, current: CampaignControl) => {
  if (current.runToken !== source.runToken) {
    return false;
  }

  if (source.state === "scheduled" || source.startedAt === undefined) {
    return current.state === "draft";
  }

  return current.state === "paused" && current.pausedReason === "manual";
};

/** Withdraws a pending run. Only the campaign changes: its schedule fires stale and deletes itself. */
export const cancel = Effect.fn("Campaigns.cancel")(function* (campaignId: string) {
  const campaigns = yield* CampaignStore;
  const control = yield* campaigns.getCampaignControl(campaignId);

  switch (control.state) {
    case "draft":
    case "paused":
      return yield* campaigns.getCampaign(campaignId);

    case "sending":
    case "completed":
      return yield* new CampaignStateConflict({ state: control.state });

    case "scheduled":
    case "queued": {
      const source =
        control.state === "scheduled"
          ? { state: "scheduled" as const, runToken: control.runToken }
          : {
              state: "queued" as const,
              runToken: control.runToken,
              started: control.startedAt !== undefined,
            };

      const outcome = yield* campaigns.cancelCampaign(campaignId, source);

      if (outcome === "conflict") {
        const current = yield* campaigns.getCampaignControl(campaignId);

        if (!cancellationReachedDestination(control, current)) {
          return yield* new CampaignStateConflict({ state: current.state });
        }
      }

      return yield* campaigns.getCampaign(campaignId);
    }
  }
});
