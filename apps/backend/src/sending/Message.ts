import * as Schemas from "@emailer/api/Schemas";
import { Config, Data, Duration, Effect, Option, Schema } from "effect";
import { Base64 } from "effect/encoding";

import { confirmationLifetime } from "../storage/Subscriptions.ts";

/** What a message says: a campaign's copy rendered for one recipient, or a test copy of one. */
export interface MessageContent {
  readonly subject: string;
  readonly text: string;
  readonly html?: string | undefined;
}

interface MessageHeader {
  readonly name: string;
  readonly value: string;
}

/** The message one recipient receives: the content plus its headers. */
export interface ComposedMessage extends MessageContent {
  readonly headers: ReadonlyArray<MessageHeader>;
}

export class SenderNotOnIdentity extends Data.TaggedError("SenderNotOnIdentity")<{
  readonly identity: string;
}> {}

export const belongsToIdentity = (sender: string, identity: string): boolean => {
  const domain = sender.slice(sender.lastIndexOf("@") + 1);

  return domain === identity || domain.endsWith(`.${identity}`);
};

const postalAddressConfig = Config.schema(
  Schema.Trim.check(Schema.isNonEmpty()),
  "EMAILER_POSTAL_ADDRESS",
);

/**
 * The postal address every campaign and test message carries through its templates. A missing one
 * is a deployment defect rather than a per-message failure.
 */
export const postalAddress = Effect.orDie(postalAddressConfig);

/**
 * The name recipients see beside the From address. Quotes, backslashes and control characters are
 * refused, so a plain name needs no escaping inside its quotes. A name beyond printable ASCII is
 * sent as one RFC 2047 encoded word, which may be at most 75 characters, and 45 UTF-8 bytes always
 * fit in one.
 */
const senderName = Config.option(
  Config.schema(
    Schema.Trim.check(
      Schema.isNonEmpty(),
      Schema.isPattern(/^[^"\\\p{Cc}]*$/u),
      Schemas.utf8ByteCeiling(45),
    ),
    "EMAILER_FROM_NAME",
  ),
);

/**
 * The From address, its optional display name and the postal address every message carries. A
 * sender outside the verified identity, an invalid name or an empty postal address is a deployment
 * defect rather than a per-message failure.
 */
export const senderSettings = Effect.gen(function* () {
  const raw = yield* Config.all({
    identity: Config.String("EMAILER_SENDER_IDENTITY"),
    sender: Config.schema(Schemas.EmailAddress, "EMAILER_FROM_EMAIL"),
    senderName,
    postalAddress: postalAddressConfig,
  });

  const identity = raw.identity.trim().toLowerCase();

  if (!belongsToIdentity(raw.sender, identity)) {
    return yield* Effect.die(new SenderNotOnIdentity({ identity }));
  }

  return { sender: raw.sender, senderName: raw.senderName, postalAddress: raw.postalAddress };
});

const printableAscii = /^[\x20-\x7E]*$/;

/**
 * The From value SES sends, which must be 7-bit ASCII. A plain name goes out quoted; any other is
 * base64 in an RFC 2047 encoded word, because encoding a name that needs none is a spam signal.
 */
export const fromHeader = (sender: string, name: Option.Option<string>): string =>
  Option.match(name, {
    onNone: () => sender,
    onSome: (name) =>
      printableAscii.test(name)
        ? `"${name}" <${sender}>`
        : `=?UTF-8?B?${Base64.encode(name)}?= <${sender}>`,
  });

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * Adds the unsubscribe headers to a rendered message. Its templates already placed the link and the
 * postal address (ADR-0041), so the content goes out as rendered.
 */
export const compose = (content: MessageContent, unsubscribeUrl: string): ComposedMessage => ({
  ...content,
  headers: [
    { name: "List-Unsubscribe", value: `<${unsubscribeUrl}>` },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
  ],
});

const confirmationFont = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The double opt-in mail: neutral, in English, text and HTML. It carries no unsubscribe headers,
 * since it subscribes no one until its link is used.
 */
export const composeConfirmation = (
  listName: string,
  confirmUrl: string,
  postal: string,
): ComposedMessage => {
  const days = Duration.toDays(confirmationLifetime);
  const expiry = `The link works for ${days} days.`;
  const ignore = "If you didn't ask for this, ignore this email and you won't be added.";

  return {
    subject: `Please confirm your email address for ${listName}`,
    text: [
      `Someone asked to add this address to ${listName}. To confirm, open this link:`,
      "",
      confirmUrl,
      "",
      `${expiry} ${ignore}`,
      "",
      "---",
      postal,
    ].join("\n"),
    html: [
      `<div style="max-width:600px;margin:0 auto;padding:24px;font-family:${confirmationFont};font-size:16px;line-height:1.5;color:#111827;">`,
      `<p>Someone asked to add this address to <strong>${escapeHtml(listName)}</strong>.</p>`,
      `<p><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;padding:12px 20px;background-color:#111827;color:#ffffff;text-decoration:none;border-radius:6px;">Confirm my email address</a></p>`,
      `<p>Or open this link: <a href="${escapeHtml(confirmUrl)}">${escapeHtml(confirmUrl)}</a></p>`,
      `<p>${escapeHtml(expiry)} ${escapeHtml(ignore)}</p>`,
      `<p style="font-size:12px;color:#6b7280;">${escapeHtml(postal)}</p>`,
      `</div>`,
    ].join("\n"),
    headers: [],
  };
};
