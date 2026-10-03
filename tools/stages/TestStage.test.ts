import { describe, expect, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Option } from "effect";
import { TestClock } from "effect/testing";

import * as TestStage from "./TestStage.ts";

const created = DateTime.makeUnsafe("2026-10-03T14:30:00Z");

describe("make", () => {
  it.effect("names a stage that parses back to the minute it was made in", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(created) + 59_000);

      const stage = yield* TestStage.make;

      expect(stage).toMatch(/^test-2610031430-[0-9a-z]{4}$/);
      expect(TestStage.createdAt(stage)).toStrictEqual(Option.some(created));
    }),
  );
});

describe("createdAt", () => {
  it.each([
    "prod",
    "shared",
    "test",
    "test_example",
    "test-import",
    "test-2613031430-k3x9",
    "test-2602301430-k3x9",
    "test-2610031430",
    "test-2610031430-k3x",
    "test-2610031430-k3x9a",
    "test-2610031430-K3X9",
  ])("does not take %s for a test stage", (stage) => {
    expect(TestStage.createdAt(stage)).toStrictEqual(Option.none());
  });
});

describe("isStale", () => {
  const stage = "test-2610031430-k3x9";
  const after = (duration: Duration.Input) => DateTime.addDuration(created, duration);

  it("keeps a stage short of its lifetime", () => {
    expect(TestStage.isStale(stage, after({ hours: 3, minutes: 59 }))).toBe(false);
  });

  it("sweeps a stage at its lifetime", () => {
    expect(TestStage.isStale(stage, after(TestStage.lifetime))).toBe(true);
  });

  it("keeps a stage whose name lies in the future", () => {
    expect(TestStage.isStale("test-2610031830-k3x9", created)).toBe(false);
  });

  it("never sweeps another stage, however old", () => {
    expect(TestStage.isStale("test", after({ days: 3650 }))).toBe(false);
  });
});

describe("testStages", () => {
  it("reads the test stages of the stack from state list paths, and nothing else", () => {
    const listing = [
      "Emailer/prod/",
      "Emailer/test/",
      "Emailer/test_example/",
      "Emailer/test-import/",
      "Emailer/test-2610031030-aaaa/",
      "Emailer/test-2610031430-bbbb/",
      "Emailer/test-2613031430-cccc/",
      "Emailer/test-2610031430-dddd/Api",
      "EmailerSending/test-2610031030-eeee/",
      "test-2610031030-ffff",
      "",
    ].join("\n");

    expect(TestStage.testStages("Emailer", listing)).toStrictEqual([
      "test-2610031030-aaaa",
      "test-2610031430-bbbb",
    ]);
  });
});
