import * as sns from "@distilled.cloud/aws/sns";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";

import { completedAlert, makeRunAlerts, pausedAlert, publishTimeout } from "./RunAlerts.ts";

import type * as AWS from "@alchemy.run/aws";
import type { EndedRun } from "../storage/Campaigns.ts";

const run: EndedRun = {
  id: "0195f0a0-1111-4222-8333-4444444ca409",
  subject: "Grüße zum Release 🎉",
  progress: { accepted: 24_120, rejected: 3, uncertain: 1, skipped: 412 },
  feedback: { bounced: 96, complained: 2 },
};

/** Captures what an alert logs, which is the only trace of a publish that failed. */
const loggedTo = (messages: Array<unknown>) =>
  Logger.layer([Logger.make((options) => messages.push(options.message))]);

describe("pausedAlert", () => {
  it("names the reason in an ASCII subject and the campaign, counters and resume command in the body", () => {
    expect(pausedAlert(run, "daily-quota")).toStrictEqual({
      subject: "emailer: campaign paused (daily-quota)",
      message: [
        "Campaign paused: Grüße zum Release 🎉",
        "The account's sends in the last 24 hours reached the daily budget. Resume once the rolling window has room again.",
        "Accepted 24120, rejected 3, uncertain 1, skipped 412.\nBounced 96, complained 2 so far.",
        `Resume it with: emailer campaigns resume ${run.id}`,
      ].join("\n\n"),
    });
  });
});

describe("completedAlert", () => {
  it("names the campaign, its counters and how to see it", () => {
    expect(completedAlert(run)).toStrictEqual({
      subject: "emailer: campaign completed",
      message: [
        "Campaign completed: Grüße zum Release 🎉",
        "Accepted 24120, rejected 3, uncertain 1, skipped 412.\nBounced 96, complained 2 so far.",
        `See it with: emailer campaigns get ${run.id}`,
      ].join("\n\n"),
    });
  });
});

describe("makeRunAlerts", () => {
  it.effect("publishes the alert's subject and body", () =>
    Effect.gen(function* () {
      const requests: Array<AWS.SNS.PublishRequest> = [];

      const alerts = makeRunAlerts((request) =>
        Effect.sync(() => {
          requests.push(request);

          return { MessageId: "sns-message" };
        }),
      );

      yield* alerts.paused(run, "feedback");
      yield* alerts.completed(run);

      expect(requests).toStrictEqual([
        {
          Subject: pausedAlert(run, "feedback").subject,
          Message: pausedAlert(run, "feedback").message,
        },
        { Subject: completedAlert(run).subject, Message: completedAlert(run).message },
      ]);
    }),
  );

  it.effect("logs a failed publish by its error's name and succeeds", () =>
    Effect.gen(function* () {
      const messages: Array<unknown> = [];

      const alerts = makeRunAlerts(() =>
        Effect.fail(new sns.AuthorizationErrorException({ message: "secret detail" })),
      );

      yield* alerts.completed(run).pipe(Effect.provide(loggedTo(messages)));

      expect(messages).toStrictEqual([
        ["run alert not published", { campaignId: run.id, cause: "AuthorizationErrorException" }],
      ]);
    }),
  );

  it.effect("gives up on a publish that does not answer within its timeout", () =>
    Effect.gen(function* () {
      const messages: Array<unknown> = [];
      const alerts = makeRunAlerts(() => Effect.never);

      const alerting = yield* Effect.forkChild(
        alerts.paused(run, "rate-limited").pipe(Effect.provide(loggedTo(messages))),
      );

      yield* TestClock.adjust(publishTimeout);
      yield* Fiber.join(alerting);

      expect(messages).toStrictEqual([
        ["run alert not published", { campaignId: run.id, cause: "TimeoutError" }],
      ]);
    }),
  );
});
