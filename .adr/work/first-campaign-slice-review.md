# Independent correctness review: First campaign slice

## Contract and coverage

- Target: [implementation plan](first-campaign-slice.md) and [ADR-0001](../0001-resource-owning-effect-services.md).
- Authority: user-approved first slice and capability ownership, repository `AGENTS.md`, create-plan quality checklist and behavior-focused test guidance.
- Baseline: `bf4a26b` plus planning documents. The independent reviewer had read-only access; the parent alone changed the plan.
- Inspected: complete drafts, repository configuration, relevant wiki, installed Alchemy beta.77 / Effect RC112 / Distilled RC9 source, and documented Alchemy command flags.
- Review question: if implemented literally and every named check passes, could the intended result still fail?
- Excluded: implementation review, actual application tests, AWS calls, deployments and production certification.

## Round 1 findings and parent dispositions

### PC-001 — P2 — HTTP router lifetime

`HttpRouter.toHttpEffect` requires a construction Scope and returns a handler requiring an invocation Scope. The first draft did not resolve whether routing was constructed at initialization, inside a transient scoped region, or per request. Returning a handler from an already-closed scoped region could invalidate its dependencies; promoting request state to initialization could leak state across invocations.

**Disposition: Accept.** The plan now captures resource-backed capabilities/config at initialization and explicitly constructs and executes routing inside the request Scope, supplying captured values. Its API tests check finalizer timing and isolation across consecutive invocations. No resource-owning Layer is rebuilt inside the request.

Evidence: `effect/src/unstable/http/HttpRouter.ts` (`toHttpEffect`); `alchemy/src/AWS/Lambda/Function.ts` (per-invocation context/scope).

### PC-002 — P2 — Credible live persistence test seam

The initial reference to a generic test runtime context was insufficient: a production Layer that declares resources cannot simply be treated as an ordinary SDK client. A test could duplicate transaction logic and therefore fail to protect the production implementation.

**Disposition: Accept.** A small same-module `makeStorageOperations` accepts bound DynamoDB primitives. Production and live fixtures execute the same codecs, conditions and operation logic. The live fixture targets the recorded physical test table and only adapts transport/table-name binding. No second persistence implementation, fake infrastructure runtime or public test endpoint is added.

Evidence: wiki runtime/binding construction guidance; pinned `TransactWriteItemsHttp` and its bound table-name contract.

### PC-003 — P2 — Explicit log-retention resource

The plan required finite log retention, but beta.77's Lambda resource has no retention property. Lambda's auxiliary deletion of its conventional group does not configure retention.

**Disposition: Accept.** `Api.ts` owns an `AWS.Logs.LogGroup` with seven-day retention, matching the Lambda's conventional group name and an explicit readiness/dependency relationship. Live validation checks retention and ownership-aware teardown. Complexity triage accepted the additional resource as a proportionate implementation of the requirement.

Evidence: `alchemy/src/AWS/Logs/LogGroup.ts` (`retention`); Lambda provider props and log cleanup implementation.

### Version-specific body limit warning

RC112's Web Request `.text` / `.arrayBuffer` path does not enforce MaxBodySize merely because that reference is provided. The API must explicitly bound reads, including without Content-Length.

**Disposition: Accept clarification.** The plan now specifies explicit bounded reading, 413, and a no-Content-Length test through the actual HTTP/native adapter path. This refines an existing body-limit requirement rather than adding scope.

## Round 2 closure

The same independent reviewer re-read the entire revised plan and checked the changes against the previously inspected pinned sources. Result: **Clear**. PC-001, PC-002 and PC-003 are addressed, with no unresolved material findings. The CLI native-TypeScript and body-limit clarifications were also checked.

The parent's final edits after closure only changed readiness/handoff metadata, linked these reports and made the already-required manifest-to-lockfile installation command explicit. No behavior or architecture changed after review closure.

## Limits

This is a reviewed implementation handoff, not evidence of an implemented or deployed service. The test paths and commands describe future work. Actual runtime, SES acceptance/delivery and cleanup remain required implementation acceptance evidence.
