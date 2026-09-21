import * as lambda from "@distilled.cloud/aws/lambda";
import * as sqs from "@distilled.cloud/aws/sqs";
import { Cause, Data, Effect, Result, Runtime, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  invocationSucceeded,
  namesConfiguredFunction,
  renderCause,
  replay,
  shouldReport,
  ReplayRefused,
} from "./ReplayFeedback.ts";

import type { ReplayOperations } from "./ReplayFeedback.ts";

/** Unwraps the refusal a case expects, rather than asserting a hand-written tagged shape. */
const refusalOf = <A, E>(attempt: Result.Result<A, E>): ReplayRefused => {
  const failure = Result.isFailure(attempt) ? attempt.failure : undefined;

  if (!(failure instanceof ReplayRefused)) {
    throw new Error(`Expected the replay to be refused, got ${String(failure)}`);
  }

  return failure;
};

const decodeSentPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const functionArn = "arn:aws:lambda:eu-central-1:123456789012:function:emailer-test-feedback";

const queueUrl =
  "https://sqs.eu-central-1.amazonaws.com/123456789012/emailer-test-FeedbackFailures";

const requestPayload = {
  version: "0",
  id: "8f7e6d5c-4b3a-2910-8f7e-6d5c4b3a2910",
  "detail-type": "Email Bounce",
  source: "aws.ses",
  detail: {
    eventType: "Bounce",
    mail: {
      messageId: "0100019-deadbeef",
      tags: { "ses:configuration-set": ["emailer-test-mail"], campaignId: ["c-1"] },
    },
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: "bounce@simulator.amazonses.com" }],
      feedbackId: "0100019a-6c6f-4a39-8f12-0b2f9c3d4e5f",
    },
  },
};

/**
 * AWS's shape, with the qualification it actually writes. The stack output is unqualified, so a
 * fixture that dropped `:$LATEST` would pass against a comparison that rejects every real record.
 */
const envelope = (recordedArn: string = `${functionArn}:$LATEST`) =>
  JSON.stringify({
    version: "1.0",
    timestamp: "2026-09-14T09:00:00.000Z",
    requestContext: {
      requestId: "b1f4c3d2-1111-4222-8333-44444444e5d1",
      functionArn: recordedArn,
      condition: "RetriesExhausted",
      approximateInvokeCount: 3,
    },
    requestPayload,
    // The original attempt's failure. Every record carries one — it is why the record exists —
    // so a replay that treated it as a reason to refuse would never repair anything.
    responseContext: { statusCode: 200, functionError: "Unhandled", executedVersion: "$LATEST" },
    responsePayload: { errorType: "StorageFailure", errorMessage: "unavailable" },
  });

const message = (body: string, id = "m-1"): sqs.Message => ({
  MessageId: id,
  ReceiptHandle: `receipt-${id}`,
  Body: body,
});

interface World {
  readonly operations: ReplayOperations;
  readonly received: Array<sqs.ReceiveMessageRequest>;
  readonly invoked: Array<lambda.InvocationRequest>;
  readonly deleted: Array<sqs.DeleteMessageRequest>;
}

interface Scenario {
  readonly messages?: ReadonlyArray<ReadonlyArray<sqs.Message>>;
  readonly invokeResult?: lambda.InvocationResponse;
  readonly invokeFails?: boolean;
  readonly deleteFails?: boolean;
}

const world = (scenario: Scenario): World => {
  const received: Array<sqs.ReceiveMessageRequest> = [];
  const invoked: Array<lambda.InvocationRequest> = [];
  const deleted: Array<sqs.DeleteMessageRequest> = [];

  const operations = {
    receiveMessage: (request: sqs.ReceiveMessageRequest) => {
      received.push(request);

      return Effect.succeed({ Messages: [...(scenario.messages?.[received.length - 1] ?? [])] });
    },
    invoke: (request: lambda.InvocationRequest) => {
      invoked.push(request);

      return scenario.invokeFails === true
        ? Effect.fail(new lambda.ServiceException({ Type: "Service", message: "unavailable" }))
        : Effect.succeed(scenario.invokeResult ?? { StatusCode: 200 });
    },
    deleteMessage: (request: sqs.DeleteMessageRequest) => {
      deleted.push(request);

      return scenario.deleteFails === true
        ? Effect.fail(new sqs.ReceiptHandleIsInvalid({ message: "the receipt handle has expired" }))
        : Effect.succeed({});
    },
  } satisfies ReplayOperations;

  return { operations, received, invoked, deleted };
};

const settings = { queueUrl, functionArn, maxMessages: 10 };

describe("namesConfiguredFunction", () => {
  // AWS writes the ARN qualified; the stack output is unqualified. Both spellings of *this*
  // function are the same function, and nothing else is.
  it.each([
    [functionArn, true],
    [`${functionArn}:$LATEST`, true],
    [`${functionArn}:3`, false],
    [`${functionArn}:PROD`, false],
    ["arn:aws:lambda:eu-central-1:123456789012:function:emailer-prod-feedback", false],
    ["arn:aws:lambda:us-east-1:123456789012:function:emailer-test-feedback", false],
    ["arn:aws:lambda:eu-central-1:999999999999:function:emailer-test-feedback", false],
    [`${functionArn}-other`, false],
  ])("judges %s as %s", (presented, expected) => {
    expect(namesConfiguredFunction(functionArn, presented)).toBe(expected);
  });
});

describe("invocationSucceeded", () => {
  // The one that matters: Lambda answers HTTP 200 for a handler that threw, and says so only in
  // FunctionError. Treating the status alone as success would acknowledge an event that failed
  // again, which is exactly the loss the queue exists to prevent.
  it.each([
    [{ StatusCode: 200 }, true],
    [{ StatusCode: 200, FunctionError: "Unhandled" }, false],
    [{ StatusCode: 200, FunctionError: "Handled" }, false],
    [{ StatusCode: 202 }, false],
    [{ StatusCode: 500 }, false],
    [{}, false],
  ])("judges %o as %s", (result, expected) => {
    expect(invocationSucceeded(result)).toBe(expected);
  });
});

describe("replay", () => {
  it("invokes the configured target with the original payload and then acknowledges", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracked = world({ messages: [[message(envelope())], []] });

        const attempt = yield* Effect.result(replay(tracked.operations, settings));

        expect(Result.isSuccess(attempt) && attempt.success).toBe(1);
        expect(tracked.invoked).toHaveLength(1);
        expect(tracked.invoked[0]?.FunctionName).toBe(functionArn);
        expect(tracked.invoked[0]?.InvocationType).toBe("RequestResponse");

        const payload = tracked.invoked[0]?.Payload;

        // The payload goes on the wire as bytes, and it must be the original event verbatim.
        expect(payload).toBeInstanceOf(Uint8Array);

        const sent = yield* decodeSentPayload(
          new TextDecoder().decode(payload instanceof Uint8Array ? payload : new Uint8Array()),
        );

        expect(sent).toStrictEqual(requestPayload);
        expect(tracked.deleted).toStrictEqual([
          { QueueUrl: queueUrl, ReceiptHandle: "receipt-m-1" },
        ]);
      }),
    ));

  it("takes one message at a time and stops when a poll comes back empty", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracked = world({
          messages: [[message(envelope(), "m-1")], [message(envelope(), "m-2")], []],
        });

        const attempt = yield* Effect.result(replay(tracked.operations, settings));

        expect(Result.isSuccess(attempt) && attempt.success).toBe(2);
        expect(tracked.received.every((request) => request.MaxNumberOfMessages === 1)).toBe(true);
        expect(tracked.received[0]?.WaitTimeSeconds).toBe(20);
        expect(tracked.deleted.map((request) => request.ReceiptHandle)).toStrictEqual([
          "receipt-m-1",
          "receipt-m-2",
        ]);
      }),
    ));

  it("stops at the requested count rather than draining the queue", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracked = world({
          messages: [[message(envelope(), "m-1")], [message(envelope(), "m-2")]],
        });

        const attempt = yield* Effect.result(
          replay(tracked.operations, { ...settings, maxMessages: 1 }),
        );

        expect(Result.isSuccess(attempt) && attempt.success).toBe(1);
        expect(tracked.invoked).toHaveLength(1);
      }),
    ));

  it("reports nothing replayed when the queue has nothing available", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracked = world({ messages: [[]] });

        const attempt = yield* Effect.result(replay(tracked.operations, settings));

        expect(Result.isSuccess(attempt) && attempt.success).toBe(0);
        expect(tracked.invoked).toHaveLength(0);
        expect(tracked.deleted).toHaveLength(0);
      }),
    ));

  it.each([
    ["a body that is not a failure record", "not json at all"],
    ["a record missing its request context", JSON.stringify({ requestPayload })],
  ])("refuses %s without invoking or acknowledging", (_label, body) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracked = world({ messages: [[message(body)]] });

        const attempt = yield* Effect.result(replay(tracked.operations, settings));

        expect(refusalOf(attempt).reason).toBe("malformed-envelope");
        expect(tracked.invoked).toHaveLength(0);
        expect(tracked.deleted).toHaveLength(0);
      }),
    ),
  );

  // A message on the queue must not be able to direct an invocation somewhere else.
  it("refuses a record naming another function without invoking anything", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const alien = envelope("arn:aws:lambda:eu-central-1:999999999999:function:someone-elses");

        const tracked = world({ messages: [[message(alien)]] });

        const attempt = yield* Effect.result(replay(tracked.operations, settings));

        expect(refusalOf(attempt).reason).toBe("wrong-target");
        expect(tracked.invoked).toHaveLength(0);
        expect(tracked.deleted).toHaveLength(0);
      }),
    ));

  // The original failure metadata is why the record exists. It must not stop the repair.
  it("replays a record whose original attempt failed, which is every record", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracked = world({ messages: [[message(envelope())], []] });

        yield* Effect.result(replay(tracked.operations, settings));

        expect(tracked.invoked).toHaveLength(1);
        expect(tracked.deleted).toHaveLength(1);
      }),
    ));

  it("leaves the message when the new invocation reports a handler failure", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracked = world({
          messages: [[message(envelope())]],
          invokeResult: { StatusCode: 200, FunctionError: "Unhandled" },
        });

        const attempt = yield* Effect.result(replay(tracked.operations, settings));

        expect(refusalOf(attempt).reason).toBe("handler-failed");
        expect(tracked.invoked).toHaveLength(1);
        expect(tracked.deleted).toHaveLength(0);
      }),
    ));

  it("leaves the message when the invocation itself could not be made", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracked = world({ messages: [[message(envelope())]], invokeFails: true });

        const attempt = yield* Effect.result(replay(tracked.operations, settings));

        expect(refusalOf(attempt).reason).toBe("invoke-failed");
        expect(tracked.deleted).toHaveLength(0);
      }),
    ));

  // The work is already done at this point, and the conditional writes make a repeat harmless.
  // Reporting it is still right: the message will come back and someone should know why.
  it("reports a failed acknowledgement rather than claiming the replay finished", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracked = world({ messages: [[message(envelope())]], deleteFails: true });

        const attempt = yield* Effect.result(replay(tracked.operations, settings));

        expect(refusalOf(attempt).reason).toBe("delete-failed");
        expect(tracked.invoked).toHaveLength(1);
        expect(tracked.deleted).toHaveLength(1);
      }),
    ));

  it("stops at the first refusal rather than working through the rest", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tracked = world({
          messages: [[message("not json at all", "m-1")], [message(envelope(), "m-2")]],
        });

        yield* Effect.result(replay(tracked.operations, settings));

        expect(tracked.received).toHaveLength(1);
        expect(tracked.invoked).toHaveLength(0);
      }),
    ));
});

describe("renderCause", () => {
  // Found by running the command: a refusal printed as the bare word "ReplayRefused" followed by a
  // stack trace through this file, which tells an operator nothing about which message or why.
  it("prints a refusal's fields rather than its name and a stack trace", () => {
    const rendered = renderCause(
      Cause.fail(
        new ReplayRefused({ reason: "wrong-target", messageId: "m-1", detail: "another function" }),
      ),
    );

    expect(rendered).toContain("wrong-target");
    expect(rendered).toContain("m-1");
    expect(rendered).toContain("another function");
  });

  it("prints the trace for a defect, which has no fields to show", () => {
    const rendered = renderCause(Cause.die(new Error("replay went wrong")));

    expect(rendered).toContain("replay went wrong");
  });
});

describe("shouldReport", () => {
  // Found by running the command: `--queue-url` without `--function-arn` printed the framework's
  // own "Missing required flag" line, and then this tool printed the raw `ShowHelp` value on top
  // of it — Effect internals and all, including the marker saying it had already been reported.
  class AlreadyReported extends Data.TaggedError("AlreadyReported")<{ readonly detail: string }> {
    override readonly [Runtime.errorReported] = false;
  }

  it("says nothing again for a failure that reported itself", () => {
    expect(shouldReport(Cause.fail(new AlreadyReported({ detail: "missing flag" })))).toBe(false);
  });

  it("says nothing for the operator's own interruption", () => {
    expect(shouldReport(Cause.interrupt(1))).toBe(false);
  });

  it("reports a refusal, which is the whole point of the tool's stderr", () => {
    const refusal = new ReplayRefused({ reason: "wrong-target", messageId: "m-1", detail: "x" });

    expect(shouldReport(Cause.fail(refusal))).toBe(true);
    expect(shouldReport(Cause.die(new Error("boom")))).toBe(true);
  });
});
