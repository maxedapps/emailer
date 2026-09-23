import * as Schemas from "@emailer/api/Schemas";
import { Random } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Config, Effect, Option, Redacted, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { Buffer } from "node:buffer";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createHmac } from "node:crypto";

import { tokensMatch } from "./Auth.ts";

const separator = ".";

const version = "v1";

const digestLength = 64;

export const unsubscribeSecret = Random("UnsubscribeSecret");

export class UnsubscribeFunction extends AWS.Lambda.Function<UnsubscribeFunction>()(
  "Unsubscribe",
) {}

export const unsubscribeSigningKey = Config.Redacted("EMAILER_UNSUBSCRIBE_SECRET");

/** Unpadded base64url expands three input bytes into four characters, rounding up. */
const encodedLength = (bytes: number): number => Math.ceil((bytes * 4) / 3);

/**
 * Derived rather than chosen: the payload is the longest address the shared schema admits, so this
 * is what the route must carry. At today's 254-byte address limit it is 407 characters. Shortening
 * it would mean shortening the signature or the address limit, not the route.
 */
export const maxTokenLength =
  version.length +
  separator.length +
  encodedLength(Schemas.maxEmailLength) +
  separator.length +
  digestLength;

const tokenPattern = /^v1\.([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/;

const decodeMailbox = Schema.decodeUnknownOption(Schemas.NormalizedEmailAddress);

const encodePayload = (mailbox: string): string =>
  Buffer.from(mailbox, "utf8").toString("base64url");

const digestFor = (signingKey: Redacted.Redacted<string>, signed: string): string =>
  createHmac("sha256", Redacted.value(signingKey)).update(signed).digest("hex");

/**
 * A link names the mailbox it was issued to, not the contact that happened to hold it. Contacts are
 * editable and deletable; the consent record is keyed by mailbox and outlives both, so the token
 * carries the same identity the consent does and needs no lookup to resolve.
 *
 * The version travels inside the signed material. Signing the payload alone would leave the prefix
 * free to be rewritten, which is the whole value of versioning it.
 */
export const mintToken = (signingKey: Redacted.Redacted<string>, email: string): string => {
  const signed = `${version}${separator}${encodePayload(Schemas.mailboxKey(email))}`;

  return `${signed}${separator}${digestFor(signingKey, signed)}`;
};

/**
 * Cheap structural checks first, then the signature, and only then the payload: nothing decodes an
 * attacker-supplied string until the HMAC has established that we issued it.
 */
export const verifyToken = (
  signingKey: Redacted.Redacted<string>,
  token: string,
): Option.Option<string> => {
  if (token.length > maxTokenLength) {
    return Option.none();
  }

  const parts = tokenPattern.exec(token);

  if (parts === null) {
    return Option.none();
  }

  const payload = parts[1] ?? "";
  const digest = parts[2] ?? "";
  const signed = `${version}${separator}${payload}`;

  if (!tokensMatch(digestFor(signingKey, signed), digest)) {
    return Option.none();
  }

  const mailbox = Buffer.from(payload, "base64url").toString("utf8");

  // base64url decoding is lenient: several encodings, including ones with unused trailing bits set,
  // decode to the same bytes. Requiring the round trip means exactly one token names any mailbox.
  if (encodePayload(mailbox) !== payload) {
    return Option.none();
  }

  // A valid signature proves we issued the token, not that the key we signed still names a mailbox
  // this system accepts — the address schema may have tightened since. Canonical form is required
  // as well, so a signed mixed-case payload cannot address the lowercase consent record.
  return Option.filter(
    decodeMailbox(mailbox),
    (address) => address === Schemas.mailboxKey(address),
  );
};

export const unsubscribeLink = Effect.fn("Unsubscribe.unsubscribeLink")(function* (email: string) {
  const configured = yield* Config.all({
    baseUrl: Config.String("EMAILER_UNSUBSCRIBE_URL"),
    signingKey: unsubscribeSigningKey,
  });

  // AWS reports a Function URL with a trailing slash.
  const base = configured.baseUrl.replace(/\/+$/, "");

  return `${base}/unsubscribe/${mintToken(configured.signingKey, email)}`;
});
