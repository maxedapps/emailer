import { SendingPaused } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";

import { unsubscribeLink } from "../consent/Unsubscribe.ts";
import { accepted, failureOutcomes, Mail, Mailer } from "../sending/Mailer.ts";
import { SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { chooseCopy } from "./Copies.ts";

import type { MessageContent } from "../sending/Message.ts";

/**
 * Sends a `[Test]` of one of a campaign's copies to the few addresses named, now, and reports each
 * outcome. It renders as the contact `as` names, or as no contact, and goes only to the addresses
 * named: never to a contact's or a list's. Every copy is rendered before the first is sent, so a
 * copy that fails to render sends nothing.
 *
 * It shares everything account-wide with a campaign run — the guard, the daily budget and the
 * pacing slot — and touches nothing of the campaign's: no send rows, no counters, and no message
 * tags, so the feedback a test draws suppresses an address without reaching the campaign's
 * breaker. Each recipient gets one attempt; the operator repeats a test rather than the API
 * retrying it. Only the copy it sends is read.
 */
export const sendTest = Effect.fn("TestSends.sendTest")(function* (
  campaignId: string,
  payload: Schemas.TestSendPayload,
) {
  const audience = yield* AudienceStore;
  const campaigns = yield* CampaignStore;
  const guard = yield* SendGuard;
  const mailer = yield* Mailer;
  const campaign = yield* campaigns.getSummary(campaignId);
  const copy = yield* chooseCopy(campaign, payload.as, payload.variant);
  const allowance = yield* guard.current;

  if (allowance.refusal !== undefined) {
    return yield* new SendingPaused({ reason: allowance.refusal });
  }

  const prepared: Array<
    | { readonly email: string; readonly content: MessageContent; readonly unsubscribeUrl: string }
    | { readonly email: string; readonly skipped: Schemas.UnmailableStatus }
  > = [];

  for (const email of payload.to) {
    // The campaign's list: the copy stands in for the campaign's mail, and its unsubscribe link
    // works as the campaign's would, for the test address, never for the contact it renders as.
    const status = yield* audience.addressStatus(email, campaign.listId);

    if (status !== "mailable") {
      prepared.push({ email, skipped: status });
      continue;
    }

    const unsubscribeUrl = yield* unsubscribeLink({
      mailbox: email,
      listId: campaign.listId,
    }).pipe(Effect.orDie);

    const content = yield* copy.render(unsubscribeUrl);

    prepared.push({
      email,
      content: { ...content, subject: `[Test] ${content.subject}` },
      unsubscribeUrl,
    });
  }

  const outcomes: Array<Schemas.TestSendOutcome> = [];

  for (const recipient of prepared) {
    if ("skipped" in recipient) {
      outcomes.push({ email: recipient.email, outcome: "skipped", reason: recipient.skipped });
      continue;
    }

    const delay = yield* guard.slot(allowance.limit);

    yield* Effect.sleep(delay);

    const outcome = yield* mailer
      .send(
        recipient.email,
        Mail.Test({ content: recipient.content, unsubscribeUrl: recipient.unsubscribeUrl }),
      )
      .pipe(Effect.map(accepted), Effect.catchTags(failureOutcomes));

    outcomes.push({ email: recipient.email, ...outcome });
  }

  return { recipients: outcomes } satisfies Schemas.TestSendResult;
});
