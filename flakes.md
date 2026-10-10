# Flaky tests

The flake ledger ([ADR-0035](.adr/0035-flaky-tests-rerun-ledger-and-dated-skips.md)): `pnpm gate` appends a line for each failed test that passed when rerun alone. Replace its cause `?` with the suspected cause and commit the line with the fix or the skip.

