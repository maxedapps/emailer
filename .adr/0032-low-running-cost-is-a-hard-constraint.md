# ADR-0032: Low running cost is a hard constraint

- Status: Accepted
- Date: 2026-10-03
- Authority: The user, on 2026-09-24: no code simplification or improvement may be adopted if it leads to higher cost in the end. Recorded in the repository on 2026-10-03.
- Generalises: the "no change may raise running cost" constraint of [ADR-0024](0024-typed-errors-and-cost-neutral-storage.md), from one refactor to all work.

## Context

- **A cheap, self-hosted SES service is the point of the project.** Its value over a hosted mailing service is the bill.
- **Most of the stack bills per use:** on-demand DynamoDB, Lambda, SQS, EventBridge and CloudWatch Logs. A small change per call or per contact multiplies with every send and import.
- **AGENTS.md also asks for the cleanest solution and welcomes big refactors.** Without a rule, a cleaner design that costs more could win.

## Decision

1. **Low running cost outranks code elegance.** When the cleanest design and the cheapest one differ, the cheaper one wins.
2. **DynamoDB stays.** No move to a relational database.
3. **Every proposed change states its steady-state cost effect** on:
   - DynamoDB read and write units, GSI writes and storage;
   - Lambda invocations and duration;
   - SQS requests, including Lambda's idle long polling of each queue;
   - CloudWatch Logs volume.
4. **A change that costs more in steady state is withdrawn,** even by cents.
5. **Billing facts to apply** (DynamoDB):
   - a read of a missing item still consumes read units;
   - a canceled transaction still consumes write units;
   - updating an attribute projected into a GSI also writes that GSI;
   - `ReturnValues` and `ReturnValuesOnConditionCheckFailure` consume no capacity.

## Consequences

- Every ADR, plan and review states its cost effect, as ADR-0024 to ADR-0031 already do.
- Refactors remain welcome when they are cost-neutral or cheaper.
