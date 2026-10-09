import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import * as Process from "../Process.ts";
import { changes } from "./Changes.ts";

/** A repository whose `main` holds `kept`, `edited`, `staged`, `renamed` and `ignored` patterns. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* fs.makeTempDirectoryScoped({ prefix: "gate-" });
  const git = (...args: ReadonlyArray<string>) => Process.read("git", ["-C", repo, ...args]);
  const write = (file: string, text: string) => fs.writeFileString(path.join(repo, file), text);

  yield* git("init", "--quiet", "--initial-branch=main");
  yield* git("config", "user.email", "gate@example.com");
  yield* git("config", "user.name", "Gate");

  for (const file of ["kept.ts", "edited.ts", "staged.ts", "renamed.ts", "committed.ts"]) {
    yield* write(file, `export const file = "${file}";\n`);
  }

  yield* write(".gitignore", "ignored.log\n");
  yield* git("add", ".");
  yield* git("commit", "--quiet", "--message", "main");

  return { repo, git, write };
});

describe("changes", () => {
  it.effect("lists committed, staged, unstaged and untracked paths, and both rename sides", () =>
    Effect.gen(function* () {
      const { repo, git, write } = yield* fixture;
      const main = (yield* git("rev-parse", "HEAD")).trim();

      yield* git("switch", "--quiet", "--create", "work");
      yield* write("committed.ts", "export const file = 0;\n");
      yield* git("commit", "--quiet", "--all", "--message", "work");
      yield* write("staged.ts", "export const file = 1;\n");
      yield* git("add", "staged.ts");
      yield* git("mv", "renamed.ts", "moved.ts");
      yield* write("edited.ts", "export const file = 2;\n");
      yield* write("untracked.ts", "export const file = 3;\n");
      yield* write("ignored.log", "noise\n");

      const result = yield* changes(repo, "main");

      expect(result.base).toBe(main);
      expect([...result.paths].sort()).toStrictEqual([
        "committed.ts",
        "edited.ts",
        "moved.ts",
        "renamed.ts",
        "staged.ts",
        "untracked.ts",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "diffs against the merge base, so the integration branch's own commits are not listed",
    () =>
      Effect.gen(function* () {
        const { repo, git, write } = yield* fixture;

        yield* git("switch", "--quiet", "--create", "work");
        yield* write("committed.ts", "export const file = 0;\n");
        yield* git("commit", "--quiet", "--all", "--message", "work");
        yield* git("switch", "--quiet", "main");
        yield* write("kept.ts", "export const file = 4;\n");
        yield* git("commit", "--quiet", "--all", "--message", "main moves on");
        yield* git("switch", "--quiet", "work");

        expect((yield* changes(repo, "main")).paths).toStrictEqual(["committed.ts"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails instead of listing nothing when the integration branch is missing", () =>
    Effect.gen(function* () {
      const { repo } = yield* fixture;

      const error = yield* Effect.flip(changes(repo, "origin/main"));

      expect(error._tag).toBe("CommandFailed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
