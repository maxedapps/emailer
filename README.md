# Emailer

Self-hosted marketing email over Amazon SES. Deploy it to your AWS account, then manage contacts, lists and campaigns from the CLI.

License: [MIT](LICENSE). Oxlint rules in `tools/oxlint/anti-slop` are vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (MIT, Dillon Mulroy).

## Requirements

- Node.js **24.19.0** (see `.node-version`) and pnpm **12.3.4**
- An AWS account with **SES production access** in the Region you will deploy to (sandbox can only mail verified addresses and the SES mailbox simulator)
- A domain you control
- [Alchemy](https://alchemy.run) **2.0.0-beta.77**, pinned in this repo with Effect **4.0.0-rc.112**

```sh
pnpm install --frozen-lockfile
```

Do not skip lifecycle scripts. There is no build step: Node 24 runs the TypeScript directly.

## Configure

Copy `.env.example` to an untracked `.env` and fill it in. Alchemy and the CLI read the file you pass with `--env-file`; they do not interpolate `$OTHER` inside it.

| Variable                     | Required | Purpose                                                                                                                                                                                       |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAILER_API_TOKEN`          | yes      | Bearer token for every API route. 32 random bytes, base64url (43 characters). Generate with `node -e 'import("node:crypto").then(c => console.log(c.randomBytes(32).toString("base64url")))'` |
| `EMAILER_SENDER_IDENTITY`    | yes      | SES domain identity, e.g. `mail.example.com`. Both stacks must use the same value. Changing it on the identity stack **replaces** the identity and leaves the old one retained but untracked. |
| `EMAILER_FROM_EMAIL`         | yes      | From address. Must belong to `EMAILER_SENDER_IDENTITY`. The domain does not need a mailbox.                                                                                                   |
| `EMAILER_POSTAL_ADDRESS`     | yes      | Physical postal address rendered into every message footer (CAN-SPAM). Empty fails closed at function construction.                                                                           |
| `AWS_REGION`                 | yes      | Region for both stacks. Never guessed.                                                                                                                                                        |
| `EMAILER_DAILY_SEND_CEILING` | no       | Positive integer daily send cap for this stage.                                                                                                                                               |
| `EMAILER_ALERT_EMAIL`        | no       | Alarm notifications. SNS sends one confirmation per stage; follow the `SubscribeURL` before expecting mail.                                                                                   |
| `EMAILER_API_URL`            | CLI      | API Function URL from the `apiUrl` stack output.                                                                                                                                              |
| `AWS_PROFILE`                | deploy   | AWS CLI/SSO profile. Leave unset if you export credentials into the environment.                                                                                                              |

Do not set `EMAILER_UNSUBSCRIBE_SECRET`. Alchemy mints it, binds it into the functions, and **rotates it when the stage is destroyed**, which invalidates every unsubscribe link already sent.

`.env.example` also lists `EMAILER_TEST_*` keys. Those are for the live integration suite only, not for operating the service.

## Sending identity (once per account and Region)

DNS is published by hand. The stacks never create Route 53 or other DNS records.

1. Publish MX, SPF and DMARC **before** SES probes MAIL FROM.
2. Deploy the identity stack at `--stage shared`.
3. Publish the three Easy DKIM `CNAME`s from the stack output `dkimTokens` (or `GetEmailIdentity`).
4. Confirm `MailFromDomainStatus=SUCCESS` and, on a delivered message, `spf=pass`, `dkim=pass` and `dmarc=pass`.

Replace `mail.example.com` with your `EMAILER_SENDER_IDENTITY` and `us-east-1` with your `AWS_REGION`:

- MX `bounce.mail.example.com` → `10 feedback-smtp.us-east-1.amazonses.com`
- TXT `bounce.mail.example.com` → `"v=spf1 include:amazonses.com ~all"`
- TXT `_dmarc.mail.example.com` → `"v=DMARC1; p=none; rua=mailto:dmarc@your-reports.example"`
- If `rua` is on a different organizational domain, also publish TXT `mail.example.com._report._dmarc.<rua-host>` → `"v=DMARC1"`
- After deploy: CNAME `<token>._domainkey.mail.example.com` → `<token>.<SigningHostedZone>` for each DKIM token

Do not use the `bounce.` subdomain as a From address. Never destroy stack `EmailerSending`. Exclude `AWS.SES.*` from `alchemy unsafe nuke`.

```sh
pnpm exec alchemy deploy --config stacks/sending-identity.ts --stage shared --env-file .env --profile emailer --yes --no-input
```

## Deploy the service

**Once per machine.** Alchemy profiles are not AWS CLI profiles:

```sh
pnpm exec alchemy profile create emailer
pnpm exec alchemy profile edit --profile emailer --add AWS --method sso --set ssoProfile=<your-aws-sso-profile>
```

**Once per AWS account and Region.** A deploy fails with `Assets bucket not found` until this exists. Leave the bootstrap and state buckets in place; `alchemy destroy` does not remove them.

```sh
pnpm exec alchemy provider aws bootstrap --aws-profile <your-aws-sso-profile> --region <region>
```

The identity stack must already be deployed. Pick a durable `--stage` (for example `prod`). Omitting it falls back to `live_$USER`.

```sh
pnpm exec alchemy plan   --config alchemy.run.ts --stage prod --env-file .env --profile emailer
pnpm exec alchemy deploy --config alchemy.run.ts --stage prod --env-file .env --profile emailer --yes --no-input
```

Do not pass `--detailed`: it prints bound secrets, including `EMAILER_API_TOKEN` and the unsubscribe signing key. Treat a secret you have printed as exposed and replace it.

The stack deploys four Lambdas (API, dispatcher, bounce/complaint consumer, unsubscribe page), one table, the dispatch queue and its dead-letter queue, a scheduler group, feedback wiring, seven alarms and an alert topic. Both Function URLs are public (`authType: NONE`): the API authorizes with the bearer token; unsubscribe authorizes with the signed token in the link.

Outputs: `apiUrl`, `unsubscribeUrl`, `feedbackFunctionArn`, `feedbackFailureQueueUrl`, `alertsTopicArn`. Put `apiUrl` in `EMAILER_API_URL`.

```sh
pnpm exec alchemy destroy --config alchemy.run.ts --stage prod --env-file .env --profile emailer --yes --no-input
```

Destroying a stage deletes its resources and rotates the unsubscribe key. The sending identity and Alchemy bootstrap/state buckets stay.

## Use

`pnpm emailer` does not load `.env`. Export the two CLI variables, or pass the file to Node:

```sh
node --env-file=.env apps/cli/src/main.ts --help
```

Successful commands print JSON on **stdout** and exit **0**. Diagnostics go to stderr. A usage error prints help on stdout and exits nonzero, so stdout is machine-readable only when the exit status is zero.

```sh
node --env-file=.env apps/cli/src/main.ts contacts create --email you@example.com --name "You"
node --env-file=.env apps/cli/src/main.ts contacts get <contactId>
node --env-file=.env apps/cli/src/main.ts contacts list --limit 25
node --env-file=.env apps/cli/src/main.ts contacts by-email --email you@example.com
node --env-file=.env apps/cli/src/main.ts contacts update <contactId> --email new@example.com --attr plan=pro --attr city=Berlin
node --env-file=.env apps/cli/src/main.ts contacts update <contactId> --clear-name
node --env-file=.env apps/cli/src/main.ts contacts delete <contactId>

node --env-file=.env apps/cli/src/main.ts lists create --name "Readers"
node --env-file=.env apps/cli/src/main.ts lists get <listId>
node --env-file=.env apps/cli/src/main.ts lists list
node --env-file=.env apps/cli/src/main.ts lists members <listId> --limit 50
node --env-file=.env apps/cli/src/main.ts lists rename <listId> --name "Subscribers"
node --env-file=.env apps/cli/src/main.ts lists add-contact <listId> <contactId>
node --env-file=.env apps/cli/src/main.ts lists remove-contact <listId> <contactId>
node --env-file=.env apps/cli/src/main.ts lists import <listId> --file contacts.json
node --env-file=.env apps/cli/src/main.ts lists delete <listId>

node --env-file=.env apps/cli/src/main.ts campaigns create \
  --list <listId> --subject "Release notes" --text newsletter.txt
node --env-file=.env apps/cli/src/main.ts campaigns create \
  --list <listId> --subject "Release notes" --text newsletter.txt --html newsletter.html
node --env-file=.env apps/cli/src/main.ts campaigns create \
  --list <listId> --subject "Release notes" --text newsletter.txt --filter plan=pro
node --env-file=.env apps/cli/src/main.ts campaigns send <campaignId>
node --env-file=.env apps/cli/src/main.ts campaigns get <campaignId>
node --env-file=.env apps/cli/src/main.ts campaigns list
node --env-file=.env apps/cli/src/main.ts campaigns schedule <campaignId> --at 2026-09-20T09:00Z
node --env-file=.env apps/cli/src/main.ts campaigns cancel <campaignId>
node --env-file=.env apps/cli/src/main.ts campaigns resume <campaignId>

node --env-file=.env apps/cli/src/main.ts addresses status --email you@example.com
node --env-file=.env apps/cli/src/main.ts addresses unsuppress --email you@example.com
```

`lists import` expects JSON of the form `{ "contacts": [ { "email": "...", "name": "...", "attributes": { "plan": "pro" } } ] }`. `name` and `attributes` are optional.

### Contracts

- An address identifies at most one contact, case-insensitively. Creating or updating onto an address another contact holds answers **409**.
- `--attr` replaces the whole attribute map; it does not merge. Repeat it per entry. At most 20 entries, keys ≤ 64 characters, values ≤ 512. An omitted flag leaves a field alone; `--clear-name` removes the name.
- `--filter` keeps members whose attributes equal every `key=value` (AND). Omit it for the whole list. Non-matches are skipped with no send row and are not counted in `skipped`.
- `lists import` reports converged state, not a delta. Re-running the same file returns the same answer. At most 20 entries per call; one address may not appear twice. Larger imports are a client-side loop.
- An opt-out holds the address. While opted out, moving the contact onto a different address answers **409** `AddressOptedOut`. Deleting the contact and creating another at the same address does not make it mailable.
- `addresses unsuppress` clears local suppression and the SES **account** suppression list (one list per account and Region, shared with every other sender there). Pass the exact string the listing returns: SES stores suppression entries case-sensitively. It never clears an opt-out.
- Deleting a contact removes it from every list; deleting a list removes every membership in it. Neither deletes the other side. A delete that times out on a large list is safe to repeat.
- Listings page in created order. `--limit` is 1–100, default 25. A page's `nextCursor` is absent exactly when there is nothing more.
- `campaigns list` omits the body; `campaigns get` includes it.
- `campaigns send` exits zero when the campaign is **queued**. Poll `campaigns get` for `progress`, `feedback` (`bounced`, `complained`) and a `paused` reason.
- `campaigns schedule` exits zero when the campaign is `scheduled`. `--at` is an ISO date (`YYYY-MM-DD`) or date-time with minute precision; no zone means UTC. Past instants are **409**. Scheduler fires with 60-second precision. `campaigns send` on a scheduled campaign sends now.
- `campaigns cancel` withdraws a pending run. `scheduled`, or a `queued` first send that never started, returns to `draft`. A `queued` resume returns to `paused` with reason `manual`. `sending`, `completed`, and a conflicting replacement generation are **409**. Cancel does not stop in-flight SES submissions or recall mail.
- An individual recipient is never retried automatically. A lost SES response stays `uncertain`.

Every message gets a postal footer, `List-Unsubscribe` and one-click `List-Unsubscribe-Post`. Open/click tracking is off.

## Operate

**Pause reasons.** `reputation` — wait for the alarm to clear or the account to heal, then `campaigns resume`. A forced `ALARM` persists under `TreatMissingData: ignore` until reset (`aws cloudwatch set-alarm-state --state-value OK …`). `feedback` — this campaign's list tripped the breaker (5% hard bounces after 200 accepted, or 0.1% complaints after 1,000 accepted); clean the list before resuming. `rate-limited` / `daily-quota` / `sending-paused` — wait, then resume.

**Alarms** all notify the stage's alert topic.

| Alarm                                        | Meaning                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `FeedbackFailuresVisible`                    | A bounce/complaint was accepted and could not be processed. Replay it.                    |
| `FeedbackDestinationDeliveryFailures`        | Lambda could not even record the failure. That event is gone.                             |
| `DispatchFailuresVisible`                    | A campaign wake-up died after five receives. The campaign is stuck `sending`; redrive it. |
| `SetBounceRate` / `SetComplaintRate`         | This configuration set at 2% bounces / 0.05% complaints. Silent until the set has sent.   |
| `AccountBounceRate` / `AccountComplaintRate` | The whole account at 5% / 0.1%, including every other SES sender in the account.          |

A fresh stage with `EMAILER_ALERT_EMAIL` set can mail several `OK:` notifications on deploy (`OKActions` fire `INSUFFICIENT_DATA` → `OK`). Those actions stay: an alarm returning to OK is the signal to resume a `reputation` pause.

**Replay failed feedback** (from the non-secret stack outputs; `--env-file` will not expand `$VAR`):

```sh
node --env-file=.env apps/backend/src/ReplayFeedback.ts \
  --queue-url "$EMAILER_FEEDBACK_FAILURE_QUEUE_URL" \
  --function-arn "$EMAILER_FEEDBACK_FUNCTION_ARN" \
  --max-messages 10
```

Safe to repeat. An empty poll is not proof the queue is empty — SQS samples its servers.

**Redrive a campaign stuck `sending`:**

```sh
aws sqs start-message-move-task \
  --source-arn <DispatchFailures ARN> \
  --destination-arn <Dispatch ARN>
```

`campaigns resume` does not apply to `sending`. The dispatcher continues from the persisted cursor.

**A campaign stuck `scheduled`.** Passing the wall-clock minute is not proof of failure (60-second scheduler precision plus queue delay). If it needs to start now, `campaigns send` replaces the run token so a late scheduled wake-up is stale.

Gmail sends no complaint feedback loop to SES. Watch the domain in Google Postmaster Tools, and read DMARC aggregate reports at the `rua` address you published.

The account suppression list survives `alchemy destroy`. A test run can leave `simulator.amazonses.com` entries; remove them with the exact string `addresses status` returns.

## Credits

This repository vendors [anti-slop](https://github.com/dmmulroy/anti-slop) by Dillon Mulroy, MIT licensed. The copy lives at `tools/oxlint/anti-slop` with its [LICENSE](tools/oxlint/anti-slop/LICENSE) and [provenance](tools/oxlint/anti-slop/UPSTREAM.md).
