# ADR-0048: Configurable DMARC policy, Cloudflare report handling and the From domain's SPF

- Status: Proposed
- Date: 2026-11-26
- Authority: On 2026-11-26 the user chose to move the domain's DMARC policy towards enforcement. They chose:
  - aggregate reports go to Cloudflare DMARC Management instead of a mailbox, declared with Alchemy;
  - the identity stack also owns the From domain's own SPF record;
  - the policy stays `p=none` for now, and each step to `quarantine` and `reject` waits for their go.

  See the plan ([0048-dmarc-enforcement-and-cloudflare-reports.plan.md](0048-dmarc-enforcement-and-cloudflare-reports.plan.md)).
- Supersedes in part:
  - [ADR-0018](0018-optional-dns-management.md): `EMAILER_DMARC_REPORT_EMAIL` and its fixed `p=none` record.
  - [ADR-0017](0017-adopted-root-domain-sending-identity.md): the mailbox as the report destination.
- Preserves: ADR-0018's opt-in DMARC (only with `EMAILER_DNS`, only on request), its retained records and its rule that a setting nothing would publish fails construction.

## Context

The DMARC record at the organizational domain reported to a shared mailbox, as ADR-0017 chose. Its 20–40 aggregate reports a day landed among real mail, and nobody read them.

- **`rua` is optional** (RFC 9989 §4.7). Mailbox providers' bulk-sender rules require a DMARC record with `p=none` or stricter, not reports.
- **The reports have one use:** they show who sends as the domain, so `p=none` can safely move to `quarantine` and `reject`. That blocks spoofing of the domain and is a precondition for BIMI. Only enforcement makes them worth receiving.
- **emailer hardcoded `p=none`.** The policy could not move without code.
- **On a root domain, the mailbox provider sends as the From domain too.** With no SPF record at the apex, its mail passed DMARC on DKIM alone. Under enforcement, a lapse in that signature would reject the domain's own mail.
- **Cloudflare DMARC Management** is free on Cloudflare DNS. It receives the zone's reports and shows each sending source. Alchemy 2.0.0-beta.87 declares it as `Cloudflare.Email.DmarcReports`, whose `ruaPrefix` names the report address `<prefix>@dmarc-reports.cloudflare.net`. Enabling it makes Cloudflare add that address to the existing `_dmarc` record, or create one where none exists. It works only on a zone apex. Cloudflare publishes the external-destination authorization record (RFC 9990 §4) for the zones it serves.

## Decision

- **`EMAILER_DMARC_REPORTS`** replaces `EMAILER_DMARC_REPORT_EMAIL` and still opts into the DMARC record.
  - A mailbox address sends the reports there.
  - `cloudflare` (only with `EMAILER_DNS=cloudflare`) makes the identity stack declare `Cloudflare.Email.DmarcReports` for the zone. The DMARC record waits for its `ruaPrefix` and then writes the whole value with Cloudflare's address alone. The stack stays the record's only owner.
- **`EMAILER_DMARC_POLICY`**, `none` (default), `quarantine` or `reject`, sets `p=`. Moving the policy changes one setting and redeploys the identity stack.
- **`EMAILER_IDENTITY_SPF`** publishes the From domain's own SPF record, its value verbatim from the configuration. The value names the operator's mailbox provider, so it stays out of the repository. SES keeps its own SPF at `bounce.<identity>`.
- **A setting nothing would publish dies at construction** (`IgnoredDnsSetting`): reports or SPF without `EMAILER_DNS`, a policy without reports, Cloudflare reports outside a Cloudflare zone.

Cost: Cloudflare DMARC Management and DNS records are free. No AWS resource, invocation or log line is added (ADR-0032).

## Alternatives

1. **Drop `rua`.** The simplest option that works: no reports, nothing to receive. Rejected because the user wants enforcement, and enforcing blind risks rejecting the domain's own mail.
2. **A mailbox filter** that labels or deletes the reports. Rejected: the mailbox also receives real mail, and the reports would still go unread.
3. **A receiver inside emailer** (SES inbound to S3 and a parsing Lambda, or an Email Worker). It adds resources, code and running cost for data Cloudflare parses for free. Rejected under ADR-0032.
4. **A hosted DMARC service.** It adds an external account and vendor for one domain. Rejected.
5. **Let Cloudflare own the `_dmarc` record.** The policy would then move in Cloudflare's dashboard, outside the stack. Rejected: Alchemy is the single source of truth.
6. **The apex SPF in the website's stack.** That stack owns no DNS records, and the SPF only matters to the DMARC policy that lives here. Rejected by the user.

## Consequences

- **A domain without a DMARC record** cannot switch on Cloudflare reports in the same deploy that creates the record. Cloudflare would create its own record first, and a second TXT would appear beside it. Deploy once with a mailbox address, then switch to `cloudflare`. The README says so.
- **Disabling** (removing `cloudflare`) leaves DMARC Management enabled, since the resource is retained like every record, until it is turned off in a deploy that declares it with `enabled: false`. No such step exists yet, and none is needed until someone leaves Cloudflare.
- **Enforcement steps** are operational: two weeks at `none` with Cloudflare's data, then `quarantine`, then `reject`, each confirmed by the user.
- **Readiness** is proven on the live zone: one DMARC record at the authoritative nameservers with Cloudflare's address, DMARC Management `enabled` with no `status`, and reports in its dashboard within a day.

## References

- [RFC 9989: DMARC](https://www.rfc-editor.org/rfc/rfc9989), §4.7 tags
- [RFC 9990: DMARC aggregate reporting](https://www.rfc-editor.org/rfc/rfc9990), §4 external destinations
- [Cloudflare DMARC Management](https://developers.cloudflare.com/dmarc-management/)
- [Cloudflare: Enable DMARC Management](https://developers.cloudflare.com/dmarc-management/enable/)
- [ADR-0018: Optional DNS management](0018-optional-dns-management.md)
