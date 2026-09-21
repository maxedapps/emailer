import type * as Schemas from "@emailer/api/Schemas";
import { Clock, Context, Data, Duration, Effect, Option, Result } from "effect";
import { RateLimiter } from "effect/unstable/persistence";

import { CampaignWake } from "./Campaigns.ts";
import { newIdentifier, nowIso } from "./Identifiers.ts";
import { Mailer, submissionTimeout } from "./Mailer.ts";
import { AudienceStore } from "./Storage/Audience.ts";
import { CampaignStore } from "./Storage/Campaigns.ts";
import { operationTimeout } from "./Storage/Items.ts";
import { unsubscribeLink } from "./Unsubscribe.ts";

import type { DispatchMessage } from "./Dispatch.ts";
import type { SendGuard } from "./SendGuard.ts";
import type { OutgoingMessage } from "./Mailer.ts";

/**
 * Members per invocation. One page is the only loop shape, so every two-page
 * campaign exercises continuation.
 */
export const memberPageSize = 50;

/**
 * Per-run bounce and complaint thresholds. Integer arithmetic only.
 */
export const breaker = {
  bounce: { minimumAccepted: 200, percent: 5 },
  complaint: { minimumAccepted: 1000, perMille: 1 },
} as const;

/**
 * Per-slice send guard. The dispatcher constructs this from `GetAccount`,
 * `DescribeAlarms` and the optional daily ceiling so tests can stub the result.
 */
export class DispatchGuard extends Context.Service<
  DispatchGuard,
  {
    readonly current: Effect.Effect<SendGuard>;
  }
>()("emailer/backend/DispatchGuard") {}

/**
 * The first member's limiter delay already exceeds the remaining invocation
 * budget. Returning normally would acknowledge the SQS message and drop the
 * work; failing lets `reportedAndFatal` die so SQS redelivers.
 */
export class SliceOverrun extends Data.TaggedError("SliceOverrun") {}

const limiterWindow = "1 second";

const limiterKey = "ses-send";

const rateLimitedBackoffs = [
  Duration.seconds(1),
  Duration.seconds(2),
  Duration.seconds(4),
] as const;

const reservationFor = (delay: Duration.Duration) =>
  Duration.sum(delay, Duration.sum(submissionTimeout, Duration.times(operationTimeout, 2)));

const consumeSlot = (limit: number) =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter.RateLimiter;

    const consumed = yield* limiter.consume({
      key: limiterKey,
      window: limiterWindow,
      limit,
      onExceeded: "delay",
      algorithm: "fixed-window",
    });

    return consumed.delay;
  });

const remainingUntil = (deadline: number) =>
  Effect.map(Clock.currentTimeMillis, (now) => Duration.millis(deadline - now));

const matchesFilter = (
  filter: Schemas.ContactAttributes,
  attributes: Schemas.ContactAttributes | undefined,
) => Object.entries(filter).every(([key, value]) => attributes?.[key] === value);

export const runSlice = Effect.fn("Dispatching.runSlice")(function* (
  message: DispatchMessage,
  deadline: number,
) {
  const campaigns = yield* CampaignStore;
  const audience = yield* AudienceStore;
  const wake = yield* CampaignWake;
  const guards = yield* DispatchGuard;

  // Names this slice on the checkpoint it writes, so a retried checkpoint is recognised as its own.
  const sliceId = yield* newIdentifier;
  const begun = yield* campaigns.beginRun(message.campaignId, message.runToken, yield* nowIso);

  if (begun === "stale") {
    yield* Effect.logInfo("stale wake discarded", {
      campaignId: message.campaignId,
      runToken: message.runToken,
      disposition: "stale",
    });

    return;
  }

  const { listId, subject, cursor: previous, filter } = begun.campaign;
  const run = begun.campaign.run;
  const guard = yield* guards.current;

  if (Option.isSome(guard.halted)) {
    yield* campaigns.pauseRun(
      message.campaignId,
      message.runToken,
      "reputation",
      previous,
      yield* nowIso,
    );

    return;
  }

  if (guard.dailyExhausted) {
    yield* campaigns.pauseRun(
      message.campaignId,
      message.runToken,
      "daily-quota",
      previous,
      yield* nowIso,
    );

    return;
  }

  if (
    (run.accepted >= breaker.bounce.minimumAccepted &&
      run.bounced * 100 >= run.accepted * breaker.bounce.percent) ||
    (run.accepted >= breaker.complaint.minimumAccepted &&
      run.complained * 1000 >= run.accepted * breaker.complaint.perMille)
  ) {
    yield* campaigns.pauseRun(
      message.campaignId,
      message.runToken,
      "feedback",
      previous,
      yield* nowIso,
    );

    return;
  }

  const listed = yield* audience.listMembers(listId, memberPageSize, previous);

  if (Option.isNone(listed)) {
    yield* campaigns.completeRun(message.campaignId, message.runToken, yield* nowIso);

    return;
  }

  const page = listed.value;
  const { text, html } = yield* campaigns.getCampaignBody(message.campaignId);
  // ExclusiveStartKey of the last member this slice finished (skip, settle, or
  // already-claimed). A budget overrun before sending N checkpoints here so
  // the next page starts after N-1.
  let lastProcessed: string | undefined;

  const enqueueAfterCheckpoint = (next: string) =>
    Effect.gen(function* () {
      const outcome = yield* campaigns.checkpoint(
        message.campaignId,
        message.runToken,
        sliceId,
        previous,
        next,
      );

      if (outcome === "updated") {
        yield* wake.enqueue(message.campaignId, message.runToken);
      }
    });

  for (const member of page.items) {
    // A member the filter excludes is not a recipient, so it gets no row and no
    // counter; re-paging re-evaluates the same pure function, so nothing needs
    // recording; it sits before the status read so a miss costs no read.
    if (filter !== undefined && !matchesFilter(filter, member.attributes)) {
      lastProcessed = member.id;
      continue;
    }

    const status = yield* audience.addressStatus(member.email);
    const now = yield* nowIso;

    if (status !== "mailable") {
      const skipped = yield* campaigns.skipRecipient(
        message.campaignId,
        message.runToken,
        member.id,
        member.email,
        status,
        now,
      );

      if (skipped === "stale") {
        return;
      }

      lastProcessed = member.id;
      continue;
    }

    const delay = yield* consumeSlot(guard.limit);
    const remaining = yield* remainingUntil(deadline);

    if (Duration.isGreaterThan(reservationFor(delay), remaining)) {
      if (lastProcessed === undefined) {
        return yield* new SliceOverrun();
      }

      yield* enqueueAfterCheckpoint(lastProcessed);

      return;
    }

    const sendId = yield* newIdentifier;

    const claimed = yield* campaigns.claimRecipient(
      message.campaignId,
      message.runToken,
      member.id,
      member.email,
      sendId,
      now,
    );

    if (claimed === "stale") {
      return;
    }

    if (claimed === "already-claimed") {
      lastProcessed = member.id;
      continue;
    }

    const unsubscribeUrl = yield* unsubscribeLink(member.email).pipe(Effect.orDie);

    const outgoing: OutgoingMessage = {
      recipient: member.email,
      subject,
      text,
      html,
      unsubscribeUrl,
      campaignId: message.campaignId,
      sendId,
    };

    const submitted = yield* submitClaimed({
      outgoing,
      contactId: member.id,
      runToken: message.runToken,
      limit: guard.limit,
      firstDelay: delay,
    });

    if (submitted.kind === "stop") {
      return;
    }

    lastProcessed = member.id;
  }

  if (page.nextCursor === undefined) {
    yield* campaigns.completeRun(message.campaignId, message.runToken, yield* nowIso);

    return;
  }

  yield* enqueueAfterCheckpoint(page.nextCursor);
});

type ClaimedSubmit = { readonly kind: "next" } | { readonly kind: "stop" };

const submitClaimed = Effect.fn("Dispatching.submitClaimed")(function* (input: {
  readonly outgoing: OutgoingMessage;
  readonly contactId: string;
  readonly runToken: string;
  readonly limit: number;
  readonly firstDelay: Duration.Duration;
}) {
  const mailer = yield* Mailer;
  const campaigns = yield* CampaignStore;
  const { outgoing, contactId, runToken, limit } = input;

  for (let attempt = 0; ; attempt += 1) {
    const delay = attempt === 0 ? input.firstDelay : yield* consumeSlot(limit);

    yield* Effect.sleep(delay);

    const attemptResult = yield* Effect.result(mailer.submit(outgoing));
    const finishedAt = yield* nowIso;

    if (Result.isFailure(attemptResult)) {
      yield* campaigns.settleRecipient(
        outgoing.campaignId,
        outgoing.sendId,
        contactId,
        { state: "uncertain" },
        finishedAt,
      );

      return { kind: "next" } satisfies ClaimedSubmit;
    }

    const sent = attemptResult.success;

    if (sent.outcome === "accepted") {
      yield* campaigns.settleRecipient(
        outgoing.campaignId,
        outgoing.sendId,
        contactId,
        { state: "accepted", messageId: sent.messageId },
        finishedAt,
      );

      return { kind: "next" } satisfies ClaimedSubmit;
    }

    if (sent.rejectionCode === "rate-limited") {
      const backoff = rateLimitedBackoffs[attempt];

      if (backoff === undefined) {
        yield* campaigns.settleRecipient(
          outgoing.campaignId,
          outgoing.sendId,
          contactId,
          { state: "rejected", rejectionCode: "rate-limited" },
          finishedAt,
        );
        yield* campaigns.pauseRun(
          outgoing.campaignId,
          runToken,
          "rate-limited",
          contactId,
          finishedAt,
        );

        return { kind: "stop" } satisfies ClaimedSubmit;
      }

      yield* Effect.sleep(backoff);
      continue;
    }

    yield* campaigns.settleRecipient(
      outgoing.campaignId,
      outgoing.sendId,
      contactId,
      { state: "rejected", rejectionCode: sent.rejectionCode },
      finishedAt,
    );

    if (sent.rejectionCode === "sending-paused") {
      yield* campaigns.pauseRun(
        outgoing.campaignId,
        runToken,
        "sending-paused",
        contactId,
        finishedAt,
      );

      return { kind: "stop" } satisfies ClaimedSubmit;
    }

    return { kind: "next" } satisfies ClaimedSubmit;
  }
});
