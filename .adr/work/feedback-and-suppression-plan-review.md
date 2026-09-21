# Feedback and suppression — plan review

Independent adversarial review of the draft [feedback and suppression plan](feedback-and-suppression.md), before any implementation. The reviewer changed no file and ran no cloud command, and verified claims against the installed Alchemy 2.0.0-beta.77 source, current AWS documentation and the existing implementation.

## Verdict

**Clear** after two rounds. **Not Clear** on the first draft: twelve findings, five of which would have let the required outcome fail with every named check passing. All twelve are dispositioned below and the plan has been revised. The revision **removed** a task rather than adding one.

## Dispositions

| ID  | Severity    | Subject                                                        | Disposition               |
| --- | ----------- | -------------------------------------------------------------- | ------------------------- |
| F1  | High        | Suppression key could not match the bounce payload             | **Accept**                |
| F2  | High        | Handler had no defined source for the configuration-set name   | **Accept**                |
| F3  | High        | The reconciliation task was not implementable as scoped        | **Accept — task removed** |
| F4  | Medium-High | `complaint@simulator` would pollute the shared account list    | **Accept**                |
| F5  | Medium-High | Classification contradicted its own research and was inverted  | **Accept**                |
| F6  | Medium      | "Not a replacement" was unobservable                           | **Accept**                |
| F7  | Medium      | `createRecord` cannot express "conditional failure is success" | **Accept**                |
| F8  | Medium      | T3 left the tree red and could not detect it                   | **Accept**                |
| F9  | Medium      | The decode-mismatch rule built a poison pill                   | **Accept**                |
| F10 | Medium      | The no-DLQ reasoning was partly wrong                          | **Accept**                |
| F11 | Medium      | Scope: `DELIVERY`, history records, unattributed partition     | **Partially accept**      |
| F12 | Low         | Four smaller corrections                                       | **Accept**                |

### F1 — the suppression key could not match the payload

Verified: `normalizeEmailAddress` (`packages/api/src/Schemas.ts:17-26`) lowercases only the **domain** and preserves local-part case. A bounce payload's `bouncedRecipients[].emailAddress` comes from the receiving MTA's DSN `Final-Recipient` and is not guaranteed to match the case we sent, so `SUPPRESSION#User@Example.com` and `SUPPRESSION#user@example.com` would be different partitions and the guard would miss. The mailbox simulator echoes the exact address sent, so the live test could not have caught it either.

Fixed with a suppression-only, fully-lowercased key builder used on both write and read, leaving the contract-visible `normalizeEmailAddress` untouched. AWS's own statement that SES "treats addresses with different cases as identical" for sending supports case-insensitive keying. The T2 test is restated as a local-part case variant being refused.

### F2 — no defined source for the configuration-set name

The `ses:configuration-set` tag carries Alchemy's generated **physical** name, not the logical ID, and the draft never said where the feedback function obtains it. The dangerous repair is re-declaring `ConfigurationSet("EmailerMail", {})` in the second module: registration is idempotent by fully-qualified name and the **first** site's props win, with `Resource.ts:397` carrying an unimplemented `TODO` for precisely this. If the feedback function registered first, its bare props would silently discard the `suppressedReasons` from T3 — no error, no plan hint.

Fixed by exporting the `ConfigurationSet` declaration from `Mailer.ts` the way `dataTable` is exported from `Storage.ts`, and pinning the name into the feedback function's `env`.

### F3 — the reconciliation task was not implementable, and is no longer needed

The draft exposed reconciliation as a CLI command. The CLI imports only `@emailer/api/*` and [ADR-0001](../0001-resource-owning-effect-services.md) states that CLI consumers "do not import the Lambda, backend implementations or Stack"; the feedback Lambda has no Function URL. Reconciliation would therefore have required a new endpoint, contract schemas, a route, and `ListSuppressedDestinations` IAM on the API Lambda — none of it in the plan, and its stated dependency was wrong. It would also have paged an account-wide list shared with any other SES sender on the account, pulling third-party recipient addresses into our table, inside a 30-second Lambda with no resume point.

**The task was removed rather than expanded.** Working through the reviewer's alternative produced a better mechanism: because T3 enables SES-side suppression, a lost event heals on the next send — SES accepts the message, does not send it, and emits a bounce with subtype `OnAccountSuppressionList`, which the corrected classification suppresses. One wasted SES call, no new endpoint, no third-party data. This depends on F5's correction and is why the two are linked.

### F4 — the complaint test would have polluted a shared resource

AWS documents the suppression-list exemption for `bounce@simulator` only. Nothing exempts `complaint@simulator`, and T3 enables `COMPLAINT` suppression, so the complaint run would have added a permanent entry to the **account-level** list — the shared, non-ephemeral resource the Open gate is about, untouched by `alchemy destroy`. A second run would then have observed an echo instead of a complaint, silently testing nothing.

Fixed with documented label addressing (`complaint+<runId>@simulator.amazonses.com`) and a post-teardown check for any `simulator.amazonses.com` entry.

### F5 — classification was inverted against the slice's purpose

Four defects with one root cause. The draft contradicted its own research on `auth-failure`; carried `UnsubscribedRecipient`, which is not in the event-publishing subtype list; and — most importantly — **declined to record the echo subtypes**, which is backwards. An echo is proof the address is already suppressed at SES; refusing to record it locally guarantees we call SES again on every subsequent send, forever.

The discriminating principle the draft was missing: SES-side suppression governs delivery, so local classification only governs whether we refuse _before_ the call. Every local exception therefore makes us looser than SES, and each buys a wasted call and a misleading `accepted` state. Collapsed to: `Permanent` ⇒ suppress, echoes included; `Transient` and `Undetermined` ⇒ record only; complaints ⇒ suppress unless `not-spam` or `auth-failure`. Subtypes are persisted for diagnostics without branching. This also removed a fragility: the draft's rule depended on the simulator producing `General` or `NoEmail`, which AWS does not document.

### F6, F7, F8, F9 — checks that could not fire, and two real defects

- **F6:** both tasks expected an "in-place update, not a replacement" of the configuration set. The `test` stage was destroyed at the end of the previous slice, so `alchemy plan` will legitimately report every resource as a create and the check could never fire. The property is true but is established by source inspection, which the plan now says.
- **F7:** `createRecord` (`Storage.ts:174-181`) maps **every** failure, `ConditionalCheckFailedException` included, to `StorageFailure{reason:"unavailable"}`. Naive reuse would have made every redelivered event a failure, which in the feedback handler becomes a defect, a 24-hour retry loop and — with no DLQ — a lost event. The plan now names an explicit `catchTag`, and the redelivery tests must use a double raising that exact tag.
- **F8:** renaming `EMAILER_ALLOWED_RECIPIENT` breaks `Campaigns.ts`, `Campaigns.test.ts`, `Api.integration.test.ts` and — which the review missed — `Api.test.ts`. T3's verification ran only `Mailer.test.ts` and `alchemy plan`, and Node strips types rather than checking them, so T3 could have been declared done with the repo not compiling. T3 now updates every consumer and verifies with `pnpm typecheck` plus the full unit suite.
- **F9:** treating a decode mismatch as a failure built a poison pill — a deterministic failure retried for 24 hours and then lost — and contradicted the draft's own rule to ignore events from other configuration sets. Anything unrecognised is now logged and succeeds.

### F10 — the no-DLQ reasoning was partly wrong; the conclusion stands

The draft claimed a DLQ "cannot address the dominant loss mode". Two distinct loss modes exist: SES-side best-effort publication, which no DLQ addresses under any composition, and post-bus retry exhaustion, which a DLQ does address. The reviewer also showed `AWS.EventBridge.events(...).toLambda(fn, { DeadLetterConfig })` is a real alternative that the draft called impossible rather than disproportionate. The plan and ADR-0003 now state this accurately, and F9's correction removes the main way a handler fails permanently.

### F11 — scope, partially accepted

Accepted: `DELIVERY` earns nothing in this slice — nothing reads a delivery record, and it was the sole reason for a second dedup-key scheme, since delivery events carry no `feedbackId`. Dropped from both `kinds` and `matchingEventTypes`. Also accepted: the `FEEDBACK#unattributed` partition was dead — every send tags `campaignId` and other configuration sets are already discarded — and an unbounded single partition is a DynamoDB anti-pattern shipped for a case that cannot occur. Removed.

Rejected: dropping bounce and complaint history. `wiki/aws/sns-and-feedback.md` states the principle as repository authority — "keep delivery history and suppression as separate dimensions rather than one last-event-wins status" — and the records share the write path with suppression, so they cost almost nothing. The reviewer's observation that nothing in this slice _reads_ them is fair and is recorded, not hidden.

### F12 — smaller corrections, all applied

The Virtual Deliverability Manager justification for the handler filter was wrong, because the helper always sets `detail-type`; the filter is still needed because the pattern does not constrain the configuration set, and the rationale is corrected. The requirement-erasing cast citation was wrong and the analogy to the previous slice's `Stage` defect overstated. `complaintSubType` is now mentioned and persisted. The allowlist widening is confirmed as not scope creep, with the alternative the draft skipped — permitting `*@simulator.amazonses.com` plus one real address — now recorded with the reason it was not taken.

## Net effect

The revision removed one task, one record type, one dedup scheme, one DynamoDB partition, one event type and one configuration-set re-declaration hazard, while adding one exported declaration and one lowercased key builder. The plan is shorter and its central guarantee is stronger: seven tasks instead of eight.

## Second round

The revision was re-reviewed. The reviewer independently verified the **self-healing claim** link by link against AWS documentation and confirmed it: SES adds only hard bounces to the list, which matches our `Permanent` rule; configuration-set scoping means healing does not depend on the account-level setting, which matters given the shared SES account; a send to a suppressed address is accepted but not sent; that produces a real feedback event, not merely a metric; and our rule catches it. The eleven applied dispositions were confirmed correct with no faults found.

Four further findings, all small and all applied:

- **N1 — the complaint half of the healing path was undefended.** An address suppressed for `COMPLAINT` does not echo as a bounce; it echoes as a complaint carrying `complaintSubType: "OnAccountSuppressionList"` and, having no ISP feedback report, no `complaintFeedbackType`. The plan's "absent still suppresses" rule caught it — but by coincidence rather than by design, and the bounce bullet carried a protective rationale the complaint bullet did not. Anyone later adding the obvious-looking third exception would have broken complaint healing with no test failing. The rationale and a test case are now on the complaint side too.
- **N2 — the removed task left behind an instruction to grant privilege that is now unused.** With reconciliation gone, no Lambda in this slice calls any SES suppression API, yet both the Research section and T7's Verify still said those actions are "necessarily granted on `*`". Left in a Verify step, that would have led an implementer either to accept a `*` grant that should not exist or to add one to satisfy the check. Both mentions are replaced with the sharper assertion that the feedback role must contain **no** SES actions.
- **N3 — a missing `campaignId` would have discarded the safety-critical write.** The revision said an event without the tag is logged and ignored, but the suppression record is address-keyed and needs no campaign; only the history record does. That gated the write the slice exists for on a field belonging to the admittedly-unread one. Corrected to suppress first and write history only when the tag is present, which is simpler than either previous version.
- **N4 — the new teardown check could silently miss.** SES stores suppression entries case-sensitively and its management APIs require an exact match, even though its sending path is case-insensitive. Deleting a simulator entry with a re-derived lowercased address would miss one stored with different case. T7 now deletes using the exact string the listing returns. This does not affect T2, whose case-insensitive DynamoDB key relies on the sending-side half of the same AWS paragraph.

Three test additions were also accepted: the complaint echo case; supplying the configuration-set name through the same config read the handler uses, so a hardcoded literal fails the test rather than passing against hand-written fixtures; and asserting that `Transient` and `Undetermined` actually write a history record, so "record only" is checked rather than assumed.

One wording correction: the residual risk previously read as though the echo repairs the affected campaign. It does not — the echo is asynchronous, arrives after the campaign is finalized `accepted`, and a non-draft campaign can never be resubmitted. What heals is the **address**, for future campaigns.

On F11, the reviewer accepted the rejection and supplied a better justification than the wiki citation, now in the plan: with reconciliation removed, history rows are the only durable trace of what SES reported, and they are what gives the `Transient` and `Undetermined` outcomes any effect at all — without them, those events would be only a log line.

## Residual risks, accepted knowingly

- A lost event costs one wasted SES call and leaves a campaign `accepted` although SES did not deliver it, until the echo bounce arrives on that same attempt.
- Nothing in this slice reads the bounce and complaint history records.
- The account-level suppression list stays shared with any other SES sender on the account.
- The simulator's `bounceType`/`bounceSubType` are undocumented; T7 records them as evidence rather than asserting them in advance.
