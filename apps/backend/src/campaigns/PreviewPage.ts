import { Clock, Duration, Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { reportedAndFatal } from "../Diagnostics.ts";
import { lambdaBasics } from "../Lambda.ts";
import { compose, escapeHtml, senderSettings } from "../sending/Message.ts";
import { CampaignReader, CampaignReaderLive } from "../storage/Campaigns.ts";
import {
  maxPreviewTokenLength,
  PreviewFunction,
  previewSecret,
  previewSigningKey,
  verifyPreviewToken,
} from "./Previews.ts";

const invocationTimeout = Duration.seconds(10);

const route = "/previews/:token";

/** Stands in for the per-recipient unsubscribe link, which only a real send can mint. */
export const placeholderUnsubscribeUrl =
  "https://unsubscribe.invalid/each-recipient-gets-their-own-link";

/**
 * The page may carry an operator's HTML, so it runs no script at all: the document is sandboxed
 * and loads nothing but images and inline styles. It is nobody's business how the page was
 * reached, so neither referrer nor search index nor cache keeps it.
 */
const pageHeaders = {
  "content-security-policy":
    "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-src 'self'",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
};

const respond = (status: number, body: string) =>
  HttpServerResponse.text(body, { status, contentType: "text/html", headers: pageHeaders });

const document = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#f4f4f5;color:#1f2328}
header,section{padding:16px}
header{background:#fff;border-bottom:1px solid #d0d7de}
dl{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}
dt{color:#57606a}
dd{margin:0;overflow-wrap:anywhere}
h2{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#57606a}
iframe{display:block;width:100%;height:80vh;border:1px solid #d0d7de;background:#fff}
pre{margin:0;padding:16px;white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;border:1px solid #d0d7de}
</style>
</head>
<body>
${body}
</body>
</html>
`;

const notFound = respond(
  404,
  document(
    "Preview not available",
    "<section><p>This preview link is not valid or has expired.</p></section>",
  ),
);

// Inside the sandboxed frame a link has nowhere useful to go, so every link opens a new tab.
const withLinksInNewTabs = (html: string): string => {
  const head = /<head[^>]*>/i.exec(html);

  if (head === null) {
    return `<base target="_blank">${html}`;
  }

  const end = head.index + head[0].length;

  return `${html.slice(0, end)}<base target="_blank">${html.slice(end)}`;
};

const htmlPart = (html: string | undefined) =>
  html === undefined
    ? "<p>This campaign has no HTML part; recipients see the plain text.</p>"
    : `<iframe title="HTML part" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeHtml(withLinksInNewTabs(html))}"></iframe>`;

const tokenOf = Effect.map(HttpRouter.params, (params) => params["token"] ?? "");

type PreviewSender = Effect.Success<typeof senderSettings>;

/** The From line as a mail client shows it, not in the encoded form SES is sent. */
const displayedFrom = (settings: PreviewSender): string =>
  Option.match(settings.senderName, {
    onNone: () => settings.sender,
    onSome: (name) => `${name} <${settings.sender}>`,
  });

/**
 * Verifies before it reads: a forged or expired token costs no storage read. The campaign is read
 * afresh on every request, so a link shows the draft as it is now, composed exactly as a send
 * composes it, placeholder unsubscribe link aside.
 */
const showPreview = (settings: PreviewSender) =>
  HttpRouter.add(
    "GET",
    route,
    Effect.gen(function* () {
      const signingKey = yield* previewSigningKey;
      const now = yield* Clock.currentTimeMillis;
      const campaignId = verifyPreviewToken(signingKey, yield* tokenOf, Math.floor(now / 1000));

      if (Option.isNone(campaignId)) {
        return notFound;
      }

      const reader = yield* CampaignReader;
      const campaign = yield* reader.getCampaign(campaignId.value);
      const message = compose(campaign, placeholderUnsubscribeUrl, settings.postalAddress);

      return respond(
        200,
        document(
          `Preview: ${message.subject}`,
          `<header><dl>
<dt>From</dt><dd>${escapeHtml(displayedFrom(settings))}</dd>
<dt>Subject</dt><dd>${escapeHtml(message.subject)}</dd>
</dl></header>
<section><h2>HTML</h2>${htmlPart(message.html)}</section>
<section><h2>Plain text</h2><pre>${escapeHtml(message.text)}</pre></section>`,
        ),
      );
    }).pipe(
      // A campaign deleted since the link was signed.
      Effect.catchTag("NotFound", () => Effect.succeed(notFound)),
      reportedAndFatal,
    ),
  );

// The token is longer than the router's default parameter cap of 100 characters.
const routerConfig = Layer.succeed(HttpRouter.RouterConfig)({
  maxParamLength: maxPreviewTokenLength,
});

/** Built once per instance, like the other public page. */
export const makePreviewHandler = (settings: PreviewSender) =>
  HttpRouter.toHttpEffect(showPreview(settings)).pipe(Effect.provide(routerConfig));

const previewProps = Effect.gen(function* () {
  const { logGroupName, ...basics } = yield* lambdaBasics("Preview", "preview");

  const secret = yield* previewSecret;

  return {
    ...basics,
    main: import.meta.url,
    memorySize: 256,
    timeout: invocationTimeout,
    // Public like the unsubscribe page, and for the same reason capped: the signed token is the
    // only authorization, and a flood against this page must not starve anything else.
    reservedConcurrentExecutions: 2,
    functionUrl: { authType: "NONE" },
    env: {
      EMAILER_LOG_GROUP: logGroupName,
      EMAILER_PREVIEW_SECRET: secret.text,
    },
  } as const;
});

export default PreviewFunction.make(
  previewProps,
  Effect.gen(function* () {
    const settings = yield* senderSettings;
    // GetItem on the one table, and nothing else.
    const services = yield* Layer.build(CampaignReaderLive);

    return { fetch: Effect.provideContext(yield* makePreviewHandler(settings), services) };
  }),
);
