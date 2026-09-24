import type * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";

import { newIdentifier, nowIso } from "../Identifiers.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { contactOf } from "../storage/Contacts.ts";

export const create = Effect.fn("Lists.create")(function* (payload: Schemas.CreateListPayload) {
  const storage = yield* AudienceStore;
  const id = yield* newIdentifier;
  const createdAt = yield* nowIso;

  const list: Schemas.ContactList = { id, name: payload.name, createdAt };

  yield* storage.createList(list);

  return list;
});

export const addContact = Effect.fn("Lists.addContact")(function* (
  listId: string,
  contactId: string,
) {
  const storage = yield* AudienceStore;
  const addedAt = yield* nowIso;

  yield* storage.addMember(listId, contactId, addedAt);
});

export const importContacts = Effect.fn("Lists.importContacts")(function* (
  listId: string,
  payload: Schemas.ImportContactsPayload,
) {
  const storage = yield* AudienceStore;
  const addedAt = yield* nowIso;

  const candidates = yield* Effect.forEach(payload.contacts, (entry) =>
    Effect.map(newIdentifier, (id) =>
      contactOf(id, entry.email, entry.name, entry.attributes, addedAt),
    ),
  );

  return yield* storage.importContacts(listId, candidates, addedAt);
});
