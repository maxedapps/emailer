# PR #9: independent review evidence

- Reviewed: `9378cdfbce273ec92d5166c6f8c7b2b1c3899d7e`.
- Target `origin/main` and merge base: `9cd7e40f4f939376f225aaa0d74fea4dddbad4e8`.
- Scope: full PR #9 and its integration boundaries, against the segmentation plan T1–T6 and accepted ADRs 0005, 0011, 0013 and 0014. No changes to the scheduling lane.
- Outcome: **Clear — no material code findings**. R1–R3 in the [walkthrough](pr-9-review.md) are operating risks/accepted tradeoffs, not asserted bugs in the fully deployed PR.
- New architecture decision: none. This record does not amend accepted scope or claim authority to merge.
- Review method: parent synthesis plus two independent read-only lanes, one for dispatch/pagination and one for schema/domain/storage/CLI. Source and existing work documents were not edited.

## Validation

| Check | Observed result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed in a fresh detached worktree at the exact PR head; installed dependencies locally, without a node_modules symlink |
| Formatting, lint, typecheck | Passed in both full-gate attempts; lint retains `--deny-warnings` |
| Default `pnpm check`, attempt 1 | 604/605 unit tests passed; existing CLI case `reports a missing entity on stderr and exits nonzero` timed out at the 30-second test limit; run took 129.32 seconds |
| CLI-only rerun | `pnpm exec vitest run --project unit apps/cli/src/Commands.test.ts`: 26/26 passed, 20.05 seconds |
| Import smoke check | `pnpm check:imports` passed after the CLI rerun |
| Default `pnpm check`, attempt 2 | 604/605 passed; different existing CLI case `never writes diagnostics to stdout` timed out; run took 213.61 seconds |
| Full suite with one worker | `pnpm exec vitest run --project unit --maxWorkers=1`: 605/605 tests across 29 files passed in 152.14 seconds; subsequent `pnpm check:imports` passed |
| GitHub CI | `check` SUCCESS at the reviewed head; [run](https://github.com/maxedapps/emailer/actions/runs/35214259697/job/105178854320) |
| Dispatch lane automated checks | 70/70 passed across Dispatching, Storage/Membership and Storage/RateLimit |
| Manual help | `pnpm emailer campaigns create --help` passed and documents repeatable `--filter key=value` |
| Manual CLI against local HTTP server | Repeated filters and own prototype-name keys survive to the request; absent filter remains absent; malformed/bounds-invalid flags fail before HTTP |
| Real runSlice with existing in-memory fixtures | Empty `{}` includes contacts without attributes; wholly excluded page advances without status/limiter/rows; later matching member sends; wholly excluded final page completes |
| Parent old/new compatibility repro | Baseline API schema strips `filter`; baseline storage `beginRun` drops persisted filter in its projection; PR projection retains it |
| Parent key/size repro | Five own special keys survive payload and storage codecs; accepted 20-entry Unicode map has 34,560 key/value bytes before item overhead |
| Contract lane transport repro | Real Alchemy/Distilled PutItem serialization and response decoding over stub transport preserve special keys and string values; malformed stored filter maps fail decoding |
| AWS integration/deploy/teardown | Not run in this review; author's plan records 25/25 passing integration cases, manual simulator send, and test-seg destruction |

The two local timeouts do not exercise the new filter path. Concurrent install/test/deployment processes were observed on the shared host; no other user's process was changed. Contention is a plausible explanation, not a demonstrated root cause. No test timeout, implementation, or configuration was changed to obtain a passing run.

One initial parent compatibility probe mixed schemas and runtime instances from two separate Effect installations and failed in the harness. It was corrected to use each installation's own Schema/Effect runtime and then passed. That harness failure is not a product finding.

## Plan-backed verdicts

1. **Baseline quality:** Clear. T1–T6 explicitly define AND equality, bounds, absent/empty behavior, live attributes, no row/count for exclusion, and excluded scope. ADR-0011 is amended consistently. The rollout and counter-item-size risks are operational omissions worth recording, not authority conflicts.
2. **Implementation compliance:** T1–T5 Complete with source and local execution evidence. T6's integration case is Complete as code; its live/manual/destroy result is Unverifiable independently in this review and explicitly attributed to the author. No Incorrect, Missing, Overbuilt, or unapproved deviation is established.
3. **Quality beyond the baseline:** Clear, no material code findings. Conditional mixed-version widening and large-filter write amplification are confirmed boundary behaviors; no evidence of a current deployment incident or measured throughput regression is claimed.
4. **Test quality:** The new tests check field propagation, exact accepted recipients, missing rows and counters for exclusions, and checkpoint behavior. Additional probes cover wholly excluded pages and empty filters. All 605 tests passed with one worker. Default local gate timeouts limit the default-command claim; successful CI and bounded-concurrency execution are separate evidence. Cloud conditions and rollout sequencing were not independently exercised.

## Compliance matrix

| Authority item | Expected evidence | Inspected implementation | Validation | Status |
| --- | --- | --- | --- | --- |
| T1: bounded optional filter input | Shared map schema; reject invalid bounds and present undefined | `packages/api/src/Schemas.ts:132`, `:307` | Schemas tests; direct invalid-input probes | Complete |
| T1: summary/full-campaign output | Optional field reaches list/get/create | `Schemas.ts:233`, `:254`; API success schemas | Schema, router, domain and storage tests | Complete |
| T2: META storage | Optional string map; no undefined property | `Storage/Campaigns.ts:58`, `:255` | Recorded write tests; real serializer over stub transport | Complete |
| T2: projections | `summaryOf` and `beginRun` retain predicate | `Storage/Campaigns.ts:154`, `:413` | Get/list/run tests; parent direct beginRun probe | Complete |
| T2: reserved name | No bare FILTER identifier in expressions | `Storage/Campaigns.ts:255`; reserved-name test sweep | Source inspection and storage tests | Complete |
| T3: domain copy | Payload filter reaches create/storage result | `Campaigns.ts:65` | Domain and real-router round trip | Complete |
| T4: AND semantics | All entries equal; absent/empty includes whole list | `Dispatching.ts:80`, `:180` | Two-entry test; direct empty-filter/no-attributes probe | Complete |
| T4: exclusion effects | No row, count, status read, limiter slot or send | `Dispatching.ts:177` | Recorder assertions; wholly excluded page probe | Complete |
| T4: checkpoint progress | Advance across excluded member/page, including time overrun | `Dispatching.ts:181`, `:267` | Added overrun test; continuation and terminal-page probes | Complete |
| T4 / ADR-0011: live contact data | Existing member hydration exposes current attributes | `Storage/Membership.ts:241` | Membership tests and call-path inspection | Complete |
| T5: CLI | Optional repeatable key=value, bounds, transmitted map | `apps/cli/src/Commands.ts:403`, `:423` | Commands suite, CLI help, local HTTP probe | Complete |
| T5: README and ADR amendment | Explain live values, AND, and no-row/no-counter | README guarantees; ADR-0011 header | Full diff/document inspection | Complete |
| T6: integration test implementation | Two matching contacts accepted, third absent from SEND rows, filter returned in listing | `Api.integration.test.ts:252` | Inspected full case and support helpers | Complete |
| T6: live deploy/manual/destroy | Cloud execution and cleanup evidence | `.adr/work/campaign-segmentation.md`, T6 and handoff | Author reports 25 integration passes and teardown; not independently run | Unverifiable |
| ADR-0013: repeat-safe writes | Preserve tokens, conditions, fresh-key create semantics | Existing primitives, create/checkpoint/claim/settle paths | Storage/dispatch suites; no new write operation introduced | Complete |
| ADR-0014: body separation | BODY remains separate and read once per slice; listing omits it | Campaign storage and dispatcher body read | Existing body/list/dispatch tests | Complete |

There is no new approved deviation. The earlier implementation review's Partial T6 reflected its earlier execution date; the later plan and PR body report completion. This review preserves that distinction rather than treating an old report as a current blocker.

## Additional context

The pinned Effect keyValuePair CLI convention rejects empty values and values containing `=`. HTTP supports those valid string values. This matches the plan's explicit reuse of the existing `--attr` convention; no material finding is admitted for this limitation.

Consulted current official sources for [Lambda per-function versioning](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html) and [DynamoDB full-item write charging](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html), plus the local DynamoDB, Effect schema/CLI, Lambda, and Alchemy lifecycle wiki and pinned dependency source. The 34,560-byte measurement is a schema-valid input bound, not a billing benchmark.

## Artifact and workspace ownership

The workflow-owned detached worktree at `~/worktrees/emailer/pr-9-review` was verified clean and removed after validation. No branch was created. Existing campaign-segmentation and campaign-scheduling worktrees are user-owned and untouched. Both independent review lanes finished without source edits or remaining processes. The PR is not merged or pushed, and no GitHub review/comment is posted.

The walkthrough HTML is generated by the PR-review renderer. A named browser session verified desktop (1280px) and mobile (375px) rendering with screenshots; neither viewport has document-level horizontal overflow. Automated artifact checks found no scripts, network assets or broken internal anchors. The browser session is closed at closure. Only the three review artifacts are included in the local documentation commit.
