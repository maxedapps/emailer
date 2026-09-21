# SES open and link-click tracking

Verified against AWS documentation on **2026-09-11**.

Related: [SES sending](ses.md), [SNS event processing](sns-and-feedback.md), [deliverability and unsubscribe](deliverability.md), [CloudFront](cloudfront.md).

## Built-in tracking boundaries

SES adds an image for opens and rewrites links for clicks when the send uses a configuration set with the corresponding event publishing enabled. Creating a configuration set without attaching it to the send does not enable tracking. Use a configuration set without engagement events when tracking should be disabled while retaining delivery feedback.

| Property | SES behavior |
| --- | --- |
| HTML | Supports open pixels and rewritten click links |
| Plain text | Neither built-in open nor click tracking |
| Attribution | Send to one recipient per operation for individual click attribution |
| Repeated activity | Repeated opens/clicks can each produce events |
| Collection window | 60 days after sending |
| Link limit | At most 250 tracked links per email |

`ses:no-track` excludes an HTML link. `ses:tags` adds link classification to event data. A single `{{ses:openTracker}}` placeholder controls pixel placement; avoid duplicates. Correctly URL-encode destinations. Privacy proxies, image blocking, caches and scanners distort observations. [SES metrics FAQ](https://docs.aws.amazon.com/ses/latest/dg/faqs-metrics.html)

These observations cannot establish that a human read a message, clicked deliberately or consented. Keep raw observations separate from any heuristic classification of human activity.

## Event storage and useful counts

Configuration-set events use `eventType: "Open"` or `"Click"`, plus `mail.messageId` and the event-specific object. Open and click objects carry observation timestamps, IP addresses and user agents; clicks also identify the link and can include link tags. Preserve application correlation tags separately from transport message IDs. [SES event schema](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)

Define distinct metrics explicitly:

- Total observations: deduplicated event deliveries, including genuine repeat activity.
- Unique engaged recipients: distinct recipient/message identities with qualifying observations.
- Unique clicked links: distinct recipient/message/link identities.
- Rates: those counts divided by a stated population, such as delivered recipients within a stated window.

Do not deduplicate all clicks by message ID: that discards different links and repeat activity. Conversely, a replayed SNS notification must not increase totals. Preserve the original event identity through replay, and use conditional writes or an equivalent atomic reducer when updating summaries. See [SNS deduplication](sns-and-feedback.md#ids-and-deduplication).

IP addresses, user agents and destination URLs can contain personal or sensitive information. Retain only the fields needed for a defined analysis, restrict raw-event access, and separate raw-event retention from aggregate retention. Avoid putting addresses or token-bearing URLs in metric dimensions.

## Custom HTTPS tracking domains

For SES-managed branded tracking, verify a dedicated tracking subdomain in the sending Region. Point CloudFront at that Region's SES tracking endpoint, preserve the viewer's `Host`, and configure the custom hostname, certificate and DNS alias. Use a separate subdomain per sending Region when following AWS's documented setup.

AWS's diagnostic request to `https://links.example.com/favicon.ico` returns `x-amz-ses-region` and `x-amz-ses-request-protocol`; check both. This verifies routing, not event publishing. Send a real HTML sample and inspect its rewritten links as well. [Custom tracking-domain procedure](https://docs.aws.amazon.com/ses/latest/dg/configure-custom-open-click-domains.html)

Set `TrackingOptions.CustomRedirectDomain` on the configuration set. `HttpsPolicy: "REQUIRE"` wraps both opens and clicks with HTTPS; `OPTIONAL` uses HTTP for opens and the destination's original scheme for clicks; `REQUIRE_OPEN_ONLY` changes only open tracking. The hostname and valid TLS path must exist before relying on that setting. [TrackingOptions API](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_TrackingOptions.html)

Keep tracking responses uncached when every request must reach the tracker. A cached redirect can continue to navigate correctly while undercounting clicks. Keep the domain operational for previously delivered mail; changing the next send's configuration does not rewrite old inbox content.

## Custom redirects, including plain-text links

An application-owned redirect is a separate implementation option when plaintext click measurement or custom retention is required. The following is design guidance, not an SES feature:

1. Create an opaque, unguessable link identifier mapped to a previously validated HTTP(S) destination and message context.
2. Put the HTTPS redirect URL into either the text body or HTML anchor.
3. On GET, resolve that identifier, record an observation and return a temporary redirect with caching disabled.

Do not accept an arbitrary destination query parameter: that creates an open redirect. Do not put email addresses or administrative API tokens in the link. Decide whether recording failure blocks navigation or permits navigation with lost telemetry; document that tradeoff. Detached post-response work in Lambda is not durable. [Lambda execution lifecycle](lambda-and-api.md)

Keep destination mappings usable for the intended lifetime of delivered links, even if detailed events expire sooner. Treat HEAD requests and scanner fetches separately where useful. Exclude custom redirects from SES rewriting if double wrapping is unwanted. Unsubscribe is a different capability and protocol; a click observation must never change subscription state. [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html)
