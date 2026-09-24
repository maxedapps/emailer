import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { contactId, inMemoryService, runCli, token, withService } from "../../test/CliHarness.ts";

describe("contact management from the command line", () => {
  it.live("merges repeated --attr pairs into one attribute map", () =>
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
  );

  it.live("refuses an attribute map the contract bounds, before any request", () =>
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
  );
});
