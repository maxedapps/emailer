import * as AWS from "@alchemy.run/aws";
import { Context, Duration, Effect, Layer } from "effect";

import { describeCause } from "../Errors.ts";
import { alertsTopic } from "./Reputation.ts";

import type * as sns from "@distilled.cloud/aws/sns";
import type * as Schemas from "@emailer/api/Schemas";
import type { EndedRun } from "../storage/Campaigns.ts";

/** Why the dispatcher pauses a run; only an operator pauses one `manual`, through the API. */
export type RunPauseReason = Exclude<Schemas.PauseReason, "manual">;

/** What each pause means and what to do about it, for the operator reading the alert. */
const pauseExplanations: Record<RunPauseReason, string> = {
  "sending-paused":
    "SES has paused sending for the account or the configuration set. Resume once it is enabled again.",
  "daily-quota":
    "The account's sends in the last 24 hours reached the daily budget. Resume once the rolling window has room again.",
  "rate-limited": "SES kept throttling sends through every retry. Resume to carry on.",
  reputation:
    "An account-wide bounce or complaint alarm is in ALARM, or SES no longer reports the account healthy. Check the account, then resume.",
  feedback:
    "This run's own bounces or complaints reached the breaker's rate. Check the list before resuming.",
};

/** An SNS subject is ASCII on one line, so it names only the event; the campaign goes in the body. */
export interface RunAlert {
  readonly subject: string;
  readonly message: string;
}

const counters = (run: EndedRun) =>
  [
    `Accepted ${run.progress.accepted}, rejected ${run.progress.rejected}, uncertain ${run.progress.uncertain}, skipped ${run.progress.skipped}.`,
    `Bounced ${run.feedback.bounced}, complained ${run.feedback.complained} so far.`,
  ].join("\n");

export const pausedAlert = (run: EndedRun, reason: RunPauseReason): RunAlert => ({
  subject: `emailer: campaign paused (${reason})`,
  message: [
    `Campaign paused: ${run.subject}`,
    pauseExplanations[reason],
    counters(run),
    `Resume it with: emailer campaigns resume ${run.id}`,
  ].join("\n\n"),
});

export const completedAlert = (run: EndedRun): RunAlert => ({
  subject: "emailer: campaign completed",
  message: [
    `Campaign completed: ${run.subject}`,
    counters(run),
    `See it with: emailer campaigns get ${run.id}`,
  ].join("\n\n"),
});

/** Bounds a publish so a slow SNS cannot hold a slice that has already ended its run. */
export const publishTimeout = Duration.seconds(5);

/**
 * Tells the stage's alert topic that a run paused or completed (ADR-0043). The run's state is
 * written before, so a publish that fails is only logged: failing the slice would make SQS redeliver
 * a wake-up that can only find its run superseded.
 */
export const makeRunAlerts = (
  publish: (
    request: AWS.SNS.PublishRequest,
  ) => Effect.Effect<sns.PublishResponse, sns.PublishError>,
) => {
  const send = (campaignId: string, alert: RunAlert) =>
    publish({ Subject: alert.subject, Message: alert.message }).pipe(
      Effect.timeout(publishTimeout),
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("run alert not published", { campaignId, cause: describeCause(error) }),
      ),
    );

  return {
    paused: (run: EndedRun, reason: RunPauseReason) => send(run.id, pausedAlert(run, reason)),
    completed: (run: EndedRun) => send(run.id, completedAlert(run)),
  } as const;
};

export class RunAlerts extends Context.Service<RunAlerts>()("emailer/backend/RunAlerts", {
  make: Effect.gen(function* () {
    return makeRunAlerts(yield* AWS.SNS.Publish(yield* alertsTopic));
  }),
}) {
  static readonly layer = Layer.effect(RunAlerts)(RunAlerts.make).pipe(
    Layer.provide(AWS.SNS.PublishHttp),
  );
}
