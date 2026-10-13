# Plan: Only account-wide signals halt sending

- Status: Implemented
- Decision: [ADR-0036](0036-only-account-wide-signals-halt-sending.md)

## Goal

**Done when:** `SendGuard` binds only the two account-wide alarms; the set-level alarms still exist and notify the alert topic; the live alarm test proves both halves; README and ADR-0012 say so; landed on `main` through `pnpm leak-check && pnpm gate` (one whole live run, approved by the operator).

**Out of scope:** the prod deploy and resetting `SetComplaintRate` in prod (later, separate go); thresholds; the breaker; bot checks on sign-up forms.

## Rules for every task

- Worktree `~/worktrees/emailer/task-905-account-wide-halt`, branch `task-905-account-wide-halt`; logs in `~/tmp/t905/`.

## Tasks

### T1 — Two alarm groups (`apps/backend/src/sending/Reputation.ts`)

- Replace `reputationAlarms` with `accountReputationAlarms` (`AccountBounceRate`, `AccountComplaintRate`) and `setReputationAlarms` (`SetBounceRate`, `SetComplaintRate`), each `Effect.all` over its two. Resource ids, props and thresholds unchanged, so no alarm is replaced.
- Doc comments say which group halts and which warns.

### T2 — The guard binds the account-wide group (`SendGuard.ts`, `SendGuard.test.ts`, `packages/api` comments)

- `DescribeAlarms` binds `accountReputationAlarms` only; the comments name the account-wide alarms.
- Unit test "any of four metric alarms" becomes "either account-wide alarm" with two states.
- `packages/api/src/Errors.ts`, `Api.ts`: comments say "account-wide reputation alarms".

### T3 — Stack and live test (`alchemy.run.ts`, `apps/backend/test/IntegrationSupport.ts`, `Live.integration.test.ts`, `src/api/Api.live.ts`)

- The stack yields both groups and outputs `accountBounceAlarmName` and `setBounceAlarmName`.
- `Deployment` carries both names.
- `detachAlarm` (test support) points an alarm at a metric nobody publishes, so a forced state holds: `SetAlarmState` lasts only until the next evaluation (within a minute) when the metric has readings, and the account's has them whenever it sends real mail.
- The alarm test detaches `AccountBounceRate`, forces it and `SetBounceRate` to `ALARM`, sees the campaign pause with `reputation`, resets only `AccountBounceRate`, resumes, and sees the campaign complete with `SetBounceRate` still in `ALARM` (asserted). `Effect.ensuring` resets both.

### T4 — Docs (`README.md`, `.adr/0012-reputation-guardrails.md`)

- README: the List hygiene feature line, the `reputation` pause reason and the alarm table say only the account-wide alarms (and an SES review) halt; the set-level ones mail a warning.
- ADR-0012: an `Amended:` line pointing at ADR-0036.

### T5 — Verify

- `pnpm check` (log `~/tmp/t905/check.log`); `SendGuard.test.ts`.
- Manual on a fresh `pnpm stages up` stage: force `SetComplaintRate` to `ALARM`, a test send to a simulator address goes out; detach and force `AccountComplaintRate` to `ALARM`, the next test send (which reads `current`, uncached) is refused with `SendingPaused` `reputation`; reset both, `pnpm stages down`.
- `pnpm leak-check && pnpm gate` on the merged result (reaches all groups).

## Evidence

No UI: key files and snippets from the landed commit (`Reputation.ts` groups, `SendGuard.ts` binding, the live test's alarm steps).

## Cost

None: the same one `DescribeAlarms` call per check, the same four alarms, topic and IAM grant; no DynamoDB, GSI, Lambda, SQS or Logs change at equal traffic.

## Open questions

None.
