# Clean codebase — final plan-backed review

> **Reviewed:** 2026-09-14 · **Scope:** the whole `clean-codebase` branch against the plan, with emphasis on T5–T8 and the removal manifest · **Result:** Clear after five dispositions.

An independent reviewer read the branch against the plan with no access to the earlier reviews' conclusions. It reproduced its claims by execution rather than by reading, including establishing a lint baseline on `main` in a throwaway worktree. It made no AWS calls and deployed nothing.

Six findings. One was a real defect in the operator tool; one was an overstatement in this document's own evidence; the rest were small and are fixed. Nothing was rejected.

## F1 — The replay tool reported every failure twice, once on stdout · Fix now · **Fixed**

`ReplayFeedback.ts` called `NodeRuntime.runMain(program)` without `disableErrorReporting: true` and tapped the cause without a `shouldReport` guard. Both are precisely the traps the plan names under _Critical implementation details → CLI_, and both are what `apps/cli/src/Diagnostics.ts` exists to prevent — the CLI entry point passes the option and guards the tap; this one did neither. The runner adds its own reporter _outside_ the program's context and can write to stdout, which for this tool is the list of message ids it replayed.

The reviewer proved both halves by running the command. So did I, against the fix:

| Case                                   | Before                                                                                                                                                              | After                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Expired credential                     | stderr diagnostic **plus** a timestamped `ERROR` and ten frames of `node_modules` stack on **stdout**                                                               | one `emailer: replay stopped — {…}` line on stderr, **stdout empty**, exit 1 |
| `--queue-url` with no `--function-arn` | the framework's own "Missing required flag", then a raw `ShowHelp` dump carrying `"~effect/Runtime/errorReported": false` — the marker that says _already reported_ | the framework's line alone, exit 1                                           |

Fixed by giving the tool the same policy the CLI has: `shouldReport`, a `reportCause` that writes only when it should, and `disableErrorReporting: true`. `apps/backend/src/ReplayFeedback.test.ts` now pins the policy — a self-reporting failure and an interruption stay silent, a refusal and a defect do not.

**On the duplication.** The policy is now stated in two files. A shared module would need a new package or a dependency between two apps that have none, which is more machinery than twenty lines across two call sites deserves; the comment in each names the other. That the two _drifted_ is what this finding is, so the duplication is a deliberate choice with a known cost, not an oversight.

## F2 — This document overstated what the CLI subprocess tests assert · Fix now · **Fixed**

The T6 record claimed all three subprocess cases assert "a nonzero exit, a non-empty stderr and an empty stdout". The out-of-bounds attribute-map case asserts a nonzero exit, that stdout carries no result document, and that the service was never called. It _cannot_ assert an empty stdout: Effect's CLI writes its help document to stdout for every validation failure, which is the framework's output and not ours. The code and the test were right; the claim about them was not. The record now says what each case actually settles.

## F3 — The wiki still showed `alchemy plan --detailed` · Fix now · **Fixed**

The removal manifest routed the unsafe example at "README/**wiki**", and only the README was corrected — `git diff main..HEAD -- wiki/` was empty. The example in `wiki/alchemy/cli-and-deployment.md` no longer carries the flag, and the paragraph that explains it now says why: redaction is the property's own declaration, so a value the Stack did not mark secret prints in full.

## F4 — The classification fallback could not fire for a native error · Fix now · **Fixed**

`describeCause` read `name` with a schema, which sees own properties; `Error.prototype.name` is not one, so `new TypeError("boom")` classified as `"unknown"`. The test exercised that branch with an object shaped like an AWS SDK exception, which _does_ own `name`, so it passed while the case it stood for did not work. Impact was small — everything reaching it from `@distilled.cloud/aws` and from Effect carries `_tag` — but a defect leaking into a storage cause logged as nothing at all. One `instanceof Error` fallback, and the table now pins `TypeError` and `Error`.

## F5 — A test asserting the framework back to itself · Fix now · **Fixed**

`SendNotAccepted`'s field assignment and `Result.fail` cannot fail for any change to that type. Removed. The marker behaviour that matters is covered decisively elsewhere in the same file.

## F6 — `pnpm check` was red at `50b5a93` · Validate · **Already fixed**

A branch regression, confirmed against `main` in an isolated worktree with the same pinned `oxlint@1.82.0`: one missing blank line in `Api.integration.test.ts`. `b554ae4` fixed it mid-review, along with restoring the document's status and removing its link to this file before this file existed.

## Verified clean

Recorded because the reviewer established these by execution, not by reading:

- **Removal manifest:** every row absent by grep across `apps/`, `packages/`, `alchemy.run.ts`, `package.json`, `.env.example`, `README.md`. `Storage/Table.ts` is 27 lines of resource declaration. All 16 planned new files exist.
- **Nothing the plan rejected was added,** and **zero dependency changes** — no workspace, lockfile or package manifest touched beyond one script entry.
- **T5:** duplicate prevention never was the budget's job. The conditional `TransactWriteItems` claim is untouched, a killed invocation leaves a durable claim that refuses the retry, and CLI 70s > API 60s so a caller never abandons a send the service is still answering.
- **T6:** `Effect.provideContext` merges rather than replaces, and Alchemy makes a fresh `Scope` per invocation, so the instance-lifetime capabilities cannot displace a request's scope. Proven against pinned sources and by a two-request lifetime test.
- **T7:** `tokensMatch` compares byte lengths, which is the right guard — a character count would be wrong for multibyte input and the primitive throws on mismatch.
- **T8:** `namesConfiguredFunction` is exact equality against the ARN or the ARN with exactly `:$LATEST`; the invoke always targets the configured function, never the record's; nothing is deleted before the invoke returns; the SQS grant is `sqs:SendMessage` alone.

## Closing checks

`pnpm check` green at the disposition commit: formatter clean over 99 files, `oxlint --type-aware --deny-warnings` clean, `tsc --noEmit` clean, **468 unit tests in 23 files**, import probe exit 0. The two `ReplayFeedback` reproductions above were run against the built tool. No live suite was re-run: every fix is in an operator entry point, a schema fallback, a test and documentation, and no deployed behaviour changed.
