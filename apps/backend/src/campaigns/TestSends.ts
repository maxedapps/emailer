import { SendingPaused, TestAudienceTooLarge } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";

import { unsubscribeLink } from "../consent/Unsubscribe.ts";
import { Mailer } from "../sending/Mailer.ts";
import { SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";

/**
 * A list's members, if a test may reach them all. One member past the limit is requested, and a
 * second page is what decides: members whose contact is gone are dropped from a page, so its item
 * count alone could hide the twenty-first.
 */
const listRecipients = Effect.fn("TestSends.listRecipients")(function* (listId: string) {
  const audience = yield* AudienceStore;
  const page = yield* audience.listMembers(listId, Schemas.maxTestRecipients + 1, undefined);

  if (page.nextCursor !== undefined) {
    return yield* new TestAudienceTooLarge({ limit: Schemas.maxTestRecipients });
  }

  return page.items.map((member) => member.email);
});

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
  const campaigns = yield* CampaignStore;
  const guard = yield* SendGuard;
  const mailer = yield* Mailer;
  const campaign = yield* campaigns.getCampaign(campaignId);
  const recipients = "to" in payload ? payload.to : yield* listRecipients(payload.listId);
  const allowance = yield* guard.current;

  if (allowance.refusal !== undefined) {
    return yield* new SendingPaused({ reason: allowance.refusal });
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

    const unsubscribeUrl = yield* unsubscribeLink(email).pipe(Effect.orDie);
    const delay = yield* guard.slot(allowance.limit);

    yield* Effect.sleep(delay);

    const outcome = yield* mailer.send(email, content, unsubscribeUrl, { kind: "test" });

    outcomes.push({ email, ...outcome });
  }

  return { recipients: outcomes } satisfies Schemas.TestSendResult;
});
