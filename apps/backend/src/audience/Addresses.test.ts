import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import { DateTime, Effect, Layer } from "effect";

import { AccountSuppression, status, unsuppress } from "./Addresses.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { unusedAudience } from "../storage/Testing.ts";

const email = "User@Example.com";

const local = {
  email,
  status: "suppressed" as const,
  transientBounces: [],
  accountSuppression: null,
};

const notListed = new sesv2.NotFoundException({ message: "not listed" });

interface Scenario {
  readonly listed?: Effect.Effect<
    sesv2.GetSuppressedDestinationResponse,
    sesv2.GetSuppressedDestinationError
  >;
  readonly deleted?: Effect.Effect<
    sesv2.DeleteSuppressedDestinationResponse,
    sesv2.DeleteSuppressedDestinationError
  >;
}

/** The local record and the SES account list, recording each call in order. */
const world = (scenario: Scenario = {}) => {
  const calls: Array<string> = [];

  const layer = Layer.mergeAll(
    Layer.succeed(AudienceStore)({
      ...unusedAudience,
      addressRecord: (address) =>
        Effect.sync(() => {
          calls.push(`addressRecord ${address}`);

          return local;
        }),
      unsuppress: (address) =>
        Effect.sync(() => {
          calls.push(`unsuppress ${address}`);

          return undefined;
        }),
    }),
    Layer.succeed(AccountSuppression)({
      getSuppressedDestination: (request) =>
        Effect.suspend(() => {
          calls.push(`getSuppressedDestination ${request.EmailAddress}`);

          return scenario.listed ?? Effect.fail(notListed);
        }),
      deleteSuppressedDestination: (request) =>
        Effect.suspend(() => {
          calls.push(`deleteSuppressedDestination ${request.EmailAddress}`);

          return scenario.deleted ?? Effect.succeed({});
        }),
    }),
  );

  return { layer, calls };
};

describe("status", () => {
  it.effect("answers the local record with no account entry when SES lists none", () =>
    Effect.gen(function* () {
      const { layer, calls } = world();

      expect(yield* status(email).pipe(Effect.provide(layer))).toStrictEqual(local);
      // SES keeps the case it was given and matches exactly, so the address reaches it unchanged.
      expect(calls).toStrictEqual([`addressRecord ${email}`, `getSuppressedDestination ${email}`]);
    }),
  );

  it.effect("maps an account entry to its reason and an ISO timestamp", () =>
    Effect.gen(function* () {
      const { layer } = world({
        listed: Effect.succeed({
          SuppressedDestination: {
            EmailAddress: email,
            Reason: "BOUNCE",
            LastUpdateTime: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-15T10:20:30.000Z")),
          },
        }),
      });

      expect(yield* status(email).pipe(Effect.provide(layer))).toStrictEqual({
        ...local,
        accountSuppression: { reason: "bounce", lastUpdateTime: "2026-09-15T10:20:30.000Z" },
      });
    }),
  );

  it.effect("names a failed lookup as the email service being unavailable", () =>
    Effect.gen(function* () {
      const { layer } = world({
        listed: Effect.fail(new sesv2.TooManyRequestsException({ message: "slow" })),
      });

      expect(yield* Effect.flip(status(email).pipe(Effect.provide(layer)))).toStrictEqual(
        new Errors.EmailServiceUnavailable({
          operation: "getSuppressedDestination",
          failure: "TooManyRequestsException",
        }),
      );
    }),
  );
});

describe("unsuppress", () => {
  it.effect("deletes the account entry before the local rows, then reads the result", () =>
    Effect.gen(function* () {
      const { layer, calls } = world();

      yield* unsuppress(email).pipe(Effect.provide(layer));

      expect(calls).toStrictEqual([
        `deleteSuppressedDestination ${email}`,
        `unsuppress ${email}`,
        `addressRecord ${email}`,
        `getSuppressedDestination ${email}`,
      ]);
    }),
  );

  it.effect("clears the local rows when SES has no entry to delete", () =>
    Effect.gen(function* () {
      const { layer, calls } = world({ deleted: Effect.fail(notListed) });

      yield* unsuppress(email).pipe(Effect.provide(layer));

      expect(calls).toContain(`unsuppress ${email}`);
    }),
  );

  it.effect("leaves the local rows alone when SES refuses the delete", () =>
    Effect.gen(function* () {
      const { layer, calls } = world({
        deleted: Effect.fail(new sesv2.TooManyRequestsException({ message: "slow" })),
      });

      expect(yield* Effect.flip(unsuppress(email).pipe(Effect.provide(layer)))).toStrictEqual(
        new Errors.EmailServiceUnavailable({
          operation: "deleteSuppressedDestination",
          failure: "TooManyRequestsException",
        }),
      );
      expect(calls).toStrictEqual([`deleteSuppressedDestination ${email}`]);
    }),
  );
});
