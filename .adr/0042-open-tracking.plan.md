# Plan: open tracking (ADR-0042)

Task 4102. [ADR-0042](0042-open-tracking.md) holds the design and its cost.

## Goal

- Campaign mail goes out with SES's open pixel. Each open is recorded on the recipient's send row: first open time and open count.
- `campaigns get` shows total and unique opens per campaign and per copy.
- `campaigns opens <id>` lists who opened.

## Non-goals

- Click tracking. Opens of test copies and sign-up confirmations. Open rates per copy, which would need a send counter per copy and more writes on every send.

## Tasks

1. **One configuration set, tracking turned off per message** (`sending/Mailer.ts`): `EmailerMail` also publishes `OPEN`. Test copies and confirmations send with `ConfigurationOverrides.Tracking.OpenTrackingEnabled: DISABLED`, and the Mailer grants `ses:ApplyTrackingConfigurationOverrides` for that value only. `Mail.Campaign` gets a `contactId` tag. Unit: `Mailer.test.ts` (override per mail kind, tags).
2. **Consumer** (`feedback/`): the rule also matches `Email Opened`, and only this stage's configuration set; the handler's set check goes. The handler decodes `Open`, skips `isBotEvent: Likely` and records the rest through `FeedbackStore.recordOpen`. Unit: `Feedback.test.ts`, `FeedbackClassification.test.ts`.
3. **Storage** (`storage/Feedback.ts`): `recordOpen` reads the send row, then runs one transaction: the send row (earliest `openedAt`, `opens + 1`, `lastOpen` event id, conditioned on the read) and the copy's `OPENS#<copy>` counter (`total + 1`, `unique + 1` on a first open). A redelivered event is a no-op, and a race retries from a fresh read. Unit: `storage/Feedback.test.ts`.
4. **API and storage reads** (`packages/api`, `storage/Campaigns.ts`, `api/Api.ts`): `Campaign.opens` (`unique`, `total`, `copies`) is set once the submission carries progress, from one Query of the counters, with zeros for copies nobody opened. `GET /campaigns/:id/opens?cursor=` returns one DynamoDB page of send rows filtered to openers. Unit: storage and API tests.
5. **CLI** (`apps/cli`): `campaigns opens <id>` pages through every opener and prints them by first open. `campaigns get` prints `opens` as is. Unit: CLI command tests.
6. **Docs**: README (what it does, what it does not do, output, privacy: Apple Mail Privacy Protection, personal data, HTML only); ADR-0003, ADR-0028 and ADR-0041 amended.
7. **Live**: the feedback suite injects an `Email Opened` envelope onto the stage's feedback queue for a simulator send (the simulator produces no opens), then checks `campaigns get` and `GET /opens`. The landing gate runs whatever groups the reach map picks.

## Evidence

- CLI output of `campaigns get` and `campaigns opens` on my test stage after an injected open.
- Key files and excerpts from the landed commit.

## Open questions

- None. The full live run the reach map calls for was put to Max on topic 4102.
