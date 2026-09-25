import { Crypto, Effect, Encoding, Option, Redacted, Schema } from "effect";
// Effect exposes no HMAC or constant-time comparison, so these are the platform primitives it would wrap.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The tokens the backend issues and later accepts back come in two kinds.
 *
 * Signed tokens — unsubscribe links and preview links — share one format:
 * `v1.<field>.….<hex HMAC-SHA256>`. The version travels inside the signed material; signing the
 * fields alone would leave the prefix free to be rewritten, which is the whole value of versioning
 * it.
 *
 * Hashed secrets — API keys and confirmation links — are random, and only their hash is stored, so
 * reading the table reveals no credential.
 */
const version = "v1";

const separator = ".";

const digestLength = 64;

const fieldPattern = /^[A-Za-z0-9_-]+$/;

const digestPattern = /^[0-9a-f]{64}$/;

const encoder = new TextEncoder();

/**
 * A constant-time comparison of two secrets, using the platform's own primitive rather than a
 * hand-written byte loop. `timingSafeEqual` throws on unequal lengths — length is not secret here,
 * only content is — so that case is answered first and never reaches it.
 */
export const tokensMatch = (expected: string, supplied: string): boolean => {
  const expectedBytes = encoder.encode(expected);
  const suppliedBytes = encoder.encode(supplied);

  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
};

/** The length of a token whose fields have these lengths: the bound a public route must carry. */
export const lengthFor = (fieldLengths: ReadonlyArray<number>): number =>
  fieldLengths.reduce((length, field) => length + separator.length + field, version.length) +
  separator.length +
  digestLength;

const digestFor = (signingKey: Redacted.Redacted<string>, signed: string): string =>
  createHmac("sha256", Redacted.value(signingKey)).update(signed).digest("hex");

/** Fields must already be in the token alphabet (base64url, digits, UUIDs). */
export const sign = (
  signingKey: Redacted.Redacted<string>,
  fields: ReadonlyArray<string>,
): string => {
  const signed = [version, ...fields].join(separator);

  return `${signed}${separator}${digestFor(signingKey, signed)}`;
};

export interface TokenFormat {
  readonly fields: number;
  readonly maxLength: number;
}

/**
 * Cheap structural checks first, then the signature. The fields come back undecoded: callers parse
 * them only after the HMAC has established that we issued them.
 */
export const verify = (
  signingKey: Redacted.Redacted<string>,
  token: string,
  format: TokenFormat,
): Option.Option<ReadonlyArray<string>> => {
  if (token.length > format.maxLength) {
    return Option.none();
  }

  const parts = token.split(separator);
  const digest = parts.at(-1) ?? "";
  const signed = parts.slice(0, -1);
  const fields = signed.slice(1);

  const wellFormed =
    signed[0] === version &&
    fields.length === format.fields &&
    fields.every((field) => fieldPattern.test(field)) &&
    digestPattern.test(digest);

  return wellFormed && tokensMatch(digestFor(signingKey, signed.join(separator)), digest)
    ? Option.some(fields)
    : Option.none();
};

const secretBytes = 32;

/** A secret `issueSecret` could have issued, as presented back. */
export const IssuedSecret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));

/** A fresh random secret: 32 bytes as unpadded base64url, 43 characters. */
export const issueSecret = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* Effect.orDie(crypto.randomBytes(secretBytes));

  return Redacted.make(Encoding.encodeBase64Url(bytes));
});

/** What is stored in a secret's place: its SHA-256, as hex. */
export const hashSecret = Effect.fn("Tokens.hashSecret")(function* (
  secret: Redacted.Redacted<string>,
) {
  const crypto = yield* Crypto.Crypto;

  const digest = yield* Effect.orDie(
    crypto.digest("SHA-256", encoder.encode(Redacted.value(secret))),
  );

  return Encoding.encodeHex(digest);
});
