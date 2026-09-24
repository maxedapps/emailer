---
project: Emailer
pr: PR #10
date: 17 Sep 2026
title: Scheduled campaigns need one input-validation fix
footer: Reviewed 0516864 against origin/main 9cd7e40. Fresh-install pnpm check passed. Cloud evidence is attributed to the implementation record; no deployment or merge performed during this review.
---

PR #10 lets an operator arrange a future campaign send using EventBridge Scheduler. This independent second opinion follows the send through its two storage systems, identifies one new defect missed by the earlier implementation review, and separates that defect from accepted operating risks.

> [!bad]
> **Verdict: changes required. Validate calendar dates before replacing a schedule.**
>
> **`ScheduleCampaignPayload` in `packages/api/src/Schemas.ts:319` accepts impossible dates.** A malformed reschedule can replace the campaign's run token and delete its working timer before the replacement fails. Require a real, canonical UTC instant and add router regressions that prove invalid input leaves the existing campaign and schedule untouched.
>
> The full local gate passed: **625 tests**, formatting, lint, types and import checks.

## 1. Where it started

Previously, `Campaigns.send` accepted a draft, wrote a fresh run token, and immediately queued a wake-up. There was no public operation accepting a send timestamp and no durable timer.

```ts caption="The previous Campaigns.send path"
case "draft": {
  const runToken = yield* newIdentifier;
  const outcome = yield* campaigns.enqueueCampaign(campaignId, runToken, now);
  if (outcome === "queued") {
    **yield* wake.enqueue(campaignId, runToken);**
  }
}
```

The existing `Timestamp` schema mostly described timestamps produced by the application. This PR makes it the validation boundary for an operator's scheduling instruction. That change in use is where the new defect enters.

## 2. Follow one scheduled campaign through

### Turn the operator's time into an API request {step}

`campaigns schedule <id> --at <instant>` converts its input to a UTC timestamp and calls the authenticated schedule endpoint. Input without a zone is interpreted as UTC. A valid instant at or before the server's current time receives `SendAtNotInFuture` with HTTP 409.

### Persist the intent and its identity {step}

For a draft or scheduled campaign, `scheduleCampaign` writes `scheduled`, the desired time into the existing `queuedAt` field, a new run token, and the counter baselines. The API projects `queuedAt` as `sendAt` while the campaign is scheduled. Other active or terminal states are not rescheduled.

### Replace the timer {step}

The API deletes the schedule named after the campaign and creates its replacement in the stage's schedule group. It uses UTC, disables the flexible window, requests deletion after completion, and passes the run token as the creation idempotency token. The target is the existing dispatch queue, carrying the existing `{ campaignId, runToken }` message.

### Admit the fire and send through the existing dispatcher {step}

`beginRun` now admits `scheduled` as well as `queued` and `sending`, but still requires the stored run token to match. The dispatcher then performs the same audience reads, consent checks, pacing and recipient claims as an immediate send. Scheduler delivery to SQS and the dispatcher's actual start remain separate events.

### Cancel or send now {step}

Cancellation first returns the campaign to `draft` and removes its token, then deletes the timer. Send-now first replaces the token and queues the campaign, then removes the timer and publishes a wake-up. If the old timer already fired, its message carries the wrong token and cannot begin the cancelled or replacement run.

## 3. The subtle decision

**The table is authoritative; deleting the timer is cleanup.** Reversing that order would leave an already-enqueued fire valid during cancellation. Persisting the new intent first closes that safety hole.

It does not make the two systems transactional. A failed create, or two overlapping replacements, can leave an intent with no matching timer. ADR-0015 and the earlier review explicitly accept manual recovery through `send` or another `schedule`. The finding below is different: malformed input can cause this loss before any valid replacement intent exists.

## 4. What looks good

### Cancellation and send-now retain the run-token barrier {good|solid}

The new writes happen before Scheduler operations. `beginRun` and recipient claims retain their state/token conditions. If dispatch wins the cancellation race, cancel returns the current sending state; it does not report a successful return to draft.

### Runtime timers have a stage owner {good|solid}

The stage declares both the schedule group and execution role. Installed Alchemy beta.77 supplies group-scoped create/delete permissions and permission to pass that exact role; the role can only send to the dispatch queue. Its group provider calls `DeleteScheduleGroup`, which AWS documents as removing the group's schedules. [AWS group deletion](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_DeleteScheduleGroup.html)

### CLI time-zone behavior survives a real process boundary {good|solid}

A manual CLI run under `TZ=Europe/Berlin` sent both zone-less `09:00` and `11:00+02:00` as `09:00:00.000Z`. Malformed text exited nonzero without an HTTP request, and cancel returned a draft. The existing tests also exercise the real router and CLI process.

## 5. What needs changing

### F1. Reject impossible dates before any scheduling mutation {medium #invalid-date}

**P2 · S2/C3 — medium severity, confirmed application behavior.** Location: new ScheduleCampaignPayload, line 319, with the future check in Campaigns.schedule, line 175.

The timestamp schema checks the string's shape, not its calendar validity. Both of these pass:

```text caption="Inputs exercised through the real HTTP router"
2099-13-01T00:00:00.000Z  // Date.parse returns NaN
2099-02-29T09:00:00.000Z  // Date.parse normalizes to March 1
```

Neither is rejected by `Date.parse(sendAt) <= now`. Starting with an already scheduled campaign, both requests replaced its stored timestamp and run token and reached the schedule service. A controlled service rejection produced HTTP 503 `StorageUnavailable`, with the invalid replacement still stored. The control input `nonsense` produced HTTP 400 and no mutation.

The production adapter then makes the problem destructive: Api.ts:222 deletes the existing timer before passing the original invalid date to `CreateSchedule`. A rejected replacement loses the previously working scheduled send. The old token is already invalid even if an earlier fire remains in the queue.

The AWS rejection itself was not called live in this review. Its documented date-expression requirements and `ValidationException` support that downstream failure; the admission and state mutation were reproduced locally through production router/domain code. [CreateSchedule contract](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html)

Consider: refine `sendAt` at the request boundary to require a finite parsed time and an exact UTC ISO round-trip. A finite/NaN check alone misses normalized invalid days. Add router cases for an invalid month and non-leap February 29, asserting HTTP 400 and preservation of the existing timestamp, token and timer without storage or Scheduler writes.

## 6. Risks this change introduces

These are deployment or accepted operating risks, not additional code findings.

### R1. A mixed-version rollout can acknowledge a scheduled fire without sending {medium}

The previous dispatcher's `beginRun` rejects `scheduled`; `runSlice` returns normally for that stale result, acknowledging the message. The new API can therefore create work that an old dispatcher discards. Alchemy applies independent resources concurrently, and neither function depends on the other. Lambda code versions are managed per function. [Lambda version behavior](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html)

This requires scheduling during an in-place upgrade, or a partial deployment that leaves the new API beside the old dispatcher. It was not observed as an incident. A fresh-stage integration run cannot prove this transition safe.

Consider: keep scheduling unused until both function updates complete; for automated releases, deploy consumer support before enabling the new endpoint. Preserve PR #9's documented merge-first order and validate the combined result afterward.

### R2. A scheduled row still requires operational follow-up {medium}

There is no reconciliation worker or Scheduler failure queue. Failed provisioning and the accepted concurrent-reschedule mismatch can leave a campaign scheduled indefinitely; the dispatch queue's failure alarm cannot detect a message that never reaches it.

The README's wall-clock-minute recovery threshold is also too strong for the recorded evidence. ADR-0015 reports a request for `11:32:44` starting at `11:33:33.071`. AWS describes target invocation precision, not a deadline for downstream Lambda execution. [Scheduler timing](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)

Consider: preserve the accepted manual recovery model, but document a suitable elapsed grace period and inspect Scheduler and queue state before declaring a missed fire. Correct the “within the minute” wording to agree with the recorded probe; do not present the following minute as proof of failure.

## 7. The numbers

```stats
625 / 625 | unit tests passed across 29 files
305 / 8 | source lines added / removed
880 / 19 | test and support lines added / removed
246 / 14 | documentation lines added / removed
```

The 21-file diff is mostly tests and documentation: seven production files account for the runtime change. The full diff is +1,431 / −41. Counts describe scope; they do not cover the invalid-calendar boundary exposed by F1.

## 8. What I checked, what I trusted

```split
Verified in this review
- Fresh frozen-lockfile install and full pnpm check at 0516864
- Changed source/tests, relevant unchanged callers, accepted ADRs and wiki
- Real-router invalid-date reproduction with controlled persistence/Scheduler boundaries
- Manual CLI normalization, malformed input and cancel against a local HTTP server
- Installed Alchemy binding, cleanup and deployment-dependency source
---
Attributed evidence and limits
- Author records 26 passing cloud integration cases, manual sends and test-sched teardown
- No AWS deployment, real Scheduler invalid-date call or cloud inventory check in this review
- Local router probe controls external storage and Scheduler; it is not an AWS integration test
- Mixed-version rollout risk is inferred from code and dependency ordering, not an observed incident
```

`origin/main` was `9cd7e40`, also the merge base, so this PR head is the current remote-base merged result. That stops being true when the target advances. The required combination with PR #9 has not yet been reviewed. Detailed traceability and probe outcomes are in [the evidence record](pr-10-review-evidence.md).

## 9. Before you merge

```checklist
- **Fix F1** — validate real calendar instants before writes and prove rejected reschedules preserve existing intent.
- **Complete the documented PR #9 → PR #10 sequence** — validate again after incorporating segmentation.
- **Make deployment and recovery timing explicit** — both function versions must support scheduling before it is used; a minute boundary is not a failure detector.
```

For a compact source check, open `Schemas.ts` at `ScheduleCampaignPayload`, `Campaigns.ts` at `schedule`, and `Api.ts` at the schedule adapter. Together they show the entire finding. No implementation files were changed by this review.
