import {
  ConfirmationNotFound,
  ConfirmationRecentlySent,
  ContactChanged,
  ListNotFound,
} from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Data, DateTime, Duration, Effect } from "effect";

import { itemWriter, str, strSet, tableLogicalId } from "./Items.ts";
import {
  PendingSubscription,
  addressKey,
  consentKey,
  pendingKey,
  readAddressState,
  readPending,
  writeConsent,
} from "./Addresses.ts";
import {
  contactOf,
  readHolders,
  readReservation,
  reservationKey,
  retryLostRace,
} from "./Contacts.ts";
import { listKey } from "./Lists.ts";
import { joinActions, memberKey } from "./Membership.ts";

import type {
  Action,
  BatchPrimitives,
  ReadPrimitives,
  StoredItem,
  TransactionPrimitives,
  WritePrimitives,
} from "./Primitives.ts";

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
  /** The address left the list, whether or not its contact is still a member. */
  OptedOut: {};
  NotSubscribed: {};
}>;

export const SubscriptionState = Data.taggedEnum<SubscriptionState>();

/** A pending sign-up as requested, before storage gives it its expiry. */
export type SubscriptionRequest = Omit<PendingSubscription, "ttl">;

/**
 * A single opt-in sign-up (ADR-0037): whom to add and how, the consent evidence, and the identifier
 * a new contact would take.
 */
export type DirectSubscription = Omit<SubscriptionRequest, "requestedAt" | "secretHash"> & {
  readonly contactId: string;
  readonly subscribedAt: string;
};

/** A confirmation link used, and the identifier a new contact would take. */
export interface SubscriptionConfirmation {
  readonly email: string;
  readonly listId: string;
  readonly secretHash: string;
  readonly contactId: string;
  readonly confirmedAt: string;
  readonly confirmIp: string;
}

const writePending = itemWriter(PendingSubscription);

const plus = (timestamp: string, duration: Duration.Duration): DateTime.Utc =>
  DateTime.addDuration(DateTime.makeUnsafe(timestamp), duration);

export const subscriptionOperations = (
  primitives: ReadPrimitives & WritePrimitives & BatchPrimitives & TransactionPrimitives,
) => {
  const { readItem, putIf, transact } = primitives;

  /**
   * The address item and the reservation are read together; the membership only if a contact holds
   * the address. An address that left the list is opted out of it, whatever its membership.
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

    if (address.optOuts.includes(listId)) {
      return SubscriptionState.OptedOut();
    }

    if (reservation.Item === undefined) {
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

  /**
   * Joining as an import would, plus the consent record: the steps every opt-in writes, whichever
   * way it came. The candidate is made at the moment of joining, so its `createdAt` dates the
   * membership and keys the consent record. That record is append-only: two sign-ups joining in the
   * same millisecond would share its key, so the later one is refused as a lost race
   * (`ContactChanged`) rather than replacing the earlier evidence; sent again, it finds the address
   * subscribed.
   */
  const consentedJoin = Effect.fnUntraced(function* (
    candidate: Schemas.Contact,
    holders: ReadonlyMap<string, string>,
    consent: Schemas.ConsentRecord,
  ) {
    const joined = yield* joinActions(consent.listId, [candidate], holders, candidate.createdAt);

    return [
      ...joined.actions,
      {
        Put: {
          Table: tableLogicalId,
          Item: {
            ...consentKey(candidate.email, consent.listId, candidate.createdAt),
            ...(yield* writeConsent(consent)),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
        refused: () => new ContactChanged(),
      },
    ] satisfies ReadonlyArray<Action<ContactChanged>>;
  });

  /**
   * A single opt-in: joins the list and records the consent in one transaction, with no link to
   * confirm. It never lifts an opt-out; the caller refuses an address that left the list.
   */
  const subscribeDirectly = Effect.fn("Storage.subscribeDirectly")(function* (
    subscription: DirectSubscription,
  ) {
    const { email, listId, subscribedAt } = subscription;

    const [list, holders] = yield* Effect.all(
      [
        readItem("subscribeDirectly", listKey(listId)),
        readHolders(primitives, "subscribeDirectly", [email]),
      ],
      { concurrency: 2 },
    );

    if (list.Item === undefined) {
      return yield* new ListNotFound();
    }

    const candidate = contactOf(
      subscription.contactId,
      email,
      subscription.name,
      subscription.attributes,
      subscribedAt,
    );

    return yield* transact(
      "subscribeDirectly",
      yield* consentedJoin(candidate, holders, {
        listId,
        source: subscription.source,
        wording: subscription.wording,
        ip: subscription.ip,
        subscribedAt,
      }),
    );
  }, retryLostRace);

  /**
   * Joins the pending subscriber to the list as an import would, records the consent, consumes the
   * link and lifts the list's opt-out, in one transaction.
   *
   * The pending item is deleted first, conditioned on the secret: a link used twice, even at once,
   * joins once, and the second use answers `ConfirmationNotFound`, which is not retried. An expired
   * item still in the table (TTL deletes lazily) is refused like a missing one.
   */
  const confirmSubscription = Effect.fn("Storage.confirmSubscription")(function* (
    confirmation: SubscriptionConfirmation,
  ) {
    const { email, listId, secretHash, confirmedAt } = confirmation;

    const [pending, list, address, holders] = yield* Effect.all(
      [
        readItem("confirmSubscription", pendingKey(email, listId)),
        readItem("confirmSubscription", listKey(listId)),
        readAddressState(primitives, "confirmSubscription", email),
        readHolders(primitives, "confirmSubscription", [email]),
      ],
      { concurrency: 4 },
    );

    if (pending.Item === undefined) {
      return yield* new ConfirmationNotFound();
    }

    const stored = yield* readPending("confirmSubscription", pending.Item);

    if (
      stored.secretHash !== secretHash ||
      stored.ttl * 1000 <= DateTime.toEpochMillis(DateTime.makeUnsafe(confirmedAt))
    ) {
      return yield* new ConfirmationNotFound();
    }

    if (list.Item === undefined) {
      return yield* new ListNotFound();
    }

    const candidate = contactOf(
      confirmation.contactId,
      stored.email,
      stored.name,
      stored.attributes,
      confirmedAt,
    );

    const liftOptOut: Array<Action<never>> = address.optOuts.includes(listId)
      ? [
          {
            Update: {
              Table: tableLogicalId,
              Key: addressKey(email),
              UpdateExpression: "DELETE optOuts :list",
              ExpressionAttributeValues: { ":list": strSet([listId]) },
            },
          },
        ]
      : [];

    const actions: ReadonlyArray<Action<ConfirmationNotFound | ContactChanged>> = [
      {
        Delete: {
          Table: tableLogicalId,
          Key: pendingKey(email, listId),
          ConditionExpression: "secretHash = :secretHash",
          ExpressionAttributeValues: { ":secretHash": str(secretHash) },
        },
        refused: () => new ConfirmationNotFound(),
      },
      ...(yield* consentedJoin(candidate, holders, {
        listId,
        source: stored.source,
        wording: stored.wording,
        ip: stored.ip,
        requestedAt: stored.requestedAt,
        confirmedAt,
        confirmIp: confirmation.confirmIp,
      })),
      ...liftOptOut,
    ];

    yield* transact("confirmSubscription", actions);

    return listId;
  }, retryLostRace);

  return {
    subscriptionState,
    requestSubscription,
    subscribeDirectly,
    confirmSubscription,
  } as const;
};
