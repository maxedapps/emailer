# Plan: A sign-up API with scoped keys, double opt-in and per-list opt-out

- Status: In progress
- Decision: [ADR-0027](0027-signup-api-scoped-keys-and-double-opt-in.md)

## Goal

**Done when:**

- opt-outs are per list, end to end: link, page, storage, the send path, test sends and `addresses status`;
- the mailer sends one `Mail` tagged enum;
- the operator creates, lists and revokes scoped keys from the CLI, and a scoped key reaches only the sign-up endpoints;
- a site can start a double opt-in and confirm it through the API, with typed errors, and the consent evidence is stored;
- the README documents keys, the sign-up API and per-list unsubscribe;
- the live gate passes, and prod runs the result with TTL enabled on the retained table.

**Out of scope:**

- hosted sign-up or confirm pages;
- key expiry or key editing;
- consent records for imported contacts;
- other languages;
- a CLI command that starts a sign-up;
- any change to campaigns, pacing, feedback, imports or the function set.

## Rules for every task

- Work in one worktree off `main`, one commit per task, with `pnpm check` green.
- Every task states its running-cost effect. A task that raises the cost of an existing path does not ship.
- No compatibility code: nothing real has been sent, so old links and old fields are simply dropped.
- Only neutral placeholders (`example.com`) in code, tests and docs.

## Tasks

### T1 — Per-list opt-out

Status: Done

- **Storage (`apps/backend/src/storage/Addresses.ts`):**
  - Replace `unsubscribedAt` with `optOuts`, a string set of list ids, decoded by the status reader.
  - `optOut({email, listId})` is one `UpdateItem`: `SET` the version and mailbox stamp, `ADD optOuts :list`. It replaces `unsubscribeWrites.unsubscribeAddress` and the `AddressUnsubscribe` type.
  - `addressStatus(email, listId)` answers `unsubscribed` when the set holds the list, then suppression and bouncing as today.
  - `addressRecord` reads the address's whole partition with one strongly consistent `Query`, so T6 and T7 can add consent and pending entries.
  - The record reports:
    - a mailbox-level `status` (`mailable | suppressed | bouncing`);
    - `optOuts`;
    - its suppression and transient bounces as today.
- **Contract (`packages/api/src/Schemas.ts`):**
  - `AddressRecord` drops `unsubscribedAt` and gains `optOuts: Array<EntityId>`.
  - Its `status` becomes a `MailboxStatus` without `unsubscribed`.
  - `AddressStatus` and `SkipReason` keep `unsubscribed`, now meaning "this list".
- **Token (`apps/backend/src/consent/Unsubscribe.ts`):**
  - `mintToken`, `verifyToken` and `unsubscribeLink` take and return `{ mailbox, listId }`. Signed fields: `[base64url(mailbox), listId]`.
  - `maxTokenLength` is `lengthFor([encodedLength(maxEmailLength), 36])`.
- **Page (`UnsubscribePage.ts`):** the POST calls `optOut` for the token's list. The confirmation text says the reader won't get mail from this list again.
  - `storage/Unsubscribe.ts` still binds `UpdateItem` only.
- **Send paths:**
  - `sending/Dispatching.ts` passes the run's list id to `addressStatus` and `unsubscribeLink`.
  - `campaigns/TestSends.ts` uses the campaign's `listId` for both, including explicit `to` addresses.
- **Address change (`storage/Contacts.ts`):** ADR-0006's check becomes `attribute_not_exists(optOuts)`. DynamoDB drops an emptied set, so a lifted last opt-out frees the address again.
- **CLI (`apps/cli/src/commands/Addresses.ts`):** `addresses status` prints the new record. Only the description changes.
- **Other callers of the changed signatures**, updated in this task so `pnpm check` stays green:
  - `apps/backend/test/IntegrationSupport.ts` (`addressStatus`);
  - `consent/Unsubscribe.live.ts` (token minting);
  - `storage/Testing.ts`;
  - `api/Api.test.ts`.
- **Cost:** unchanged. One read per recipient, one write per unsubscribe, and the set adds about 36 bytes per list.

**Verify:**

- `Addresses.test.ts`:
  - `optOut` sends one `UpdateItem` with `ADD optOuts`;
  - `addressStatus` is `unsubscribed` for the opted-out list and `mailable` for another;
  - suppression outranks nothing it didn't before.
- `Unsubscribe.test.ts`: a token round-trips `{mailbox, listId}`; a token with a changed list fails verification; the frozen-token test is re-pinned.
- `UnsubscribePage.test.ts`: the POST writes the token's list.
- `Dispatching.test.ts` and `TestSends.test.ts`: a recipient opted out of the campaign's list is skipped as `unsubscribed`; one opted out of another list is sent.
- `Contacts.test.ts`: the move's condition is `attribute_not_exists(optOuts)` and still answers `AddressOptedOut`.

### T2 — One `Mail` tagged enum for the mailer

Status: Done

- **Where:** `apps/backend/src/sending/Mailer.ts`.
- **The type:** `Mail = Data.TaggedEnum<{ Campaign: { content, unsubscribeUrl, campaignId, sendId }; Test: { content, unsubscribeUrl } }>`. T6 adds `Confirmation`.
- **Sending:**
  - `send(recipient, mail)` composes through `Mail.$match`: `compose` for `Campaign` and `Test`.
  - Only `Campaign` sets `EmailTags`.
  - Remove `SendPurpose` and the loose `makeSend` arguments. The SES request, error mapping and timeout are unchanged.
- **Callers:** `Dispatching.ts` (`submitClaimed`) and `TestSends.ts`, plus the mailer doubles in `Dispatching.test.ts`, `TestSends.test.ts` and `Api.test.ts`.
- **`$match`:** exported by `Data.taggedEnum` in the installed rc.117.
- **Cost:** none.

**Verify:** `Mailer.test.ts`:

- a `Campaign` mail carries both tags and the unsubscribe headers;
- a `Test` mail carries the headers and no tags;
- the error mapping tests still pass unchanged.

### T3 — One module for the tokens we issue

Status: Done

- **Rename** `apps/backend/src/SignedToken.ts` to `Tokens.ts` and update its importers: `consent/Unsubscribe.ts`, `campaigns/Previews.ts`, `api/Auth.ts`, and their tests.
- **Add the hashed-secret half:**
  - `issueSecret`: `Crypto.randomBytes(32)` → base64url, as `Redacted`;
  - `hashSecret`: `Crypto.digest("SHA-256")` → hex.
- **Cost:** none.

**Verify:**

- `Tokens.test.ts` (the renamed `SignedToken.test.ts`): a secret is 43 base64url characters, two secrets differ, and a hash is stable, 64 hex characters, and differs per secret.

### T4 — Scoped API keys

Status: Done

Deviations:

- `Forbidden` lands in T6, its first user, because knip rejects an unused export.
- Key creation (`createKey`) sits in `api/Auth.ts`, beside the `emk.<id>.<secret>` format it issues and parses.

- **Contract (`packages/api/src`):**
  - `Api.ts`:
    - `AdminAuthorization` (bearer, `Unauthorized`) replaces `Authorization`;
    - `Integration` is a `Context.Service` holding `{ keyId, lists, confirmUrl }`;
    - `SubscriptionAuthorization` uses `HttpApiMiddleware.Service<…, { provides: Integration }>` with bearer, errors `Unauthorized | StorageUnavailable`, and `requiredForClient`;
    - new group `keys`: `POST /keys` (201 `CreatedApiKey`), `GET /keys` (`ApiKey[]`, unpaged), `DELETE /keys/:id` (204, `ApiKeyNotFound`).
    - **Group order:** `HttpApi.make(...).add(contacts, lists, campaigns, addresses, keys).middleware(AdminAuthorization)`, then T6's `.add(subscriptions)` after it. Explain the order in a comment.
  - `Schemas.ts`:
    - `ConfirmUrl`: an absolute `https:` URL, at most 2,000 characters;
    - `ApiKey`: `{id, name, lists: NonEmptyArray<EntityId>, confirmUrl, createdAt}`;
    - `CreateApiKeyPayload`;
    - `CreatedApiKey`: `ApiKey` plus `key`.
  - `Errors.ts`: `ApiKeyNotFound` (404), `Forbidden` (403).
  - `Client.ts`: `makeEmailerClient` keeps its signature and supplies `layerClient` for both middlewares with the same bearer. Its callers therefore don't change: the CLI's `Client.ts`, `CliHarness.ts`, `IntegrationSupport.ts` and the live suites. `Client.test.ts` covers both.
- **Storage (`apps/backend/src/storage/ApiKeys.ts`, new):**
  - Items `pk=APIKEY, sk=<id>`.
  - Operations:
    - `createKey`: a conditional `Put`;
    - `getKey`: a strongly consistent `GetItem`;
    - `listKeys`: one `Query`;
    - `revokeKey`: a one-action `transact` with a conditional `Delete` → `ApiKeyNotFound`. `TableOperations` has no `DeleteItem`, and every existing delete already goes through `transact`.
  - An `ApiKeyStore` service builds on the primitives over `allTableOperations`, the binding the Api function already holds. No new IAM action.
- **Auth (`apps/backend/src/api/Auth.ts`):**
  - The admin layer is today's check: `apiToken` config plus `tokensMatch`.
  - The subscription layer:
    1. parses `emk.<uuid>.<43 chars>` with one Schema;
    2. `getKey`;
    3. compares `hashSecret(secret)` with the stored hash;
    4. provides `Integration` with `Effect.provideService`.
  - Any mismatch is `Unauthorized`.
  - The admin token is never tried as a key, and a key is never compared with the admin token.
- **Handlers (`api/Api.ts`):**
  - `keys` handlers: `create` issues the id and secret and stores only the hash.
  - `ApiKeyStore.layer` joins `apiLayer`, and `makeApiHandler` provides both authorization layers.
- **CLI (`apps/cli/src/commands/Keys.ts`, new, registered in `Emailer.ts`):**
  - `keys create --name <name> --list <id> [--list …] --confirm-url <url>` prints the created key once;
  - `keys list`;
  - `keys revoke <id>`.
- **Cost:** admin calls unchanged. A scoped call adds one strongly consistent read.

**Verify:**

- `Api.test.ts`, via `HttpApi.reflect`:
  - every admin endpoint answers 401 to a valid scoped key;
  - every `subscriptions` endpoint answers 401 to the admin token (once T6 adds them).
- `Auth.test.ts`:
  - a stored key authorizes and provides its lists;
  - a wrong secret, an unknown id, a revoked key and a malformed token each answer 401;
  - the existing admin tests stay.
- `ApiKeys.test.ts`: the key layout, only the hash stored, and revoking a missing key is `ApiKeyNotFound`.
- CLI in-process tests (`Keys.test.ts`): `--list` repeats into an array, and `create` prints the key.

### T5 — Subscription records and TTL

Status: Done

Deviations:

- The pending and consent records' keys and codecs live in `storage/Addresses.ts`, the module for the `ADDRESS#` partition. `addressRecord` reads them there, and `storage/Subscriptions.ts` imports them, so no import cycle arises. The consent key lands in T7, its first user.
- The pending item also stores `listId`, so `addressRecord` reads it without parsing the sort key.
- `requestSubscription(request)` takes the request, whose `requestedAt` is now, and derives `ttl` itself.
- A new `putIf` primitive gives the conditional `Put` its typed refusal. `recordOnce` swallows a failed condition, and a one-action transaction would bill twice.
- The condition also accepts the same `secretHash`, so the same request landing twice after a lost response is not refused by its own first landing.

- **Table (`apps/backend/src/storage/Table.ts`):** `timeToLiveSpecification: { AttributeName: "ttl", Enabled: true }`.
- **Import steps (`storage/Membership.ts`):** extract from `importContacts` two helpers without changing its behaviour:
  - `readHolders(candidates)`, the reservation pre-read;
  - `joinActions(listId, candidates, holders, addedAt)`, which returns the actions and the converged result.
  - `importContacts` becomes: list read, `readHolders`, `joinActions`, `transact`.
- **Records (`storage/Subscriptions.ts`, new, part of `AudienceStore`):**
  - `ADDRESS#<m>/PENDING#<listId>`: `{email, name?, attributes?, source, wording, ip, requestedAt, secretHash, ttl}`.
  - `ADDRESS#<m>/CONSENT#<listId>#<confirmedAt>`: `{listId, source, wording, ip, requestedAt, confirmedAt, confirmIp}`.
- **Operations:**
  - `subscriptionState(listId, email)`: the address item (suppression, bounces, `optOuts`) and the reservation read concurrently, then the member item if a contact holds the address. It answers `undeliverable | subscribed | not-subscribed`.
  - `requestSubscription(pending, now)`: a `Put` with the condition `attribute_not_exists(pk) OR requestedAt < :hourAgo`, refused as `ConfirmationRecentlySent`. A newer request replaces the older one's link.
  - `confirmSubscription(...)`: T7.
- **`addressRecord`** also reports `consents` and `pending` (`listId, requestedAt, expiresAt`).
- **`storage/Testing.ts`:** stubs for the new operations (T5 through T7).
- **Cost:** none on existing paths. `addressRecord` is still one read unit for a normal partition.

**Verify:**

- `Membership.test.ts`: the existing import tests pass without assertion changes.
- `Subscriptions.test.ts`:
  - the pending `Put`, its condition and a `ttl` in epoch seconds;
  - a refused condition answers `ConfirmationRecentlySent`;
  - `subscriptionState` answers each of its three cases.

### T6 — `POST /subscriptions`

Status: To do

- **Contract:**
  - group `subscriptions`, with `.middleware(SubscriptionAuthorization)`, added after `AdminAuthorization`.
  - `POST /subscriptions`:
    - payload `SubscribePayload`: `{listId, email, name?, attributes?, consent: {source: EntityName, wording: 1–1,000 characters}, ip: 1–45 characters}`;
    - success `[ConfirmationSent (202), AlreadySubscribed (200)]`;
    - errors `Forbidden`, `ListNotFound`, `AddressUndeliverable` (422, `{reason: suppressed | bouncing}`), `ConfirmationRecentlySent` (429, `{retryAfter: Timestamp}`, the time a new mail may go out), `SendingPaused`, `EmailServiceUnavailable`, `StorageUnavailable`.
- **Domain (`apps/backend/src/consent/Subscriptions.ts`, new): `subscribe`**, in this order:
  1. The list must be in `Integration.lists`, else `Forbidden`. Read the list, else `ListNotFound`.
  2. `subscriptionState`: `undeliverable` → `AddressUndeliverable`; `subscribed` → `AlreadySubscribed`.
  3. `guard.current`: a refusal → `SendingPaused`, before anything is written.
  4. `issueSecret`, then `requestSubscription`.
  5. The pacing slot, then `mailer.send(email, Mail.Confirmation({ listName, confirmUrl }))`.
     - `confirmUrl` is the key's URL with `token` set through `URL.searchParams`.
     - A definite SES refusal → `EmailServiceUnavailable`.
     - An uncertain submission counts as sent.
  6. Answer `ConfirmationSent`.
- **Mail:**
  - `Mailer.ts`: `Mail` gains `Confirmation`, with no tags.
  - `Message.ts`: `composeConfirmation(listName, confirmUrl, postal)`.
    - Subject: `Please confirm your subscription to <list name>`.
    - Text and HTML: the request, the button or link, the 7-day expiry, "if you didn't ask for this, ignore this email and you won't be added", and the postal address.
    - Escaped as in the footer, with no `List-Unsubscribe` headers.
- **Cost:** new path only: about 5 reads, 2–3 writes and one SES mail per sign-up.

**Verify:**

- `Subscriptions.test.ts`, with `TestClock`:
  - every answer and error above;
  - nothing is written when the guard refuses;
  - the link carries the token and keeps the URL's own query;
  - a second sign-up within the hour answers 429, and after the hour sends again.
- `Message.test.ts`: the subject, the escaped list name, the link in both parts, and no unsubscribe headers.
- `Api.test.ts`: the status codes and error tags end to end, and a list outside the key answers 403.

### T7 — `POST /subscriptions/confirm`

Status: To do

- **Contract:**
  - payload `{token: ConfirmationToken, ip}`;
  - success `Subscribed {listId}`;
  - errors `Forbidden`, `ConfirmationNotFound` (404), `ListNotFound`, `ContactChanged`, `StorageUnavailable`.
- **Domain (`confirm`):**
  1. Parse the token: mailbox, list, secret. A token that doesn't parse is `ConfirmationNotFound`.
  2. Check the list against the key, else `Forbidden`.
  3. `confirmSubscription`.
- **Storage (`confirmSubscription` in `storage/Subscriptions.ts`):**
  - **Read concurrently:** the pending item, the list, the address item and the reservation.
  - **Refuse** with `ConfirmationNotFound` if the pending item is missing, its `ttl` has passed (TTL deletes lazily), or its hash differs. A missing list is `ListNotFound`.
  - **One transaction:**
    - `joinActions` for the pending contact;
    - a `Put` of the consent record;
    - a `Delete` of the pending item, conditioned on `secretHash = :hash` and refused as `ConfirmationNotFound`;
    - if `optOuts` holds the list, an `Update` with `DELETE optOuts :list`.
  - `retryLostRace` still retries `ContactChanged` only.
- **Cost:** new path only: about 5 reads and one transaction of about 14 write units per confirmation.

**Verify:** `Subscriptions.test.ts`:

- the whole transaction for a new contact and for an existing one;
- the opt-out removal appears only when the set holds the list;
- an expired, missing or wrong-secret link and a pending delete refused mid-transaction each answer `ConfirmationNotFound` and are not retried;
- `ContactChanged` is retried.

### T8 — Docs

Status: To do

- **README:**
  - "What you get": a sign-up API with double opt-in, and per-list unsubscribe.
  - "What it does not do": no hosted sign-up or confirm pages.
  - A section on `keys` (create, rotate by create, swap and revoke; the key is shown once).
  - A section for site integrators:
    - both endpoints, their bodies, status codes and error tags;
    - undeclared fields are refused (ADR-0022);
    - the confirm page must confirm on POST, never on GET;
    - show one "check your inbox" message for 202, 200 and 429.
- **ADRs 0004, 0006 and 0007:** add "Superseded in part by ADR-0027" lines.
- **Cost:** none.

**Verify:** each README command matches the CLI's `--help`, and `pnpm check` passes.

### T9 — Live gate

Status: To do

- **New module `apps/backend/src/consent/Subscriptions.live.ts`**, registered in `apps/backend/test/Live.integration.test.ts`. With the admin token it creates a list and a key, then with the key:
  - signs up `success@simulator.amazonses.com` and expects 202 and a pending record with a `ttl`;
  - signs up again at once and expects 429;
  - confirms a pending record the test planted with a known secret (the real link only exists in the mail) and expects the member, one consent record and a lifted opt-out for that list;
  - confirms the same link again and expects 404;
  - calls a list outside the key and expects 403, and an admin endpoint with the key and expects 401.
- **`Unsubscribe.live.ts`:** an opt-out from one list leaves the address mailable on another. Moving the contact is refused with `AddressOptedOut`.
- **`IntegrationSupport.ts`:** new helpers to plant a pending record and to read the address partition. Its signature changes were made in T1.
- **Cost:** only while the test stage exists.

**Verify:** the live run deploys its own stage, passes, and destroys it, with nothing left behind.

### T10 — Prod rollout

Status: To do (on the user's go)

1. `alchemy plan --stage prod`: `EmailerData` must be an update, never a replace.
2. Deploy with `--force`, then check that every function's `CodeSha256` changed.
3. `aws dynamodb describe-time-to-live` reports `ttl` as `ENABLED`.
4. Remove leftover `unsubscribedAt` fields: scan with `attribute_exists(unsubscribedAt)`, then `REMOVE unsubscribedAt` per item. No code change.
5. Create the site's key with `pnpm emailer keys create`, and hand it over as the site's secret.

- **Cost:** none beyond the above.

**Verify:**

- with the new key, one sign-up through the API from here to an inbox readable through uMail, then a confirmation with the token from the delivered mail. The site's own form is the user's check, on their machine;
- `addresses status` shows the consent record.

## Open questions

- None. The defaults chosen here:
  - consent wording up to 1,000 characters;
  - the IP as a string of up to 45 characters;
  - a confirm URL up to 2,000 characters.
