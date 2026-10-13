# ADR-0036: Only account-wide signals halt sending; our own alarms warn

- Status: Accepted
- Date: 2026-10-13
- Accepted: 2026-10-13, after the plan review
- Authority: The operator approved the change on 2026-10-13 (task 905), after the configuration set's complaint alarm had halted every send for seven days.
- Amends: [ADR-0012](0012-reputation-guardrails.md)'s "The dispatcher gates every slice on alarm state and enforcement status": only the two account-wide alarms and the enforcement status gate it now.
- Plan: [0036-only-account-wide-signals-halt-sending.plan.md](0036-only-account-wide-signals-halt-sending.plan.md)

## Context

- **The guard halts on any of four alarms.** `SendGuard` binds `DescribeAlarms` to all four reputation alarms of ADR-0012 and refuses every send, campaigns, test sends and sign-up confirmations alike, while one is in `ALARM` or SES reports an enforcement status other than `HEALTHY`.
- **A set-level alarm cannot clear once it halts.** The alarms treat missing data as `ignore`, as AWS recommends. A halt stops our mail, so the configuration set's reputation metrics get no new readings, and its alarm stays in `ALARM` until someone resets it.
- **At our volume a few bad addresses trip it.** On 6 Oct a bot sign-up wave on a sign-up form sent confirmations to about 156 addresses nobody had asked for; 7 complaints put the set's complaint rate at 0.05 percent, its alarm's threshold. Every send, real sign-ups included, was refused for seven days. AWS paused nothing: the account stayed `HEALTHY`, its complaint rate at 0.059 percent.
- **AWS acts on the account, not the set.** Its review starts at 5 percent bounces or 0.1 percent complaints account-wide, which the account-wide alarms watch, and a review shows in `EnforcementStatus`.
- **The account-wide metrics stop too, a day later.** SES published account readings until about 24 hours after the halt (7 Oct), then none; mailbox-simulator sends add none. Emailer is today the account's only real sender.
- **The per-campaign circuit breaker (ADR-0012) already stops a list that bounces or complains,** within a slice, from the campaign's own counts.

## Decision

- **Only account-wide signals halt sending.** `Reputation.ts` declares the alarms in two groups: `accountReputationAlarms` (5 percent bounces, 0.1 percent complaints) and `setReputationAlarms` (2 percent, 0.05 percent). `SendGuard` binds `DescribeAlarms` to the account-wide group only, so a set-level alarm never reaches `sendGuard`. The enforcement status check stays.
- **Our own alarms warn.** The stack still declares both groups; every alarm keeps mailing `ALARM:` and `OK:` through the stage's alert topic. A set-level alarm can still stick in `ALARM` without readings; it then only stops repeating its warning, and sending goes on.
- **The breaker stays as it is.**
- **The live test forces an account-wide alarm** on its own stage to prove the halt, and keeps the set bounce alarm in `ALARM` while the campaign resumes and completes, to prove a set-level alarm halts nothing. The stack outputs both alarm names for it. A forced state lasts only until the alarm's next evaluation, within a minute, when its metric has readings, and the account's metric has them whenever the account sends real mail. The test therefore first points its stage's account bounce alarm at a metric nobody publishes (`detachAlarm`); the guard binds the alarm by name, so it still reads it. The set alarm's metric has no readings on a fresh stage, as before.

## Alternatives considered

1. **Reset the alarm by hand after each incident** (no change). Every incident would stop all sending, sign-ups included, until someone notices and resets it.
2. **Our own alarms treat missing data as `OK`** (`notBreaching`). They would clear in the first hour without mail and trip again on the next reading, flapping between halt and send and hiding a real problem behind the noise.
3. **Drop our own alarms.** Saves 0.20 USD a month but loses the early warning below AWS's review point.
4. **A minimum-volume metric-math alarm** that halts only when the set's rate is high and its volume large enough. More metrics per alarm cost more, against ADR-0032, and the threshold would be a guess at our volume.

## Consequences

- **No margin before AWS's review.** The account-wide complaint alarm fires at 0.1 percent, exactly where AWS starts its review; before, our set-level alarm halted at half that. The set-level mail is now the only earlier signal, and someone has to act on it.
- **An account-wide halt can stick the same way.** While emailer is the account's only real sender, a halt starves the account-wide metrics a day later, and the alarm stays in `ALARM` until someone resets it. That is accepted: it fires only at AWS's review point, where someone should look at the account before sending resumes. A `reputation` pause then needs the reset and `campaigns resume`, as before.
- **Sign-ups no longer stop for a bad form.** Bots on a sign-up form can push the set's rates up without halting real sign-ups; the form's own bot check, not the guard, is what stops them.
- **Cost: none.** The same one `DescribeAlarms` call per check, now naming two alarms instead of four; the same four alarms, topic and IAM grant. At equal traffic nothing else moves: no DynamoDB read or write, GSI write or storage, Lambda invocation or duration, SQS request (idle polling included) or CloudWatch Logs line is added or removed. The test's detached alarm lives only on the live run's own stage.

## Confirmation

`SendGuard`'s unit suite covers the mapping; the live suite's alarm test detaches and forces the account bounce alarm and keeps the set bounce alarm in `ALARM` through the resumed run. A manual check on a fresh stage forces the set complaint alarm and sees a test send go out, then detaches and forces the account complaint alarm and sees the next test send refused with `SendingPaused` `reputation`.

Observed 2026-10-13 on ephemeral stage `test-2610131149-b203`: with `SetComplaintRate` forced to `ALARM` a test send to the success simulator was accepted; with the detached `AccountComplaintRate` forced to `ALARM` the next one was refused with `SendingPaused` `reputation`; with the account alarm back to `OK` and the set alarm still in `ALARM` the next one was accepted. Stage destroyed after the check.

## References

- [ADR-0012: Reputation guardrails](0012-reputation-guardrails.md)
- [ADR-0032: Low running cost is a hard constraint](0032-low-running-cost-is-a-hard-constraint.md)
- [Amazon SES: Creating reputation monitoring alarms using CloudWatch](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboard-cloudwatch-alarm.html)
- [Amazon SES: Enforcement FAQs](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html)
