import * as Schemas from "@emailer/api/Schemas";
import { Effect, Option } from "effect";

import { newIdentifier, nowIso } from "../Identifiers.ts";
import { AudienceStore } from "../storage/Audience.ts";

export const create = Effect.fn("Contacts.create")(function* (
  payload: Schemas.CreateContactPayload,
) {
  const storage = yield* AudienceStore;
  const id = yield* newIdentifier;
  const createdAt = yield* nowIso;

  const identified = { id, email: payload.email, createdAt };
  const named = payload.name === undefined ? identified : { ...identified, name: payload.name };

  const contact: Schemas.Contact =
    payload.attributes === undefined ? named : { ...named, attributes: payload.attributes };

  const outcome = yield* storage.createContact(contact);

  if (outcome === "email-taken") {
    return yield* new Schemas.EmailAlreadyUsed({ email: payload.email });
  }

  return contact;
});

export const get = Effect.fn("Contacts.get")(function* (contactId: string) {
  const storage = yield* AudienceStore;

  const found = yield* storage.getContact(contactId);

  if (Option.isNone(found)) {
    return yield* new Schemas.NotFound({ entity: "contact" });
  }

  return found.value;
});

export const list = Effect.fn("Contacts.list")(function* (
  limit: number,
  cursor: Schemas.EntityCursor | undefined,
) {
  const storage = yield* AudienceStore;

  const page = yield* storage.listContacts(limit, cursor);

  return page.nextCursor === undefined
    ? { items: page.items }
    : { items: page.items, nextCursor: page.nextCursor };
});

export const getByEmail = Effect.fn("Contacts.getByEmail")(function* (email: string) {
  const storage = yield* AudienceStore;

  const found = yield* storage.getContactByEmail(email);

  if (Option.isNone(found)) {
    return yield* new Schemas.NotFound({ entity: "contact" });
  }

  return found.value;
});

export const update = Effect.fn("Contacts.update")(function* (
  contactId: string,
  payload: Schemas.UpdateContactPayload,
) {
  const storage = yield* AudienceStore;

  const result = yield* storage.updateContact(contactId, payload);

  if (result.outcome === "contact-missing") {
    return yield* new Schemas.NotFound({ entity: "contact" });
  }

  if (result.outcome === "email-taken") {
    return yield* new Schemas.EmailAlreadyUsed({ email: result.email });
  }

  if (result.outcome === "opted-out") {
    return yield* new Schemas.AddressOptedOut({ email: result.email });
  }

  return result.contact;
});

export const remove = Effect.fn("Contacts.remove")(function* (contactId: string) {
  const storage = yield* AudienceStore;

  const outcome = yield* storage.deleteContact(contactId);

  if (outcome === "contact-missing") {
    return yield* new Schemas.NotFound({ entity: "contact" });
  }
});
