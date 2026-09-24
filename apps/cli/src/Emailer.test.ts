import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  campaignId,
  contactId,
  createdAt,
  inMemoryService,
  listId,
  otherToken,
  parseJson,
  runCli,
  tempFile,
  textBody,
  token,
  withService,
} from "../test/CliHarness.ts";

describe("the emailer executable", { timeout: 60_000 }, () => {
  it.live("prints help without credentials or a service", () =>
    Effect.gen(function* () {
      const result = yield* runCli("http://127.0.0.1:1", "", ["--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Manage contacts, lists, campaigns and addresses");
      expect(result.stdout).toContain("campaigns");
      expect(result.stdout).toContain("addresses");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects an unknown subcommand with a nonzero exit and usage on stdout", () =>
    Effect.gen(function* () {
      const result = yield* runCli("http://127.0.0.1:1", token, ["contacts", "destroy"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("USAGE");
      expect(result.stdout.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects an argument the contract does not accept, before any request", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["contacts", "create", "--email", "not-an-address"]),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid value for flag --email");
      expect(result.stdout.startsWith("{")).toBe(false);

      expect(service.authorizations).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("attaches the configured credential to its requests", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["contacts", "create", "--email", "sam@example.com"]),
      );

      expect(result.exitCode).toBe(0);
      expect(service.authorizations).toStrictEqual([token]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a refused credential on stderr and exits nonzero", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, otherToken, ["contacts", "create", "--email", "sam@example.com"]),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Unauthorized");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a missing entity on stderr and exits nonzero", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["campaigns", "get", campaignId]),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("NotFound");
      expect(result.stdout).toBe("");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("runs the whole flow and prints machine-readable results on stdout", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);
      const text = yield* tempFile("txt", textBody);

      const outcome = yield* withService(service, (baseUrl) =>
        Effect.gen(function* () {
          const contact = yield* runCli(baseUrl, token, [
            "contacts",
            "create",
            "--email",
            "sam@example.com",
            "--name",
            "Sam",
          ]);

          const list = yield* runCli(baseUrl, token, ["lists", "create", "--name", "Readers"]);

          const member = yield* runCli(baseUrl, token, ["lists", "add-contact", listId, contactId]);

          const campaign = yield* runCli(baseUrl, token, [
            "campaigns",
            "create",
            "--list",
            listId,
            "--subject",
            "Release notes",
            "--text",
            text,
          ]);

          const sent = yield* runCli(baseUrl, token, ["campaigns", "send", campaignId]);
          const replayed = yield* runCli(baseUrl, token, ["campaigns", "send", campaignId]);

          return { contact, list, member, campaign, sent, replayed };
        }),
      );

      expect(outcome.contact.exitCode).toBe(0);
      expect(yield* parseJson(outcome.contact.stdout)).toStrictEqual({
        id: contactId,
        email: "sam@example.com",
        name: "Sam",
        createdAt,
      });

      expect(outcome.list.exitCode).toBe(0);
      expect(outcome.member.exitCode).toBe(0);
      expect(outcome.campaign.exitCode).toBe(0);

      const created = yield* parseJson(outcome.campaign.stdout);

      expect(created).toMatchObject({
        submission: { state: "draft" },
      });
      expect(created).not.toHaveProperty("html");

      expect(outcome.sent.exitCode).toBe(0);
      expect(yield* parseJson(outcome.sent.stdout)).toMatchObject({
        submission: { state: "queued", queuedAt: createdAt },
      });

      expect(yield* parseJson(outcome.replayed.stdout)).toStrictEqual(
        yield* parseJson(outcome.sent.stdout),
      );
      expect(outcome.replayed.exitCode).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a page size outside the contract before issuing any request", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["contacts", "list", "--limit", "500"]),
      );

      expect(result.exitCode).not.toBe(0);
      expect(service.authorizations).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // A page reports its cursor in the contract's own form, so the flag has to accept exactly that
  // string. The two halves are pinned apart — `Schemas.test.ts` that a page's value survives the
  // wire unchanged, and this that the flag takes it — because between them sits the client, which
  // is the layer that used to hand the CLI a value it could not be given back.
  it.live("accepts the cursor form a page reports, without a round trip to reject it", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["contacts", "list", "--cursor", `${createdAt}#${contactId}`]),
      );

      expect(result.exitCode).toBe(0);
      expect(service.authorizations).toStrictEqual([token]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // The reporter wraps provisioning, so a configuration read that fails before any request still
  // produces one useful line on stderr rather than an empty nonzero exit.
  it.live("reports missing configuration on stderr and writes nothing to stdout", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["contacts", "get", contactId], { EMAILER_API_URL: "" }),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("emailer:");
      expect(result.stderr.trim()).not.toBe("");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // An unexpected defect is the case the old per-call wrapper handled worst: it mapped every
  // failure to a tag and lost the rest. A defect must still reach stderr with something an
  // operator can act on, and must not reach stdout.
  it.live("reports an unexpected defect on stderr with a usable message", () =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["contacts", "get", contactId], {
          // A URL the client accepts and then cannot reach: the failure surfaces from inside
          // the request rather than from argument parsing.
          EMAILER_API_URL: "http://127.0.0.1:1",
        }),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("emailer:");
      expect(result.stderr.length).toBeGreaterThan("emailer: ".length + 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
