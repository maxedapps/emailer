import { NodeServices } from "@effect/platform-node";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import * as Lists from "./Lists.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { unusedAudience } from "../storage/Testing.ts";

import type { AddMemberOutcome, RemoveMemberOutcome } from "../storage/Membership.ts";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const contactId = "0195f0a0-1111-4222-8333-44444444c001";

const storageAnswering = (outcome: AddMemberOutcome) =>
  Layer.succeed(AudienceStore)({ ...unusedAudience, addMember: () => Effect.succeed(outcome) });

const removeContact = (outcome: RemoveMemberOutcome) =>
  Effect.result(Lists.removeContact(listId, contactId)).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(AudienceStore)({
          ...unusedAudience,
          removeMember: () => Effect.succeed(outcome),
        }),
        NodeServices.layer,
      ),
    ),
  );

const addContact = (outcome: AddMemberOutcome) =>
  Effect.result(Lists.addContact(listId, contactId)).pipe(
    Effect.provide(Layer.mergeAll(storageAnswering(outcome), NodeServices.layer)),
  );

describe("addContact", () => {
  it("succeeds when the membership was created", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(Result.isSuccess(yield* addContact("added"))).toBe(true);
      }),
    ));

  it("treats a repeated addition as success, not a conflict", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(Result.isSuccess(yield* addContact("already-member"))).toBe(true);
      }),
    ));

  it("reports a missing contact as a missing contact", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* addContact("contact-missing");

        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.NotFound({ entity: "contact" }),
        );
      }),
    ));

  it("reports a missing list as a missing list", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* addContact("list-missing");

        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.NotFound({ entity: "list" }),
        );
      }),
    ));
});

describe("removeContact", () => {
  it("succeeds when the membership was removed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(Result.isSuccess(yield* removeContact("removed"))).toBe(true);
      }),
    ));

  it("reports a missing list as a missing list", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* removeContact("list-missing");

        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.NotFound({ entity: "list" }),
        );
      }),
    ));
});
