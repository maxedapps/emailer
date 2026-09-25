import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Integration, SubscriptionAuthorization } from "@emailer/api/Api";
import { ApiKeyNotFound, StorageUnavailable } from "@emailer/api/Errors";
import { ConfigProvider, Effect, Inspectable, Layer, Redacted, Result, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { apiToken, MalformedApiToken, subscriptionAuthorization } from "./Auth.ts";
import { ApiKeyStore } from "../storage/ApiKeys.ts";

import type { StoredApiKey } from "../storage/ApiKeys.ts";

const validToken = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

const withEnvironment = (environment: Readonly<Record<string, string>>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(environment));

describe("apiToken", () => {
  it.effect("resolves a well-formed token, still redacted", () =>
    Effect.gen(function* () {
      const resolved = yield* apiToken;

      expect(Redacted.value(resolved)).toBe(validToken);
      // It reaches the comparison boundary redacted, so nothing between here and there can
      // print it by accident — inspecting it, which is what a log line or a diagnostic does,
      // yields the marker rather than the credential.
      expect(Inspectable.toStringUnknown(resolved)).not.toContain(validToken);
    }).pipe(withEnvironment({ EMAILER_API_TOKEN: validToken })),
  );

  it.effect("fails when the token is absent", () =>
    Effect.gen(function* () {
      const attempt = yield* Effect.result(apiToken);

      expect(Result.isFailure(attempt) && attempt.failure.reason).toBe("absent");
    }).pipe(withEnvironment({})),
  );

  it.effect("fails when the token does not match the agreed format", () =>
    Effect.gen(function* () {
      const attempt = yield* Effect.result(apiToken);

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toBeInstanceOf(
        MalformedApiToken,
      );
      expect(Result.isFailure(attempt) && attempt.failure.reason).toBe("wrong-format");
    }).pipe(withEnvironment({ EMAILER_API_TOKEN: "too-short" })),
  );

  it.effect("never carries the configured value in the failure it reports", () =>
    Effect.gen(function* () {
      const attempt = yield* Effect.result(apiToken);
      const failure = Result.isFailure(attempt) ? attempt.failure : undefined;

      expect(failure === undefined ? [] : Object.keys(failure).sort()).toStrictEqual([
        "_tag",
        "reason",
      ]);
    }).pipe(withEnvironment({ EMAILER_API_TOKEN: "hunter2-but-the-wrong-shape" })),
  );

  it.effect("does not accept a 43-character value outside the base64url alphabet", () =>
    Effect.gen(function* () {
      const attempt = yield* Effect.result(apiToken);

      expect(Result.isFailure(attempt) && attempt.failure.reason).toBe("wrong-format");
    }).pipe(withEnvironment({ EMAILER_API_TOKEN: "!".repeat(43) })),
  );
});

const keyId = "0195f0a0-1111-4222-8333-44444444ce01";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const secret = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk-Ll_MmNnOoP";

const confirmUrl = "https://www.example.com/newsletter/confirm";

// Computed independently: `printf '%s' "$secret" | sha256sum`.
const storedKey: StoredApiKey = {
  id: keyId,
  name: "Website",
  lists: [listId],
  confirmUrl,
  createdAt: "2026-09-11T10:00:00.000Z",
  secretHash: "8ff2188e7463211f1a0af5b018552b52a593961c9d2787014067565a31862a83",
};

/** One endpoint behind the scoped-key middleware, answering the integration it was given. */
class ProbeGroup extends HttpApiGroup.make("probe")
  .add(
    HttpApiEndpoint.get("integration", "/integration", {
      success: Schema.Struct({
        keyId: Schema.String,
        lists: Schema.Array(Schema.String),
        confirmUrl: Schema.String,
      }),
    }),
  )
  .middleware(SubscriptionAuthorization) {}

class ProbeApi extends HttpApi.make("probe").add(ProbeGroup) {}

const probe = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  handlers.handle("integration", () => Effect.service(Integration)),
);

/** Asks the probe with `credential`, the key store answering `getKey` with `stored`. */
const presenting = (credential: string, stored: ApiKeyStore["Service"]["getKey"]) =>
  Effect.gen(function* () {
    const keys = Layer.succeed(ApiKeyStore)({
      createKey: () => Effect.die(new Error("createKey is not exercised")),
      getKey: stored,
      listKeys: () => Effect.die(new Error("listKeys is not exercised")),
      revokeKey: () => Effect.die(new Error("revokeKey is not exercised")),
    });

    const routes = HttpApiBuilder.layer(ProbeApi).pipe(
      Layer.provide(probe),
      Layer.provide(subscriptionAuthorization),
      Layer.provide(Layer.mergeAll(keys, NodeCrypto.layer, HttpServer.layerServices)),
    );

    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });

    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://emailer.test/integration", {
          headers: { authorization: `Bearer ${credential}` },
        }),
      ),
    );

    const body = yield* Effect.promise(() => response.text());

    yield* Effect.promise(() => dispose());

    return { status: response.status, body };
  });

const found = () => Effect.succeed(storedKey);

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

describe("subscriptionAuthorization", () => {
  it.effect("authorizes a stored key and provides its lists and confirm page", () =>
    Effect.gen(function* () {
      const response = yield* presenting(`emk.${keyId}.${secret}`, found);

      expect(response.status).toBe(200);
      expect(yield* parseJson(response.body)).toStrictEqual({ keyId, lists: [listId], confirmUrl });
    }),
  );

  it.effect.each([
    ["a wrong secret", `emk.${keyId}.${secret.slice(0, -1)}Q`, found],
    [
      "an unknown or revoked key",
      `emk.${keyId}.${secret}`,
      () => Effect.fail(new ApiKeyNotFound()),
    ],
    ["a key without its prefix", `${keyId}.${secret}`, found],
    ["a key whose secret is short", `emk.${keyId}.${secret.slice(1)}`, found],
    ["the admin token", "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY", found],
  ] as const)("refuses %s with 401", ([_label, credential, stored]) =>
    Effect.gen(function* () {
      expect((yield* presenting(credential, stored)).status).toBe(401);
    }),
  );

  it.effect("answers 503 when the key cannot be read", () =>
    Effect.gen(function* () {
      const response = yield* presenting(`emk.${keyId}.${secret}`, () =>
        Effect.fail(new StorageUnavailable({ operation: "getKey", failure: "TimeoutError" })),
      );

      expect(response.status).toBe(503);
    }),
  );
});
