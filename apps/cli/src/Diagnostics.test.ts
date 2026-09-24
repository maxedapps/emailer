import * as Schemas from "@emailer/api/Schemas";
import {
  Cause,
  Config,
  ConfigProvider,
  Console,
  Data,
  Effect,
  Exit,
  Runtime,
  Schema,
} from "effect";
import { HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { reporting, shouldReport } from "./Diagnostics.ts";

class Refused extends Data.TaggedError("Refused")<{ readonly detail: string }> {}

/** What the CLI framework raises once it has already written its own output. */
class AlreadyRendered extends Data.TaggedError("AlreadyRendered") {
  override readonly [Runtime.errorReported] = false;
}

/**
 * Captures what reached stderr, so "reported exactly once" is checkable rather than assumed.
 *
 * `Console` is an Effect service, so the substitute is provided rather than assigned over a
 * global: the test observes what the reporter asked for, and anything it wrote through some other
 * path would not be captured — which is the point, since stdout must stay clean.
 */
const capturing = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const written: Array<string> = [];
    const printed: Array<string> = [];

    // Delegates everything else to the real console through the prototype chain, so only the two
    // streams this reporter can write to are observed.
    // SAFETY: the prototype is the real Console, so the created object satisfies the interface
    // before the two overrides below replace the only members under test.
    const console: Console.Console = Object.assign(
      Object.create(yield* Effect.service(Console.Console)) as Console.Console,
      {
        error: (...parts: ReadonlyArray<unknown>) => {
          written.push(parts.map(String).join(" "));
        },
        log: (...parts: ReadonlyArray<unknown>) => {
          printed.push(parts.map(String).join(" "));
        },
      },
    );

    const exit = yield* Effect.exit(program).pipe(Effect.provideService(Console.Console, console));

    return { exit, written, printed, text: written.join("\n") };
  });

describe("shouldReport", () => {
  it("reports an ordinary failure", () => {
    expect(shouldReport(Cause.fail(new Refused({ detail: "boom" })))).toBe(true);
  });

  // Ctrl-C is the operator's own decision. A diagnostic would make it look like a fault.
  it("stays quiet for an interruption", () => {
    expect(shouldReport(Cause.interrupt())).toBe(false);
  });

  // The framework's help and validation output, and any command that printed something more
  // specific, mark themselves reported. Saying it twice is worse than not saying it.
  it("stays quiet for a failure that has already been rendered", () => {
    expect(shouldReport(Cause.fail(new AlreadyRendered()))).toBe(false);
  });

  it("reports a defect, which nothing else will have rendered", () => {
    expect(shouldReport(Cause.die(new Error("unexpected")))).toBe(true);
  });
});

describe("reporting", () => {
  it("writes one diagnostic to stderr and leaves the failure untouched", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const failure = new Refused({ detail: "credential refused" });

        const { exit, written, printed, text } = yield* capturing(reporting(Effect.fail(failure)));

        expect(written).toHaveLength(1);
        // stdout carries the command's result and nothing else.
        expect(printed).toHaveLength(0);
        expect(text).toContain("emailer:");
        expect(text).toContain("Refused");
        expect(text).toContain("credential refused");
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure);
      }),
    ));

  // Found by running the command: a duplicate --to printed 896 lines of schema tree.
  it("says a schema failure's message rather than its schema tree", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const decoding = Schema.decodeUnknownEffect(Schema.Struct({ to: Schema.String }))({
          to: 1,
        });

        const { written, text } = yield* capturing(reporting(decoding));

        expect(written).toHaveLength(1);
        expect(text).toContain('at ["to"]');
        expect(text).not.toContain("~effect/Schema");
      }),
    ));

  it("names a missing configuration value once, without a schema tree", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reading = Config.String("EMAILER_API_URL").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({})),
        );

        const { text } = yield* capturing(reporting(reading));

        expect(text.split("EMAILER_API_URL")).toHaveLength(2);
        expect(text).not.toContain("~effect/Schema");
      }),
    ));

  // Found by running the command: a refused connection printed `"cause": {}`.
  it("says a transport failure and what caused it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const refused = new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: HttpClientRequest.get("http://127.0.0.1:59999/contacts"),
            cause: new TypeError("fetch failed", {
              cause: new Error("connect ECONNREFUSED 127.0.0.1:59999"),
            }),
          }),
        });

        const { text } = yield* capturing(reporting(Effect.fail(refused)));

        expect(text).toMatch(
          /^emailer: Transport error \(GET .+\): fetch failed: connect ECONNREFUSED 127\.0\.0\.1:59999$/,
        );
      }),
    ));

  it("still prints a contract error's fields, which are its diagnostic", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { text } = yield* capturing(
          reporting(Effect.fail(new Schemas.NotFound({ entity: "contact" }))),
        );

        expect(text).toContain("NotFound");
        expect(text).toContain('"entity": "contact"');
      }),
    ));

  it("reports a failure raised while services are still being provided", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // The reporter wraps provisioning, not just the command body, so a missing configuration
        // read is reported the same way a refused request is.
        const provisioning = Effect.map(
          Effect.fail(new Refused({ detail: "no config" })),
          () => "never",
        );

        const { text } = yield* capturing(reporting(provisioning));

        expect(text).toContain("no config");
      }),
    ));

  it("says nothing for a success", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { exit, written } = yield* capturing(reporting(Effect.succeed("done")));

        expect(Exit.isSuccess(exit) && exit.value).toBe("done");
        expect(written).toHaveLength(0);
      }),
    ));

  it("says nothing a second time for a failure the command already printed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const failure = new AlreadyRendered();

        const { exit, written } = yield* capturing(reporting(Effect.fail(failure)));

        expect(written).toHaveLength(0);
        // Silent, but still a failure: the exit code is what tells a script the command did not land.
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ));

  it("says nothing for an interruption but still ends as one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { exit, written } = yield* capturing(reporting(Effect.interrupt));

        expect(written).toHaveLength(0);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }),
    ));

  it("reports an unexpected defect rather than letting it pass unremarked", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { exit, text } = yield* capturing(
          reporting(Effect.die(new Error("rendering went wrong"))),
        );

        expect(text).toContain("rendering went wrong");
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ));
});
