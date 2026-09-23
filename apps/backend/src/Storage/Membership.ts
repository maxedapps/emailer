import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import type * as AWS from "alchemy/AWS";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Option, Schema } from "effect";

import { corrupt, unavailable } from "./Errors.ts";
import {
  contactItem,
  contactKey,
  contactOf,
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
 * actions, and each membership costs two deletes, so 40 leaves room for the list action and
 * headroom besides. The bound is load-bearing rather than tuning: a transaction built from a page
 * of unbounded size would exceed 100 on any list past 49 members and then fail **identically on
 * every retry**, leaving the list permanently undeletable.
 */
const cascadePageLimit = 40;

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
 * index would be eventually consistent, and a cascade driven by a stale read would orphan
 * memberships that `Campaigns.send` then reports as a permanent 503.
 */
const memberOfKey = (contactId: string, listId: string) => ({
  pk: str(`CONTACT#${contactId}`),
  sk: str(`LISTOF#${listId}`),
});

export type AddMemberOutcome = "added" | "already-member" | "contact-missing" | "list-missing";

export type RemoveMemberOutcome = "removed" | "list-missing";

export interface ImportCandidate {
  readonly id: string;
  readonly email: string;
  readonly name?: string | undefined;
  readonly attributes?: Schemas.ContactAttributes | undefined;
}

interface ImportedContact {
  readonly email: string;
  readonly contactId: string;
  readonly member: boolean;
}

type ImportContactsOutcome =
  | { readonly outcome: "imported"; readonly contacts: ReadonlyArray<ImportedContact> }
  | { readonly outcome: "list-missing" };

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
   * Slot 0 checks the contact, slot 1 bumps the list, slot 2 writes the forward member and slot 3
   * its reverse. The tests address these positions, so the order is part of the contract. The
   * list's existence rides on its own `Update`'s condition rather than a separate `ConditionCheck`,
   * because a transaction may not target one item twice.
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
        {
          Update: {
            Table: tableLogicalId,
            Key: listKey(listId),
            UpdateExpression: "SET membershipVersion = membershipVersion + :one",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeValues: { ":one": num(1) },
          },
        },
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
      return "contact-missing" as const;
    }

    if (outcome.conditionFailures.has(1)) {
      return "list-missing" as const;
    }

    return "already-member" as const;
  });

  /**
   * Both directions go, and `membershipVersion` moves so a concurrent membership change is
   * visible to any reader of the list. Neither delete is conditioned: removing someone who is not
   * a member is a no-op, and repeating the request must stay harmless.
   */
  const removeMember = Effect.fn("Storage.removeMember")(function* (
    listId: string,
    contactId: string,
  ) {
    const outcome = yield* runTransaction("removeMember", {
      TransactItems: [
        ...removeMembership(listId, contactId),
        {
          Update: {
            Table: tableLogicalId,
            Key: listKey(listId),
            UpdateExpression: "SET membershipVersion = membershipVersion + :one",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeValues: { ":one": num(1) },
          },
        },
      ],
    });

    return outcome.committed ? ("removed" as const) : ("list-missing" as const);
  });

  /**
   * Members are read from the base table, never from the index, and hydrated into whole contacts:
   * a caller listing a list's members wants the people, and bare identifiers would only force a
   * second round trip per member. `Option.none` means the list itself is absent, which is a
   * different answer from a list with no members.
   */
  const listMembers = Effect.fn("Storage.listMembers")(function* (
    listId: string,
    limit: number,
    cursor: string | undefined,
  ) {
    const list = yield* readItem("listMembers", listKey(listId));

    if (list.Item === undefined) {
      return Option.none<StoredPage<Schemas.Contact, string>>();
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

    const keys: Array<dynamodb.AttributeMap> = [];

    for (const item of page.Items ?? []) {
      const { contactId: memberId } = yield* decodeMemberEntry(item).pipe(
        Effect.mapError(corrupt("listMembers")),
      );

      keys.push(contactKey(memberId));
    }

    const contacts: Array<Schemas.Contact> = [];

    for (const item of yield* readItems("listMembers", keys)) {
      const stored = yield* decodeContactItem(item).pipe(Effect.mapError(corrupt("listMembers")));

      contacts.push(
        contactOf(stored.id, stored.email, stored.name, stored.attributes, stored.createdAt),
      );
    }

    // Members sort by contact id under the list partition; a batch read does not preserve that.
    contacts.sort((left, right) => left.id.localeCompare(right.id));

    const last = page.LastEvaluatedKey;

    // A `LastEvaluatedKey` that cannot be turned into a cursor would silently end the listing, so
    // it is decoded rather than read: a page that is there but unreachable is corrupt, not absent.
    const nextCursor =
      last === undefined
        ? undefined
        : (yield* decodeMemberCursor(last).pipe(Effect.mapError(corrupt("listMembers")))).sk.slice(
            "MEMBER#".length,
          );

    return Option.some<StoredPage<Schemas.Contact, string>>({ items: contacts, nextCursor });
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

  const bumpList = (listId: string) => ({
    Update: {
      Table: tableLogicalId,
      Key: listKey(listId),
      UpdateExpression: "SET membershipVersion = membershipVersion + :one",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":one": num(1) },
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
   * One transaction per membership, so no page arithmetic applies. A `ConditionalCheckFailed` in
   * the bump slot means that list was concurrently deleted; the membership is then removed without
   * a bump, which is what keeps an orphan left by the accepted delete-cascade race from blocking
   * this contact's deletion forever.
   */
  const deleteContact = Effect.fn("Storage.deleteContact")(function* (contactId: string) {
    const stored = yield* readItem("deleteContact", contactKey(contactId));

    if (stored.Item === undefined) {
      return "contact-missing" as const;
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
          TransactItems: [...removeMembership(listId, contactId), bumpList(listId)],
        });

        if (!removal.committed) {
          yield* runTransaction("deleteContact", {
            TransactItems: removeMembership(listId, contactId),
          });
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

    return "deleted" as const;
  });

  /**
   * Deletes a list and every membership in it, `META` last. Each page clears at most
   * `cascadePageLimit` memberships; the **final** page deletes `LIST#…/META` instead of bumping,
   * because the bump and the deletion address the same item and a transaction may not target one
   * item twice — that is a validation error raised before the transaction runs, so it would never
   * surface as a cancellation and would fail every non-empty list's delete deterministically.
   *
   * Dropping the final bump is safe: the parent is gone, so later membership writes that condition
   * on its existence fail the same way a bump on a missing list would.
   */
  const deleteList = Effect.fn("Storage.deleteList")(function* (listId: string) {
    const stored = yield* readItem("deleteList", listKey(listId));

    if (stored.Item === undefined) {
      return "list-missing" as const;
    }

    let startKey: dynamodb.AttributeMap | undefined;

    for (;;) {
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

      const final = page.LastEvaluatedKey === undefined;

      const outcome = yield* runTransaction("deleteList", {
        TransactItems: final
          ? [...removals, { Delete: { Table: tableLogicalId, Key: listKey(listId) } }]
          : [...removals, bumpList(listId)],
      });

      if (!outcome.committed) {
        return yield* unavailable("deleteList")(outcome.conditionFailures);
      }

      if (final) {
        return "deleted" as const;
      }

      startKey = page.LastEvaluatedKey;
    }
  });

  /**
   * Loads a batch of contacts into a list in one transaction. Members are written with `Update`
   * rather than `Put`: a conditional `Put` would fail for anyone already in the list and cancel the
   * whole batch, where an upsert makes a re-run a no-op. `addedAt` is kept through `if_not_exists`,
   * so re-importing does not rewrite when somebody joined.
   *
   * The pre-read is advisory only — a strong read still does not make a later write atomic. The
   * transaction's own conditions are the authority: every existing contact carries a
   * `ConditionCheck`, so an import racing that contact's deletion fails rather than resurrecting a
   * membership, and each new address is reserved conditionally, so losing a race to a concurrent
   * creation fails too. Both resolve on a repeat, whose pre-read then sees the new state.
   *
   * The bump is slot 0 and is unconditional in the sense that matters: it does not depend on what
   * the pre-read said. Making it conditional on that would let a concurrent removal between the
   * read and the write leave the audience changed while the version stood still.
   */
  const importContacts = Effect.fn("Storage.importContacts")(function* (
    listId: string,
    candidates: ReadonlyArray<ImportCandidate>,
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
      bumpList(listId),
    ];

    const imported: Array<ImportedContact> = [];

    for (const candidate of candidates) {
      const held = holders.get(Schemas.mailboxKey(candidate.email));
      const contactId = held ?? candidate.id;

      if (held === undefined) {
        actions.push(
          {
            Put: {
              Table: tableLogicalId,
              Item: contactItem(
                contactOf(
                  contactId,
                  candidate.email,
                  candidate.name,
                  candidate.attributes,
                  addedAt,
                ),
              ),
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
      return { outcome: "imported", contacts: imported } as const satisfies ImportContactsOutcome;
    }

    if (outcome.conditionFailures.has(0)) {
      return { outcome: "list-missing" } as const satisfies ImportContactsOutcome;
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
