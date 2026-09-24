---
project: Emailer
pr: PR #9
date: 17 Sep 2026
title: Segmentation without a second list
footer: Reviewed 9378cdf against origin/main 9cd7e40. Independent second opinion; source unchanged. AWS deployment evidence is author-reported.
---

PR #9 lets an operator narrow a campaign to contacts whose attributes match every supplied equality. This review traces a filtered send, explains the delivery guarantees, and separates code findings from rollout and operating risks.

> [!good]
> **Verdict: merge-ready. No material code findings.**
>
> **Deploy the compatible API and dispatcher before using filters.** An older API discards the input filter; an older dispatcher ignores a stored filter and sends to the whole list. Keep filtered campaigns away from those versions during deployment or rollback.
>
> **Keep the documented audience semantics:** attributes are read when each page is processed, and excluded contacts produce neither delivery rows nor a filtered count. These are deliberate scope choices, not missing implementation.

## 1. Where it started

The old dispatcher already paged the live list, checked consent and suppression, paced sends, and recorded each recipient's outcome. It had no campaign-specific predicate. Every member reached the address-status lookup:

```ts caption="Dispatching.ts before this PR"
for (const member of page.items) {
  **const status = yield* audience.addressStatus(member.email);**
  const now = yield* nowIso;
  if (status !== "mailable") {
    // Record a consent or deliverability skip.
  }
}
```

Contact hydration already returned attributes. The PR uses that existing data; it adds no secondary index, audience snapshot, resource, or extra per-contact read. Existing campaigns omit the new field and retain their previous behavior.

## 2. Follow one filtered campaign through

### Define the intended audience {step}

An operator creates a campaign with `--filter plan=pro --filter city=Berlin`, or sends the corresponding JSON map to `POST /campaigns`. The shared schema allows at most 20 string-valued entries, keys of up to 64 UTF-16 code units, and values of up to 512. Both equalities must match exactly. An absent filter or `{}` includes the whole list.

### Preserve the predicate {step}

The CLI and domain `create` explicitly copy the optional map. Storage writes it as a DynamoDB map on the campaign's `META` item. The existing body-first creation sequence stays intact. `summaryOf` exposes the filter on list/get responses, and `beginRun` hands it to the dispatcher. Each projection omits an absent field instead of introducing `filter: undefined`, which this optional-key schema rejects.

### Read one live page {step}

The dispatcher begins the run, applies reputation and quota guards, and asks membership storage for up to 50 contacts. The existing contact hydration supplies their current attributes. It reads the campaign body once, then evaluates the filter before consulting address status.

### Exclude without creating a recipient {step}

A `plan=free` member advances `lastProcessed` and immediately continues. There is no address-status lookup, limiter reservation, recipient claim, delivery row, or counter increment for that member. A matching contact still passes through the original consent and suppression checks before it can be sent.

### Continue and finish safely {step}

The existing conditional checkpoint determines which invocation may enqueue the next page. A wholly excluded page still follows `nextCursor`. If the next matching recipient cannot fit the remaining time budget, the last excluded contact is a valid checkpoint. A final page with no matches completes with zero outcomes. Recipient claims still prevent a redelivered page from sending the same contact twice.

## 3. The subtle decision: excluded is different from skipped

`skipped` continues to mean a recipient was blocked by consent or deliverability. A contact outside the filter is not a recipient of this campaign. Giving every exclusion a row would add transactions for the very audience the operator is trying to avoid sending to.

```ts caption="Dispatching.ts:177–184"
if (filter !== undefined && !matchesFilter(filter, member.attributes)) {
  **lastProcessed = member.id;**
  continue;
}
const status = yield* audience.addressStatus(member.email);
```

Advancing `lastProcessed` is the essential detail: excluding a contact still counts as progress through the list. The tradeoff is observability, discussed below. ADR-0011's amendment and the README make the distinction explicit; it does not require another segment entity or ledger.

## 4. What held up under review

### Filtering does not bypass delivery safeguards {good|solid}

Matching members still encounter consent, suppression, conditional claims, pacing and outcome settlement. The added tests inspect actual rows and recipients, so a mistakenly dropped predicate or an exclusion counted as a skip would fail them.

### The field survives every projection {good|solid}

Schema, domain, storage and HTTP tests cover input, persistence and responses. Direct probes also preserved own keys such as `__proto__`, `constructor` and `toString`; they do not disappear and turn a restrictive predicate into an empty one. Stored malformed maps fail decoding rather than being treated as absent.

### Excluded pages do not strand the campaign {good|solid}

The existing tests protect checkpoint behavior around the new branch. Additional probes of the real `runSlice` confirmed empty filters, wholly excluded pages, continuation to a later match, and completion when the final page contains no matching members.

### Old campaigns remain readable {good|solid}

The stored field is optional and no update expression changes. No table or index migration is introduced. This is backward compatibility for the new reader; it does not make the old dispatcher safe for new filtered campaigns.

## 5. Risks to account for

### R1 — Old versions silently broaden a filtered audience {high}

The API and dispatcher are separate Lambda functions. A partial deployment or rollback can pair a filter-aware client/API with an older consumer. I reproduced both compatibility failures locally: the baseline API schema removes the new input field, and baseline `beginRun` accepts a stored filter but omits it from the run projection. The baseline dispatcher then applies no predicate. Consent checks remain, but otherwise excluded contacts can receive the message.

This is a conditional operating risk, not a defect in the fully deployed PR. The fresh-stage integration case cannot exercise mixed versions. Lambda updates and published versions operate per function; there is no application-wide atomic switch in this stack. [AWS function versions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html) and the project's Alchemy lifecycle wiki support that boundary.

Consider: allow filtered sends only after both functions are verified on the new release. For rollback, stop dispatch, let current invocations finish, and ensure no filtered draft, queued, sending or paused campaign can be processed by the older dispatcher. If uninterrupted mixed-version operation becomes a requirement, add an explicit consumer capability/version guard.

### R2 — Large filters increase every counter write {medium}

The predicate lives on `META`, which is also updated for each outcome. DynamoDB charges `UpdateItem` for the whole item even when only a counter changes, and transactional writes double the write units. A schema-valid maximum-size Unicode filter contains 34,560 bytes of keys and values before map and campaign overhead. It can therefore make settlements much more expensive than the small `META` described by ADR-0014. [AWS write-capacity calculation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html).

Short predicates such as `plan=pro` have little effect, and no throughput regression was observed or benchmarked. The useful distinction is between a bounded map and a cheap map; they are not equivalent at the schema ceiling.

Consider: measure consumed capacity with representative large filters before sustained volume. If that workload matters, compare a tighter filter byte budget with storing immutable audience configuration outside the counter item.

### R3 — Progress cannot explain every exclusion {consideration}

Attributes are evaluated at page-read time. An edit after a contact's page is finished does not make the dispatcher revisit it; reprocessing an unfinished page can observe a newer value. Because exclusions leave no rows and there is no filtered count, `completed` with zero outcomes cannot distinguish a typo in the filter from a list with no matches. Filtering also still reads the whole list in 50-member pages.

These are explicitly accepted boundaries, not merge blockers. A saved segment or snapshot would change the product contract and add substantial machinery.

Consider: retain the README's live-audience explanation in operator-facing workflows. Add a preview only if operators need it, making clear that a preview is not a frozen recipient set.

## 6. The size of the change

```stats
74 / 20 | source lines added / removed across 5 files
391 / 27 | test lines added / removed across 7 files
168 / 10 | documentation lines added / removed across 4 files
0 | material code findings
```

The 633 additions are mostly tests and review/plan records. The runtime change is a field propagated through existing boundaries and one branch in the send loop. There are no dependency or infrastructure declaration changes.

## 7. What I checked, what I trusted

```split
Independently checked
- Exact PR commit 9378cdf against origin/main 9cd7e40; their merge base is origin/main, so the PR head is the merged result while the target stays there.
- Fresh frozen-lockfile install in an isolated worktree; format, warning-denying lint and typecheck passed.
- All 605 unit tests passed with one worker; the CLI suite also passed separately. Import smoke check and manual CLI help passed.
- Full changed-source/test inspection across two review lanes; unchanged storage, hydration, queue and Lambda boundaries; accepted ADRs and wiki.
- Direct old/new compatibility and unusual-key probes. GitHub's check run independently reports success.
---
Author-reported, not rerun
- The plan records 25 live integration cases passing on test-seg, a manual filtered simulator send, and complete teardown.
- No AWS deployment, real SES submission, cloud inventory check, or upgrade/rollback rehearsal was performed in this review.
- No throughput benchmark establishes a practical limit for large filters or sparse audiences.
```

The default local `pnpm check` reached unit tests twice and timed out on two different pre-existing CLI cases. Each run passed the other 604 tests. The CLI suite passed in isolation with all 26 tests; a subsequent full run with `--maxWorkers=1` passed all 605 tests across 29 files, and the import check passed. No source or timeout was changed. Concurrent work was running on the shared host; that is consistent with resource contention but does not prove the timeout's cause. The CI check passed. The adjacent `pr-9-review-evidence.md` records execution details and the plan matrix.

This is a second opinion after the implementation review committed on the branch. That earlier report had no material findings. This review adds independent execution, unusual-input checks, and the mixed-version/storage-cost analysis above.

## 8. Before the first filtered send

```checklist
- **Use compatible deployed versions** — finish the API/dispatcher rollout before sending a filtered campaign, and keep the rollback restriction explicit.
- **Retain the agreed semantics** — live attributes and no exclusion ledger/count are the delivered behavior. No new architectural decision is proposed by this review.
- **Treat the local gate honestly** — CI and all 605 tests with one worker passed; local default runs encountered CLI timeouts.
```

For a quick source check, open Dispatching.ts, Storage/Campaigns.ts, and Api.integration.test.ts. They show the exclusion branch, the durable predicate, and the test that distinguishes two intended recipients from three actual sends.
