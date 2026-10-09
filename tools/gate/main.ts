/**
 * `pnpm gate`, the check to run before landing (ADR-0033): `pnpm check`, then the live suite for
 * only the groups the change against `origin/main` reaches, or none.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Duration, Effect } from "effect";
import { Command } from "effect/cli";

import { liveGroups } from "../../apps/backend/test/LiveGroups.ts";
import * as Process from "../Process.ts";
import { changes } from "./Changes.ts";
import { reach, selected } from "./LiveReach.ts";

import type { Reach } from "./LiveReach.ts";

const integration = "origin/main";

const checkTimeout = Duration.minutes(15);

/** A deploy and a destroy of up to 30 minutes each, and a group with 20-minute sends between. */
const liveTimeout = Duration.hours(2);

const describeReach = (groups: Reach) =>
  groups === "all" ? "all" : groups.length === 0 ? "none" : groups.join(", ");

const gate = Command.make("gate", {}, () =>
  Effect.gen(function* () {
    yield* Process.run("pnpm", ["check"]).pipe(Effect.timeout(checkTimeout));

    const { base, paths } = yield* changes(".", integration);

    yield* Console.log(`\nChanged against ${integration} (merge base ${base.slice(0, 9)}):`);

    for (const path of paths) {
      yield* Console.log(`  ${path} → ${describeReach(reach(path))}`);
    }

    const groups = selected(paths);

    if (groups.length === 0) {
      return yield* Console.log("Live suite: no group reached, skipped");
    }

    const all = groups.length === liveGroups.length;

    yield* Console.log(`Live suite: ${all ? "every group" : groups.join(", ")}\n`);
    yield* Process.run("pnpm", [
      "test:integration",
      ...(all ? [] : [`--tags-filter=${groups.join(" || ")}`]),
    ]).pipe(Effect.timeout(liveTimeout));
  }),
).pipe(Command.withDescription("Run the checks a change needs before it lands"));

Command.run(gate, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
