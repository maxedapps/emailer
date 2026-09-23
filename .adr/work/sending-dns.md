# Optional DNS management for the sending identity

> **Status:** Complete
> **ADRs:** [0018 — Optional DNS management for the sending identity](../0018-optional-dns-management.md) (accepted by the user's instruction to implement it). Supersedes in part [0009](../0009-account-level-sending-identity.md) (alternative 5 and "published once, operationally"), [0010](../0010-aligned-mail-from-spf-and-dmarc.md) (records by hand; alternative 6) and [0017](../0017-adopted-root-domain-sending-identity.md) (the one-resource `--adopt` note). Preserves [0009](../0009-account-level-sending-identity.md)'s one-shot retained identity stack and [0010](../0010-aligned-mail-from-spf-and-dmarc.md)'s MAIL FROM and DMARC values.
> **Updated:** 2026-09-23

Names are anonymized:
- the production root domain is `example.com` (DNS on Cloudflare);
- the Route 53 test zone is `example.net`;
- the prior email provider is "the prior provider".

## Outcome and boundaries

- **Problem and target:**
  - Every deployer publishes six DNS records by hand, even when the whole setup lives in one AWS account.
  - **Target:** one optional setting makes the identity stack own those records. That's Route 53 for an all-AWS deployer, and Cloudflare for a zone hosted there.
  - Unset keeps manual publication. Manual deployers also get the DKIM values as a stack output.
- **In scope:**
  - **`EMAILER_DNS`** (`route53` | `cloudflare`, unset = manual).
  - **`EMAILER_DMARC_REPORT_EMAIL`**, opt-in, valid only with `EMAILER_DNS`.
  - **A deploy-time module**:
    - derives the records;
    - reads the DKIM target zone from SES;
    - declares the records through the chosen provider.
  - **Identity stack rewiring:**
    - providers conditional on the mode;
    - the identity waits for the MAIL FROM records;
    - a `dkimRecords` output replaces `dkimTokens`.
  - **The production migration:** the existing Cloudflare records are adopted in place.
  - **Documentation:** README, `.env.example`, wiki notes, ADR-0018 and back-links.
- **Out of scope:**
  - DNS hosts other than Route 53 and Cloudflare.
  - A Route 53 zone in another AWS account.
  - DMARC policies other than `p=none`, and cross-domain report authorization records.
  - Record comments and tags.
  - A procedure for leaving a DNS mode (one-line limitation in ADR-0018).
  - Any change to `alchemy.run.ts` or runtime code.
  - Upgrading Alchemy.
- **Approach:**
  - **One module, one decision point.** A deploy-time leaf module `apps/backend/src/SendingDns.ts` builds plain record descriptors. One adapter per provider declares them, retained like the identity.
  - **MAIL FROM ordering.** In a DNS mode, `mailFromDomain` is derived from the MX and SPF records' outputs, so on a fresh deploy the identity sets MAIL FROM only after those writes finish.
    - On Route 53 a write finishes at `INSYNC`, so the name servers already serve the MX.
    - On Cloudflare it finishes when the API accepts the record, so SES can briefly miss it. Until the zone's negative TTL passes (30 min), mail flows through SES's own MAIL FROM (`USE_DEFAULT_VALUE`).
  - **DKIM records.** They come from one `GetEmailIdentity` call per evaluation, run through `Output.mapEffect` over the identity's stable `emailIdentity` attribute. The token names and the per-identity `SigningHostedZone` are therefore exact at plan time on every redeploy, not only after apply.

## Key files, evidence, and decisions

| File or source | Why it matters | Decision or plan impact |
|---|---|---|
| `stacks/sending-identity.ts:15-36` | One-shot `EmailerSending` stack: `AWS.providers()`, retained identity, outputs `emailIdentity`/`dkimTokens` | Gains the mode-dependent providers, the DNS declarations and the `dkimRecords` output |
| `apps/backend/src/SendingIdentity.ts`, `Mailer.ts:7` | Imported by runtime code (Mailer) | DNS code must not live here, or it lands in the Lambda bundle. New leaf module next to it; `@distilled.cloud/aws` is an `apps/backend` dependency only |
| `node_modules/alchemy/src/Output.ts:62-64, 243, 276-279, 371, 492`; `AWS/Providers.ts:1971-1983` | `map`, `mapEffect` (the effect runs with the stack's services: Region, Credentials; `E = never`), `all`, `interpolate` | DKIM lookup via `mapEffect`; failures are `Effect.die` with a clear message |
| `…/Plan.ts:692-812, 1281-1301, 1541-1546`; `…/Apply.ts:431-454, 909-914`; `…/AWS/SES/EmailIdentity.ts:228` | Downstream sees an upstream's full attributes only when it is a noop. `update` exposes only the stable `emailIdentity`/`identityArn`. The adoption probe needs resolved props. Apply waits for upstream reconciles. Every adopted resource plans as an update | DKIM names are derived from `emailIdentity`. The prod dry run cannot show content changes, so T6 compares the live records to the desired bodies itself |
| `…/AWS/Route53/Record.ts:99-159, 343-344, 467-469, 512-526, 553-574, 632-680`; `HostedZoneLookup.ts:15-60` | Props are `Input<>`. The zone is inferred at apply (longest public zone match, same account). Values are verbatim: TXT quotes are the caller's, and the MX value carries its priority. A numeric TTL means milliseconds. Writes are UPSERT with an `INSYNC` wait. `read` never returns `Unowned` | TTL `"300 seconds"`; TXT values pre-quoted; MX value `10 feedback-smtp.<region>.amazonses.com`; lowercase names; the README warns that existing records are overwritten |
| `…/Cloudflare/DNS/Record.ts:66-168, 297-315, 346-411, 449-602, 716-782` | `zoneId` required. TXT content is compared verbatim. An omitted TTL means automatic (1). The body carries no comment or tags. An existing `(name,type)` record is `Unowned`, so `--adopt` is required. A PUT happens only when content, TTL, `proxied` or priority differ | TXT pre-quoted, `proxied: false`, automatic TTL, `priority: 10`. T6 proves no PUT is needed before the deploy |
| `…/Cloudflare/Zone/lookup.ts:23-108`, `Cloudflare/index.ts:2,105` | `Cloudflare.Zone.resolveZoneId({ accountId, hostname })` walks up to the enclosing zone and fails with "Cloudflare zone not found" | The zone ID becomes a plain string, which keeps the adoption probe working; no zone setting; `Effect.orDie` |
| `…/Cloudflare/Providers.ts:138-722`, `CloudflareEnvironment.ts:34-46, 128-139`, `Auth/Resolve.ts:50-119`; `Stack.ts:94-97, 262-300`; `Alchemist/Session.ts:139-152, 280-313`; effect `Layer.ts:54` | `Cloudflare.providers()` needs credentials when the layer is built. Providers are built before the stack body, for deploy and destroy alike, under the `--env-file` config. `Layer` is `in ROut` | Providers are chosen with `Layer.unwrap` over `EMAILER_DNS`. Naming `AWS.providers()`'s requirements once (one scoped lint disable) makes both branches typecheck without an assertion |
| AWS [Managing Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy-managing.html), [General Reference DKIM domains](https://docs.aws.amazon.com/general/latest/gr/ses.html) | "SigningHostedZone varies by AWS Region and can differ between identities"; AWS's own sources disagree for us-west-2 | Never hardcode the zone. The `dkimRecords` output replaces the README's lookup command |
| `vitest.config.ts:10`, `tsconfig.json:8`, `oxlint.config.ts`, `Mailer.test.ts:501-598` | `stacks/` is typechecked and linted but has no tests. Unit tests live next to `apps/**` modules and use `ConfigProvider.fromEnvRecord` | Pure derivation and config decoding get unit tests in `apps/backend/src/SendingDns.test.ts` |
| `package.json:18` `check:imports` | Smoke-imports `alchemy` and `alchemy/AWS` under Effect RC112 | Adds `alchemy/Cloudflare`, now imported by the identity stack |
| Live facts (2026-09-23) | SES us-west-2 is sandbox. The us-west-2 state bucket does not exist. `example.net` holds only NS/SOA; its SOA TTL is 900, so the effective negative TTL is 15 min. The `example.com` negative TTL is 30 min. Prod `example.com` has 3 DKIM CNAMEs, bounce MX + TXT and `_dmarc` published by hand, the last three with hand-set comments | Live tests in us-west-2 on throwaway subdomains. T4 records whether the state bucket exists, and T5 deletes it only if T4 found it missing. Prod is migrated by adoption |

- **Open gate:** before T4, the user confirms the two test zones and the throwaway names, per the standing DNS-scope rule. This does not block T1–T3.
- **Decisions the user made:**
  - both modes, selected by an environment variable;
  - DMARC is managed only when opted in;
  - big refactors are welcome, but prod must not be destroyed or redeployed.
- **Credentials for live runs:**
  - AWS credentials are exported from the operator's AWS CLI profile with `aws configure export-credentials --format env`. Environment credentials take precedence over the Alchemy profile.
  - Cloudflare credentials come from the operator's Alchemy profile that has a Cloudflare entry, refreshed first.
  - Every Cloudflare-mode run is launched with `env -u CLOUDFLARE_API_TOKEN`, because the shell's token belongs to another Cloudflare account and a complete environment pair would override the profile.

## Research

Findings come from five read-only research lanes over Alchemy 2.0.0-beta.77 source, AWS docs and repo conventions, all on 2026-09-23.

- **MX → identity edge on Route 53.** `Output.all(mx.name, spf.name).pipe(Output.map(() => mailFrom))` gives the edge. Map to the constant: the Route 53 `name` attribute has a trailing dot.
- **Fresh deploy order:** MX/SPF, then identity (MAIL FROM set in the same reconcile), then DKIM. There's no cycle, because the MX/SPF props never read identity outputs.
- **The SES lookup never runs too early.** On a fresh deploy it doesn't run at plan, because the upstream is unresolved. At apply it runs only after the identity's reconcile.
- **The prod migration (records live, not in state, `--adopt`), step by step:**
  - The MX/SPF/DMARC props are plain, so they are probed and adopted.
  - The identity is planned `update`, because the MX is new to state and `mailFromDomain` is unresolved at plan. That's harmless at apply: the MAIL FROM put is skipped because it's equal, DKIM is untouched, and only tags re-sync.
  - The DKIM names are derived from the stable `emailIdentity`, so they resolve at plan and are probed and adopted.
  - The next deploy plans all noop.
- **Why not hardcode the DKIM zone:**
  - Alchemy (beta.77, beta.79 and main) exposes no `SigningHostedZone`, and its JSDoc's `dkim.amazonses.com` is not reliable.
  - A `mapEffect` lookup needs no dependency patch and no `--force`, and follows Alchemy's own AMI-lookup precedent (`AWS/EC2/Image.ts:46-58`).
- **Cloudflare TXT quoting.** Cloudflare TXT content must be quoted character strings (`@distilled.cloud/cloudflare/src/services/dns.ts:851`), and the hand-made prod records are quoted.
- **Cloudflare adoption and comments.** An adopted record gets a PUT only if its content, TTL, `proxied` or priority differ, and that PUT would drop the hand-set comment. T6 therefore proves equality before deploying.
- **`--adopt` scope.** It applies to the whole run. With records in the identity stack it adopts records too. That's intended for the migration, and must still never be passed to `alchemy.run.ts`.
- **`alchemy unsafe nuke`** lists every DNS record in every zone the credentials reach. The README warns against running it with the identity stack's config.
- **Leaving `cloudflare` mode.** Existing Cloudflare state rows need the provider; without it the plan fails with `MissingProviderError`. The rows would be removed with `alchemy state delete` first, and the records stay in DNS. This is a one-line ADR limitation.

## Tasks

#### T1 — Deploy-time DNS module with unit tests

- **Change:**
  - **Config:** add `apps/backend/src/SendingDns.ts`, a leaf module imported only by the identity stack. It exports `dnsMode` (optional `route53` | `cloudflare`) and `dnsSettings` (mode plus optional DMARC report address). Decoding fails when the DMARC email is set without `EMAILER_DNS`, and on any other mode value.
  - **Record descriptors:** export a `DnsRecord` descriptor (logical key, lowercase name, type `CNAME` | `MX` | `TXT`, target value, MX priority) and three pure builders:
    - `mailFromRecords(domain, region)`: MX `bounce.<domain>` → `feedback-smtp.<region>.amazonses.com`, priority 10, plus the quoted SPF TXT;
    - `dmarcRecord(domain, email)`: quoted `v=DMARC1; p=none; rua=mailto:<email>`;
    - `dkimRecords(domain, attributes)`: exactly three CNAMEs `<token>._domainkey.<domain>` → `<token>.<SigningHostedZone>`. It fails when the zone is missing or the token count isn't three; it never falls back to a zone.
  - **SES lookup:** export `dkimRecordsOf(emailIdentity)`, an `Output.mapEffect` that calls `sesv2.getEmailIdentity` and applies `dkimRecords`, dying with a message naming the identity.
  - **Provider adapters:** declare a descriptor, piped through `RemovalPolicy.retain()`, with the provider selected by `Match` on the mode:
    - `AWS.Route53.Record`: value formatted for Route 53 (MX value `"<priority> <host>"`), TTL `"300 seconds"`, zone inferred;
    - `Cloudflare.DNS.Record`: `zoneId`, `proxied: false`, automatic TTL, MX `priority`.
- **Starts at:** `apps/backend/src/Mailer.ts:67-110` (config and `feedbackPublishing` precedents), `Mailer.test.ts:501-598`
- **Depends on:** none
- **Status:** Complete
- **Tests:** `apps/backend/src/SendingDns.test.ts` (unit) protects:
  - exact record names and values for MAIL FROM, DMARC and DKIM, including a non-default `SigningHostedZone` and uppercase input lowercased;
  - refusal on a missing zone or a wrong token count;
  - mode decoding (unset → manual, bad value → error, DMARC without mode → error).
- **Verify:**
  - Run `pnpm exec vitest run --project unit apps/backend/src/SendingDns.test.ts`; expect all cases pass
  - Run `pnpm lint && pnpm typecheck`; expect 0 errors
- **Risk/recovery:** pure code; revert the file.
- **Evidence:** `SendingDns.ts` + 9 unit tests pass; lint and typecheck clean. The email schema lowercases only the domain part, so the test expects `Reports@example.com`.

#### T2 — Identity stack owns the records in a DNS mode

- **Change:**
  - **Providers:** built with `Layer.unwrap` over `dnsMode`: `AWS.providers()` merged with `Cloudflare.providers()` only in `cloudflare` mode. No Cloudflare service is yielded outside that mode.
  - **Records before the identity:** in a DNS mode, declare the MAIL FROM records first and pass `mailFromDomain` as a constant derived from their outputs. Manual mode keeps the plain string.
  - **DKIM and DMARC:** declare the three DKIM records from `dkimRecordsOf(identity.emailIdentity)`, and the DMARC record when opted in.
  - **Cloudflare zone:** in `cloudflare` mode, resolve `zoneId` once from the identity domain through `Cloudflare.Zone.resolveZoneId(...).pipe(Effect.orDie)`.
  - **Outputs:** replace the `dkimTokens` output with `dkimRecords` (name/value pairs) in every mode.
  - **Import check:** add `alchemy/Cloudflare` to `check:imports`.
- **Starts at:** `stacks/sending-identity.ts`, `package.json:18`
- **Depends on:** T1
- **Status:** Complete
- **Tests:** No repository layer tests stacks (`vitest.config.ts:10`). The declaration paths are validated live in T4/T5 (fresh, both modes) and T6 (adoption); `pnpm check` covers types, lint and imports.
- **Verify:**
  - Run `pnpm check`; expect format, lint, typecheck, tests and imports all pass
- **Risk/recovery:** the stack is only deployed in T4–T6; revert before then.
- **Evidence:**
  - `pnpm check` green: 737 tests, imports including `alchemy/Cloudflare`.
  - No type assertion was needed: once `AWS.providers()`'s `any` is named once (one scoped disable), both branches typecheck.
  - The manual-mode plan against the production identity is a no-op.

#### T3 — Documentation, wiki and ADRs

- **Change:**
  - **Configuration docs:** document `EMAILER_DNS` and `EMAILER_DMARC_REPORT_EMAIL` in `.env.example` and the README table.
  - **Rewrite README "Sending identity" as if built this way:**
    - automatic DNS (Route 53 in the same account, or Cloudflare with Cloudflare credentials in the Alchemy profile);
    - manual DNS (MAIL FROM and DMARC records listed, DKIM from the `dkimRecords` output, replacing the lookup command);
    - the one-DMARC-record and Route 53 overwrite warnings;
    - the adoption note (now covering existing records);
    - the `nuke` warning.
  - **One-time setup:** add Cloudflare credentials to the Alchemy profile for `cloudflare` mode.
  - **Wiki notes:**
    - `wiki/aws/ses.md`: the zone varies per identity; look it up with `Output.mapEffect`;
    - `wiki/alchemy/version-specific-traps.md`: `Cloudflare.providers()` needs credentials when the layer is built, so select providers with `Layer.unwrap`;
    - the effective negative TTL is the smaller of the SOA TTL and its MINIMUM field.
  - **ADRs:** finalize ADR-0018 and add the `Superseded in part` back-links in ADR-0009, ADR-0010 and ADR-0017.
- **Starts at:** `README.md` "Sending identity", `.env.example`, `.adr/0018-optional-dns-management.md`
- **Depends on:** T2
- **Status:** Complete
- **Verify:**
  - Run `pnpm format:check`; expect pass
  - Run `{ git diff --name-only --diff-filter=d e0233e4; git ls-files -o --exclude-standard; } | sort -u | xargs grep -l -i -E "<real domains, profile names, account id, provider name, name-server hosts>"`; expect no output. This covers staged, committed and untracked changes since the start commit `e0233e4`; the pattern is kept outside the repository.
- **Risk/recovery:** docs only.
- **Evidence:** README, `.env.example`, three wiki notes, ADR-0018 (Accepted) and back-links in ADR-0009, 0010 and 0017. Leak check: no matches.

#### T4 — Live test: Route 53 mode, fresh identity

- **Change:**
  - First run `aws s3api head-bucket` on the us-west-2 Alchemy state bucket and record the result in the Evidence field. Only a 404 here allows T5 to delete the bucket later.
  - Deploy the identity stack at `--stage dnstest` in **us-west-2** (SES sandbox; separate state bucket, so prod state and identity can't be reached), with:
    - `EMAILER_SENDER_IDENTITY` = the never-reused throwaway name `dnstest-r53-<yyyymmddhhmm>.example.net`;
    - `EMAILER_DNS=route53`;
    - `EMAILER_DMARC_REPORT_EMAIL` set.

    The env file lives in the scratchpad.
  - Check the dry run first; expect creates only: identity + 6 records.
  - After the deploy, confirm:
    - the MX and SPF finished (`INSYNC`) before the identity reconcile started (apply log);
    - SES `DkimStatus=SUCCESS` and `MailFromDomainStatus=SUCCESS`;
    - the CNAME targets equal the identity's own `SigningHostedZone`.
  - Redeploy and confirm an all-noop plan.
- **Depends on:** T2 and the open gate
- **Status:** Complete
- **Verify:**
  - Run `aws sesv2 get-email-identity --region us-west-2 --email-identity <name> --query '{d:DkimAttributes.Status,z:DkimAttributes.SigningHostedZone,m:MailFromAttributes.MailFromDomainStatus}'`; expect SUCCESS/<zone>/SUCCESS. Allow up to 45 min before treating PENDING as a failure.
  - Run `dig @<zone's authoritative NS> CNAME <token>._domainkey.<name>`; expect `<token>.<zone>.`
- **Risk/recovery / cleanup (verified against inventory):**
  1. `alchemy destroy` the stage (orphans the retained resources);
  2. delete the identity with `sesv2 delete-email-identity`;
  3. delete the 6 records with a Route 53 change batch.

  The state bucket is kept for T5.
- **Evidence:**
  - The head-bucket check before T4 returned **404**.
  - Dry run: 7 creates.
  - Apply order: MX/SPF `INSYNC`, then the identity, then DKIM.
  - SES DKIM and MAIL FROM `SUCCESS` after about 60 s; the zone reported by SES equals the CNAME targets.
  - Authoritative answers correct; redeploy plan 7× noop.
  - Cleanup: 7 orphaned, identity and 6 records deleted, zone back to NS/SOA.

#### T5 — Live test: Cloudflare mode, fresh identity

- **Change:** as T4, with these differences:
  - the throwaway name is in the Cloudflare zone the user confirms at the gate;
  - `EMAILER_DNS=cloudflare`;
  - Cloudflare credentials are handled as described under "Credentials for live runs";
  - the dry run shows creates only;
  - after the deploy, records are read back through the Cloudflare API (content quoted, `proxied: false`, automatic TTL) and SES verification reaches SUCCESS;
  - redeploy is noop.
- **Depends on:** T4 cleanup complete
- **Status:** Complete
- **Verify:**
  - Run the SES query from T4; expect SUCCESS/SUCCESS within 45 min
  - Run `dig @<zone's authoritative NS> TXT bounce.<name>`; expect the quoted SPF
- **Risk/recovery / cleanup:**
  - destroy the stage;
  - delete the identity;
  - delete the 6 Cloudflare records by ID;
  - if T4's head-bucket recorded 404, empty the us-west-2 state bucket (every version and delete marker) and delete it;
  - otherwise delete only the `EmailerSending/dnstest/` keys, with every version and delete marker.
- **Evidence:**
  - Dry run: 7 creates.
  - Records read back: TXT quoted, `proxied: false`, automatic TTL, MX priority 10.
  - SES `SUCCESS` after about 90 s; redeploy plan 7× noop.
  - Cleanup: identity and 6 records deleted; the us-west-2 state bucket was emptied (60 entries) and deleted, and now returns 404.

#### T6 — Prod migration: adopt the live Cloudflare records

- **Change:**
  - **Snapshot** the 6 prod records (ID, name, type, content, TTL, `proxied`, priority, comment) and the identity (DKIM tokens, `LastKeyGenerationTimestamp`, `SigningHostedZone`, MAIL FROM, `ConfigurationSetName`, tags).
  - **Pre-deploy equality gate:** compare each record to the body the adapter would send (exact content, TTL 1, `proxied: false`, MX priority 10). Stop on any mismatch; no PUT means the comments survive.
  - Add `EMAILER_DNS=cloudflare` and `EMAILER_DMARC_REPORT_EMAIL=admin@example.com` to the prod `.env`.
  - Dry-run the identity stack at `--stage shared` with `--adopt`. Expect exactly: identity update or noop, and 6 records adopted. No create, replace or delete. Anything else stops the task.
  - Deploy with `--adopt`.
  - Redeploy without flags; expect all noop.
  - Plan `alchemy.run.ts --stage prod`; expect no changes.
- **Depends on:** T5
- **Status:** Complete
- **Verify:**
  - Run a snapshot comparison before and after; expect every record field identical (including TTL and comment) and the identity fields identical except the Alchemy tags, which already exist
  - Run the SES query for the prod identity in us-east-1; expect DKIM SUCCESS and MAIL FROM SUCCESS
- **Risk/recovery:**
  - A record changed unexpectedly: restore it from the snapshot through the API.
  - The adoption misbehaved: run `alchemy state delete` for the record rows and leave the records manual.
  - Prod sending is never interrupted: the identity is never replaced, and `mailFromDomain` keeps its value.
- **Evidence:**
  - Equality gate PASS.
  - Dry run and apply: 1 identity update + 6 adopted.
  - After: every record field-identical, `modified_on` unchanged (no write), zone record count unchanged, identity identical.
  - Flag-free plan all noop; service stack `prod` no changes.

#### T7 — Record the evidence and close

- **Change:**
  - Fill ADR-0018's Confirmation section with the T4–T6 results, in anonymized form:
    - no throwaway FQDNs in real zones;
    - no name-server hosts;
    - no ARNs or account IDs;
    - "field-identical" rather than "byte-identical".
  - Mark the tasks here Complete with evidence.
  - Run the T3 leak check again (the start-commit form) over all changed and new files.
- **Depends on:** T6
- **Status:** Complete
- **Verify:**
  - Run `pnpm check`; expect green
  - Run the leak check; expect no output
- **Evidence:** ADR-0018 Confirmation filled; final leak check and `pnpm check` green before commit.

## Final acceptance

- **Checks:**
  - `pnpm check` green;
  - T4/T5 live tests pass and their cleanup is verified against the SES/Route 53/Cloudflare/S3 inventory;
  - T6 shows prod records and identity unchanged field for field, the identity stack all-noop on redeploy, and the prod service stack unchanged.
- **End state:**
  - `EMAILER_DNS` selects automatic DNS through Route 53 or Cloudflare, with manual as the default;
  - the prod identity stack owns the production domain's SES records;
  - docs and ADR-0018 describe the design as if it had always been there.
- **Deferrals or blockers:**
  - Upstream Alchemy issue for `SigningHostedZone` and Route 53 `Unowned` (not blocking);
  - the prior provider's export and cleanup (separate, pending the user's go).

## Handoff

- **Next action:** none — complete. Follow-ups: file upstream Alchemy issues (`SigningHostedZone` attribute; Route 53 `Unowned`).
- **Reviews:**
  - **Implementation review, Not clear, all findings accepted:**
    - M1: the general `AWS.SES.*` nuke exclusion is restored;
    - M2: the README orders the manual steps before the deploy;
    - minor wording in the README and one stack comment;
    - the cross-domain report record is noted as manual;
    - the zone lookup is lowercased;
    - stale plan text is aligned.
  - **Focused re-review (round 2), Not clear, both findings accepted:**
    - a head-bucket step before T4, with deletion conditional on its result;
    - a leak check over committed, staged and untracked changes since `e0233e4`, with evidence recorded anonymized.

    Nits (ADR wording, status) are handled in T3 and T7.
  - **Adversarial review (round 1), Not clear, all 9 findings accepted:**
    1. field-level prod snapshot and pre-deploy equality gate (T6);
    2. the state bucket is deleted only because T4 creates it;
    3. the leak check covers untracked files and the plan is anonymized;
    4. the Cloudflare MAIL FROM claim is softened and the negative TTL corrected to 15 min on Route 53;
    5. Route 53 MX value format (T1);
    6. the leave-mode limitation as one line;
    7. credentials spelled out;
    8. zone confirmation gate before T4;
    9. evidence recorded (T7).
  - **Complexity review (round 1), Not clear, both findings accepted:**
    - DEX-001: no leave-mode procedure and no README zone explanation;
    - DEX-002: the state bucket is deleted once.
