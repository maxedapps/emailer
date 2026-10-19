# Plan: Single opt-in keys and an opt-out endpoint for integrations

- Status: Accepted
- Decision: [ADR-0037](0037-single-opt-in-keys-and-integration-opt-out.md)

## Goal

**Done when:** a scoped key created with `--single-opt-in` adds subscribers to its lists directly through `POST /subscriptions` (same payload, consent evidence stored, attributes kept, opt-outs never lifted); double opt-in keys behave as today; `POST /subscriptions/opt-out` opts an address out of one of the key's lists, idempotently; API package, CLI, README and ADR-0027 say so; landed on `main` through `pnpm leak-check && pnpm gate`.

**Out of scope:** the prod deploy; creating the cohort list or key anywhere but a test stage; any change to the site that calls the API.

## Rules for every task

- Worktree `~/worktrees/emailer/task-1299-single-opt-in`, branch `task-1299-single-opt-in`; logs in `~/tmp/t1299/`.

## Tasks

### T1 — Contract (`packages/api/src/Schemas.ts`, `Api.ts`, `Errors.ts`)

- `ApiKey.confirmUrl` and `CreateApiKeyPayload.confirmUrl` become `optionalKey`; doc comments say a key without one is single opt-in.
- `ConsentRecord` becomes a union of `DoubleOptInConsent` (today's fields) and `SingleOptInConsent` (`listId, source, wording, ip, subscribedAt`).
- `OptOutPayload { listId, email }`.
- `Integration` provides `optIn: OptIn`, a `Data.TaggedEnum` `Double { confirmUrl } | Single` exported beside it.
- `SubscriptionsGroup`: `subscribe` adds `Subscribed` (201), `AddressOptedOut` and `ContactChanged`; new `optOut` (`POST /opt-out`, 204, errors: storage, `Forbidden`). Group doc covers both modes.
- `AddressOptedOut` doc generalised (the address left a list).
- Tested through their users: both consent shapes in `Addresses.test.ts`, a key without confirm URL in `Api.test.ts` (`201`) and `Auth.test.ts`. `Schemas.test.ts` keeps to rules the contract adds beyond Effect's own checks, and this adds none.

### T2 — Auth (`apps/backend/src/api/Auth.ts`)

- `subscriptionAuthorization` maps the stored key to `OptIn`; `createKey` stores `confirmUrl` only when given.
- Tested: `Auth.test.ts` (a single opt-in key's handler sees `Single`; a double one sees `Double` with its URL).

### T3 — Storage (`apps/backend/src/storage/Subscriptions.ts`, `Addresses.ts`, `Audience.ts`)

- `SubscriptionState` gains `OptedOut` (mailable, but the list is in `optOuts`), split from `NotSubscribed`.
- One helper builds a join-with-consent transaction (list and holders read, `joinActions`, the consent `Put`); `confirmSubscription` and the new `subscribeDirectly` both use it, so the join steps exist once.
- `subscribeDirectly({ email, listId, name, attributes, source, wording, ip, contactId, subscribedAt })`: refuses `ListNotFound`, retries lost races like the confirmation.
- `writeConsent`/`readConsent` take the union. `consentKey` names its timestamp neutrally.
- `unsubscribeWrites` becomes `optOutWrites` (its doc no longer claims a single user), merged into `audienceOperations` so the API function opts out with the permission it already has.
- Tested: `storage/Subscriptions.test.ts` (direct join writes contact, reservation, both memberships and the single consent record, never touches `optOuts`; `OptedOut` state); `Addresses.test.ts` (both consent shapes in `addressRecord`).

### T4 — Domain and handlers (`apps/backend/src/consent/Subscriptions.ts`, `apps/backend/src/api/Api.ts`)

- `subscribe` matches state × mode: `Double` keeps today's flow (`OptedOut` and `NotSubscribed` both mail a link); `Single` joins on `NotSubscribed` (→ `Subscribed`) and fails `AddressOptedOut` on `OptedOut`.
- `optOut(payload)`: `Forbidden` unless the key covers the list, then `audience.optOut`.
- Handler `optOut` wired in `subscriptionsHandlers`.
- Tested: `consent/Subscriptions.test.ts` (single: joins without mail or guard, refuses an opted-out address, already subscribed, undeliverable; double: unchanged incl. opted-out → mail; opt-out: forbidden list, success); `Api.test.ts` (route statuses 201/204, admin token refused on `/subscriptions/opt-out`, key refused elsewhere stays).

### T5 — CLI (`apps/cli/src/commands/Keys.ts`, `apps/cli/test/CliHarness.ts`)

- `keys create` takes exactly one of `--confirm-url <url>` / `--single-opt-in`; neither or both fails before any call, naming the two flags.
- Tested: `Keys.test.ts` (single opt-in payload has no `confirmUrl`; neither/both refused).

### T6 — Live suite (`apps/backend/src/consent/Subscriptions.live.ts`)

- New test in the `subscriptions` group: a single opt-in key signs up a fresh address with attributes → `Subscribed`, member and contact attributes present, consent record `{ subscribedAt, source, wording, ip }`; again → `AlreadySubscribed`; opt-out through the endpoint → `204`, `addresses status` lists the opt-out, again → `204` unchanged; sign-up again → `AddressOptedOut`; other list → `Forbidden` for both endpoints. No mail is sent.
- No new group, so `LiveGroups.ts` and `LiveReach.ts` stay.

### T7 — Docs (`README.md`, `.adr/0027-…md`)

- README: feature line; "Sign-ups from your website" covers both modes, the CLI choice, the `201`/`409` rows, the opt-out endpoint table, and a worked recipe: create a single opt-in list and its key (`lists create`, `keys create --single-opt-in`), then the calls. Commands table and "What commands print" updated.
- ADR-0027: an `Amended by ADR-0037` line.

### T8 — Verify

- `pnpm check` (log `~/tmp/t1299/check.log`) and the changed unit test files.
- Hand check on a fresh `pnpm stages up` stage with the CLI and `curl`: create a list, a single opt-in key and a double opt-in key; single sign-up with `attributes.page_path`; `addresses status` shows the consent; opt-out twice; sign-up refused with 409; double opt-in sign-up to a simulator address still answers 202. `pnpm stages down`.
- `pnpm leak-check && pnpm gate` on the merged result (reaches all groups; whole run asked for on 2026-10-19).

## Evidence

No UI: the exact API contract and CLI steps in the report, key files and snippets from the landed commit (`consent/Subscriptions.ts` `subscribe`, the `SubscriptionsGroup`, `Keys.ts` flags), and the stage hand-check transcript with keys and IDs removed.

## Cost

As ADR-0037's Consequences: no new resource, index, permission, queue or idle cost; double opt-in and admin paths unchanged. A single opt-in sign-up does the double one's reads and the confirmation's join (contact GSI write on a new contact, consent item storage) without the pending write, send guard, SES mail and confirm call. An opt-out is one API invocation (duration, logs), one strongly consistent key read (1 RRU) and one base-table `UpdateItem` (1 WRU, growing with `optOuts`), no GSI write.

## Open questions

None.
