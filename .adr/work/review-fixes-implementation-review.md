# Implementation review: review fixes and simplification

## Review constraints

| Axis | Selection |
|---|---|
| Target | Branch `review-fixes`, `9ebb2fc..6139b21` (T1–T10, before the merge of `main`) |
| Baseline | Plan-backed: [review-fixes.md](review-fixes.md), its [plan review](review-fixes-review.md), AGENTS.md and the accepted ADRs |
| Invocation | Independent reviewer; read-only on the repository; checks run in a scratch export of the branch |
| Dimensions | Plan compliance, correctness (send path, error typing, storage request shapes, CLI rendering, the Markdown text part), test quality, scope and simplicity, doc accuracy |
| Validation | Typecheck exit 0, lint 0 diagnostics, format clean, 889/889 unit tests. CLI runs covered a refused port, an unset URL, a duplicate `--to` and the body refusals. The Markdown text part was compared against `9ebb2fc` on 46 adversarial inputs, with the HTML part byte-identical. The leak grep was case-insensitive. No AWS; the live gate is T11. |

## Verdict

**Clear.** No findings admitted.

## Plan compliance

| Task | Status | Deviation judged |
|---|---|---|
| T1 Send-path tests | Implemented. Mutations of the backoff sleep and the uncertain resend each fail a test. | — |
| T2 One settlement | Implemented. Behaviour is identical for accepted, ordinary rejection, rate-limited with and without backoff left, sending-paused and uncertain; settle still comes before pause. | — |
| T3 Admission failures | Implemented | Reworded comment: harmless |
| T4 Types at the boundary | Implemented | Doc comment trimmed: harmless |
| T5 Order by key | Implemented; fixture rewritten as planned | — |
| T6 Slice margin | Implemented | — |
| T7 Copied shapes | Implemented; condition expressions and records unchanged | `pauseRun` form: harmless |
| T8 CLI errors | Implemented; all planned tests present | One refusal wording; two copies of the helper: harmless |
| T9 Markdown text part | Implemented; HTML part unchanged | Checkbox override and doc rewording: harmless |
| T10 Docs | Implemented; each edit matches the code and ADRs | — |

## Note

The plan still quoted the two replaced fixtures. They are fixed in the plan along with the T11 evidence.
