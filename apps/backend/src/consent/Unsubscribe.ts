import * as Schemas from "@emailer/api/Schemas";
import { Random } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Config, Effect, Encoding, Option, Redacted, Result, Schema } from "effect";

import * as Tokens from "../Tokens.ts";

export const unsubscribeSecret = Random("UnsubscribeSecret");

export class UnsubscribeFunction extends AWS.Lambda.Function<UnsubscribeFunction>()(
  "Unsubscribe",
) {}

export const unsubscribeSigningKey = Config.Redacted("EMAILER_UNSUBSCRIBE_SECRET");

/** Unpadded base64url expands three input bytes into four characters, rounding up. */
const encodedLength = (bytes: number): number => Math.ceil((bytes * 4) / 3);

/** A list identifier is a UUID. */
const listIdLength = 36;

/**
 * Derived rather than chosen: the payload is the longest address the shared schema admits and a
 * list identifier, so this is what the route must carry. At today's 254-byte address limit it is
 * 444 characters. Shortening it would mean shortening the signature or the address limit, not the
 * route.
 */
export const maxTokenLength = Tokens.lengthFor([
  encodedLength(Schemas.maxEmailLength),
  listIdLength,
]);

/** What a link opts out of: one mailbox's mail from one list. */
export interface UnsubscribeTarget {
  readonly mailbox: string;
  readonly listId: string;
}

const decodeMailbox = Schema.decodeUnknownOption(Schemas.NormalizedEmailAddress);

const isListId = Schema.is(Schemas.EntityId);

const encodePayload = (mailbox: string): string => Encoding.encodeBase64Url(mailbox);

/**
 * A link names the mailbox it was issued to, not the contact that happened to hold it, and the list
 * it was sent from. Contacts are editable and deletable; the opt-out is keyed by mailbox and
 * outlives both, so the token carries the same identity the opt-out does and needs no lookup to
 * resolve.
 */
export const mintToken = (
  signingKey: Redacted.Redacted<string>,
  target: UnsubscribeTarget,
): string =>
  Tokens.sign(signingKey, [encodePayload(Schemas.mailboxKey(target.mailbox)), target.listId]);

const mailboxOf = (payload: string): Option.Option<string> =>
  Result.getSuccess(Encoding.decodeBase64UrlString(payload)).pipe(
    // base64url decoding is lenient: several encodings, including ones with unused trailing bits
    // set, decode to the same bytes. Requiring the round trip means exactly one token names any
    // mailbox.
    Option.filter((mailbox) => encodePayload(mailbox) === payload),
    // A valid signature proves we issued the token, not that the key we signed still names a
    // mailbox this system accepts — the address schema may have tightened since. Canonical form is
    // required as well, so a signed mixed-case payload cannot address the lowercase opt-out.
    Option.flatMap(decodeMailbox),
    Option.filter((address) => address === Schemas.mailboxKey(address)),
  );

/** Nothing decodes an attacker-supplied payload until the signature has established that we issued it. */
export const verifyToken = (
  signingKey: Redacted.Redacted<string>,
  token: string,
): Option.Option<UnsubscribeTarget> =>
  Option.flatMap(
    Tokens.verify(signingKey, token, { fields: 2, maxLength: maxTokenLength }),
    ([payload = "", listId = ""]) =>
      isListId(listId)
        ? Option.map(mailboxOf(payload), (mailbox) => ({ mailbox, listId }))
        : Option.none(),
  );

/**
 * Read per call, not at construction: the URL and key are env pinned from the function's props,
 * which a constructor read would look for on the deploy machine at plan time. A sender mints before
 * it changes any state, so a link that cannot be minted stops it with nothing to undo.
 */
export const unsubscribeLink = Effect.fn("Unsubscribe.unsubscribeLink")(function* (
  target: UnsubscribeTarget,
) {
  const configured = yield* Config.all({
    baseUrl: Config.String("EMAILER_UNSUBSCRIBE_URL"),
    signingKey: unsubscribeSigningKey,
  });

  // AWS reports a Function URL with a trailing slash.
  const base = configured.baseUrl.replace(/\/+$/, "");

  return `${base}/unsubscribe/${mintToken(configured.signingKey, target)}`;
});
