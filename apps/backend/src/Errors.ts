import { Data, Effect, ErrorReporter, Predicate } from "effect";

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

/** The fields of every public dependency error. */
interface DependencyFailure {
  readonly operation: string;
  readonly failure: string;
}

/**
 * Classifies a failed dependency call once, where it happens: `Effect.mapError(unavailable(
 * StorageUnavailable, "getContact"))`. The cause itself goes no further than its name.
 */
export const unavailable =
  <E>(Unavailable: new (fields: DependencyFailure) => E, operation: string) =>
  (cause: unknown): E =>
    new Unavailable({ operation, failure: describeCause(cause) });

/**
 * A stored item this code cannot read. It is a defect rather than an answer: nothing a caller does
 * changes it, so it ends the request with a 500 or fails the invocation. The item's values stay out
 * of it, because they are the addresses and content the log must never hold.
 */
export class CorruptItem extends Data.TaggedError("CorruptItem")<{ readonly operation: string }> {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation };
  }
}

/** Turns a failed decode of a stored item into the `CorruptItem` defect. */
export const corrupt =
  (operation: string) =>
  <A, E, R>(decoded: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
    Effect.catch(decoded, () => Effect.die(new CorruptItem({ operation })));
