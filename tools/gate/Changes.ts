/** The paths a change touches against the integration branch, as `pnpm gate` selects by them. */
import { Duration, Effect } from "effect";

import * as Process from "../Process.ts";

/** Git answers locally; a hung one fails the gate rather than stalling it. */
const gitTimeout = Duration.minutes(1);

/** Git's `-z` output: raw paths, NUL-terminated, never quoted. */
const paths = (output: string) => output.split("\0").filter((path) => path !== "");

/**
 * The merge base of `HEAD` with `integration` in the repository at `repo`, and every path changed
 * since: committed, staged, unstaged and untracked, both sides of a rename.
 */
export const changes = Effect.fn(function* (repo: string, integration: string) {
  const git = (args: ReadonlyArray<string>) =>
    Process.read("git", ["-C", repo, ...args]).pipe(Effect.timeout(gitTimeout));

  const base = (yield* git(["merge-base", integration, "HEAD"])).trim();
  const changed = yield* git(["diff", "--name-only", "--no-renames", "-z", base]);
  const untracked = yield* git(["ls-files", "--others", "--exclude-standard", "-z"]);

  return { base, paths: [...new Set([...paths(changed), ...paths(untracked)])] };
});
