# Campaign scheduling: strict calendar validation

- Date: 2026-09-17
- Scope: resolve PR #10 finding F1; implementation detail of [ADR-0015](../0015-one-shot-scheduler-per-campaign.md).
- Authority: user requested the cleanest solution and authorized refactors where useful.
- Status: complete. PR #10 finding F1 resolved; independent review Clear; local and live checks passed; ephemeral stage destroyed.

## Problem and decision

The shared `Timestamp` schema checked only the shape of a UTC string. An impossible `sendAt` could reach the domain, replace the persisted schedule intent and run token, and delete the working timer before AWS rejected its replacement. The CLI also normalized impossible days before sending them, making the user's mistake invisible to the API.

Keep the existing canonical UTC string representation throughout HTTP, storage and pagination. Strengthen its single shared schema: a timestamp must match the fixed-width pattern, parse through Effect `DateTime.make`, and format back to exactly the entered value. Parsing alone accepts calendar overflow. The domain retains the clock-dependent future check: malformed input is HTTP 400; a valid past instant is 409.

At the CLI boundary, accept an explicit ISO subset: date-only, or a date and time with hours/minutes, optional seconds, up to three fractional digits, and optional `Z` or `±HH:mm` offset. Missing zones mean UTC. Pad the entered calendar fields and validate them through the shared `Timestamp` before Effect applies the offset. Validate the normalized result too, so offsets cannot produce a year outside the four-digit wire contract. Keep this codec beside the scheduling command, its sole caller.

## Alternatives considered

- **Only check finite parsing in the domain:** still accepts normalized impossible days and duplicates a contract invariant after HTTP decoding.
- **A scheduling-only timestamp schema:** leaves other consumers of `Timestamp` trusting a shape that does not guarantee a real instant.
- **Migrate timestamps to `DateTime.Utc` objects everywhere:** adds conversions across API, DynamoDB and cursor boundaries, while the raw parser still needs calendar validation. The existing fixed-width strings already support ordering and roundtripping.
- **Add a date library or custom leap-year arithmetic:** unnecessary; Effect parsing plus exact roundtripping provides the required calendar check.

The shared schema narrows invalid inputs without changing valid wire/storage values. The CLI deliberately rejects non-ISO date spellings, `24:00`, extra fractional precision and trailing whitespace rather than silently rewriting them. Scheduler persistence, run-token transitions and recovery remain as accepted in ADR-0015.

## Validation and review

- Regression tests ran before production changes: 15 expected failures, 188 passes. They exposed shared-schema acceptance, HTTP mutation on invalid reschedules, and CLI normalization.
- Focused tests after the implementation: 203/203 passed across the schema, HTTP API and CLI suites.
- HTTP tests use raw requests through the real router/domain and prove HTTP 400, unchanged campaign and run token, and no storage mutations, scheduler calls or queue wakes.
- CLI process tests cover valid leap dates, offset rollover, date-only input, fractional seconds and zone-less UTC behavior; invalid input exits before any HTTP request.
- Independent read-only design assessment and implementation review: Clear, no material findings. A final delta review confirmed the Effect-native parser and HTTP regression request changes.
- Formatting, lint (warnings denied), typechecking and import smoke checks passed. All 655 tests passed across 29 files with `--maxWorkers=2`. The first unrestricted run had 654 passes and one existing CLI flow timeout under heavy machine load; that test passed alone in 3.57 seconds, then passed in the complete 54.90-second rerun. No timeout or test expectations were relaxed.
- Independent final documentation review: Clear. CLI formats, HTTP errors, deployment order and timing/recovery guidance match the implementation.
- Ephemeral AWS stage `test`: first deploy encountered AWS `InvalidParameterValueException: Internal KMS service error` while creating the dispatch event-source mapping. Alchemy destroy removed its tracked resources; the interrupted Lambda creation left one stage-tagged dispatcher IAM role, which was explicitly removed after checking ownership and attached policies. Inventory then confirmed no test-stage resources. The second deploy succeeded.
- Live HTTP probe: created an empty-audience campaign and scheduled it an hour ahead. Invalid month, non-leap February 29 and April 31 requests each returned 400; a valid past instant returned 409. After each invalid request, the complete DynamoDB `META` item and AWS `GetSchedule` response were unchanged, as was the campaign returned by the API. Cancellation returned it to draft and removed the schedule.
- Live CLI probe: impossible February 29 failed calendar validation and left the campaign in draft.
- Full live integration suite: 26/26 passed across three files in 435.21 seconds. The scheduled campaign started at `2026-09-17T12:22:49.397Z` for `sendAt` `2026-09-17T12:22:00.000Z` (+49.397 seconds) and completed; cancellation, subsequent sending, feedback, guardrails and unsubscribe checks passed.
- Final teardown: Alchemy destroyed all 28 managed resources. Independent AWS inventory returned zero test-stage functions, tables, queues, alarms, schedule groups, roles, log groups, topics, EventBridge rules, SES configuration sets and Lambda event-source mappings. Shared sending identity and bootstrap resources were untouched; private temporary environment files were removed.

Deployment also emitted Alchemy/Rolldown unresolved-import warnings for optional Bun services and Vite tooling. Source inspection confirmed Node Lambda uses NodeServices; Bun imports are platform-conditional, and esbuild/devtools belong to unused build-tool paths. Inspection of all four deployed ZIPs found deferred Bun/esbuild references still present, with no devtools references. These upstream graph warnings are recorded rather than concealed by installing unused peers or suppressing diagnostics; the API and CLI live probes passed against those bundles.

Documentation also corrects the review's operational risks: complete both Lambda updates before enabling scheduling, and do not infer a failed fire from the elapsed wall-clock minute or schedule presence alone. These clarify existing behavior without introducing new infrastructure.

## Merge and cleanup

The user explicitly requested merge, commit, push and worktree cleanup on 2026-09-17. PR #9 was still open, but scheduling has no runtime dependency on it, so this authorization superseded the original segmentation-first merge order. `main` was merged into the scheduling branch without conflicts; only the six existing review documents were added, leaving the previously deployed application and dependency files unchanged. A fresh unrestricted `pnpm check` passed all 655 tests plus formatting, lint, typechecking and import checks. GitHub's check for `abd155c` also passed.

PR #10 was merged with `--no-ff` as `4e37835` and pushed to `origin/main`; GitHub confirmed it merged. The merge tree matched the validated scheduling branch, and all pre-existing main-branch review documents were preserved. The scheduling worktree and local/remote branch were removed. The segmentation worktree and PR #9 remain for their separate integration.

## Sources

- [Schema and configuration wiki](../../wiki/effect/schema-and-config.md), [CLI wiki](../../wiki/effect/http-cli-and-runtime.md), [Scheduler wiki](../../wiki/aws/scheduler.md).
- Installed Effect `4.0.0-rc.112`, `src/internal/dateTime.ts` and `src/Schema.ts`: string parsing can normalize calendar overflow; `DateTime.make` returns an `Option`, and `DateTime.formatIso` yields the canonical UTC representation.
- [ECMAScript date-time string format](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date-time-string-format).
