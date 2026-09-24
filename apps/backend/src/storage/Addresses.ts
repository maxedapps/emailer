import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as Schemas from "@emailer/api/Schemas";
import { Clock, Duration, Effect, Schema, Struct } from "effect";

import { corrupt } from "../Errors.ts";
import {
  attributeOf,
  num,
  recordVersion,
  str,
  StoredVersionAttribute,
  tableLogicalId,
  withOptional,
} from "./Items.ts";

import type { BatchPrimitives, TransactionPrimitives, WritePrimitives } from "./Primitives.ts";

const suppressionKey = (email: string) => ({
  pk: str(`SUPPRESSION#${Schemas.mailboxKey(email)}`),
  sk: str("SUPPRESSION"),
});

export const unsubscribeKey = (email: string) => ({
  pk: str(`UNSUBSCRIBE#${Schemas.mailboxKey(email)}`),
  sk: str("UNSUBSCRIBE"),
});

export const transientKey = (email: string) => ({
  pk: str(`SUPPRESSION#${Schemas.mailboxKey(email)}`),
  sk: str("TRANSIENT"),
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

const StoredUnsubscribe = Schema.Struct({
  v: StoredVersionAttribute,
  unsubscribedAt: attributeOf(Schemas.Timestamp),
});

const StoredSuppression = Schema.Struct({
  v: StoredVersionAttribute,
  reason: attributeOf(Schemas.SuppressionReason),
  suppressedAt: attributeOf(Schemas.Timestamp),
  bounceSubType: Schema.optionalKey(attributeOf(Schema.String)),
  complaintFeedbackType: Schema.optionalKey(attributeOf(Schema.String)),
  complaintSubType: Schema.optionalKey(attributeOf(Schema.String)),
});

const StoredTransient = Schema.Struct({
  v: StoredVersionAttribute,
  occurrences: Schema.optionalKey(Schema.Struct({ SS: Schema.Array(Schema.String) })),
});

const decodeStoredUnsubscribe = Schema.decodeUnknownEffect(StoredUnsubscribe);

const decodeStoredSuppression = Schema.decodeUnknownEffect(StoredSuppression);

const decodeStoredTransient = Schema.decodeUnknownEffect(StoredTransient);

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

/**
 * What is known about a mailbox independently of any contact, and outliving one: that the mail
 * system reported it undeliverable, and that its owner opted out. Both are keyed by mailbox rather
 * than by contact, so deleting and re-creating a contact escapes neither. The `EMAIL#` reservation is
 * keyed by address too, but it is contact identity and belongs to `Contacts.ts`.
 */
export const suppressionWrites = (primitives: WritePrimitives) => {
  const { recordOnce } = primitives;

  const suppressAddress = Effect.fn("Storage.suppressAddress")((suppression: AddressSuppression) =>
    recordOnce(
      "suppressAddress",
      withOptional(
        {
          ...suppressionKey(suppression.email),
          v: num(recordVersion),
          email: str(Schemas.mailboxKey(suppression.email)),
          reason: str(suppression.reason),
          messageId: str(suppression.messageId),
          feedbackId: str(suppression.feedbackId),
          suppressedAt: str(suppression.suppressedAt),
        },
        [
          ["bounceSubType", suppression.bounceSubType],
          ["complaintFeedbackType", suppression.complaintFeedbackType],
          ["complaintSubType", suppression.complaintSubType],
        ],
      ),
    ),
  );

  return { suppressAddress } as const;
};

/**
 * The public unsubscribe function's whole persistence need: one conditional write, and so one
 * DynamoDB permission. It is split from the reader and from suppression precisely so the one
 * unauthenticated surface in the system cannot read, update, query or delete anything.
 */
export const unsubscribeWrites = (primitives: WritePrimitives) => {
  const { recordOnce } = primitives;

  const unsubscribeAddress = Effect.fn("Storage.unsubscribeAddress")(
    (unsubscribe: AddressUnsubscribe) =>
      recordOnce("unsubscribeAddress", {
        ...unsubscribeKey(unsubscribe.email),
        v: num(recordVersion),
        email: str(Schemas.mailboxKey(unsubscribe.email)),
        unsubscribedAt: str(unsubscribe.unsubscribedAt),
      }),
  );

  return { unsubscribeAddress } as const;
};

export const addressReads = (primitives: BatchPrimitives) => {
  const { readItems } = primitives;

  const bouncingStatus = (transient: dynamodb.AttributeMap | undefined, operationId: string) =>
    Effect.gen(function* () {
      if (transient === undefined) {
        return "mailable" as const;
      }

      const stored = yield* decodeStoredTransient(transient).pipe(corrupt(operationId));

      const now = yield* Clock.currentTimeMillis;

      const inWindow = (stored.occurrences?.SS ?? []).filter((occurrence) =>
        inTransientWindow(occurrence, now),
      );

      return inWindow.length >= transientWindow.occurrences
        ? ("bouncing" as const)
        : ("mailable" as const);
    });

  /**
   * One mailbox's three rows, told apart by sort key, and the status they give. The status reads an
   * unsubscribe or suppression row by its presence alone: the send path's check never decodes one,
   * so a corrupt row still keeps its recipient from being mailed.
   */
  const loadAddressItems = (operationId: string, email: string) =>
    Effect.gen(function* () {
      const items = yield* readItems(operationId, [
        unsubscribeKey(email),
        suppressionKey(email),
        transientKey(email),
      ]);

      const bySortKey = new Map(items.map((item) => [item.sk?.S, item] as const));
      const unsubscribe = bySortKey.get("UNSUBSCRIBE");
      const suppression = bySortKey.get("SUPPRESSION");
      const transient = bySortKey.get("TRANSIENT");

      const status =
        unsubscribe !== undefined
          ? ("unsubscribed" as const)
          : suppression !== undefined
            ? ("suppressed" as const)
            : yield* bouncingStatus(transient, operationId);

      return { unsubscribe, suppression, transient, status };
    });

  const addressStatus = Effect.fn("Storage.addressStatus")(function* (email: string) {
    return (yield* loadAddressItems("addressStatus", email)).status;
  });

  const addressRecord = Effect.fn("Storage.addressRecord")(function* (email: string) {
    const rows = yield* loadAddressItems("addressRecord", email);

    const unsubscribe =
      rows.unsubscribe === undefined
        ? undefined
        : yield* decodeStoredUnsubscribe(rows.unsubscribe).pipe(corrupt("addressRecord"));

    const suppression =
      rows.suppression === undefined
        ? undefined
        : yield* decodeStoredSuppression(rows.suppression).pipe(corrupt("addressRecord"));

    const transientBounces =
      rows.transient === undefined
        ? []
        : ((yield* decodeStoredTransient(rows.transient).pipe(corrupt("addressRecord"))).occurrences
            ?.SS ?? []);

    const record = { email, status: rows.status, transientBounces, accountSuppression: null };

    const unsubscribed =
      unsubscribe === undefined
        ? record
        : { ...record, unsubscribedAt: unsubscribe.unsubscribedAt };

    return (
      suppression === undefined
        ? unsubscribed
        : { ...unsubscribed, suppression: Struct.omit(suppression, ["v"]) }
    ) satisfies Schemas.AddressRecord;
  });

  return { addressStatus, addressRecord } as const;
};

export const addressWrites = (primitives: TransactionPrimitives) => {
  const { transact } = primitives;

  const unsuppress = Effect.fn("Storage.unsuppress")((email: string) =>
    transact("unsuppress", [
      { Delete: { Table: tableLogicalId, Key: suppressionKey(email) } },
      { Delete: { Table: tableLogicalId, Key: transientKey(email) } },
    ]),
  );

  return { unsuppress } as const;
};
