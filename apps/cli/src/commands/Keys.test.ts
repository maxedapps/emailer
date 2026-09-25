import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import {
  confirmUrl,
  createdAt,
  fakeService,
  keyId,
  listId,
  parseJson,
  runCli,
  token,
} from "../../test/CliHarness.ts";

const otherListId = "0195f0a0-1111-4222-8333-44444444209e";

describe("scoped keys from the command line", () => {
  it.effect("creates a key for every list given and prints it, key included", () =>
    Effect.gen(function* () {
      const service = fakeService();

      const run = yield* runCli(service, [
        "keys",
        "create",
        "--name",
        "Website",
        "--list",
        listId,
        "--list",
        otherListId,
        "--confirm-url",
        confirmUrl,
      ]);

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(service.payloadsOf("keys.create")).toStrictEqual([
        { name: "Website", lists: [listId, otherListId], confirmUrl },
      ]);
      expect(yield* parseJson(run.stdout)).toStrictEqual({
        id: keyId,
        name: "Website",
        lists: [listId, otherListId],
        confirmUrl,
        createdAt,
        key: `emk.${keyId}.${token}`,
      });
    }),
  );

  it.effect.each([
    ["no list", ["--confirm-url", confirmUrl]],
    ["a confirm page that is not https", ["--list", listId, "--confirm-url", "http://example.com"]],
  ] as const)("refuses a key with %s before any request", ([_label, flags]) =>
    Effect.gen(function* () {
      const service = fakeService();

      const run = yield* runCli(service, ["keys", "create", "--name", "Website", ...flags]);

      expect(Exit.isFailure(run.exit)).toBe(true);
      expect(service.received).toStrictEqual([]);
    }),
  );

  it.effect("lists the keys", () =>
    Effect.gen(function* () {
      const service = fakeService();

      const run = yield* runCli(service, ["keys", "list"]);

      expect(service.received).toStrictEqual([{ endpoint: "keys.list" }]);
      expect(yield* parseJson(run.stdout)).toStrictEqual([
        { id: keyId, name: "Website", lists: [listId], confirmUrl, createdAt },
      ]);
    }),
  );

  it.effect("revokes a key", () =>
    Effect.gen(function* () {
      const service = fakeService();

      const run = yield* runCli(service, ["keys", "revoke", keyId]);

      expect(service.received).toStrictEqual([{ endpoint: "keys.revoke", params: { id: keyId } }]);
      expect(yield* parseJson(run.stdout)).toStrictEqual({ id: keyId, revoked: true });
    }),
  );
});
