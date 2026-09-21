import * as Schemas from "@emailer/api/Schemas";
import { Effect, Option } from "effect";

import { newIdentifier, nowIso } from "./Identifiers.ts";
import { AudienceStore } from "./Storage/Audience.ts";

export const create = Effect.fn("Lists.create")(function* (payload: Schemas.CreateListPayload) {
  const storage = yield* AudienceStore;
  const id = yield* newIdentifier;
  const createdAt = yield* nowIso;

  const list: Schemas.ContactList = { id, name: payload.name, createdAt };

  yield* storage.createList(list);

  return list;
});

export const get = Effect.fn("Lists.get")(function* (listId: string) {
  const storage = yield* AudienceStore;

  const found = yield* storage.getList(listId);

  if (Option.isNone(found)) {
    return yield* new Schemas.NotFound({ entity: "list" });
  }

  return found.value.list;
});

export const list = Effect.fn("Lists.list")(function* (
  limit: number,
  cursor: Schemas.EntityCursor | undefined,
) {
  const storage = yield* AudienceStore;

  const page = yield* storage.listLists(limit, cursor);

  return page.nextCursor === undefined
    ? { items: page.items }
    : { items: page.items, nextCursor: page.nextCursor };
});

export const listMembers = Effect.fn("Lists.listMembers")(function* (
  listId: string,
  limit: number,
  cursor: string | undefined,
) {
  const storage = yield* AudienceStore;

  const found = yield* storage.listMembers(listId, limit, cursor);

  if (Option.isNone(found)) {
    return yield* new Schemas.NotFound({ entity: "list" });
  }

  const page = found.value;

  return page.nextCursor === undefined
    ? { items: page.items }
    : { items: page.items, nextCursor: page.nextCursor };
});

export const removeContact = Effect.fn("Lists.removeContact")(function* (
  listId: string,
  contactId: string,
) {
  const storage = yield* AudienceStore;

  const outcome = yield* storage.removeMember(listId, contactId);

  if (outcome === "list-missing") {
    return yield* new Schemas.NotFound({ entity: "list" });
  }
});

export const addContact = Effect.fn("Lists.addContact")(function* (
  listId: string,
  contactId: string,
) {
  const storage = yield* AudienceStore;
  const addedAt = yield* nowIso;

  const outcome = yield* storage.addMember(listId, contactId, addedAt);

  if (outcome === "contact-missing") {
    return yield* new Schemas.NotFound({ entity: "contact" });
  }

  if (outcome === "list-missing") {
    return yield* new Schemas.NotFound({ entity: "list" });
  }
});

export const rename = Effect.fn("Lists.rename")(function* (
  listId: string,
  payload: Schemas.UpdateListPayload,
) {
  const storage = yield* AudienceStore;

  const renamed = yield* storage.renameList(listId, payload.name);

  if (Option.isNone(renamed)) {
    return yield* new Schemas.NotFound({ entity: "list" });
  }

  return renamed.value;
});

export const remove = Effect.fn("Lists.remove")(function* (listId: string) {
  const storage = yield* AudienceStore;

  const outcome = yield* storage.deleteList(listId);

  if (outcome === "list-missing") {
    return yield* new Schemas.NotFound({ entity: "list" });
  }
});

export const importContacts = Effect.fn("Lists.importContacts")(function* (
  listId: string,
  payload: Schemas.ImportContactsPayload,
) {
  const storage = yield* AudienceStore;
  const addedAt = yield* nowIso;

  const candidates = yield* Effect.forEach(payload.contacts, (entry) =>
    Effect.map(newIdentifier, (id) => ({
      id,
      email: entry.email,
      name: entry.name,
      attributes: entry.attributes,
    })),
  );

  const result = yield* storage.importContacts(listId, candidates, addedAt);

  if (result.outcome === "list-missing") {
    return yield* new Schemas.NotFound({ entity: "list" });
  }

  return { contacts: result.contacts };
});
