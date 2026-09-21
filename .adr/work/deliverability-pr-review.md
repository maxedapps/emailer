# Code review: PR #3 — Aligned MAIL FROM, SPF and DMARC for `mail.example.com`

## Review constraints

| Axis             | Selection                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target           | GitHub PR #3, branch `deliverability`, commit `425ec20` on top of `main` (`cb73c3a`)                                                                    |
| Baseline         | Plan-backed: `.adr/work/deliverability.md` (T1–T4, Final acceptance, Handoff) and ADR-0010 (Accepted)                                                   |
| Scope            | Full PR: code, docs, ADR lifecycle edits, work document, plus the live state the PR claims (SES identity, DNS, delivered headers, `test-a` teardown)    |
| Invocation       | Standalone, requested by the user on 2026-09-15                                                                                                         |
| Output           | This report in the main checkout; the PR branch and worktree were not modified                                                                          |
| Dimensions       | Plan compliance, correctness of the stack change, documentation accuracy and reproducibility, ADR conventions, live evidence                            |
| Validation/tools | Read-only AWS CLI (SES, Route 53, Lambda), `dig @8.8.8.8`, the operator mailbox CLI message source, `git grep` on the branch, CI status; one independent reviewer lane |
| Writes/artifacts | `.adr/work/deliverability-pr-review.md` only                                                                                                            |

## Summary

The PR implements the plan line for line. The stack change is the two specified props and nothing else; Alchemy applied it as one in-place update, the DKIM key timestamp is unchanged, and `MailFromDomainStatus` is `SUCCESS`. All seven retained records resolve publicly with the planned values. The delivered gate message, re-read from the operator mailbox archive, carries `spf=pass` on the bounce subdomain, `dkim=pass` for `mail.example.com` with the unsubscribe headers signed, and `dmarc=pass`. No `test-a` resource remains. CI is green and the PR is mergeable.

One material finding: the README's rewritten one-time setup procedure tells a new operator to deploy the shared stack first and publish the records afterwards, which is the order the plan, ADR-0010 and the wiki sentence added in this same PR forbid, because SES's first MX probe can negative-cache a missing record for a day. It is a documentation fix of a few sentences. Two clerical leftovers are listed for the same fix commit.

## Coverage

### Inspected

- Full `git diff main...origin/deliverability` (10 files), the work document and the implementer's review report on the branch (the latter as a claim, not evidence).
- `stacks/sending-identity.ts` against `node_modules/alchemy/src/AWS/SES/EmailIdentity.ts` (`diff` replaces only on identity-name change; `putEmailIdentityMailFromAttributes` in reconcile).
- Live: `GetEmailIdentity mail.example.com` (MAIL FROM `bounce.mail.example.com`, `SUCCESS`, `USE_DEFAULT_VALUE`, DKIM `SUCCESS`, key timestamp `2026-09-14T17:30:33`, Alchemy tags `EmailerSending/shared/EmailerSender`); Route 53 `Z00000000000000` record sets for `mail.example.com` (three DKIM `CNAME`s, MX, SPF TXT, DMARC TXT, TTL 1800); `dig @8.8.8.8` for MX, SPF, DMARC and the Cloudflare authorization TXT; SES configuration sets and Lambda functions (no `test-a` remnants).
- the operator mailbox message `in_c87e4714…` source: `Received-SPF: pass … envelope-from=…@bounce.mail.example.com`; `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=mail.example.com …; dmarc=pass header.from=mail.example.com policy.dmarc=none`; `DKIM-Signature d=mail.example.com` with `h=` including `List-Unsubscribe:List-Unsubscribe-Post`; `envelopeFrom` at the bounce subdomain.
- T4 greps re-run on the branch: no `only prop` / `Still open from ADR-0002` in ADR-0009, README, `.env.example`; no `three DKIM` in README.
- Worktree `~/worktrees/emailer/deliverability` at `425ec20`, clean.

### Skipped or partial

- `pnpm check` was not re-run locally; the CI `check` job on the PR head passed (run 34944229461).
- The Route 53 change-batch action (`CREATE`) and the Cloudflare record metadata were not re-observed; the resulting records were.
- The relative-link check was not re-run.

### Required boundaries

- The shared `EmailerSending/shared` stack is account-level state shared with the mass-sending lane; its deploy happened before this review and no `test-b` resources exist now. Merging the PR deploys nothing.

## Validation

- **Run:** the read-only live checks and greps above; independent reviewer lane (source and docs only).
- **Skipped/unavailable:** local `pnpm check`, link check.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** Specific and testable. Two gaps surfaced by the implementation: the plan's README task did not carry over the records-before-attribute ordering the plan itself depends on (F1), and its stale-wording grep was scoped to three files and missed two ADR header lines that quote the wording it renamed (F2).
2. **Implementation compliance:** Complete on every task and every ADR-0010 decision, with one approved clerical deviation (retained-record count six → seven). One residual of that deviation remains in the plan's T4 change text.
3. **Implementation quality beyond the baseline:** The code change is minimal and provably an in-place update. The README procedure contradicts the diff's own wiki guidance (F1).
4. **Test and validation quality:** No unit tests are appropriate for a two-prop declaration. The live gate is the right proof and its evidence is now independently confirmed from the archived message and the live AWS and DNS state.

## Plan compliance matrix

| Authority item                                                                             | Expected evidence                                    | Implementation evidence                                                                            | Validation / test evidence                                                                                                                           | Status                         |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| T1 four records, API-only preflight, `CREATE`, go-ahead naming both zones                  | Records exist with planned values                    | Work doc T1 evidence (change id, Cloudflare record id, go-ahead)                                   | Route 53 listing and `dig @8.8.8.8` show MX, SPF, DMARC (`p=none`, `rua` the operator mailbox), authorization TXT `v=DMARC1`                                        | Complete                       |
| T2 two props, no other change, in-place update, DKIM untouched                             | Stack diff; `Plan: 1 to update`; timestamp unchanged | `stacks/sending-identity.ts:27-28`; outputs unchanged; Alchemy `diff` replaces only on name change | Live identity: MAIL FROM `SUCCESS`, `USE_DEFAULT_VALUE`, key timestamp `2026-09-14T17:30:33`, Alchemy tags present                                   | Complete                       |
| T2 no deploy while `test-b` in flight                                                      | Recorded check                                       | Work doc T2 evidence                                                                               | Not re-observable after the fact                                                                                                                     | Unverifiable                   |
| T3 live gate: five header assertions, `test-a` deploy/destroy                              | Delivered headers; empty inventory                   | Work doc T3 evidence                                                                               | the operator mailbox source re-read: `spf=pass` at bounce, `dkim=pass` d=mail.example.com, `dmarc=pass`, `h=` covers unsubscribe; no `test-a` config set or Lambda | Complete                       |
| T4 ADR-0010 `Accepted:` date and Confirmation paragraph                                    | Header + paragraph                                   | ADR-0010 `:5`, `:48`                                                                               | —                                                                                                                                                    | Complete                       |
| T4 ADR-0002 header line, body unchanged                                                    | One header line                                      | ADR-0002 `:6`; diff is one line                                                                    | —                                                                                                                                                    | Complete (F2 residual on `:7`) |
| T4 ADR-0009 `Extended by`, `:47` pointer, `:49` reword, `:29` kept                         | Those edits only                                     | ADR-0009 `:8`, `:48`, `:50`; `:30` unchanged                                                       | Grep clean                                                                                                                                           | Complete                       |
| T4 README section: all records with values and zones, readiness checks, bounce rule        | Rewritten section                                    | README `:178`, `:184-190`, `:197`                                                                  | Grep clean                                                                                                                                           | Complete (F1 on ordering)      |
| T4 README teardown sentence                                                                | "its DNS records in both zones"                      | README `:255`                                                                                      | —                                                                                                                                                    | Complete                       |
| T4 `.env.example:11` reword                                                                | New wording                                          | `.env.example:10-12`                                                                               | —                                                                                                                                                    | Complete                       |
| T4 wiki deliverability and ses edits                                                       | Stated facts                                         | `wiki/aws/deliverability.md:12-14, 18, 20, 28`; `wiki/aws/ses.md:105`                              | Facts match ADR-0010 and RFC 7489 §7.1                                                                                                               | Complete                       |
| End state: one retained identity with verified MAIL FROM; seven records; no `test-a` stage | Live reads                                           | —                                                                                                  | All three confirmed live                                                                                                                             | Complete                       |
| Out of scope: no app or Emailer stack change, no Route 53 resources, no policy tightening  | Absence                                              | Diff touches only the ten listed files; DMARC stays `p=none` without `aspf`/`sp`                   | —                                                                                                                                                    | Complete                       |

### Approvals and conflicts

- **Approved deviation:** retained-record count corrected from six to seven (ADR-0010 Consequences, plan End state, Handoff). Residual: the plan's T4 change text still says "list all six records".
- **Authority conflict:** none.

## Findings

### S2 / C3 — README one-time procedure publishes the MAIL FROM records after the deploy that makes SES probe them

- **Dimension / authority:** documentation reproducibility; plan Approach ("Publish the records first, so that SES's first MX probe and every external resolver see them"), T2 "Depends on: T1", ADR-0010, and the wiki sentence added in this PR ("Publish MAIL FROM records before SES or a public resolver probes them").
- **Location:** `README.md:178` on the branch: "Deploy `stacks/sending-identity.ts` at `--stage shared` … Then publish the records below."
- **Impact:** the section is the one-time procedure per AWS account and Region, and ADR-0009 anticipates a separate production account. An operator following it deploys the stack with `mailFromDomain` set before the MX exists. SES's first probe can receive NXDOMAIN, which the zone's negative TTL lets resolvers hold for up to a day, leaving `MailFromDomainStatus=PENDING`. `USE_DEFAULT_VALUE` keeps mail flowing unaligned meanwhile, so the cost is a delayed setup, not lost mail. This project already spent a day on the same trap during the DKIM slice.
- **Evidence:** the two quoted lines are in the same diff; the DKIM `CNAME`s are the only records that genuinely need the deploy first, because their tokens come from `GetEmailIdentity`.
- **Confidence:** C3 for the contradiction; the delay length depends on the resolver, as the plan records.
- **Condition:** any fresh account or Region setup.
- **Validation state:** not exercised; the live setup on this account happened in the plan's order.
- **Smallest safe fix:** split the one-time step into three ordered sentences: publish the MX, SPF TXT, DMARC TXT and the authorization TXT; deploy the shared stack; then publish the three DKIM `CNAME`s from `GetEmailIdentity`. Keep the readiness sentence as is.

## Context-dependent concerns

- **Concern (F2, clerical):** two header lines still carry wording this PR retired. ADR-0010 `:7` quotes `("Still open from ADR-0002")` as ADR-0009's heading, which T4 renamed to "SPF and DMARC"; ADR-0002 `:7` ends "the rest are not discharged yet" directly under the new "Obligations discharged in part" line. The plan's grep was scoped to three files and could not see them.
- **Disposition:** fix in the same commit as the S2 finding; both are header text, so in-place correction is allowed by the ADR conventions. Also correct "list all six records" in the plan's T4 change text.
- **Concern (F3, rejected):** the README hardcodes `us-east-1` in the MX target while saying "in the same Region as the Emailer". Rejected: the README documents this deployment's concrete values throughout, and the wiki carries the generic `<region>` form.
- **Concern (rejected):** the reviewer noted that the Mailer's From check accepts any subdomain of the identity, so a From at a deeper subdomain would find no DMARC policy. Pre-existing, outside this PR, and `.env.example` already requires the From to be at the identity.

## Confirmed-good areas

- The `mailFromDomain` derivation `bounce.<identity>` is correct for SES, which requires a subdomain of the verified identity.
- ADR lifecycle edits follow the conventions: one header line each in ADR-0002 and ADR-0009, ADR-0009's rationale bullet kept, ADR-0010's Consequences count corrected in place as clerical.
- The operator mailbox was used once, for the gate message, as the constraint requires.
- The DMARC record has no `aspf=s` and no `sp`, so relaxed alignment holds and nothing tightens.

## Limitations and caveats

- The Route 53 change action and the "no `test-b` deploy in flight" check are historical and could not be re-observed.
- `pnpm check` was taken from CI, not re-run locally.

## Next steps

1. Apply the README ordering fix and the two clerical header corrections on the `deliverability` branch, then merge. No further review round is needed for a wording change.
2. After merge: delete the worktree and branch, and keep watching for the first DMARC aggregate report at the operator mailbox.
