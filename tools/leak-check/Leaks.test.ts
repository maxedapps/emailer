import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import * as Process from "../Process.ts";
import { leaks, PatternMissing } from "./Leaks.ts";

/** A repository whose `main` already names the placeholder company, and a pattern file beside it. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "leak-check-" });
  const repo = path.join(dir, "repo");
  const pattern = path.join(dir, "pattern.txt");
  const git = (...args: ReadonlyArray<string>) => Process.read("git", ["-C", repo, ...args]);
  const write = (file: string, text: string) => fs.writeFileString(path.join(repo, file), text);

  yield* fs.makeDirectory(repo);
  yield* fs.writeFileString(pattern, "acme corp\nwile\\.e\n");
  yield* git("init", "--quiet", "--initial-branch=main");
  yield* git("config", "user.email", "leak-check@example.com");
  yield* git("config", "user.name", "Leak Check");
  yield* write("landed.md", "Written for Acme Corp.\n");
  yield* write("deleted.md", "Written for Acme Corp.\n");
  yield* write("clean.ts", "export const sender = 0;\n");
  yield* git("add", ".");
  yield* git("commit", "--quiet", "--message", "main");
  yield* git("switch", "--quiet", "--create", "work");

  return { fs, repo, pattern, git, write };
});

describe("leaks", () => {
  it.effect("finds nothing in a change the pattern does not match", () =>
    Effect.gen(function* () {
      const { repo, pattern, git, write } = yield* fixture;

      yield* write("clean.ts", "export const sender = 1;\n");
      yield* git("commit", "--quiet", "--all", "--message", "Change the sender");

      expect(yield* leaks(repo, "main", pattern)).toStrictEqual({ files: [], logLines: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists changed files and counts commit lines it matches, in any case", () =>
    Effect.gen(function* () {
      const { repo, pattern, git, write } = yield* fixture;

      yield* write("clean.ts", 'export const sender = "ACME CORP";\n');
      yield* git("rm", "--quiet", "deleted.md");
      yield* git("commit", "--quiet", "--all", "--message", "Send as Wile.E\n\nFor the demo.");

      expect(yield* leaks(repo, "main", pattern)).toStrictEqual({
        files: ["clean.ts"],
        logLines: 3,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails without a pattern, missing or empty", () =>
    Effect.gen(function* () {
      const { fs, repo, pattern } = yield* fixture;

      yield* fs.writeFileString(pattern, "");
      expect(yield* Effect.flip(leaks(repo, "main", pattern))).toBeInstanceOf(PatternMissing);

      yield* fs.remove(pattern);
      expect(yield* Effect.flip(leaks(repo, "main", pattern))).toBeInstanceOf(PatternMissing);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
