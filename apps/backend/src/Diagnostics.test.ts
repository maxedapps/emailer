import * as Schemas from "@emailer/api/Schemas";
import { Data, Effect, Logger, Result } from "effect";
import { describe, expect, it } from "vitest";

import { describeCause, publicly, reportedAndFatal } from "./Diagnostics.ts";
import { StorageFailure } from "./Storage/Errors.ts";

/** A cause that carries exactly the kind of payload the log must never repeat. */
class LeakySdkError extends Data.TaggedError("LeakySdkError")<{
  readonly Item: unknown;
  readonly token: string;
}> {}

const mailbox = "max@example.com";

interface Entry {
  readonly level: string;
  readonly message: unknown;
}

/**
 * Captures what the boundary actually recorded, rather than trusting that it recorded something.
 * `Effect.logError(message, data)` reaches a logger as `[message, data]`, so a test can assert the
 * recorded fields exactly — which is how "nothing else was recorded" becomes checkable.
 */
const collecting = (entries: Array<Entry>) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push({ level: options.logLevel, message: options.message });
    }),
  ]);

const recorded = <A, E>(operation: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const entries: Array<Entry> = [];
    const attempt = yield* Effect.result(operation).pipe(Effect.provide(collecting(entries)));

    // SAFETY: the collector stores each logger's `message` verbatim, and Effect delivers
    // `logError(message, data)` as the pair `[message, data]`.
    const first = entries[0]?.message as ReadonlyArray<unknown> | undefined;

    return { attempt, entries, fields: first?.[1] };
  });

// An SDK exception names itself; an Effect failure tags itself. Both must reduce
// to that name and nothing more.
const sdk = { name: "ProvisionedThroughputExceededException", $metadata: { requestId: "r-1" } };

const unavailable = (cause: unknown) =>
  new StorageFailure({ operationId: "getContact", reason: "unavailable", cause });

describe("describeCause", () => {
  it.each([
    [unavailable("x"), "StorageFailure"],
    [sdk, "ProvisionedThroughputExceededException"],
    // A defect that reaches the log is a native error, whose `name` lives on the prototype.
    [new TypeError("boom"), "TypeError"],
    [new Error("boom"), "Error"],
    ["plain", "unknown"],
    [undefined, "unknown"],
    [null, "unknown"],
    [{ Item: { email: { S: mailbox } } }, "unknown"],
  ])("names %o as a classification rather than a payload", (cause, expected) => {
    expect(describeCause(cause)).toBe(expected);
  });
});

describe("publicly", () => {
  it("converts a storage failure into the public error, once, at the boundary", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { attempt } = yield* recorded(publicly(Effect.fail(unavailable(sdk))));

        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.StorageUnavailable({ operationId: "getContact" }),
        );
      }),
    ));

  it("records one actionable diagnostic: the operation, its classification and the cause's name", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { entries, fields } = yield* recorded(publicly(Effect.fail(unavailable(sdk))));

        expect(entries).toHaveLength(1);
        expect(entries[0]?.level).toBe("Error");
        expect(fields).toStrictEqual({
          operationId: "getContact",
          reason: "unavailable",
          cause: "ProvisionedThroughputExceededException",
        });
      }),
    ));

  it("records no raw cause, so an SDK payload cannot reach the log through it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const leaky = new LeakySdkError({
          Item: { email: { S: mailbox } },
          token: "v1.secret.aaa",
        });

        const { attempt, fields } = yield* recorded(publicly(Effect.fail(unavailable(leaky))));

        // Exactly these three fields: the item and the token the cause was carrying
        // have no way through, because nothing copies the cause itself.
        expect(fields).toStrictEqual({
          operationId: "getContact",
          reason: "unavailable",
          cause: "LeakySdkError",
        });
        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.StorageUnavailable({ operationId: "getContact" }),
        );
      }),
    ));

  it("leaves an expected public error untouched and unlogged", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const expected = new Schemas.NotFound({ entity: "contact" });

        const { attempt, entries } = yield* recorded(publicly(Effect.fail(expected)));

        expect(Result.isFailure(attempt) && attempt.failure).toBe(expected);
        expect(entries).toHaveLength(0);
      }),
    ));

  it("leaves a success alone", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { attempt, entries } = yield* recorded(publicly(Effect.succeed("kept")));

        expect(Result.isSuccess(attempt) && attempt.success).toBe("kept");
        expect(entries).toHaveLength(0);
      }),
    ));
});

describe("reportedAndFatal", () => {
  // The feedback consumer and the unsubscribe POST have no error contract to
  // translate into. Recording the failure must not turn it into a success:
  // Lambda has to retry, and a mail provider must not read a 2xx.
  it("records the failure and still ends the invocation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { attempt, entries } = yield* recorded(
          Effect.exit(reportedAndFatal(Effect.fail(unavailable(sdk)))),
        );

        const outcome = Result.isSuccess(attempt) ? attempt.success : undefined;

        expect(outcome?._tag).toBe("Failure");
        expect(entries).toHaveLength(1);
      }),
    ));

  it("leaves a success a success", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { attempt, entries } = yield* recorded(reportedAndFatal(Effect.succeed("done")));

        expect(Result.isSuccess(attempt) && attempt.success).toBe("done");
        expect(entries).toHaveLength(0);
      }),
    ));
});
