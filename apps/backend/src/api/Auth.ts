import { AdminAuthorization, Integration, SubscriptionAuthorization } from "@emailer/api/Api";
import { Unauthorized } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Config, Crypto, Data, Effect, Layer, Option, Redacted, Schema } from "effect";

import { newIdentifier, nowIso } from "../Identifiers.ts";
import { ApiKeyStore } from "../storage/ApiKeys.ts";
import { hashSecret, issueSecret, tokensMatch } from "../Tokens.ts";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export class MalformedApiToken extends Data.TaggedError("MalformedApiToken")<{
  readonly reason: "absent" | "wrong-format";
}> {}

/**
 * The configured credential, still redacted. It is unwrapped in exactly two places — the format
 * check below and the comparison in `adminAuthorization` — so that nothing between here and there
 * can put it in a log line, an error or a stack frame by accident.
 */
export const apiToken = Effect.gen(function* () {
  const configured = yield* Config.Redacted("EMAILER_API_TOKEN").pipe(
    Effect.mapError(() => new MalformedApiToken({ reason: "absent" })),
  );

  if (!tokenPattern.test(Redacted.value(configured))) {
    return yield* new MalformedApiToken({ reason: "wrong-format" });
  }

  return configured;
});

/** The admin token is checked in memory: an administrative call reads nothing to authorize. */
export const adminAuthorization = (expected: Redacted.Redacted<string>) =>
  Layer.succeed(AdminAuthorization)(
    AdminAuthorization.of({
      bearer: (httpEffect, options) =>
        tokensMatch(Redacted.value(expected), Redacted.value(options.credential))
          ? httpEffect
          : Effect.fail(new Unauthorized()),
    }),
  );

const keyPrefix = "emk.";

/**
 * A scoped key as presented: `emk.<id>.<secret>`. The admin token has no such prefix, so it never
 * parses as a key, and a key is never compared with the admin token.
 */
const decodeScopedKey = Schema.decodeUnknownOption(
  Schema.TemplateLiteralParser([
    keyPrefix,
    Schemas.EntityId,
    ".",
    Schema.String.check(Schema.isPattern(tokenPattern)),
  ]),
);

/**
 * A scoped key reaches only the sign-up endpoints, and gives them its lists and confirm page. A key
 * that does not parse, is unknown or revoked, or whose secret does not hash to the stored hash is
 * refused alike.
 */
export const subscriptionAuthorization = Layer.effect(SubscriptionAuthorization)(
  Effect.gen(function* () {
    const keys = yield* ApiKeyStore;
    const crypto = yield* Crypto.Crypto;

    return SubscriptionAuthorization.of({
      bearer: Effect.fnUntraced(function* (httpEffect, options) {
        const presented = decodeScopedKey(Redacted.value(options.credential));

        if (Option.isNone(presented)) {
          return yield* new Unauthorized();
        }

        const [, keyId, , secret] = presented.value;

        const stored = yield* keys
          .getKey(keyId)
          .pipe(Effect.catchTag("ApiKeyNotFound", () => Effect.fail(new Unauthorized())));

        const hash = yield* hashSecret(Redacted.make(secret)).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        );

        if (!tokensMatch(stored.secretHash, hash)) {
          return yield* new Unauthorized();
        }

        return yield* Effect.provideService(httpEffect, Integration, {
          keyId,
          lists: stored.lists,
          confirmUrl: stored.confirmUrl,
        });
      }),
    });
  }),
);

/** Issues a key, stores only its secret's hash, and answers the key: the one time it is shown. */
export const createKey = Effect.fn("Auth.createKey")(function* (
  payload: Schemas.CreateApiKeyPayload,
) {
  const keys = yield* ApiKeyStore;
  const id = yield* newIdentifier;
  const secret = yield* issueSecret;

  const key: Schemas.ApiKey = {
    id,
    name: payload.name,
    lists: payload.lists,
    confirmUrl: payload.confirmUrl,
    createdAt: yield* nowIso,
  };

  yield* keys.createKey({ ...key, secretHash: yield* hashSecret(secret) });

  return {
    ...key,
    key: `${keyPrefix}${id}.${Redacted.value(secret)}`,
  } satisfies Schemas.CreatedApiKey;
});
