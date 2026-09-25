# ADR-0001: Resource-owning Effect services

- Status: Accepted
- Date: 2026-09-11
- Superseded in part: [ADR-0009](0009-account-level-sending-identity.md) for two clauses: "Keep one root `alchemy.run.ts`" (the identity now has its own stack) and the SES identity's placement in `Mailer.ts`. `:19` already allows "a small separate resource module … if a concrete shared ownership need arises", which this is. `Mailer.ts` still owns the service, configuration set, send binding and implementation.
- Superseded in part: [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md) for "immediate plain-text submission to one allowlisted recipient".
- Amended: [ADR-0020](0020-drafts-previews-and-test-sends.md) — the backend's capabilities are grouped into concern folders (`api`, `audience`, `campaigns`, `consent`, `feedback`, `identity`, `sending`, `storage`), and every function builds its services once from a Live layer. Resource ownership by module is unchanged.
- Authority: The user accepted the capability-oriented Alchemy design and requested its implementation plan. Acceptance covers the architecture, not implementation or production deployment.

## Context

Emailer will expose an AWS SES email service through a CLI and later MCP. The initial scaffold reserved separate infrastructure, domain and AWS directories. That division does not express the chosen Alchemy Infrastructure as Effects model well: service implementations should carry the resources, permissions and runtime operations they need.

## Decision

- Keep one root `alchemy.run.ts` for Stack name, AWS providers/state, application composition and non-secret outputs.
- Organize backend code by capability. `Storage/` owns its Effect service, DynamoDB table, operation bindings and persistence implementation. `Mailer.ts` owns its service, SES identity/configuration set, send binding and implementation. `Api.ts` owns the Lambda declaration and its HTTP runtime composition.
- Keep application operations alongside these modules. Introduce service boundaries for meaningful capabilities and test substitution; do not require one service class per function or a generic repository framework.
- Preserve construction versus invocation phases. Construction discovers resource requirements and initializes capabilities; contact writes and email submissions only run inside application operations invoked by a handler.
- Reuse resource declarations and Layer values with stable logical identities. One shared table has one owner. Backend-only sharing remains within the backend app.
- Keep `packages/api` limited to the shared HTTP schemas, contract and client. CLI/MCP consumers do not import the Lambda, backend implementations or Stack.
- Retire the empty `infra/` and the unused horizontal backend placeholders when implementation begins. A small separate resource module remains valid if a concrete shared ownership need arises; this is not a universal folder prohibition.

## Alternatives considered

**Central `infra/resources.ts` plus separate adapters:** supported by Alchemy, but separates changes that belong to one capability and adds manual composition across that division.

**Everything in `alchemy.run.ts`:** valid for tiny examples, but couples the Stack entry point to application operations and makes the CLI/shared-contract boundary harder to preserve.

**A package per capability:** unnecessary for backend-only code; contrary to the user's package ownership rule.

## Consequences and confirmation

Providing a production service Layer adds its resource and binding requirements to the Stack. Tests can supply an alternative implementation without creating AWS resources. Moving service files must preserve logical IDs; resource removal and test cleanup still require explicit lifecycle policy. Built/deployed runtime checks remain necessary because types and mocked services do not prove cloud wiring.

The first slice remains contact → list membership → campaign → immediate plain-text submission to one allowlisted recipient. Its task and validation details live in the implementation plan (`work/first-campaign-slice.md`, in git history).

## References

- [Alchemy Infrastructure as Effects](https://alchemy.run/infrastructure-as-effects/)
- [Alchemy Layers](https://alchemy.run/infrastructure-as-effects/layers/)
- [Alchemy file layout](https://alchemy.run/project-structure/file-layout/)
- [Alchemy phases](https://alchemy.run/infrastructure-as-effects/phases/)
- [Official AWS storage example](https://github.com/alchemy-run/alchemy/blob/main/examples/aws-lambda/src/JobStorage.ts)
- [Alchemy runtime](https://alchemy.run/infrastructure-as-effects/runtime/) and [bindings](https://alchemy.run/infrastructure-as-effects/binding/)
- [ADR-0002: Domain sending identity with Easy DKIM](0002-domain-sending-identity.md), which records the sending identity deviation found while implementing this slice
