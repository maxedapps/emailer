import * as Schemas from "@emailer/api/Schemas";
import { Effect, Option, Schema } from "effect";

import { StorageFailure } from "./storage/Errors.ts";

const Tagged = Schema.Struct({ _tag: Schema.String });

const Named = Schema.Struct({ name: Schema.String });

const asTagged = Schema.decodeUnknownOption(Tagged);

const asNamed = Schema.decodeUnknownOption(Named);

/**
 * A cause reduced to a name. Recording the cause itself would put SDK payloads, request bodies and
 * schema input into the log, which is how addresses and tokens end up there; the classification is
 * what distinguishes a timeout from a throttle from a malformed item, and that is what is worth
 * having. A cause carrying neither an Effect tag nor an exception name carries no classification to
 * record, and says so.
 */
export const describeCause = (cause: unknown): string =>
  Option.match(asTagged(cause), {
    onSome: (tagged) => tagged._tag,
    onNone: () =>
      Option.match(asNamed(cause), {
        onSome: (named) => named.name,
        // A native error keeps `name` on its prototype, where a schema reading own properties
        // never finds it — so without this a defect that reaches here classifies as "unknown"
        // rather than as the `TypeError` it is.
        onNone: () => (cause instanceof Error ? cause.name : "unknown"),
      }),
  });

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
export const publicly = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, StorageFailure> | Schemas.StorageUnavailable, R> => {
  type Public = Exclude<E, StorageFailure> | Schemas.StorageUnavailable;

  return Effect.catch(operation, (failure): Effect.Effect<never, Public> =>
    failure instanceof StorageFailure
      ? reportStorageFailure(failure).pipe(
          Effect.andThen(
            Effect.fail(new Schemas.StorageUnavailable({ operationId: failure.operationId })),
          ),
        )
      : // SAFETY: the branch above handles every StorageFailure, so what remains is E without it —
        // and every such failure is already a declared public error of its endpoint.
        Effect.fail(failure as Exclude<E, StorageFailure>),
  );
};

/**
 * The boundary for the two entry points that have no HTTP error contract to translate into: the
 * SES event consumer and the public unsubscribe POST. Neither may report success for work that did
 * not persist, so the failure still ends the invocation — it is only recorded on the way past.
 * Lambda retries the consumer and a mail provider gets a 500 rather than a false acknowledgement.
 */
export const reportedAndFatal = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.tapError((failure) =>
      failure instanceof StorageFailure ? reportStorageFailure(failure) : Effect.void,
    ),
    Effect.orDie,
  );
