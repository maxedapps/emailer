# ADR-0014: The campaign body is its own item, and the listing returns summaries

- Status: Accepted
- Date: 2026-09-16
- Confirmed: 2026-09-16. Live gate on ephemeral stage `test-list` passed all 23 integration cases, including the listing case that finds a created campaign without its `text` and reads the `text` back through `get`; a direct read of the campaign partition showed the `BODY` item carrying the text and the `META` item carrying state and index attributes without it. The stage was destroyed.
- Authority: The user decided on 2026-09-16, after the review of PR #7, that a campaign listing must not carry the body, and asked for the cleanest fix with big refactors allowed. The user then asked for the implementation of [the plan](work/campaign-body-item.md). Confirmation follows the plan's live gate.
- Supersedes in part: [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md)'s campaign record, which held subject, text, state and counters in one item.
- Superseded in part: [ADR-0020](0020-drafts-previews-and-test-sends.md) for "No campaign delete exists": a draft can be deleted, `META` and `BODY` in one transaction.

## Context

The campaign `META` item holds the body beside the counters the dispatcher increments once per recipient. DynamoDB charges an `UpdateItem` by the larger of the item before and after the write, charges a transactional write twice, and sustains about 1,000 write units a second on one partition. A 64 KiB text therefore makes each settlement cost about 130 units and caps settlements near 7 a second, below the paced 20; lane B's 256 KiB HTML body would make it about 1.5. The same item is what `GET /campaigns` hydrates, so a page of 25 campaigns at those ceilings exceeds the 6 MB response a buffered Function URL can return. Contacts and lists never raised the question because they have no body.

The listing index projects keys only and every listing hydrates from the base table with a consistent batch read (ADR-0005). `beginRun` is an `UpdateItem` that returns the item it updated, which is why it is not a transaction (ADR-0013); it cannot return a sibling item.

## Decision

- **Two items per campaign under one partition key.** `META` keeps identity, subject, state, counters, run token, cursor and the listing index attributes. `BODY` holds `text` and, once lane B lands, `html`. Per-recipient rows are unchanged.
- **Two `recordOnce` puts create them, body first.** Both keys are fresh, so each put is the repeat-safe form ADR-0013 prescribes: an item already there is this request landing again. `BODY` is written first so that `META` is the commit point; a create interrupted between the two leaves an orphan body under an identifier nobody holds, which no index entry, key or query can reach.
- **Each access path reads what it needs.** The listing hydrates `META` and returns summaries. The dispatcher reads `BODY` once per slice, after the page read and before the first recipient, so a pause exit or a missing list never pays for it. `get` reads both; a `META` without a `BODY` is corrupt, and so is a body read that finds nothing, because every caller already holds the `META`.
- **The wire contract mirrors the items.** `CampaignSummary` is id, list, subject, created time and submission; `CampaignBody` is the body; `Campaign` is the two composed. `list` answers `CampaignSummary`; `create`, `get`, `send` and `resume` answer `Campaign`.

## Alternatives considered

1. **A summary on the wire, the body left on `META`.** Fixes the response size and nothing else: every settlement still pays for the body, and the listing still reads bodies it discards. Rejected.
2. **Project summary fields into the listing index.** Every counter update would also write the index, the index would serve stale progress, and the projection change replaces the table under the pinned provider. Rejected.
3. **One tokened transaction for both items.** Atomic, with the contact create as precedent, but it doubles the create's write cost (about 132 units against 66 for a 64 KiB text) and overrides ADR-0013's rule for fresh keys to close a crash window whose worst outcome, body first, is an unreachable item. Rejected.
4. **Summaries from `send` and `resume` too.** The cost this decision removes is per settlement; a send runs once per campaign and echoing the body costs one bounded read. Not worth a contract change and a third read operation. Rejected.
5. **One batch read for `get`.** The batch primitive returns items unordered and the page primitive tells items apart by partition key, which the two items share. Two consistent reads keep the distinction in code. Rejected.
6. **Bodies in object storage.** AWS's guidance for [large items](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-use-s3-too.html), but a body is at most a few hundred kilobytes and object storage would add a bucket, a grant and a consistency question for no present need. Rejected.

## Consequences

- **Settlements write a lean item** at two units each regardless of body size, and the send rate is bounded by pacing, not by the body.
- **A listing page is proportional to the summary**, and bodies are no longer read to be discarded.
- **`get` costs two reads; the dispatcher one more read per slice.** Both are bounded by the store's five-second operation timeout inside budgets of sixty seconds and five minutes.
- **Create costs two puts** instead of one.
- **`send` and `resume` read the body twice** through `get`, once before and once after the enqueue; four bounded reads inside the API's sixty-second budget.
- **The 400 KB item ceiling binds on the body item alone**; lane B's HTML ceiling can be revisited against it.
- **No campaign delete exists**, so no cascade needs to remove the body. One is needed if a delete is ever added.
- **JSON key order of full-campaign responses changes**, with the body last. Nothing depends on order.

## Confirmation

Confirmed on 2026-09-16 against ephemeral stage `test-list`, then destroyed: all 23 integration cases green after the alarm case's stage-specific configuration was repointed; `campaigns list --limit 1` printed a campaign without `text` and `campaigns get` printed it; the partition held a `BODY` item with `text` and `v` and a `META` item with `state`, `gsi1pk` and no `text`. The dispatcher's body read is proven by the simulator sends completing with accepted counts.

## References

- [Plan](work/campaign-body-item.md)
- [Campaign listing plan](work/campaign-listing.md), whose PR review raised the listing size
- [DynamoDB read and write operations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html)
- [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
