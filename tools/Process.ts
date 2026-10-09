/**
 * Child processes for the repository's tools. Both helpers fail on a non-zero exit, which Effect's
 * own output helpers (`ChildProcessSpawner.string`, `lines`) do not check.
 */
import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly message: string;
}> {}

const succeeded = (command: string, args: ReadonlyArray<string>, exitCode: number) =>
  exitCode === 0
    ? Effect.void
    : Effect.fail(
        new CommandFailed({ message: `${[command, ...args].join(" ")} exited with ${exitCode}` }),
      );

/** Runs a command in the terminal, so its progress shows as it goes. */
export const run = Effect.fn(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(command, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
  );

  yield* succeeded(command, args, exitCode);
});

/** Runs a command for its output; its diagnostics still reach the terminal. */
export const read = Effect.fn(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const handle = yield* spawner.spawn(ChildProcess.make(command, args, { stderr: "inherit" }));

  const [output, exitCode] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
    { concurrency: "unbounded" },
  );

  yield* succeeded(command, args, exitCode);

  return output;
}, Effect.scoped);
