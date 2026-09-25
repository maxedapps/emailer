import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import {
  AddressOptedOut,
  ContactChanged,
  ContactNotFound,
  EmailAlreadyUsed,
} from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Predicate, Schema } from "effect";

import { addressKey } from "./Addresses.ts";
import { itemReader, itemWriter, listingAttributes, str, tableLogicalId } from "./Items.ts";

import type {
  Action,
  PagePrimitives,
  ReadPrimitives,
  StoredPage,
  TransactionPrimitives,
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

const writeContact = itemWriter(Schemas.Contact);

/** Reads a stored contact. Membership hydrates contacts too, so this is shared. */
export const readContact = itemReader(Schemas.Contact);

const Reservation = Schema.Struct({ contactId: Schemas.EntityId });

const writeReservation = itemWriter(Reservation);

export const readReservation = itemReader(Reservation);

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

/** A contact's whole item: its record, its key and its entry in the listing index. */
export const contactItem = (contact: Schemas.Contact): Effect.Effect<dynamodb.AttributeMap> =>
  Effect.map(writeContact(contact), (attributes) => ({
    ...contactKey(contact.id),
    ...listingAttributes(contactKind, contact.createdAt, contact.id),
    ...attributes,
  }));

/**
 * A write that lost a race with another request on the same contact, retried from a fresh read:
 * the race is over by then, and the retry answers what now holds. A contact that keeps changing
 * answers `ContactChanged`.
 */
export const retryLostRace = <A, E, R>(write: Effect.Effect<A, E, R>) =>
  Effect.retry(write, { times: 2, while: Predicate.isTagged("ContactChanged") });

export const reservationItem = (email: string, contactId: string) =>
  Effect.map(writeReservation({ contactId }), (attributes) => ({
    ...reservationKey(email),
    ...attributes,
  }));

export const contactOperations = (
  primitives: ReadPrimitives & PagePrimitives & TransactionPrimitives,
) => {
  const { readEntityPage, readItem, transact } = primitives;

  /**
   * The contact and its address reservation. The contact's condition could only fail if a freshly
   * generated identifier already existed, so it declares no refusal: that would be a defect.
   */
  const createContact = Effect.fn("Storage.createContact")(function* (contact: Schemas.Contact) {
    yield* transact("createContact", [
      {
        Put: {
          Table: tableLogicalId,
          Item: yield* contactItem(contact),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          Table: tableLogicalId,
          Item: yield* reservationItem(contact.email, contact.id),
          ConditionExpression: "attribute_not_exists(pk)",
        },
        refused: () => new EmailAlreadyUsed({ email: contact.email }),
      },
    ]);
  });

  const getContact = Effect.fn("Storage.getContact")(function* (contactId: string) {
    const response = yield* readItem("getContact", contactKey(contactId));

    if (response.Item === undefined) {
      return yield* new ContactNotFound();
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
      return yield* new ContactNotFound();
    }

    const reserved = yield* readReservation("getContactByEmail", reservation.Item);

    const found = yield* getContact(reserved.contactId);

    // Every path that writes a reservation writes the contact in the same transaction, so the two
    // cannot disagree. If they ever did, answering "no contact has this address" is honest, where
    // returning a contact under an address it does not hold would not be.
    if (Schemas.mailboxKey(found.email) !== Schemas.mailboxKey(email)) {
      return yield* new ContactNotFound();
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
    const move: Array<Action<AddressOptedOut | EmailAlreadyUsed>> =
      Schemas.mailboxKey(email) === Schemas.mailboxKey(current.email)
        ? []
        : [
            {
              // The address being left must not be opted out of any list. An opted-out address is
              // one that delivered mail and whose owner acted on it, so leaving it is never a typo
              // correction: it is a move to a different mailbox, the one way an opt-out could
              // otherwise be escaped. Checked in the transaction rather than read first, so an
              // opt-out landing mid-update cannot slip past. DynamoDB drops a set emptied of its
              // last list, so an address whose opt-outs were all lifted is free again.
              ConditionCheck: {
                Table: tableLogicalId,
                Key: addressKey(current.email),
                ConditionExpression: "attribute_not_exists(optOuts)",
              },
              refused: () => new AddressOptedOut({ email: current.email }),
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
                Item: yield* reservationItem(email, contactId),
                ConditionExpression: "attribute_not_exists(pk)",
              },
              refused: () => new EmailAlreadyUsed({ email }),
            },
          ];

    // The contact comes first, so a lost race decides over the address checks computed from it.
    yield* transact("updateContact", [
      {
        // Commits only against the contact as it was just read. A concurrent address change is
        // then a lost race on the failure channel, never silently reverted — which would leave the
        // other request's reservation pointing at a contact that no longer holds that address,
        // unreachable through any endpoint. The condition also accepts the new spelling, which
        // holds once this write has applied, so the same request landing twice is not a lost race.
        Put: {
          Table: tableLogicalId,
          Item: yield* contactItem(next),
          ConditionExpression:
            "attribute_exists(pk) AND (#email = :currentEmail OR #email = :email)",
          ExpressionAttributeNames: { "#email": "email" },
          ExpressionAttributeValues: {
            ":currentEmail": str(current.email),
            ":email": str(email),
          },
        },
        refused: () => new ContactChanged(),
      },
      // An opt-out is answered before `EmailAlreadyUsed` when both fail: another address can be
      // chosen, an opt-out cannot be worked around.
      ...move,
    ]);

    return next;
  }, retryLostRace);

  return {
    createContact,
    getContact,
    getContactByEmail,
    listContacts,
    updateContact,
  } as const;
};
