# SES setup and sending

[AWS](aws.md)

Related: [Deliverability](deliverability.md) · [Feedback](sns-and-feedback.md) · [Open and click tracking](ses-engagement-tracking.md)

## Establish a sending Region and identity

SES identity verification, production access and quotas are scoped by AWS account/Region. Verify a domain controlled by the sender and publish its DNS authentication records. New sandbox accounts can send only to verified recipients or the mailbox simulator, with default limits of 200 recipients per 24 hours and one per second. Production-access requests describe the intended sending use and recipient acquisition, bounce and complaint handling. Approval does not provide an arbitrary throughput allowance. [Production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html)

Alchemy provides `SES.EmailIdentity`, `ConfigurationSet`, event destinations, contact/list resources, tenant resources, account settings and send bindings. Stable infrastructure configuration is suitable for IaC. Frequently changing contacts and preferences need a clearly defined owner to avoid conflicts between runtime updates and desired-state reconciliation. Do not hard-code DNS token derivation where SES returns concrete values, especially across partitions or regions. [Alchemy SES surface](https://alchemy.run/aws/email/sending/)

Easy DKIM tokens are deterministic per domain and account, but recreating the identity can still break signing: SES may publish a key under the reused selectors that no longer matches the key it signs with (research F14–F15: RSA-open of delivered signatures against the live DNS key). Create a domain identity once and retain it; do not delete it to "retry" verification. Publish CNAMEs as `<token>.<SigningHostedZone>` from `GetEmailIdentity`, never a hardcoded zone — the provider comment that names `dkim.amazonses.com` is an example, not the lookup. AWS states the zone "varies by AWS Region and can differ between identities", and its own endpoint table and API example disagree for us-west-2. Alchemy's `EmailIdentity` exposes the tokens but not the zone (beta.77–79); read both from one `GetEmailIdentity` call through `Output.mapEffect` over the identity's stable `emailIdentity` attribute, which also keeps the derived record names resolvable at plan time while the identity updates. Confirm `dkim=pass header.d=<domain>` on a delivered message rather than treating DNS publication or `DkimStatus=SUCCESS` as proof a receiver can verify. [Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html), [Managing Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy-managing.html), [EmailIdentity `dkimTokens`](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SES/EmailIdentity.ts), [SigningHostedZone varies](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy-managing.html)

## Use SES API v2

`SendEmail` accepts Simple, Raw or Template content. Simple supports normal structured messages, including attachments in current API v2; Raw is needed when controlling MIME directly. Single-recipient requests simplify independent personalization, suppression and outcome handling. Batching distinct recipients in To/CC can leak addresses and makes per-recipient failure semantics harder. [SendEmail API](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html), [AWS sending guidance](https://docs.aws.amazon.com/ses/latest/dg/send-email.html)

A display name goes into the From value itself: `"Name" <address>`. SES accepts that value only as 7-bit ASCII, because it does not support SMTPUTF8. A name with any other character must be sent as a MIME encoded word (RFC 2047), such as `=?UTF-8?B?<base64>?= <address>`, and SES will not encode it for you. One encoded word is at most 75 characters. Encode only names that need it: a base64 encoded name that is plain ASCII is a known spam-filter signal (SpamAssassin `FROM_EXCESS_BASE64`). Both forms were accepted live on 2026-09-23. [Source parameter (API v1)](https://docs.aws.amazon.com/ses/latest/APIReference/API_SendEmail.html), [Email format](https://docs.aws.amazon.com/ses/latest/dg/send-email-formatted.html), [RFC 2047](https://www.rfc-editor.org/rfc/rfc2047)

Use a verified sending identity. Attach the intended configuration set when event publishing is required, and choose correlation tags and subscription-management behavior for the message type. For Alchemy's scoped binding, bind the configuration set as the second argument; the callable omits `ConfigurationSetName` because it is injected. Domain identities require an explicit full From address. Review actual generated permissions: beta.79 grants multiple send operations and template/configuration-set scopes, not merely one identity action. [SendEmail contract](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SES/SendEmail.ts), [Binding implementation](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SES/BindingHttp.ts)

## Acceptance is not delivery

A successful response returns `MessageId` when SES accepts the message. It may still reject content or fail template rendering later. Persist acceptance separately from delivery and process feedback. `SendEmail` exposes no client idempotency token; a transport timeout cannot tell you whether SES accepted the request. [SendEmail response and request fields](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)

`SendBulkEmail` returns per-entry results; HTTP success does not mean all destinations succeeded. Retry only failed entries whose outcome is sufficiently known, preserving each logical send ID and rate accounting. Bulk processing requires per-entry outcome tracking and recipient-based quota accounting. [SendBulkEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendBulkEmail.html)

## Quotas and admission

SES counts recipients, not just API calls. API v2/SMTP support messages up to 40 MB after encoding, compared with the 10 MB v1 limit; maximum recipients per message is 50. Large payloads can encounter bandwidth throttling. Keep marketing messages much smaller for practical rendering and deliverability. [Service quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html)

Read current account sending limits and status operationally. Alchemy's `SES.GetAccount()` binding grants `ses:GetAccount` on `*`. The response's `SendQuota` is `{ Max24HourSend?, MaxSendRate?, SentLast24Hours? }`, **all optional**. `MaxSendRate` is per second; `SentLast24Hours` includes every sender on the account. Undefined `MaxSendRate` is treated as limit 1; undefined `Max24HourSend` means no daily pause. Simulator sends are rate-limited against `MaxSendRate` but do not count toward the daily quota. Enforce both rolling 24-hour recipient volume and per-second admission across every sender sharing the account/Region. Preserve headroom for other traffic, retries and operational tests. Lambda concurrency is only an indirect bound; a distributed limiter or controlled dispatcher must enforce the actual rate. [GetAccount](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html), [Alchemy GetAccount](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SES/GetAccount.ts)

## Templates and content

When retries must reproduce the same message, retain the template/content revision, personalization data and destination associated with that logical operation. Validate required variables before dispatch, escape untrusted HTML fields, reject CR/LF in header inputs, and include both text and HTML where appropriate. Immutable rendered content or versioned template inputs make retries reproducible. Referring only to a mutable template name can change the content between attempts.

`Content.Simple.Body` exposes `Html` and `Text` as independent optionals. The client chooses an HTML version, a text-only version, or both; SES constructs the RFC 5322 message and, when both parts are present, the multipart MIME. AWS recommends sending both to a large audience so HTML-capable clients can follow hyperlinks while text-only clients still have a usable body. Neither Gmail nor Yahoo bulk-sender guidelines require a plain-text part; they do require one-click unsubscribe headers **and** a clearly visible unsubscribe link in the body. Both `Body.Html` and `Body.Text` typecheck as independent optionals on Alchemy's `AWS.SES.SendEmailRequest` (Distilled's `sesv2.SendEmailRequest` with `ConfigurationSetName` omitted). [Body](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Body.html), [Message](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Message.html), [Email format](https://docs.aws.amazon.com/ses/latest/dg/send-email-concepts-email-format.html), [Formatted email](https://docs.aws.amazon.com/ses/latest/dg/send-email-formatted.html), [Alchemy SendEmail](https://unpkg.com/alchemy@2.0.0-beta.79/src/AWS/SES/SendEmail.ts), [Distilled SES v2 Body](https://unpkg.com/@distilled.cloud/aws@1.0.0-rc.12/lib/services/sesv2.d.ts), [Gmail sender guidelines](https://support.google.com/a/answer/81126), [Yahoo sender practices](https://senders.yahooinc.com/best-practices/)

Avoid placing bodies or arbitrary recipient data in SES tags, queue messages or logs. Tags should correlate internal IDs, not become an alternate PII database. Validate header and body behavior using received MIME as well as API responses.

## Unsubscribe headers and suppression

Two paths produce `List-Unsubscribe`, and only one of them may own the headers. SES subscription management works through `ListManagementOptions`, Easy DKIM and the `{{amazonSESUnsubscribeUrl}}` placeholder: SES keeps the contact list, adds the headers and footer link for single-recipient messages only, and **overrides supplied unsubscribe headers when enabled**. Choose it when SES should own subscription state, and integrate its events back into application preferences.

The other path is to set the headers yourself. Since March 2024, `SendEmail` with `Simple` or `Templated` content accepts a `Headers` list, so one-click unsubscribe needs no raw MIME; AWS documents this as the way to implement it. `List-Unsubscribe` and `List-Unsubscribe-Post` are supported header names and are explicitly independent of `ListManagementOptions`. The headers SES sets itself cannot be supplied as custom headers: `BCC`, `CC`, `Content-Disposition`, `Content-Type`, `Date`, `From`, `Message-ID`, `MIME-Version`, `Reply-To`, `Return-Path`, `Subject`, `To`. `Reply-To` has a request field of its own (`ReplyToAddresses`); the rest belong to SES. Custom `Headers` are at most 15 entries. Each `MessageHeader` name is 1–126 characters of printable ASCII except colon; the value is 1–995 printable ASCII characters; name and value together must not exceed 996. [Header fields](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/header-fields.html), [MessageHeader](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_MessageHeader.html), [Message](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Message.html), [One-click unsubscribe with SES](https://aws.amazon.com/blogs/messaging-and-targeting/using-one-click-unsubscribe-with-amazon-ses/)

RFC 8058 requires both header fields to appear in the `h=` tag of a valid DKIM signature, and AWS does not document which headers SES puts there. Captured SES mail shows the signer enumerating the headers actually present rather than a fixed list — including both unsubscribe fields, under a sender's own Easy DKIM `d=` as well as the `d=amazonses.com` signature. Coverage of the Simple + `Headers` path is proven: a delivered message on 2026-09-14 carried `h=From:To:Subject:MIME-Version:Content-Type:Content-Transfer-Encoding:List-Unsubscribe:List-Unsubscribe-Post:Message-ID:Date` with `dkim=pass header.d=` of the sending domain. AWS still does not publish the signed-header set, so treat that as a SES Simple+Headers observation rather than an API contract. Do **not** confirm coverage by whether Gmail renders its unsubscribe control — that affordance is reputation-dependent, so its absence proves nothing about the signature.

Account suppression protects reputation; it is not an application consent ledger. [Subscription management](https://docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html), [Account suppression](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)

The account suppression list is case-sensitive for management calls. SES stores an address exactly as it received it, and `GetSuppressedDestination`, `PutSuppressedDestination` and `DeleteSuppressedDestination` require an exact case match, although the sending path treats `User@Example.com` and `user@example.com` as the same mailbox. An operator tool that looks an address up or removes it must therefore pass the string the listing returns, unchanged. `PutSuppressedDestination` also rejects mailbox-simulator addresses, so a seeded entry for a test needs a reserved domain such as `example.com`. [Account-level suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)

## Optional capabilities

SES tenants can group identities, configuration sets and templates, but application tenant authorization and shared account limits still need explicit design. Dedicated IP pools and Virtual Deliverability Manager add capabilities and costs; adopt them when measured volume/reputation needs justify them. Multi-Region endpoints require verified regional configuration and readiness checks; they do not make regional quotas or suppression magically global. [Alchemy SES capabilities](https://alchemy.run/aws/email/sending/)

Use the SES mailbox simulator to verify success, bounce and complaint handling without damaging reputation metrics. Simulator traffic does not count toward daily sending quota or bounce/complaint reputation; it does not establish inbox placement. It **is still rate limited** against the per-second send rate, and it **is billed normally** — the exemptions cover reputation and quota, not cost. [Mailbox simulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-simulator.html)

The simulator addresses are all at `simulator.amazonses.com`. Every kind accepts a `+label` local-part variant, which is how a run isolates its own recipients:

| Address            | Labelled form          | Behavior                                                                 |
| ------------------ | ---------------------- | ------------------------------------------------------------------------ |
| `success@`         | `success+<runId>-<n>@` | Delivered; produces a `Delivery` event                                   |
| `bounce@`          | `bounce+<runId>@`      | Hard bounce; documented as **not** added to the account suppression list |
| `ooto@`            | —                      | Out-of-office auto-response                                              |
| `complaint@`       | `complaint+<runId>@`   | Complaint; **nothing documents a suppression-list exemption for it**     |
| `suppressionlist@` | —                      | Rejected as if the address were on the account suppression list          |

Observed on 2026-09-11 in `us-east-1`, with `SuppressedReasons: [BOUNCE, COMPLAINT]` set on the sending configuration set: neither `bounce@simulator.amazonses.com` nor a labelled `complaint+<runId>@simulator.amazonses.com` was added to the account suppression list after driving both paths. Treat that as an observation, not a guarantee — AWS documents the exemption for `bounce@` only, so the precautions below still cost little and remain worthwhile.

The documented `bounce@` exemption does not establish what every complaint simulation will do. Treat a complaint test as potentially adding an account suppression entry when `COMPLAINT` suppression is enabled; neither guaranteed inclusion nor a guaranteed exemption follows from the observation above. The list is shared by workloads in the same account and Region. Use label addressing (`complaint+<runId>@simulator.amazonses.com`) and inspect the test address at teardown, removing any entry the run created. Delete using the exact `EmailAddress` returned by SES: its suppression-list management is case-sensitive. [Mailbox simulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-simulator.html), [suppression-list management](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html).

AWS does not document which `bounceType`/`bounceSubType` the simulator produces, so a classification rule that depends on a specific subtype cannot be verified against the simulator alone. Prefer a rule keyed on `bounceType`.

**Event publishing vocabulary.** Three spellings name the same events and must not be confused: the configuration-set API's `MatchingEventTypes` (`SEND`, `DELIVERY`, `BOUNCE`, `COMPLAINT`, `REJECT`, `RENDERING_FAILURE`, `DELIVERY_DELAY`, `SUBSCRIPTION`, `OPEN`, `CLICK`), EventBridge's `detail-type` (`Email Bounced`, `Email Complaint Received`, …) and the payload's own `detail.eventType` (`Bounce`, `Complaint`, …). An event destination publishing to EventBridge supports **the account's default event bus only**; a custom bus is not a valid destination.

**`EmailTags` character constraints.** Tag names and values may contain only ASCII letters, digits, underscores and hyphens, at most 256 characters each. UUIDs and other hyphenated identifiers are fine; anything containing `@`, `.`, `:` or spaces is not, which rules out putting an email address in a tag. Tag values arrive in event payloads as **arrays** (`detail.mail.tags.<name>[0]`), and SES adds its own `ses:configuration-set` tag alongside yours.

## A minimal API v2 request

The following low-level `SendEmail` request illustrates a Simple message and configuration-set selection. The domain, recipient and configuration-set name are placeholders; it assumes the sending identity and destination policy permit the request:

```json
{
  "FromEmailAddress": "hello@mail.example.com",
  "Destination": { "ToAddresses": ["person@example.com"] },
  "ConfigurationSetName": "ExampleEvents",
  "EmailTags": [{ "Name": "operationId", "Value": "operation-42" }],
  "Content": {
    "Simple": {
      "Subject": { "Data": "Example message", "Charset": "UTF-8" },
      "Body": {
        "Text": { "Data": "Example text content.", "Charset": "UTF-8" },
        "Html": { "Data": "<p>Example HTML content.</p>", "Charset": "UTF-8" }
      }
    }
  }
}
```

`Body.Html` and `Body.Text` are independent optionals; a request may carry either or both. When both are present, SES builds the multipart message — the example is not a raw MIME payload.

This is an AWS API request, not the Alchemy scoped binding's input: the latter injects its bound configuration set. The example is also not a complete subscription-mail template. Subscription management, required unsubscribe presentation and recipient permission depend on the sending use. Do not use HTML escaping as a substitute for header validation or MIME encoding. [SendEmail request](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html), [Body](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Body.html)

## Classify failures before another attempt

| Result | Interpretation | Appropriate next decision |
| --- | --- | --- |
| `MessageId` returned | SES accepted submission | Persist acceptance and await feedback |
| `BadRequestException` / `MessageRejected` | Invalid request or content | Correct or quarantine the input |
| `MailFromDomainNotVerifiedException` / `NotFoundException` | Identity or referenced resource problem; `MailFromDomainNotVerifiedException` is reachable only under `REJECT_MESSAGE` | Repair configuration before replay |
| `SendingPausedException` / `AccountSuspendedException` | Sending is restricted | Stop treating it as routine transport retry |
| `TooManyRequestsException` / `ThrottlingException` / `LimitExceededException` | Request rate is too high | Re-admit under a bounded rate/retry policy |
| Transport timeout or lost response | Acceptance may be unknown | Preserve uncertainty and apply an explicit duplicate-risk policy |

HTTP status alone is insufficient: several materially different SES errors use 400. SDK defaults may retry before the application sees an error, so count actual attempts when designing durable attempt records. A correlation tag helps match later feedback but is not an SES idempotency token. [SendEmail errors](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html), [Distilled retry behavior](../effect/retries-and-concurrency.md#distilleds-automatic-retries-are-real)

The mailer maps `TooManyRequestsException`, `ThrottlingException` and `LimitExceededException` to `rate-limited`. The 2026-09-15 live gate on stage `test-b` (`MaxSendRate=26`, paced limit 20) did **not** observe a per-second SES throttle; the sequential dispatcher at that quota never approached the ceiling, so those names remain a mapping, not a live observation.

## Verify the full sending path

Check account/Region production status, identity verification and DKIM, From address, configuration set and event destination permissions. Use the mailbox simulator for controlled success/bounce/complaint scenarios, then inspect delivered MIME and authentication in real test mailboxes when checking rendering and alignment. A successful request proves neither event routing nor unsubscribe behavior.

Use the [SES developer-guide index](https://docs.aws.amazon.com/ses/latest/dg/llms.txt) for setup and behavior and the [API v2 index](https://docs.aws.amazon.com/ses/latest/APIReference-V2/llms.txt) for exact payloads. API v1, API v2 and SMTP examples are not interchangeable in every limit or content capability.
