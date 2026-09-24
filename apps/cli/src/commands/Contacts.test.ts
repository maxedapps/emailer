import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { contactId, inMemoryService, runCli, token, withService } from "../../test/CliHarness.ts";

describe("contact management from the command line", () => {
  it("merges repeated --attr pairs into one attribute map", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          Effect.gen(function* () {
            yield* runCli(baseUrl, token, ["contacts", "create", "--email", "sam@example.com"]);

            return yield* runCli(baseUrl, token, [
              "contacts",
              "update",
              contactId,
              "--attr",
              "plan=pro",
              "--attr",
              "city=Berlin",
            ]);
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(service.updates).toStrictEqual([{ plan: "pro", city: "Berlin" }]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("refuses an attribute map the contract bounds, before any request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const oversized = ["--attr", `${"k".repeat(200)}=value`];

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["contacts", "update", contactId, ...oversized]),
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout.startsWith("{")).toBe(false);
        expect(service.updates).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));
});
