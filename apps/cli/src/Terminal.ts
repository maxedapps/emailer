import { NodeTerminal } from "@effect/platform-node";
import { Effect, Layer, Stdio, Stream, Terminal } from "effect";
import { CliError, Prompt } from "effect/unstable/cli";

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
  Prompt.confirm({ message }).pipe(
    Effect.catchTag("QuitError", (cause) =>
      Effect.fail(
        new CliError.UserError({
          cause,
          userMessage: "No answer was given; pass --yes to proceed without the question",
        }),
      ),
    ),
  );
