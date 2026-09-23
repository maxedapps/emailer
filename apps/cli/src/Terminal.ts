import { NodeTerminal } from "@effect/platform-node";
import { Effect, Layer, Stdio, Stream, Terminal } from "effect";
import { CliError, Prompt } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/**
 * Node's terminal — keypresses from stdin, raw mode — with every write and measurement moved to
 * stderr. Stdout carries a command's result and nothing else, so a prompt written there would
 * land in `emailer … | jq`.
 */
export const stderrTerminal = Layer.effect(Terminal.Terminal)(
  Effect.gen(function* () {
    const terminal = yield* NodeTerminal.make();
    const stdio = yield* Stdio.Stdio;

    return Terminal.make({
      readInput: terminal.readInput,
      readLine: terminal.readLine,
      columns: Effect.sync(() => process.stderr.columns ?? 0),
      rows: Effect.sync(() => process.stderr.rows ?? 0),
      display: (text) => Stream.run(Stream.make(text), stdio.stderr({ endOnDone: false })),
    });
  }),
);

/**
 * A yes/no question on stderr. Without an answer — stdin closed by a script or a pipe, or the
 * prompt aborted — the command stops and says how to proceed without asking.
 */
export const confirm = (message: string) =>
  Prompt.Confirm({ message }).pipe(
    Effect.catchTag("QuitError", (cause) =>
      Effect.fail(
        new CliError.UserError({
          cause,
          userMessage: "No answer was given; pass --yes to proceed without the question",
        }),
      ),
    ),
  );

const opener = process.platform === "darwin" ? "open" : "xdg-open";

/**
 * Hands a URL to the desktop's opener without waiting for it: detached, with no stdio ties and
 * unreferenced, so neither the scope's finalizer nor Node's event loop holds the command open.
 */
export const openInBrowser = (url: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(opener, [url], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );

    // `unref` answers the effect that would re-reference the child; nothing ever will.
    yield* Effect.asVoid(handle.unref);
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new CliError.UserError({
          cause,
          userMessage: `Could not start ${opener}; open the printed link in any browser`,
        }),
    ),
  );
