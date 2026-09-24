import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import type * as Schemas from "@emailer/api/Schemas";
import { Effect, Layer } from "effect";

import * as Contacts from "./Contacts.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { unusedAudience } from "../storage/Testing.ts";

import type { AudienceOperations } from "../storage/Audience.ts";

const email = "sam@example.com";

const answering = (operations: Partial<AudienceOperations>) =>
  Layer.mergeAll(
    Layer.succeed(AudienceStore)({ ...unusedAudience, ...operations }),
    NodeServices.layer,
  );

describe("create", () => {
  it.effect("carries bounded attributes through to the stored contact", () =>
    Effect.gen(function* () {
      const written: Array<Schemas.Contact> = [];

      const created = yield* Contacts.create({ email, attributes: { plan: "pro" } }).pipe(
        Effect.provide(
          answering({
            createContact: (contact) =>
              Effect.sync(() => {
                written.push(contact);

                return undefined;
              }),
          }),
        ),
      );

      expect(created.attributes).toStrictEqual({ plan: "pro" });
      expect(written[0]?.attributes).toStrictEqual({ plan: "pro" });
    }),
  );
});
