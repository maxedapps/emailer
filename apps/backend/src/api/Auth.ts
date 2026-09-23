import { Authorization, Unauthorized } from "@emailer/api/Api";
import { Config, Data, Effect, Layer, Redacted } from "effect";

import { tokensMatch } from "../SignedToken.ts";

export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export class MalformedApiToken extends Data.TaggedError("MalformedApiToken")<{
  readonly reason: "absent" | "wrong-format";
}> {}

/**
 * The configured credential, still redacted. It is unwrapped in exactly two places — the format
 * check below and the comparison in `authorizationUsing` — so that nothing between here and there
 * can put it in a log line, an error or a stack frame by accident.
 */
export const apiToken = Effect.gen(function* () {
  const configured = yield* Config.redacted("EMAILER_API_TOKEN").pipe(
    Effect.mapError(() => new MalformedApiToken({ reason: "absent" })),
  );

  if (!tokenPattern.test(Redacted.value(configured))) {
    return yield* new MalformedApiToken({ reason: "wrong-format" });
  }

  return configured;
});

export const authorizationUsing = (expected: Redacted.Redacted<string>) =>
  Layer.succeed(Authorization)(
    Authorization.of({
      bearer: (httpEffect, options) =>
        tokensMatch(Redacted.value(expected), Redacted.value(options.credential))
          ? httpEffect
          : Effect.fail(new Unauthorized()),
    }),
  );
