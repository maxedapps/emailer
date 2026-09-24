import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  inMemoryService,
  listId,
  parseJson,
  runCli,
  toJson,
  token,
  withService,
  withTempFile,
} from "../../test/CliHarness.ts";

describe("list management from the command line", () => {
  it("rejects a malformed import file before issuing any request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const file = `${tmpdir()}/emailer-import-${randomUUID()}.json`;

        const contents = yield* toJson({ contacts: [{ email: "not-an-address" }] });

        yield* Effect.promise(() => writeFile(file, contents));

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["lists", "import", listId, "--file", file]),
        );

        yield* Effect.promise(() => rm(file, { force: true }));

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout.startsWith("{")).toBe(false);
        expect(service.authorizations).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("rejects an import file naming one address twice, before issuing any request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const file = `${tmpdir()}/emailer-import-${randomUUID()}.json`;

        const contents = yield* toJson({
          contacts: [{ email: "Sam@example.com" }, { email: "sam@EXAMPLE.com" }],
        });

        yield* Effect.promise(() => writeFile(file, contents));

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["lists", "import", listId, "--file", file]),
        );

        yield* Effect.promise(() => rm(file, { force: true }));

        expect(result.exitCode).not.toBe(0);
        expect(service.authorizations).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("imports the contacts a well-formed file names", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const contents = yield* toJson({
          contacts: [{ email: "sam@example.com", attributes: { plan: "pro" } }],
        });

        const result = yield* withService(service, (baseUrl) =>
          Effect.gen(function* () {
            yield* runCli(baseUrl, token, ["lists", "create", "--name", "Readers"]);

            return yield* withTempFile("json", contents, (file) =>
              runCli(baseUrl, token, ["lists", "import", listId, "--file", file]),
            );
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(yield* parseJson(result.stdout)).toMatchObject({
          contacts: [{ email: "sam@example.com", member: true }],
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("rejects an import file with a misspelled entry key, naming it, before any request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const contents = yield* toJson({
          contacts: [{ email: "sam@example.com", attributs: { plan: "pro" } }],
        });

        const result = yield* withTempFile("json", contents, (file) =>
          withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["lists", "import", listId, "--file", file]),
          ),
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Invalid value for flag --file");
        expect(result.stderr).toContain(
          'Expected no excess property\n  at ["contacts"][0]["attributs"]',
        );
        expect(result.stdout.startsWith("{")).toBe(false);
        expect(service.authorizations).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("lists, renames and deletes a list from the command line", () =>
    Effect.runPromise(
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
        expect(outcome.after.stderr).toContain("NotFound");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));
});
