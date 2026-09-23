import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node";
import { fromChain } from "@distilled.cloud/aws/Credentials";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as sqs from "@distilled.cloud/aws/sqs";
import {
  Cause,
  Console,
  Data,
  Duration,
  Effect,
  Inspectable,
  Layer,
  Option,
  Runtime,
  Schema,
} from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import type { Credentials } from "@distilled.cloud/aws/Credentials";

type AwsClient = Credentials | HttpClient.HttpClient;

/**
 * Replays feedback events that Lambda accepted, failed to process, and parked on the failure
 * queue. It is deliberately a command an operator runs, not a worker: an automatic consumer would
 * be a second retry loop with its own lifecycle, and nothing so far has needed one.
 *
 * It does one message at a time, checks the result before acknowledging it, and stops on the first
 * problem. The conditional writes in `Storage/Feedback.ts` make a replayed event a no-op if it did
 * land after all, so replaying something twice is safe and replaying something never is not.
 */

/** A new invocation's own bound. Shorter than the queue's visibility timeout, deliberately. */
const invokeTimeout = Duration.seconds(45);

const longPoll = 20;

/** Lambda's asynchronous failure record. Only the parts this tool acts on are described. */
const FailureRecord = Schema.Struct({
  requestContext: Schema.Struct({
    requestId: Schema.String,
    functionArn: Schema.String,
    condition: Schema.optional(Schema.String),
    approximateInvokeCount: Schema.optional(Schema.Finite),
  }),
  requestPayload: Schema.Unknown,
});

const decodeFailureRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(FailureRecord));

/** The original payload, re-serialized exactly as it arrived, for the fresh invocation. */
const encodePayload = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export class ReplayRefused extends Data.TaggedError("ReplayRefused")<{
  readonly reason:
    | "malformed-envelope"
    | "wrong-target"
    | "invoke-failed"
    | "handler-failed"
    | "delete-failed";
  readonly messageId: string;
  readonly detail: string;
}> {}

/**
 * A record names the function it came from, and AWS writes that ARN **qualified**: the example in
 * the destination documentation ends in `:$LATEST`, while a stack output is unqualified. Both
 * spellings of the configured function are accepted and nothing else is — a different account,
 * region, function or version is refused rather than invoked.
 *
 * The target that actually gets invoked is the configured one, never the one the message named.
 * Otherwise a message placed on the queue could direct an invocation anywhere.
 */
export const namesConfiguredFunction = (configured: string, presented: string): boolean =>
  presented === configured || presented === `${configured}:$LATEST`;

/** A synchronous invoke that returned HTTP 200 with a FunctionError did not succeed. */
export const invocationSucceeded = (result: {
  readonly StatusCode?: number | undefined;
  readonly FunctionError?: string | undefined;
}): boolean => result.StatusCode === 200 && result.FunctionError === undefined;

interface Settings {
  readonly queueUrl: string;
  readonly functionArn: string;
  readonly maxMessages: number;
}

/**
 * The three AWS calls this command makes, as callables already bound to their client — the same
 * shape `TableOperations` has, and for the same reason: the decisions below are worth testing
 * without AWS, and a module-level import is not a seam.
 */
export interface ReplayOperations {
  readonly receiveMessage: (
    request: sqs.ReceiveMessageRequest,
  ) => Effect.Effect<sqs.ReceiveMessageResult, sqs.ReceiveMessageError>;
  readonly invoke: (
    request: lambda.InvocationRequest,
  ) => Effect.Effect<lambda.InvocationResponse, lambda.InvokeError>;
  readonly deleteMessage: (
    request: sqs.DeleteMessageRequest,
  ) => Effect.Effect<sqs.DeleteMessageResponse, sqs.DeleteMessageError>;
}

/** Binds each call to the ambient AWS client once, so the operations themselves need no context. */
const awsOperations = Effect.gen(function* () {
  const client = yield* Effect.context<AwsClient>();

  return {
    receiveMessage: (request) => Effect.provideContext(sqs.receiveMessage(request), client),
    invoke: (request) => Effect.provideContext(lambda.invoke(request), client),
    deleteMessage: (request) => Effect.provideContext(sqs.deleteMessage(request), client),
  } satisfies ReplayOperations;
});

const replayOne = Effect.fn("ReplayFeedback.replayOne")(function* (
  operations: ReplayOperations,
  settings: Settings,
  message: sqs.Message,
) {
  const messageId = message.MessageId ?? "unknown";

  const record = yield* decodeFailureRecord(message.Body ?? "").pipe(
    Effect.mapError(
      () =>
        new ReplayRefused({
          reason: "malformed-envelope",
          messageId,
          detail: "the body is not a Lambda asynchronous failure record",
        }),
    ),
  );

  if (!namesConfiguredFunction(settings.functionArn, record.requestContext.functionArn)) {
    return yield* new ReplayRefused({
      reason: "wrong-target",
      messageId,
      detail: "the record names a function this command is not configured to invoke",
    });
  }

  // The original failure metadata is expected — it is why the record exists — and says nothing
  // about whether a fresh attempt will work. It is reported, not treated as a reason to refuse.
  yield* Console.error(
    `emailer: replaying ${messageId} (request ${record.requestContext.requestId}, ` +
      `${record.requestContext.condition ?? "unknown condition"}, ` +
      `${record.requestContext.approximateInvokeCount ?? 0} prior attempts)`,
  );

  const result = yield* operations
    .invoke({
      FunctionName: settings.functionArn,
      InvocationType: "RequestResponse",
      // Re-serializing a value that was just parsed from JSON cannot fail operationally; if it
      // ever did it would be a defect in this file, not something the operator can act on.
      Payload: new TextEncoder().encode(yield* Effect.orDie(encodePayload(record.requestPayload))),
    })
    .pipe(
      Effect.timeout(invokeTimeout),
      Effect.mapError(
        (cause) =>
          new ReplayRefused({
            reason: "invoke-failed",
            messageId,
            detail: cause._tag,
          }),
      ),
    );

  if (!invocationSucceeded(result)) {
    return yield* new ReplayRefused({
      reason: "handler-failed",
      messageId,
      detail: `status ${result.StatusCode ?? 0}, ${result.FunctionError ?? "no function error"}`,
    });
  }

  // Only now. Deleting on the strength of the call having returned would drop an event whose
  // handler raised, which is the failure this queue exists to survive.
  yield* operations
    .deleteMessage({ QueueUrl: settings.queueUrl, ReceiptHandle: message.ReceiptHandle ?? "" })
    .pipe(
      Effect.mapError(
        (cause) => new ReplayRefused({ reason: "delete-failed", messageId, detail: cause._tag }),
      ),
    );

  yield* Console.log(`emailer: replayed ${messageId}`);
});

export const replay = Effect.fn("ReplayFeedback.replay")(function* (
  operations: ReplayOperations,
  settings: Settings,
) {
  let replayed = 0;

  while (replayed < settings.maxMessages) {
    const received = yield* operations.receiveMessage({
      QueueUrl: settings.queueUrl,
      // One at a time: each is invoked and acknowledged before the next is taken, so a stop
      // leaves everything not yet handled on the queue rather than in flight.
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: longPoll,
    });

    const message = Option.fromUndefinedOr(received.Messages?.[0]);

    if (Option.isNone(message)) {
      break;
    }

    yield* replayOne(operations, settings, message.value);

    replayed += 1;
  }

  // An empty receive means none were available in this poll, which is not the same as the queue
  // being empty: SQS samples its servers. Say what was done, not what is left.
  yield* Console.log(`emailer: replayed ${replayed} message(s)`);

  return replayed;
});

const command = Command.make(
  "replay-feedback",
  {
    queueUrl: Flag.String("queue-url").pipe(
      Flag.withDescription("The failure queue's URL, from the stack's feedbackFailureQueueUrl"),
    ),
    functionArn: Flag.String("function-arn").pipe(
      Flag.withDescription("The feedback function's ARN, from the stack's feedbackFunctionArn"),
    ),
    maxMessages: Flag.Int("max-messages").pipe(
      Flag.withDescription("How many messages to replay before stopping"),
      Flag.withDefault(10),
    ),
  },
  Effect.fn(function* (settings) {
    yield* replay(yield* awsOperations, settings);
  }),
).pipe(Command.withDescription("Replay feedback events Lambda could not process"));

/**
 * A refusal's fields *are* the diagnostic — which message, and why. `Cause.pretty` renders a tagged
 * error as its bare name and a stack trace through this file, which tells an operator nothing, so
 * an expected failure is inspected and only an unexpected one gets the trace.
 */
export const renderCause = (cause: Cause.Cause<unknown>): string =>
  Cause.hasFails(cause) ? Inspectable.toStringUnknown(Cause.squash(cause)) : Cause.pretty(cause);

/**
 * Whether this tool should say anything at all. The operator's own Ctrl-C is not a fault, and a
 * failure carrying Effect's already-reported marker has been rendered by whoever raised it — the
 * CLI framework's help and validation output raises `ShowHelp` that way, and printing the raw
 * value again would dump framework internals on top of the message it already wrote.
 *
 * The same policy as `apps/cli/src/Diagnostics.ts`. It is stated twice because the two entry
 * points are in different apps and neither depends on the other; the wording of what each prints
 * is their own.
 */
export const shouldReport = (cause: Cause.Cause<unknown>): boolean =>
  !Cause.hasInterruptsOnly(cause) && Runtime.getErrorReported(Cause.squash(cause));

/**
 * The one place a failure becomes operator-visible output, on stderr — stdout carries the replayed
 * message ids and nothing else, so a run that fails halfway still leaves a readable result.
 */
const reportCause = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  shouldReport(cause)
    ? Console.error(`emailer: replay stopped — ${renderCause(cause)}`)
    : Effect.void;

const awsClient = Layer.mergeAll(FetchHttpClient.layer, fromChain(), NodeCrypto.layer);

// Only when run as the operator command. Its suite imports this module for the decisions above,
// and importing must not parse the test runner's arguments or start an invocation.
if (import.meta.main) {
  // The runner's own reporting stays disabled: it runs outside this program's context and can
  // write to stdout, which belongs to the list of message ids this tool replayed.
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, awsClient)),
    Effect.tapCause(reportCause),
    (program) => NodeRuntime.runMain(program, { disableErrorReporting: true }),
  );
}
