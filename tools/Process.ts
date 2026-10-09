/**
 * Child processes for the repository's tools. Both helpers fail on an exit code they are not told
 * to accept (only 0 by default), which Effect's own output helpers (`ChildProcessSpawner.string`,
 * `lines`) do not check.
 */
import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly message: string;
}> {}

export interface ReadOptions {
  /** The directory the command runs in; the tool's own by default. */
  readonly cwd?: string | undefined;
  /** Text written to the command's standard input. */
  readonly input?: string | undefined;
  /** The exit codes that pass, such as grep's 1 for "no match". */
  readonly exitCodes?: ReadonlyArray<number>;
}

const succeeded = (
  command: string,
  args: ReadonlyArray<string>,
  exitCode: number,
  exitCodes: ReadonlyArray<number> = [0],
) =>
  exitCodes.includes(exitCode)
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
export const read = Effect.fn(function* (
  command: string,
  args: ReadonlyArray<string>,
  { cwd, input, exitCodes }: ReadOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      cwd,
      stdin: input === undefined ? undefined : Stream.encodeText(Stream.make(input)),
      stderr: "inherit",
    }),
  );

  const [output, exitCode] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
    { concurrency: "unbounded" },
  );

  yield* succeeded(command, args, exitCode, exitCodes);

  return output;
}, Effect.scoped);
