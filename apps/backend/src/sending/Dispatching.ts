import type * as Schemas from "@emailer/api/Schemas";
import { Clock, Data, Duration, Effect, Option, Result } from "effect";

import { unsubscribeLink } from "../consent/Unsubscribe.ts";
import { newIdentifier, nowIso } from "../Identifiers.ts";
import { CampaignWake } from "./Dispatch.ts";
import { Mailer, submissionTimeout } from "./Mailer.ts";
import { consumeSlot, SendGuard } from "./SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { operationTimeout } from "../storage/Items.ts";

import type { DispatchMessage } from "./Dispatch.ts";
import type { SendPurpose } from "./Mailer.ts";
import type { MessageContent } from "./Message.ts";

/**
 * Members per invocation. One page is the only loop shape, so every two-page
 * campaign exercises continuation.
 */
export const memberPageSize = 50;

/**
 * Per-run bounce and complaint thresholds. Integer arithmetic only.
 */
const breaker = {
  bounce: { minimumAccepted: 200, percent: 5 },
  complaint: { minimumAccepted: 1000, perMille: 1 },
} as const;

/**
 * The first member's limiter delay already exceeds the remaining invocation
 * budget. Returning normally would acknowledge the SQS message and drop the
 * work; failing lets `reportedAndFatal` die so SQS redelivers.
 */
export class SliceOverrun extends Data.TaggedError("SliceOverrun") {}

const rateLimitedBackoffs = [
  Duration.seconds(1),
  Duration.seconds(2),
  Duration.seconds(4),
] as const;

const reservationFor = (delay: Duration.Duration) =>
  Duration.sum(delay, Duration.sum(submissionTimeout, Duration.times(operationTimeout, 2)));

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
  const guards = yield* SendGuard;

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

  if (guard.halted) {
    yield* campaigns.pauseRun(message.campaignId, message.runToken, "reputation", previous);

    return;
  }

  if (guard.dailyExhausted) {
    yield* campaigns.pauseRun(message.campaignId, message.runToken, "daily-quota", previous);

    return;
  }

  if (
    (run.accepted >= breaker.bounce.minimumAccepted &&
      run.bounced * 100 >= run.accepted * breaker.bounce.percent) ||
    (run.accepted >= breaker.complaint.minimumAccepted &&
      run.complained * 1000 >= run.accepted * breaker.complaint.perMille)
  ) {
    yield* campaigns.pauseRun(message.campaignId, message.runToken, "feedback", previous);

    return;
  }

  const listed = yield* audience.listMembers(listId, memberPageSize, previous);

  if (Option.isNone(listed)) {
    yield* campaigns.completeRun(message.campaignId, message.runToken, yield* nowIso);

    return;
  }

  const page = listed.value;
  const { text, html } = yield* campaigns.getCampaignBody(message.campaignId);
  const content: MessageContent = { subject, text, html };
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

    // Minted before the claim: a claimed row is only ever settled by a submission, so a link that
    // cannot be minted must stop the slice while the member is still unclaimed.
    const unsubscribeUrl = yield* unsubscribeLink(member.email).pipe(Effect.orDie);

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

    const submitted = yield* submitClaimed({
      recipient: member.email,
      content,
      unsubscribeUrl,
      campaignId: message.campaignId,
      sendId,
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
  readonly recipient: string;
  readonly content: MessageContent;
  readonly unsubscribeUrl: string;
  readonly campaignId: string;
  readonly sendId: string;
  readonly contactId: string;
  readonly runToken: string;
  readonly limit: number;
  readonly firstDelay: Duration.Duration;
}) {
  const mailer = yield* Mailer;
  const campaigns = yield* CampaignStore;
  const { recipient, content, campaignId, sendId, contactId, runToken, limit } = input;
  const purpose: SendPurpose = { kind: "campaign", campaignId, sendId };

  for (let attempt = 0; ; attempt += 1) {
    const delay = attempt === 0 ? input.firstDelay : yield* consumeSlot(limit);

    yield* Effect.sleep(delay);

    const attemptResult = yield* Effect.result(
      mailer.send(recipient, content, input.unsubscribeUrl, purpose),
    );

    const finishedAt = yield* nowIso;

    if (Result.isFailure(attemptResult)) {
      yield* campaigns.settleRecipient(
        campaignId,
        sendId,
        contactId,
        { state: "uncertain" },
        finishedAt,
      );

      return { kind: "next" } satisfies ClaimedSubmit;
    }

    const sent = attemptResult.success;

    if (sent.outcome === "accepted") {
      yield* campaigns.settleRecipient(
        campaignId,
        sendId,
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
          campaignId,
          sendId,
          contactId,
          { state: "rejected", rejectionCode: "rate-limited" },
          finishedAt,
        );
        yield* campaigns.pauseRun(campaignId, runToken, "rate-limited", contactId);

        return { kind: "stop" } satisfies ClaimedSubmit;
      }

      yield* Effect.sleep(backoff);
      continue;
    }

    yield* campaigns.settleRecipient(
      campaignId,
      sendId,
      contactId,
      { state: "rejected", rejectionCode: sent.rejectionCode },
      finishedAt,
    );

    if (sent.rejectionCode === "sending-paused") {
      yield* campaigns.pauseRun(campaignId, runToken, "sending-paused", contactId);

      return { kind: "stop" } satisfies ClaimedSubmit;
    }

    return { kind: "next" } satisfies ClaimedSubmit;
  }
});
