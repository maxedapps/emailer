import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import {
  AddressOptedOut,
  ContactChanged,
  ContactNotFound,
  EmailAlreadyUsed,
  TooManyAttributes,
} from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Predicate, Record, Schema } from "effect";

import { addressKey } from "./Addresses.ts";
import { itemReader, itemWriter, listingAttributes, num, str, tableLogicalId } from "./Items.ts";

import type {
  Action,
  BatchPrimitives,
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

/**
 * A contact as stored: the contract's record plus `revision`, which every write sets and every
 * update increments, so an update writes only against the contact it read. A contact from before
 * revisions has none.
 */
const ContactRecord = Schema.Struct({
  ...Schemas.Contact.fields,
  revision: Schema.optionalKey(Schema.Int),
});

const writeContact = itemWriter(ContactRecord);

/** Reads a stored contact. Membership hydrates contacts too, so this is shared. */
export const readContact = itemReader(Schemas.Contact);

const readContactRecord = itemReader(ContactRecord);

/** The contact without its revision, as the contract answers it. */
const contractOf = ({ revision: _revision, ...contact }: typeof ContactRecord.Type) => contact;

/**
 * The condition an update asserts on the contact it read: the same revision, or none yet on a
 * contact that is still there, so a write never resurrects a deleted one.
 */
const sameRevision = (revision: number | undefined) =>
  revision === undefined
    ? { ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revision)" }
    : {
        ConditionExpression: "revision = :revision",
        ExpressionAttributeValues: { ":revision": num(revision) },
      };

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

/**
 * A contact's whole item at `revision`: its record, its key and its entry in the listing index. A
 * new contact is revision 1.
 */
export const contactItem = (
  contact: Schemas.Contact,
  revision: number,
): Effect.Effect<dynamodb.AttributeMap> =>
  Effect.map(writeContact({ ...contact, revision }), (attributes) => ({
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

/** A reservation read back by batch, keyed by the mailbox its key names. */
const readHeldReservation = itemReader(
  Schema.Struct({
    pk: Schema.String.check(Schema.isStartingWith("EMAIL#")),
    contactId: Schemas.EntityId,
  }),
);

/**
 * Which contact holds each candidate's address, by mailbox, read strongly consistently. The read is
 * advice only — a strong read still does not make a later write atomic — which every writer turns
 * into conditions its transaction asserts.
 */
export const readHolders = Effect.fnUntraced(function* (
  primitives: Pick<BatchPrimitives, "readItems">,
  operation: string,
  emails: ReadonlyArray<string>,
) {
  const reserved = yield* primitives.readItems(operation, emails.map(reservationKey));

  const holders = new Map<string, string>();

  for (const item of reserved) {
    const entry = yield* readHeldReservation(operation, item);

    holders.set(entry.pk.slice("EMAIL#".length), entry.contactId);
  }

  return holders;
});

/**
 * A merge patch applied to a contact's attributes: a string sets a key, null removes it, and keys
 * the patch leaves out keep their value. No attributes left is none at all. More than a contact may
 * hold is refused, naming the contact's address.
 */
const mergeAttributes = (
  contact: Schemas.Contact,
  patch: Schemas.AttributePatch,
): Effect.Effect<Schemas.ContactAttributes | undefined, TooManyAttributes> => {
  const merged = Record.filter({ ...contact.attributes, ...patch }, Predicate.isNotNull);
  const count = Object.keys(merged).length;

  if (count > Schemas.maxAttributeEntries) {
    return Effect.fail(
      new TooManyAttributes({ email: contact.email, limit: Schemas.maxAttributeEntries }),
    );
  }

  return Effect.succeed(count === 0 ? undefined : merged);
};

export const contactOperations = (
  primitives: ReadPrimitives & PagePrimitives & BatchPrimitives & TransactionPrimitives,
) => {
  const { readEntityPage, readItem, readItems, transact } = primitives;

  /**
   * The contact and its address reservation. The contact's condition could only fail if a freshly
   * generated identifier already existed, so it declares no refusal: that would be a defect.
   */
  const createContact = Effect.fn("Storage.createContact")(function* (contact: Schemas.Contact) {
    yield* transact("createContact", [
      {
        Put: {
          Table: tableLogicalId,
          Item: yield* contactItem(contact, 1),
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

  /** The stored contact with its revision, which only an update needs. */
  const getContactRecord = Effect.fn("Storage.getContactRecord")(function* (contactId: string) {
    const response = yield* readItem("getContact", contactKey(contactId));

    if (response.Item === undefined) {
      return yield* new ContactNotFound();
    }

    return yield* readContactRecord("getContact", response.Item);
  });

  const getContact = Effect.fn("Storage.getContact")(function* (contactId: string) {
    return contractOf(yield* getContactRecord(contactId));
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
   * The change is merged into the contact just read and the whole item is written at the next
   * revision, so a cleared field is simply absent. Attributes are merged as a patch, and null
   * clears them all. `id` and `createdAt` are written back as read, so `gsi1sk` is unchanged and
   * the contact keeps its place in created order. The write holds only against the revision read,
   * so a concurrent edit is a lost race, retried from a fresh read, and never silently reverted.
   */
  const updateContact = Effect.fn("Storage.updateContact")(function* (
    contactId: string,
    update: Schemas.UpdateContactPayload,
  ) {
    const { revision, ...current } = yield* getContactRecord(contactId);
    const email = update.email ?? current.email;
    const name = update.name === undefined ? current.name : (update.name ?? undefined);

    const attributes =
      update.attributes === undefined
        ? current.attributes
        : update.attributes === null
          ? undefined
          : yield* mergeAttributes(current, update.attributes);

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
        // Commits only against the contact as it was just read. A concurrent change is then a lost
        // race on the failure channel, never silently reverted — which for an address change would
        // leave the other request's reservation pointing at a contact that no longer holds that
        // address, unreachable through any endpoint. The transaction's token makes the same
        // request landing twice one commit, and a deleted contact has no revision to match.
        Put: {
          Table: tableLogicalId,
          Item: yield* contactItem(next, (revision ?? 0) + 1),
          ...sameRevision(revision),
        },
        refused: () => new ContactChanged(),
      },
      // An opt-out is answered before `EmailAlreadyUsed` when both fail: another address can be
      // chosen, an opt-out cannot be worked around.
      ...move,
    ]);

    return next;
  }, retryLostRace);

  /**
   * Merges each patch into the contact holding its address, in one transaction of whole-contact
   * writes, each at the next revision of the contact just read. An address no contact holds is
   * reported, not refused: an attribute file often names people who never joined. A contact that
   * moved, went or changed since the reads is a lost race, retried from fresh reads.
   */
  const setAttributes = Effect.fn("Storage.setAttributes")(function* (
    entries: Schemas.SetAttributesPayload["contacts"],
  ) {
    const holders = yield* readHolders(
      primitives,
      "setAttributes",
      entries.map((entry) => entry.email),
    );

    const held = entries.flatMap((entry) => {
      const contactId = holders.get(Schemas.mailboxKey(entry.email));

      return contactId === undefined ? [] : [contactId];
    });

    const stored = new Map<string, typeof ContactRecord.Type>();

    for (const item of yield* readItems("setAttributes", held.map(contactKey))) {
      const record = yield* readContactRecord("setAttributes", item);

      stored.set(record.id, record);
    }

    const actions: Array<Action<ContactChanged>> = [];
    const contacts: Array<Schemas.SetAttributesResult["contacts"][number]> = [];

    for (const entry of entries) {
      const contactId = holders.get(Schemas.mailboxKey(entry.email));

      if (contactId === undefined) {
        contacts.push({ email: entry.email, outcome: "not-found" });
        continue;
      }

      const record = stored.get(contactId);

      // Deleted, or moved off this address, since the reservation was read.
      if (
        record === undefined ||
        Schemas.mailboxKey(record.email) !== Schemas.mailboxKey(entry.email)
      ) {
        return yield* new ContactChanged();
      }

      const { revision, ...current } = record;

      const next = contactOf(
        current.id,
        current.email,
        current.name,
        yield* mergeAttributes(current, entry.attributes),
        current.createdAt,
      );

      actions.push({
        Put: {
          Table: tableLogicalId,
          Item: yield* contactItem(next, (revision ?? 0) + 1),
          ...sameRevision(revision),
        },
        refused: () => new ContactChanged(),
      });

      contacts.push({ email: entry.email, outcome: "updated", contactId });
    }

    if (actions.length > 0) {
      yield* transact("setAttributes", actions);
    }

    return { contacts } satisfies Schemas.SetAttributesResult;
  }, retryLostRace);

  return {
    createContact,
    getContact,
    getContactByEmail,
    listContacts,
    setAttributes,
    updateContact,
  } as const;
};
