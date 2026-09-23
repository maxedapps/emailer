# ADR-0017: Adopted root-domain sending identity

- Status: Accepted
- Date: 2026-09-23
- Accepted: 2026-09-23
- Authority: On 2026-09-23 the user decided the following and approved the steps below:
  - retire the `mail.example.com` identity and every earlier test resource;
  - send from the root domain `example.com`, which a prior email service provider had used through this account's SES;
  - stop using that provider;
  - use `no-reply@example.com` as the From address and `admin@example.com` as the DMARC report destination.
- Supersedes in part:
  - [ADR-0009](0009-account-level-sending-identity.md): the `mail.example.com` domain choice and "created once". The identity is adopted, not created.
  - [ADR-0002](0002-domain-sending-identity.md): the rule against adopting an existing identity.
  - [ADR-0010](0010-aligned-mail-from-spf-and-dmarc.md): the record inventory. DMARC moves to the organizational domain, and the cross-domain report authorization is gone.
- Preserves:
  - ADR-0009's one-shot identity stack, `RemovalPolicy.retain()` and cross-stage reference;
  - ADR-0010's custom MAIL FROM at `bounce.<identity>`, `USE_DEFAULT_VALUE` and `p=none` first;
  - ADR-0002's missing `Reply-To`.
- Superseded in part: [ADR-0018](0018-optional-dns-management.md) — `--adopt` on the "one-resource" identity stack: the stack now also declares DNS records, and adopting existing ones is intended.

## Context

The prior provider was connected to this account's SES ("bring your own SES"). The root domain was therefore already a verified SES domain identity:

- Easy DKIM, with keys generated 2026-05-10;
- custom MAIL FROM `e.example.com`;
- created outside Alchemy, and untagged.

SES allows one identity per domain per account and Region, so the Emailer cannot create its own. Deleting and recreating that identity is not an option either. ADR-0009 records that recreating an Easy DKIM identity never again produced a verifying key.

Alchemy beta.77 decides ownership in two different places.

- **Cold-start probe (`Plan.ts`).** It runs `read` only for a resource with no prior state:
  - an untagged identity reads as `Unowned`;
  - without adoption, planning fails with `OwnedBySomeoneElse`.
- **Replace path (`Apply.ts`).** A changed `emailIdentity` on existing state plans a replace, and this path calls `reconcile` without the probe. The provider's `reconcile` then:
  - finds the existing identity and skips create;
  - rewrites its MAIL FROM;
  - adds its own tags.

  Changing `EMAILER_SENDER_IDENTITY` on the deployed stack would therefore take over the foreign identity silently. The plan shows an ordinary replace.

The root domain's mailbox is hosted elsewhere, and its MX points there. The apex published no SPF and no DMARC record.

## Decision

The sending identity is the root domain `example.com`. `EmailerSending/shared` adopts it rather than creating it, in this order:

1. **Retire the old identity.**
   - Destroy `EmailerSending/shared`. The retained `mail.example.com` identity is then deleted by hand, together with its six records and the report authorization record.
   - Delete the state and assets buckets, including every object version, so that no history of the earlier test stages remains.
2. **Publish the new records first:** MX and SPF TXT at `bounce.example.com`, and DMARC at `_dmarc.example.com`. Check them at the authoritative nameserver.
3. **Take over the identity**, on the identity stack only:
   - confirm that `alchemy plan` fails with `OwnedBySomeoneElse`, which shows the cold-start path is in use;
   - confirm that `alchemy deploy --adopt --dry-run` shows exactly one `adopted`;
   - deploy with `--adopt`.
4. **Clean up the prior records.** After `MailFromDomainStatus=SUCCESS`, delete the prior provider's MAIL FROM records at `e.example.com`.

The other rules:

- **DKIM.** The existing Easy DKIM keys and their `CNAME`s are kept unchanged.
- **DMARC.** The record lives at the organizational domain: `"v=DMARC1; p=none; rua=mailto:admin@example.com"`.
  - The report address is on the same organizational domain, so no external authorization record is needed.
  - The policy stays at `p=none`: the apex has no SPF record and other services send as the domain. The aggregate reports decide when a stricter policy is safe.
- **From address.** `no-reply@example.com`, with no `Reply-To`. The domain has a mailbox provider, so a reply reaches it and bounces there unless a mailbox or catch-all exists.
- **The prior provider's own AWS resources** are outside this project: its IAM user, its configuration sets and the address identity it sent from. They are removed separately, after its contacts are exported.

## Alternatives considered

1. **A fresh subdomain identity such as `news.example.com`.** No adoption is needed and the DKIM keys are new. The costs are new-domain reputation and a From address off the main brand. The user chose the root domain.
2. **Changing `EMAILER_SENDER_IDENTITY` on the deployed stack.** This is one command, but it takes over the foreign identity through the replace path with no ownership check, and nothing in the plan shows it. Rejected.
3. **Keeping the prior MAIL FROM subdomain `e.example.com`.** This would reuse two existing records, but it needs a configurable MAIL FROM subdomain in the stack for a single deployment. `bounce.<identity>` stays the one convention.
4. **Deleting and recreating the identity so that Alchemy creates it.** Rejected on ADR-0009's DKIM evidence.

## Consequences

- **Alchemy owns an identity it did not create.** `RemovalPolicy.retain()` still protects it on destroy, and `alchemy unsafe nuke` must still exclude `AWS.SES.*`.
- **`--adopt` applies to every resource in a run.** It belongs only on the one-resource identity stack, never on `alchemy.run.ts`.
- **The prior provider keeps access until its IAM user is removed.** Until then it can send through the identity and change its attributes. Its mail uses the new MAIL FROM, which the new records cover.
- **Domain reputation carries over:** the domain, the DKIM keys and the account are all the same.
- **Test stages send through the root-domain identity too.** The operator mailbox and the SES mailbox simulator remain the only test recipients.

## Confirmation

On 2026-09-23:

- **The adopted identity kept its DKIM.** The tokens and `LastKeyGenerationTimestamp` were unchanged, and the three Alchemy tags were present.
- **The new MAIL FROM verified.** `MailFromDomain` was `bounce.example.com`, and `MailFromDomainStatus` reached `SUCCESS` about 60 seconds after the deploy.
- **`prod` was deployed**, with 29 resources.
- **A delivered message passed every check.** An ephemeral `test` stage delivered one campaign to the operator mailbox, and it showed:
  - `spf=pass smtp.mailfrom=…@bounce.example.com`;
  - `dkim=pass header.d=example.com`;
  - `dmarc=pass header.from=example.com policy.dmarc=none`;
  - `h=` covering `List-Unsubscribe` and `List-Unsubscribe-Post`.

  The stage was then destroyed and its state history purged.

## References

- [ADR-0002: Domain sending identity with Easy DKIM](0002-domain-sending-identity.md)
- [ADR-0009: Account-level sending identity](0009-account-level-sending-identity.md)
- [ADR-0010: Custom MAIL FROM, SPF and DMARC](0010-aligned-mail-from-spf-and-dmarc.md)
- Alchemy 2.0.0-beta.77:
  - `Plan.ts`: the cold-start adoption probe;
  - `Apply.ts`: the replace path calling `reconcile`;
  - `AWS/SES/EmailIdentity.ts`: `reconcile` skipping create for an existing identity.
- [Amazon SES: Using a custom MAIL FROM domain](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
- [Amazon SES: Complying with DMARC](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)
- [RFC 7489: DMARC](https://www.rfc-editor.org/rfc/rfc7489), §7.1 external report destinations
