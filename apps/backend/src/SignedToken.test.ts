import { describe, expect, it } from "@effect/vitest";
import { Option, Redacted } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createHmac } from "node:crypto";

import * as SignedToken from "./SignedToken.ts";

const validToken = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

const secret = "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718293a4b5c6d7e8f90";

const signingKey = Redacted.make(secret);

const fields = ["cmVjaXBpZW50", "1790000000"];

const format = { fields: 2, maxLength: SignedToken.lengthFor([12, 10]) };

/** A token signed the way the implementation should sign, built without calling it. */
const signIndependently = (key: string, signed: string): string =>
  `${signed}.${createHmac("sha256", key).update(signed).digest("hex")}`;

describe("tokensMatch", () => {
  it("accepts the exact token", () => {
    expect(SignedToken.tokensMatch(validToken, validToken)).toBe(true);
  });

  it("is case sensitive", () => {
    expect(SignedToken.tokensMatch(validToken, validToken.toLowerCase())).toBe(false);
  });

  it("rejects a token that differs only in its last byte", () => {
    const almost = `${validToken.slice(0, -1)}Z`;

    expect(almost).toHaveLength(validToken.length);
    expect(SignedToken.tokensMatch(validToken, almost)).toBe(false);
  });

  it("rejects a prefix of the token", () => {
    expect(SignedToken.tokensMatch(validToken, validToken.slice(0, 20))).toBe(false);
  });

  it("rejects the token with anything appended", () => {
    expect(SignedToken.tokensMatch(validToken, `${validToken}x`)).toBe(false);
  });

  it("rejects an empty credential", () => {
    expect(SignedToken.tokensMatch(validToken, "")).toBe(false);
  });

  it("rejects a comma-joined pair of duplicate credentials", () => {
    expect(SignedToken.tokensMatch(validToken, `${validToken}, ${validToken}`)).toBe(false);
  });

  // The platform primitive throws on unequal lengths rather than answering false, so the guard
  // in front of it is load-bearing: without it every short credential would be a 500.
  it.each([
    ["", "empty"],
    ["a", "one byte"],
    [`${validToken}xx`, "longer"],
  ])("answers false rather than throwing for a %s credential", (supplied) => {
    expect(SignedToken.tokensMatch(validToken, supplied)).toBe(false);
  });
});

describe("signed tokens", () => {
  it("signs the versioned fields with HMAC-SHA256 in lowercase hex", () => {
    expect(SignedToken.sign(signingKey, fields)).toBe(
      signIndependently(secret, "v1.cmVjaXBpZW50.1790000000"),
    );
  });

  it("derives the length of a token from its field lengths", () => {
    expect(SignedToken.sign(signingKey, fields)).toHaveLength(format.maxLength);
  });

  it("verifies a token it signed and yields the fields back", () => {
    expect(
      SignedToken.verify(signingKey, SignedToken.sign(signingKey, fields), format),
    ).toStrictEqual(Option.some(fields));
  });

  const minted = SignedToken.sign(signingKey, fields);

  it.each([
    ["a tampered field", minted.replace("1790000000", "1790000001")],
    ["a tampered digest", `${minted.slice(0, -1)}${minted.endsWith("a") ? "b" : "a"}`],
    ["an uppercase digest", minted.toUpperCase()],
    ["a truncated digest", minted.slice(0, -4)],
    ["a missing separator", minted.replace(".", "")],
    ["an unknown version", `v2${minted.slice(2)}`],
    ["a token signed under another key", SignedToken.sign(Redacted.make("another key"), fields)],
    ["too few fields", SignedToken.sign(signingKey, fields.slice(0, 1))],
    ["too many fields", SignedToken.sign(signingKey, [...fields, "x"])],
    ["an empty field", SignedToken.sign(signingKey, ["", "1790000000"])],
    ["a field outside the alphabet", signIndependently(secret, "v1.cmVja+BpZW50.1790000000")],
    ["an over-long token", `${minted}${"0".repeat(4)}`],
  ])("rejects %s", (_description, presented) => {
    expect(SignedToken.verify(signingKey, presented, format)).toStrictEqual(Option.none());
  });

  it("refuses an over-long token before looking at its structure", () => {
    const tight = { fields: 2, maxLength: minted.length - 1 };

    expect(SignedToken.verify(signingKey, minted, tight)).toStrictEqual(Option.none());
  });
});
