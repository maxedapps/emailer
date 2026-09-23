import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { inMemoryService, parseJson, runCli, token, withService } from "../../test/CliHarness.ts";

describe("address status and un-suppress from the command line", () => {
  it("prints the address record from addresses status and exits 0", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["addresses", "status", "--email", "Max@Example.com"]),
        );

        expect(result.exitCode).toBe(0);
        expect(yield* parseJson(result.stdout)).toStrictEqual({
          email: "Max@Example.com",
          status: "suppressed",
          suppression: { reason: "bounce", suppressedAt: "2026-09-15T10:00:00.000Z" },
          transientBounces: [],
          accountSuppression: { reason: "bounce", lastUpdateTime: "2026-09-15T10:00:00.000Z" },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("prints the refreshed record from addresses unsuppress and exits 0", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["addresses", "unsuppress", "--email", "max@example.com"]),
        );

        expect(result.exitCode).toBe(0);
        expect(yield* parseJson(result.stdout)).toStrictEqual({
          email: "max@example.com",
          status: "mailable",
          transientBounces: [],
          accountSuppression: null,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ));
});
