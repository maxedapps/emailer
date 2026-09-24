# Plan review: review fixes and simplification

## Review constraints

| Axis | Selection |
|---|---|
| Target | [review-fixes.md](review-fixes.md), draft of 2026-09-23 |
| Baseline | Plan-backed: the 14 findings of the 2026-09-23 whole-codebase review and its follow-ups, plus the user's decisions on ADR-0016, delivery and sequencing |
| Scope | Full plan; rounds 2–3 were focused on the revised sections |
| Invocation | Embedded in `create-plan` |
| Dimensions | Coverage, feasibility against the installed Effect rc.117 and Alchemy beta.79, false-green checks, sequencing, complexity, ADR consistency |
| Validation/tools | Read-only on the repo. The reviewer applied the riskiest changes in a scratch copy and ran tsc, lint and the unit suite (T3, T4, T5, T8, T9). No AWS, no integration run |

## Round 1 — Changes required

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R1 | S2 | T5's `listMembers` change fails `Membership.test.ts:266`, which pins the `localeCompare` sort. The plan misdescribed that test as covering batch reordering | Accept: T5 rewrites the fixture (query `[c1, c2]`, batch `[c2, c1]`, expect `[c1, c2]`) |
| R2 | S2 | T8's `instanceof Error` rule leaves `ConfigError`, which is not an `Error`, printing the schema tree. The Verify step used port 9, which fetch blocks itself | Accept: key on a string `message`; add a missing-config case; use a refused port (59999) |
| R3 | S1 | T3's new stub case can't fail if the Live mapping is missing | Accept: the case is dropped, and the Live mapping is stated as untested wiring |
| R4 | S1 | A fourth test pins capitalised headings (`Campaigns.test.ts:648`), and the ADR amendment used a nonstandard header | Accept: add `:648`; use `- Amended: [review-fixes](…)`, which also mentions raw HTML and task boxes |
| R5 | S1 | Missing ADR-0020 → 0016 forward link; stale ADR-0018:75 path; a line-number citation that would drift | Accept |
| R6 | S1 | T11's commit would have landed after the push | Accept: reordered as T11 live gate → T12 confirmation → T13 delivery; `sender-name` overlap corrected to `Mailer.ts` + `README.md`, with no overlapping hunks |
| R7 | S1 | T1's third case duplicates `Dispatching.test.ts:940` | Accept: dropped, so the file has 32 cases |

## Round 2 — Changes required

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| N1 | S2 | The reworded T8 rule could be read as printing a `ConfigError`'s message twice, and its Verify demanded one line where the correct output has two | Accept: follow `.cause` only while the current value is an `Error`; Verify checks there is no repeat |
| N2 | S1 | T3 claimed the service type protects the Live mapping, but `never` is assignable to `StorageFailure` | Accept: "review only" |
| N3 | S1 | T13 expected PR checks, but the repo has no CI | Accept |

## Round 3 — Clear

No new findings. The coverage check mapped every one of the 14 findings to a task or an out-of-scope line.
