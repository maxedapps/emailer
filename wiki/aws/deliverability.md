# Deliverability and sender reputation

[AWS](aws.md) · [Engagement tracking](ses-engagement-tracking.md) · [DNS and certificates](route53-and-acm.md) · [HTML email](../email/html-email.md)

Deliverability is a feedback-controlled operation: valid authentication, wanted content, healthy recipients and prompt suppression all matter. SES acceptance alone says nothing about inbox placement. Separate marketing traffic and reputation from unrelated transactional/user mail where practical.

## Authentication checklist

| Mechanism | What to establish |
| --- | --- |
| DKIM | Verify the sending domain; publish SES-provided records from `SigningHostedZone` (never a hardcoded zone); observe `dkim=pass` on delivered mail. Recreating an Easy DKIM identity can break signing — see [SES](ses.md) |
| SPF | Authorize the actual envelope sender; use a custom MAIL FROM domain when aligned SPF is required. SES's MAIL FROM SPF TXT is `v=spf1 include:amazonses.com ~all` |
| DMARC | Align the visible From domain with authenticated DKIM or SPF; publish a policy starting at `p=none` and review reports. A bounce subdomain needs relaxed SPF alignment (never `aspf=s`). An external `rua`/`ruf` address needs `<policy-domain>._report._dmarc.<mailto host>` TXT `v=DMARC1` at the host part of the mailto (RFC 7489 §7.1) |
| Custom MAIL FROM | MX `10 feedback-smtp.<region>.amazonses.com` and the SPF TXT above, at a subdomain of the identity used for nothing else. SES verifies the MX only; `MailFromDomainStatus` does not observe SPF. Choose failure behavior deliberately |

Default SES MAIL FROM is not your visible From domain, so SPF passing alone does not prove DMARC alignment. Easy DKIM can provide alignment; a custom MAIL FROM provides another path. Validate received headers in a real mailbox instead of treating DNS record creation as proof of success.

Publish MAIL FROM records before SES or a public resolver probes them. A resolver that answers NXDOMAIN may cache that for the zone's negative TTL — the smaller of the SOA record's own TTL and its MINIMUM field (RFC 2308), 15 minutes for Route 53's defaults and 30 for Cloudflare's. After publication, verify at the authoritative server first, then at a public resolver. [DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim.html), [Custom MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html), [DMARC](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)

A cautious rollout starts with DMARC reporting and verified alignment, then strengthens policy based on all legitimate senders for that domain. `p=none` is the required starting point. Do not overwrite existing SPF/DMARC records without inventorying those senders.

## Mailbox-provider requirements

Google's requirements for senders exceeding 5,000 daily messages to personal Gmail accounts include SPF and DKIM, DMARC, alignment, one-click unsubscribe for marketing/subscribed mail and a visible body unsubscribe link. Its documented spam-rate boundary is below 0.3%; that is a ceiling to avoid, not an operating target. [Google sender guidelines](https://support.google.com/a/answer/81126?hl=en)

Yahoo's bulk-sender guidance also requires strong authentication/alignment, easy unsubscribe and low complaint rates. It asks senders to process unsubscribes within two days. The delay between accepting an unsubscribe and enforcing it determines how long subsequent sends may still occur. Durable preference updates and prompt enforcement minimize that window; an already in-flight send cannot be recalled. [Yahoo sender practices](https://senders.yahooinc.com/best-practices/)

Neither provider asks the sending From domain to accept mail. The From domain has no MX, monitored reply address or `Reply-To` requirement in either list; RFC 8058 needs only an HTTPS URI in `List-Unsubscribe`, and CAN-SPAM accepts a web-based opt-out in place of a reply address. A custom MAIL FROM bounce subdomain carries one MX for SES feedback; the From domain still has none. A send-only domain still owes recipients a working opt-out — what it costs is that replies fail at the recipient's own server, which is their non-delivery report, not your bounce. A Null MX record ([RFC 7505](https://www.rfc-editor.org/rfc/rfc7505.html)) makes that failure immediate and explicit.

These are mailbox-provider delivery requirements, distinct from jurisdiction-specific marketing law. Applicable consent, retention and disclosure requirements depend on recipient markets and the business; record that scope before launch.

## Reputation controls

AWS advises staying below 5% bounces and 0.1% complaints; its published review/pause guidance includes review at 5% bounces or 0.1% complaints and possible sending pause at 10% or 0.5%. Treat these as documented intervention boundaries, never as acceptable operating targets. CloudWatch alarm guidance for the reputation metrics is `>= 0.05` bounce and `>= 0.001` complaint, treating missing data as `ignore`. The metrics exclude suppressed and simulator sends and move about daily. [SES reputation guidance](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html), [Creating reputation monitoring alarms](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboard-cloudwatch-alarm.html), [Enforcement FAQs](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html)

Chosen values: configuration-set alarms at 2% bounce and 0.05% complaint (earlier than review); account-level alarms at AWS's 5% and 0.1%. A per-campaign breaker at those same review ratios is the fast guard, with minimum samples of 200 accepted for bounces and 1,000 for complaints — below those minima a single event already breaches the ratio. Suppression-list echoes (a permanent bounce with subtype `OnAccountSuppressionList` or `Suppressed`, or a complaint with `complaintSubType: OnAccountSuppressionList`) do not count: nothing reached a mailbox, and SES excludes them from its own rates.

Do not compare Gmail, Yahoo and SES complaint rates as if they share identical denominators and reporting coverage. Track each source separately. Gmail sends no feedback loop to SES; its spam rate lives in Postmaster Tools. Start new domains with smaller, engaged cohorts, increase gradually and stop unhealthy imports before volume amplifies the reputation impact.

Permanent bounces and complaints require prompt policy-driven suppression. Soft bounces/delays need classification; immediate application resending can duplicate SES's own delivery attempts. Transient and undetermined bounces are a rolling window: three occurrences inside thirty days skip the address as `bouncing` without writing a suppression. Keep unsubscribe and complaint state durable across imports and restores. [SES feedback](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html), [Suppression](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)

## Engagement is noisy

Open pixels and click redirects can be fetched by privacy proxies or security scanners. Treat them as signals, not proof that a human read or consented to a message. They must never automatically resubscribe a contact. A GET request to an unsubscribe link must not trigger a one-click unsubscribe merely because a scanner fetched it; use the RFC's POST mechanism. [RFC 8058 rationale](https://www.rfc-editor.org/rfc/rfc8058.html)

Keep content relevant, frequency consistent with the subscription, branding recognizable and unsubscribe prominent. Dedicated IPs do not repair poor audience quality. Before launch, inspect delivered MIME, authentication results, both unsubscribe paths and the feedback pipeline end to end.

## Alignment follows identities, not display names

An email has several identities: the visible From header, the envelope sender used for SPF, and the signing domain in DKIM. DMARC asks whether an authenticated identity aligns with the visible From domain under the applicable alignment mode. A display name has no role in that check. A message can pass SPF for the provider's envelope domain while failing SPF alignment with the author's From domain. [DMARC with SES](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)

Inspect received Authentication-Results and DKIM headers together with DNS. Compare the actual envelope and signing domains, including any custom MAIL FROM fallback behavior. DNS publication alone does not establish that the intended signature was present on the final delivered message. Forwarding and transformations can also change authentication outcomes; evaluate the received message rather than only the original request.

## One-click unsubscribe is an HTTP protocol

RFC 8058 uses an HTTPS URI in `List-Unsubscribe` and the `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header. A receiver performs the prescribed POST when the user invokes one-click unsubscribe. The relevant headers must be covered by a valid DKIM signature. A visible body link remains a separate usability requirement for subscribed mail; it can lead to a preference page, but one-click processing must not require an interactive login flow. [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html)

Treat the unsubscribe action as idempotent. Repeated requests should leave the same preference disabled, and an old queued message should not override a newer opt-out. A GET from a scanner should not be mistaken for the RFC's explicit POST action. Where SES manages subscription headers, use its documented behavior and signing requirements rather than simultaneously implementing a conflicting header authority. [SES subscription management](https://docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html)

The one-click URI must identify the intended subscription without requiring cookies or an Authorization header. Use an opaque or hard-to-forge component and verify it. Accept the prescribed `List-Unsubscribe=One-Click` form data, including the RFC's multipart and URL-encoded forms; do not require JSON. Process the action at that HTTPS endpoint without redirecting the POST. [RFC 8058 sender and receiver requirements](https://www.rfc-editor.org/rfc/rfc8058.html)

Keep unsubscribe capabilities separate from administrative API tokens and general click-tracking identifiers. Their authority should be limited to the relevant opt-out. A repeat request should remain harmless, and a success response should follow a durable preference update. Recheck current suppression before sending queued work; cached audience membership must not override a later opt-out.

## Diagnose poor delivery by evidence category

Start with submission and event records: was the message accepted, rejected, delayed or bounced? Next check authentication and content in a received sample. Then inspect mailbox-provider reputation signals, complaint trends and recipient acquisition quality. Delivery to a recipient server is a different observation from placement in the inbox, and an open event can originate from a proxy.

Do not average unrelated providers' complaint rates without understanding their reporting populations. Low volume can make short-window percentages unstable, while large denominators can hide a localized acquisition problem. Break down by legitimate operational categories with sufficient sample size and keep addresses out of high-cardinality metric dimensions. [SES reputation guidance](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html)

These operational practices do not establish a jurisdiction's consent or retention rules. Mailbox-provider requirements, AWS service restrictions and applicable law have different authorities. The [SES `llms.txt`](https://docs.aws.amazon.com/ses/latest/dg/llms.txt) provides the service-side documentation; sender requirements should be checked directly with the mailbox provider.
