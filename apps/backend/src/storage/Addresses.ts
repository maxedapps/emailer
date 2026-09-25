import * as Schemas from "@emailer/api/Schemas";
import { Clock, Data, Duration, Effect, Predicate, Record, Schema } from "effect";

import { itemReader, num, recordVersion, str, strMap } from "./Items.ts";

import type { ReadPrimitives, UpdatePrimitives } from "./Primitives.ts";

/**
 * What is known about a mailbox independently of any contact, and outliving one: that its owner
 * opted out, that the mail system reported it undeliverable, and its recent transient bounces. One
 * item holds all three, so the status before each send is one read. It is keyed by mailbox rather
 * than by contact, so deleting and re-creating a contact escapes none of it. The `EMAIL#`
 * reservation is keyed by address too, but it is contact identity and belongs to `Contacts.ts`.
 */
export const addressKey = (email: string) => ({
  pk: str(`ADDRESS#${Schemas.mailboxKey(email)}`),
  sk: str("ADDRESS"),
});

/**
 * Whichever write creates the item, it stamps the version and the mailbox: each write is an update
 * that may be the item's first.
 */
export const stamped = (email: string) => ({
  expression: "v = if_not_exists(v, :v), email = if_not_exists(email, :email)",
  values: { ":v": num(recordVersion), ":email": str(Schemas.mailboxKey(email)) },
});

const transientWindow = { occurrences: 3, days: 30 } as const;

export interface AddressSuppression {
  readonly email: string;
  readonly reason: Schemas.SuppressionReason;
  readonly messageId: string;
  readonly feedbackId: string;
  readonly bounceSubType?: string | undefined;
  readonly complaintFeedbackType?: string | undefined;
  readonly complaintSubType?: string | undefined;
  readonly suppressedAt: string;
}

export interface AddressUnsubscribe {
  readonly email: string;
  readonly unsubscribedAt: string;
}

/**
 * The status reads an opt-out or a suppression by its presence alone, so one that is malformed
 * still keeps its recipient from being mailed; only the transient window is decoded.
 */
const readStatus = itemReader(
  Schema.Struct({
    unsubscribedAt: Schema.optionalKey(Schema.Unknown),
    suppression: Schema.optionalKey(Schema.Unknown),
    transientBounces: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

/** The whole item, as `addresses status` reports it. */
const readRecord = itemReader(
  Schema.Struct({
    unsubscribedAt: Schemas.AddressRecord.fields.unsubscribedAt,
    suppression: Schemas.AddressRecord.fields.suppression,
    transientBounces: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

const inTransientWindow = (occurrence: string, now: number): boolean => {
  const separator = occurrence.indexOf("#");

  if (separator <= 0) {
    return false;
  }

  const timestamp = Date.parse(occurrence.slice(0, separator));

  return (
    Number.isFinite(timestamp) &&
    now - timestamp <= Duration.toMillis(Duration.days(transientWindow.days))
  );
};

const statusOf = (
  stored: {
    readonly unsubscribedAt?: unknown;
    readonly suppression?: unknown;
    readonly transientBounces?: ReadonlyArray<string>;
  },
  now: number,
): Schemas.AddressStatus => {
  if (stored.unsubscribedAt !== undefined) {
    return "unsubscribed";
  }

  if (stored.suppression !== undefined) {
    return "suppressed";
  }

  const inWindow = (stored.transientBounces ?? []).filter((occurrence) =>
    inTransientWindow(occurrence, now),
  );

  return inWindow.length >= transientWindow.occurrences ? "bouncing" : "mailable";
};

/** The suppression's fields as a string map, leaving out those the event did not carry. */
const suppressionMap = (suppression: AddressSuppression) =>
  strMap(
    Record.filter(
      {
        reason: suppression.reason,
        messageId: suppression.messageId,
        feedbackId: suppression.feedbackId,
        suppressedAt: suppression.suppressedAt,
        bounceSubType: suppression.bounceSubType,
        complaintFeedbackType: suppression.complaintFeedbackType,
        complaintSubType: suppression.complaintSubType,
      },
      Predicate.isNotUndefined,
    ),
  );

/** The first suppression stands: a later event for the same mailbox changes nothing. */
export const suppressionWrites = (primitives: Pick<UpdatePrimitives, "update">) => {
  const { update } = primitives;

  const suppressAddress = Effect.fn("Storage.suppressAddress")((
    suppression: AddressSuppression,
  ) => {
    const stamp = stamped(suppression.email);

    return update("suppressAddress", {
      Key: addressKey(suppression.email),
      UpdateExpression: `SET ${stamp.expression}, suppression = if_not_exists(suppression, :s)`,
      ExpressionAttributeValues: { ...stamp.values, ":s": suppressionMap(suppression) },
    });
  });

  return { suppressAddress } as const;
};

/**
 * The public unsubscribe function's whole persistence need: one update that records the first
 * opt-out and keeps it, and so one DynamoDB permission. It is split from the reader and from
 * suppression precisely so the one unauthenticated surface in the system cannot read, query or
 * delete anything.
 */
export const unsubscribeWrites = (primitives: Pick<UpdatePrimitives, "update">) => {
  const { update } = primitives;

  const unsubscribeAddress = Effect.fn("Storage.unsubscribeAddress")((
    unsubscribe: AddressUnsubscribe,
  ) => {
    const stamp = stamped(unsubscribe.email);

    return update("unsubscribeAddress", {
      Key: addressKey(unsubscribe.email),
      UpdateExpression: `SET ${stamp.expression}, unsubscribedAt = if_not_exists(unsubscribedAt, :at)`,
      ExpressionAttributeValues: { ...stamp.values, ":at": str(unsubscribe.unsubscribedAt) },
    });
  });

  return { unsubscribeAddress } as const;
};

export const addressReads = (primitives: ReadPrimitives) => {
  const { readItem } = primitives;

  /** One strongly consistent read; a mailbox nothing was ever recorded for is mailable. */
  const addressStatus = Effect.fn("Storage.addressStatus")(function* (email: string) {
    const { Item } = yield* readItem("addressStatus", addressKey(email));

    if (Item === undefined) {
      return "mailable" as const;
    }

    return statusOf(yield* readStatus("addressStatus", Item), yield* Clock.currentTimeMillis);
  });

  const addressRecord = Effect.fn("Storage.addressRecord")(function* (email: string) {
    const { Item } = yield* readItem("addressRecord", addressKey(email));

    const stored =
      Item === undefined ? { transientBounces: [] } : yield* readRecord("addressRecord", Item);

    const record = {
      email,
      status: statusOf(stored, yield* Clock.currentTimeMillis),
      transientBounces: stored.transientBounces ?? [],
      accountSuppression: null,
    };

    const unsubscribed =
      stored.unsubscribedAt === undefined
        ? record
        : { ...record, unsubscribedAt: stored.unsubscribedAt };

    return (
      stored.suppression === undefined
        ? unsubscribed
        : { ...unsubscribed, suppression: stored.suppression }
    ) satisfies Schemas.AddressRecord;
  });

  return { addressStatus, addressRecord } as const;
};

/** No address item: there is nothing to clear. */
class NothingStored extends Data.TaggedError("NothingStored") {}

export const addressWrites = (primitives: Pick<UpdatePrimitives, "updateIf">) => {
  const { updateIf } = primitives;

  /**
   * Clears the suppression and the transient window. An opt-out stays: it is the recipient's
   * decision, not a delivery fault. Conditioned on the item existing, so a mailbox with nothing
   * recorded does not gain an empty item.
   */
  const unsuppress = Effect.fn("Storage.unsuppress")((email: string) =>
    updateIf(
      "unsuppress",
      {
        Key: addressKey(email),
        UpdateExpression: "REMOVE suppression, transientBounces",
        ConditionExpression: "attribute_exists(pk)",
      },
      () => new NothingStored(),
    ).pipe(
      Effect.asVoid,
      Effect.catchTag("NothingStored", () => Effect.void),
    ),
  );

  return { unsuppress } as const;
};
