import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as Process from "./Process.ts";

const exitWith = (code: number) => ["-e", `process.stdout.write("out"); process.exit(${code})`];

describe("read", () => {
  it.effect("returns the output of a command that succeeds", () =>
    Effect.gen(function* () {
      expect(yield* Process.read("node", exitWith(0))).toBe("out");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when the command exits non-zero, despite its output", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Process.read("node", exitWith(3)));

      expect(error).toStrictEqual(
        new Process.CommandFailed({ message: `node ${exitWith(3).join(" ")} exited with 3` }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("run", () => {
  it.effect("fails when the command exits non-zero", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Process.run("node", ["-e", "process.exit(2)"]));

      expect(error.message).toBe("node -e process.exit(2) exited with 2");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
