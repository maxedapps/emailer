import type * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";

import { newIdentifier, nowIso } from "../Identifiers.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { contactOf } from "../storage/Contacts.ts";

export const create = Effect.fn("Contacts.create")(function* (
  payload: Schemas.CreateContactPayload,
) {
  const storage = yield* AudienceStore;
  const id = yield* newIdentifier;
  const createdAt = yield* nowIso;

  const contact = contactOf(id, payload.email, payload.name, payload.attributes, createdAt);

  yield* storage.createContact(contact);

  return contact;
});
