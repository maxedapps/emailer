# Decomplex review: Campaign scheduling

## Overall status

Findings, none blocking and none touching the user's decisions. The core of the change — one one-shot schedule per campaign in a stage-owned group, the intent on `META`, the fire as the existing wake-up, `beginRun` admitting `scheduled` under the same token check, table first and Scheduler second — is the smallest design that meets the 2026-09-17 decisions, and the delete-then-create plus `ClientToken` pair in `CampaignSchedule.create` is exactly as much machinery as reschedule and ADR-0013 require (question (a), below under proportionate areas). What does not earn its place: a `queuedAt` that duplicates `startedAt` byte-for-byte on every fire while a second attribute carries the same instant (DEX-001), a condition clause that is always true (DEX-002), a retry loop in the live gate for a failure the plan itself calls unreachable (DEX-003), a typed error designed before anyone has checked what Scheduler does with a past `at()` (DEX-004), a pure function extracted and given its own test file to pin a string slice (DEX-005), three test cases that re-pin the library or the fake (DEX-006), and one ADR alternative that is not one (DEX-007).

If DEX-001, DEX-002, DEX-003 and DEX-005 all land, the change has this shape: `StoredCampaign` gains only the `"scheduled"` literal and no attribute; `beginRun`'s update expression is byte-identical and only its condition grows; `unscheduleCampaign`'s condition mirrors `scheduleCampaign`'s; `Scheduling.ts` and `Scheduling.test.ts` do not exist (the role and group sit beside `dispatchQueue` in `Dispatch.ts`, or in `Api.ts`); T7 is two plain cases with no `Effect.retry`; ADR-0015 loses one alternative and one Consequence clause. DEX-004 is a one-command check on the test stage that decides whether `SendAtNotInFuture`, its route error, its domain branch and its three test cases exist at all.

## Review contract

| Axis | Selection |
|---|---|
| Mode | Prevention |
| Target | [`campaign-scheduling.md`](campaign-scheduling.md) (Ready for implementation, 2026-09-17) and [ADR-0015](../0015-one-shot-scheduler-per-campaign.md) (Proposed) |
| Authority / required behavior | ADR-0015:5 — the user decided on 2026-09-17 that scheduling gets a dedicated `POST /campaigns/:id/schedule` with `sendAt` plus a cancel, `send` stays "now", the run token is minted at schedule time, the fire targets the existing dispatch queue with the existing wake-up message, a schedule group per stage is mandatory, one ADR. Accepted ADRs 0011, 0013, 0014. Repository rules: keep code and architecture simple and lean; do not handle edge cases or esoteric fail states; cleanest solution over quick fix; the wiki is authoritative. Required behaviour is the plan's Outcome: a draft (or scheduled campaign) can be scheduled, listed as `scheduled` with its `sendAt`, cancelled back to `draft`, or sent now; the fire runs the existing dispatcher within the minute after `sendAt`; late and duplicate fires are no-ops; schedules die with their stage |
| Scope | Structural choices, task shape, tests and validation machinery, records; the nine questions (a)–(i) in the brief. Defects and plan compliance are routed (see Limitations) |
| Report | `.adr/work/campaign-scheduling-decomplex.md` (explicit path; the repository uses `.adr/`, not `adrs/`) |

## Coverage

### Inspected

- The full plan and ADR-0015; ADR-0011, 0013 and 0014 in full; `campaigns-next-lanes.md` (lane C brief, risks and the "must read" list); `wiki/aws/scheduler.md` in full; `wiki/effect/http-cli-and-runtime.md` "CLI surface"; the `wiki/alchemy` page list; the two prior decomplex reports (`campaign-body-item`, `mass-sending`) for shape and bar.
- `apps/backend/src/Storage/Campaigns.ts` in full (`StoredCampaign`, `submissionOf`, `createCampaign` writes `draft` with no `runToken`, `enqueueCampaign` and `resumeCampaign` conditions, `beginRun` with `startedAt = if_not_exists(startedAt, :now)` and `ALL_NEW`, the transaction operations that require `sending`); `Campaigns.ts` in full (`send`/`resume` switch, `wakeQueued`, `CampaignWake`); `Dispatching.ts` in full (`beginRun` at :90, `stale` return at :92); `Dispatcher.ts` in full; `Dispatch.ts` in full (leaf rule, `dispatchQueue` yielding `dispatchFailures`); `Api.ts` in full (`ApiFunction` bindings and layers); `Addresses.ts` (93 lines; see Limitations).
- `packages/api/src/Schemas.ts` (`Timestamp`, `CampaignSubmission`, the 409 error classes); `packages/api/src/Api.ts` `CampaignsGroup`.
- Test suites at the lines the plan cites: `Storage/Campaigns.test.ts` (`StoredCampaignFields`/`meta` fixture, absent-key assertions, the pinned `enqueueCampaign`/`resumeCampaign`/`beginRun` requests, the `it` list); `Campaigns.test.ts:80-180, 300-425` (store fake, `wakeDouble`, the `send`/`resume` tables); `Api.test.ts:45-60, 356-437` (`unusedCampaignStore`, the in-memory store and wake); `Dispatching.test.ts:159-200`; `Api.integration.test.ts:35-160` and `IntegrationSupport.ts:235-252, 331-363` (no `Effect.retry` anywhere in the integration project); `packages/api/src/Schemas.test.ts:335-360, 454`; `apps/cli/src/Commands.ts:425-500`; `Commands.test.ts:245-330, 461-530, 610-650`.
- `node_modules/alchemy/src/AWS/Scheduler/CreateSchedule.ts`, `DeleteSchedule.ts`, `BindingHttp.ts` (grants, `GroupName`/`RoleArn`/`FlexibleTimeWindow` injection), `ScheduleGroup.ts` (delete via `DeleteScheduleGroup`), `Schedule.ts:8-27` (`retryUntilRoleAssumable`, 24 × 5 s, for the deploy-time resource), `IAM/Role.ts` (retry on the principal-propagation message only); `@distilled.cloud/aws` `services/scheduler.ts:86-131, 383-399` (`ClientToken` optional with `T.IdempotencyToken()`, `ConflictException` is `withRetryableError`) and `client/generate-idempotency-tokens.ts` (fresh UUID per attempt when unset).
- Web research, disclosed because the brief listed no validation: the AWS "Schedule types" page (60-second precision; `at()` syntax; nothing on a past instant), one AWS re:Post thread whose `ValidationException` was an `at(...Z)` format error and not a past instant, and one practitioner write-up stating that "no validation occurs at Schedule creation to ensure newly created ones are not already irrelevant". None of it settles what Scheduler does with a past `at()`; see DEX-004.

### Skipped or partial

- Lane D's plan and worktree were not read; the merge protocol is judged on its own text.
- No deployment, unit run or AWS call was made. The past-`at()` behaviour and the role-propagation window are taken from documents, not observed.
- `README.md` was read only at the sections the plan edits.

## Potential findings

### DEX-001 — `queuedAt = if_not_exists(queuedAt, :now)` on `beginRun` duplicates `startedAt` and leaves `sendAt` as a second attribute for the same instant

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** Plan :44 ("`queuedAt` is required downstream … `beginRun` gains `queuedAt = if_not_exists(queuedAt, :now)` beside `startedAt`. The instant the scheduler fired is the honest queued time"), T2 :76 (`sendAt` on `StoredCampaign`), :80 (`enqueueCampaign` gains `REMOVE sendAt`), :81 (`beginRun` update expression), :84 (fixture and assertions); ADR-0015:18, :39; T7 :162 (`queuedAt >= sendAt - 1000`). Question (c) of the brief. Not a user decision.
- **Current-need evidence:** `beginRun` today writes `startedAt = if_not_exists(startedAt, :now)` (`Storage/Campaigns.ts:367`) and the plan adds `queuedAt = if_not_exists(queuedAt, :now)` with the same `:now` in the same write. On every fire `queuedAt` and `startedAt` are therefore the same string, and the `scheduled` item carries the nominal instant in a third attribute, `sendAt`, which `enqueueCampaign` must then remove. The plan's "honest queued time" is the fire instant, which `startedAt` already records.
- **Added burden:** One new stored attribute (`sendAt`) with its `StoredCampaignFields`/`meta` fixture entry and the "a fresh create has no `sendAt`" assertion; `REMOVE sendAt` on the hot-path `enqueueCampaign` expression; a changed `beginRun` update expression on the hot path (the condition changes anyway); a `queuedAt` that carries no information of its own after a fire.
- **Reachable practical impact:** An operator reading a completed scheduled campaign sees `queuedAt === startedAt` and cannot tell from the record what instant was asked for; the dispatcher pays one more `SET` clause per slice.
- **Smallest simpler alternative:** `scheduleCampaign` writes `queuedAt = :sendAt` (the payload's `Timestamp`, verbatim) instead of `sendAt`; `submissionOf` returns `{ state: "scheduled", sendAt: stored.queuedAt }`; `unscheduleCampaign` is `SET #state = :draft REMOVE runToken, queuedAt`; `enqueueCampaign` keeps its expression unchanged (it already sets `queuedAt = :now`, which overwrites); `beginRun`'s update expression is byte-identical and only its condition gains `:scheduled`. `StoredCampaign` gains the `"scheduled"` literal and no attribute; the `meta` fixture does not change. `queuedAt` is then the instant the campaign was queued for and `startedAt` the instant it actually began — two distinct facts on every scheduled campaign, and the same two on a `send` (where they differ by the queue hop). T7's "did not send early" assertion becomes `Date.parse(startedAt) >= Date.parse(sendAt) - 1000`, which is the truer check anyway since `startedAt` is the fire.
- **Exception / boundary check:** No wire contract changes: `scheduled` still carries `sendAt`; the later states still carry `queuedAt` and `startedAt`. The `sending`-without-`queuedAt` corruption rule (`Storage/Campaigns.test.ts:387`) holds because a `scheduled` item already has `queuedAt` when the fire moves it to `sending`. ADR-0014's "intent lives on `META`" holds.
- **Required behavior and simplification risk:** None affected. The cost is a naming wrinkle: a `scheduled` item holds its nominal instant in an attribute called `queuedAt`; one sentence on `scheduleCampaign` says so. If the parent prefers to keep a distinct `sendAt` attribute, the finding still stands in its smaller form: `scheduleCampaign` writes both `sendAt` and `queuedAt = :sendAt`, `beginRun`'s update expression is unchanged, and cancel removes both — but that is duplicate state on one item and the version above is preferred.
- **Bounded next step or user question:** Amend plan :44, T2 :76-84, T7 :162 and ADR-0015:18, :39 as above.
- **Acceptance signal:** `grep -n "sendAt" apps/backend/src/Storage/Campaigns.ts` shows it only in `submissionOf` and the `scheduleCampaign` parameter; the `beginRun` case at `Storage/Campaigns.test.ts:683` changes only its `ConditionExpression` and `ExpressionAttributeValues`; the `meta` fixture is untouched.

### DEX-002 — `unscheduleCampaign`'s `attribute_not_exists(runToken)` clause is always true

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** Plan :46 ("`unscheduleCampaign` under `#state = :scheduled OR (#state = :draft AND attribute_not_exists(runToken))`: the second disjunct is the state this very request leaves behind"), T2 :79, :84 ("under the two-way condition"); ADR-0015:19 ("under a condition that also holds once the write has applied"). Question (b). ADR-0013:21 is the accepted rule the clause implements.
- **Current-need evidence:** `createCampaign` writes `state: draft` without `runToken` (`Storage/Campaigns.ts:223-241`); `enqueueCampaign`, `resumeCampaign` and the planned `scheduleCampaign` set the token and leave `draft` in the same write; the planned `unscheduleCampaign` removes the token as it writes `draft`; no other operation writes `draft`. A draft therefore never holds a run token, and `#state = :draft AND attribute_not_exists(runToken)` is `#state = :draft`. The `(#state = :queued AND runToken = :run)` disjunct on `enqueueCampaign` needs its token clause to tell "my own write" from "someone else's enqueue"; cancel has no token to compare, so the distinction collapses to the state alone.
- **Added burden:** A condition string that reads as if it discriminates something, a comment explaining it, and a case asserting it verbatim; every later reader re-derives that the clause cannot fail.
- **Reachable practical impact:** Maintenance only.
- **Smallest simpler alternative:** `ConditionExpression: "#state IN (:scheduled, :draft)"`, mirroring `scheduleCampaign`'s `#state IN (:draft, :scheduled)` at T2 :78, with the same one-line comment ("also holds once this very request has applied"). The plain `#state = :scheduled` the brief asks about is not smaller in any way that matters and would make the `"not-scheduled"` outcome false on a client-level retry after a lost response, which is the misreading ADR-0013 removed.
- **Exception / boundary check:** ADR-0013's invariant (the condition holds before and after the write for the actor that wrote it) is preserved in the shorter form; a concurrent fire that moved the campaign to `sending` still fails the condition and `cancel` returns the campaign as it is.
- **Required behavior and simplification risk:** None.
- **Bounded next step or user question:** Amend :46, T2 :79 and :84; ADR-0015:19 keeps its sentence.
- **Acceptance signal:** `grep -n "attribute_not_exists(runToken)" apps/backend/src/Storage/Campaigns.ts` is empty.

### DEX-003 — The live gate retries a 503 for a role-propagation window the plan says is never reached

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** T7 :162 ("wrap the call in `Effect.retry` on `StorageUnavailable`, `Schedule.spaced("5 seconds")` for at most 12 attempts, for role propagation right after a deploy"); plan :51 ("the role is created during the deploy, long before the first `schedule` call in practice. The live case retries a 503 for a bounded time"); T3 :108 ("wait a minute and repeat; T7's retry covers it"); ADR-0015:41. Question (e).
- **Current-need evidence:** Alchemy's `retryUntilRoleAssumable` (`Schedule.ts:20-27`) exists for the deploy-time `Schedule` resource, which is created seconds after its role in the same deploy. Here the role is deployed with the stack and the first `schedule` call comes after the deploy has finished, after T7's own six-value `.env.test` repoint (T7 :170), and after the integration project starts. The integration project has no `Effect.retry` today (grep over `Api.integration.test.ts`, `IntegrationSupport.ts` and the other `*.integration.test.ts` is empty); every other case treats a 503 as a failure.
- **Added burden:** A one-minute retry loop around one call in one case, a first in the suite, that also hides any other 503 the `schedule` endpoint answers during that minute (a bad execution role, a wrong target ARN, a group the API may not write to) behind twelve silent attempts.
- **Reachable practical impact:** In the failure the loop is for, the whole run is one minute old; the plan's own recovery ("wait a minute and repeat") is the correct and cheaper answer. In any other 503 the loop delays the diagnosis by a minute.
- **Smallest simpler alternative:** Delete the retry from T7 :162 and the "the live gate retries a 503 for a bounded time" clauses at :51, T3 :108 and ADR-0015:41; keep "if `ExecutionRoleNotAssumable` appears right after the first deploy, wait a minute and repeat" at T3 :108 as the recovery.
- **Exception / boundary check:** No ops need: the live gate is run by a person right after a deploy, and a one-minute rerun is not an operator burden. The production path is unaffected either way.
- **Required behavior and simplification risk:** None; a fast run right after a first deploy may fail once and is rerun.
- **Bounded next step or user question:** Amend T7 :162, :51, T3 :108 and ADR-0015:41.
- **Acceptance signal:** `grep -n "Effect.retry" apps/backend/src/Api.integration.test.ts` is empty; the ADR's Consequence about the role ends at "long before the first `schedule` call".

### DEX-004 — `SendAtNotInFuture` is designed before anyone has checked what Scheduler does with a past `at()`

- **Evidence:** Supported
- **Recommendation:** Validate
- **Surface and location / authority:** Plan :13 ("`sendAt` must be in the future, checked in the domain against the clock and answered with a typed 409 rather than letting Scheduler's `ValidationException` surface as a 503" — listed among "assumptions taken as routine"), :31 ("nothing documents a past `at()`"), :54, T1 :61 (`SendAtNotInFuture` class), :62 (route error), T4 :113 (domain branch), :117-118 (two cases), T7 :162 (one assertion); ADR-0015:21 (Decision bullet). Question (d). Not among the user's decisions at ADR-0015:5.
- **Current-need evidence:** The plan's own citation says the API reference does not document a past `at()`; the web research under Coverage found the same silence plus one practitioner report that Scheduler performs no "already irrelevant at creation" validation. If Scheduler accepts a past `at()` and fires at the next opportunity, the check is pure policy: a past `sendAt` would simply send now, continuous with the plan's own "a `sendAt` only seconds ahead is accepted; Scheduler fires it at the next opportunity" (:49). If Scheduler rejects it, the check is warranted, because the table is written first and a user typo would otherwise leave a `scheduled` campaign with no schedule behind a 503.
- **Added burden:** One tagged error in the shared contract (sticky once published), one route error entry, one clock read and branch in `Campaigns.schedule`, one Schemas member, two unit cases and one live assertion — all resting on an undocumented behaviour. Note also that the check cannot fully prevent Scheduler seeing a past instant: a `sendAt` a few hundred milliseconds ahead passes the domain check and is past by the time `CreateSchedule` runs, so the 503 path stays reachable in the rejecting case either way (an esoteric residual the repository rules say not to handle).
- **Reachable practical impact:** If Scheduler accepts, the error refuses a request the system could serve. If Scheduler rejects, the error is the cleanest answer available and its cost is proportionate.
- **Smallest simpler alternative:** Before implementation, one command on the test stage (`aws scheduler create-schedule --name probe --schedule-expression "at(2020-01-01T00:00:00)" --flexible-time-window '{"Mode":"OFF"}' --target '{...}'`, then delete it). Accepts-and-fires: drop the check, the class, the route error, the T4 branch and cases and the T7 assertion; ADR-0015:21 becomes "a past or near `sendAt` fires at Scheduler's next opportunity". Rejects: keep the plan as written; the typed 409 is the repository's established shape (`AddressOptedOut`, `EmailAlreadyUsed`), and record the observed message in :31.
- **Exception / boundary check:** No trust boundary or data invariant hinges on the check; `Timestamp` already validates the shape. The check exists only to avoid a `scheduled`-with-no-schedule state on user error, which is a real cost only in the rejecting case.
- **Required behavior and simplification risk:** The Outcome does not mention a past-`sendAt` refusal; it is a plan assumption. Risk in the accepting case: none. Risk in the rejecting case, if the check were dropped: a 503 and a `scheduled` campaign to cancel — which is why the validation comes first.
- **Bounded next step or user question:** T3 has no dependencies: deploy it to `test-sched` first (the probe needs the execution role and the queue ARN for `--target`; any existing `scheduler.amazonaws.com` role in the account also serves), run the probe, record the outcome at plan :31, then write T1 with or without the error class.
- **Acceptance signal:** Plan :31 states the observed behaviour with the error text or the fire; either `grep -rn SendAtNotInFuture packages apps` is empty or the plan's Research cites the rejection verbatim.

### DEX-005 — A pure function extracted, and a test file created, to pin `.slice(0, 19)`

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** T3 :99 ("Extract the `at()` rendering as a small exported pure function (`scheduleExpression(sendAt)`) in `Scheduling.ts` so it has a unit test"), :104 (new `apps/backend/src/Scheduling.test.ts` with one case `2026-09-20T09:00:00.000Z → at(2026-09-20T09:00:00)`). Question (f), and (g) for the module.
- **Current-need evidence:** The rendering is `` `at(${sendAt.slice(0, 19)})` `` on a string the contract already guarantees is `yyyy-mm-ddThh:mm:ss.sssZ` (`Schemas.ts` `isoUtcPattern`). The extraction exists for the test, not for a second caller. T7's fire case is the proof that matters: a malformed expression is a `ValidationException` at `CreateSchedule`, the campaign never fires, and the case fails.
- **Added burden:** One exported function, one new test file with one case, and a `Scheduling.ts` module whose other content is two resource declarations.
- **Reachable practical impact:** Maintenance only.
- **Smallest simpler alternative:** Inline the expression in `create` with a one-line comment citing the `at()` syntax and the contract's millisecond form; no `Scheduling.test.ts`. On (g): with the function gone, `Scheduling.ts` holds only `scheduleGroup` and `schedulerRole`. The role's props yield `dispatchQueue`, so beside `dispatchQueue` in `Dispatch.ts` is the natural home — the leaf rule there forbids a Function class (it would pull the dispatcher handler into the API bundle), not a Role or a group, and a module-level resource registers only where it is yielded (`Dispatch.ts:28-30`), so the dispatcher bundle is unaffected. `Api.ts` is the other honest home since the API function is the only consumer. Either is a lean, not a finding; a third file is not wrong, only unearned once its test is gone.
- **Exception / boundary check:** None lost; the wire form of the expression is proven live.
- **Required behavior and simplification risk:** None.
- **Bounded next step or user question:** Amend T3 :97-99, :104; decide the module placement at implementation time.
- **Acceptance signal:** No `Scheduling.test.ts`; `grep -rn scheduleExpression apps/backend/src` is empty.

### DEX-006 — Three planned cases re-pin library or fake behaviour

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** T1 :63 ("one case that a `scheduled` submission without `sendAt` is rejected; … `ScheduleCampaignPayload` … rejects a non-UTC string"); T4 :118 ("a later `GET` and `GET /campaigns` summary carry it"). Question (f).
- **Current-need evidence:** `Schemas.test.ts:454` already pins that a timestamp that is not ISO UTC is rejected, through the same `Timestamp` schema. A required Struct field being required is library behaviour that the type system also enforces; the `it.each` row at `:342-356` is what records the `scheduled` member's shape. In `Api.test.ts` the store is an in-memory map (`:356-437`); `GET /campaigns` there returns whatever `schedule` put in the map, so the listing assertion exercises the fake, while the real projection is pinned by the Storage "decodes every public state" case that T2 :84 extends with a `scheduled` item.
- **Added burden:** Three cases whose failure could only mean the library or the fake changed.
- **Reachable practical impact:** Maintenance only.
- **Smallest simpler alternative:** T1: the `it.each` row, and one payload decode if the parent wants the payload schema exercised at all; no rejection cases. T4 `Api.test.ts`: `schedule` answers `scheduled` with the `sendAt` sent; a past `sendAt` answers 409 (if DEX-004 keeps it); `cancel` answers `draft`. Drop the `GET /campaigns` clause. The CLI cases at T5 :133 all stand: the `TZ=Europe/Berlin` case protects verified real behaviour, and `--at nonsense` follows the precedent at `Commands.test.ts:472`.
- **Exception / boundary check:** No unique protection lost; the wire presence of `sendAt` on a listing is proven live by T7's `GET /campaigns` assertion against the deployed store.
- **Required behavior and simplification risk:** None.
- **Bounded next step or user question:** Trim T1 :63 and T4 :118.
- **Acceptance signal:** `Schemas.test.ts` gains one row (plus at most one payload decode); the `Api.test.ts` schedule case does not call `list`.

### DEX-007 — ADR-0015 alternative 6 is not an alternative

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** ADR-0015:31 ("A deploy-time Alchemy `Schedule` resource per campaign. Schedules are minted by operators at runtime, not by deploys. Rejected; the runtime binding exists for this"). Question (i).
- **Current-need evidence:** A deploy-time resource cannot be created by an operator's API request; the entry rejects itself in its own sentence. Alternatives 1–5 are real choices (the lane brief names three of them) and 7 answers the brief's explicit "draft or `cancelled` — pick one and justify".
- **Added burden:** One entry a reader must evaluate and dismiss.
- **Reachable practical impact:** Record clarity only.
- **Smallest simpler alternative:** Delete alternative 6; the runtime-binding fact already lives in the Decision's first bullet.
- **Exception / boundary check:** ADR conventions ask for realistic alternatives.
- **Required behavior and simplification risk:** None.
- **Bounded next step or user question:** Amend ADR-0015:31.
- **Acceptance signal:** ADR-0015 lists six alternatives.

## User-decision queue

None. DEX-004 is a validation the implementer can run, not a user decision; every other item is advisory and small.

## Confirmed proportionate areas

- **(a) Delete-then-create plus `ClientToken` in `CampaignSchedule.create`.** Both earn their place, for different repeats. A reschedule mints a fresh token (plan :13), so a second `CreateSchedule` under the same `Name` with a new `ClientToken` is a `ConflictException`; the prior delete is what makes reschedule and repair one path. A client-level retry after a lost response, without a supplied token, sends a fresh UUID per attempt (`generate-idempotency-tokens.ts`) and also answers `ConflictException` — the ADR-0013 lesson — so `ClientToken: runToken` is one field that makes that retry transparent. Handling `ConflictException` instead of pre-deleting would be two code paths for one; the "a Conflict can then only be a concurrent operator, answered as `StorageUnavailable`" clause is the default `mapError`, zero code. `UpdateSchedule` on conflict would be a third binding.
- **`beginRun` admitting `scheduled`; `enqueueCampaign` admitting it; `resumeCampaign` not.** One-to-one with the state edges the user's decisions create; the lane brief's stated risk.
- **The `CampaignSchedule` service with `create`/`remove`** beside `CampaignWake`, provided as a `Layer.succeed` in `ApiFunction`: the same shape as the wake, one fake per suite.
- **The three fakes growing two members each.** Forced by the structural `CampaignStoreOperations`; `notExercised` / `Effect.die` in the suites that never reach them is the established form.
- **T2's two cases per new operation and the updated pinned request strings.** The exact-request assertion style is the suite's; nothing is combinatorial.
- **T4's call-order assertion (table before scheduler).** It protects the ADR's ordering invariant, which is the whole cancellation-race argument.
- **T7's cancel case** (schedule an hour ahead, cancel, send, complete with two rows). Two simulator sends prove that a cancelled campaign is a working draft against the real table; the manual `list-schedules` step is what proves the delete. Proportionate for a live gate.
- **(h) The wiki edits.** One section on the scheduler page and one paragraph on the CLI page, both recording verified traps (`ClientToken` filled per attempt; `Flag.date` reads zone-less input as local time). Placement nit only: the Alchemy grant details arguably belong on `wiki/alchemy/runtime-and-bindings.md` with a link from the scheduler page; either is one edit.
- **README additions** (two command lines, one contract bullet, a stuck-`scheduled` paragraph with the `list-schedules` inspection, one inventory line). Operator decisions with a concrete action each.
- **The mandatory group and the execution role.** User decisions; the group is the only thing that ties runtime-minted schedules to the stage.
- **No Scheduler retry policy or dead-letter queue.** A deliberate non-decision with a recorded recovery (`send`); adding either would be machinery for a failure with no observed rate.

## Limitations

- Static review plus the web research disclosed under Coverage. No stage was deployed, no suite run, no Scheduler call made; the past-`at()` behaviour (DEX-004) and the role-propagation window (DEX-003) are unobserved.
- Every disposition is the parent's. DEX-001 changes the stored shape the plan describes and touches T2, T7 and two ADR lines; the others are independent of each other.
- Routed to the defect and compliance reviewer, not judged here:
  - Plan :54 cites `apps/backend/src/Addresses.ts:111-115` as the clock-comparison precedent; the file is 93 lines and contains no `Clock` or `Date.parse` use. The citation is broken whichever way DEX-004 goes.
  - The distilled client marks `ConflictException` as retryable, so a genuine concurrent conflict is retried by the client's policy before it surfaces, and the Scheduler bindings carry no operation timeout like the store's five seconds; the API's sixty-second budget bounds it.
  - T7's `queuedAt >= sendAt - 1000` assertion follows DEX-001 whichever way the parent goes: under the plan as written it holds trivially only because `queuedAt` is the fire; under the alternative it must read `startedAt`.
