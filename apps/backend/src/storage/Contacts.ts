import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Schema, SchemaTransformation, Struct } from "effect";

import { corrupt, unavailable } from "./Errors.ts";
import { unsubscribeKey } from "./Addresses.ts";
import {
  attributeOf,
  listingAttributes,
  num,
  recordVersion,
  str,
  StoredVersionAttribute,
  StringMapAttribute,
  strMap,
  tableLogicalId,
} from "./Items.ts";

import type {
  PagePrimitives,
  ReadPrimitives,
  StoredPage,
  TransactionPrimitives,
  TransactionRequest,
} from "./Primitives.ts";

const contactKind = "contact";

export const contactKey = (contactId: string) => ({
  pk: str(`CONTACT#${contactId}`),
  sk: str("META"),
});

/**
 * The uniqueness reservation. It is part of contact identity rather than a domain of its own: it is
 * written with the contact in one transaction, moved with it on an address change, and removed with
 * it on delete — and it doubles as lookup-by-address at no extra cost.
 */
export const reservationKey = (email: string) => ({
  pk: str(`EMAIL#${Schemas.mailboxKey(email)}`),
  sk: str("META"),
});

/**
 * The stored item, wire kinds and domain rules together. `optionalKey` rather than `optional`: an
 * attribute DynamoDB never wrote is absent from the map, and an attribute present but of the wrong
 * kind is a decoding failure rather than an absence. Key and index attributes travel on the same
 * item and are ignored here.
 */
const StoredContact = Schema.Struct({
  v: StoredVersionAttribute,
  id: attributeOf(Schemas.EntityId),
  email: attributeOf(Schemas.NormalizedEmailAddress),
  name: Schema.optionalKey(attributeOf(Schemas.EntityName)),
  attributes: Schema.optionalKey(
    StringMapAttribute.pipe(
      Schema.decodeTo(Schemas.ContactAttributes, SchemaTransformation.passthrough()),
    ),
  ),
  createdAt: attributeOf(Schemas.Timestamp),
});

/** Decodes a stored contact item. Membership hydrates contacts too, so this is shared. */
export const decodeContactItem = Schema.decodeUnknownEffect(StoredContact);

const StoredReservation = Schema.Struct({ contactId: attributeOf(Schemas.EntityId) });

const decodeReservation = Schema.decodeUnknownEffect(StoredReservation);

/** Builds a contact with its absent fields omitted rather than set to `undefined`. */
export const contactOf = (
  id: string,
  email: string,
  name: string | undefined,
  attributes: Schemas.ContactAttributes | undefined,
  createdAt: string,
): Schemas.Contact => {
  const identified = { id, email, createdAt };
  const named = name === undefined ? identified : { ...identified, name };

  return attributes === undefined ? named : { ...named, attributes };
};

export const contactItem = (contact: Schemas.Contact): dynamodb.AttributeMap => {
  const item: dynamodb.AttributeMap = {
    ...contactKey(contact.id),
    ...listingAttributes(contactKind, contact.createdAt, contact.id),
    v: num(recordVersion),
    id: str(contact.id),
    email: str(contact.email),
    createdAt: str(contact.createdAt),
  };

  const named = contact.name === undefined ? item : { ...item, name: str(contact.name) };

  return contact.attributes === undefined
    ? named
    : { ...named, attributes: strMap(contact.attributes) };
};

export const reservationItem = (email: string, contactId: string): dynamodb.AttributeMap => ({
  ...reservationKey(email),
  v: num(recordVersion),
  contactId: str(contactId),
});

export const contactOperations = (
  primitives: ReadPrimitives & PagePrimitives & TransactionPrimitives,
) => {
  const { readEntityPage, readItem, runTransaction } = primitives;

  /**
   * Slot 0 is the contact, slot 1 its address reservation. A slot-1 condition failure is the
   * ordinary answer `EmailAlreadyUsed`; a slot-0 failure means the generated identifier already
   * exists, which is an anomaly rather than an answer and stays a storage failure.
   */
  const createContact = Effect.fn("Storage.createContact")(function* (contact: Schemas.Contact) {
    const outcome = yield* runTransaction("createContact", {
      TransactItems: [
        {
          Put: {
            Table: tableLogicalId,
            Item: contactItem(contact),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            Table: tableLogicalId,
            Item: reservationItem(contact.email, contact.id),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    });

    if (outcome.committed) {
      return;
    }

    if (outcome.conditionFailures.has(1)) {
      return yield* new Schemas.EmailAlreadyUsed({ email: contact.email });
    }

    return yield* unavailable("createContact")(outcome.conditionFailures);
  });

  const readContact = (operationId: string, item: dynamodb.AttributeMap) =>
    decodeContactItem(item).pipe(
      Effect.mapError(corrupt(operationId)),
      Effect.map((stored): Schemas.Contact => Struct.omit(stored, ["v"])),
    );

  const getContact = Effect.fn("Storage.getContact")(function* (contactId: string) {
    const response = yield* readItem("getContact", contactKey(contactId));

    if (response.Item === undefined) {
      return yield* new Schemas.NotFound({ entity: "contact" });
    }

    return yield* readContact("getContact", response.Item);
  });

  const listContacts = Effect.fn("Storage.listContacts")(function* (
    limit: number,
    cursor: string | undefined,
  ) {
    const page = yield* readEntityPage("listContacts", contactKind, contactKey, limit, cursor);
    const contacts = yield* Effect.forEach(page.items, (item) => readContact("listContacts", item));

    return { ...page, items: contacts } satisfies StoredPage<Schemas.Contact, string>;
  });

  const getContactByEmail = Effect.fn("Storage.getContactByEmail")(function* (email: string) {
    const reservation = yield* readItem("getContactByEmail", reservationKey(email));

    if (reservation.Item === undefined) {
      return yield* new Schemas.NotFound({ entity: "contact" });
    }

    const reserved = yield* decodeReservation(reservation.Item).pipe(
      Effect.mapError(corrupt("getContactByEmail")),
    );

    const found = yield* getContact(reserved.contactId);

    // Every path that writes a reservation writes the contact in the same transaction, so the two
    // cannot disagree. If they ever did, answering "no contact has this address" is honest, where
    // returning a contact under an address it does not hold would not be.
    if (Schemas.mailboxKey(found.email) !== Schemas.mailboxKey(email)) {
      return yield* new Schemas.NotFound({ entity: "contact" });
    }

    return found;
  });

  /**
   * The change is merged into the contact just read and the whole item is written, so a cleared
   * field is simply absent and an attribute map is replaced, never merged. `id` and `createdAt`
   * are written back as read, so `gsi1sk` is unchanged and the contact keeps its place in created
   * order. Two concurrent edits of different fields end last-writer-wins, as draft edits do.
   */
  const updateContact = Effect.fn("Storage.updateContact")(function* (
    contactId: string,
    update: Schemas.UpdateContactPayload,
  ) {
    const current = yield* getContact(contactId);
    const email = update.email ?? current.email;
    const name = update.name === undefined ? current.name : (update.name ?? undefined);

    const attributes =
      update.attributes === undefined ? current.attributes : (update.attributes ?? undefined);

    const next = contactOf(current.id, email, name, attributes, current.createdAt);

    // Old and new addresses sharing a mailbox key means one reservation item, which a transaction
    // may not both delete and put. Only the stored spelling changes, so there is no reservation to
    // move — and the contact stays on the same mailbox, so there is no opt-out to check.
    const move: TransactionRequest["TransactItems"] =
      Schemas.mailboxKey(email) === Schemas.mailboxKey(current.email)
        ? []
        : [
            {
              // The address being left must not be opted out. An opted-out address is one that
              // delivered mail and whose owner acted on it, so leaving it is never a typo
              // correction: it is a move to a different mailbox, the one way an opt-out could
              // otherwise be escaped. Checked in the transaction rather than read first, so an
              // opt-out landing mid-update cannot slip past.
              ConditionCheck: {
                Table: tableLogicalId,
                Key: unsubscribeKey(current.email),
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              // Unconditional: the contact's write in slot 0 establishes that this request owns the
              // move away from that address, so whatever the reservation's state, removing it is
              // correct.
              Delete: { Table: tableLogicalId, Key: reservationKey(current.email) },
            },
            {
              Put: {
                Table: tableLogicalId,
                Item: reservationItem(email, contactId),
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ];

    const outcome = yield* runTransaction("updateContact", {
      TransactItems: [
        {
          // Commits only against the contact as it was just read. A concurrent address change is
          // then a lost race on the failure channel, never silently reverted — which would leave the
          // other request's reservation pointing at a contact that no longer holds that address,
          // unreachable through any endpoint. The condition also accepts the new spelling, which
          // holds once this write has applied, so the same request landing twice is not a lost race.
          Put: {
            Table: tableLogicalId,
            Item: contactItem(next),
            ConditionExpression:
              "attribute_exists(pk) AND (#email = :currentEmail OR #email = :email)",
            ExpressionAttributeNames: { "#email": "email" },
            ExpressionAttributeValues: {
              ":currentEmail": str(current.email),
              ":email": str(email),
            },
          },
        },
        ...move,
      ],
    });

    if (outcome.committed) {
      return next;
    }

    // Answered before `EmailAlreadyUsed` when both fail: another address can be chosen, an opt-out
    // cannot be worked around.
    if (outcome.conditionFailures.has(1)) {
      return yield* new Schemas.AddressOptedOut({ email: current.email });
    }

    if (outcome.conditionFailures.has(3)) {
      return yield* new Schemas.EmailAlreadyUsed({ email });
    }

    return yield* unavailable("updateContact")(outcome.conditionFailures);
  });

  return {
    createContact,
    getContact,
    getContactByEmail,
    listContacts,
    updateContact,
  } as const;
};
