/**
 * Test stage names, `test-<UTC yyMMddHHmm>-<4 base36>`: each carries its creation time, so a sweep
 * can tell a stale stage from a sibling worker's live one without any store (ADR-0031).
 */
import { DateTime, Duration, Effect, Option, Random, Schema } from "effect";

/** A test stage lives this long from its creation, however often it is redeployed. */
export const lifetime = Duration.hours(4);

const pattern = /^test-(\d{10})-[0-9a-z]{4}$/;

const suffixes = 36 ** 4;

const twoDigits = (value: number) => String(value % 100).padStart(2, "0");

const stamp = (time: DateTime.DateTime) => {
  const { year, month, day, hour, minute } = DateTime.toPartsUtc(time);

  return [year, month, day, hour, minute].map(twoDigits).join("");
};

/** When the stage was created, for a name in exactly the test stage format. */
export const createdAt = (stage: string): Option.Option<DateTime.Utc> => {
  const digits = pattern.exec(stage)?.[1];

  if (digits === undefined) {
    return Option.none();
  }

  const [yy, MM, dd, HH, mm] = digits.match(/\d\d/g) ?? [];

  // Formatting the time back rejects what the parser rolled over, such as 30 February.
  return DateTime.make(`20${yy}-${MM}-${dd}T${HH}:${mm}:00Z`).pipe(
    Option.filter((time) => stamp(time) === digits),
  );
};

export const TestStageName = Schema.String.check(
  Schema.makeFilter((stage: string) =>
    Option.isSome(createdAt(stage)) ? undefined : "expected test-<UTC yyMMddHHmm>-<4 base36>",
  ),
);

/** A fresh name, created now. */
export const make = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const suffix = yield* Random.nextIntBetween(0, suffixes, { halfOpen: true });

  return `test-${stamp(now)}-${suffix.toString(36).padStart(4, "0")}`;
});

/** How long ago a test stage was created. */
export const age = (stage: string, now: DateTime.DateTime): Option.Option<Duration.Duration> =>
  Option.map(createdAt(stage), (created) => DateTime.distance(created, now));

/** Stale: a test stage created a whole lifetime or more before `now`. */
export const isStale = (stage: string, now: DateTime.DateTime): boolean =>
  Option.exists(age(stage, now), Duration.isGreaterThanOrEqualTo(lifetime));

/** The test stages of `stack` in `alchemy state list <stack>` output, whose lines are paths. */
export const testStages = (stack: string, listing: string): ReadonlyArray<string> =>
  listing
    .split("\n")
    .flatMap((line) => {
      const [name, stage, rest] = line.trim().split("/");

      return name === stack && stage !== undefined && rest === "" ? [stage] : [];
    })
    .filter((stage) => Option.isSome(createdAt(stage)));
