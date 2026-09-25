import { describe, expect, it } from "@effect/vitest";
import type * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";

import {
  campaignId,
  createdAt,
  draft,
  fakeService,
  listId,
  otherToken,
  parseJson,
  readers,
  runProcess,
  withServer,
} from "../test/CliHarness.ts";

/**
 * What only the real executable shows: exit codes, which stream each output reaches, the terminal
 * prompting on stderr, and configuration read from the environment. Everything a command decides
 * is tested in-process, beside the command.
 */
describe("the emailer executable", { timeout: 60_000 }, () => {
  it.live("prints help without credentials or a service", () =>
    Effect.gen(function* () {
      const result = yield* runProcess("http://127.0.0.1:1", ["--help"], {
        env: { EMAILER_API_TOKEN: "" },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Manage contacts, lists, campaigns, addresses and keys");
    }),
  );

  it.live("rejects an unknown subcommand with a nonzero exit and usage on stdout", () =>
    Effect.gen(function* () {
      const result = yield* runProcess("http://127.0.0.1:1", ["contacts", "destroy"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("USAGE");
    }),
  );

  it.live("rejects an invalid flag on stderr, with a nonzero exit, before any request", () =>
    Effect.gen(function* () {
      const service = fakeService();

      const result = yield* withServer(service, (baseUrl) =>
        runProcess(baseUrl, ["contacts", "create", "--email", "not-an-address"]),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid value for flag --email");
      expect(result.stdout.startsWith("{")).toBe(false);
      expect(service.received).toStrictEqual([]);
    }),
  );

  // The reporter wraps provisioning, so a configuration read that fails before any request still
  // produces one useful line on stderr rather than an empty nonzero exit.
  it.live("names missing configuration on stderr and writes nothing to stdout", () =>
    Effect.gen(function* () {
      const result = yield* runProcess("", ["campaigns", "get", campaignId]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("EMAILER_API_URL");
    }),
  );

  it.live("reports a refused credential on stderr and exits nonzero", () =>
    Effect.gen(function* () {
      const result = yield* withServer(fakeService(), (baseUrl) =>
        runProcess(baseUrl, ["contacts", "create", "--email", "sam@example.com"], {
          env: { EMAILER_API_TOKEN: otherToken },
        }),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Unauthorized");
    }),
  );

  it.live("reads a zone-less --at as UTC regardless of the operator's TZ", () =>
    Effect.gen(function* () {
      const service = fakeService({ campaigns: [draft] });

      const result = yield* withServer(service, (baseUrl) =>
        runProcess(baseUrl, ["campaigns", "schedule", campaignId, "--at", "2026-09-20T09:00"], {
          env: { TZ: "Europe/Berlin" },
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(service.payloadsOf("campaigns.schedule")).toStrictEqual([
        { sendAt: "2026-09-20T09:00:00.000Z" },
      ]);
    }),
  );

  it.live("asks on stderr before sending a test to a list, keeping stdout for the result", () =>
    Effect.gen(function* () {
      const members: ReadonlyArray<Schemas.Contact> = [
        { id: "0195f0a0-1111-4222-8333-4444444c0001", email: "r1@example.com", createdAt },
      ];

      const service = fakeService({ campaigns: [draft], lists: [readers], members });

      const result = yield* withServer(service, (baseUrl) =>
        runProcess(baseUrl, ["campaigns", "test", campaignId, "--list", listId], { stdin: "y" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Send a test of "Release notes" to 1 members of "Readers"?');
      expect(result.stdout).not.toContain("Send a test");
      expect(yield* parseJson(result.stdout)).toHaveProperty(
        "recipients.0.email",
        "r1@example.com",
      );
    }),
  );
});
