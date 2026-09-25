import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  inMemoryService,
  listId,
  parseJson,
  runCli,
  tempFile,
  toJson,
  token,
  withService,
} from "../../test/CliHarness.ts";

/** A file of `count` distinct readers, in order. */
const readers = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ email: `reader${index}@example.com` }));

describe("list management from the command line", () => {
  it.live("rejects a malformed import file before issuing any request", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const contents = yield* toJson({ contacts: [{ email: "not-an-address" }] });

      const file = yield* tempFile("json", contents);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["lists", "import", listId, "--file", file]),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.startsWith("{")).toBe(false);
      expect(service.authorizations).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "rejects an import file naming one address twice, batches apart, before any request",
    () =>
      Effect.gen(function* () {
        const service = inMemoryService(token);
        const contacts = readers(30);

        contacts[0] = { email: "Sam@example.com" };
        contacts[25] = { email: "sam@EXAMPLE.com" };

        const contents = yield* toJson({ contacts });

        const file = yield* tempFile("json", contents);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["lists", "import", listId, "--file", file]),
        );

        expect(result.exitCode).not.toBe(0);
        expect(service.authorizations).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("imports the contacts a well-formed file names", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const contents = yield* toJson({
        contacts: [{ email: "sam@example.com", attributes: { plan: "pro" } }],
      });

      const file = yield* tempFile("json", contents);

      const result = yield* withService(service, (baseUrl) =>
        Effect.gen(function* () {
          yield* runCli(baseUrl, token, ["lists", "create", "--name", "Readers"]);

          return yield* runCli(baseUrl, token, ["lists", "import", listId, "--file", file]);
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(yield* parseJson(result.stdout)).toMatchObject({
        contacts: [{ email: "sam@example.com", member: true }],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("imports a file larger than one call in batches and answers for it in file order", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);
      const contacts = readers(45);

      const file = yield* tempFile("json", yield* toJson({ contacts }));

      const result = yield* withService(service, (baseUrl) =>
        Effect.gen(function* () {
          yield* runCli(baseUrl, token, ["lists", "create", "--name", "Readers"]);

          return yield* runCli(baseUrl, token, ["lists", "import", listId, "--file", file]);
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(
        service.importCalls.map((call) => call.length).toSorted((a, b) => a - b),
      ).toStrictEqual([5, 20, 20]);
      expect(yield* parseJson(result.stdout)).toMatchObject({
        contacts: contacts.map((contact) => ({ email: contact.email, member: true })),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("sends a call again when the service could not complete it", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token, { importUnavailableOnce: true });

      const file = yield* tempFile("json", yield* toJson({ contacts: readers(1) }));

      const result = yield* withService(service, (baseUrl) =>
        Effect.gen(function* () {
          yield* runCli(baseUrl, token, ["lists", "create", "--name", "Readers"]);

          return yield* runCli(baseUrl, token, ["lists", "import", listId, "--file", file]);
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(service.importCalls).toHaveLength(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not repeat a call into a missing list, and says a re-run is safe", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const file = yield* tempFile("json", yield* toJson({ contacts: readers(1) }));

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["lists", "import", listId, "--file", file]),
      );

      expect(result.exitCode).not.toBe(0);
      expect(service.importCalls).toHaveLength(1);
      expect(result.stderr).toContain("ListNotFound");
      expect(result.stderr).toContain(
        "Stopped after 0 of 1 contacts were imported; running the same file again is safe",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("imports a CSV export, taking extra columns as attributes", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const file = yield* tempFile("csv", "Email,Name,plan\nada@example.com,Ada,pro\n");

      const result = yield* withService(service, (baseUrl) =>
        Effect.gen(function* () {
          yield* runCli(baseUrl, token, ["lists", "create", "--name", "Readers"]);

          return yield* runCli(baseUrl, token, ["lists", "import", listId, "--file", file]);
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(service.importCalls).toMatchObject([
        [{ email: "ada@example.com", name: "Ada", attributes: { plan: "pro" } }],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects an import file with a misspelled entry key, naming it, before any request", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const contents = yield* toJson({
        contacts: [{ email: "sam@example.com", attributs: { plan: "pro" } }],
      });

      const file = yield* tempFile("json", contents);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["lists", "import", listId, "--file", file]),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid value for flag --file");
      expect(result.stderr).toContain(
        'Expected no excess property\n  at ["contacts"][0]["attributs"]',
      );
      expect(result.stdout.startsWith("{")).toBe(false);
      expect(service.authorizations).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("lists, renames and deletes a list from the command line", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const outcome = yield* withService(service, (baseUrl) =>
        Effect.gen(function* () {
          yield* runCli(baseUrl, token, ["lists", "create", "--name", "Weekly"]);

          const renamed = yield* runCli(baseUrl, token, [
            "lists",
            "rename",
            listId,
            "--name",
            "Monthly",
          ]);

          const listed = yield* runCli(baseUrl, token, ["lists", "list"]);
          const deleted = yield* runCli(baseUrl, token, ["lists", "delete", listId]);
          const after = yield* runCli(baseUrl, token, ["lists", "get", listId]);

          return { renamed, listed, deleted, after };
        }),
      );

      expect(outcome.renamed.stdout).toContain("Monthly");
      expect(outcome.listed.stdout).toContain("Monthly");
      expect(outcome.deleted.exitCode).toBe(0);
      expect(outcome.after.exitCode).not.toBe(0);
      expect(outcome.after.stderr).toContain("ListNotFound");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
