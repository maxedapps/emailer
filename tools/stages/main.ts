/**
 * `pnpm stages`: deploys, lists and destroys this worker's own test stages, and sweeps stale ones
 * (ADR-0031). Every command runs the Alchemy CLI on `alchemy.run.ts` with `.env.test`.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, DateTime, Duration, Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";

import * as Process from "../Process.ts";
import * as TestStage from "./TestStage.ts";

const stack = "Emailer";

/** A deploy or destroy takes minutes; a stalled one fails the command and stops a sweep. */
const commandTimeout = Duration.minutes(30);

const alchemyArgs = (args: ReadonlyArray<string>) => [
  ...args,
  "--config",
  "alchemy.run.ts",
  "--env-file",
  ".env.test",
];

const run = (args: ReadonlyArray<string>) =>
  Process.run("alchemy", alchemyArgs(args)).pipe(Effect.timeout(commandTimeout));

const read = (args: ReadonlyArray<string>) =>
  Process.read("alchemy", alchemyArgs(args)).pipe(Effect.timeout(commandTimeout));

const testStages = Effect.map(read(["state", "list", stack]), (listing) =>
  TestStage.testStages(stack, listing),
);

const destroy = (stage: string) =>
  Console.log(`Destroying ${stage}`).pipe(
    Effect.andThen(run(["destroy", "--stage", stage, "--yes", "--no-input"])),
  );

const stageArgument = Argument.String("stage").pipe(
  Argument.withDescription("A test stage: test-<UTC yyMMddHHmm>-<4 base36>"),
  Argument.withSchema(TestStage.TestStageName),
);

const up = Command.make(
  "up",
  { stage: stageArgument.pipe(Argument.optional) },
  Effect.fn(function* ({ stage }) {
    const name = yield* Option.match(stage, {
      onNone: () => TestStage.make,
      onSome: Effect.succeed,
    });

    yield* Console.log(`Deploying ${name}`);
    // Forced, because Alchemy can plan a changed function as noop and keep its old bundle.
    yield* run(["deploy", "--stage", name, "--force", "--yes", "--no-input"]);
    yield* Console.log(`Deployed ${name}`);
  }),
).pipe(Command.withDescription("Deploy a fresh test stage, or redeploy the one given"));

const down = Command.make("down", { stage: stageArgument }, ({ stage }) => destroy(stage)).pipe(
  Command.withDescription("Destroy a test stage"),
);

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const stages = yield* testStages;

    if (stages.length === 0) {
      return yield* Console.log("No test stages");
    }

    for (const stage of stages) {
      const age = Option.getOrThrow(TestStage.age(stage, now));
      const minutes = Duration.minutes(Math.floor(Duration.toMinutes(age)));
      const stale = TestStage.isStale(stage, now) ? "  stale" : "";

      yield* Console.log(`${stage}  ${Duration.format(minutes)}${stale}`);
    }
  }),
).pipe(Command.withDescription("List the test stages with their age"));

const sweep = Command.make("sweep", {}, () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const stale = (yield* testStages).filter((stage) => TestStage.isStale(stage, now));

    if (stale.length === 0) {
      return yield* Console.log("No stale test stages");
    }

    // One at a time, and the first failure stops the sweep.
    yield* Effect.forEach(stale, destroy, { discard: true });
  }),
).pipe(
  Command.withDescription(
    `Destroy every test stage older than ${Duration.format(TestStage.lifetime)}`,
  ),
);

const stages = Command.make("stages").pipe(
  Command.withDescription("Manage this repository's ephemeral test stages"),
  Command.withSubcommands([up, down, list, sweep]),
);

Command.run(stages, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
