import { describe, expect, it } from "@effect/vitest";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Exit, Schema } from "effect";

import {
  contactId,
  createdAt,
  fakeService,
  parseJson,
  runCli,
  tempFile,
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

describe("contacts update", () => {
  it.effect("merges --attr and --unset into one patch, leaving other attributes alone", () =>
    Effect.gen(function* () {
      const service = fakeService({
        contacts: [{ id: contactId, email: "sam@example.com", createdAt }],
      });

      yield* runCli(service, [
        "contacts",
        "update",
        contactId,
        "--attr",
        "plan=pro",
        "--unset",
        "trial",
        "--unset",
        "city",
      ]);

      expect(service.payloadsOf("contacts.update")).toStrictEqual([
        { attributes: { plan: "pro", trial: null, city: null } },
      ]);
    }),
  );

  it.effect("clears every attribute with --clear-attributes, and refuses it beside --attr", () =>
    Effect.gen(function* () {
      const service = fakeService({
        contacts: [{ id: contactId, email: "sam@example.com", createdAt }],
      });

      yield* runCli(service, ["contacts", "update", contactId, "--clear-attributes"]);

      const mixed = yield* runCli(service, [
        "contacts",
        "update",
        contactId,
        "--clear-attributes",
        "--attr",
        "plan=pro",
      ]);

      expect(service.payloadsOf("contacts.update")).toStrictEqual([{ attributes: null }]);
      expect(Exit.isFailure(mixed.exit)).toBe(true);
      expect(mixed.stderr).toContain("--clear-attributes alone");
    }),
  );
});

describe("contacts set-attributes", () => {
  const rows = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `r${index}@example.com,${index % 2 === 0 ? "a" : "b"},`,
    );

  it.effect(
    "sends a CSV file in batches, a blank cell leaving its attribute out of the patch",
    () =>
      Effect.gen(function* () {
        const service = fakeService();
        const file = yield* tempFile("csv", ["Email,segment,source", ...rows(45)].join("\n"));

        const run = yield* runCli(service, ["contacts", "set-attributes", "--file", file]);

        const decodeBatch = Schema.decodeUnknownEffect(Schemas.SetAttributesPayload);

        const batches = yield* Effect.forEach(
          service.payloadsOf("contacts.setAttributes"),
          (payload) => decodeBatch(payload),
        );

        expect(Exit.isSuccess(run.exit)).toBe(true);
        expect(
          batches.map((batch) => batch.contacts.length).toSorted((a, b) => a - b),
        ).toStrictEqual([5, 20, 20]);
        expect(batches.flatMap((batch) => batch.contacts)).toContainEqual({
          email: "r1@example.com",
          attributes: { segment: "b" },
        });
        // Joined in file order, whichever batch answered first.
        expect(yield* parseJson(run.stdout)).toHaveProperty("contacts.44", {
          email: "r44@example.com",
          outcome: "updated",
          contactId,
        });
      }),
  );

  it.effect("refuses a name column before any request", () =>
    Effect.gen(function* () {
      const service = fakeService();
      const file = yield* tempFile("csv", "email,name,segment\nada@example.com,Ada,a\n");

      const run = yield* runCli(service, ["contacts", "set-attributes", "--file", file]);

      expect(Exit.isFailure(run.exit)).toBe(true);
      expect(run.stderr).toContain("name column");
      expect(service.received).toStrictEqual([]);
    }),
  );
});
