/**
 * `pnpm gate`, the check to run before landing (ADR-0033): `pnpm check`, then the live suite for
 * only the groups the change against `origin/main` reaches, or none. A red run reruns each of its
 * failed tests alone once and logs those that pass to the flake ledger, and stays red (ADR-0035).
 */
import { join } from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, DateTime, Duration, Effect, FileSystem } from "effect";
import { Command } from "effect/cli";

import { liveGroups } from "../../apps/backend/test/LiveGroups.ts";
import * as Process from "../Process.ts";
import { changes } from "./Changes.ts";
import { reach, selected } from "./LiveReach.ts";
import { branchTask, ledgerLine, readResults, rerunArgs, verdict } from "./Reruns.ts";

import type { Reach } from "./LiveReach.ts";

const integration = "origin/main";

const checkTimeout = Duration.minutes(15);

/** A deploy and a destroy of up to 30 minutes each, and a group with 20-minute sends between. */
const liveTimeout = Duration.hours(2);

const ledger = "flakes.md";

/** Reruns each failed test of `report` alone once, through `script`, and logs those that pass. */
const rerunFailed = Effect.fn(function* (
  report: string,
  script: string,
  timeout: Duration.Duration,
) {
  const fs = yield* FileSystem.FileSystem;
  const reports = yield* fs.makeTempDirectoryScoped({ prefix: "gate-reruns-" });
  const failed = (yield* readResults(report, ".")).filter((test) => test.status === "failed");

  if (failed.length === 0) {
    return;
  }

  yield* Console.log(`\nRerunning each of ${failed.length} failed tests alone (ADR-0035)\n`);

  const verdicts = yield* Effect.forEach(failed, (test, index) =>
    Effect.gen(function* () {
      const rerun = join(reports, `${index}.json`);

      yield* Process.run("pnpm", [script, ...rerunArgs(test)], {
        env: { GATE_TEST_REPORT: rerun },
      }).pipe(Effect.timeout(timeout), Effect.ignore);

      return { test, verdict: verdict(test, yield* readResults(rerun, ".")) };
    }),
  );

  yield* Console.log("\nRerun alone:");

  for (const { test, verdict } of verdicts) {
    yield* Console.log(`  ${verdict}: ${test.file} > ${test.name}`);
  }

  const flakes = verdicts.flatMap(({ test, verdict }) =>
    verdict === "passes alone" ? [test] : [],
  );

  if (flakes.length === 0) {
    return;
  }

  const date = DateTime.formatIsoDateUtc(yield* DateTime.now);
  const task = branchTask((yield* Process.read("git", ["branch", "--show-current"])).trim());

  yield* fs.writeFileString(ledger, flakes.map((test) => ledgerLine(test, date, task)).join(""), {
    flag: "a",
  });
  yield* Console.log(`Logged ${flakes.length} flakes to ${ledger}: replace each cause "?".`);
}, Effect.scoped);

/** Runs `pnpm <command>` with a test report; when it fails, reruns its failed tests through `rerun`. */
const tested = Effect.fn(function* (
  command: ReadonlyArray<string>,
  rerun: string,
  timeout: Duration.Duration,
) {
  const fs = yield* FileSystem.FileSystem;
  const report = join(yield* fs.makeTempDirectoryScoped({ prefix: "gate-" }), "report.json");

  yield* Process.run("pnpm", command, { env: { GATE_TEST_REPORT: report } }).pipe(
    Effect.timeout(timeout),
    Effect.tapError(() => rerunFailed(report, rerun, timeout)),
  );
}, Effect.scoped);

const describeReach = (groups: Reach) =>
  groups === "all" ? "all" : groups.length === 0 ? "none" : groups.join(", ");

const gate = Command.make("gate", {}, () =>
  Effect.gen(function* () {
    yield* tested(["check"], "test", checkTimeout);

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
    yield* tested(
      ["test:integration", ...(all ? [] : [`--tags-filter=${groups.join(" || ")}`])],
      "test:integration",
      liveTimeout,
    );
  }),
).pipe(Command.withDescription("Run the checks a change needs before it lands"));

Command.run(gate, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
