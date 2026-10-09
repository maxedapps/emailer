/** The paths a change touches against the integration branch, as `pnpm gate` selects by them. */
import { Effect } from "effect";

import * as Process from "../Process.ts";

const lines = (output: string) => output.split("\n").filter((line) => line !== "");

/**
 * The merge base of `HEAD` with `integration` in the repository at `repo`, and every path changed
 * since: committed, staged, unstaged and untracked, both sides of a rename.
 */
export const changes = Effect.fn(function* (repo: string, integration: string) {
  const git = (args: ReadonlyArray<string>) => Process.read("git", ["-C", repo, ...args]);

  const base = (yield* git(["merge-base", integration, "HEAD"])).trim();
  const changed = yield* git(["diff", "--name-only", "--no-renames", base]);
  const untracked = yield* git(["ls-files", "--others", "--exclude-standard"]);

  return { base, paths: [...new Set([...lines(changed), ...lines(untracked)])] };
});
