# ADR-0025: Fast imports of large contact files

- Status: Accepted
- Date: 2026-09-24
- Authority: On 2026-09-24 the user asked for lists of tens of thousands of contacts to import as fast as possible. After measurements on ephemeral stages, they chose:
  - parallel batches from the CLI;
  - a list read instead of the transactional list check;
  - CSV files beside JSON, with extra columns as attributes.

  They approved this record and its plan on 2026-09-25 by asking for the implementation.
- Supersedes in part, once implemented: [ADR-0005](0005-contact-identity-and-membership-access-paths.md): "larger imports are a client-side loop" (the CLI runs the loop), and the import transaction's list check.
- Plan: [0025-fast-large-imports.plan.md](0025-fast-large-imports.plan.md)

## Context

- **One import call carries at most 20 contacts.**
  - It is one `TransactWriteItems`, which allows 100 actions. Each contact takes four actions, and the list check takes one.
  - The README leaves larger files to a loop the operator writes.
- **Only JSON is accepted,** while large lists usually arrive as CSV exports.
- **Measurements on ephemeral stages (2026-09-24), with 20-contact calls from a client outside the Region:**
  - **One call at a time:** 75 contacts/s, so 50,000 contacts take about 11 minutes.
    - A call takes about 260 ms, of which DynamoDB takes about 67 ms.
    - The rest is the network and the function.
  - **Parallel calls into one list:**
    - 8 in flight reached 200–250 contacts/s. 16 or 32 in flight did no better.
    - DynamoDB throttled the list's partition, while the table used 2,500–3,600 of its 4,000 write units a second.
    - Every member item (`LIST#<id>/MEMBER#<contactId>`) shares one partition key with the list's `META`. A partition takes at most 1,000 write units a second.
  - **Every import transaction checks the list's `META`.**
    - That check costs 2 write units per call, on the same hot partition.
    - Parallel calls collide on it. The store's conflict retry absorbs the cancellations, but they are billed: about 16% more write units.
  - **Under throttling some calls answered an empty 500.** The AWS client could not decode DynamoDB's error reply ("incorrect header check"). ADR-0024's T12 has since fixed that.
- **Cost per new contact:**
  - 8 table write units, 1 index write unit and about 1 read unit;
  - about $0.29 per 50,000 contacts at on-demand prices.

## Decision

1. **The CLI imports a file of any size.**
   - It checks the whole file before sending anything: the format, and that no address appears twice anywhere in it.
   - It sends 20-contact calls, 8 in flight.
   - A call that fails transiently is retried with jittered exponential backoff for about two minutes. Transient means a transport failure, a timeout, or 408, 429 or 5xx.
   - It prints the converged state for the whole file, in file order.
   - Its request deadline applies to each request, not to the whole command.
2. **A `.csv` file is read as CSV;** any other file is read as JSON, as today.
   - The first row is the header.
     - `email` is required and `name` is optional, both matched case-insensitively.
     - Every other column becomes an attribute named by its header.
   - Empty cells are left out.
   - A header naming a column twice is rejected.
   - Each row then passes the same checks as a JSON entry. An invalid row is named by its line in the file.
   - Parsing uses `csv-parse`, which handles quoting, embedded commas and line breaks, and a byte-order mark.
3. **The API contract is unchanged:** 20 contacts per call, the same answers.
4. **The import reads the list instead of checking it in the transaction.**
   - The list's `META` is read, strongly consistent, alongside the reservation pre-read.
   - A missing list answers `ListNotFound` before any write.
   - The transaction holds four actions per contact and nothing else, so parallel calls touch disjoint items.
   - There is still one check per call, because any caller may call the API. It is now 1 read unit instead of 2 write units on the hot partition plus billed collisions.
5. **A throttled call answers a retryable 503,** through [ADR-0024](0024-typed-errors-and-cost-neutral-storage.md):
   - its capped AWS retry (T7);
   - uncompressed AWS replies (T12).

## Alternatives

- **One call at a time from the CLI.** This is the simplest option: no backend change, no collisions. At 11 minutes per 50,000 contacts it was rejected, because the user wants imports as fast as possible.
- **Keep the transactional list check.** This is the stronger guarantee. Rejected: its collisions are billed, and it loads the partition that limits speed.
- **Larger calls that the server splits into transactions.** Rejected:
  - a call would no longer be all-or-nothing;
  - the body has a 6 MB limit;
  - DynamoDB, not the number of calls, is the limit.
- **An asynchronous import job** (upload to S3, a queue and a worker). It would survive a closed terminal. Rejected: it is no faster, and it adds a bucket, a queue, a worker and job state.
- **Spreading a list's members over several partition keys.** Rejected:
  - it gains at most about 2×, because the table's instant limit of 4,000 write units a second is about 440 contacts/s;
  - it changes member paging for the API, the dispatcher, test sends and list deletion.
- **`BatchWriteItem`.** It halves the write cost but takes no conditions, so it loses unique addresses and the two-way membership. Rejected.
- **25 contacts per call,** which the missing list check would allow. Rejected: DynamoDB, not the number of calls, bounds the speed, so the contract change buys nothing.
- **Converting CSV to JSON outside the CLI.** This is the simplest option: no code. Rejected, because the user wants CSV imports directly.
- **CSV that carries only `email` and `name`,** or attributes only from prefixed columns. The user chose extra columns as attributes, which mirrors the JSON format.
- **Parsing CSV by hand.** Rejected: quoting, embedded line breaks and byte-order marks are where hand-written parsers fail.

## Consequences

- **Speed:** a list imports at about 200 contacts/s, so 50,000 contacts take about 4 minutes. DynamoDB may split the hot partition during a long import; that is unmeasured.
- **Cost:**
  - per call, 2 write units become 1 read unit, and billed collisions go;
  - about $0.28 per 50,000 new contacts;
  - re-running a file costs about the same as the first run.
- **Racing a list deletion can orphan memberships.**
  - Only calls whose read came before the deletion and whose commit came after it can orphan, at most 8 × 20 memberships.
  - Every later call answers `ListNotFound`.
  - This is the same class of leftover that ADR-0005 accepts for an import during a delete cascade.
- **An interrupted import** leaves the finished calls in place. Running the same file again completes it.
- **CSV headers become attribute keys verbatim.**
  - Export columns the operator does not want must be removed before importing.
  - A file with more than 20 other columns fails on every row.
- **The CLI gains one dependency,** `csv-parse`.
- **Deploy order:** the CLI and the API can be deployed in either order.

## Confirmation

- `pnpm check` passes, with tests for:
  - the list read;
  - the file schema;
  - CSV reading;
  - the CLI's batching and retries.
- On an ephemeral stage, a 10,000-contact CSV import completes:
  - the membership count is exact in both directions;
  - there are no transaction conflicts;
  - it uses about 8 table and 1 index write units per contact.
