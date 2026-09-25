import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { ContactChanged, ContactNotFound, ListNotFound } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Schema } from "effect";

import { corrupt } from "../Errors.ts";
import {
  contactItem,
  contactKey,
  readContact,
  reservationItem,
  reservationKey,
  retryLostRace,
} from "./Contacts.ts";
import { itemReader, keyCodec, num, recordVersion, str, tableLogicalId } from "./Items.ts";
import { listKey } from "./Lists.ts";

import type {
  Action,
  BatchPrimitives,
  QueryPrimitives,
  ReadPrimitives,
  StoredPage,
  TransactionPrimitives,
} from "./Primitives.ts";

/**
 * How many memberships one list-cascade transaction clears. `TransactWriteItems` allows at most 100
 * actions, and each membership costs two deletes, so a page is 80 actions with headroom besides;
 * the list itself is deleted in a transaction of its own. The bound is load-bearing rather than
 * tuning: a transaction built from a page of unbounded size would exceed 100 on any list past 50
 * members and then fail **identically on every retry**, leaving the list permanently undeletable.
 */
const cascadePageLimit = 40;

/** Both directions of a membership store the same record. */
const Member = Schema.Struct({
  listId: Schemas.EntityId,
  contactId: Schemas.EntityId,
  addedAt: Schemas.Timestamp,
});

const readMember = itemReader(Member);

/** A reservation read back by batch, keyed by the mailbox its key names. */
const readHeldReservation = itemReader(
  Schema.Struct({
    pk: Schema.String.check(Schema.isStartsWith("EMAIL#")),
    contactId: Schemas.EntityId,
  }),
);

const decodeMemberCursor = Schema.decodeUnknownEffect(
  keyCodec(Schema.Struct({ sk: Schema.String.check(Schema.isStartsWith("MEMBER#")) })),
);

export const memberKey = (listId: string, contactId: string) => ({
  pk: str(`LIST#${listId}`),
  sk: str(`MEMBER#${contactId}`),
});

/**
 * The reverse of the membership, and the only contact→lists access path there is: the listing index
 * is sparse over contact and list `META` items, so it covers no member item. It is written in the
 * same transaction as the forward item, which makes the pair strongly consistent — an inverted
 * index would be eventually consistent, and a contact cascade driven by a stale read would miss a
 * membership written moments before and leave it behind.
 */
const memberOfKey = (contactId: string, listId: string) => ({
  pk: str(`CONTACT#${contactId}`),
  sk: str(`LISTOF#${listId}`),
});

const joinMember = (
  key: dynamodb.AttributeMap,
  listId: string,
  contactId: string,
  addedAt: string,
) => ({
  Update: {
    Table: tableLogicalId,
    Key: key,
    UpdateExpression:
      "SET v = :v, listId = :listId, contactId = :contactId, addedAt = if_not_exists(addedAt, :addedAt)",
    ExpressionAttributeValues: {
      ":v": num(recordVersion),
      ":listId": str(listId),
      ":contactId": str(contactId),
      ":addedAt": str(addedAt),
    },
  },
});

/**
 * Which contact holds each candidate's address, by mailbox, read strongly consistently. The read is
 * advice only — a strong read still does not make a later write atomic — which `joinActions`
 * turns into conditions its transaction asserts.
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
 * The actions that join each candidate to a list, creating the contact where no one holds its
 * address, and the converged result they leave. Members are written with `Update` rather than
 * `Put`: a conditional `Put` would fail for anyone already in the list and cancel the whole batch,
 * where an upsert makes a re-run a no-op. `addedAt` is kept through `if_not_exists`, so joining
 * again does not rewrite when somebody joined.
 *
 * The transaction's own conditions are the authority over `holders`: every existing contact carries
 * a `ConditionCheck`, so a join racing that contact's deletion fails rather than resurrecting a
 * membership; and each new address is reserved conditionally, so losing a race to a concurrent
 * creation fails too. Both races answer `ContactChanged`, which a caller retries from a fresh read.
 */
export const joinActions = Effect.fnUntraced(function* (
  listId: string,
  candidates: ReadonlyArray<Schemas.Contact>,
  holders: ReadonlyMap<string, string>,
  addedAt: string,
) {
  const actions: Array<Action<ContactChanged>> = [];

  const contacts: Array<Schemas.ImportContactsResult["contacts"][number]> = [];

  for (const candidate of candidates) {
    const held = holders.get(Schemas.mailboxKey(candidate.email));
    const contactId = held ?? candidate.id;

    if (held === undefined) {
      actions.push(
        {
          Put: {
            Table: tableLogicalId,
            Item: yield* contactItem(candidate),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        // A concurrent creation took the address since it was read.
        {
          Put: {
            Table: tableLogicalId,
            Item: yield* reservationItem(candidate.email, contactId),
            ConditionExpression: "attribute_not_exists(pk)",
          },
          refused: () => new ContactChanged(),
        },
      );
    } else {
      actions.push(
        {
          ConditionCheck: {
            Table: tableLogicalId,
            Key: contactKey(contactId),
            ConditionExpression: "attribute_exists(pk)",
          },
          refused: () => new ContactChanged(),
        },
        // The holder was read before the transaction, so it is advice, not a fact. Between the
        // read and the commit the contact can be moved to another address, or deleted and the
        // address reassigned — and then this join would add a contact to the list under an
        // address it no longer holds. Asserting the reservation still names this contact makes
        // that a refusal instead, atomically with the membership writes rather than before them.
        {
          ConditionCheck: {
            Table: tableLogicalId,
            Key: reservationKey(candidate.email),
            ConditionExpression: "contactId = :holder",
            ExpressionAttributeValues: { ":holder": str(contactId) },
          },
          refused: () => new ContactChanged(),
        },
      );
    }

    actions.push(
      joinMember(memberKey(listId, contactId), listId, contactId, addedAt),
      joinMember(memberOfKey(contactId, listId), listId, contactId, addedAt),
    );

    contacts.push({ email: candidate.email, contactId, member: true });
  }

  return { actions, result: { contacts } satisfies Schemas.ImportContactsResult };
});

export const membershipOperations = (
  primitives: ReadPrimitives & QueryPrimitives & BatchPrimitives & TransactionPrimitives,
) => {
  const { readItem, readItems, runQuery, transact } = primitives;

  const removeMembership = (listId: string, contactId: string) => [
    { Delete: { Table: tableLogicalId, Key: memberKey(listId, contactId) } },
    { Delete: { Table: tableLogicalId, Key: memberOfKey(contactId, listId) } },
  ];

  /**
   * Adding to a list that is gone must write no membership, and removing from one answers
   * `ListNotFound`, so both transactions carry this check. It targets the list's `META`, never a
   * member item, so it shares a transaction with the member writes without targeting any item twice.
   * An import reads the list instead; `importContacts` says why.
   */
  const listExists = (listId: string) => ({
    ConditionCheck: {
      Table: tableLogicalId,
      Key: listKey(listId),
      ConditionExpression: "attribute_exists(pk)",
    },
    refused: () => new ListNotFound(),
  });

  /**
   * Both parents are checked and both directions joined, as an import joins them: joining again
   * changes nothing, not even when the contact joined.
   */
  const addMember = Effect.fn("Storage.addMember")(function* (
    listId: string,
    contactId: string,
    addedAt: string,
  ) {
    yield* transact("addMember", [
      {
        ConditionCheck: {
          Table: tableLogicalId,
          Key: contactKey(contactId),
          ConditionExpression: "attribute_exists(pk)",
        },
        refused: () => new ContactNotFound(),
      },
      listExists(listId),
      joinMember(memberKey(listId, contactId), listId, contactId, addedAt),
      joinMember(memberOfKey(contactId, listId), listId, contactId, addedAt),
    ]);
  });

  /**
   * Both directions go, and slot 2 checks the list, so removing from a list that is not there
   * answers `ListNotFound` rather than a quiet success. Neither delete is conditioned: removing
   * someone who is not a member is a no-op, and repeating the request must stay harmless.
   */
  const removeMember = Effect.fn("Storage.removeMember")(function* (
    listId: string,
    contactId: string,
  ) {
    yield* transact("removeMember", [...removeMembership(listId, contactId), listExists(listId)]);
  });

  /**
   * Members are read from the base table, never from the index, and hydrated into whole contacts:
   * a caller listing a list's members wants the people, and bare identifiers would only force a
   * second round trip per member. `ListNotFound` means the list itself is absent, which is a different
   * answer from a list with no members.
   */
  const listMembers = Effect.fn("Storage.listMembers")(function* (
    listId: string,
    limit: number,
    cursor: string | undefined,
  ) {
    const list = yield* readItem("listMembers", listKey(listId));

    if (list.Item === undefined) {
      return yield* new ListNotFound();
    }

    const request = {
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": str(`LIST#${listId}`), ":prefix": str("MEMBER#") },
      Limit: limit,
    };

    const page = yield* runQuery(
      "listMembers",
      "base-table",
      cursor === undefined ? request : { ...request, ExclusiveStartKey: memberKey(listId, cursor) },
    );

    const memberIds: Array<string> = [];

    for (const item of page.Items ?? []) {
      const { contactId: memberId } = yield* readMember("listMembers", item);

      memberIds.push(memberId);
    }

    const byId = new Map<string, Schemas.Contact>();

    for (const item of yield* readItems("listMembers", memberIds.map(contactKey))) {
      const contact = yield* readContact("listMembers", item);

      byId.set(contact.id, contact);
    }

    const contacts = memberIds.flatMap((memberId): Array<Schemas.Contact> => {
      const contact = byId.get(memberId);

      return contact === undefined ? [] : [contact];
    });

    const last = page.LastEvaluatedKey;

    if (last === undefined) {
      return { items: contacts } satisfies StoredPage<Schemas.Contact, string>;
    }

    // A `LastEvaluatedKey` that cannot be turned into a cursor would silently end the listing, so
    // it is decoded rather than read: a page that is there but unreachable is corrupt, not absent.
    const { sk } = yield* decodeMemberCursor(last).pipe(corrupt("listMembers"));

    return { items: contacts, nextCursor: sk.slice("MEMBER#".length) } satisfies StoredPage<
      Schemas.Contact,
      string
    >;
  });

  /**
   * Deletes a contact, its memberships and its address reservation. `META` goes **last**, which is
   * what makes a repeated `DELETE` resume: while it is still there the contact is discoverable, and
   * the moment it is gone `addMember`'s existence check refuses to add anything more.
   *
   * Every transaction here is a delete, so a repeat of any of them changes nothing, and the
   * cascade as a whole resumes wherever it stopped.
   *
   * Each membership is removed, both directions together, in a transaction of its own. The removal
   * carries no list condition, so a membership whose list is already gone is removed like any
   * other and can never block the contact's deletion.
   */
  const deleteContact = Effect.fn("Storage.deleteContact")(function* (contactId: string) {
    const stored = yield* readItem("deleteContact", contactKey(contactId));

    if (stored.Item === undefined) {
      return yield* new ContactNotFound();
    }

    const contact = yield* readContact("deleteContact", stored.Item);

    let startKey: dynamodb.AttributeMap | undefined;

    do {
      const request = {
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": str(`CONTACT#${contactId}`),
          ":prefix": str("LISTOF#"),
        },
        Limit: cascadePageLimit,
      };

      const page = yield* runQuery(
        "deleteContact",
        "base-table",
        startKey === undefined ? request : { ...request, ExclusiveStartKey: startKey },
      );

      for (const item of page.Items ?? []) {
        const { listId } = yield* readMember("deleteContact", item);

        yield* transact("deleteContact", removeMembership(listId, contactId));
      }

      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);

    // Conditioned on the address read at the start still being the contact's. Without it, an
    // address change landing between that read and here would strand the new reservation: nothing
    // would point at it and no endpoint could clear it. A lost race is retried from a fresh read,
    // which resumes the cascade where it stopped.
    yield* transact("deleteContact", [
      {
        Delete: {
          Table: tableLogicalId,
          Key: contactKey(contactId),
          ConditionExpression: "attribute_exists(pk) AND #email = :email",
          ExpressionAttributeNames: { "#email": "email" },
          ExpressionAttributeValues: { ":email": str(contact.email) },
        },
        refused: () => new ContactChanged(),
      },
      { Delete: { Table: tableLogicalId, Key: reservationKey(contact.email) } },
    ]);
  }, retryLostRace);

  /**
   * Deletes a list and every membership in it. Each page clears at most `cascadePageLimit`
   * memberships, both directions of each, in one transaction; `LIST#…/META` goes **last**, on its
   * own, which is what makes a repeated `DELETE` resume: while it is still there the list is
   * discoverable, and the moment it is gone every membership write's list check refuses.
   *
   * A page can hold no members — an empty list, or the page after one that ended exactly on the
   * limit — and a transaction with no actions is a validation error that would fail on every
   * repeat, so such a page writes nothing.
   */
  const deleteList = Effect.fn("Storage.deleteList")(function* (listId: string) {
    const stored = yield* readItem("deleteList", listKey(listId));

    if (stored.Item === undefined) {
      return yield* new ListNotFound();
    }

    let startKey: dynamodb.AttributeMap | undefined;

    do {
      const request = {
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": str(`LIST#${listId}`), ":prefix": str("MEMBER#") },
        Limit: cascadePageLimit,
      };

      const page = yield* runQuery(
        "deleteList",
        "base-table",
        startKey === undefined ? request : { ...request, ExclusiveStartKey: startKey },
      );

      const removals: Array<Action<never>> = [];

      for (const item of page.Items ?? []) {
        const { contactId: memberId } = yield* readMember("deleteList", item);

        removals.push(...removeMembership(listId, memberId));
      }

      if (removals.length > 0) {
        yield* transact("deleteList", removals);
      }

      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);

    yield* transact("deleteList", [{ Delete: { Table: tableLogicalId, Key: listKey(listId) } }]);
  });

  /**
   * Loads a batch of contacts into a list in one transaction, joined as `joinActions` joins them.
   *
   * The list is read, not checked inside the transaction. Its `META` shares a partition with every
   * member item, so a transactional check would lock the one partition a large import already
   * saturates, and parallel batches would collide on it (ADR-0025). A missing list is `ListNotFound`
   * before any write. A list deleted between the read and the commit leaves this batch's
   * memberships behind — the leftover ADR-0005 already accepts for an import during a delete
   * cascade; every later batch reads the list as missing.
   *
   * A lost race is retried from a fresh pre-read, which then sees the new state.
   */
  const importContacts = Effect.fn("Storage.importContacts")(function* (
    listId: string,
    candidates: ReadonlyArray<Schemas.Contact>,
    addedAt: string,
  ) {
    const [list, holders] = yield* Effect.all(
      [
        readItem("importContacts", listKey(listId)),
        readHolders(
          primitives,
          "importContacts",
          candidates.map((candidate) => candidate.email),
        ),
      ],
      { concurrency: 2 },
    );

    if (list.Item === undefined) {
      return yield* new ListNotFound();
    }

    const joined = yield* joinActions(listId, candidates, holders, addedAt);

    yield* transact("importContacts", joined.actions);

    return joined.result;
  }, retryLostRace);

  return {
    addMember,
    removeMember,
    deleteContact,
    deleteList,
    importContacts,
    listMembers,
  } as const;
};
