# DynamoDB data modeling

[AWS](aws.md)

Related: [Transactions and outbox](dynamodb-outbox.md)

## Start from access patterns

DynamoDB Query is key-oriented; a filter does not turn a Scan into an efficient indexed query. Design the reads and writes before choosing keys. Keep large documents and binary payloads in object storage and store references in DynamoDB. On-demand capacity simplifies initial capacity selection but does not eliminate hot keys, throttling or cost. [AWS modeling guidance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-modeling-nosql.html)

Example access patterns and their key-design tradeoffs:

| Access | Possible key strategy |
| --- | --- |
| Resource by owner and ID | Owner-scoped partition key and resource sort key |
| Events in time order | Entity partition key and timestamp/event-ID sort key |
| Job by ID | Well-distributed job key with ownership stored and checked |
| High-volume aggregate history | Aggregate plus shard, with a defined fan-out query |
| Due outbox records | Time bucket/shard plus due-time index |
| Lookup by external ID | Secondary index or a dedicated lookup item |

A high-volume entity under one partition key can bottleneck writes. Shard only the access patterns that need it, and define how to query/checkpoint all shards. Separate tables are reasonable when retention, traffic and recovery differ; “single table” is not a requirement.

## Keys, indexes and attribute values

A table has either a partition key or a composite partition/sort key. `GetItem` needs the complete primary key. `Query` requires equality on one partition-key value and can additionally constrain its sort key; it is not an arbitrary multi-column search. A secondary index offers another key-oriented access path at the cost of storage, write amplification and its own consistency constraints.

**Changing a global secondary index's key schema or projection requires replacing the index.** DynamoDB supports adding and deleting GSIs through `UpdateTable` while preserving the table. To migrate without losing the existing query path, create a differently named index with the desired definition, wait for `ACTIVE`, switch readers, then remove the old index. Account for backfill load and the one-index-per-update limits. Alchemy `2.0.0-beta.77` instead plans a **table replacement** if an existing, same-named index's key schema or projection changes directly; use staged declarations and inspect each plan. [AWS online index operations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.OnlineOps.html), [pinned Alchemy provider](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/DynamoDB/Table.ts).

`KEYS_ONLY` plus a strongly consistent `BatchGetItem` hydration returns current base-table items and drops entries whose items were deleted. Serving `INCLUDE` or `ALL` projections directly accepts the index's eventual consistency. Hydration does not recover newly created items that the index has not discovered yet; choose the projection according to the read contract and cost.

**A sparse index contains only items that carry its key attributes.** Restricting those attributes to selected item types keeps other types out of the index. Low partition-key cardinality alone does not impose an immutable single-partition ceiling: DynamoDB can split an item collection by sort key when an LSI does not prevent it, and split-for-heat applies to GSIs too. However, steadily increasing timestamp sort keys can concentrate new writes at one end, where splitting would not spread the incoming load. Measure throttling and distribution before choosing write sharding and its corresponding fan-out reads. [AWS partition distribution](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html), [AWS split-for-heat guidance](https://aws.amazon.com/blogs/database/part-3-scaling-dynamodb-how-partitions-hot-keys-and-split-for-heat-impact-performance/).

For a composite table with `PK` and `SK`, a query for an owner's documents might use the following low-level request. The table name and key convention are illustrative:

```json
{
  "TableName": "Documents",
  "KeyConditionExpression": "#pk = :owner AND begins_with(#sk, :prefix)",
  "ExpressionAttributeNames": { "#pk": "PK", "#sk": "SK" },
  "ExpressionAttributeValues": {
    ":owner": { "S": "OWNER#user-1" },
    ":prefix": { "S": "DOCUMENT#" }
  },
  "Limit": 25,
  "ConsistentRead": true
}
```

This queries the base table. `ConsistentRead: true` is not supported for a GSI. Continue using the returned `LastEvaluatedKey` as the next request's `ExclusiveStartKey`; a response page is not the entire collection. Sort-key order follows numeric order for numbers and UTF-8 byte order for strings, so timestamp and numeric encodings affect ordering. [Key conditions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.KeyConditionExpressions.html)

AWS AttributeValue JSON distinguishes strings, numbers, booleans, maps and lists. A number is represented as a numeric string inside `N`; a numeric-looking `S` is still a string. Document-client marshalling and Alchemy's low-level bindings are different APIs. Normalize this boundary in one adapter so application code does not alternate incompatible representations.

## Conditional writes are the concurrency primitive

Claim a job with a conditional update, not read-then-write. Store state, attempt/owner ID, lease deadline and version. Completion must condition on the same ownership/version so a stale worker cannot overwrite a newer decision. A conditional conflict can be a normal business outcome: another worker already owns or completed the job.

Illustrative AWS expression shape:

```text
UpdateExpression:
  SET #status = :claimed, owner = :owner, leaseUntil = :deadline
ConditionExpression:
  #status = :queued AND attribute_not_exists(owner)
```

This only models a first claim; expired lease recovery and uncertain remote effects require separate transitions. Use expression attribute names for reserved words and values for user data. [Transaction and conditional operation semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

**Make every write safe to repeat, then let the client retry every write.** The AWS client retries throttling, server errors and lost responses by default, and DynamoDB answers a small share of writes with a server error, so a write that cannot be repeated is a write that will one day fail for nothing. Two mechanisms, by write shape. A transaction carries a `ClientRequestToken`: a repeat of the identical request within ten minutes returns success without applying again, the same token with other parameters is rejected, and a cancelled transaction should be retried as a new call with a new token, since nothing documents how a cancelled token replays. Generate the token yourself, one per logical call: a client that fills it during encoding regenerates it on every retry attempt, which protects nothing. A single-item conditional update has no token, so its condition must hold both before and after the write for the actor that wrote it — a run token, a slice identifier, the value being set — and a put under a freshly generated key can treat an existing item as done. Only a transaction cancelled solely for `TransactionConflict` needs an application-level retry: the client does not classify that exception as retryable, because the same class also reports condition failures. [TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html), [Transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

Alchemy's operation bindings use AWS AttributeValue objects (`{ S: "x" }`, `{ N: "42" }`) and do not automatically marshal domain objects. Centralize encoding/decoding in a repository adapter and validate recovered records. A table's `attributes` declaration contains key/index attributes, not every business field. [Alchemy DynamoDB](https://alchemy.run/aws/data/dynamodb/)

## Consistency boundaries

Tables and local secondary indexes can serve strongly consistent reads; global secondary indexes are eventually consistent. A stale index result must not establish lock ownership or authorize an irreversible state transition. Use the index to discover candidate work, then conditionally claim the authoritative base record. A strong read alone still does not make a subsequent write atomic. [Read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html)

Process paginated results to completion and persist continuation checkpoints. Query filters can return an empty page with more pages remaining; use the continuation key, not returned count, to decide completion. Handle unprocessed items from batch operations individually with bounded retries. Batch writes are not a substitute for conditional transitions or transactions. A Query reads at most 1 MB before filtering. BatchWriteItem accepts at most 25 put/delete operations (16 MB request limit), has no per-item conditions, and each stored item remains limited to 400 KB. [Query API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html), [BatchWriteItem API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html)

**`BatchGetItem` answers under the physical table name, and a binding that accepts logical IDs does not map it back.** Where an operation binding takes `RequestItems` keyed by a logical resource ID, it rewrites those keys to physical table names on the way out; AWS then echoes both `Responses` and `UnprocessedKeys` under the **physical** name. So `UnprocessedKeys` cannot be fed back verbatim — the retry would name a table the binding has never heard of, which typically fails as a defect rather than an error. Read responses by value rather than by name, and re-key the pending block before retrying it. `BatchGetItem` also caps at 100 keys, returns results in **no particular order**, and silently omits keys it found nothing for: match results by key, never by position, and never send an empty key list, which the service rejects.

## TTL and retention

TTL is asynchronous cleanup, commonly occurring within days of expiry. Expired items can still be read and updated until deletion. Enforce lease/idempotency expiry in application conditions; TTL must not be used as a precise lease-release or scheduling mechanism. [TTL behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)

Choose idempotency retention longer than queue retention, retry delay and permitted replay horizon. Choose retention per record class; deleting a deduplication record can make an old replay look new. Operational records, audit evidence and aggregates may need different lifetimes.

Enable PITR for durable production tables and practice restoring to a new table. AWS supports a recovery period of 1–35 days; restore does not rewind external services or client observations. Reconcile side effects completed after the restore point before re-enabling consumers. [PITR](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Point-in-time-recovery.html)

## Make updates conditional on observed state

An update expression can set or remove attributes and perform supported arithmetic. A condition is evaluated atomically with that item mutation. For optimistic concurrency, store a version, require the expected version in the condition, and increment it in the update. When the condition fails, read the current item and decide whether the operation was already completed, lost a race or should be retried with new input. Blindly retrying the same failed condition does not resolve the conflict. [Update expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html)

For lease ownership, completion should require both the expected operation state and current owner/version. That prevents a stale completion from replacing a newer worker's result. It does not by itself stop the stale worker from making a non-idempotent call to another service, so external-effect safety needs an additional protocol or an explicit uncertain-outcome policy.

TTL attributes use epoch seconds, while application clocks and JavaScript timestamps commonly use milliseconds. Store and compare units deliberately. An item whose TTL has passed can still participate in reads or conditional writes until asynchronous deletion; filter or condition on logical expiry where required. [TTL behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)

The [DynamoDB guide index](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/llms.txt) locates key design, capacity and recovery guides. Use the API reference to confirm which batch operations support conditions, what is returned on conflicts, and how unprocessed items must be retried.
