import { ConfigProvider, Effect, Inspectable, Redacted, Result } from "effect";
import { describe, expect, it } from "vitest";

import { apiToken, MalformedApiToken } from "./Auth.ts";

const validToken = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

const withEnvironment = (environment: Readonly<Record<string, string>>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(environment));

describe("apiToken", () => {
  it("resolves a well-formed token, still redacted", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const resolved = yield* apiToken;

        expect(Redacted.value(resolved)).toBe(validToken);
        // It reaches the comparison boundary redacted, so nothing between here and there can
        // print it by accident — inspecting it, which is what a log line or a diagnostic does,
        // yields the marker rather than the credential.
        expect(Inspectable.toStringUnknown(resolved)).not.toContain(validToken);
      }).pipe(withEnvironment({ EMAILER_API_TOKEN: validToken })),
    ));

  it("fails when the token is absent", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(apiToken);

        expect(Result.isFailure(attempt) && attempt.failure.reason).toBe("absent");
      }).pipe(withEnvironment({})),
    ));

  it("fails when the token does not match the agreed format", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(apiToken);

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toBeInstanceOf(
          MalformedApiToken,
        );
        expect(Result.isFailure(attempt) && attempt.failure.reason).toBe("wrong-format");
      }).pipe(withEnvironment({ EMAILER_API_TOKEN: "too-short" })),
    ));

  it("never carries the configured value in the failure it reports", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(apiToken);
        const failure = Result.isFailure(attempt) ? attempt.failure : undefined;

        expect(failure === undefined ? [] : Object.keys(failure).sort()).toStrictEqual([
          "_tag",
          "reason",
        ]);
      }).pipe(withEnvironment({ EMAILER_API_TOKEN: "hunter2-but-the-wrong-shape" })),
    ));

  it("does not accept a 43-character value outside the base64url alphabet", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(apiToken);

        expect(Result.isFailure(attempt) && attempt.failure.reason).toBe("wrong-format");
      }).pipe(withEnvironment({ EMAILER_API_TOKEN: "!".repeat(43) })),
    ));
});
