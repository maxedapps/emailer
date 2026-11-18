# Flaky tests

The flake ledger ([ADR-0035](.adr/0035-flaky-tests-rerun-ledger-and-dated-skips.md)): `pnpm gate` appends a line for each failed test that passed when rerun alone. Replace its cause `?` with the suspected cause and commit the line with the fix or the skip.

- 2026-11-18 task-4068 `apps/backend/test/Live.integration.test.ts > variants > campaign variants > holds as many variants as a campaign may, each at its size limits, and deletes them together` — StorageUnavailable: — cause: DynamoDB ThrottlingException on deleteDraft's transaction over the maximum variants, while four live groups write the fresh on-demand table at once
