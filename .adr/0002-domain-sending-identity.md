# ADR-0002: Domain sending identity with Easy DKIM

- Status: Accepted
- Date: 2026-09-11
- Superseded in part: [ADR-0009](0009-account-level-sending-identity.md) replaces the per-stage identity lifecycle, the `example.com` domain choice, and the propagation-race explanation with the `INSYNC`/`dig` obligation built on it. The body stays as the preserved rationale.
- Obligations discharged in part: [ADR-0010](0010-aligned-mail-from-spf-and-dmarc.md) — SPF, DMARC and custom MAIL FROM (Consequences).
- Superseded in part: [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md) for the allowlist guard in `Campaigns.send` and the single-recipient rule as the protections behind a domain identity.
- Superseded in part: [ADR-0017](0017-adopted-root-domain-sending-identity.md) for the rule against adopting an existing identity.
- Amended: 2026-09-23, at the user's request — an optional third key, `EMAILER_FROM_NAME`, gives the From address a display name for the whole deployment. It is read in `senderSettings` beside the address. That read runs during Alchemy's plan, so an invalid name fails the deploy before anything ships, and Alchemy binds the value into every function that sends or previews mail. SES takes the From value as 7-bit ASCII only: a printable-ASCII name goes out quoted, and any other name goes out as one base64 RFC 2047 encoded word. Encoding a name that needs no encoding is a spam-filter signal, so ASCII names are never encoded. The name is capped at 45 UTF-8 bytes so that one encoded word, at most 75 characters, always holds it. Quotes, backslashes and control characters are refused rather than escaped. A name per campaign was rejected: it would need a stored field, an API field and a CLI flag, for a need nobody has yet.
- Amendment confirmed: 2026-09-23 on the ephemeral stage `test-sender`, destroyed afterwards and checked against the AWS inventory. The name was bound into exactly the api, dispatcher and preview functions. With a non-ASCII name the full live suite passed 40/41, and the one failure was the breaker case's feedback wait, which passed on its own rerun. SES accepted test sends under both the encoded and the quoted form, and the preview showed each name readably. Changing only the name planned `3 to update` (Api, Dispatcher, Preview), and a plain deploy shipped it without `--force`. A name with a quote failed `alchemy plan` with a `SchemaError` at `EMAILER_FROM_NAME`.
- Amendment in prod: 2026-09-24. PR #2 merged as `36ad425`, and prod was deployed with `--force`. The plan without `--force` showed only Api, Dispatcher and Preview to update. After the deploy, all five functions had a new `CodeSha256`, and only api, dispatcher and preview carried `EMAILER_FROM_NAME`. Prod's name is plain ASCII. One test copy was delivered with the header `From: Name <address>`, because SES drops quotes that a one-word name does not need. DKIM, aligned to the identity, passed, and so did SPF and DMARC.
- Authority: The user chose `example.com` as the sending domain and `operator@example.com` as the test recipient, and accepted this record on 2026-09-11. The identity mechanism was proposed here rather than chosen by the user; the obligations it creates are listed under Consequences. One of them was corrected on 2026-09-11 after research contradicted it, and the rest were discharged by [ADR-0010](0010-aligned-mail-from-spf-and-dmarc.md) on 2026-09-15.

## Context

The first campaign slice plan (`work/first-campaign-slice.md`, in git history) decided that the slice's sender identity would be "a single email address equal to FROM, keeping domain/DNS automation out of this implementation". That assumed an address whose mailbox can receive the SES verification message, which is why the plan asked for "a dedicated new email alias that can receive SES's verification message".

Preflight of the target account invalidated the assumption:

- The account already runs production SES for `existing.example.net` with another SES workload on the same account. The plan forbids adopting an existing identity or touching account-global settings, so no existing identity could be used.
- The user directed sending from `example.com`. That domain is hosted in Route 53 in the same account, carries no MX, SPF or DMARC records, and **has no mailbox**. A verification message sent to any address at it cannot be received, so an email-address identity is impossible.
- The originally suggested `other.example.net` was rejected for a separate reason: its MX points at Purelymail, its SPF does not authorize SES, and its DMARC policy is `p=reject`, which would likely have bounced the test message.

## Decision

`Mailer.ts` declares the SES identity as the **domain** `example.com` with Easy DKIM, not as an email address. The From address is an arbitrary no-reply address at that domain, supplied as configuration.

Two configuration keys therefore exist where the plan implied one: `EMAILER_SENDER_IDENTITY` (the verified identity, a domain) and `EMAILER_FROM_EMAIL` (the address SES sends as). `Mailer.ts` checks at construction that the From address belongs to the identity and fails closed with `SenderNotOnIdentity` if it does not.

The three DKIM CNAME records are published **operationally**, not by the Stack. The plan excludes DNS automation from this slice and that exclusion stands.

## Alternatives considered

**An email-address identity on a domain with a mailbox** — the plan's original choice. It needs an alias that can receive mail. No such alias existed on a domain free of an existing workload, and creating one was outside what the user authorized.

**Reusing the verified `existing.example.net` identity** — rejected by the plan: adopting another workload's identity risks its production sending reputation and its configuration.

**Declaring the Route 53 records in the Stack** — cleaner long term, and the natural next step, but it widens the slice into DNS lifecycle management and would make `alchemy destroy` responsible for records that may outlive any one stage.

## Consequences

- A domain identity authorizes sending from **any** address at that domain. The blast radius is wider than an address identity's. The allowlist guard in `Campaigns.send` and the single-recipient rule remain the actual protections, and IAM scopes SES to this identity, `*@example.com` and the deployed configuration set only.
- The DKIM records are not owned by the Stack, so `alchemy destroy` does not remove them. Teardown must delete them by hand or the domain keeps a verifiable SES identity it no longer uses. This was done for the test deployment and verified by DNS lookup.
- Verification is asynchronous. A deploy does not mean the identity can send; `DkimStatus=SUCCESS` and `VerifiedForSendingStatus=true` must be observed before any send test.
- **The domain cannot receive mail, and is not meant to.** It has no MX record, which is what made an address identity impossible in the first place, and nothing here depends on receiving: nothing replies to the From address, and SES returns bounce and complaint feedback through configuration set event destinations rather than by mail to the sender. No `Reply-To` is set either. No authority requires one — Google's and Yahoo's bulk sender requirements cover authentication, From-domain alignment, one-click unsubscribe and spam rate, and neither asks a sending domain to accept mail or carry a monitored reply address; RFC 8058 requires one HTTPS URI in `List-Unsubscribe` and makes `mailto:` optional; CAN-SPAM accepts a web-based opt-out in place of a reply address. The residual cost is recipient experience, not reputation: someone who replies receives a non-delivery report from their own provider, which is not a bounce against this account. A Null MX record ([RFC 7505](https://www.rfc-editor.org/rfc/rfc7505.html)) would make those replies fail immediately rather than be retried for days, and would moot the `postmaster@`/`abuse@` convention, which applies to domains that accept mail; it is not adopted.
- **SPF and DMARC are still missing**, and both Google and Yahoo require them of bulk senders. DKIM alone carried the test message to the inbox — confirmed by placement, not merely by SES acceptance — but that is not a sending posture to keep. Aligned SPF through a custom MAIL FROM subdomain would itself require an MX record pointing at the regional SES endpoint. The clause that once closed this entry — that the DKIM alignment already in place satisfies DMARC without one — is **withdrawn**; see the next consequence.
- **DKIM alignment has been observed failing, so it cannot be assumed.** On the 2026-09-12 consent and unsubscribe (`work/consent-and-unsubscribe.md`, in git history) verification run, Google reported `dkim=fail header.i=@example.com header.s=tecne7g2yyztls4ayj3ldgiohvtgwcuo` beside `dkim=pass header.i=@amazonses.com`. With `From:` at `example.com` and SPF passing only for `smtp.mailfrom=…@amazonses.com`, **neither mechanism aligned with the From domain** and DMARC evaluation would have failed. Inbox placement had previously been read as evidence of alignment; it is not, and that reading is corrected here.

  The most probable cause is a propagation race in the verification procedure rather than a defect in the identity: the DKIM `CNAME`s were published and the first message sent under 90 seconds later, with the Route53 change still `PENDING` and never polled to `INSYNC`. Only SES's `DkimStatus=SUCCESS` was awaited, and AWS's resolvers see Route53 sooner than a receiver's need to. The evidence isolates the failure to the key lookup: `bh=` was byte-identical across both signatures and Google's ARC seal, so the body was never altered, and the amazonses.com signature over nearly the same header list verified.

  **Obligation.** Publishing the records is no longer sufficient. A run must poll the Route53 change to `INSYNC`, confirm the selector resolves from an external resolver (`dig @8.8.8.8 <selector>._domainkey.<domain> CNAME`), and then require `dkim=pass header.i=@<domain>` in the delivered message's `Authentication-Results` before the identity is treated as sending-ready. One-click unsubscribe is unaffected by this — its two headers were covered by the signature that did pass — but bulk-sender compliance is not.

## Confirmation

`Mailer.test.ts` covers the identity/From relationship (`belongsToIdentity`) including the mismatch that must fail closed. Live confirmation for the test deployment: identity `example.com` reached `DkimStatus=SUCCESS` and `VerifiedForSendingStatus=true`, one campaign was accepted with a SES `MessageId`, and after teardown the identity, the configuration set and the three CNAMEs were all gone.

## References

- [ADR-0001: Resource-owning Effect services](0001-resource-owning-effect-services.md)
- First campaign slice plan and evidence (`work/first-campaign-slice.md`, in git history)
- [SES: verifying a domain identity with Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [Google Email sender guidelines](https://support.google.com/a/answer/81126?hl=en)
- [Yahoo sender best practices](https://senders.yahooinc.com/best-practices/)
- [RFC 8058: one-click unsubscribe](https://www.rfc-editor.org/rfc/rfc8058.html)
- [FTC: CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)
