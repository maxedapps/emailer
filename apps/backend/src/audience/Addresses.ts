import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Context, Effect, Layer, Option } from "effect";

import { AudienceStore } from "../storage/Audience.ts";
import { unavailable } from "../storage/Errors.ts";

import type { StorageFailure } from "../storage/Errors.ts";

/**
 * Account-list lookup and delete. These are SES callables, not a storage capability; the Live
 * layer binds them.
 */
export class AccountSuppression extends Context.Service<
  AccountSuppression,
  {
    readonly getSuppressedDestination: (
      request: sesv2.GetSuppressedDestinationRequest,
    ) => Effect.Effect<sesv2.GetSuppressedDestinationResponse, sesv2.GetSuppressedDestinationError>;
    readonly deleteSuppressedDestination: (
      request: sesv2.DeleteSuppressedDestinationRequest,
    ) => Effect.Effect<
      sesv2.DeleteSuppressedDestinationResponse,
      sesv2.DeleteSuppressedDestinationError
    >;
  }
>()("emailer/backend/AccountSuppression") {}

export const AccountSuppressionLive = Layer.effect(AccountSuppression)(
  Effect.gen(function* () {
    return AccountSuppression.of({
      getSuppressedDestination: yield* AWS.SES.GetSuppressedDestination(),
      deleteSuppressedDestination: yield* AWS.SES.DeleteSuppressedDestination(),
    });
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(AWS.SES.GetSuppressedDestinationHttp, AWS.SES.DeleteSuppressedDestinationHttp),
  ),
);

const accountReason = (
  reason: sesv2.SuppressionListReason,
): Schemas.SuppressionReason | undefined => {
  switch (reason) {
    case "BOUNCE":
      return "bounce";
    case "COMPLAINT":
      return "complaint";
    default:
      return undefined;
  }
};

const accountSuppressionOf = (
  destination: sesv2.SuppressedDestination,
): Effect.Effect<NonNullable<Schemas.AddressRecord["accountSuppression"]>, StorageFailure> => {
  const reason = accountReason(destination.Reason);

  if (reason === undefined) {
    return Effect.fail(unavailable("getSuppressedDestination")(destination.Reason));
  }

  return Effect.succeed({
    reason,
    lastUpdateTime: destination.LastUpdateTime.toISOString(),
  });
};

export const status = Effect.fn("Addresses.status")(function* (email: string) {
  const audience = yield* AudienceStore;
  const ses = yield* AccountSuppression;

  const local = yield* audience.addressRecord(email);

  const listed = yield* ses.getSuppressedDestination({ EmailAddress: email }).pipe(
    Effect.asSome,
    Effect.catchTag("NotFoundException", () => Effect.succeedNone),
    Effect.mapError(unavailable("getSuppressedDestination")),
  );

  if (Option.isNone(listed)) {
    return { ...local, accountSuppression: null } satisfies Schemas.AddressRecord;
  }

  return {
    ...local,
    accountSuppression: yield* accountSuppressionOf(listed.value.SuppressedDestination),
  } satisfies Schemas.AddressRecord;
});

/**
 * SES first so a later storage failure is retryable: both sides are idempotent,
 * and a repeat never sees the local row gone while the account entry remains.
 */
export const unsuppress = Effect.fn("Addresses.unsuppress")(function* (email: string) {
  const audience = yield* AudienceStore;
  const ses = yield* AccountSuppression;

  yield* ses.deleteSuppressedDestination({ EmailAddress: email }).pipe(
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.mapError(unavailable("deleteSuppressedDestination")),
  );

  yield* audience.unsuppress(email);

  return yield* status(email);
});
