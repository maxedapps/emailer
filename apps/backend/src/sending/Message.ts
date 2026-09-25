import * as Schemas from "@emailer/api/Schemas";
import { Config, Data, Duration, Effect, Encoding, Option, Schema } from "effect";

import { confirmationLifetime } from "../storage/Subscriptions.ts";

/**
 * What a message says before it is addressed to anyone: a campaign's stored draft, or a test copy
 * of one.
 */
export interface MessageContent {
  readonly subject: string;
  readonly text: string;
  readonly html?: string | undefined;
}

interface MessageHeader {
  readonly name: string;
  readonly value: string;
}

/** The message one recipient receives: the content plus its footer and unsubscribe headers. */
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

const postalAddress = Config.schema(
  Schema.Trim.check(Schema.isNonEmpty()),
  "EMAILER_POSTAL_ADDRESS",
);

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
 * The From address, its optional display name and the postal address every footer carries. A
 * sender outside the verified identity, an invalid name or an empty postal address is a deployment
 * defect rather than a per-message failure.
 */
export const senderSettings = Effect.gen(function* () {
  const raw = yield* Config.all({
    identity: Config.String("EMAILER_SENDER_IDENTITY"),
    sender: Config.schema(Schemas.EmailAddress, "EMAILER_FROM_EMAIL"),
    senderName,
    postalAddress,
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
        : `=?UTF-8?B?${Encoding.encodeBase64(name)}?= <${sender}>`,
  });

export const footerFor = (unsubscribeUrl: string, postal: string): string =>
  `\n\n---\nUnsubscribe from these emails: ${unsubscribeUrl}\n\n${postal}`;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * A block that styles itself, so it reads the same under the CLI's Markdown layout and under
 * hand-written HTML. Its background repeats the layout's page colour, which makes it continue the
 * layout's outer band instead of starting a new one.
 */
export const htmlFooterFor = (unsubscribeUrl: string, postal: string): string =>
  [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">`,
    `<tr><td align="center" style="padding:0 12px 24px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">`,
    `<tr><td align="center" style="padding:0 24px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#6b7280;">`,
    `<p style="margin:0 0 8px;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline;">Unsubscribe from these emails</a></p>`,
    `<p style="margin:0;">${escapeHtml(postal)}</p>`,
    `</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
  ].join("\n");

// Matches on the original string, so the index is an original index even when a character such
// as `İ` would change length under `toLowerCase()`.
const bodyClose = /<\/body>/gi;

const withHtmlFooter = (html: string, footer: string): string => {
  let index = -1;

  for (const match of html.matchAll(bodyClose)) {
    index = match.index;
  }

  return index === -1 ? `${html}${footer}` : `${html.slice(0, index)}${footer}${html.slice(index)}`;
};

/**
 * The one place a message gets its footer and unsubscribe headers. Sends, test sends and previews
 * all compose through here, so a preview shows exactly what a recipient receives.
 */
export const compose = (
  content: MessageContent,
  unsubscribeUrl: string,
  postal: string,
): ComposedMessage => ({
  subject: content.subject,
  text: `${content.text}${footerFor(unsubscribeUrl, postal)}`,
  html:
    content.html === undefined
      ? undefined
      : withHtmlFooter(content.html, htmlFooterFor(unsubscribeUrl, postal)),
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
    subject: `Please confirm your subscription to ${listName}`,
    text: [
      `Someone asked to subscribe this address to ${listName}. To confirm, open this link:`,
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
      `<p>Someone asked to subscribe this address to <strong>${escapeHtml(listName)}</strong>.</p>`,
      `<p><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;padding:12px 20px;background-color:#111827;color:#ffffff;text-decoration:none;border-radius:6px;">Confirm my subscription</a></p>`,
      `<p>Or open this link: <a href="${escapeHtml(confirmUrl)}">${escapeHtml(confirmUrl)}</a></p>`,
      `<p>${escapeHtml(expiry)} ${escapeHtml(ignore)}</p>`,
      `<p style="font-size:12px;color:#6b7280;">${escapeHtml(postal)}</p>`,
      `</div>`,
    ].join("\n"),
    headers: [],
  };
};
