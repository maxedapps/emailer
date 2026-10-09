/**
 * What the machine-local leak pattern matches in a change (ADR-0034): the files it changes and the
 * text of its commits. The pattern is case-insensitive grep `-E`, one alternative a line; only file
 * names and a line count ever reach the output, never the pattern or a matching line.
 */
import { Data, Duration, Effect, FileSystem } from "effect";

import * as Process from "../Process.ts";

export class PatternMissing extends Data.TaggedError("PatternMissing")<{
  readonly message: string;
}> {}

/** Git and grep answer locally; a hung one fails the check rather than stalling it. */
const timeout = Duration.minutes(1);

/** Git's `-z` output: raw paths, NUL-terminated, never quoted. */
const paths = (output: string) => output.split("\0").filter((path) => path !== "");

/**
 * The files changed between `integration` and `HEAD` in the repository at `repo` that `pattern`
 * matches, and how many lines of the commits `integration..HEAD` (messages and patches) it
 * matches. Fails when the `pattern` file is missing or empty.
 */
export const leaks = Effect.fn(function* (repo: string, integration: string, pattern: string) {
  const fs = yield* FileSystem.FileSystem;

  const size = yield* fs.stat(pattern).pipe(
    Effect.map((info) => info.size),
    Effect.orElseSucceed(() => 0n),
  );

  if (size === 0n) {
    return yield* new PatternMissing({
      message: `The leak pattern ${pattern} is missing or empty: nothing can be checked or pushed without it`,
    });
  }

  const git = (args: ReadonlyArray<string>) =>
    Process.read("git", ["-C", repo, ...args]).pipe(Effect.timeout(timeout));

  /** grep exits 1 when nothing matches. */
  const grep = (args: ReadonlyArray<string>, input?: string) =>
    Process.read("grep", ["-iIE", "-f", pattern, ...args], {
      cwd: repo,
      input,
      exitCodes: [0, 1],
    }).pipe(Effect.timeout(timeout));

  const changed = paths(
    yield* git(["diff", "--name-only", "--diff-filter=d", "-z", integration, "HEAD"]),
  );

  const files =
    changed.length === 0
      ? []
      : (yield* grep(["-l", "--", ...changed])).split("\n").filter((file) => file !== "");

  const log = yield* git(["log", "-p", "--format=%B", `${integration}..HEAD`]);
  const logLines = Number((yield* grep(["-c"], log)).trim());

  return { files, logLines };
});
