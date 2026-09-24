# ADR-0013: Every write is safe to repeat, so the client retries every write

- Status: Accepted
- Date: 2026-09-16
- Accepted: 2026-09-16
- Confirmed: 2026-09-16. Live gate on ephemeral stage `test-f` passed all 22 integration cases; the stage was destroyed.
- Authority: The user asked on 2026-09-16 for the cleanest fix after a live run showed one DynamoDB server error stalling a campaign for the dispatch queue's 30-minute lease, and allowed big refactors to get there. Acceptance follows the live gate in [the plan](work/repeat-safe-writes.md).
- Supersedes in part: [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md)'s "Conditional writes are single-attempt" and its claim that a retried conditional write is misread as a lost race; [ADR-0012](0012-reputation-guardrails.md)'s "Transaction conflicts are retried, lost responses are not", including its client-level opt-out.
- Superseded in part: [ADR-0016](0016-cancelling-pending-campaign-runs.md), for campaign lifecycle commands: enqueue and resume no longer accept a campaign already queued, because each command is a single-item transaction with its own request token that requires the state it observed.

## Context

The store made exactly one HTTP attempt on every conditional write. That was a deliberate answer to a real problem: the AWS client retries transient answers by default, and a retried conditional write whose first attempt had applied but whose response was lost comes back as a condition failure, which the dispatcher read as a lost race. A checkpoint would be acknowledged without a continuation; a claim would never be mailed. Opting out of client retries removed the misreading at the price of a crash on every transient answer, which SQS repairs only after the dispatch queue's 30-minute visibility lease, and of one recipient left unconfirmed when the failed write was a settle.

The live gate of the reputation lane hit that price once: DynamoDB's own `SystemErrors` metric recorded one server error among about 13,500 writes, the dispatcher died on `settleRecipient`, and the campaign waited half an hour. Server errors at that rate are documented and expected, which is why every AWS SDK retries them. A resume whose write applied but whose response was lost had a second, independent consequence: the API answered 503, and a repeated `resume` did nothing because the campaign was already queued, so only `send` could get it moving.

Three facts shape the fix. DynamoDB transactions accept a `ClientRequestToken`, and a repeat of the identical request within ten minutes returns success without applying again. The client we use fills that token itself, but generates a fresh one on every retry attempt, so it protects nothing unless the store supplies it. Single-item updates have no token at all.

## Decision

- **Every write is safe to repeat, and the client's default retry policy applies to all of them.** `Retry.none` is gone from the store. The one retry the store still owns is for a transaction cancelled only for `TransactionConflict`, which the client does not classify as retryable because the same exception also reports condition failures.
- **Transactions carry a token the primitive generates.** `runTransaction` draws one token per logical call from the Crypto service and strips the field from its request type; no caller passes a token. A conflict cancellation is retried as a new call with a new token, since nothing documents how a cancelled token replays; the client's own retries within one attempt resend the identical request.
- **Single-item conditions hold before and after the write for the actor that wrote it.** Enqueue and resume also accept a campaign already queued under the same run token. The checkpoint records the slice's identifier with the cursor and also accepts its own advance, so a lost response cannot acknowledge a page without a continuation, while a concurrent duplicate on the same page still loses and starts no second chain. The contact update accepts either the current or the new spelling of the address. Begin, complete and pause already qualified.
- **Creates under a fresh identifier collapse into `recordOnce`.** An item already there under a freshly generated key can only be this request landing again, so it means done. The separate `createRecord` primitive is deleted.
- **`resume` mirrors `send`.** For a campaign that is already queued it re-sends the wake-up under the stored run token, which is the repair for a lost enqueue or a lost response.
- **The pacing item may over-count on a retry.** Its increment has no repeat-safe condition; a repeat consumes an extra token, which only slows sending. Accepted.

## Alternatives considered

1. **Every write as a transaction so one mechanism covers all.** Transactions cannot return the updated item, which `beginRun` needs, and they double the write cost. Rejected.
2. **Keep single attempts and shorten the queue lease.** The 30-minute lease is AWS's own six-times-the-timeout guidance for Lambda and SQS. Rejected.
3. **Retry inside the dispatcher instead of the store.** Would re-walk a page on every transient answer and still need the repeat-safe conditions. Rejected.
4. **Reconcile rows a crashed slice left unconfirmed.** Still rejected, as in ADR-0011: genuine crashes are now the only way to reach that state.

## Consequences

- **A transient answer costs a retry of a few hundred milliseconds instead of a 30-minute stall**, and a settle that lands on retry is counted.
- **Genuine crashes still leave unconfirmed rows**, and a persistent outage still dies to the SQS redelivery: the 5-second operation timeout bounds the client's policy to about four attempts, which is the right fallback.
- **The store layers require the Crypto service**, which the API, dispatcher and feedback functions provide. Test suites use numbered tokens derived from the requests already sent.
- **A human retrying a create still gets a new entity**; ADR-0005's clause on API idempotency stands.
- **The wiki's DynamoDB page** describes the two mechanisms by write shape.

## Confirmation

The transport tests prove that a server error is retried with the identical request, token included, and that a conflict cancellation is retried as a new call with a new token. The unit suites pin every condition. The plan's gate runs the integration project on an ephemeral stage and destroys it.

## References

- [Repeat-safe writes plan](work/repeat-safe-writes.md)
- [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md), [ADR-0012](0012-reputation-guardrails.md)
- [Amazon DynamoDB: TransactWriteItems, ClientRequestToken](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)
- [Amazon DynamoDB: Transactions, idempotency and conflict handling](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)
- [AWS Lambda: Configuring a queue to use with Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)
- @distilled.cloud/aws 1.0.0-rc.9: `client/generate-idempotency-tokens.ts` (token filled per attempt), `services/dynamodb.ts` (retryable classes)
