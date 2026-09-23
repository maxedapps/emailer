import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as Schemas from "@emailer/api/Schemas";
import { Clock, Duration, Effect, Schema } from "effect";

import { corrupt, unavailable } from "./Errors.ts";
import {
  attributeOf,
  num,
  recordVersion,
  str,
  StoredVersionAttribute,
  tableLogicalId,
  withOptional,
} from "./Items.ts";

import type { FeedbackKind } from "./Feedback.ts";
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
  readonly reason: FeedbackKind;
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

export type AddressStatus = "mailable" | "unsubscribed" | "suppressed" | "bouncing";

interface LocalSuppression {
  reason: "bounce" | "complaint";
  suppressedAt: string;
  bounceSubType?: string;
  complaintFeedbackType?: string;
  complaintSubType?: string;
}

interface LocalAddressRecord {
  email: string;
  status: AddressStatus;
  unsubscribedAt?: string;
  suppression?: LocalSuppression;
  transientBounces: ReadonlyArray<string>;
  accountSuppression: null;
}

const StoredUnsubscribe = Schema.Struct({
  v: StoredVersionAttribute,
  unsubscribedAt: attributeOf(Schemas.Timestamp),
});

const StoredSuppression = Schema.Struct({
  v: StoredVersionAttribute,
  reason: attributeOf(Schema.Literals(["bounce", "complaint"])),
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

const attributeString = (value: dynamodb.AttributeValue | undefined): string | undefined =>
  value !== undefined && "S" in value ? value.S : undefined;

const hasKey = (
  item: dynamodb.AttributeMap,
  key: { readonly pk: { readonly S: string }; readonly sk: { readonly S: string } },
) => attributeString(item["pk"]) === key.pk.S && attributeString(item["sk"]) === key.sk.S;

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

  const loadAddressItems = (operationId: string, email: string) =>
    Effect.gen(function* () {
      const items = yield* readItems(operationId, [
        unsubscribeKey(email),
        suppressionKey(email),
        transientKey(email),
      ]);

      return {
        unsubscribe: items.find((item) => hasKey(item, unsubscribeKey(email))),
        suppression: items.find((item) => hasKey(item, suppressionKey(email))),
        transient: items.find((item) => hasKey(item, transientKey(email))),
      };
    });

  const bouncingStatus = (transient: dynamodb.AttributeMap | undefined, operationId: string) =>
    Effect.gen(function* () {
      if (transient === undefined) {
        return "mailable" as const;
      }

      const stored = yield* decodeStoredTransient(transient).pipe(
        Effect.mapError(corrupt(operationId)),
      );

      const now = yield* Clock.currentTimeMillis;

      const inWindow = (stored.occurrences?.SS ?? []).filter((occurrence) =>
        inTransientWindow(occurrence, now),
      );

      return inWindow.length >= transientWindow.occurrences
        ? ("bouncing" as const)
        : ("mailable" as const);
    });

  const addressStatus = Effect.fn("Storage.addressStatus")(function* (email: string) {
    const rows = yield* loadAddressItems("addressStatus", email);

    if (rows.unsubscribe !== undefined) {
      return "unsubscribed" as const;
    }

    if (rows.suppression !== undefined) {
      return "suppressed" as const;
    }

    return yield* bouncingStatus(rows.transient, "addressStatus");
  });

  const addressRecord = Effect.fn("Storage.addressRecord")(function* (email: string) {
    const rows = yield* loadAddressItems("addressRecord", email);

    const status: AddressStatus =
      rows.unsubscribe !== undefined
        ? "unsubscribed"
        : rows.suppression !== undefined
          ? "suppressed"
          : yield* bouncingStatus(rows.transient, "addressRecord");

    const unsubscribedAt =
      rows.unsubscribe === undefined
        ? undefined
        : (yield* decodeStoredUnsubscribe(rows.unsubscribe).pipe(
            Effect.mapError(corrupt("addressRecord")),
          )).unsubscribedAt;

    const suppression =
      rows.suppression === undefined
        ? undefined
        : yield* decodeStoredSuppression(rows.suppression).pipe(
            Effect.mapError(corrupt("addressRecord")),
          );

    const transientBounces =
      rows.transient === undefined
        ? []
        : ((yield* decodeStoredTransient(rows.transient).pipe(
            Effect.mapError(corrupt("addressRecord")),
          )).occurrences?.SS ?? []);

    const record: LocalAddressRecord = {
      email,
      status,
      transientBounces,
      accountSuppression: null,
    };

    if (unsubscribedAt !== undefined) {
      record.unsubscribedAt = unsubscribedAt;
    }

    if (suppression !== undefined) {
      const row: LocalSuppression = {
        reason: suppression.reason,
        suppressedAt: suppression.suppressedAt,
      };

      if (suppression.bounceSubType !== undefined) {
        row.bounceSubType = suppression.bounceSubType;
      }

      if (suppression.complaintFeedbackType !== undefined) {
        row.complaintFeedbackType = suppression.complaintFeedbackType;
      }

      if (suppression.complaintSubType !== undefined) {
        row.complaintSubType = suppression.complaintSubType;
      }

      record.suppression = row;
    }

    return record satisfies Schemas.AddressRecord;
  });

  return { addressStatus, addressRecord } as const;
};

export const addressWrites = (primitives: TransactionPrimitives) => {
  const { runTransaction } = primitives;

  const unsuppress = Effect.fn("Storage.unsuppress")(function* (email: string) {
    const outcome = yield* runTransaction("unsuppress", {
      TransactItems: [
        { Delete: { Table: tableLogicalId, Key: suppressionKey(email) } },
        { Delete: { Table: tableLogicalId, Key: transientKey(email) } },
      ],
    });

    if (!outcome.committed) {
      return yield* unavailable("unsuppress")(outcome);
    }
  });

  return { unsuppress } as const;
};
