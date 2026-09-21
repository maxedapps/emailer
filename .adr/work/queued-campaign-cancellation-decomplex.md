# Decomplex review: queued campaign cancellation

## Overall status

Clear — no potential complexity findings in the structural draft or the corrected final plan.

## Review contract

| Axis | Selection |
| --- | --- |
| Mode | Prevention |
| Target | [Implementation plan](queued-campaign-cancellation.md) and [proposed ADR-0016](../0016-cancelling-pending-campaign-runs.md) |
| Authority / required behavior | User requested a detailed plan for queued cancellation and prefers clean, lean code; preserve recipient history, retry safety and generation ownership |
| Scope | Necessity, maintenance cost and operational burden of the proposed mechanisms and validation |
| Report | `.adr/work/queued-campaign-cancellation-decomplex.md`; parent records the independent reader's chat-only review |

## Coverage

Inspected: plan/ADR, AGENTS.md, accepted ADRs 0008/0011/0013/0014/0015, DynamoDB/SQS/Scheduler/Alchemy wiki guidance, campaign commands and storage, transaction primitive, inline Scheduler adapter, stale-dispatch branch, integration support, test configuration and relevant tests.

Partial/skipped: API/CLI suites were sampled; no implementation, automated tests, live inventory, provider probes or new external research were performed. No reviewed targets were changed by the reviewer.

## Potential findings

**No potential complexity findings.** No candidate passed the complete admission gate. No user decision is outstanding from this review.

## Confirmed proportionate areas

- Retained tokens and expected-source conditions prevent stale first attempts across lifecycle cycles; transaction tokens prevent committed expressions from reapplying, including mutable run-baseline copies. These are distinct reachable hazards. The existing primitive avoids a new outcome-reconstruction protocol, and transactional cost is limited to commands on META.
- A coherent metadata control read replaces split ownership observations without adding another persisted model or state-machine framework.
- The concrete Scheduler factory owns AWS request construction and error translation, while domain functions retain sequencing. It supplies a real adapter test seam without another service hierarchy or application List/Get permissions.
- Generation names and post-create cleanup handle overlapping old/new handlers. Shared names would need coordination the provider deletion API does not express. Existing queue, role and stage group remain sufficient.
- A stale-wake diagnostic and scoped mapping gate provide live evidence unavailable from empty recipient rows, approximate queue counts or direct worker invocation. Sequential execution and finalizers contain the helper's burden.
- Domain, binding-transport, real DynamoDB and live queue tests observe different failure boundaries. Existing seams are reused; generic simulation machinery is excluded.
- Active interruption, run entities, client idempotency keys, automatic reconciliation and persistent-stage migration remain explicit separate decisions. The plan does not conceal those missing guarantees.

## Parent disposition and correction check

Accept the Clear structural assessment. Correctness finding R1 adds only the existing pausedReason field to the control read, an expected-destination classification and its regression. This is required to preserve the cancellation guarantee and does not add a new mechanism. The original reviewer confirmed Clear on the corrected plan on 2026-09-17, including T5's one-shot hook, scoped timeout and accurately labelled seeded-history refinements. No findings or user decisions were added.

## Limitations

Complexity review does not establish runtime correctness or implementation acceptance. ADR-0016 remains Proposed and all implementation/live tasks remain pending.
