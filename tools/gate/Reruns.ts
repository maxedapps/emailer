/**
 * The gate's lone reruns (ADR-0035): the tests of a Vitest JSON report, the filter that reruns
 * exactly one of them, its verdict from that rerun's report, and the flake ledger's line for one
 * that passed alone.
 */
import { relative } from "node:path";

import { Effect, FileSystem, Match, Schema } from "effect";

/** The parts of Vitest's `json` reporter output the gate reads. */
const Report = Schema.Struct({
  testResults: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      assertionResults: Schema.Array(
        Schema.Struct({
          ancestorTitles: Schema.Array(Schema.String),
          title: Schema.String,
          status: Schema.String,
          failureMessages: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
});

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(Report));

export interface TestResult {
  /** The test file, relative to the repository. */
  readonly file: string;
  /** Its describe blocks and its own title, as `-t` matches them: `a > b > test`. */
  readonly name: string;
  readonly status: string;
  /** The first line of its first failure, empty when it did not fail. */
  readonly symptom: string;
}

export type Verdict = "passes alone" | "fails alone" | "did not run";

/** Separates a test's describe blocks and title, in Vitest's full test names. */
const separator = " > ";

const firstLine = (message: string) =>
  message
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/** Every test of the report at `path`, or none when the run wrote no report. */
export const readResults = Effect.fn(function* (path: string, root: string) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(path))) {
    return [];
  }

  const report = yield* decodeReport(yield* fs.readFileString(path));

  return report.testResults.flatMap((file) =>
    file.assertionResults.map((test): TestResult => ({
      file: relative(root, file.name),
      name: [...test.ancestorTitles, test.title].join(separator),
      status: test.status,
      symptom: firstLine(test.failureMessages[0] ?? ""),
    })),
  );
});

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Vitest arguments that run only `test`: its file, and `-t` with its full name, escaped and anchored. */
export const rerunArgs = (test: TestResult) => [test.file, "-t", `^${escapeRegExp(test.name)}$`];

/** How `test`, failed in the gate's run, did in the rerun. */
export const verdict = (test: TestResult, rerun: ReadonlyArray<TestResult>): Verdict => {
  const again = rerun.find((result) => result.file === test.file && result.name === test.name);

  return Match.value(again?.status).pipe(
    Match.when("passed", (): Verdict => "passes alone"),
    Match.when("failed", (): Verdict => "fails alone"),
    Match.orElse((): Verdict => "did not run"),
  );
};

/** The task a branch named `task-<N>-…` works for, as the ledger names it. */
export const branchTask = (branch: string) => {
  const task = /^task-(\d+)\b/.exec(branch)?.[1];

  return task === undefined ? "task-?" : `task-${task}`;
};

const maxSymptom = 160;

/** The flake ledger's line for `test`, which passed alone (the awesome-tests format). */
export const ledgerLine = (test: TestResult, date: string, task: string) => {
  const symptom =
    test.symptom.length > maxSymptom ? `${test.symptom.slice(0, maxSymptom - 1)}…` : test.symptom;

  return `- ${date} ${task} \`${test.file} > ${test.name}\` — ${symptom} — cause: ?\n`;
};
