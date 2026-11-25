import { Integration, OptIn } from "@emailer/api/Api";
import {
  AddressOptedOut,
  AddressUndeliverable,
  ConfirmationNotFound,
  EmailServiceUnavailable,
  Forbidden,
  SendingPaused,
} from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Option, Redacted, Schema } from "effect";

import { unavailable } from "../Errors.ts";
import { newIdentifier, nowIso } from "../Identifiers.ts";
import { Mail, Mailer } from "../sending/Mailer.ts";
import { SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { SubscriptionState } from "../storage/Subscriptions.ts";
import { hashSecret, IssuedSecret, issueSecret } from "../Tokens.ts";

import type { Data } from "effect";

/** How an address left a list it signs up for again. */
type OptedOut = Data.TaggedEnum.Value<SubscriptionState, "OptedOut">;

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
 * Stores the pending sign-up and mails its link, which names the list. The guard's recent allowance
 * is asked first, so a paused account writes nothing. SES refusing the mail after the write blocks
 * a new one for an hour, which ADR-0027 accepts; a submission whose outcome is unknown may have
 * gone out, so it counts as sent.
 */
const requestConfirmation = Effect.fn("Subscriptions.requestConfirmation")(function* (
  payload: Schemas.SubscribePayload,
  shown: { readonly source: string; readonly wording: string },
  confirmPage: string,
) {
  const audience = yield* AudienceStore;
  const guard = yield* SendGuard;
  const mailer = yield* Mailer;
  const list = yield* audience.getList(payload.listId);
  const allowance = yield* guard.recent;

  if (allowance.refusal !== undefined) {
    return yield* new SendingPaused({ reason: allowance.refusal });
  }

  const secret = yield* issueSecret;

  yield* audience.requestSubscription({
    email: payload.email,
    listId: payload.listId,
    name: payload.name,
    attributes: payload.attributes,
    source: shown.source,
    wording: shown.wording,
    ip: payload.ip,
    requestedAt: yield* nowIso,
    secretHash: yield* hashSecret(secret),
  });

  const confirmUrl = confirmationLink(
    confirmPage,
    Schemas.mailboxKey(payload.email),
    payload.listId,
    secret,
  );

  yield* Effect.sleep(yield* guard.slot(allowance.limit));

  yield* mailer.send(payload.email, Mail.Confirmation({ listName: list.name, confirmUrl })).pipe(
    Effect.catchTag("SubmissionUncertain", () => Effect.void),
    Effect.mapError(unavailable(EmailServiceUnavailable, "sendConfirmation")),
  );

  return Schemas.ConfirmationSent.make({});
});

/**
 * A single opt-in (ADR-0037): the subscriber joins at once, with the sign-up as the evidence of its
 * basis, and nothing is mailed. `rejoin`, the opt-out the address left the list by, brings it back
 * (ADR-0045).
 */
const subscribeDirectly = Effect.fn("Subscriptions.subscribeDirectly")(function* (
  payload: Schemas.SubscribePayload,
  rejoin: OptedOut | undefined,
) {
  const audience = yield* AudienceStore;

  yield* audience.subscribeDirectly({
    email: payload.email,
    listId: payload.listId,
    name: payload.name,
    attributes: payload.attributes,
    consent: payload.consent,
    ip: payload.ip,
    contactId: yield* newIdentifier,
    subscribedAt: yield* nowIso,
    rejoin,
  });

  return Schemas.Subscribed.make({ listId: payload.listId });
});

/**
 * A single opt-in for an address that left the list: consent brings it back; an existing customer
 * or account holder stays out, since they objected, and buying again or keeping the account is no
 * new consent.
 */
const rejoin = Effect.fn("Subscriptions.rejoin")(function* (
  payload: Schemas.SubscribePayload,
  optedOut: OptedOut,
) {
  if (payload.consent.basis !== "consent") {
    return yield* new AddressOptedOut({ email: Schemas.mailboxKey(payload.email) });
  }

  return yield* subscribeDirectly(payload, optedOut);
});

/**
 * The address joins as its state with the list allows: `fresh` when it never left, `back` when it
 * did. One already on the list or undeliverable is answered without either.
 */
const join = Effect.fn("Subscriptions.join")(function* <A, E, R, BackA, BackE, BackR>(
  payload: Schemas.SubscribePayload,
  ways: {
    readonly fresh: Effect.Effect<A, E, R>;
    readonly back: (optedOut: OptedOut) => Effect.Effect<BackA, BackE, BackR>;
  },
) {
  const audience = yield* AudienceStore;
  const state = yield* audience.subscriptionState(payload.listId, payload.email);

  return yield* SubscriptionState.$match(state, {
    Undeliverable: ({ reason }) => Effect.fail(new AddressUndeliverable({ reason })),
    Subscribed: () => Effect.succeed(Schemas.AlreadySubscribed.make({})),
    OptedOut: ways.back,
    NotSubscribed: () => ways.fresh,
  });
});

/**
 * A site's sign-up, as its key opts in and on the basis it names (ADR-0045, ADR-0046). A double
 * opt-in key takes consent only, since a confirmation would turn any other basis into consent: it
 * starts the confirmation, and the subscriber joins once they use the mailed link, which also takes
 * them back after they left. A single opt-in key joins them at once, mailing nothing, and brings
 * back an address that left the list on consent only.
 */
export const subscribe = Effect.fn("Subscriptions.subscribe")(function* (
  payload: Schemas.SubscribePayload,
) {
  const integration = yield* Integration;
  const { consent } = payload;

  if (!integration.lists.includes(payload.listId)) {
    return yield* new Forbidden();
  }

  if (OptIn.$is("Double")(integration.optIn)) {
    if (consent.basis !== "consent") {
      return yield* new Forbidden();
    }

    const confirmation = requestConfirmation(payload, consent, integration.optIn.confirmUrl);

    return yield* join(payload, { fresh: confirmation, back: () => confirmation });
  }

  return yield* join(payload, {
    fresh: subscribeDirectly(payload, undefined),
    back: (optedOut) => rejoin(payload, optedOut),
  });
});

/** Each sign-up state as the status read names it. */
const statusOf = {
  Undeliverable: "undeliverable",
  Subscribed: "subscribed",
  OptedOut: "optedOut",
  NotSubscribed: "notSubscribed",
} as const satisfies Record<SubscriptionState["_tag"], Schemas.SubscriptionStatus["status"]>;

/**
 * Where an address stands with one of the key's lists, as a sign-up would find it (ADR-0045): for a
 * signed-in user's own settings, read server to server, never from a public form.
 */
export const status = Effect.fn("Subscriptions.status")(function* (
  payload: Schemas.ListAddressPayload,
) {
  const integration = yield* Integration;
  const audience = yield* AudienceStore;

  if (!integration.lists.includes(payload.listId)) {
    return yield* new Forbidden();
  }

  const state = yield* audience.subscriptionState(payload.listId, payload.email);

  return Schemas.SubscriptionStatus.make({ status: statusOf[state._tag] });
});

/** A confirmation link's token: `<mailbox>.<listId>.<secret>`. */
const decodeConfirmationToken = Schema.decodeUnknownOption(
  Schema.TemplateLiteralParser([
    Schemas.NormalizedEmailAddress,
    ".",
    Schemas.EntityId,
    ".",
    IssuedSecret,
  ]),
);

/**
 * The second half of the double opt-in: the subscriber used the mailed link, so they join the list.
 * A token that does not parse is a link that does not work, like one expired or already used.
 */
export const confirm = Effect.fn("Subscriptions.confirm")(function* (
  payload: Schemas.ConfirmPayload,
) {
  const integration = yield* Integration;
  const audience = yield* AudienceStore;
  const token = decodeConfirmationToken(payload.token);

  if (Option.isNone(token)) {
    return yield* new ConfirmationNotFound();
  }

  const [mailbox, , listId, , secret] = token.value;

  if (!integration.lists.includes(listId)) {
    return yield* new Forbidden();
  }

  yield* audience.confirmSubscription({
    email: mailbox,
    listId,
    secretHash: yield* hashSecret(Redacted.make(secret)),
    contactId: yield* newIdentifier,
    confirmedAt: yield* nowIso,
    confirmIp: payload.ip,
  });

  return Schemas.Subscribed.make({ listId });
});

/**
 * An opt-out from the site's own unsubscribe link (ADR-0037): the same write as the service's
 * signed link, so repeating it changes nothing.
 */
export const optOut = Effect.fn("Subscriptions.optOut")(function* (
  payload: Schemas.ListAddressPayload,
) {
  const integration = yield* Integration;
  const audience = yield* AudienceStore;

  if (!integration.lists.includes(payload.listId)) {
    return yield* new Forbidden();
  }

  yield* audience.optOut({ email: payload.email, listId: payload.listId });
});
