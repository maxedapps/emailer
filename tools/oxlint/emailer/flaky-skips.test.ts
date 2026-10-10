import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { flakySkipsRule } from "./flaky-skips.ts";

RuleTester.describe = describe;

RuleTester.it = it;

/** The UTC date `days` from today. */
const inDays = (days: number) =>
  new Date((Math.floor(Date.now() / 86_400_000) + days) * 86_400_000).toISOString().slice(0, 10);

const skip = (condition: string, until: string) =>
  `it.skipIf(${condition})("sends", () => {}); // flaky: task-636 until ${until}`;

const canonical = (until: string) => skip(`vi.getRealSystemTime() < Date.parse("${until}")`, until);

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "flaky-skips",
  flakySkipsRule,
  {
    valid: [
      { name: "the last allowed day, 14 days ahead", code: canonical(inDays(14)) },
      { name: "an expired skip, whose test runs again", code: canonical(inDays(-1)) },
      {
        name: "the marker on the line above, on a nested tester",
        code: `// flaky: task-7 until ${inDays(3)}\nit.effect.skipIf(vi.getRealSystemTime() < Date.parse('${inDays(3)}'))("sends", () => {});`,
      },
      { name: "an option that is not a skip", code: `it("sends", { timeout: 5 }, () => {});` },
    ],
    invalid: [
      { name: "15 days ahead", code: canonical(inDays(15)), errors: [{ messageId: "tooLate" }] },
      {
        name: "no marker",
        code: `it.skipIf(vi.getRealSystemTime() < Date.parse("${inDays(3)}"))("sends", () => {});`,
        errors: [{ messageId: "marker" }],
      },
      {
        name: "a marker naming another date",
        code: skip(`vi.getRealSystemTime() < Date.parse("${inDays(3)}")`, inDays(4)),
        errors: [{ messageId: "marker" }],
      },
      {
        name: "a malformed marker",
        code: `it.skipIf(vi.getRealSystemTime() < Date.parse("${inDays(3)}"))("sends", () => {}); // flaky until ${inDays(3)}`,
        errors: [{ messageId: "marker" }],
      },
      {
        name: "a permanent condition with a marker",
        code: skip("true", inDays(3)),
        errors: [{ messageId: "condition" }],
      },
      {
        name: "the fakeable clock",
        code: skip(`Date.now() < Date.parse("${inDays(3)}")`, inDays(3)),
        errors: [{ messageId: "condition" }],
      },
      {
        name: "a reversed comparison",
        code: skip(`vi.getRealSystemTime() > Date.parse("${inDays(3)}")`, inDays(3)),
        errors: [{ messageId: "condition" }],
      },
      {
        name: "it.skip",
        code: `it.skip("sends", () => {});`,
        errors: [{ messageId: "permanent" }],
      },
      {
        name: "describe.skip",
        code: `describe.skip("sending", () => {});`,
        errors: [{ messageId: "permanent" }],
      },
      {
        name: "it.effect.skip",
        code: `it.effect.skip("sends", () => {});`,
        errors: [{ messageId: "permanent" }],
      },
      {
        name: "a skip from the test context",
        code: `it("sends", (ctx) => { ctx.skip(); });`,
        errors: [{ messageId: "permanent" }],
      },
      {
        name: "the skip option",
        code: `it("sends", { skip: true }, () => {});`,
        errors: [{ messageId: "permanent" }],
      },
    ],
  },
);
