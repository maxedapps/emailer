import * as Schemas from "@emailer/api/Schemas";
import { Effect, Predicate } from "effect";

import { StorageFailure } from "./storage/Errors.ts";

/**
 * A cause reduced to a name. Recording the cause itself would put SDK payloads, request bodies and
 * schema input into the log, which is how addresses and tokens end up there; the classification is
 * what distinguishes a timeout from a throttle from a malformed item, and that is what is worth
 * having.
 */
export const describeCause = (cause: unknown): string =>
  Predicate.hasProperty(cause, "_tag") && Predicate.isString(cause._tag)
    ? cause._tag
    : Predicate.hasProperty(cause, "name") && Predicate.isString(cause.name)
      ? cause.name
      : "unknown";

const reportStorageFailure = (failure: StorageFailure) =>
  Effect.logError("storage operation failed", {
    operationId: failure.operationId,
    reason: failure.reason,
    cause: describeCause(failure.cause),
  });

/**
 * The API boundary for every operation that only touches storage. Internal detail is recorded here
 * and converted here, exactly once, so no call site maps the failure itself or loses its cause.
 */
export const publicly = <A, E, R>(operation: Effect.Effect<A, E | StorageFailure, R>) =>
  Effect.catchIf(
    operation,
    (failure): failure is StorageFailure => failure instanceof StorageFailure,
    (failure) =>
      reportStorageFailure(failure).pipe(
        Effect.andThen(
          Effect.fail(new Schemas.StorageUnavailable({ operationId: failure.operationId })),
        ),
      ),
  );

/**
 * The boundary for the two entry points that have no HTTP error contract to translate into: the
 * SES event consumer and the public unsubscribe POST. Neither may report success for work that did
 * not persist, so the failure still ends the invocation — it is only recorded on the way past.
 * SQS redelivers the consumer's message and a mail provider gets a 500 rather than a false
 * acknowledgement.
 */
export const reportedAndFatal = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.tapError((failure) =>
      failure instanceof StorageFailure ? reportStorageFailure(failure) : Effect.void,
    ),
    Effect.orDie,
  );
