import { NodeServices } from "@effect/platform-node";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import * as Contacts from "./Contacts.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { unusedAudience } from "../storage/Testing.ts";

import type { AudienceOperations } from "../storage/Audience.ts";

const contactId = "0195f0a0-1111-4222-8333-44444444c001";

const createdAt = "2026-09-11T10:00:00.000Z";

const email = "sam@example.com";

const stored: Schemas.Contact = { id: contactId, email, name: "Sam", createdAt };

const answering = (operations: Partial<AudienceOperations>) =>
  Layer.mergeAll(
    Layer.succeed(AudienceStore)({ ...unusedAudience, ...operations }),
    NodeServices.layer,
  );

describe("create", () => {
  it("reports a reserved address as a conflict rather than a storage failure", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(Contacts.create({ email })).pipe(
          Effect.provide(answering({ createContact: () => Effect.succeed("email-taken") })),
        );

        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.EmailAlreadyUsed({ email }),
        );
      }),
    ));

  it("carries bounded attributes through to the stored contact", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const written: Array<Schemas.Contact> = [];

        const created = yield* Contacts.create({ email, attributes: { plan: "pro" } }).pipe(
          Effect.provide(
            answering({
              createContact: (contact) =>
                Effect.sync(() => {
                  written.push(contact);

                  return "created" as const;
                }),
            }),
          ),
        );

        expect(created.attributes).toStrictEqual({ plan: "pro" });
        expect(written[0]?.attributes).toStrictEqual({ plan: "pro" });
      }),
    ));
});

describe("getByEmail", () => {
  it("reports a missing contact as a missing contact", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(Contacts.getByEmail(email)).pipe(
          Effect.provide(answering({ getContactByEmail: () => Effect.succeedNone })),
        );

        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.NotFound({ entity: "contact" }),
        );
      }),
    ));

  it("answers with the contact the address resolves to", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const found = yield* Contacts.getByEmail(email).pipe(
          Effect.provide(answering({ getContactByEmail: () => Effect.succeedSome(stored) })),
        );

        expect(found).toStrictEqual(stored);
      }),
    ));
});

describe("update", () => {
  it("reports a contact that is not there as a missing contact", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(Contacts.update(contactId, { name: "Maxi" })).pipe(
          Effect.provide(
            answering({ updateContact: () => Effect.succeed({ outcome: "contact-missing" }) }),
          ),
        );

        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.NotFound({ entity: "contact" }),
        );
      }),
    ));

  it("names the address that is already taken, not the one being replaced", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(
          Contacts.update(contactId, { email: "taken@example.com" }),
        ).pipe(
          Effect.provide(
            answering({
              updateContact: () =>
                Effect.succeed({ outcome: "email-taken", email: "taken@example.com" }),
            }),
          ),
        );

        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.EmailAlreadyUsed({ email: "taken@example.com" }),
        );
      }),
    ));

  it("refuses a move off an opted-out address, naming the address being left", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(
          Contacts.update(contactId, { email: "elsewhere@example.com" }),
        ).pipe(
          Effect.provide(
            answering({
              updateContact: () => Effect.succeed({ outcome: "opted-out", email: stored.email }),
            }),
          ),
        );

        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.AddressOptedOut({ email: stored.email }),
        );
      }),
    ));

  it("answers with the contact as it now stands", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const updated = yield* Contacts.update(contactId, { name: "Maxi" }).pipe(
          Effect.provide(
            answering({
              updateContact: () =>
                Effect.succeed({ outcome: "updated", contact: { ...stored, name: "Maxi" } }),
            }),
          ),
        );

        expect(updated).toStrictEqual({ ...stored, name: "Maxi" });
      }),
    ));
});
