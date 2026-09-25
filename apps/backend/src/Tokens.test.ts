import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Redacted } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createHmac } from "node:crypto";

import * as Tokens from "./Tokens.ts";

const validToken = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

const secret = "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718293a4b5c6d7e8f90";

const signingKey = Redacted.make(secret);

const fields = ["cmVjaXBpZW50", "1790000000"];

const format = { fields: 2, maxLength: Tokens.lengthFor([12, 10]) };

/** A token signed the way the implementation should sign, built without calling it. */
const signIndependently = (key: string, signed: string): string =>
  `${signed}.${createHmac("sha256", key).update(signed).digest("hex")}`;

describe("tokensMatch", () => {
  it("accepts the exact token", () => {
    expect(Tokens.tokensMatch(validToken, validToken)).toBe(true);
  });

  it("rejects a token that differs only in its last byte", () => {
    const almost = `${validToken.slice(0, -1)}Z`;

    expect(almost).toHaveLength(validToken.length);
    expect(Tokens.tokensMatch(validToken, almost)).toBe(false);
  });

  // The platform primitive throws on unequal lengths rather than answering false, so the guard
  // in front of it is load-bearing: without it every short credential would be a 500.
  it.each([
    ["", "empty"],
    ["a", "one byte"],
    [`${validToken}xx`, "longer"],
  ])("answers false rather than throwing for a %s credential", (supplied) => {
    expect(Tokens.tokensMatch(validToken, supplied)).toBe(false);
  });
});

describe("signed tokens", () => {
  it("signs the versioned fields with HMAC-SHA256 in lowercase hex", () => {
    expect(Tokens.sign(signingKey, fields)).toBe(
      signIndependently(secret, "v1.cmVjaXBpZW50.1790000000"),
    );
  });

  it("derives the length of a token from its field lengths", () => {
    expect(Tokens.sign(signingKey, fields)).toHaveLength(format.maxLength);
  });

  it("verifies a token it signed and yields the fields back", () => {
    expect(Tokens.verify(signingKey, Tokens.sign(signingKey, fields), format)).toStrictEqual(
      Option.some(fields),
    );
  });

  const minted = Tokens.sign(signingKey, fields);

  const prefixOf = (token: string) => token.slice(0, token.lastIndexOf(".") + 1);

  const digestOf = (token: string) => token.slice(token.lastIndexOf(".") + 1);

  it.each([
    ["a tampered field", minted.replace("1790000000", "1790000001")],
    ["a tampered digest", `${minted.slice(0, -1)}${minted.endsWith("a") ? "b" : "a"}`],
    ["an uppercase digest", `${prefixOf(minted)}${digestOf(minted).toUpperCase()}`],
    ["a truncated digest", minted.slice(0, -4)],
    ["a missing separator", minted.replace(".", "")],
    ["an unknown version", `v2${minted.slice(2)}`],
    ["a token signed under another key", Tokens.sign(Redacted.make("another key"), fields)],
    ["too few fields", Tokens.sign(signingKey, fields.slice(0, 1))],
    ["too many fields", Tokens.sign(signingKey, [...fields, "x"])],
    ["an empty field", Tokens.sign(signingKey, ["", "1790000000"])],
    ["a field outside the alphabet", signIndependently(secret, "v1.cmVja+BpZW50.1790000000")],
    ["an over-long token", `${minted}${"0".repeat(4)}`],
  ])("rejects %s", (_description, presented) => {
    expect(Tokens.verify(signingKey, presented, format)).toStrictEqual(Option.none());
  });

  it("refuses an over-long token before looking at its structure", () => {
    const tight = { fields: 2, maxLength: minted.length - 1 };

    expect(Tokens.verify(signingKey, minted, tight)).toStrictEqual(Option.none());
  });
});

describe("hashed secrets", () => {
  it.effect("issues 43 base64url characters, fresh each time", () =>
    Effect.gen(function* () {
      const first = Redacted.value(yield* Tokens.issueSecret);
      const second = Redacted.value(yield* Tokens.issueSecret);

      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second).not.toBe(first);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    "hashes a secret to its SHA-256 in hex, the same each time and different per secret",
    () =>
      Effect.gen(function* () {
        const hash = yield* Tokens.hashSecret(Redacted.make("a secret"));

        // Computed independently: `printf 'a secret' | sha256sum`.
        expect(hash).toBe("984ca5162200734c592148f1820b71057f098573d138666b48663e4e30cd8d3a");
        expect(yield* Tokens.hashSecret(Redacted.make("a secret"))).toBe(hash);
        expect(yield* Tokens.hashSecret(Redacted.make("another secret"))).not.toBe(hash);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
