# Decomplex review: Aligned MAIL FROM, SPF and DMARC for `mail.example.com`

## Overall status

**No potential complexity findings.** The plan is two identity props, four hand-published records, one live proof and the record-keeping the ADR conventions require. Every candidate checked either protects an irreversible DNS write into a live zone, proves a distinct record, or follows a decision the user recorded.

## Review contract

| Axis                          | Selection                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode                          | Prevention                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Target                        | [`deliverability.md`](deliverability.md) (Ready for implementation, 2026-09-15) and [ADR-0010](../0010-aligned-mail-from-spf-and-dmarc.md) (Proposed)                                                                                                                                                                                                                                                                                              |
| Authority / required behavior | ADR-0010 Authority line: SPF and DMARC on `mail.example.com`, DMARC reports to the operator mailbox `dmarc@reports.example.net`. ADR-0009 (hand-published records, retained identity), memory `dns-changes-stay-in-scope`. Required behaviour is the plan's Outcome: a delivered message shows `spf=pass` at `bounce.mail.example.com`, `dkim=pass` and `dmarc=pass` for `mail.example.com`, under a `p=none` policy reporting to the operator mailbox |
| Scope                         | Structural choices, machinery, task count, tests and validation machinery, configuration surface, operational burden                                                                                                                                                                                                                                                                                                                               |
| Report                        | `.adr/work/deliverability-decomplex.md` (explicit path; the repository uses `.adr/`, not `adrs/`)                                                                                                                                                                                                                                                                                                                                                  |

## Coverage

### Inspected

- The full plan and ADR-0010; ADR-0002 and ADR-0009 in full (the obligations being discharged, the hand-published-records rule, the `INSYNC`/`dig` obligation); the memory records `dns-changes-stay-in-scope` and `mailbox-inbox-for-header-checks`.
- `stacks/sending-identity.ts` (the one declaration T1 edits), `node_modules/alchemy/src/AWS/SES/EmailIdentity.ts` (props at `:56-69`, `toAttributes` at `:199-211`, `diff` at `:275-284`).
- `.adr/work/sending-identity.md` T3 and T4 (the preflight and live-cycle precedents T2 and T3 reuse), `wiki/aws/deliverability.md`, the README "Sending identity" and teardown sections.

### Skipped or partial

- RFC 7489 sections and the SES MAIL FROM documentation were taken from the plan's citations, not re-read.
- The Cloudflare zone and Route 53 zone were not queried; no DNS, SES or deploy action was taken.

## Confirmed proportionate areas

- **T3's own deploy/send/destroy cycle.** The alternative — piggyback the header check on the mass-sending lane's `test-b` run — saves one ephemeral cycle of a few minutes but couples ADR-0010's acceptance to another lane's merge order and to a DNS wait of up to 72 hours, against the plan header's explicit lane independence. The cycle is the same shape that proved ADR-0009 (sending-identity T4) and is the only evidence the ADR's Confirmation accepts. Kept.
- **Four `dig` checks.** Four records in two zones, one resolver check each; each proves a distinct thing (the MX SES verifies, the SPF TXT SES does not verify, the DMARC policy, the cross-zone authorization). A loop would be style.
- **The preflight step in T2.** A hand write into two live production zones is irreversible in effect (ADR-0009 alternative 5 records silent overwrites; the memory records the 86400 s negative-cache trap). Confirming the names are empty before writing is the smallest protection and follows the sending-identity T3 precedent.
- **Explicit `mailFromBehaviorOnMxFailure: "USE_DEFAULT_VALUE"`.** The provider sends `undefined` when omitted and the SES API marks the field required (plan Research); declaring the default is one line that removes a runtime dependency on provider behaviour.
- **The one-line header comment in `stacks/sending-identity.ts`.** The file's header already holds the identity's operating rules; the bounce subdomain's "never a From address" rule belongs beside them.
- **Docs touched in T4.** ADR-0002 and ADR-0009 get lifecycle lines only, as the ADR conventions require when obligations are discharged; the README record list is what an operator rebuilding the setup needs; the two wiki edits correct a statement that is now wrong ("no MX") and record the values the project will reuse. Nothing is duplicated beyond the lifecycle links.
- **`p=none`, relaxed alignment, reports to the operator mailbox with the `_report._dmarc` authorization.** User decision plus RFC 7489 §7.1 requirement; no smaller design satisfies it.

### Evaluated and not admitted

- **Returning `mailFromDomain` as a stack output (T1).** `EmailIdentity`'s `toAttributes` exposes no MAIL FROM attribute, so the output would echo the derived prop `bounce.<identity>`, not observed SES state; the observation lives in `aws sesv2 get-email-identity`, which T1 already runs. It is one line and cannot mislead anyone who follows the README's readiness check, so it fails the proportionate-value gate. The implementer may drop it without loss.

## Limitations

- Static review only. Whether Alchemy plans the prop change as one `update` is asserted by the plan from `EmailIdentity.ts:275-284` and confirmed here by reading the same `diff`; it is proven only by T1's plan output.
- Routed to the defect/compliance reviewer, not judged here: T3 sends through the allowlisted single-recipient path that the mass-sending lane deletes, so the merge order of the two lanes decides which send path T3 actually runs; the plan's merge notes should say that either path satisfies the gate.
