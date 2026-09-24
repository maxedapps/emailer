# Aligned MAIL FROM, SPF and DMARC for `mail.example.com`

> **Status:** Complete
> **ADRs:** [0010 — Custom MAIL FROM, SPF and DMARC for the sending domain](../0010-aligned-mail-from-spf-and-dmarc.md) (Accepted); discharges obligations in [0002](../0002-domain-sending-identity.md) and extends [0009](../0009-account-level-sending-identity.md)
> **Updated:** 2026-09-15
> **Lane:** independent of the mass-sending lane. Own worktree, own Emailer stage name `test-a`. Shares the retained `EmailerSending/shared` stack, which it updates in place; see Merge notes.

## Outcome and boundaries

- **Problem and target:** Mail from `mail.example.com` authenticates by DKIM only. SPF passes for `amazonses.com`, not for our domain, and no DMARC policy exists. Bulk-sender rules at Google, Yahoo and Microsoft require SPF, DKIM, DMARC and From alignment, and DMARC is what stops third parties from sending as the domain. **Target:** a delivered message shows `spf=pass` with `smtp.mailfrom` at `bounce.mail.example.com`, `dkim=pass header.d=mail.example.com` and `dmarc=pass header.from=mail.example.com`, under a `p=none` policy reporting to `dmarc@reports.example.net`.
- **In scope:**
  - Three records in Route 53 zone `example.com` and one authorization TXT in the Cloudflare zone `reports.example.net`, published by hand after explicit confirmation naming both zones
  - The two MAIL FROM props on the retained identity in `stacks/sending-identity.ts`, deployed as an in-place update
  - A live gate on one delivered message read through the operator mailbox
  - ADR-0010, lifecycle links in ADR-0002 and ADR-0009, README, `.env.example` and wiki updates
- **Out of scope:**
  - Tightening DMARC beyond `p=none` (later, after reports)
  - Declaring DNS records in Alchemy (ADR-0009 alternative 5)
  - BIMI, ARC, dedicated IPs, Virtual Deliverability Manager
  - Any change to application code, the Emailer stack or the mass-sending lane
  - Reading or acting on DMARC reports (operator activity after the gate)
- **Approach:** Publish the records first, so that SES's first MX probe and every external resolver see them from the start. Then add `mailFromDomain` and `mailFromBehaviorOnMxFailure` to the existing identity declaration; the Alchemy provider updates MAIL FROM attributes on the observed identity and never recreates it. Wait for SES's MAIL FROM status, then prove alignment on a delivered message from an ephemeral Emailer stage using today's single-recipient send path. Nothing in the Emailer stack changes: the reference reads only the identity name and ARN.

## Key files, evidence, and decisions

| File or source                                                                                    | Why it matters                                                                                                                                                                                                                                                                                                                                     | Decision or plan impact                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stacks/sending-identity.ts:23-25`                                                                | The only `AWS.SES.EmailIdentity` declaration; reads `EMAILER_SENDER_IDENTITY`                                                                                                                                                                                                                                                                      | T2 adds the two props, derived from that value; no new config key, no new output                                                                                                  |
| `node_modules/alchemy/src/AWS/SES/EmailIdentity.ts:56-69, 275-284, 371-386`                       | Props `mailFromDomain` / `mailFromBehaviorOnMxFailure` (default `USE_DEFAULT_VALUE`); `diff` replaces only on an identity-name change; reconcile calls `putEmailIdentityMailFromAttributes` when it differs                                                                                                                                        | An update, never a replacement; DKIM untouched (steps 3b/3c run only when DKIM props are declared, which they are not). Declare the behaviour explicitly                          |
| `node_modules/alchemy/src/Plan.ts:1511-1519`; `Diff.ts:184-201`                                   | An `undefined` provider diff falls back to a canonical props comparison → `update`                                                                                                                                                                                                                                                                 | T2's plan must read `Plan: 1 to update`, `[EmailerSender] update`                                                                                                                 |
| `node_modules/alchemy/src/AWS/SES/EmailIdentity.ts:199-211, 260-273`                              | Attributes and `read` expose no `MailFromAttributes`                                                                                                                                                                                                                                                                                               | MAIL FROM status is observed only through `aws sesv2 get-email-identity`, never through plan, state or a stack output                                                             |
| AWS SES custom MAIL FROM docs                                                                     | Exactly one MX `10 feedback-smtp.us-east-1.amazonses.com`; SPF TXT `v=spf1 include:amazonses.com ~all`; must be a subdomain of the identity used for nothing else; status `PENDING→SUCCESS`, probed for up to 72 h from when the attribute is set                                                                                                  | T1 publishes before T2 sets the attribute, so SES's first probe finds the MX; the bounce subdomain never appears in a From address                                                |
| `dig SOA example.com` → negative TTL 86400; commit `50b5a93`; memory `dns-changes-stay-in-scope` | A resolver that answers NXDOMAIN for a name before it exists may hold that answer for a day; this project lost a day to it once                                                                                                                                                                                                                    | T1 preflights through the Route 53 and Cloudflare APIs only, never `dig` on a name about to be created; external checks start at the authoritative servers                        |
| RFC 7489 §3.1.2, §6.3, §7.1                                                                       | Relaxed alignment is the default and required for a bounce subdomain; external `rua` needs `<policy-domain>._report._dmarc.<mailto host>` TXT `v=DMARC1` at the host part of the address, `reports.example.net`                                                                                                                                 | The DMARC record carries no `aspf`; no `sp` because with `p=none` a subdomain policy adds nothing yet; the authorization TXT goes in the Cloudflare zone                          |
| Zone facts (read-only `dig`, 2026-09-15)                                                          | `reports.example.net` is not delegated; its SOA is served by the `reports.example.net` zone on Cloudflare; `example.com` currently has no records under `bounce.mail.` or `_dmarc.mail.`                                                                                                                                                         | The TXT is created in zone `reports.example.net` under the full name; the T1 preflight is clean today                                                                               |
| `the mailbox stack/alchemy.run.ts:110-145`                                                     | The mailbox stack declares Cloudflare Email Routing resources on the zone, not DNS records                                                                                                                                                                                                                                                           | A hand-added TXT is not managed by IaC and survives mailbox-stack redeploys                                                                                                               |
| Archived mailbox message `in_70bc9f18…` (cycle 2, 2026-09-14)                                       | The receiver `mx.cloudflare.net` stamps `Authentication-Results` (and an `ARC-Authentication-Results` twin) with `dkim=pass header.d=mail.example.com`, `dmarc=none header.from=mail.example.com policy.dmarc=none`, `spf=pass … smtp.mailfrom=…@amazonses.com`, plus `Received-SPF` with `envelope-from=`; the mailbox API exposes `envelopeFrom` | The gate reads that header by name; the baseline tokens are recorded so the change is visible: `dmarc=none → pass`, `smtp.mailfrom` at `amazonses.com → bounce.mail.example.com` |
| `.adr/work/sending-identity.md:140-165, 166-208`                                                  | Precedents for a confirmed one-time DNS publication and a live evidence run                                                                                                                                                                                                                                                                        | T1 and T3 follow the same shapes                                                                                                                                                  |
| `.adr/0002-domain-sending-identity.md:39-41, 45`                                                  | The open SPF/DMARC/MAIL FROM obligations and the "no MX" reasoning                                                                                                                                                                                                                                                                                 | T4 adds a lifecycle line pointing at ADR-0010; body preserved                                                                                                                     |
| `.adr/0009-account-level-sending-identity.md:29, 47, 49`                                          | "Three DKIM CNAMEs" inventory; "Still open from ADR-0002"; "`EMAILER_SENDER_IDENTITY` is the identity's only prop"                                                                                                                                                                                                                                 | T4: header line `Extended by: ADR-0010` (leave `:29` as accepted rationale); `:47` lifecycle link; `:49` clerical reword                                                          |
| `README.md:174-190, 246-248`; `.env.example:11`                                                   | The Sending identity section, the retained-inventory sentence, and the "identity is its only prop" comment                                                                                                                                                                                                                                         | T4 rewrites the records list and rules and corrects the comment                                                                                                                   |
| `wiki/aws/deliverability.md:12-16, 26`; `wiki/aws/ses.md:105`                                     | Generic SPF/DMARC/MAIL FROM rows; "no MX" discussion; `MailFromDomainNotVerifiedException` row                                                                                                                                                                                                                                                     | T4 records the concrete record values, status polling and the external-report rule                                                                                                |

- **Open gate:** none for the plan. T1 has an operator gate: explicit go-ahead naming Route 53 `example.com` (`Z00000000000000`) and Cloudflare zone `reports.example.net` (zone id read from the Cloudflare zone list and quoted in the request).

## Research

Decision-relevant results (sources in the table above):

- Alchemy treats a MAIL FROM prop change on the retained identity as `update`; the provider's create path runs only when `getEmailIdentity` observes nothing, so the identity is never recreated and no DKIM key is minted.
- The provider sends `BehaviorOnMxFailure: undefined` when the prop is omitted; the SES API marks it required, so the plan declares `"USE_DEFAULT_VALUE"` explicitly. Removing `mailFromDomain` later does nothing: the provider only acts when the prop is defined. A `FAILED` status is not restarted by a no-op redeploy; it needs `PutEmailIdentityMailFromAttributes` re-issued by hand.
- SES verifies the MX only. The SPF TXT is required for `spf=pass` but is not reflected in `MailFromDomainStatus`, so it is checked with `dig`.
- The receiver evidence exists today. The 2026-09-14 message archived in the operator mailbox carries `Authentication-Results: mx.cloudflare.net;` with all three verdicts; `Return-Path` is absent (Worker delivery), so the envelope sender is read from the `Received-SPF` `envelope-from=` token or the mailbox API's `envelopeFrom` field.
- Cloudflare Email Routing enforces the sender's DMARC policy on inbound mail; `p=none` rejects nothing.

## Tasks

#### T1 — Publish the four DNS records once

- **Change:**
  - **Before any DNS write,** obtain the user's explicit go-ahead naming both zones: Route 53 `example.com` (`Z00000000000000`) and Cloudflare zone `reports.example.net` (zone id looked up first through the Cloudflare API and quoted in the request).
  - **Preflight through the APIs only:** `aws route53 list-resource-record-sets --hosted-zone-id Z00000000000000 --query "ResourceRecordSets[?Name=='bounce.mail.example.com.' || Name=='_dmarc.mail.example.com.']"` returns `[]`; the Cloudflare zone's DNS records contain no `_report._dmarc` name. Do **not** `dig` these names before they exist.
  - In Route 53, one change batch with `Action: CREATE` (never `UPSERT`, so an unexpected existing record fails loudly), TTL 1800: MX `bounce.mail.example.com` → `10 feedback-smtp.us-east-1.amazonses.com`; TXT `bounce.mail.example.com` → `"v=spf1 include:amazonses.com ~all"`; TXT `_dmarc.mail.example.com` → `"v=DMARC1; p=none; rua=mailto:dmarc@reports.example.net"`. Poll the change to `INSYNC`.
  - In Cloudflare zone `reports.example.net`, one TXT `mail.example.com._report._dmarc.reports.example.net` → `"v=DMARC1"`, DNS-only, through the Cloudflare API (`cloudflare-api` MCP tools) or the dashboard.
- **Starts at:** the T3 precedent in `.adr/work/sending-identity.md:140-165`; `the mailbox stack/alchemy.run.ts:110-145` (the Cloudflare zone owner)
- **Depends on:** none
- **Status:** Verified
- **Evidence:**
  - Worktree `~/worktrees/emailer/deliverability` on branch `deliverability` at `cb73c3a`.
  - User confirmed T1 go-ahead 2026-09-15 naming Route 53 `example.com` (`Z00000000000000`) and Cloudflare `reports.example.net` (`00000000000000000000000000000000`).
  - Cloudflare zone lookup via API: `reports.example.net` zone id `00000000000000000000000000000000` (account `00000000000000000000000000000000`). Connected Cloudflare MCP is a different Cloudflare account and does not see this zone; lookup used the mailbox account's API token.
  - Route 53 preflight `Z00000000000000` query for `bounce.mail.example.com.` and `_dmarc.mail.example.com.` → `[]`. Existing `mail.example.com` records are the three DKIM `CNAME`s only.
  - Cloudflare preflight: no DNS record whose name contains `_report._dmarc`; exact name `mail.example.com._report._dmarc.reports.example.net` count 0.
  - No `dig` of names about to be created.
  - Route 53 change `/change/C00505981QJHOM2GPEVP4` (`CREATE`, never `UPSERT`) → `INSYNC`.
  - Cloudflare TXT id `996789d5a2305861f26a2eb5b93957f2`, DNS-only, `proxied: false`, TTL 1800, content `v=DMARC1`.
  - Authoritative (the zone's Route 53 name server) then `@8.8.8.8`: MX `10 feedback-smtp.us-east-1.amazonses.com.`; SPF TXT `"v=spf1 include:amazonses.com ~all"`; DMARC TXT `"v=DMARC1; p=none; rua=mailto:dmarc@reports.example.net"`; report TXT `"v=DMARC1"`.
- **Tests:** Operational one-time step with no automation. Validated by the resolver checks below and exercised end to end in T3.
- **Verify:**
  - After `INSYNC`, against an authoritative server first (`dig +short @<name server> …`, using one that `dig NS example.com` lists), then against `8.8.8.8`:
    - `bounce.mail.example.com MX` → `10 feedback-smtp.us-east-1.amazonses.com.` and nothing else.
    - `bounce.mail.example.com TXT` → `"v=spf1 include:amazonses.com ~all"`.
    - `_dmarc.mail.example.com TXT` → the DMARC record verbatim.
  - `dig +short @8.8.8.8 mail.example.com._report._dmarc.reports.example.net TXT` → `"v=DMARC1"` (Cloudflare serves it immediately).
- **Risk/recovery:** A wrong value is corrected with a second change batch (`UPSERT` is acceptable for a correction of a record this task created). A `CREATE` that fails with "already exists" means the preflight missed something: stop and inspect. Never delete the DKIM `CNAME`s.

#### T2 — Declare the custom MAIL FROM on the retained identity

- **Change:**
  - In `stacks/sending-identity.ts`, add `mailFromDomain: \`bounce.${emailIdentity}\``and`mailFromBehaviorOnMxFailure: "USE_DEFAULT_VALUE"`to the existing`AWS.SES.EmailIdentity(senderLogicalId, …)` props. No other change to the declaration or the outputs.
  - Extend the header comment with one line: the MAIL FROM subdomain sends nothing and receives only SES feedback at its MX; it must never be used in a From address.
  - Do not deploy while a mass-sending `test-b` plan or deploy is in flight; both read the identity's state row.
- **Starts at:** `stacks/sending-identity.ts:20-31`
- **Depends on:** T1 (the MX exists before SES's first probe)
- **Status:** Verified
- **Evidence:**
  - No Emailer `test-b`/`test-a` Lambdas; `alchemy state list Emailer` → path does not exist. Mass-sending worktree exists with application edits only; no alchemy plan/deploy process in flight at T2 deploy.
  - `pnpm check` green (117 files formatted, oxlint 0, tsc clean, 470 unit tests, check:imports).
  - Plan `--stage shared --detailed`: `Plan: 1 to update`, `[EmailerSender] update`, `+ mailFromDomain: bounce.mail.example.com`, `+ mailFromBehaviorOnMxFailure: USE_DEFAULT_VALUE`. No `replace` or `create`.
  - Deploy: `[EmailerSender] updated`, ARN `arn:aws:ses:us-east-1:123456789012:identity/mail.example.com`, same three DKIM tokens.
  - Immediately after deploy (09:28:10+02:00): `MailFromDomain=bounce.mail.example.com`, `BehaviorOnMxFailure=USE_DEFAULT_VALUE`, `MailFromDomainStatus=PENDING`, DKIM `SUCCESS`, `LastKeyGenerationTimestamp=2026-09-14T17:30:33.252000+02:00`.
  - `MailFromDomainStatus=SUCCESS` at 09:29:05+02:00 (~63s after deploy). DKIM `SUCCESS`, timestamp unchanged `2026-09-14T17:30:33.252000+02:00`.
  - `alchemy state read EmailerSending/shared/EmailerSender` → `removalPolicy: "retain"`, props include the two MAIL FROM fields.
- **Tests:** No unit test: the file is a declaration and `pnpm check` type-checks and lints it. The observable behaviour, an in-place update and a set MAIL FROM domain, is checked by the plan output and the SES read below.
- **Verify:**
  - Run `pnpm check`; expect green.
  - Run `pnpm exec alchemy plan --config stacks/sending-identity.ts --stage shared --env-file .env.test --profile emailer-test --detailed`; expect `Plan: 1 to update`, `[EmailerSender] update` with `mailFromDomain: bounce.mail.example.com` in the property diff, and **no** `replace` or `create`.
  - Run `pnpm exec alchemy deploy --config stacks/sending-identity.ts --stage shared --env-file .env.test --profile emailer-test --yes --no-input`; expect `[EmailerSender] updated`.
  - Poll `aws sesv2 get-email-identity --email-identity mail.example.com --query '[MailFromAttributes,DkimAttributes.Status,DkimAttributes.LastKeyGenerationTimestamp]'`; expect `MailFromDomain=bounce.mail.example.com`, `BehaviorOnMxFailure=USE_DEFAULT_VALUE`, `MailFromDomainStatus` reaching `SUCCESS`, DKIM `SUCCESS`, and the key timestamp unchanged from `2026-09-14T17:30:33.252000+02:00`. Record the elapsed time.
  - Run `pnpm exec alchemy state read EmailerSending/shared/EmailerSender --config stacks/sending-identity.ts --env-file .env.test --profile emailer-test`; expect `removalPolicy: "retain"` still present.
- **Risk/recovery:** If the plan shows anything but one `update`, stop before deploying; a `replace` would create a second identity. A deploy that fails after `PutEmailIdentityMailFromAttributes` is safe to rerun. While status is `PENDING`, the only useful check is the authoritative MX answer from T1; SES's resolver cannot be flushed, and the docs allow up to 72 hours. A `FAILED` status needs `PutEmailIdentityMailFromAttributes` re-issued by hand.

#### T3 — Live gate: aligned authentication on a delivered message

- **Change:**
  - Copy the root `.env.test` into the worktree, keeping `dmarc@reports.example.net` first in `EMAILER_ALLOWED_RECIPIENTS` (today's send path still enforces the allowlist; that is fine for this lane).
  - Deploy the Emailer at `--stage test-a` (`pnpm exec alchemy deploy --config alchemy.run.ts --stage test-a --env-file .env.test --profile emailer-test --yes --no-input`) and copy its outputs into the worktree `.env.test`.
  - Create a contact for `dmarc@reports.example.net`, a list and a campaign, and send it.
  - Read the delivered message through the operator mailbox: `mailbox_get_message_headers` for the header block and the message's `envelopeFrom` field, or `the mailbox CLI messages source` from the operator mailbox repo if the MCP needs re-authentication.
  - Destroy `test-a`.
- **Starts at:** `.adr/work/sending-identity.md:166-208` (T4 precedent), `README.md:192-248`
- **Depends on:** T2 (status `SUCCESS`; a send before that uses the `amazonses.com` fallback and proves nothing)
- **Status:** Verified
- **Evidence:**
  - Deploy `--stage test-a`: `Plan: 15 to create, 10 binding changes`; `[Api/Allow(Api, AWS.SES.SendEmail(EmailerSender, EmailerMail))] create`; no `EmailIdentity` create. Outputs `apiUrl` / `unsubscribeUrl`; table `Emailer-EmailerData-test-a-wjpth67j2bim3yr3`.
  - Contact `92702b76-6751-441d-b45e-aa8a550cf51c` (`dmarc@reports.example.net`), list `f10dadb5-b505-4a71-9c9a-ad773afab5f4`, campaign `aa217291-57d5-4f63-b7a7-27310a2a6584`.
  - `campaigns send` exit 0, `submission.state: "accepted"`, `messageId` `010001a0a3fb7559-bb0d06cf-46b8-41ce-87b7-875a5d028644-000000`.
  - the operator mailbox `in_c87e4714e27cd07709a890a4deedfb0bf7a1206eab7017338132af9f5c3629bc`; `envelopeFrom` `…@bounce.mail.example.com`.
  - Raw `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=mail.example.com header.s=xrqbcrri2cif2ux65a5aostry7f4z2bb header.b=SpwlJV/J; dkim=pass header.d=amazonses.com header.s=224i4yxa5dv7c2xz3womw6peuasteono header.b=P1FCwCI/; dmarc=pass header.from=mail.example.com policy.dmarc=none; spf=none (…smtp.helo=a8-56.smtp-out.amazonses.com); spf=pass (…domain of …@bounce.mail.example.com…) smtp.mailfrom=010001a0a3fb7559-bb0d06cf-46b8-41ce-87b7-875a5d028644-000000@bounce.mail.example.com`. `Received-SPF` `envelope-from=` at the bounce subdomain. `d=mail.example.com` `h=` includes `List-Unsubscribe:List-Unsubscribe-Post`. The HELO `spf=none` is the SES outbound host, not the MAIL FROM check.
  - Destroy: `Plan: 15 to delete`; identity not in the plan. After destroy: no `emailer-test-a-*` Lambdas/log groups, no `Emailer-*-test-a-*` tables/queues/roles/alarms/config sets/event rules; `alchemy state list Emailer` → path does not exist. DKIM timestamp still `2026-09-14T17:30:33.252000+02:00`; `MailFromDomainStatus=SUCCESS`.
- **Tests:** Live acceptance only; this is the gate. In the delivered message's `Authentication-Results: mx.cloudflare.net;` header (the `ARC-Authentication-Results` twin carries the same tokens), all of:
  - `spf=pass` with `smtp.mailfrom=<id>@bounce.mail.example.com` (baseline on 2026-09-14: `smtp.mailfrom=<id>@amazonses.com`).
  - `dkim=pass header.d=mail.example.com`.
  - `dmarc=pass header.from=mail.example.com` (baseline: `dmarc=none … policy.dmarc=none`).
  - The operator mailbox `envelopeFrom` field, or the `Received-SPF` `envelope-from=` token, is at `bounce.mail.example.com`.
  - The `DKIM-Signature` for `d=mail.example.com` still lists `List-Unsubscribe:List-Unsubscribe-Post` in `h=` (ADR-0004 coverage unchanged).
- **Verify:**
  - Run the send through the CLI; expect `submission.state: "accepted"` and exit 0.
  - Read the headers; expect the five assertions above.
  - Run `aws sesv2 get-email-identity --email-identity mail.example.com --query DkimAttributes.LastKeyGenerationTimestamp` after the destroy; expect the unchanged `2026-09-14T17:30:33.252000+02:00`.
  - After the destroy: no `emailer-test-a-*` Lambdas, no `Emailer-*-test-a-*` resources, `alchemy state list Emailer` shows no `test-a`.
- **Risk/recovery:** If `smtp.mailfrom` is still at `amazonses.com` although status was `SUCCESS`, SES has not yet switched the envelope; wait ten minutes and send once more before investigating. If `dmarc=fail` appears beside `spf=pass` and `dkim=pass`, the record is malformed; fix the TXT and resend. Destroy `test-a` before investigating anything else. **Block, don't loop,** if a second send after the fixes still fails: that contradicts the SES docs and needs a look at the raw record set.

#### T4 — Records, README and wiki

- **Change:**
  - ADR-0010: set `Status: Accepted` with `Accepted:` date after T3 passes and the user accepts.
  - ADR-0002: add a header line `- Obligations discharged in part: [ADR-0010](../0010-aligned-mail-from-spf-and-dmarc.md)` naming the SPF, DMARC and custom MAIL FROM consequences (`:40-41, :45`); body unchanged.
  - ADR-0009: add a header line `- Extended by: [ADR-0010](../0010-aligned-mail-from-spf-and-dmarc.md)` (MAIL FROM, SPF and DMARC records join the retained inventory); `:47` "Still open from ADR-0002" becomes `- **SPF and DMARC.** Published under ADR-0010; see there for the records.`; `:49` clerical reword to "the prop whose change plans a replacement" (no "only"). `:29` stays as accepted rationale.
  - README "Sending identity" (`:174-190`): list all seven records with their values and zones, add `MailFromDomainStatus=SUCCESS` to the readiness checks, state that the bounce subdomain must not be used as a From domain, and extend the readiness sentence to `spf=pass` at the bounce subdomain, `dkim=pass` and `dmarc=pass`. Retained-inventory sentence (`:246-248`): "its DNS records in both zones" instead of "its three DKIM CNAMEs".
  - `.env.example:11`: "the identity is its only prop" becomes "the identity name is the prop whose change plans a replacement".
  - `wiki/aws/deliverability.md`: the concrete SES MAIL FROM record values for a Region, that SES verifies the MX only, the relaxed-alignment requirement for a bounce subdomain, the `_report._dmarc` rule for external report addresses at the mailto host, that `p=none` is the required starting point, and the negative-cache rule (publish before probing; verify at the authoritative server first); correct the "no MX" paragraph (`:26`) to say the bounce subdomain carries one.
  - `wiki/aws/ses.md:105`: note that `MailFromDomainNotVerifiedException` is reachable only under `REJECT_MESSAGE`.
- **Starts at:** the paths above
- **Depends on:** T3
- **Status:** Verified
- **Evidence:**
  - Docs updated per T4 (ADR-0010 Accepted date + T3 confirmation; ADR-0002/0009 lifecycle lines; README inventory; `.env.example`; wiki deliverability + ses).
  - `pnpm check` green (format, lint, tsc, 470 unit tests, check:imports).
  - T4 greps: no `only prop` / `Still open from ADR-0002` in `.adr/0009-*.md` README `.env.example`; no `three DKIM` in README.
  - Relative-link check: 385 links in README/`.adr`/`wiki` resolve (ellipsis placeholders in review reports skipped).
  - Implementation review: [deliverability-implementation-review.md](deliverability-implementation-review.md), closure `Clear`, no material findings.
- **Tests:** Documentation; no automation. Validated by the link check and by reading T3's evidence into the text.
- **Verify:**
  - Run `pnpm format:check`; expect clean.
  - Run the relative-link check over `README.md`, `.adr/**/*.md`, `wiki/**/*.md`; expect none broken.
  - Run `grep -rn "only prop\|Still open from ADR-0002" .adr/0009-*.md README.md .env.example && grep -n "three DKIM" README.md`; expect no match from either (ADR-0009 `:29` keeps its "three DKIM" rationale and is outside the second grep).

## Final acceptance

- **Checks:**
  - `pnpm check` green.
  - All four records resolve at the authoritative servers and at `8.8.8.8`; T2's plan showed exactly one `update`, no `replace`; `MailFromDomainStatus=SUCCESS`; the DKIM key timestamp is unchanged after every step.
  - T3's delivered message shows `spf=pass` at the bounce subdomain, `dkim=pass` and `dmarc=pass` for `mail.example.com`.
  - Link checks clean; ADR-0010 Accepted; ADR-0002 and ADR-0009 carry their links.
- **End state:**
  - `EmailerSending/shared` still holds one retained identity, now with a verified custom MAIL FROM.
  - Seven retained records across two zones, listed in the README.
  - No Emailer `test-a` stage exists.
- **Operator steps:** T1's DNS writes need explicit confirmation naming both zones. The Cloudflare record needs Cloudflare API access or the dashboard.
- **Deferrals or blockers:**
  - DMARC policy stays `p=none`; tightening is a separate decision after reports have been read.
  - DMARC report arrival (typically within 24 to 48 hours) is confirmed by the operator in the operator mailbox, outside this gate.
  - PTR and TLS are SES-managed and not verified here.

## Handoff

- **Next action:** None. Implementation complete; PR from the `deliverability` worktree.
- **Deviations:**
  - ADR-0010 Consequences counted "three to six" retained records while enumerating seven (three DKIM `CNAME`s, MX, SPF TXT, DMARC TXT, Cloudflare authorization TXT). Clerical correction to seven; README lists them without claiming six. Plan end-state "six" was the same off-by-one.
- **Resources:** Worktree `~/worktrees/emailer/deliverability` on branch `deliverability` retained until the PR is merged (not merged automatically). Untracked `.env.test` copied from the main checkout. Main checkout left on `main`. No `test-a` stage. A sibling `mass-sending` worktree exists; it was not deploying `test-b` during T2.
- **Merge notes:** Files shared with the mass-sending lane, all additive and on different lines: `README.md` (the retained-inventory sentence), `wiki/aws/ses.md`, `.env.example` (line 11 here, lines 19-32 there), and ADR-0002's header (one lifecycle line each). Once T2 reaches `SUCCESS`, every Emailer stage, including the other lane's `test-b`, sends with the `bounce.mail.example.com` envelope; harmless for simulator recipients. Do not run T2's shared deploy while a `test-b` plan or deploy is in flight. **Sequencing:** if the mass-sending lane merges before T3 runs, `campaigns send` returns `queued` instead of `accepted`; T3 then polls `campaigns get` to `completed` before reading the delivered headers, and the allowlist no longer exists, so the operator mailbox address is simply the list's only member.
- **Reviews:** [Independent plan review](deliverability-review.md), 2026-09-15: seven findings, all accepted. R1 reordered T1/T2 (records before the attribute), replaced `dig` preflight with API preflight, `CREATE` instead of `UPSERT`, authoritative-first verification. R2 closed with evidence: the archived cycle-2 message shows `Authentication-Results: mx.cloudflare.net;` carrying `spf`, `dkim` and `dmarc` tokens; the gate names that header and uses `envelopeFrom` instead of `Return-Path`. R3 added `.env.example:11` and the overlap list. R4 replaced the ADR-0009 `:29` rewrite with an `Extended by` header line. R5 reworded the `sp` rationale. R6 dropped the stack output. R7 added the envelope note and the deploy-timing rule.
- **Closure round:** [Follow-up round 2](deliverability-review.md), 2026-09-15: R1–R7 resolved, closure `Clear`. R8 (S1, fix-caused: the T4 grep matched wording T4 keeps) accepted and applied by narrowing the patterns and fixing the `:47`/`:49` wording.
- **Complexity gate:** [Decomplex prevention review](deliverability-decomplex.md), 2026-09-15: no potential complexity findings.
- **Implementation review:** [deliverability-implementation-review.md](deliverability-implementation-review.md), 2026-09-15: no material findings, closure `Clear`. Unverifiable live-AWS/mailbox rows were parent-run (T1–T3 evidence). Six→seven count: approved clerical deviation. Optional README reorder: rejected (not in T4 Change).
