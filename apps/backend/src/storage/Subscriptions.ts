import { ConfirmationRecentlySent } from "@emailer/api/Errors";
import { Data, DateTime, Duration, Effect } from "effect";

import { itemWriter, str } from "./Items.ts";
import { PendingSubscription, pendingKey, readAddressState, readPending } from "./Addresses.ts";
import { readReservation, reservationKey } from "./Contacts.ts";
import { memberKey } from "./Membership.ts";

import type { ReadPrimitives, StoredItem, WritePrimitives } from "./Primitives.ts";

/** How long a confirmation link works. DynamoDB's TTL removes the pending item after it. */
export const confirmationLifetime = Duration.days(7);

/** At most one confirmation mail per address and list within this window. */
const resendInterval = Duration.hours(1);

/** Where an address stands with a list, as a sign-up sees it. */
export type SubscriptionState = Data.TaggedEnum<{
  /** The mailbox refuses mail: suppressed or bouncing, until the operator unsuppresses it. */
  Undeliverable: { readonly reason: "suppressed" | "bouncing" };
  /** A member of the list who has not left it. */
  Subscribed: {};
  NotSubscribed: {};
}>;

export const SubscriptionState = Data.taggedEnum<SubscriptionState>();

/** A pending sign-up as requested, before storage gives it its expiry. */
export type SubscriptionRequest = Omit<PendingSubscription, "ttl">;

const writePending = itemWriter(PendingSubscription);

const plus = (timestamp: string, duration: Duration.Duration): DateTime.Utc =>
  DateTime.addDuration(DateTime.makeUnsafe(timestamp), duration);

export const subscriptionOperations = (primitives: ReadPrimitives & WritePrimitives) => {
  const { readItem, putIf } = primitives;

  /**
   * The address item and the reservation are read together; the membership only if a contact holds
   * the address. An address that left the list is not subscribed to it, whatever its membership.
   */
  const subscriptionState = Effect.fn("Storage.subscriptionState")(function* (
    listId: string,
    email: string,
  ) {
    const [address, reservation] = yield* Effect.all(
      [
        readAddressState(primitives, "subscriptionState", email),
        readItem("subscriptionState", reservationKey(email)),
      ],
      { concurrency: 2 },
    );

    if (address.mailbox !== "mailable") {
      return SubscriptionState.Undeliverable({ reason: address.mailbox });
    }

    if (reservation.Item === undefined || address.optOuts.includes(listId)) {
      return SubscriptionState.NotSubscribed();
    }

    const { contactId } = yield* readReservation("subscriptionState", reservation.Item);
    const member = yield* readItem("subscriptionState", memberKey(listId, contactId));

    return member.Item === undefined
      ? SubscriptionState.NotSubscribed()
      : SubscriptionState.Subscribed();
  });

  /**
   * Stores the pending sign-up, replacing an older one and its link, unless one was requested
   * within the hour. The same request landing twice carries the same secret's hash, so it is not
   * refused by its own first landing.
   */
  const requestSubscription = Effect.fn("Storage.requestSubscription")(function* (
    request: SubscriptionRequest,
  ) {
    const expiresAt = plus(request.requestedAt, confirmationLifetime);

    const hourAgo = DateTime.subtractDuration(
      DateTime.makeUnsafe(request.requestedAt),
      resendInterval,
    );

    const refused = (current: StoredItem) =>
      Effect.flatMap(readPending("requestSubscription", current), (stored) =>
        Effect.fail(
          new ConfirmationRecentlySent({
            retryAfter: DateTime.formatIso(plus(stored.requestedAt, resendInterval)),
          }),
        ),
      );

    yield* putIf(
      "requestSubscription",
      {
        Item: {
          ...pendingKey(request.email, request.listId),
          ...(yield* writePending({
            ...request,
            ttl: Math.floor(DateTime.toEpochMillis(expiresAt) / 1000),
          })),
        },
        ConditionExpression:
          "attribute_not_exists(pk) OR requestedAt < :hourAgo OR secretHash = :secretHash",
        ExpressionAttributeValues: {
          ":hourAgo": str(DateTime.formatIso(hourAgo)),
          ":secretHash": str(request.secretHash),
        },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
      refused,
    );
  });

  return { subscriptionState, requestSubscription } as const;
};
