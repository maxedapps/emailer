# Code review: PR #2 — Clean codebase (`clean-codebase` → `main`)

- Date: 2026-09-14
- Target: PR #2, 15 commits `1c2e01f..a2eb7da`, 69 files (+5028/−1621), reviewed at `a2eb7da`.
- Baseline: plan-backed — [implementation plan](clean-codebase.md), [ADR-0007](../0007-immutable-recipient-unsubscribe-links.md), [ADR-0008](../0008-storage-capabilities-and-error-boundaries.md).
- Scope: full branch. Invocation: standalone, user-requested. Output: this report plus chat summary.
- Method: four independent read-only lanes (storage; unsubscribe/auth/HTTP; feedback/replay/infra/CLI; tests and removal manifest) over a shared clean checkout, each proving claims by execution where practical. Parent ran `pnpm check`, read `Api.ts`, `Campaigns.ts`, `Diagnostics.ts`, the import transaction and the stale-import integration test directly. Tree confirmed clean before and after.
- Result: **Clear** after round 2 — one test-evidence finding (F1), fixed and proven live; no production defect admitted.

## Review constraints

| Axis             | Selection                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Target           | PR #2 at `a2eb7da`                                                                                        |
| Baseline         | plan-backed (plan + ADR-0007 + ADR-0008)                                                                  |
| Scope            | full branch                                                                                               |
| Invocation       | standalone                                                                                                |
| Output           | `.adr/work/clean-codebase-pr-review.md`, uncommitted; chat summary                                        |
| Dimensions       | correctness, security/data safety, types and boundaries, tests/validation, plan compliance                |
| Validation/tools | `pnpm check`; targeted unit runs; scratch probes against real modules; installed Alchemy/Effect source    |
| Writes/artifacts | round 1: this file only, no target edits, no deploy, no integration run; round 2: see _Follow-up closure_ |

## Summary

The branch does what the plan says, and the parts that can be verified locally verify. `pnpm check` is green at `a2eb7da` with 468 unit tests in 23 files. Static IAM narrowing matches ADR-0008 exactly. The token, the public endpoint, the import transaction, batch completeness, the replay tool and the CLI reporting policy each held up under adversarial probing by execution. Every removal-manifest row is absent from application code.

One thing the record claims and the evidence does not support: the live "stale import" integration test does not exercise the holder `ConditionCheck` it is named for and that the plan's T9 designates as the decisive live check. The production guard exists and is unit-pinned; what is unproven is DynamoDB evaluating it. That is a test-evidence gap, not a product defect, and it is small to close.

Everything T9 records from the deployed stage — effective role policies, the 22/22 live run, destination capture and replay, cold starts without `EMAILER_STAGE`, the delivered message — is **claimed, not reproduced here**. No deployment was made for this review.

## Coverage

### Inspected

- Storage: `Storage/{Primitives,Items,Errors,Membership,Contacts,Lists,Campaigns,Feedback,Addresses,Audience,Unsubscribe,Table,Testing}.ts` and suites; installed `alchemy/src/AWS/DynamoDB/{BatchGetItemHttp,TransactWriteItemsHttp,BindingHttp}.ts`; distilled DynamoDB types.
- Unsubscribe/auth/HTTP: `{Unsubscribe,UnsubscribePage,Auth,Api,Diagnostics,Campaigns}.ts`; installed `effect/unstable/http/{HttpRouter,FindMyWay}`, `Layer`, `Context`; `alchemy/lib/{Http,AWS/Lambda/HttpServer,Runtime/Bootstrap/Lambda}.js`.
- Feedback/replay/infra/CLI: `{Feedback,ReplayFeedback}.ts`, `alchemy.run.ts`, `apps/cli/src/{Diagnostics,main,Commands}.ts`; installed `alchemy/src/AWS/SQS/{BindingHttp,SendMessageHttp}.ts`, `AWS/Lambda/{EventInvokeConfig,Function}.ts`, `AWS/CloudWatch/Alarm.ts`, `Runtime/Bootstrap/{Lambda,Process}.ts`; `effect/src/Runtime.ts`.
- Tests: every `*.test.ts` in the diff (full bodies for Primitives, Membership, Unsubscribe, ReplayFeedback, both Diagnostics, Items; names plus every `expect` for the rest), the three integration suites and `test/IntegrationSupport.ts`.
- Docs: plan, both new ADRs, the three supersession edits, README, `.env.example`, wiki diff.

### Skipped or partial

- Round 1: no deployment, no integration project run, no AWS calls by design (round 2 ran one integration test against an already-deployed stage; see _Follow-up closure_). One lane's bogus-flag probe of the replay tool sent one unauthenticated request to the real SQS endpoint before failing (`AWS_ENDPOINT_URL` is not honoured by distilled); no account state was touched.
- Wire behaviour of an empty `LastEvaluatedKey` and DynamoDB's evaluation of the holder condition are supported by installed types and AWS docs, not executed.

### Required boundaries

- `Lists.importContacts` → `Storage.importContacts` (single caller, payload refinement excludes duplicate addresses).
- Alchemy invocation scope vs. once-built app context: `Context.merge` lets the merged-in side win and `Layer.build` adds no Scope, so the per-invocation Scope survives `provideContext`.
- Alchemy `safeHttpEffect` defect logging for the `orDie` boundary: executed under the deployed `consolePretty` logger with a transport error wrapping a PutItem body containing an address — message, stack and cause chain only, no item values.

## Validation

- **Run:** `pnpm check` at `a2eb7da` → formatter clean, `oxlint --type-aware --deny-warnings` clean, `tsc --noEmit` clean, 23 files / 468 tests passed, import probe exit 0. Targeted unit runs per lane: Storage 8 files / 145; Unsubscribe+UnsubscribePage+Api+Auth 4 / 86; ReplayFeedback+CLI Diagnostics+Feedback+Commands 4 / 77; Primitives+Membership+Unsubscribe+ReplayFeedback 4 / 108. Scratch probes: storage 6/6, unsubscribe 8/8, type-negative `tsc` errors exactly where expected. CLI and replay subprocesses run for exit/stdout/stderr.
- **Skipped/unavailable:** integration project; deployment; GitHub review post.

## Plan-backed verdicts

1. **Plan/baseline quality and omissions:** Sound. Two prior reviews already closed the plan's one material gap (`:$LATEST`). No conflict between plan and ADRs. The plan's T9 stale-import instruction is precise ("move/reassign the address _after_ advisory reads, then execute the real transaction") — the implementation of that instruction is what fell short, not the plan.
2. **Implementation compliance:** All rows Complete or Unverifiable-as-claimed, except one Partial (stale-import live proof, F1) and one Partial doc nit (a stale `EMAILER_STAGE` reference in the wiki). No Incorrect, no Overbuilt, no undocumented deviation. Zero dependency changes confirmed.
3. **Implementation quality beyond the baseline:** No defects admitted after adversarial probes on the token (forgery, non-canonical, over-bound, independent HMAC vector), the HTML surface (no interpolation of address or token), the router bound (real `RouterConfig` reaching find-my-way post-decode), the import transaction (no item both checked and written; 81 actions at 20 candidates), batch completeness (single catch site, missing item stays missing, one outer deadline), replay safety (invoke ≤45s inside 120s visibility; delete only after 200 without `FunctionError`; configured ARN only), and CLI/replay reporting (stdout empty on runtime failure, one stderr line).
4. **Test and validation quality:** Strong at the unit layer; revert-sensitivity confirmed for the four decisive behaviours. No skipped/only tests, no wall-clock sleeps, no secret or address in integration logging. One integration test overstates what it proves (F1).

## Plan compliance matrix

| Authority item                                                            | Expected evidence                                      | Implementation evidence                                                                                                      | Validation / test evidence                                                                        | Status                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------- |
| T1 ADR acceptance and supersession links                                  | ADR-0007/0008 Accepted; 0004/0005/0006 linked in place | Both ADRs carry Status/Accepted/Authority; supersession edits are 3–5 lines each                                             | formatter clean                                                                                   | Complete               |
| T2 four capabilities with exact bindings (ADR-0008 table)                 | Bindings only in `*StoreLive`                          | `Audience.ts:45-50` six; `Storage/Campaigns.ts:290-293` four; `Storage/Feedback.ts:184`, `Storage/Unsubscribe.ts:29` PutItem | grep of every `AWS.DynamoDB.*(table)` site; type-negative probe fails to build narrower factories | Complete (static)      |
| T2 deployed role policies (writer-only functions)                         | Effective IAM inspection                               | —                                                                                                                            | Claimed in T9; not reproduced                                                                     | Unverifiable (claimed) |
| T2 error boundaries: internal cause kept, safe public errors              | `publicly`/`publiclySent`/`reportedAndFatal`           | `Diagnostics.ts` — tag-or-name only; `SendFailure` unwraps `StorageFailure`                                                  | `Diagnostics.test.ts` exact fields; defect log under deployed logger carries no item values       | Complete               |
| T3 wire codecs, `optionalKey`, campaign cross-field validation preserved  | `Items.ts` codecs; no `readString` etc.                | Probe: absent optional keys absent; wrong kind fails; `decodeSubmission` matches main                                        | `Items.test.ts` 24; grep zero callers                                                             | Complete               |
| T3 BatchGet completeness                                                  | Pending-only retry, one deadline, fail on exhaustion   | `Primitives.ts:171-235`                                                                                                      | `Primitives.test.ts` on TestClock; probe                                                          | Complete               |
| T3 import holder `ConditionCheck`                                         | Condition in same transaction; no double-touch         | `Membership.ts:546-553`; branches never check and write one item                                                             | `Membership.test.ts:776-815` exact shape; live evaluation **not** exercised (F1)                  | Partial                |
| T4 token format, order, bound                                             | ADR-0007 payload; verify before decode; 407            | `Unsubscribe.ts:34-39, 73-104`                                                                                               | independent HMAC vector; 14 forgeries; over-bound; real router at 407                             | Complete               |
| T4 POST writes verified mailbox, no lookup; GET harmless                  | PutItem-only, no `getContact`                          | `UnsubscribePage.ts:52-61, 151-171`                                                                                          | zero writes on GET; one write on repeated POST; 500 on failed write                               | Complete               |
| T4 live A→B, delete, re-import                                            | Integration suite                                      | `Unsubscribe.integration.test.ts` present                                                                                    | Claimed 22/22; not run here                                                                       | Unverifiable (claimed) |
| T5 budget removal, `SendNotAttempted` gone, 60s/70s                       | No Clock arithmetic; timeout at CLI                    | `Campaigns.ts` has no budget; `Api.ts:33`; `Commands.ts:16,32`                                                               | manifest grep; slow-preflight test                                                                | Complete               |
| T6 app built once, request state request-local                            | `makeApiHandler`/`makeUnsubscribeHandler`              | `Api.ts:138-168`; `UnsubscribePage.ts:145-152`                                                                               | lifetime suites; installed `Context.merge`/`Layer.build` read                                     | Complete               |
| T6 CLI reports once on stderr, stdout clean                               | `disableErrorReporting`, `shouldReport`                | `main.ts:65-69`; `cli/Diagnostics.ts:23-24`; `ReplayFeedback.ts:271,285`                                                     | subprocess runs: exit 1, stdout 0 B on runtime failures                                           | Complete               |
| T7 `Stack.stage`, `timingSafeEqual`, Redacted token                       | No `EMAILER_STAGE`; guard before compare               | `Api.ts:97`, `UnsubscribePage.ts:128`, `Feedback.ts:194`; `Auth.ts:23-30, 46, 57`                                            | `Auth.test.ts`; bootstrap source supplies `Stack` from `ALCHEMY_*`                                | Complete               |
| T7 cold start without `EMAILER_STAGE`                                     | Deployed check                                         | —                                                                                                                            | Claimed in T9                                                                                     | Unverifiable (claimed) |
| T8 queue, OnFailure, SendMessage grant by construction, no receive/delete | Pinned `BindingHttp` grants on `yield*`                | `Feedback.ts:28, 234, 249`; `BindingHttp.ts:19-35, 59-61`; `EventInvokeConfig.ts` grants nothing                             | reading of pinned source                                                                          | Complete (static)      |
| T8 alarms deploy-only, resolved attributes, no actions                    | In Stack generator                                     | `alchemy.run.ts:35-59`; props match distilled `PutMetricAlarmInput`                                                          | reading                                                                                           | Complete               |
| T8 replay: bounded, configured target, `:$LATEST` exact, delete after 200 | `ReplayFeedback.ts`                                    | `:75-82, 154, 161, 182-190, 205`                                                                                             | 26 unit cases; subprocess runs                                                                    | Complete               |
| T8 live destination capture and replay                                    | Deployed exercise                                      | —                                                                                                                            | Claimed in T9                                                                                     | Unverifiable (claimed) |
| T9 suites split, `fileParallelism: false`, no secrets logged              | Config and support module                              | `vitest.config.ts`; `IntegrationSupport.ts` uses `Config.redacted`                                                           | log-site audit: ids only                                                                          | Complete               |
| T9 delivered message, DKIM coverage                                       | Manual inspection                                      | —                                                                                                                            | Claimed; `dkim=fail` gap documented honestly                                                      | Unverifiable (claimed) |
| Removal manifest (17 rows)                                                | Zero live hits                                         | grep across apps/, packages/, root files, wiki                                                                               | 16 rows zero; `EMAILER_STAGE` one prose hit in `wiki/alchemy/runtime-and-bindings.md:25`          | Partial (doc nit)      |
| Zero dependency changes                                                   | No lockfile/workspace/manifest change                  | diff stat                                                                                                                    | root `package.json` +1 script line only                                                           | Complete               |

### Approvals and conflicts

- **Approved deviation:** none needed. Clean cutover (no migration, no legacy decoder) is explicitly authorised in the plan and both ADRs.
- **Authority conflict:** none.

## Follow-up closure

- **Round and material delta:** round 2, after the user asked for the review's changes to be implemented. `apps/backend/test/IntegrationSupport.ts` gained an optional `beforeCommit` hook on `liveStorage`, run immediately before each transaction is sent; the stale-import test builds a second storage whose hook moves the contact off the address, so the move lands between `importContacts`' advisory read and its `TransactWriteItems`. The test now asserts a `StorageFailure` cancelled with exactly slot 2 — the holder check — failed. The stale `EMAILER_STAGE` wording in the wiki was replaced, and the plan record's T9 evidence corrected.
- **Closure state:** Clear.
- **Resolved or withdrawn:** F1 resolved. `pnpm check` green (lint, typecheck, formatter, 468 unit tests). The rewritten test ran against the live `test` stage that was already deployed in the account (deployed 2026-09-14 13:06 UTC, not by this review): 1 passed, refusal at slot 2. No revert run against the live table was made: the assertion on the exact failed slot cannot be satisfied by any other refusal path, and the unit test pins the condition's presence.
- **Still material:** none.
- **New fix-caused or fix-exposed findings:** none.

## Findings

### S2 / C3 — F1: the live stale-import test never evaluates the holder `ConditionCheck` it is named for

- **Dimension / authority:** tests and validation; plan T3 "A recording fake is not accepted as proof that DynamoDB evaluates the condition" and T9 "move/reassign the address after advisory reads, then execute the real transaction and assert no membership commit".
- **Location:** `apps/backend/src/Api.integration.test.ts:648-692`; guard at `apps/backend/src/Storage/Membership.ts:546-553`.
- **Evidence:** the test moves the address (`updateContact`, `:672`) _before_ calling `importContacts` (`:677`). The import's own advisory read (`Membership.ts:480-483`) then finds the reservation free, takes the new-contact branch (`:506-530`), and the refusal comes from the contact `Put`'s `attribute_not_exists(pk)` on the still-existing `CONTACT#original` — not from `contactId = :holder`. A throwaway probe with the same shape produced a transaction containing zero holder `ConditionCheck`s. The `if (imported)` branch at `:690-692` is unreachable.
- **Impact:** the plan record (T9), the PR description and commit `5d2396e` state that the stale-import interleaving was proven against AWS. It was not: DynamoDB's evaluation of `contactId = :holder`, including on a missing reservation item, remains unexercised. Removing the guard would not fail this test. Production risk is low — the guard is unit-pinned by exact transaction shape and DynamoDB's condition semantics are standard — but a decisive live check the plan required is recorded as done when it is not.
- **Safeguards considered:** `Membership.test.ts:776-815` pins the condition's presence and shape; the outcome assertion (`original` never joins under the address it left) does hold, via the other guard.
- **Condition:** deterministic on every run of that test.
- **Validation state:** confirmed by reading and by a scratch probe against the real `importContacts`; not run against AWS.
- **Smallest safe fix:** perform the address move inside the test's `transactWriteItems` wrapper (`IntegrationSupport.ts:98` already wraps it) so it happens between the import's advisory read and the commit, then assert `Result.isFailure` or a non-imported outcome and no membership. Alternatively, rename the test to what it proves and correct T9 and the review record. Either is a few lines; the first is what the plan asked for.

## Context-dependent concerns

- **DKIM `dkim=fail` at the receiver for the sending domain.** Documented candidly in the README and T9; the `amazonses.com` signature passed over an identical `bh=`, so the body and headers — and the plan's actual requirement, both unsubscribe headers inside the signature — are cleared. Cause not isolated. **Disposition:** ADR-0002's subject, not introduced by this branch; investigate on the next deployed run before trusting alignment.
- **Stale wiki example.** `wiki/alchemy/runtime-and-bindings.md:25` still says "`EMAILER_STAGE`-style values", naming a variable the code no longer has. **Disposition:** optional one-line doc fix; not a finding.
- **Missing contact after audience read answers 503 `StorageUnavailable`** (`Campaigns.ts:82-84`). Pre-existing on `main`, unchanged; noted only so nobody attributes it to this branch.

## Confirmed-good areas

- **Token verification order and bound:** length → structure → HMAC → decode → canonical → mailbox; independent `node:crypto` vector matches `mintToken`; non-canonical last-char variant of the same bytes rejected even when signed with the real key.
- **Public HTML surface:** three constant pages, no interpolation, no `action`, no hidden inputs, no cookies or redirects; an address with every permitted punctuation character rendered nothing of itself.
- **Router bound:** `RouterConfig.maxParamLength` reaches find-my-way and is enforced after percent-decoding; 254-byte address → 407-char token → 200.
- **Once-built app:** only immutable services captured; per-invocation Scope survives `provideContext`; 401 answered with zero storage reads.
- **Import transaction:** never checks and writes the same item; 81 distinct keys at 20 candidates; slot 0 stays the list-missing signal.
- **BatchGet:** one raise site, one catch site, exhaustion → `unavailable`, missing item stays missing, one outer deadline including backoff sleeps.
- **IAM by construction:** pinned `BindingHttp` registers `sqs:SendMessage` on `yield*` without a call; `EventInvokeConfig` grants nothing (its own retry on "role does not have permissions" proves it).
- **Replay:** invoke bounded at 45s inside 120s visibility; delete only after `200` with no `FunctionError`; target is the configured ARN; exact `:$LATEST` suffix only; failed delete leaves the message and exits nonzero.
- **CLI and replay reporting:** runtime failures → exit 1, stdout 0 bytes, one stderr line; `errorReported` polarity correct against `Runtime.ts:344,365`.
- **Defect logging at the `orDie` boundary:** under Alchemy's deployed pretty logger, a transport error wrapping a PutItem body with an address printed message, stack and cause chain only.
- **Tests:** no skipped/only, no wall-clock sleeps, four decisive behaviours revert-sensitive, no secret or address in integration logs.

## Limitations and caveats

- Everything under T9's deployed evidence is taken as a claim. Reproducing it means a fresh `--stage test` deployment and a live run, which the user did not ask for in this review.
- The `LastEvaluatedKey: {}` → corrupt path is unproven on the wire; the branch's own live listing tests postdate the change and passed, per the record.
- One lane's probe sent a single unauthenticated request to the real SQS endpoint; nothing was created or modified.

## Next steps

1. Commit the round-2 changes on `clean-codebase`; nothing from this review then stands in the way of merging.
