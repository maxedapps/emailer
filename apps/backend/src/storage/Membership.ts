import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import type * as AWS from "alchemy/AWS";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Schema, Struct } from "effect";

import { corrupt, unavailable } from "./Errors.ts";
import {
  contactItem,
  contactKey,
  decodeContactItem,
  reservationItem,
  reservationKey,
} from "./Contacts.ts";
import { attributeOf, num, recordVersion, str, tableLogicalId } from "./Items.ts";
import { listKey } from "./Lists.ts";

import type {
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

/**
 * Membership rows project one field each, and are decoded like any item: an attribute of the
 * wrong kind is reported as corrupt, never read as absent.
 */
const MemberEntry = Schema.Struct({ contactId: attributeOf(Schemas.EntityId) });

const MembershipEntry = Schema.Struct({ listId: attributeOf(Schemas.EntityId) });

const ReservationEntry = Schema.Struct({
  pk: attributeOf(Schema.String.check(Schema.isStartsWith("EMAIL#"))),
  contactId: attributeOf(Schemas.EntityId),
});

const MemberCursor = Schema.Struct({
  sk: attributeOf(Schema.String.check(Schema.isStartsWith("MEMBER#"))),
});

const decodeMemberEntry = Schema.decodeUnknownEffect(MemberEntry);

const decodeMembershipEntry = Schema.decodeUnknownEffect(MembershipEntry);

const decodeReservationEntry = Schema.decodeUnknownEffect(ReservationEntry);

const decodeMemberCursor = Schema.decodeUnknownEffect(MemberCursor);

const memberKey = (listId: string, contactId: string) => ({
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

export const membershipOperations = (
  primitives: ReadPrimitives & QueryPrimitives & BatchPrimitives & TransactionPrimitives,
) => {
  const { readItem, readItems, runQuery, runTransaction } = primitives;

  const memberItem = (listId: string, contactId: string, addedAt: string) => ({
    v: num(recordVersion),
    listId: str(listId),
    contactId: str(contactId),
    addedAt: str(addedAt),
  });

  const removeMembership = (listId: string, contactId: string) => [
    { Delete: { Table: tableLogicalId, Key: memberKey(listId, contactId) } },
    { Delete: { Table: tableLogicalId, Key: memberOfKey(contactId, listId) } },
  ];

  /**
   * Adding to or importing into a list that is gone must write no membership, and removing from one
   * answers `NotFound`, so each of those transactions carries this check. It targets the list's
   * `META`, never a member item, so it shares a transaction with the member writes without targeting
   * any item twice.
   */
  const listExists = (listId: string) => ({
    ConditionCheck: {
      Table: tableLogicalId,
      Key: listKey(listId),
      ConditionExpression: "attribute_exists(pk)",
    },
  });

  /**
   * Slot 0 checks the contact, slot 1 checks the list, slot 2 writes the forward member and slot 3
   * its reverse. The outcome is read from which slots failed, so the order is part of the contract.
   * Both member `Put`s are conditional on absence, which is what makes a repeat `already-member`.
   */
  const addMember = Effect.fn("Storage.addMember")(function* (
    listId: string,
    contactId: string,
    addedAt: string,
  ) {
    const outcome = yield* runTransaction("addMember", {
      TransactItems: [
        {
          ConditionCheck: {
            Table: tableLogicalId,
            Key: contactKey(contactId),
            ConditionExpression: "attribute_exists(pk)",
          },
        },
        listExists(listId),
        {
          Put: {
            Table: tableLogicalId,
            Item: { ...memberKey(listId, contactId), ...memberItem(listId, contactId, addedAt) },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            Table: tableLogicalId,
            Item: { ...memberOfKey(contactId, listId), ...memberItem(listId, contactId, addedAt) },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    });

    if (outcome.committed) {
      return "added" as const;
    }

    if (outcome.conditionFailures.has(0)) {
      return yield* new Schemas.NotFound({ entity: "contact" });
    }

    if (outcome.conditionFailures.has(1)) {
      return yield* new Schemas.NotFound({ entity: "list" });
    }

    return "already-member" as const;
  });

  /**
   * Both directions go, and slot 2 checks the list, so removing from a list that is not there
   * answers `NotFound` rather than a quiet success. Neither delete is conditioned: removing
   * someone who is not a member is a no-op, and repeating the request must stay harmless.
   */
  const removeMember = Effect.fn("Storage.removeMember")(function* (
    listId: string,
    contactId: string,
  ) {
    const outcome = yield* runTransaction("removeMember", {
      TransactItems: [...removeMembership(listId, contactId), listExists(listId)],
    });

    if (!outcome.committed) {
      return yield* new Schemas.NotFound({ entity: "list" });
    }
  });

  /**
   * Members are read from the base table, never from the index, and hydrated into whole contacts:
   * a caller listing a list's members wants the people, and bare identifiers would only force a
   * second round trip per member. `NotFound` means the list itself is absent, which is a different
   * answer from a list with no members.
   */
  const listMembers = Effect.fn("Storage.listMembers")(function* (
    listId: string,
    limit: number,
    cursor: string | undefined,
  ) {
    const list = yield* readItem("listMembers", listKey(listId));

    if (list.Item === undefined) {
      return yield* new Schemas.NotFound({ entity: "list" });
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
      const { contactId: memberId } = yield* decodeMemberEntry(item).pipe(
        Effect.mapError(corrupt("listMembers")),
      );

      memberIds.push(memberId);
    }

    const byId = new Map<string, Schemas.Contact>();

    for (const item of yield* readItems("listMembers", memberIds.map(contactKey))) {
      const stored = yield* decodeContactItem(item).pipe(Effect.mapError(corrupt("listMembers")));

      byId.set(stored.id, Struct.omit(stored, ["v"]));
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
    const { sk } = yield* decodeMemberCursor(last).pipe(Effect.mapError(corrupt("listMembers")));

    return { items: contacts, nextCursor: sk.slice("MEMBER#".length) } satisfies StoredPage<
      Schemas.Contact,
      string
    >;
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
      return yield* new Schemas.NotFound({ entity: "contact" });
    }

    const contact = yield* decodeContactItem(stored.Item).pipe(
      Effect.mapError(corrupt("deleteContact")),
    );

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
        const { listId } = yield* decodeMembershipEntry(item).pipe(
          Effect.mapError(corrupt("deleteContact")),
        );

        const removal = yield* runTransaction("deleteContact", {
          TransactItems: removeMembership(listId, contactId),
        });

        if (!removal.committed) {
          return yield* unavailable("deleteContact")(removal.conditionFailures);
        }
      }

      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);

    // Conditioned on the address read at the start still being the contact's. Without it, an
    // address change landing between that read and here would strand the new reservation: nothing
    // would point at it and no endpoint could clear it. A condition failure is a failure, not a
    // quiet success — the client's repeated DELETE re-reads and completes.
    const outcome = yield* runTransaction("deleteContact", {
      TransactItems: [
        {
          Delete: {
            Table: tableLogicalId,
            Key: contactKey(contactId),
            ConditionExpression: "attribute_exists(pk) AND #email = :email",
            ExpressionAttributeNames: { "#email": "email" },
            ExpressionAttributeValues: { ":email": str(contact.email) },
          },
        },
        { Delete: { Table: tableLogicalId, Key: reservationKey(contact.email) } },
      ],
    });

    if (!outcome.committed) {
      return yield* unavailable("deleteContact")(outcome.conditionFailures);
    }
  });

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
      return yield* new Schemas.NotFound({ entity: "list" });
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

      const removals: Array<AWS.DynamoDB.TransactWriteItemsRequest["TransactItems"][number]> = [];

      for (const item of page.Items ?? []) {
        const { contactId: memberId } = yield* decodeMemberEntry(item).pipe(
          Effect.mapError(corrupt("deleteList")),
        );

        removals.push(...removeMembership(listId, memberId));
      }

      if (removals.length > 0) {
        const outcome = yield* runTransaction("deleteList", { TransactItems: removals });

        if (!outcome.committed) {
          return yield* unavailable("deleteList")(outcome.conditionFailures);
        }
      }

      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);

    const outcome = yield* runTransaction("deleteList", {
      TransactItems: [{ Delete: { Table: tableLogicalId, Key: listKey(listId) } }],
    });

    if (!outcome.committed) {
      return yield* unavailable("deleteList")(outcome.conditionFailures);
    }
  });

  /**
   * Loads a batch of contacts into a list in one transaction. Members are written with `Update`
   * rather than `Put`: a conditional `Put` would fail for anyone already in the list and cancel the
   * whole batch, where an upsert makes a re-run a no-op. `addedAt` is kept through `if_not_exists`,
   * so re-importing does not rewrite when somebody joined.
   *
   * The pre-read is advisory only — a strong read still does not make a later write atomic. The
   * transaction's own conditions are the authority: slot 0 checks the list, so a missing list is
   * `NotFound`; every existing contact carries a `ConditionCheck`, so an import racing that
   * contact's deletion fails rather than resurrecting a membership; and each new address is
   * reserved conditionally, so losing a race to a concurrent creation fails too. Both races
   * resolve on a repeat, whose pre-read then sees the new state.
   */
  const importContacts = Effect.fn("Storage.importContacts")(function* (
    listId: string,
    candidates: ReadonlyArray<Schemas.Contact>,
    addedAt: string,
  ) {
    const reserved = yield* readItems(
      "importContacts",
      candidates.map((candidate) => reservationKey(candidate.email)),
    );

    const holders = new Map<string, string>();

    for (const item of reserved) {
      const entry = yield* decodeReservationEntry(item).pipe(
        Effect.mapError(corrupt("importContacts")),
      );

      holders.set(entry.pk.slice("EMAIL#".length), entry.contactId);
    }

    const actions: Array<AWS.DynamoDB.TransactWriteItemsRequest["TransactItems"][number]> = [
      listExists(listId),
    ];

    const imported: Array<Schemas.ImportContactsResult["contacts"][number]> = [];

    for (const candidate of candidates) {
      const held = holders.get(Schemas.mailboxKey(candidate.email));
      const contactId = held ?? candidate.id;

      if (held === undefined) {
        actions.push(
          {
            Put: {
              Table: tableLogicalId,
              Item: contactItem(candidate),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              Table: tableLogicalId,
              Item: reservationItem(candidate.email, contactId),
              ConditionExpression: "attribute_not_exists(pk)",
            },
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
          },
          // The holder was read before the transaction, so it is advice, not a fact. Between the
          // read and the commit the contact can be moved to another address, or deleted and the
          // address reassigned — and then this import would add a contact to the list under an
          // address it no longer holds. Asserting the reservation still names this contact makes
          // that a refusal instead, atomically with the membership writes rather than before them.
          {
            ConditionCheck: {
              Table: tableLogicalId,
              Key: reservationKey(candidate.email),
              ConditionExpression: "contactId = :holder",
              ExpressionAttributeValues: { ":holder": str(contactId) },
            },
          },
        );
      }

      actions.push(
        joinMember(memberKey(listId, contactId), listId, contactId, addedAt),
        joinMember(memberOfKey(contactId, listId), listId, contactId, addedAt),
      );

      imported.push({ email: candidate.email, contactId, member: true });
    }

    const outcome = yield* runTransaction("importContacts", {
      TransactItems: actions,
    });

    if (outcome.committed) {
      return { contacts: imported } satisfies Schemas.ImportContactsResult;
    }

    if (outcome.conditionFailures.has(0)) {
      return yield* new Schemas.NotFound({ entity: "list" });
    }

    return yield* unavailable("importContacts")(outcome.conditionFailures);
  });

  return {
    addMember,
    removeMember,
    deleteContact,
    deleteList,
    importContacts,
    listMembers,
  } as const;
};
