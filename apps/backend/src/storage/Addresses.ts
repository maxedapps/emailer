import * as Schemas from "@emailer/api/Schemas";
import { Data, DateTime, Effect, Option, Predicate, Record, Schema } from "effect";

import { itemReader, num, recordVersion, str, strMap, strSet } from "./Items.ts";

import type { QueryPrimitives, ReadPrimitives, UpdatePrimitives } from "./Primitives.ts";

/**
 * What is known about a mailbox independently of any contact, and outliving one: the lists its
 * owner opted out of, that the mail system reported it undeliverable, and its recent transient
 * bounces. One item holds all three, so the status before each send is one read. It is keyed by
 * mailbox rather than by contact, so deleting and re-creating a contact escapes none of it. The
 * `EMAIL#` reservation is keyed by address too, but it is contact identity and belongs to
 * `Contacts.ts`.
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

/** An opt-out from one list. */
export interface AddressOptOut {
  readonly email: string;
  readonly listId: string;
}

/**
 * The status reads a suppression by its presence alone, so one that is malformed still keeps its
 * recipient from being mailed; the opt-outs and the transient window are decoded.
 */
const readStatus = itemReader(
  Schema.Struct({
    optOuts: Schema.optionalKey(Schema.Array(Schema.String)),
    suppression: Schema.optionalKey(Schema.Unknown),
    transientBounces: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

/** The whole item, as `addresses status` reports it. */
const readRecord = itemReader(
  Schema.Struct({
    optOuts: Schema.optionalKey(Schemas.AddressRecord.fields.optOuts),
    suppression: Schemas.AddressRecord.fields.suppression,
    transientBounces: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

/** An occurrence is `<receivedAt>#<feedbackId>`; one that does not parse is outside the window. */
const occurredSince = (occurrence: string, windowStart: DateTime.Utc): boolean => {
  const separator = occurrence.indexOf("#");

  return (
    separator > 0 &&
    Option.exists(DateTime.make(occurrence.slice(0, separator)), (receivedAt) =>
      DateTime.isGreaterThanOrEqualTo(receivedAt, windowStart),
    )
  );
};

/** Whether the mailbox takes mail at all, whichever list it is sent from. */
const mailboxStatusOf = (
  stored: { readonly suppression?: unknown; readonly transientBounces?: ReadonlyArray<string> },
  now: DateTime.Utc,
): Schemas.MailboxStatus => {
  if (stored.suppression !== undefined) {
    return "suppressed";
  }

  const windowStart = DateTime.subtract(now, { days: transientWindow.days });

  const inWindow = (stored.transientBounces ?? []).filter((occurrence) =>
    occurredSince(occurrence, windowStart),
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
 * The public unsubscribe function's whole persistence need: one update that adds the list to the
 * mailbox's opt-outs, and so one DynamoDB permission. It is split from the reader and from
 * suppression precisely so the one unauthenticated surface in the system cannot read, query or
 * delete anything.
 */
export const unsubscribeWrites = (primitives: Pick<UpdatePrimitives, "update">) => {
  const { update } = primitives;

  /** Adding to a set is idempotent, so a repeated opt-out changes nothing. */
  const optOut = Effect.fn("Storage.optOut")((request: AddressOptOut) => {
    const stamp = stamped(request.email);

    return update("optOut", {
      Key: addressKey(request.email),
      UpdateExpression: `SET ${stamp.expression} ADD optOuts :list`,
      ExpressionAttributeValues: { ...stamp.values, ":list": strSet([request.listId]) },
    });
  });

  return { optOut } as const;
};

export const addressReads = (primitives: ReadPrimitives & QueryPrimitives) => {
  const { readItem, runQuery } = primitives;

  /**
   * One strongly consistent read. An opt-out from this list is the human's decision and answers
   * ahead of the mail system's reports; a mailbox nothing was ever recorded for is mailable.
   */
  const addressStatus = Effect.fn("Storage.addressStatus")(function* (
    email: string,
    listId: string,
  ) {
    const { Item } = yield* readItem("addressStatus", addressKey(email));

    if (Item === undefined) {
      return "mailable" as const;
    }

    const stored = yield* readStatus("addressStatus", Item);

    return stored.optOuts?.includes(listId) === true
      ? ("unsubscribed" as const)
      : mailboxStatusOf(stored, yield* DateTime.now);
  });

  /** The address's whole partition in one strongly consistent query, which holds its item. */
  const addressRecord = Effect.fn("Storage.addressRecord")(function* (email: string) {
    const { pk, sk } = addressKey(email);

    const partition = yield* runQuery("addressRecord", "base-table", {
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    });

    const item = partition.Items?.find((entry) => entry.sk?.S === sk.S);

    const stored =
      item === undefined ? { transientBounces: [] } : yield* readRecord("addressRecord", item);

    const record = {
      email,
      status: mailboxStatusOf(stored, yield* DateTime.now),
      optOuts: stored.optOuts ?? [],
      transientBounces: stored.transientBounces ?? [],
      accountSuppression: null,
    };

    return (
      stored.suppression === undefined ? record : { ...record, suppression: stored.suppression }
    ) satisfies Schemas.AddressRecord;
  });

  return { addressStatus, addressRecord } as const;
};

/** No address item: there is nothing to clear. */
class NothingStored extends Data.TaggedError("NothingStored") {}

export const addressWrites = (primitives: Pick<UpdatePrimitives, "updateIf">) => {
  const { updateIf } = primitives;

  /**
   * Clears the suppression and the transient window. Opt-outs stay: they are the recipient's
   * decisions, not delivery faults. Conditioned on the item existing, so a mailbox with nothing
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
