# ADR-0010: Custom MAIL FROM, SPF and DMARC for the sending domain

- Status: Accepted
- Date: 2026-09-15
- Accepted: 2026-09-15
- Authority: The user asked for SPF and DMARC on `mail.example.com` on 2026-09-15 and chose the operator mailbox `dmarc@reports.example.net` as the DMARC report destination. Accepted by the user on 2026-09-15 after independent review of [the plan](work/deliverability.md); the plan's live gate confirms the implementation.
- Discharges: the SPF, DMARC and custom MAIL FROM obligations left open by [ADR-0002](0002-domain-sending-identity.md) (Consequences) and carried forward by [ADR-0009](0009-account-level-sending-identity.md)'s Consequences.
- Superseded in part: [ADR-0017](0017-adopted-root-domain-sending-identity.md) — the record inventory: DMARC moves to the organizational domain and the cross-domain report authorization record is gone.
- Superseded in part: [ADR-0018](0018-optional-dns-management.md) — records by hand, never declared, and alternative 6: with `EMAILER_DNS` the identity stack declares them; the values are unchanged.

## Context

Mail from `mail.example.com` verifies DKIM under the retained account-level identity (ADR-0009). Nothing else is authenticated: SES sends with an `amazonses.com` envelope sender, so SPF passes only for `smtp.mailfrom=…@amazonses.com` and is not aligned with the From domain, and no DMARC record exists. Google, Yahoo and Microsoft require SPF, DKIM, a published DMARC policy and From-domain alignment of bulk senders; without them mail is throttled or rejected rather than filtered. DMARC is also what makes the domain unforgeable: without a policy, anyone can send as `@mail.example.com` and the resulting reputation damage lands on us.

Two constraints from earlier decisions hold: DNS records are published by hand, never as `AWS.Route53.Record` (ADR-0009 alternative 5), and DNS changes stay inside the one zone a task is about unless the user confirms another zone. The report destination the user chose lives in a second zone, `reports.example.net` on Cloudflare, which is why this record needs its own confirmation.

## Decision

- **Custom MAIL FROM on the retained identity.** `stacks/sending-identity.ts` declares `mailFromDomain: bounce.<identity>` and `mailFromBehaviorOnMxFailure: "USE_DEFAULT_VALUE"` explicitly. The subdomain is derived from `EMAILER_SENDER_IDENTITY`, so no new configuration key exists. Alchemy plans this as an in-place `update`: the provider replaces only when the identity name changes, and its MAIL FROM path calls `PutEmailIdentityMailFromAttributes` on the observed identity without touching DKIM.
- **Three records in `example.com`**, published once by hand: MX `bounce.mail.example.com → 10 feedback-smtp.us-east-1.amazonses.com`, TXT `bounce.mail.example.com → "v=spf1 include:amazonses.com ~all"`, TXT `_dmarc.mail.example.com → "v=DMARC1; p=none; rua=mailto:dmarc@reports.example.net"`.
- **One authorization record in the report receiver's zone**: TXT `mail.example.com._report._dmarc.reports.example.net → "v=DMARC1"`, required by RFC 7489 §7.1 because the report address is in a different organizational domain. It lives in the Cloudflare zone the mailbox project uses, which manages routing resources but no arbitrary records, so a hand-added TXT is not overwritten.
- **`p=none` first.** The policy satisfies the bulk-sender requirement and starts reporting without affecting delivery of anything else that sends as the domain. Tightening to `quarantine` and `reject` is a later, deliberate change after reports are clean.
- **`USE_DEFAULT_VALUE` on MX failure.** If the MX ever disappears, SES falls back to its own envelope domain: SPF loses alignment, but DKIM alignment still satisfies DMARC and mail keeps flowing. `REJECT_MESSAGE` would fail every send on a DNS mishap. The trade is visible: a run that shows `smtp.mailfrom=…@amazonses.com` again means the MX is broken.
- **Readiness is proven on a delivered message**, not on DNS or on SES status alone: `MailFromDomainStatus=SUCCESS`, then `spf=pass` with `smtp.mailfrom` at the bounce subdomain, `dkim=pass header.d=mail.example.com` and `dmarc=pass header.from=mail.example.com` in the delivered `Authentication-Results`.

## Alternatives considered

1. **DMARC without custom MAIL FROM.** DKIM alignment alone passes DMARC and satisfies Google's "SPF or DKIM aligned" wording. Rejected: a single authentication path is fragile, and the MAIL FROM costs one identity setting and two records.
2. **DMARC without reports.** Satisfies the requirement, but leaves no visibility into who sends as the domain, which is the reason to publish a policy at all.
3. **Reports to an address at `example.com`.** No external authorization record, but the domain has no mailbox and none is wanted.
4. **A hosted DMARC report service.** Publishes a wildcard authorization, so no second-zone record, but adds an external service for a single domain. Not needed while the operator mailbox can receive and archive the reports.
5. **`REJECT_MESSAGE` on MX failure.** Fails closed. Rejected for a marketing sender whose DMARC still passes through DKIM; see Decision.
6. **Declaring the records as `AWS.Route53.Record`.** Rejected by ADR-0009 alternative 5: the beta.77 provider adopts and overwrites existing records silently.

## Consequences

- **Identity props are no longer a single value.** ADR-0009's statement that `EMAILER_SENDER_IDENTITY` is the identity's only prop is corrected in place. Changing the identity name still plans a replacement; changing the MAIL FROM props plans an update.
- **Retained records grow from three to seven** across two zones: three DKIM `CNAME`s, the MX and SPF TXT at the bounce subdomain, the DMARC TXT, and the authorization TXT at Cloudflare. None is deleted while the identity exists.
- **SES observes only the MX.** The SPF TXT is required for SPF to pass but is not part of SES's MAIL FROM state machine, so it is verified with an external resolver, never through SES status.
- **`MailFromDomainNotVerifiedException` stays unreachable** under `USE_DEFAULT_VALUE`. The Mailer's mapping of that error to `identity-not-verified` is unchanged and remains correct if the behaviour is ever switched.
- **Alignment is relaxed by default.** `smtp.mailfrom` at `bounce.mail.example.com` aligns with From at `mail.example.com` only under relaxed SPF alignment, the default. The DMARC record must never set `aspf=s`.
- **The bounce subdomain sends nothing and receives nothing** except SES's own feedback traffic at the MX. No From address may use it.
- **Reports arrive as zipped XML attachments** at the operator mailbox, typically once per day per reporting receiver. Reading them is an operator activity outside the gate; the gate proves authentication, not report arrival.
- **A second zone is now part of the sending setup.** The Cloudflare TXT must survive any mailbox-stack redeploy; the mailbox stack declares routing resources, not records, so it does.

## Confirmation

The plan's gate deploys an ephemeral Emailer stage after `MailFromDomainStatus=SUCCESS`, sends one campaign to the operator mailbox, and reads the delivered headers: `spf=pass smtp.mailfrom=…@bounce.mail.example.com`, `dkim=pass header.d=mail.example.com`, `dmarc=pass … header.from=mail.example.com`. External `dig` against `8.8.8.8` shows the MX, both TXT records and the authorization record before the send.

The T3 live gate passed on 2026-09-15: `spf=pass` at `bounce.mail.example.com`, `dkim=pass` and `dmarc=pass` for `mail.example.com`.

## References

- [Deliverability plan](work/deliverability.md)
- [ADR-0002: Domain sending identity with Easy DKIM](0002-domain-sending-identity.md)
- [ADR-0009: Account-level sending identity](0009-account-level-sending-identity.md)
- [Amazon SES: Using a custom MAIL FROM domain](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
- [Amazon SES: MailFromAttributes](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_MailFromAttributes.html)
- [Amazon SES: Complying with DMARC](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)
- [RFC 7489: DMARC](https://www.rfc-editor.org/rfc/rfc7489), §3.1 alignment, §6.3 tags, §7.1 external report destinations
- [Google: Email sender guidelines](https://support.google.com/a/answer/81126)
