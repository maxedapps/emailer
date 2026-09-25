import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import { EmailServiceUnavailable } from "@emailer/api/Errors";
import type * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Context, Effect, Layer, Option } from "effect";

import { unavailable } from "../Errors.ts";
import { AudienceStore } from "../storage/Audience.ts";

/**
 * Account-list lookup and delete. These are SES callables, not a storage capability; the Live
 * layer binds them.
 */
export class AccountSuppression extends Context.Service<AccountSuppression>()(
  "emailer/backend/AccountSuppression",
  {
    make: Effect.gen(function* () {
      return {
        getSuppressedDestination: yield* AWS.SES.GetSuppressedDestination(),
        deleteSuppressedDestination: yield* AWS.SES.DeleteSuppressedDestination(),
      } as const;
    }),
  },
) {}

export const AccountSuppressionLive = Layer.effect(AccountSuppression)(
  AccountSuppression.make,
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
): Effect.Effect<
  NonNullable<Schemas.AddressRecord["accountSuppression"]>,
  EmailServiceUnavailable
> => {
  const reason = accountReason(destination.Reason);

  // A reason this code does not know is SES answering something it cannot report.
  if (reason === undefined) {
    return Effect.fail(
      new EmailServiceUnavailable({
        operation: "getSuppressedDestination",
        failure: "UnknownSuppressionReason",
      }),
    );
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
    Effect.mapError(unavailable(EmailServiceUnavailable, "getSuppressedDestination")),
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
    Effect.mapError(unavailable(EmailServiceUnavailable, "deleteSuppressedDestination")),
  );

  yield* audience.unsuppress(email);

  return yield* status(email);
});
