import { Integration } from "@emailer/api/Api";
import {
  AddressUndeliverable,
  EmailServiceUnavailable,
  Forbidden,
  SendingPaused,
} from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Redacted } from "effect";

import { unavailable } from "../Errors.ts";
import { nowIso } from "../Identifiers.ts";
import { Mail, Mailer } from "../sending/Mailer.ts";
import { SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { SubscriptionState } from "../storage/Subscriptions.ts";
import { hashSecret, issueSecret } from "../Tokens.ts";

/**
 * The key's confirm page, with the link's token added to whatever query it already has. The token
 * is `<mailbox>.<listId>.<secret>`: what to confirm, and the proof that the mail was received.
 */
const confirmationLink = (
  confirmUrl: string,
  mailbox: string,
  listId: string,
  secret: Redacted.Redacted<string>,
): string => {
  const link = new URL(confirmUrl);

  link.searchParams.set("token", `${mailbox}.${listId}.${Redacted.value(secret)}`);

  return link.toString();
};

/**
 * Stores the pending sign-up and mails its link. The guard is asked first, so a paused account
 * writes nothing. SES refusing the mail after the write blocks a new one for an hour, which ADR-0027
 * accepts; a submission whose outcome is unknown may have gone out, so it counts as sent.
 */
const requestConfirmation = Effect.fn("Subscriptions.requestConfirmation")(function* (
  payload: Schemas.SubscribePayload,
  listName: string,
) {
  const integration = yield* Integration;
  const audience = yield* AudienceStore;
  const guard = yield* SendGuard;
  const mailer = yield* Mailer;
  const allowance = yield* guard.current;

  if (allowance.refusal !== undefined) {
    return yield* new SendingPaused({ reason: allowance.refusal });
  }

  const secret = yield* issueSecret;

  yield* audience.requestSubscription({
    email: payload.email,
    listId: payload.listId,
    name: payload.name,
    attributes: payload.attributes,
    source: payload.consent.source,
    wording: payload.consent.wording,
    ip: payload.ip,
    requestedAt: yield* nowIso,
    secretHash: yield* hashSecret(secret),
  });

  const confirmUrl = confirmationLink(
    integration.confirmUrl,
    Schemas.mailboxKey(payload.email),
    payload.listId,
    secret,
  );

  yield* Effect.sleep(yield* guard.slot(allowance.limit));

  yield* mailer.send(payload.email, Mail.Confirmation({ listName, confirmUrl })).pipe(
    Effect.catchTag("SubmissionUncertain", () => Effect.void),
    Effect.mapError(unavailable(EmailServiceUnavailable, "sendConfirmation")),
  );

  return Schemas.ConfirmationSent.make({});
});

/**
 * A site's sign-up: the first half of the double opt-in. Nothing joins the list here; the
 * subscriber does, once they use the mailed link.
 */
export const subscribe = Effect.fn("Subscriptions.subscribe")(function* (
  payload: Schemas.SubscribePayload,
) {
  const integration = yield* Integration;
  const audience = yield* AudienceStore;

  if (!integration.lists.includes(payload.listId)) {
    return yield* new Forbidden();
  }

  const list = yield* audience.getList(payload.listId);
  const state = yield* audience.subscriptionState(payload.listId, payload.email);

  return yield* SubscriptionState.$match(state, {
    Undeliverable: ({ reason }) => Effect.fail(new AddressUndeliverable({ reason })),
    Subscribed: () => Effect.succeed(Schemas.AlreadySubscribed.make({})),
    NotSubscribed: () => requestConfirmation(payload, list.name),
  });
});
