/**
 * `pnpm leak-check`, the check before every push (ADR-0034): the machine-local leak pattern must
 * match none of the files changed against `origin/main` and none of the commits to push.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Data, Effect } from "effect";
import { Command } from "effect/cli";

import { leaks } from "./Leaks.ts";

class Leaked extends Data.TaggedError("Leaked")<{ readonly message: string }> {}

const integration = "origin/main";

const pattern = join(homedir(), ".config/emailer/leak-pattern.txt");

const leakCheck = Command.make("leak-check", {}, () =>
  Effect.gen(function* () {
    const { files, logLines } = yield* leaks(".", integration, pattern);

    if (files.length === 0 && logLines === 0) {
      return yield* Console.log(`Leak check: nothing matches against ${integration}`);
    }

    for (const file of files) {
      yield* Console.error(`  ${file}`);
    }

    return yield* new Leaked({
      message: `The leak pattern matches ${files.length} changed files and ${logLines} lines of the commits ${integration}..HEAD: remove them before pushing`,
    });
  }),
).pipe(Command.withDescription("Check that a change leaks nothing private before it is pushed"));

Command.run(leakCheck, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
