import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { createdAt, fakeService, parseJson, runCli } from "../../test/CliHarness.ts";

describe("address status and un-suppress from the command line", () => {
  it.effect("prints the address record addresses status answers, asking with the case given", () =>
    Effect.gen(function* () {
      const service = fakeService();

      const run = yield* runCli(service, ["addresses", "status", "--email", "Sam@Example.com"]);

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(service.received).toStrictEqual([
        { endpoint: "addresses.status", query: { email: "Sam@Example.com" } },
      ]);
      expect(yield* parseJson(run.stdout)).toStrictEqual({
        email: "Sam@Example.com",
        status: "suppressed",
        suppression: { reason: "bounce", suppressedAt: createdAt },
        transientBounces: [],
        accountSuppression: { reason: "bounce", lastUpdateTime: createdAt },
      });
    }),
  );

  it.effect("prints the refreshed record addresses unsuppress answers", () =>
    Effect.gen(function* () {
      const service = fakeService();

      const run = yield* runCli(service, ["addresses", "unsuppress", "--email", "sam@example.com"]);

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(service.payloadsOf("addresses.unsuppress")).toStrictEqual([
        { email: "sam@example.com" },
      ]);
      expect(yield* parseJson(run.stdout)).toStrictEqual({
        email: "sam@example.com",
        status: "mailable",
        transientBounces: [],
        accountSuppression: null,
      });
    }),
  );
});
