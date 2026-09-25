# Plan: Fast imports of large contact files

- Status: In progress
- Decision: [ADR-0025](0025-fast-large-imports.md)

## Goal

**Done when:**

- `emailer lists import` takes a JSON or CSV file of any size, sends 20-contact calls with 8 in flight, and retries transient failures;
- the import reads the list once per call instead of checking it inside the transaction;
- the README describes the new behaviour and limits;
- the live gate passes, and prod runs the result.

**Out of scope, deliberately unchanged:**

- the API contract, including 20 contacts per call;
- the member key layout;
- `addMember` and `removeMember`, which keep their transactional list check;
- asynchronous import jobs;
- the throttle-reply decode fix (the empty 500), done in typed-errors T12.

## Before starting

- This plan builds on typed-errors ([ADR-0024](0024-typed-errors-and-cost-neutral-storage.md)):
  - its T7 caps the AWS retry, so a throttled call ends as a retryable 503;
  - its T12 asks for uncompressed AWS replies, so a throttle no longer answers an empty 500.
- typed-errors had not reached `main` when this work started on 2026-09-25, a deviation from the plan approved earlier.
  - `fast-import` merged typed-errors at `80dc784`, with `pnpm check` green.
  - It merges `main` once typed-errors lands there, and again before its own merge.

## Rules for every task

- One commit per task, with `pnpm check` green.
- The task states its running-cost effect. A task that would raise cost does not ship.
- No options beyond what is listed here: no flags for concurrency or batch size, and no progress file.

## Tasks

### T1 — Read the list once per call

Status: Done

- **Where:** `importContacts` in `apps/backend/src/storage/Membership.ts`.
- **The read:**
  - read the list's `META` (`readItem`, strongly consistent) concurrently with the reservation batch read;
  - no item: fail with `ListNotFound` before any write.
- **The transaction:**
  - drop `listExists(listId)` from the actions, so a full batch is 80 actions;
  - keep `retryLostRace`: a raced contact still retries from a fresh read, including the list read.
- **Comments:**
  - `listExists` now documents only `addMember` and `removeMember`;
  - the import explains the read and the accepted leftover when it races a list deletion (ADR-0025).

**Verify (`Membership.test.ts`, with the scripted table answering the list read):**

- a new contact produces four actions, and none targets the list's `META`;
- the list read is a consistent `GetItem` on `LIST#<id>/META`;
- a full batch of 20 is 80 actions;
- a missing list answers `ListNotFound`, and no transaction is sent;
- the existing existing-contact, re-run, join-time and raced-contact cases still pass.

**Cost:** lower. Per call, a 2-write-unit transactional check becomes a 1-read-unit read, and parallel calls no longer collide.

### T2 — The import file schema

Status: Done. As built: the entry schema is exported in T5, its first user outside the module, so knip stays clean in between.

- **Where:** `packages/api/src/Schemas.ts`.
- **`ImportContactsFile`:** the same entry schema, non-empty, no address twice anywhere, and no size cap.
- **`ImportContactsPayload`:** stays the API body, with the 20-contact cap.
- Both share the entry schema and the distinct-address check instead of repeating them.
- The entry schema is exported for T5's per-row checks.

**Verify (`Schemas.test.ts`):**

- the file schema accepts more than 20 entries;
- it rejects the same mailbox at positions 0 and 25, differing only in case;
- the payload still rejects 21 entries.

**Cost:** none.

### T3 — Per-request deadline and transient retries in the CLI client

Status: Done. As built:

- **The deadline** is an `HttpClient.transform`. A request past it fails as a `TransportError`, which keeps the client's error type and is what `retryTransient` treats as transient.
- **The transform** reaches the client through `makeEmailerClient`'s new optional `transformClient`, which is passed to `HttpApiClient.make`.
- **The deadline bounds** the wait for a response's headers. The API function answers buffered, so the body follows at once.

- **Where:** `apps/cli/src/Client.ts`.
- **Deadline:**
  - the 70 s deadline moves from the whole `withClient` block to each request, as its comment already says;
  - other commands make at most three requests, so their bound changes by nothing that matters.
- **Retries:** `withClient` takes an option to retry transient failures, and only `lists import` uses it.
  - It uses Effect's `HttpClient.retryTransient`, which covers transport failures, timeouts, and 408, 429, 500, 502, 503 and 504.
  - The schedule is exponential from 500 ms, jittered, with at most 8 retries: about two minutes.
  - Declared business errors (400, 401, 404, 409) are never retried.
- **Order:**
  1. The deadline wraps each attempt, as `transformResponse(Effect.timeout(…))`.
  2. `retryTransient` wraps that, so a timed-out attempt is retried.

  The other way round, the deadline would cut the two-minute retry budget to 70 s without any error.

**Verify:** covered by T4's CLI tests. The existing CLI suites pass unchanged.

**Cost:** none on the service. A retry repeats an idempotent call.

### T4 — Import a file of any size, in parallel

Status: Not started

- **Where:** `lists import` in `apps/cli/src/commands/Lists.ts`.
- **Behaviour:**
  - decode the file with `ImportContactsFile`;
  - split it into batches of `Schemas.maxImportEntries`;
  - `Effect.forEach` with `concurrency: 8`, through the retrying client from T3;
  - print `{ contacts }` for the whole file, in file order, exactly as one call prints today.
- **Progress:** a stderr line after every 1,000 imported contacts, such as `Imported 3,000 of 50,000 contacts`.
- **Failure:**
  - stop at the first error that is not retried, or when retries run out;
  - stderr says how many contacts were confirmed and that running the same file again is safe;
  - the error itself is reported as today.
- **Command text:** the description and example no longer say "up to 20".
- **Harness (`apps/cli/test/CliHarness.ts`):**
  - the import handler takes contact ids from a counter and appends members, so several calls add up;
  - it records each call's batch size;
  - an option makes the first import call answer `StorageUnavailable`.

**Verify (`Lists.test.ts`):**

- a 45-contact file makes three calls of 20, 20 and 5, and stdout lists all 45 in file order;
- a batch answered 503 once is retried, and the import exits 0;
- a missing list is not retried: a one-batch file makes exactly one call and exits non-zero, naming `ListNotFound`;
- a file naming one mailbox at positions 0 and 25 is rejected before any request;
- the existing malformed-file, misspelled-key and single-contact cases still pass.

**Cost:** none per contact. A file costs what its batches cost.

### T5 — CSV files

Status: Not started

- **Dependency:** `csv-parse` (7.0.2, no dependencies, bundled types), added to the catalog and to `apps/cli`.
- **Where:** a new `apps/cli/src/CsvContacts.ts`. `lists import`'s file flag reads a `.csv` path through it; any other path stays JSON.
- **Parsing:** `parse` from `csv-parse/sync` with:
  - `bom: true`;
  - `skip_empty_lines: true`;
  - `info: true`, for each record's line.
- **Header:**
  - `email` is required and `name` is optional, both matched case-insensitively;
  - every other column is an attribute key, verbatim;
  - a column named twice, or a missing `email` column, is rejected before any row is read.
- **Rows:**
  - empty cells are left out;
  - each row is decoded with the exported entry schema, and a failure reads `line N: <message>`;
  - the result is checked against `ImportContactsFile`, so duplicates across rows are rejected as in JSON.
- **Command text:** the `--file` description and an example name CSV.

**Verify (`CsvContacts.test.ts`):**

- header names match regardless of case;
- a quoted field holding a comma and a line break is read whole;
- a byte-order mark is stripped;
- empty cells produce no attribute and no name;
- a missing `email` column is rejected;
- a column named twice is rejected;
- an invalid address names its line;
- blank lines are skipped;
- one mailbox on two rows is rejected.

**Verify (`Lists.test.ts`):** a CSV file imports, and its attributes reach the service.

**Cost:** none.

### T6 — Docs and ADRs

Status: Not started

- **README:**
  - drop "An import takes at most 20 contacts per call, so a larger file needs a loop.";
  - "JSON imports" becomes "JSON and CSV imports";
  - the quickstart's "at most 20 contacts per file" goes, and it shows the CSV form next to the JSON one;
  - the CSV rules: header, `email` / `name`, other columns as attributes, empty cells left out;
  - the commands table: `lists import` creates or finds the file's contacts and adds them to the list;
  - Limits: `lists import` takes any file size, sends 20 contacts per API call, and rejects an address appearing twice in a file;
  - Behavior: about 200 contacts a second per list; transient failures are retried; after an interruption, running the same file again completes it.
- **ADR-0005:** add a "Superseded in part" line pointing to ADR-0025 for the client-side loop and the import's list check.
- **ADR-0025:** add as-built notes where the implementation differs from the record.

**Verify:** `pnpm check` (format).

**Cost:** none.

### T7 — Live gate

Status: Not started

- **Stage:** a dedicated one, `--stage test-import`, so it never shares state with the typed-errors gate.
  - Deploy it from the worktree.
  - Repoint the seven stage-specific `.env.test` values, as the README's "Develop and test" lists them.
- **Full suite:** `pnpm test:integration` passes.
- **Pre-flight:**
  - run the CLI as `node --env-file=.env.test apps/cli/src/main.ts`, never as `pnpm emailer`, which loads `.env`: in an operator checkout that is prod;
  - before the first call, confirm `EMAILER_API_URL` equals this deploy's `apiUrl` output.
- **Import:**
  - write a CSV file of 10,000 labelled simulator addresses, with a `name` and one attribute column;
  - import it into a fresh list;
  - start at least a minute after the suite has finished, so its writes and conflicts stay out of the gate's metric window.
- **Pass criteria:**
  - exit 0;
  - exactly 10,000 forward and 10,000 reverse memberships, counted in the table;
  - no `TransactionConflict` during the run;
  - about 8 table write units and 1 index write unit per contact (`ConsumedWriteCapacityUnits`).
- **Re-run:** the same file again exits 0 and prints identical output.
- **Recorded, not gated:**
  - contacts per second;
  - throttle events;
  - retried calls.

  Throughput varied between fresh tables at the same concurrency.
- **Cost cap:**
  - the two runs write about 170,000 units, about $0.11;
  - an import sends no mail;
  - stop at the first unexpected failure instead of repeating.
- **Teardown:** destroy the stage. The inventory shows no functions, table, queues, log groups or alarms.

### T8 — Prod rollout (after merge, with the user's go-ahead)

Status: Not started

- Deploy prod as the README describes, and confirm the API function's `CodeSha256` changed.
- **Smoke test:**
  - import a three-address labelled simulator CSV file into a throwaway list;
  - check the output;
  - delete the list and the three contacts.

## Open questions

None. On 2026-09-24 the user settled:

- **Formats:** CSV is supported beside JSON, with extra columns as attributes.
- **The empty 500 under throttling** was fixed in typed-errors T12.
  - **The bug:** a throttled `TransactWriteItems` sometimes fails to decode DynamoDB's error reply ("HttpClientError: Decode error (400 POST dynamodb) … incorrect header check" from undici's gunzip), and the API answers an empty 500.
  - **Reproduction:** 16 imports in flight into one fresh list throttle within seconds.
