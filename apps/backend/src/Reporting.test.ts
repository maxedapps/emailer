import { describe, expect, it } from "@effect/vitest";
import { ContactNotFound, StorageUnavailable } from "@emailer/api/Errors";
import { Cause, Data, Effect, ErrorReporter, Exit, Inspectable, Layer, Logger } from "effect";
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { CorruptItem } from "./Errors.ts";
import {
  failingInvocation,
  InvocationFailed,
  ReportingLive,
  respondingToFailures,
} from "./Reporting.ts";

const mailbox = "sam@example.com";

interface Line {
  readonly level: string;
  readonly message: unknown;
}

/** The reporter's lines as a logger receives them. */
const capturing = (lines: Array<Line>) =>
  Layer.mergeAll(
    ReportingLive,
    Logger.layer([
      Logger.make(({ logLevel, message }) => {
        lines.push({ level: logLevel, message });
      }),
    ]),
  );

/** Whether any line, rendered whole, holds the value: a leak cannot hide in a nested field. */
const mentions = (lines: ReadonlyArray<Line>, value: string) =>
  lines.some((line) => Inspectable.toStringUnknown(line.message).includes(value));

const reported = <A, E>(failing: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const lines: Array<Line> = [];

    yield* failing.pipe(Effect.withErrorReporting, Effect.exit, Effect.provide(capturing(lines)));

    return lines;
  });

class Overrun extends Data.TaggedError("Overrun") {
  override get [ErrorReporter.severity]() {
    return "Warn" as const;
  }
}

describe("the reporter", () => {
  it.effect("logs a dependency error's tag and declared attributes, at error level", () =>
    Effect.gen(function* () {
      const lines = yield* reported(
        Effect.fail(new StorageUnavailable({ operation: "getContact", failure: "TimeoutError" })),
      );

      expect(lines).toStrictEqual([
        {
          level: "Error",
          message: [
            "operation failed",
            { error: "StorageUnavailable", operation: "getContact", failure: "TimeoutError" },
          ],
        },
      ]);
    }),
  );

  it.effect("logs a defect as an error by its name alone, never its message", () =>
    Effect.gen(function* () {
      const lines = yield* reported(Effect.die(new Error(`decode failed for ${mailbox}`)));

      expect(lines).toStrictEqual([
        { level: "Error", message: ["operation failed", { error: "Error" }] },
      ]);
    }),
  );

  it.effect("logs a corrupt item with the operation that read it", () =>
    Effect.gen(function* () {
      const lines = yield* reported(Effect.die(new CorruptItem({ operation: "getContact" })));

      expect(lines).toStrictEqual([
        {
          level: "Error",
          message: ["operation failed", { error: "CorruptItem", operation: "getContact" }],
        },
      ]);
    }),
  );

  it.effect("keeps an annotated severity", () =>
    Effect.gen(function* () {
      const lines = yield* reported(Effect.fail(new Overrun()));

      expect(lines.map((line) => line.level)).toStrictEqual(["Warn"]);
    }),
  );

  it.effect("never logs a business error", () =>
    Effect.gen(function* () {
      expect(yield* reported(Effect.fail(new ContactNotFound()))).toStrictEqual([]);
    }),
  );
});

describe("the queue consumers' boundary", () => {
  it.effect("reports the cause once and fails the invocation with a bare error", () =>
    Effect.gen(function* () {
      const lines: Array<Line> = [];

      const exit = yield* Effect.die(new Error(`decode failed for ${mailbox}`)).pipe(
        failingInvocation,
        Effect.exit,
        Effect.provide(capturing(lines)),
      );

      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toStrictEqual(
        new InvocationFailed(),
      );
      expect(lines).toHaveLength(1);
      expect(mentions(lines, mailbox)).toBe(false);
    }),
  );
});

describe("the HTTP functions' boundary", () => {
  const handlerFor = (lines: Array<Line>) => {
    const router = HttpRouter.toHttpEffect(
      Layer.mergeAll(
        HttpRouter.add("GET", "/defect", Effect.die(new Error(`decode failed for ${mailbox}`))),
        HttpRouter.add(
          "GET",
          "/unavailable",
          Effect.fail(new StorageUnavailable({ operation: "getContact", failure: "TimeoutError" })),
        ),
        HttpRouter.add("GET", "/fine", Effect.succeed(HttpServerResponse.text("fine"))),
      ),
    );

    return Effect.map(router, (handle) =>
      HttpEffect.toWebHandler(respondingToFailures(handle).pipe(Effect.provide(capturing(lines)))),
    );
  };

  const statusOf = (path: string) =>
    Effect.gen(function* () {
      const lines: Array<Line> = [];
      const handler = yield* handlerFor(lines);
      const response = yield* Effect.promise(() => handler(new Request(`http://test${path}`)));

      return { status: response.status, lines };
    });

  it.effect("answers a defect with an empty 500 and reports it once, without the payload", () =>
    Effect.gen(function* () {
      const { status, lines } = yield* statusOf("/defect");

      expect(status).toBe(500);
      expect(lines).toHaveLength(1);
      expect(mentions(lines, mailbox)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("answers a dependency failure outside the API contract with 500, reported once", () =>
    Effect.gen(function* () {
      const { status, lines } = yield* statusOf("/unavailable");

      expect(status).toBe(500);
      expect(lines).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the router's 404 for an unknown path and reports nothing", () =>
    Effect.gen(function* () {
      const { status, lines } = yield* statusOf("/unknown");

      expect(status).toBe(404);
      expect(lines).toStrictEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a success alone", () =>
    Effect.gen(function* () {
      const { status, lines } = yield* statusOf("/fine");

      expect(status).toBe(200);
      expect(lines).toStrictEqual([]);
    }).pipe(Effect.scoped),
  );
});
