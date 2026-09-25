import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import {
  contactId,
  createdAt,
  fakeService,
  parseJson,
  runCli,
  token,
} from "../../test/CliHarness.ts";

describe("contact management from the command line", () => {
  it.effect("creates a contact with repeated --attr pairs as one attribute map", () =>
    Effect.gen(function* () {
      const service = fakeService();

      const run = yield* runCli(service, [
        "contacts",
        "create",
        "--email",
        "sam@example.com",
        "--attr",
        "plan=pro",
        "--attr",
        "city=Berlin",
      ]);

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(service.payloadsOf("contacts.create")).toMatchObject([
        { email: "sam@example.com", attributes: { plan: "pro", city: "Berlin" } },
      ]);
      expect(yield* parseJson(run.stdout)).toStrictEqual({
        id: contactId,
        email: "sam@example.com",
        attributes: { plan: "pro", city: "Berlin" },
        createdAt,
      });
    }),
  );

  it.effect("attaches the configured credential to its requests", () =>
    Effect.gen(function* () {
      const service = fakeService();

      yield* runCli(service, ["contacts", "create", "--email", "sam@example.com"]);

      expect(service.authorizations).toStrictEqual([token]);
    }),
  );

  it.effect("reports a missing contact on stderr and prints nothing", () =>
    Effect.gen(function* () {
      const run = yield* runCli(fakeService(), ["contacts", "get", contactId]);

      expect(Exit.isFailure(run.exit)).toBe(true);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("ContactNotFound");
    }),
  );

  it.effect("refuses an attribute map the contract bounds, naming --attr, before any request", () =>
    Effect.gen(function* () {
      const service = fakeService();

      const run = yield* runCli(service, [
        "contacts",
        "update",
        contactId,
        "--attr",
        `${"k".repeat(200)}=value`,
      ]);

      expect(Exit.isFailure(run.exit)).toBe(true);
      expect(run.stderr).toContain("--attr");
      expect(service.received).toStrictEqual([]);
    }),
  );

  it.effect("refuses a page size outside the contract, naming --limit, before any request", () =>
    Effect.gen(function* () {
      const service = fakeService();

      const run = yield* runCli(service, ["contacts", "list", "--limit", "500"]);

      expect(Exit.isFailure(run.exit)).toBe(true);
      expect(run.stderr).toContain("--limit");
      expect(service.received).toStrictEqual([]);
    }),
  );

  // A page reports its cursor in the contract's own form, so the flag has to take exactly that
  // string back. `Schemas.test.ts` pins that the value survives the wire unchanged.
  it.effect("accepts the cursor form a page reports and sends it on", () =>
    Effect.gen(function* () {
      const service = fakeService();
      const cursor = `${createdAt}#${contactId}`;

      const run = yield* runCli(service, ["contacts", "list", "--cursor", cursor]);

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(service.received).toStrictEqual([{ endpoint: "contacts.list", query: { cursor } }]);
    }),
  );
});
