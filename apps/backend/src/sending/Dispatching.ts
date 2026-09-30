import * as Schemas from "@emailer/api/Schemas";
import { Clock, Data, Duration, Effect, ErrorReporter, Predicate, Schedule } from "effect";

import { unsubscribeLink } from "../consent/Unsubscribe.ts";
import { newIdentifier, nowIso } from "../Identifiers.ts";
import { CampaignWake } from "./Dispatch.ts";
import { accepted, failureOutcomes, Mail, Mailer, submissionTimeout } from "./Mailer.ts";
import { SendGuard } from "./SendGuard.ts";
import { chooseVariant, matchesAttributes } from "./Variants.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { operationTimeout } from "../storage/Items.ts";

import type { DispatchMessage } from "./Dispatch.ts";
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
 * work; failing fails the invocation, so SQS redelivers. That is the expected
 * way out of a saturated limiter, so it is reported as a warning.
 */
export class SliceOverrun extends Data.TaggedError("SliceOverrun") {
  override get [ErrorReporter.severity]() {
    return "Warn" as const;
  }
}

/** A throttled send backs off 1 s, 2 s and 4 s; any other answer is final. */
const throttleBackoff = Schedule.exponential("1 second").pipe(
  Schedule.upTo({ times: 3 }),
  Schedule.while(({ input }) => Predicate.isTagged(input, "SendThrottled")),
);

const reservationFor = (delay: Duration.Duration) =>
  Duration.sum(delay, Duration.sum(submissionTimeout, Duration.times(operationTimeout, 2)));

const remainingUntil = (deadline: number) =>
  Effect.map(Clock.currentTimeMillis, (now) => Duration.millis(deadline - now));

/**
 * One page of a campaign run. A write that finds the run is no longer the campaign's ends the slice
 * as `RunSuperseded`: the wake-up that started it was stale, or went stale while it ran.
 */
export const runSlice = Effect.fn("Dispatching.runSlice")(
  function* (message: DispatchMessage, deadline: number) {
    const campaigns = yield* CampaignStore;
    const audience = yield* AudienceStore;
    const wake = yield* CampaignWake;
    const guards = yield* SendGuard;

    // Names this slice on the checkpoint it writes, so a retried checkpoint is recognised as its own.
    const sliceId = yield* newIdentifier;

    const {
      listId,
      subject,
      cursor: previous,
      filter,
      run,
    } = yield* campaigns.beginRun(message.campaignId, message.runToken, yield* nowIso);

    const guard = yield* guards.current;

    if (guard.refusal !== undefined) {
      yield* campaigns.pauseRun(message.campaignId, message.runToken, guard.refusal, previous);

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

    // A list deleted mid-run leaves nobody to send to, so the run completes.
    const page = yield* audience
      .listMembers(listId, memberPageSize, previous)
      .pipe(Effect.catchTag("ListNotFound", () => Effect.undefined));

    if (page === undefined) {
      yield* campaigns.completeRun(message.campaignId, message.runToken, yield* nowIso);

      return;
    }

    // Every copy is read once per slice; each recipient's is chosen from these.
    const copies = yield* campaigns.getCopies(message.campaignId);

    const ownContent: MessageContent = { subject, text: copies.body.text, html: copies.body.html };
    // ExclusiveStartKey of the last member this slice finished (skip, settle, or
    // already-claimed). A budget overrun before sending N checkpoints here so
    // the next page starts after N-1.
    let lastProcessed: string | undefined;

    const enqueueAfterCheckpoint = (next: string) =>
      campaigns
        .checkpoint(message.campaignId, message.runToken, sliceId, previous, next)
        .pipe(Effect.andThen(wake.enqueue(message.campaignId, message.runToken)));

    for (const member of page.items) {
      // A member the filter excludes is not a recipient, so it gets no row and no
      // counter; re-paging re-evaluates the same pure function, so nothing needs
      // recording; it sits before the status read so a miss costs no read.
      if (filter !== undefined && !matchesAttributes(filter, member.attributes)) {
        lastProcessed = member.id;
        continue;
      }

      const status = yield* audience.addressStatus(member.email, listId);
      const now = yield* nowIso;

      if (status !== "mailable") {
        // Skipped now or settled by an earlier slice, either way this member is done.
        yield* campaigns.skipRecipient(
          message.campaignId,
          message.runToken,
          member.id,
          member.email,
          status,
          now,
        );

        lastProcessed = member.id;
        continue;
      }

      const delay = yield* guards.slot(guard.limit);
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
      const unsubscribeUrl = yield* unsubscribeLink({ mailbox: member.email, listId }).pipe(
        Effect.orDie,
      );

      // Chosen from the attributes this slice read and recorded by the claim, so a redelivered page
      // or a later attribute change cannot send this member a second or different copy.
      const chosen = yield* chooseVariant(message.campaignId, member, copies.variants);
      const variant = chosen?.key ?? Schemas.defaultCopy;

      const content: MessageContent =
        chosen === undefined
          ? ownContent
          : { subject: chosen.subject, text: chosen.text, html: chosen.html };

      const sendId = yield* newIdentifier;

      const claimed = yield* campaigns.claimRecipient(
        message.campaignId,
        message.runToken,
        member.id,
        member.email,
        variant,
        sendId,
        now,
      );

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
        variant,
        contactId: member.id,
        runToken: message.runToken,
        limit: guard.limit,
        firstDelay: delay,
      });

      if (submitted === "stop") {
        return;
      }

      lastProcessed = member.id;
    }

    if (page.nextCursor === undefined) {
      yield* campaigns.completeRun(message.campaignId, message.runToken, yield* nowIso);

      return;
    }

    yield* enqueueAfterCheckpoint(page.nextCursor);
  },
  (slice, message) =>
    Effect.catchTag(slice, "RunSuperseded", () =>
      Effect.logInfo("stale wake discarded", {
        campaignId: message.campaignId,
        runToken: message.runToken,
        disposition: "stale",
      }),
    ),
);

const submitClaimed = Effect.fn("Dispatching.submitClaimed")(function* (input: {
  readonly recipient: string;
  readonly content: MessageContent;
  readonly unsubscribeUrl: string;
  readonly campaignId: string;
  readonly sendId: string;
  readonly variant: Schemas.CopyKey;
  readonly contactId: string;
  readonly runToken: string;
  readonly limit: number;
  readonly firstDelay: Duration.Duration;
}) {
  const mailer = yield* Mailer;
  const campaigns = yield* CampaignStore;
  const guards = yield* SendGuard;

  const { recipient, content, unsubscribeUrl, campaignId, sendId, variant, contactId, runToken } =
    input;

  const mail = Mail.Campaign({ content, unsubscribeUrl, campaignId, sendId, variant });

  // One attempt waits for its pacing slot and sends. The first attempt's slot is the one already
  // checked against the time budget; a retry reserves its own once it has backed off.
  const sendOnce = Effect.gen(function* () {
    const { attempt } = yield* Schedule.CurrentMetadata;

    yield* Effect.sleep(attempt === 0 ? input.firstDelay : yield* guards.slot(input.limit));

    return yield* mailer.send(recipient, mail);
  });

  const settlement = yield* Effect.retry(sendOnce, throttleBackoff).pipe(
    Effect.map(accepted),
    Effect.catchTags(failureOutcomes),
  );

  const finishedAt = yield* nowIso;

  // Another attempt settled this row, or the campaign is gone: the send happened either way.
  yield* campaigns
    .settleRecipient(campaignId, sendId, contactId, settlement, finishedAt)
    .pipe(
      Effect.catchTag("SettlementNotApplied", () =>
        Effect.logWarning("settlement not applied", { campaignId, sendId }),
      ),
    );

  if (
    settlement.outcome === "rejected" &&
    (settlement.rejectionCode === "rate-limited" || settlement.rejectionCode === "sending-paused")
  ) {
    yield* campaigns.pauseRun(campaignId, runToken, settlement.rejectionCode, contactId);

    return "stop" as const;
  }

  return "next" as const;
});
