import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Exit, Schema } from "effect";

import {
  contactId,
  fakeService,
  listId,
  parseJson,
  readers,
  runCli,
  tempFile,
  toJson,
} from "../../test/CliHarness.ts";

/** A file of `count` distinct subscribers, in order. */
const subscribers = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ email: `reader${index}@example.com` }));

const importFile = (contacts: ReadonlyArray<unknown>) =>
  Effect.flatMap(toJson({ contacts }), (contents) => tempFile("json", contents));

describe("list management from the command line", () => {
  it.effect("rejects a malformed import file before issuing any request", () =>
    Effect.gen(function* () {
      const service = fakeService({ lists: [readers] });
      const file = yield* importFile([{ email: "not-an-address" }]);

      const run = yield* runCli(service, ["lists", "import", listId, "--file", file]);

      expect(Exit.isFailure(run.exit)).toBe(true);
      // A usage error prints help, never a result.
      expect(run.stdout.startsWith("{")).toBe(false);
      expect(service.received).toStrictEqual([]);
    }),
  );

  it.effect(
    "rejects an import file naming one address twice, batches apart, before any request",
    () =>
      Effect.gen(function* () {
        const service = fakeService({ lists: [readers] });
        const contacts = subscribers(30);

        contacts[0] = { email: "Sam@example.com" };
        contacts[25] = { email: "sam@EXAMPLE.com" };

        const run = yield* runCli(service, [
          "lists",
          "import",
          listId,
          "--file",
          yield* importFile(contacts),
        ]);

        expect(Exit.isFailure(run.exit)).toBe(true);
        expect(service.received).toStrictEqual([]);
      }),
  );

  it.effect(
    "rejects an import file with a misspelled entry key, naming it, before any request",
    () =>
      Effect.gen(function* () {
        const service = fakeService({ lists: [readers] });
        const file = yield* importFile([{ email: "sam@example.com", attributs: { plan: "pro" } }]);

        const run = yield* runCli(service, ["lists", "import", listId, "--file", file]);

        expect(Exit.isFailure(run.exit)).toBe(true);
        expect(run.stderr).toContain("Invalid value for flag --file");
        expect(run.stderr).toContain(
          'Expected no excess property\n  at ["contacts"][0]["attributs"]',
        );
        expect(service.received).toStrictEqual([]);
      }),
  );

  it.effect("imports a file larger than one call in batches and answers for it in file order", () =>
    Effect.gen(function* () {
      const service = fakeService({ lists: [readers] });
      const contacts = subscribers(45);

      const run = yield* runCli(service, [
        "lists",
        "import",
        listId,
        "--file",
        yield* importFile(contacts),
      ]);

      const decodeBatch = Schema.decodeUnknownEffect(Schemas.ImportContactsPayload);

      const batches = yield* Effect.forEach(service.payloadsOf("lists.import"), (payload) =>
        decodeBatch(payload),
      );

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(batches.map((batch) => batch.contacts.length).toSorted((a, b) => a - b)).toStrictEqual(
        [5, 20, 20],
      );
      expect(yield* parseJson(run.stdout)).toMatchObject({
        contacts: contacts.map((contact) => ({ email: contact.email, member: true })),
      });
    }),
  );

  it.effect("imports a CSV export, taking extra columns as attributes", () =>
    Effect.gen(function* () {
      const service = fakeService({ lists: [readers] });
      const file = yield* tempFile("csv", "Email,Name,plan\nada@example.com,Ada,pro\n");

      const run = yield* runCli(service, ["lists", "import", listId, "--file", file]);

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(service.payloadsOf("lists.import")).toMatchObject([
        { contacts: [{ email: "ada@example.com", name: "Ada", attributes: { plan: "pro" } }] },
      ]);
    }),
  );

  // Live: the retry backs off on the clock, from half a second.
  it.live("sends a call again when the service could not complete it", () =>
    Effect.gen(function* () {
      const service = fakeService({
        lists: [readers],
        importFailures: [
          new Errors.StorageUnavailable({
            operation: "importContacts",
            failure: "ThrottlingException",
          }),
        ],
      });

      const run = yield* runCli(service, [
        "lists",
        "import",
        listId,
        "--file",
        yield* importFile(subscribers(1)),
      ]);

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(service.payloadsOf("lists.import")).toHaveLength(2);
    }),
  );

  it.effect("does not repeat a call into a missing list, and says a re-run is safe", () =>
    Effect.gen(function* () {
      const service = fakeService();

      const run = yield* runCli(service, [
        "lists",
        "import",
        listId,
        "--file",
        yield* importFile(subscribers(1)),
      ]);

      expect(Exit.isFailure(run.exit)).toBe(true);
      expect(service.payloadsOf("lists.import")).toHaveLength(1);
      expect(run.stderr).toContain("ListNotFound");
      expect(run.stderr).toContain(
        "Stopped with 0 of 1 contacts confirmed; running the same file again is safe",
      );
    }),
  );

  it.effect.each([
    [["lists", "rename", listId, "--name", "Monthly"], "lists.update", { name: "Monthly" }],
    [["lists", "add-contact", listId, contactId], "lists.addContact", undefined],
    [["lists", "remove-contact", listId, contactId], "lists.removeContact", undefined],
    [["lists", "delete", listId], "lists.remove", undefined],
  ] as const)("runs %j as %s", ([args, endpoint, payload]) =>
    Effect.gen(function* () {
      const service = fakeService({ lists: [readers] });

      const run = yield* runCli(service, args);

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(service.received.map((request) => request.endpoint)).toStrictEqual([endpoint]);
      expect(service.payloadsOf(endpoint)).toStrictEqual([payload]);
    }),
  );
});
