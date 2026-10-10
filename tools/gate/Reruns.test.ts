import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { branchTask, ledgerLine, readResults, rerunArgs, verdict } from "./Reruns.ts";

import type { TestResult } from "./Reruns.ts";

/** A report in Vitest's `json` format, of the repository at `/repo`, holding only what the gate reads. */
const report = {
  testResults: [
    {
      name: "/repo/src/a.test.ts",
      assertionResults: [
        {
          ancestorTitles: ["outer", "inner"],
          title: "passes",
          status: "passed",
          failureMessages: [],
        },
        {
          ancestorTitles: ["outer"],
          title: "fails",
          status: "failed",
          failureMessages: [
            "\n  AssertionError: expected 1 to be 2\n    at a.test.ts:9:5",
            "second",
          ],
        },
      ],
    },
    {
      name: "/repo/src/b.test.ts",
      assertionResults: [
        { ancestorTitles: [], title: "is skipped", status: "skipped", failureMessages: [] },
      ],
    },
  ],
};

const results = (json: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "reruns-" });
    const file = path.join(directory, "report.json");

    yield* fs.writeFileString(file, json);

    return yield* readResults(file, "/repo");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const failed: TestResult = {
  file: "src/a.test.ts",
  name: "outer > fails",
  status: "failed",
  symptom: "AssertionError: expected 1 to be 2",
};

describe("readResults", () => {
  it.effect("reads every test with its file, full name, status and first failure line", () =>
    Effect.gen(function* () {
      expect(yield* results(JSON.stringify(report))).toStrictEqual([
        { file: "src/a.test.ts", name: "outer > inner > passes", status: "passed", symptom: "" },
        failed,
        { file: "src/b.test.ts", name: "is skipped", status: "skipped", symptom: "" },
      ]);
    }),
  );

  it.effect("reads no tests when the run wrote no report", () =>
    readResults("/nonexistent/report.json", "/repo").pipe(
      Effect.map((tests) => expect(tests).toStrictEqual([])),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("rerunArgs", () => {
  it("runs only the test's file and exactly its name, regex characters included", () => {
    const test = { ...failed, name: "sends (a + b) > to *.example.com?" };
    const [file, flag, pattern = ""] = rerunArgs(test);
    const filter = new RegExp(pattern);

    expect([file, flag]).toStrictEqual(["src/a.test.ts", "-t"]);
    expect(filter.test(test.name)).toBe(true);
    expect(filter.test(`${test.name} again`)).toBe(false);
    expect(filter.test(`outer > ${test.name}`)).toBe(false);
    expect(filter.test("sends a + b > to x.example.com")).toBe(false);
  });
});

describe("verdict", () => {
  const rerun = (status: string, of: TestResult = failed) => [{ ...of, status }];

  it("tells a pass alone from a failure alone and from a rerun that missed the test", () => {
    expect(verdict(failed, rerun("passed"))).toBe("passes alone");
    expect(verdict(failed, rerun("failed"))).toBe("fails alone");
    expect(verdict(failed, rerun("skipped"))).toBe("did not run");
    expect(verdict(failed, [])).toBe("did not run");
    expect(verdict(failed, rerun("passed", { ...failed, file: "src/other.test.ts" }))).toBe(
      "did not run",
    );
  });
});

describe("branchTask", () => {
  it("takes the task from a task branch, and marks it unknown otherwise", () => {
    expect(branchTask("task-636-flaky-tests")).toBe("task-636");
    expect(branchTask("task-7")).toBe("task-7");
    expect(branchTask("main")).toBe("task-?");
    expect(branchTask("task-636x")).toBe("task-?");
  });
});

describe("ledgerLine", () => {
  it("writes the shared ledger format with the cause left open", () => {
    expect(ledgerLine(failed, "2026-10-10", "task-636")).toBe(
      "- 2026-10-10 task-636 `src/a.test.ts > outer > fails` — AssertionError: expected 1 to be 2 — cause: ?\n",
    );
  });

  it("shortens a long symptom to 160 characters", () => {
    const line = ledgerLine({ ...failed, symptom: "x".repeat(400) }, "2026-10-10", "task-636");

    expect(line).toContain(` — ${"x".repeat(159)}… — cause: ?`);
  });
});
