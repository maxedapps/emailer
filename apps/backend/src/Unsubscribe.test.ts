import { maxEmailLength } from "@emailer/api/Schemas";
import { ConfigProvider, Effect, Option, Result } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  maxTokenLength,
  mintToken,
  unsubscribeLink,
  unsubscribeSigningKey,
  verifyToken,
} from "./Unsubscribe.ts";

const email = "Recipient@Example.com";

const mailbox = "recipient@example.com";

const secret = "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718293a4b5c6d7e8f90";

const otherSecret = "1c383cd30b7c298ab50293adfecb7b18dd1c2b9dd3f4e5a6978899aabbccddee";

const baseUrl = "https://unsubscribe-abc123.lambda-url.eu-central-1.on.aws";

// 254 bytes: the longest address the shared schema admits, and so the longest token.
const longestAddress = `${"a".repeat(maxEmailLength - "@example.com".length)}@example.com`;

const withEnvironment = (environment: Readonly<Record<string, string>>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(environment));

const signingKeyFor = (configured: string) =>
  unsubscribeSigningKey.pipe(withEnvironment({ EMAILER_UNSUBSCRIBE_SECRET: configured }));

const payloadOf = (token: string): string => token.split(".")[1] ?? "";

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/** A token signed the way the implementation should sign, built without calling it. */
const signIndependently = (key: string, payload: string): string => {
  const signed = `v1.${payload}`;

  return `${signed}.${createHmac("sha256", key).update(signed).digest("hex")}`;
};

const forgeries: ReadonlyArray<readonly [string, (minted: string, alien: string) => string]> = [
  ["a tampered payload", (minted) => signIndependently(otherSecret, payloadOf(minted))],
  ["a tampered digest", (minted) => `${minted.slice(0, -1)}${minted.endsWith("a") ? "b" : "a"}`],
  ["a truncated token", (minted) => minted.slice(0, -4)],
  ["a token without a separator", (minted) => minted.replace(".", "")],
  ["a token signed under another secret", (_minted, alien) => alien],
  ["an unknown version", (minted) => `v2${minted.slice(2)}`],
  ["an uppercase digest", (minted) => minted.toUpperCase()],
  ["a payload outside the base64url alphabet", (minted) => minted.replace(/\./, ".+")],
];

describe("unsubscribe tokens", () => {
  it("matches an independently computed HMAC over the versioned payload", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);

        expect(mintToken(signingKey, email)).toBe(signIndependently(secret, encode(mailbox)));
      }),
    ));

  // Links already sit in inboxes, so the exact bytes a key and an address mint are a contract. The
  // twenty-byte address does not end on a base64 group, which pins the encoding as unpadded.
  it.each([
    [
      email,
      mailbox,
      "v1.cmVjaXBpZW50QGV4YW1wbGUuY29t.051454aaab35bc94e7d5bfbe7438617a78c802ee64b584ff42af318ef228a44b",
    ],
    [
      "recipient@example.co",
      "recipient@example.co",
      "v1.cmVjaXBpZW50QGV4YW1wbGUuY28.e053d45987c097a0813b4f677c491477e83b83d4ccc37c1638970c530f6edbb6",
    ],
  ])("mints and verifies the exact token already issued for %s", (address, expected, token) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);

        expect(mintToken(signingKey, address)).toBe(token);
        expect(verifyToken(signingKey, token)).toStrictEqual(Option.some(expected));
      }),
    ),
  );

  it("verifies a token it minted and yields the mailbox back", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);

        expect(verifyToken(signingKey, mintToken(signingKey, email))).toStrictEqual(
          Option.some(mailbox),
        );
      }),
    ));

  it("canonicalizes the address before signing, so one mailbox has one token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);

        expect(mintToken(signingKey, " RECIPIENT@EXAMPLE.COM ")).toBe(mintToken(signingKey, email));
      }),
    ));

  it("round trips an address carrying the legal punctuation the schema permits", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);
        const punctuated = "first.last+tag_v1!#$%&'*/=?^`{|}~-@sub.example.co.uk";

        expect(verifyToken(signingKey, mintToken(signingKey, punctuated))).toStrictEqual(
          Option.some(punctuated),
        );
      }),
    ));

  it("stays within the derived bound at the longest permitted address", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);
        const token = mintToken(signingKey, longestAddress);

        expect(longestAddress).toHaveLength(maxEmailLength);
        expect(maxTokenLength).toBe(407);
        expect(token).toHaveLength(maxTokenLength);
        expect(verifyToken(signingKey, token)).toStrictEqual(Option.some(longestAddress));
      }),
    ));

  it.each(forgeries)("rejects %s", (_description, forge) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);
        const alienKey = yield* signingKeyFor(otherSecret);

        const minted = mintToken(signingKey, email);
        const presented = forge(minted, mintToken(alienKey, email));

        expect(presented).not.toBe(minted);
        expect(verifyToken(signingKey, presented)).toStrictEqual(Option.none());
      }),
    ),
  );

  it("rejects a correctly signed token whose payload is not a valid mailbox", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);

        for (const payload of ["not-an-address", "", "a@b@c.com", " recipient@example.com"]) {
          expect(verifyToken(signingKey, signIndependently(secret, encode(payload)))).toStrictEqual(
            Option.none(),
          );
        }
      }),
    ));

  it("rejects a correctly signed token whose mailbox is not canonical", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);

        // Signed by us and a valid address, but it does not name the lowercase
        // key the consent record is stored under, so it must not opt anyone out.
        expect(
          verifyToken(signingKey, signIndependently(secret, encode("Recipient@example.com"))),
        ).toStrictEqual(Option.none());
      }),
    ));

  it("rejects a correctly signed token whose payload is not canonically encoded", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);

        // Twenty bytes, so the encoding does not end on a group boundary and the
        // final character carries bits that mean nothing. An address whose length
        // is a multiple of three has no such slack and no alternate spelling.
        const unaligned = "recipient@example.co";
        const canonical = encode(unaligned);

        const alternate = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
          .split("")
          .map((character) => `${canonical.slice(0, -1)}${character}`)
          .find(
            (candidate) =>
              candidate !== canonical &&
              Buffer.from(candidate, "base64url").toString("utf8") === unaligned,
          );

        // Same bytes, unused trailing bits set: it decodes to the same mailbox,
        // so only the round-trip check distinguishes it.
        expect(alternate).toBeDefined();
        expect(verifyToken(signingKey, signIndependently(secret, alternate ?? ""))).toStrictEqual(
          Option.none(),
        );

        // The canonical spelling of the same mailbox is still accepted.
        expect(verifyToken(signingKey, signIndependently(secret, canonical))).toStrictEqual(
          Option.some(unaligned),
        );
      }),
    ));

  it("rejects a token longer than the derived bound before doing any work", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);
        const overlong = signIndependently(secret, encode(`${longestAddress}x`));

        expect(overlong.length).toBeGreaterThan(maxTokenLength);
        expect(verifyToken(signingKey, overlong)).toStrictEqual(Option.none());
      }),
    ));
});

describe("unsubscribeLink", () => {
  it.each([baseUrl, `${baseUrl}/`])("builds the link from the base URL %s", (configured) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingKey = yield* signingKeyFor(secret);

        const link = yield* unsubscribeLink(email).pipe(
          withEnvironment({
            EMAILER_UNSUBSCRIBE_URL: configured,
            EMAILER_UNSUBSCRIBE_SECRET: secret,
          }),
        );

        expect(link).toBe(`${baseUrl}/unsubscribe/${mintToken(signingKey, email)}`);
      }),
    ),
  );

  it("fails rather than building a partial link when the base URL is absent", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(
          unsubscribeLink(email).pipe(withEnvironment({ EMAILER_UNSUBSCRIBE_SECRET: secret })),
        );

        expect(Result.isFailure(attempt)).toBe(true);
      }),
    ));

  it("fails rather than building an unsigned link when the secret is absent", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = yield* Effect.result(
          unsubscribeLink(email).pipe(withEnvironment({ EMAILER_UNSUBSCRIBE_URL: baseUrl })),
        );

        expect(Result.isFailure(attempt)).toBe(true);
      }),
    ));
});
