# Clean codebase plan review

- Date: 2026-09-14
- Target: [Implementation plan](clean-codebase.md)
- Scope: consequential design, implementation feasibility, complexity, sequencing, test sensitivity and deployed acceptance; plan only.
- Prior design-review verdict: **Clear after correction**.
- Stored-document consistency review: **Clear**; independent reader found no material corrections required.

## Evidence and independence

Independent reader tracks inspected consent/token alternatives, storage/capability/codecs, and feedback infrastructure/replay against the repository wiki, accepted ADRs, official sources and installed Alchemy 2.0.0-beta.77 / Effect 4.0.0-rc.112 source. The parent selected the final design. A fresh reviewer inspected the draft independently and performed a focused re-review after correction. No agent implemented code or deployed resources during research.

## Material finding and disposition

### R1 — Real failure envelopes contain a qualified function ARN

**Finding:** Alchemy exposes an unqualified Function.functionArn, while AWS's failure-destination example reports requestContext.functionArn ending in :$LATEST. Exact equality against only the stack output would reject real failures while passing simplified fixtures.

**Evidence:** pinned `AWS/Lambda/Function.ts` ARN construction; [AWS destination-envelope example](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html).

**Disposition: Accept.** T8 permits only the configured base ARN or that exact ARN plus :$LATEST, rejects other targets/qualifiers, and invokes the configured target rather than an ARN selected by the message. The test fixture includes the actual qualification and original failure metadata; the replay result is independently checked before acknowledgement.

**Closure:** focused independent re-review returned Clear. Integration file serialization and guaranteed concurrency restoration were also made explicit to prevent the failure-capture exercise interfering with other cases.

## Complexity dispositions

| Recommendation                                      | Disposition | Reason                                                                                 |
| --------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| Four cohesive storage services                      | Act         | Actual IAM boundaries and smaller test dependencies; conservative existing file layout |
| Small explicit replay command                       | Act         | Retention without usable recovery leaves the reliability change incomplete             |
| Plain diagnostic boundary helpers                   | Act         | Preserve actionable failures and safe API/CLI behavior without a logging framework     |
| Construct HTTP applications once                    | Act         | Pinned source supports independent instance construction and request scope             |
| Automatic replay workers, schedulers or checkpoints | Reject      | No current need; introduces more retry/lifecycle state                                 |
| Generic persistence framework or service per method | Reject      | Hides meaningful DynamoDB conditions and adds composition burden                       |
| Legacy token/migration handling                     | Reject      | User explicitly permits total development reset                                        |
| Queue-based bulk sender in this refactor            | Reject      | Separate feature; unnecessary for the current single-recipient slice                   |

## Saved-document verification

A fresh reader reviewed the saved plan and both proposed ADRs against repository and pinned source. It confirmed task dependency order, the 81-action import bound, RC112 CLI reporting semantics, HTTP and stage lifetimes, explicit destination permission, qualified-ARN replay validation, and deployed acceptance/cleanup. No additional findings were raised.

Parent checks confirmed T1–T9 each contain status, concrete changes, starting points, named test coverage, and verification commands; all relative Markdown links resolve. Only the four new planning documents were created. Formatting is checked with the repository's formatter before delivery.

## Verification limits

Review establishes a feasible plan, not correctness of an unimplemented change. Planned unit tests, effective deployed IAM inspection, real transaction conditions, destination capture/replay, cold starts, delivered-message inspection and cleanup remain required. The earlier passing 357-test baseline is not a post-refactor result.
