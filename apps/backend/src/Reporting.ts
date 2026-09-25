import { Data, Effect, ErrorReporter } from "effect";
import { HttpServerError } from "effect/unstable/http";

import type { HttpServerResponse } from "effect/unstable/http";

/**
 * How every function reports a failure: one structured line with the error's tag and the attributes
 * the error itself declares, never its message or cause, which is where addresses, tokens and SDK
 * payloads live. Business errors are annotated as ignored and never get here, so whatever does is a
 * real failure: an unannotated one is logged as an error rather than at Effect's default `Info`.
 *
 * One instance for every function: a reporter skips a failure it has already seen, which is what
 * keeps a defect that `HttpApiBuilder` reports and the boundary reports again to one line.
 */
const reporter = ErrorReporter.make(({ error, severity, attributes, fiber }) =>
  Effect.runSyncWith(fiber.context)(
    Effect.logWithLevel(severity === "Info" ? "Error" : severity)("operation failed", {
      error: error.name,
      ...attributes,
    }),
  ),
);

/** Part of every function's services, so every boundary inside them sees the reporter. */
export const ReportingLive = ErrorReporter.layer([reporter]);

/**
 * The HTTP functions' boundary, inside their services. A failure gets the response Effect's own
 * boundary gives it — a router's 404 for an unknown path, 499 for a client abort, an empty 500 for
 * everything else — and is reported here, so no cause reaches Alchemy's boundary, which would log
 * it whole.
 */
export const respondingToFailures = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.catchCause(handler, (cause) =>
    HttpServerError.causeResponse(cause).pipe(
      Effect.flatMap(([response, reportable]) =>
        ErrorReporter.report(reportable).pipe(Effect.as(response)),
      ),
    ),
  );

/** What a failed queue invocation throws once its cause has been reported: nothing more. */
export class InvocationFailed extends Data.TaggedError("InvocationFailed") {}

/**
 * The queue consumers' boundary, inside their services. The invocation still fails, so SQS
 * delivers the message again and finally dead-letters it, but what the Lambda runtime logs is this
 * one bare error rather than the cause.
 */
export const failingInvocation = <A, E, R>(invocation: Effect.Effect<A, E, R>) =>
  Effect.catchCause(invocation, (cause) =>
    ErrorReporter.report(cause).pipe(Effect.andThen(Effect.die(new InvocationFailed()))),
  );
