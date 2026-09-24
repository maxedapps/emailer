# Combined campaign live acceptance — 2026-09-17

Status: Passed. The ephemeral deployment was destroyed and independent AWS inventory confirmed cleanup.

## Scope and authorization

The user authorized deploying, driving, monitoring and removing an ephemeral AWS test stage, with campaign mail restricted to SES mailbox-simulator recipients and email alert subscriptions disabled. The target is `Emailer/test`, AWS account `123456789012`, Region `us-east-1`, application commit `62d5888ebd5ceb424014a8947e38b6ca4c210a29`.

This validates the merged scheduling, segmentation and HTML implementation. It follows the [next-lanes roadmap](campaigns-next-lanes.md) and the existing [deployment runbook](../../README.md#develop-and-test). Application source and dependencies are unchanged. The merged commit already passed 665 unit tests and the repository checks; this run focuses on the deployed system.

## Deployment

Before deployment, AWS inventory showed no Emailer functions, tables, queues or schedule groups. SES sending and production access were enabled, with a 26/second account rate and 50,000/day quota. The retained `mail.example.com` identity reported verified sending, successful DKIM and successful custom MAIL FROM.

The explicit `--stage test --profile emailer-test` plan contained 28 creates. Deployment succeeded for all 28 resources. AWS CLI profile `deploy` supplied temporary environment credentials to both Alchemy and the integration runner. A private temporary configuration held fresh deployment outputs; existing repository environment files were preserved. `EMAILER_ALERT_EMAIL` was absent, and the stage alert topic had zero subscriptions.

A supervising shell installed teardown on exit, including failure paths. It waited for configuration, ran the live suite, allowed the bounded CLI investigation, and destroyed this stage. The shared `EmailerSending/shared` stack and bootstrap buckets are outside that teardown.

## Automated validation

**Passed: 27/27 tests across three files in 386.44 seconds, with no failed or skipped tests and no rerun.** Command: `node node_modules/vitest/vitest.mjs run --project integration --reporter verbose`, with temporary AWS credentials and freshly resolved test-stage configuration supplied privately.

The suite exercised pacing across pages, concurrent submissions, HTML persistence, segmentation, scheduled firing and cancellation, the 400-member bounce breaker, forced-alarm pause/resume, account suppression operations, simulator-only and authentication rejection, real DynamoDB conditions/indexes/cascades, bounce/complaint feedback, and unsubscribe behavior.

The scheduling case requested `2026-09-17T15:02:00.000Z` and started at `15:02:14.205Z` (+14.205 seconds). The bounce-breaker campaign accepted 200 recipients and paused for feedback; the full test also waited for every accepted simulator bounce to be counted.

## Combined CLI exercise

**Passed through the real CLI and public unsubscribe endpoint.** Run `combined-11c89e68f590` created four uniquely labelled success-simulator contacts: two with `plan=pro`, one with `plan=free`, and one with no attributes. Every member was checked before submitting the campaign. Text, HTML and filter were preserved through create/read.

| Check                                                                   | Observed result                                                                                                                                     |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled filtered HTML campaign `f75655ae-f453-4b64-b5f2-23a7ebd570c4` | Requested `2026-09-17T15:07:00.000Z`; started `15:07:37.194Z` (+37.194 seconds); completed with accepted 2, rejected 0, uncertain 0, skipped 0      |
| Actual recipients                                                       | Exactly two accepted `SEND#` rows, for simulator labels `success+combined-11c89e68f590-0` and `-1`; no rows for the free or attribute-less contacts |
| Cancelled campaign `80ebd448-7d0f-4851-a3cb-51cfd9bb5c09`               | Removed from AWS Scheduler; remained draft with zero send rows after its former due time                                                            |
| Unsubscribe                                                             | GET served the confirmation page and left the address mailable; two one-click POSTs succeeded and left it unsubscribed                              |
| Follow-up HTML campaign `0f14945d-51c9-439a-8c25-c9f7b315a4c4`          | Accepted 1, skipped 1, rejected 0, uncertain 0; skipped row explicitly says `unsubscribed`; non-matching contacts again had no send rows            |
| Scheduler after completion                                              | No remaining schedules in the test-stage group                                                                                                      |

Across the entire stage, a consistent-read audit found **285 send rows: 281 accepted and four skipped**, covering 280 distinct addresses. Every row named a success, bounce or complaint address at `simulator.amazonses.com`. No test-recipient entry remained newly added to the account suppression list. The first temporary audit query also selected feedback rows because they carry `recipient`; its summary failed on the missing `state`. The query was corrected to select `SEND#` records and rerun successfully. This was an inspection-script error; the application tests and CLI scenario passed on their first runs.

## Monitoring and warnings

Deployment emitted unresolved-import warnings for optional Bun services, MongoDB, Cloudflare Workers and Vite tooling. Installed source and all four deployed ZIPs were inspected. MongoDB, `cloudflare:workers` and Vite devtools references are absent from the deployed JavaScript. Bun imports remain behind platform selection, which uses Node services in Lambda; the remaining esbuild import is deferred in an unused Vite build-tool path. This matches the earlier [scheduling deployment investigation](campaign-scheduling-input-validation.md#validation-and-review). These upstream packaging warnings remain visible and are not suppressed or worked around by installing unused runtime dependencies.

At the final snapshot (`2026-09-17T15:08:27Z`), all three queues reported zero visible, in-flight and delayed messages; all seven alarms were `OK`; and the alert topic still had zero subscriptions. Available CloudWatch metrics reported zero errors and zero throttles for each of the four functions. These are the metrics returned at observation time, subject to CloudWatch publication delay.

The inspected Lambda log window contained 814 API events, 65 dispatcher events, 506 feedback events and 44 unsubscribe events. There were no runtime error entries. The sole warning was `unsubscribe token refused`, expected from the deliberately forged-token test. Both failure queues remained empty during the sampled checks.

## Teardown and limits

Alchemy destroy exited zero and reported **28 succeeded** at `2026-09-17T15:10:29Z`. Independent AWS inventory then returned zero test-stage Lambda functions, DynamoDB tables, SQS queues, IAM roles, CloudWatch alarms, log groups, SNS topics/subscriptions, EventBridge rules, SES configuration sets, Scheduler groups and Lambda event-source mappings. The inventory query explicitly normalized the AWS CLI's empty SQS response before asserting the final result.

The shared sending identity still reported verified sending, successful DKIM and successful custom MAIL FROM; the shared state and asset buckets remain. All test processes finished. Private temporary configuration, scripts, downloaded Lambda bundles and operational logs were removed after recording the results here. No worktree was created.

Simulator success establishes SES acceptance and the exercised AWS workflow. This run does not inspect received MIME, inbox placement or real mailbox rendering. It does not prove reputation thresholds using real bounces: the suite forces the test-stage alarm state to verify the pause/resume response. No production code was mutated to manufacture regression sensitivity during this operational run.
