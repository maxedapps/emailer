import * as Schemas from "@emailer/api/Schemas";
import { Effect, Option, Result } from "effect";

import { Mailer } from "../sending/Mailer.ts";
import { consumeSlot, SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { unavailable } from "../storage/Errors.ts";
import { get } from "./Campaigns.ts";

import type { SubmissionOutcome } from "../sending/Mailer.ts";

/**
 * A list's members, if a test may reach them all. One member past the limit is requested, and a
 * second page is what decides: members whose contact is gone are dropped from a page, so its item
 * count alone could hide the twenty-first.
 */
const listRecipients = Effect.fn("TestSends.listRecipients")(function* (listId: string) {
  const audience = yield* AudienceStore;
  const page = yield* audience.listMembers(listId, Schemas.maxTestRecipients + 1, undefined);

  if (Option.isNone(page)) {
    return yield* new Schemas.NotFound({ entity: "list" });
  }

  if (page.value.nextCursor !== undefined) {
    return yield* new Schemas.TestAudienceTooLarge({ limit: Schemas.maxTestRecipients });
  }

  return page.value.items.map((member) => member.email);
});

const outcomeOf = (
  email: string,
  sent: Result.Result<SubmissionOutcome, unknown>,
): Schemas.TestSendOutcome => {
  if (Result.isFailure(sent)) {
    return { email, outcome: "uncertain" };
  }

  return sent.success.outcome === "accepted"
    ? { email, outcome: "accepted", messageId: sent.success.messageId }
    : { email, outcome: "rejected", rejectionCode: sent.success.rejectionCode };
};

/**
 * Sends a `[Test]` copy of a campaign to a few addresses, now, and reports each outcome. It shares
 * everything account-wide with a campaign run — the guard, the daily budget and the pacing slot —
 * and touches nothing of the campaign's: no send rows, no counters, and no message tags, so the
 * feedback a test draws suppresses an address without reaching the campaign's breaker. Each
 * recipient gets one attempt; the operator repeats a test rather than the API retrying it.
 */
export const sendTest = Effect.fn("TestSends.sendTest")(function* (
  campaignId: string,
  payload: Schemas.TestSendPayload,
) {
  const audience = yield* AudienceStore;
  const guard = yield* SendGuard;
  const mailer = yield* Mailer;
  const campaign = yield* get(campaignId);
  const recipients = "to" in payload ? payload.to : yield* listRecipients(payload.listId);
  const allowance = yield* guard.current;

  if (Option.isSome(allowance.halted)) {
    return yield* new Schemas.SendingPaused({ reason: "reputation" });
  }

  if (allowance.dailyExhausted) {
    return yield* new Schemas.SendingPaused({ reason: "daily-quota" });
  }

  const content = {
    subject: `[Test] ${campaign.subject}`,
    text: campaign.text,
    html: campaign.html,
  };

  const outcomes: Array<Schemas.TestSendOutcome> = [];

  for (const email of recipients) {
    const status = yield* audience.addressStatus(email);

    if (status !== "mailable") {
      outcomes.push({ email, outcome: "skipped", reason: status });
      continue;
    }

    const delay = yield* consumeSlot(allowance.limit).pipe(Effect.mapError(unavailable("pacing")));

    yield* Effect.sleep(delay);

    outcomes.push(
      outcomeOf(email, yield* Effect.result(mailer.send(email, content, { kind: "test" }))),
    );
  }

  return { recipients: outcomes } satisfies Schemas.TestSendResult;
});
