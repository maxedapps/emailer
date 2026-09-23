import * as Schemas from "@emailer/api/Schemas";
import { Random } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Config, Effect, Option, Redacted, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { Buffer } from "node:buffer";

import * as SignedToken from "../SignedToken.ts";

export const unsubscribeSecret = Random("UnsubscribeSecret");

export class UnsubscribeFunction extends AWS.Lambda.Function<UnsubscribeFunction>()(
  "Unsubscribe",
) {}

export const unsubscribeSigningKey = Config.redacted("EMAILER_UNSUBSCRIBE_SECRET");

/** Unpadded base64url expands three input bytes into four characters, rounding up. */
const encodedLength = (bytes: number): number => Math.ceil((bytes * 4) / 3);

/**
 * Derived rather than chosen: the payload is the longest address the shared schema admits, so this
 * is what the route must carry. At today's 254-byte address limit it is 407 characters. Shortening
 * it would mean shortening the signature or the address limit, not the route.
 */
export const maxTokenLength = SignedToken.lengthFor([encodedLength(Schemas.maxEmailLength)]);

const decodeMailbox = Schema.decodeUnknownOption(Schemas.NormalizedEmailAddress);

const encodePayload = (mailbox: string): string =>
  Buffer.from(mailbox, "utf8").toString("base64url");

/**
 * A link names the mailbox it was issued to, not the contact that happened to hold it. Contacts are
 * editable and deletable; the consent record is keyed by mailbox and outlives both, so the token
 * carries the same identity the consent does and needs no lookup to resolve.
 */
export const mintToken = (signingKey: Redacted.Redacted<string>, email: string): string =>
  SignedToken.sign(signingKey, [encodePayload(Schemas.mailboxKey(email))]);

const mailboxOf = (payload: string): Option.Option<string> => {
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

/** Nothing decodes an attacker-supplied payload until the signature has established that we issued it. */
export const verifyToken = (
  signingKey: Redacted.Redacted<string>,
  token: string,
): Option.Option<string> =>
  Option.flatMap(
    SignedToken.verify(signingKey, token, { fields: 1, maxLength: maxTokenLength }),
    ([payload = ""]) => mailboxOf(payload),
  );

export const unsubscribeLink = Effect.fn("Unsubscribe.unsubscribeLink")(function* (email: string) {
  const configured = yield* Config.all({
    baseUrl: Config.string("EMAILER_UNSUBSCRIBE_URL"),
    signingKey: unsubscribeSigningKey,
  });

  // AWS reports a Function URL with a trailing slash.
  const base = configured.baseUrl.replace(/\/+$/, "");

  return `${base}/unsubscribe/${mintToken(configured.signingKey, email)}`;
});
