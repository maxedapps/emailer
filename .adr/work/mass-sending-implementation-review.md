# Code review: mass-sending implementation

## Review constraints

| Axis             | Selection                                          |
| ---------------- | -------------------------------------------------- |
| Target           | branch `mass-sending` vs `main` (`cb73c3a`)        |
| Baseline         | plan-backed: `.adr/work/mass-sending.md`, ADR-0011 |
| Scope            | full plan                                          |
| Invocation       | embedded in implement-plan                         |
| Output           | this report                                        |
| Writes/artifacts | parent dispositions only                           |

## Summary

Implementation matches the plan. One material defect (MS-1) was found on the designed budget-overrun path and fixed before merge: consume and budget-check now run before `claimRecipient`.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** Strong. One hole: T5 ordered claim before the limiter budget check, which combined with `already-claimed → continue` dropped a recipient on overrun.
2. **Implementation compliance:** Complete after MS-1 fix. Concurrent send may return `sending` (approved live deviation).
3. **Implementation quality beyond the baseline:** MS-1 was the only admitted finding.
4. **Test and validation quality:** Storage expression tests, Dispatching World/TestClock suite, and the test-b live gate (60 accepted, limiter item, ceiling, skips, DLQ 0, destroy) protect the contract. Live gate at MaxSendRate 26 did not hit overrun.

## Follow-up closure

- **Round 1:** Changes required — MS-1
- **Round 2:** Clear — MS-1 resolved
- **Resolved:** MS-1
- **Still material:** none

## Findings

### MS-1 — S2 — Budget-overrun continuation permanently skipped the claimed recipient

- **Disposition:** Fix now. Applied 2026-09-15.
- **Fix:** `runSlice` consumes a limiter slot and checks remaining time before `claimRecipient`. Overrun on N checkpoints at N−1 without writing `SEND#` for N. First-member overrun claims nothing and fails `SliceOverrun`.
- **Tests:** overrun claims only A; continuation slice submits B; first-member overrun claims nothing.
- **Re-review:** Clear.
