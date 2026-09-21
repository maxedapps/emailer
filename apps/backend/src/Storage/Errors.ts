import { Data } from "effect";

/**
 * The one way persistence fails. It is deliberately internal: it names the operation that failed,
 * says whether the store was unreachable or answered something we cannot read, and keeps the
 * original cause. Nothing here knows about HTTP, and nothing here is safe to return to a caller —
 * translating it into a public error, and deciding what of it is safe to record, both belong to an
 * entry-point boundary rather than to every call site.
 *
 * This module is a leaf. It imports nothing from the rest of Storage, so every item module and
 * capability can depend on it without a composition cycle.
 */
export class StorageFailure extends Data.TaggedError("StorageFailure")<{
  readonly operationId: string;
  readonly reason: "unavailable" | "corrupt";
  readonly cause: unknown;
}> {}

/** The store could not be reached, timed out, or refused the request. */
export const unavailable = (operationId: string) => (cause: unknown) =>
  new StorageFailure({ operationId, reason: "unavailable", cause });

/** The store answered, but with an item this system cannot make sense of. */
export const corrupt = (operationId: string) => (cause: unknown) =>
  new StorageFailure({ operationId, reason: "corrupt", cause });
