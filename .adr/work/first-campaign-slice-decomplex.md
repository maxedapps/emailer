# Decomplex review: First campaign slice

## Overall status

**Clear — no potential complexity findings.** The initial workflow remains narrow; its concurrency and uncertainty handling protect reachable failures involving irreversible email submission.

## Review contract

| Axis              | Selection                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Mode              | Prevention, followed by bounded finding triage of correctness-review changes                                                   |
| Target            | [Implementation plan](first-campaign-slice.md), [ADR-0001](../0001-resource-owning-effect-services.md)                         |
| Authority         | User-approved capability-owned Alchemy/Effect architecture and first contact/list/campaign/plain-text send; `AGENTS.md`        |
| Required behavior | Authenticated CLI/shared API, one allowlisted recipient, immediate submission, honest persisted outcomes and ephemeral cleanup |
| Scope             | Conceptual, maintenance and operational complexity while preserving trust boundaries and realistic concurrency                 |
| Ownership         | Independent read-only reviewer returned findings in chat; parent owns this saved report and plan dispositions                  |

## Coverage

Inspected the complete initial plan/ADR, repository instructions, full decomplex gates/template and ADR conventions, plus relevant wiki auth and Alchemy runtime guidance. After revision, re-inspected the constraints, lifecycle, T2, T5 and T8 changes.

No implementation exists to audit. This review did not independently certify every library API, run tests, deploy resources or mutate files/VCS.

## Potential findings

**No potential complexity findings.** No candidate met all admission gates for unnecessary burden, realistic cost, and a simpler alternative preserving required behavior.

## Confirmed proportionate areas

- Storage, Mailer and API represent real resource/runtime capabilities. There are no pass-through service classes, generic repositories or backend-only packages.
- Membership version protects the exact-one-member invariant against a concurrent addition between enumeration and claim, without adding a locking service or retry loop.
- Durable claim and unconfirmed status cover concurrent commands, lost responses and crashes without leases, expiry, reconciliation or resend machinery.
- Separate campaign and recipient records implement the agreed model. Campaign metadata is the authoritative public status and terminal changes are transactional.
- The SDK transport test establishes that one application send does not conceal automatic retries. A mocked mailer cannot supply this evidence.
- Schema, persistence, orchestration, HTTP, actual CLI-process and AWS checks protect different boundaries; extra per-operation tests are limited to distinct protection.
- Dedicated test identity ownership and cleanup protect existing AWS resources and satisfy the repository's ephemeral-stage requirement.
- No queue, outbox, scheduler, tracking destination, generalized identity-adoption mode, migration system or MCP implementation is introduced.

## Finding-triage matrix

| Finding                              | Reviewer recommendation | Parent disposition and rationale                                                                                                                        |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PC-001: request Scope                | Act                     | Accept: explicit request lifetime avoids resource Layer reconstruction and needs no lifetime framework                                                  |
| PC-002: production Storage test seam | Act                     | Accept: a same-module operation factory is simpler and more faithful than a fabricated Alchemy runtime or duplicated persistence logic                  |
| PC-003: LogGroup retention           | Act                     | Accept: one Api-owned LogGroup implements finite retention and gives cleanup an explicit owner, without a logging subsystem or infrastructure directory |

Deferring log retention would remove a declaration but retain implicit group creation and cleanup obligations, and retract the existing finite-retention requirement. Keep its naming/dependency local to Api. Keep the Storage factory narrow; do not turn it into an adapter registry or new package.

## Closure and limitations

The independent reviewer returned **Clear** after the bounded triage. No user-decision queue or unresolved complexity finding remains. This is a complexity assessment rather than a runtime/cloud correctness certification. Module splitting remains flexible as long as capability ownership and required behavior are preserved.
