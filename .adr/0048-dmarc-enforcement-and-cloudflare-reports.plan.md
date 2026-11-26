# Plan: DMARC enforcement and Cloudflare report handling (ADR-0048)

## Goal

- The domain's DMARC policy is a setting, so it can move from `none` to `quarantine` to `reject`.
- Aggregate reports go to Cloudflare DMARC Management, declared with Alchemy, and stop landing in a mailbox.
- The From domain's own SPF record is declared too, so the mailbox provider's mail passes DMARC on SPF as well as DKIM.

Non-goals: parsing reports in emailer, mailbox filters, moving the policy past `none` (each step is the user's call later).

## Tasks

1. **Settings** (`SendingDns.ts`): `EMAILER_DMARC_REPORTS` (mailbox or `cloudflare`), `EMAILER_DMARC_POLICY`, `EMAILER_IDENTITY_SPF`, and `IgnoredDnsSetting` for each setting nothing would publish. Verified by unit tests for every combination.
2. **Records** (`SendingDns.ts`): `dmarcValue`, `dmarcRecord` with an output report address, `identitySpfRecord`, and `reportAddressOf`, which declares `Cloudflare.Email.DmarcReports` and maps `ruaPrefix`. Verified by unit tests for the values.
3. **Stack** (`stacks/sending-identity.ts`): publish the SPF and the DMARC record from the settings. Verified by typecheck and the prod preview.
4. **Docs:** README configuration table and Automatic DNS section, `.env.example`, ADR-0048.
5. **Prod rollout** (operator configuration, not the repository):
   - rename the report setting to `EMAILER_DMARC_REPORTS=cloudflare`;
   - set `EMAILER_DMARC_POLICY=none` and the SPF value;
   - preview the identity stack. It must show exactly: DmarcReports create, `Dmarc` update, `IdentitySpf` create. Anything else stops the rollout;
   - deploy.
6. **Checks:**
   - the authoritative nameservers serve one DMARC record with Cloudflare's address only, and the new SPF beside the existing TXT records;
   - DMARC Management reads `enabled` with no `status`;
   - reports appear in Cloudflare within a day;
   - none arrive at the old mailbox after 48 hours.

## Evidence

The changed record values before and after, the preview's change list, the DMARC Management state, and the key code excerpts.

## Open questions

None.
