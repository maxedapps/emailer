# ADR-0018: Optional DNS management for the sending identity

- Status: Accepted
- Date: 2026-09-23
- Accepted: 2026-09-23
- Authority: On 2026-09-23 the user asked for the sending identity's DNS records to be managed as infrastructure. They chose:
  - Route 53 and Cloudflare, selected by one environment variable, with manual publication remaining the default;
  - DMARC managed only on opt-in.
  - They welcomed a rewrite, on the condition that the running production deployment is migrated in place.

  See [the plan](work/sending-dns.md).
- Supersedes in part:
  - [ADR-0009](0009-account-level-sending-identity.md): "The three DKIM `CNAME` records are published **once**, operationally", and alternative 5.
  - [ADR-0010](0010-aligned-mail-from-spf-and-dmarc.md): the rule that the records are published by hand and never declared, and alternative 6.
  - [ADR-0017](0017-adopted-root-domain-sending-identity.md): "`--adopt` belongs only on the one-resource identity stack". With DNS management, the stack also holds the records, and adopting them is intended.
- Preserves:
  - ADR-0009's one-shot, retained identity stack, and the cross-stage reference to it;
  - ADR-0010's record values: `bounce.<identity>` MX and SPF, `p=none` DMARC and `USE_DEFAULT_VALUE`;
  - ADR-0017's adopted identity.

## Context

Every deployer publishes six records by hand: three DKIM `CNAME`s, the MAIL FROM MX and SPF, and DMARC.

ADR-0009 and ADR-0010 kept DNS out of the stacks for three reasons:
- the first slice deferred it;
- Alchemy's Route 53 record silently adopts and overwrites existing records;
- records published once did not seem worth that exposure.

The project is now public. A deployer whose domain lives in the same AWS account should not need manual steps, and the maintainer's own domain is on Cloudflare.

Three facts from Alchemy 2.0.0-beta.77 and AWS shape the design:

- **Record ownership differs by provider.**
  - Route 53 records never report an existing record as foreign, so an existing record is overwritten.
  - Cloudflare records refuse to take over an existing record unless adoption is explicit.
- **Cloudflare credentials are needed as soon as its provider is loaded.** `Cloudflare.providers()` resolves its configuration when the provider layer is built, so a stack that merely includes it fails without Cloudflare credentials.
- **The DKIM target cannot be hardcoded.** SES documents that the `CNAME` target zone (`SigningHostedZone`) "varies by AWS Region and can differ between identities". Alchemy's `EmailIdentity` exposes the tokens but not the zone.

## Decision

- **`EMAILER_DNS`** selects `route53` or `cloudflare`. If it is unset, nothing changes and the operator publishes the records.
  - In a DNS mode, the identity stack declares the MAIL FROM MX and SPF records and the three DKIM `CNAME`s, all with `RemovalPolicy.retain()` like the identity.
  - It declares the DMARC record only when `EMAILER_DMARC_REPORT_EMAIL` is set. The record is `p=none` and reports to that address.
- **The zone is found automatically.** Route 53 infers the public hosted zone in the same account. Cloudflare resolves the zone that encloses the identity's domain. No zone setting is needed.
- **The MAIL FROM records exist before SES is told about them.** The identity's `mailFromDomain` is derived from the MX and SPF records' outputs, so on a fresh deploy the identity sets MAIL FROM only after those writes finish.
  - Route 53 finishes at `INSYNC`, so the name servers already serve the MX.
  - Cloudflare finishes when its API accepts the record, so SES may briefly miss it. Until the zone's negative TTL passes, mail uses SES's own MAIL FROM (`USE_DEFAULT_VALUE`).
- **DKIM comes from SES.** One `GetEmailIdentity` lookup provides both the tokens and the identity's own `SigningHostedZone`, run through `Output.mapEffect` over the identity's stable `emailIdentity` attribute. The records therefore resolve at plan time on every redeploy, and on the adoption run.
- **The DKIM records are also a stack output.** The stack exposes them as `dkimRecords` in every mode, replacing `dkimTokens`, so manual deployers get the exact values to publish.
- **The Cloudflare provider is loaded only in `cloudflare` mode.** AWS-only deployers never need Cloudflare credentials.
- **An existing deployment moves once, with `--adopt`.** The first DNS-mode deploy adopts its existing records. That flag is still never passed to `alchemy.run.ts`.

## Alternatives considered

1. **Route 53 only.** No second provider and no conditional provider layer, but the maintainer's own Cloudflare zone would stay manual. The user chose both.
2. **A separate DNS stack.** Its own providers would avoid the conditional layer. But the MAIL FROM records must exist before the identity sets MAIL FROM, and the DKIM records need the identity. A fresh setup would take three deploys across two stacks.
3. **Patching Alchemy to expose `SigningHostedZone`.** This would be the repository's first patched dependency. Existing state would lack the attribute until a forced update, and the patch would need rechecking on every upgrade. The deploy-time lookup needs neither.
4. **Hardcoding `dkim.amazonses.com`.** Rejected: SES says the zone differs by Region and by identity, and AWS's own tables disagree for at least one Region.
5. **Always managing DMARC.** DMARC is a policy for the whole domain, and an existing record is common. Route 53 would overwrite it silently. It is opt-in, documented for domains without one.
6. **Deriving DKIM names from `dkimTokens`.** That attribute is not stable, so every identity update would leave the names unresolved at plan and bypass the adoption check. `emailIdentity` is stable.

## Consequences

- **Deploying the identity stack changes DNS.** Its plan shows the records. In Route 53 mode an existing record with the same name and type is overwritten without warning.
- **Cloudflare mode needs Cloudflare credentials** in the Alchemy profile or the environment.
- **Switching `cloudflare` mode off is not a supported configuration change.** Existing Cloudflare state rows still need the provider. If it is ever needed, remove those rows with `alchemy state delete` first; the records stay in DNS.
- **Destroying the identity stack keeps every record.** Removing them is an operator decision, as it is for the identity.
- **Every plan and deploy looks up the DKIM records.** They come from one SES call per evaluation.
- **`alchemy unsafe nuke` with this stack's config would list every DNS record the credentials reach.** Never run it against this stack.
- **The stack no longer holds a single resource.** `--adopt` on it adopts every existing record it declares.

## Confirmation

- **Unit tests** in `apps/backend/src/identity/SendingDns.test.ts` pin:
  - the exact records;
  - the refusal of a missing zone or a wrong token count;
  - mode decoding, including blank keys.
- **Live tests on 2026-09-23 in a separate Region** (us-west-2), each on a throwaway subdomain that is never reused:
  - **Route 53:** MX and SPF reached `INSYNC` before the identity was created. `DkimStatus` and `MailFromDomainStatus` reached `SUCCESS` after about 60 s. The CNAME targets equalled the identity's own `SigningHostedZone`, and a redeploy planned 7 no-ops.
  - **Cloudflare:** created records carried quoted TXT content, `proxied: false`, automatic TTL and MX priority 10. SES verified after about 90 s, and a redeploy planned 7 no-ops.
  - **Cleanup:** after both runs, the test identities, records and state bucket were removed and checked against the inventory.
- **The production migration** in `cloudflare` mode:
  - The dry run showed 1 identity update and 6 records adopted, and nothing else.
  - A field-by-field gate confirmed beforehand that no record would be rewritten.
  - After the deploy every record was field-identical, including TTL, comment and `modified_on`. The identity's tokens, `LastKeyGenerationTimestamp`, MAIL FROM and tags were unchanged.
  - The next plan was all no-ops, and the service stack planned no changes.
- **The manual path is unchanged.** Before the migration, the rewritten stack planned a no-op against the production identity in manual mode.

## References

- [Plan](work/sending-dns.md)
- [Amazon SES: Managing Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy-managing.html) — `SigningHostedZone`
- [Amazon SES endpoints: DKIM domains](https://docs.aws.amazon.com/general/latest/gr/ses.html)
- [Amazon SES: Using a custom MAIL FROM domain](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
- Alchemy 2.0.0-beta.77:
  - `Output.ts` (`mapEffect`);
  - `AWS/Route53/Record.ts` (UPSERT, no `Unowned`);
  - `Cloudflare/DNS/Record.ts` (explicit adoption);
  - `Cloudflare/Providers.ts` (configuration resolved when the layer is built);
  - `AWS/SES/EmailIdentity.ts:228` (stable attributes).
