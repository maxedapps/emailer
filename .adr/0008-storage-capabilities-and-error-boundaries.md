# ADR-0008: Storage capabilities and error boundaries

- Status: Accepted
- Date: 2026-09-14
- Accepted: 2026-09-14
- Authority: The user requested a clean implementation plan and permits substantial refactoring and a full development reset. The user then requested implementation of [the plan](work/clean-codebase.md), which accepts this record.
- Supersedes: ADR-0005's exactly-one-Storage-tag choice; preserves ADR-0001's resource-owning capabilities and the single-table access paths.
- Superseded in part: [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md) for the `CampaignStore` binding table (claims/finalization without `UpdateItem`) and the API's use of the mailer.
- Superseded in part: [ADR-0012](0012-reputation-guardrails.md) for the `FeedbackStore` and `AudienceStore` capability rows.
- Amended: [ADR-0020](0020-drafts-previews-and-test-sends.md) — a sixth capability, `CampaignReader` (`GetItem` only), for the public preview function; the rate limiter's store is the fifth.
- Amended: [campaign-listing](work/campaign-listing.md) — CampaignStore binds all six table operations
- Amended: [codebase-cleanup](work/codebase-cleanup.md) — `Table.ts` also holds `allTableOperations`, the one six-operation binding that AudienceStore and CampaignStore, which both perform every operation, share; every narrower capability still binds its own

## Context

Every consumer currently constructs StorageLive and all six DynamoDB bindings. Alchemy registers permissions during construction, so the public unsubscribe function and feedback consumer receive unnecessary query, update, and delete capabilities. The same broad service requires unrelated test stubs and combines resource ownership, primitives, operation composition, and public-error translation.

## Decision

Keep one table and four meaningful capability services:

| Service          | Responsibility                                                         | DynamoDB bindings                                                     |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| AudienceStore    | Contacts, lists, membership/imports, audience and address-status reads | GetItem, BatchGetItem, PutItem, UpdateItem, Query, TransactWriteItems |
| CampaignStore    | Campaign persistence, claims/finalization, feedback reads              | GetItem, PutItem, Query, TransactWriteItems                           |
| FeedbackStore    | Conditional suppression and feedback writes                            | PutItem                                                               |
| UnsubscribeStore | Conditional mailbox unsubscribe writes                                 | PutItem                                                               |

The API provides the first two; event and public unsubscribe functions provide their specific writer capability. Each live Layer constructs only the bindings it needs.

Retain existing item-owner modules. Table.ts owns only the resource; Errors.ts owns internal storage failures; Primitives.ts owns independently constructible bounded operations. Audience.ts and Unsubscribe.ts are new capability owners. Existing Campaigns.ts and Feedback.ts own their respective services. Keep shared values in leaf modules to avoid composition cycles.

Application operations preserve internal storage and send causes. Entry-point adapters record sanitized diagnostics and translate failures into public responses or failed invocations. Storage errors do not depend on public HTTP schemas. Do not swallow feedback failures or claim successful unsubscribe before persistence.

## Alternatives considered

- **Pick from constructed StorageLive:** changes the TypeScript view after permissions have already been registered.
- **One service per entity or method:** adds composition overhead and fragments transactions spanning multiple entity types.
- **Three services named after consumers:** valid, but leaves audience management and campaign persistence as one growing administrative object. Four cohesive capabilities provide a useful separation without a large service hierarchy.
- **Generic repository/document framework or new table layout:** obscures meaningful conditional transactions and access paths; neither is needed for this cleanup.

## Consequences

API operations can share the same table while expressing smaller dependencies. Public unsubscribe and feedback lose unnecessary DynamoDB permissions. Unit tests substitute the actual capability under test instead of an entire application store.

The refactor changes internal service and error types, not the intended external API behavior except the separately planned removal of SendNotAttempted. No compatibility facade should remain after conversion. The existing sparse index, conditional transactions, consent policy, and acknowledged cascade race remain unchanged.

## Confirmation

Inspect generated and effective deployed IAM, including absence of DynamoDB get/query/update/delete permissions on writer-only functions. Preserve behavioral operation tests and conditional-write coverage. Verify logged internal classification plus safe public errors, failed feedback retry eligibility, and unsuccessful responses on failed unsubscribe writes.

## References

- [Implementation plan](work/clean-codebase.md), T2, T3, T6, and T9
- [ADR-0001](0001-resource-owning-effect-services.md)
- [ADR-0005](0005-contact-identity-and-membership-access-paths.md)
- [Alchemy Layers](https://alchemy.run/infrastructure-as-effects/layers/)
- [Alchemy runtime and bindings](https://alchemy.run/infrastructure-as-effects/runtime/)
- [Alchemy bindings](https://alchemy.run/infrastructure-as-effects/binding/)
- Installed `alchemy/src/AWS/DynamoDB/TransactWriteItemsHttp.ts` and `BindingHttp.ts`: permissions register before runtime callables are returned.
