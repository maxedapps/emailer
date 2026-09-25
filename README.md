# Emailer

Self-hosted marketing email over Amazon SES. Deploy it to your own AWS account, then manage contacts, lists and campaigns from the command line.

## What you get

- **Audience:** contacts with up to 20 `key=value` attributes, lists, and JSON or CSV imports.
- **Campaigns** written in Markdown and rendered to email-safe HTML and plain text, or supplied as your own text and HTML files.
- **Targeting:** send to a whole list, or only to members whose attributes match a filter.
- **Drafting:** preview links that open on any device, and `[Test]` copies to up to 20 addresses.
- **Delivery:** send now or schedule for later; cancel a pending send and resume a paused one.
- **Compliance:** one-click unsubscribe (`List-Unsubscribe` and `List-Unsubscribe-Post`) and your postal address in every footer.
- **List hygiene:** bounced and complaining addresses are suppressed automatically. A campaign pauses itself when its list bounces or complains too much, and every campaign pauses when the account's reputation alarms fire.
- **Pacing:** sends stay within your SES rate and daily quota, with an optional daily cap of your own.
- **Alerts:** CloudWatch alarms, delivered by email.
- **Optional:** DNS records (DKIM, SPF, DMARC, MAIL FROM) managed in Route 53 or Cloudflare, and a display name on the From address.

## What it does not do

- There is no web interface. You manage everything from the CLI.
- There are no sign-up forms or double opt-in. Contacts come in through the CLI.
- There is no personalization. Every recipient gets the same content, apart from their own unsubscribe link.
- There is no open or click tracking.
- Markdown campaigns share one fixed layout. For any other design, supply your own HTML.

## How it works

- **Two stacks**, both deployed with [Alchemy](https://alchemy.run):
  - `stacks/sending-identity.ts` owns the SES domain identity and, optionally, its DNS records. You deploy it once per AWS account and Region.
  - `alchemy.run.ts` is the service. You deploy it once per stage, such as `prod`.
- **API:** a Lambda behind a public Function URL, authorized with a bearer token. The CLI is its client.
- **Sending:** `campaigns send`, or a one-time EventBridge Scheduler schedule, queues the campaign on SQS. A dispatcher Lambda then sends one message per recipient through SES, paced within your quota.
- **Feedback:** SES bounce and complaint events reach a feedback Lambda through EventBridge and an SQS queue. It suppresses the address and counts the event against its campaign.
- **Public pages:** the unsubscribe page and the preview page are separate Lambdas that accept only signed links.
- **Storage and alerts:** one DynamoDB table holds contacts, lists, campaigns and sends. CloudWatch alarms notify an SNS topic.

## Requirements

- Node.js **24.19.0** (see `.node-version`) and pnpm **12.3.4**
- An AWS account with **SES production access** in the Region you will deploy to (sandbox can only mail verified addresses and the SES mailbox simulator)
- A domain you control
- [Alchemy](https://alchemy.run) **2.0.0-beta.79**, pinned in this repo with Effect **4.0.0-rc.117**

```sh
pnpm install --frozen-lockfile
```

Do not skip lifecycle scripts. There is no build step: Node 24 runs the TypeScript directly.

## First deployment at a glance

1. Get SES production access in your Region.
2. Fill in `.env` ([Configure](#configure)).
3. Create the Alchemy profile and bootstrap the account ([One-time setup](#one-time-setup)).
4. Set up the sending identity ([Sending identity](#sending-identity-once-per-account-and-region)):
   - without `EMAILER_DNS`, publish its MAIL FROM and DMARC records first;
   - deploy the identity stack, then publish its DKIM records if DNS is manual;
   - wait until SES reports it verified.
5. Deploy the service and put `apiUrl` into `.env` ([Deploy the service](#deploy-the-service)).
6. If you set `EMAILER_ALERT_EMAIL`, confirm the subscription mail it receives.
7. Send your first campaign ([Your first campaign](#your-first-campaign)).

Nothing is manual outside the CLI when `EMAILER_DNS` manages your zone, except a DMARC report authorization record on another domain. Without it, you publish DNS by hand:

- six records for a domain without DMARC;
- five if it already has one;
- one more if DMARC reports go to another domain.

## Configure

Copy `.env.example` to an untracked `.env` and fill it in. Alchemy reads the file you pass with `--env-file`, and the CLI reads `.env` (see [Use](#use)). Neither interpolates `$OTHER` inside it.

| Variable                     | Required | Purpose                                                                                                                                                                                                                               |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAILER_API_TOKEN`          | yes      | Bearer token for every API route. 32 random bytes, base64url (43 characters). Generate with `node -e 'import("node:crypto").then(c => console.log(c.randomBytes(32).toString("base64url")))'`                                         |
| `EMAILER_SENDER_IDENTITY`    | yes      | SES domain identity, e.g. `mail.example.com`. Both stacks must use the same value. Changing it on the identity stack **replaces** the identity and leaves the old one retained but untracked.                                         |
| `EMAILER_FROM_EMAIL`         | yes      | From address. Must belong to `EMAILER_SENDER_IDENTITY`. The domain does not need a mailbox.                                                                                                                                           |
| `EMAILER_POSTAL_ADDRESS`     | yes      | Physical postal address rendered into every message footer (CAN-SPAM). Empty fails closed at function construction.                                                                                                                   |
| `AWS_REGION`                 | yes      | Region for both stacks. Never guessed.                                                                                                                                                                                                |
| `EMAILER_FROM_NAME`          | no       | Name shown beside the From address, e.g. `Example News`. At most 45 UTF-8 bytes; quotes, backslashes and line breaks fail the deploy's plan. Unset or empty: the bare address.                                                        |
| `EMAILER_DNS`                | no       | `route53` or `cloudflare`: the identity stack publishes its DNS records in the Route 53 hosted zone of the same account, or in the enclosing Cloudflare zone. Unset: you publish them by hand.                                        |
| `EMAILER_DMARC_REPORT_EMAIL` | no       | Only with `EMAILER_DNS`: also publish `_dmarc.<identity>` as `p=none`, reporting to this address. Set it only if the domain has no DMARC record yet. A report address on another domain still needs its authorization record by hand. |
| `EMAILER_DAILY_SEND_CEILING` | no       | Positive integer daily send cap for this stage.                                                                                                                                                                                       |
| `EMAILER_ALERT_EMAIL`        | no       | Alarm notifications. SNS sends one confirmation per stage; follow the `SubscribeURL` before expecting mail.                                                                                                                           |
| `EMAILER_API_URL`            | CLI      | API Function URL from the `apiUrl` stack output.                                                                                                                                                                                      |
| `AWS_PROFILE`                | deploy   | AWS CLI/SSO profile. Leave unset if you export credentials into the environment.                                                                                                                                                      |

Do not set `EMAILER_UNSUBSCRIBE_SECRET` or `EMAILER_PREVIEW_SECRET`. Alchemy mints both, binds them into the functions, and **rotates them when the stage is destroyed**, which invalidates every unsubscribe link already sent and every preview link.

`.env.example` also lists `EMAILER_TEST_*`, `EMAILER_UNSUBSCRIBE_URL` and `EMAILER_UNSUBSCRIBE_SECRET`. Those are for the live integration suite only, not for operating the service ([Develop and test](#develop-and-test)).

## One-time setup

**Once per machine.** Alchemy profiles are not AWS CLI profiles:

```sh
pnpm exec alchemy profile create emailer
pnpm exec alchemy profile edit --profile emailer --add AWS --method sso --set ssoProfile=<your-aws-sso-profile>
```

**Once per AWS account and Region.** A deploy fails with `Assets bucket not found` until this exists. Leave the bootstrap and state buckets in place; `alchemy destroy` does not remove them.

```sh
pnpm exec alchemy provider aws bootstrap --aws-profile <your-aws-sso-profile> --region <region>
```

**Only for `EMAILER_DNS=cloudflare`.** Add Cloudflare to the profile, with OAuth or an API token that has Zone Read and DNS Edit on the zone. A `CLOUDFLARE_API_TOKEN` together with `CLOUDFLARE_ACCOUNT_ID`, in the environment or the env file, takes precedence over the profile.

```sh
pnpm exec alchemy profile edit --profile emailer --add Cloudflare
```

## Sending identity (once per account and Region)

The identity stack owns the SES domain identity. With `EMAILER_DNS` set, it also owns the DNS records the identity needs. Without it, you publish them by hand, partly before the deploy.

### Automatic DNS

The stack writes the MAIL FROM MX and SPF records at `bounce.<identity>` first, and sets the identity's MAIL FROM only after both writes finish. The three DKIM `CNAME`s follow, read from SES. The DMARC record is written only when `EMAILER_DMARC_REPORT_EMAIL` is set, independently of the others.

Records are kept when the stack is destroyed, like the identity.

- **`route53`:** the public hosted zone in the same AWS account that contains the domain. **An existing record with the same name and type is overwritten without warning.**
- **`cloudflare`:** the Cloudflare zone that encloses the domain. An existing record with the same name and type stops the deploy until you adopt it (see below). Switching this mode off later is not a configuration change: the records' state still needs the Cloudflare provider.
- **Reports to another domain:** if `EMAILER_DMARC_REPORT_EMAIL` is on another organizational domain, its authorization record, `<identity>._report._dmarc.<report host>` → `"v=DMARC1"`, stays manual.

### Manual DNS

Publish MX, SPF and DMARC **before** the first deploy, so SES never finds the MAIL FROM record missing. Replace `mail.example.com` with your `EMAILER_SENDER_IDENTITY` and `us-east-1` with your `AWS_REGION`. A root domain works the same way, e.g. `bounce.example.com` and `_dmarc.example.com`.

- MX `bounce.mail.example.com` → `10 feedback-smtp.us-east-1.amazonses.com`
- TXT `bounce.mail.example.com` → `"v=spf1 include:amazonses.com ~all"`
- TXT `_dmarc.mail.example.com` → `"v=DMARC1; p=none; rua=mailto:dmarc@your-reports.example"`
- If `rua` is on a different organizational domain, also publish TXT `mail.example.com._report._dmarc.<rua-host>` → `"v=DMARC1"`

### Deploy and verify

```sh
pnpm exec alchemy deploy --config stacks/sending-identity.ts --stage shared --env-file .env --profile emailer --yes --no-input
```

1. **Manual DNS only:** publish the three `CNAME`s from the stack output `dkimRecords` (`name` → `value`). Copy their target: the zone differs by Region and by identity.
2. Wait for `DkimStatus=SUCCESS` and `MailFromDomainStatus=SUCCESS`, usually minutes and at most 72 hours.
   - Until DKIM verifies, SES refuses to send.
   - Until MAIL FROM verifies, SES uses its own bounce domain, so SPF does not align.
3. On a delivered message, confirm `spf=pass`, `dkim=pass` and `dmarc=pass`.

### Rules for either way

- **A name can hold only one DMARC record.** If `_dmarc.<your domain>` already exists, which is common on a root domain, keep it instead of adding a second one. It must not set `aspf=s`.
- Do not use the `bounce.` subdomain as a From address.
- Never destroy stack `EmailerSending`.
- With any config, exclude `AWS.SES.*` from `alchemy unsafe nuke`.
- Never run `alchemy unsafe nuke` with this stack's config at all: it enumerates the SES identity and every DNS record the credentials reach.

**If the identity (or, in `cloudflare` mode, one of its records) already exists**, for example set up by another email service, the deploy stops with `OwnedBySomeoneElse`:

- Keep that identity; recreating it can break DKIM.
- Deploy this stack once with `--adopt`. It takes over the identity and every existing record it declares. The existing DKIM records keep their values.
- Remove the old MAIL FROM subdomain's records after `MailFromDomainStatus=SUCCESS`.
- Never pass `--adopt` with `alchemy.run.ts`, where it applies to every resource.
- To move a deployed `EmailerSending` onto such a domain, destroy it first. Changing `EMAILER_SENDER_IDENTITY` in place plans a replacement, and that path takes over the existing identity without the ownership check.

## Deploy the service

The identity stack must already be deployed. Pick a durable `--stage` (for example `prod`). Omitting it falls back to `live_$USER`.

```sh
pnpm exec alchemy plan   --config alchemy.run.ts --stage prod --env-file .env --profile emailer
pnpm exec alchemy deploy --config alchemy.run.ts --stage prod --env-file .env --profile emailer --yes --no-input
```

Do not pass `--detailed`: it prints bound secrets, including `EMAILER_API_TOKEN` and the signing keys. Treat a secret you have printed as exposed and replace it.

After a code change, Alchemy can plan a function as `noop` and keep the old bundle: in beta.79 the plan compares a function's settings, not its code. Redeploy with `--force`, then confirm each function's `CodeSha256` changed:

```sh
aws lambda get-function-configuration --function-name emailer-<stage>-<api|dispatcher|feedback|unsubscribe|preview> --query CodeSha256
```

The three Function URLs are public (`authType: NONE`): the API authorizes with the bearer token; the unsubscribe and preview pages authorize with the signed token in their links.

Outputs: `apiUrl`, `unsubscribeUrl`, `previewUrl`, `alertsTopicArn`. Put `apiUrl` in `EMAILER_API_URL`.

```sh
pnpm exec alchemy destroy --config alchemy.run.ts --stage prod --env-file .env --profile emailer --yes --no-input
```

Destroying a stage deletes its resources and rotates the unsubscribe and preview keys, so every unsubscribe link already sent stops working. The sending identity and Alchemy bootstrap/state buckets stay.

Stage `prod` keeps its DynamoDB table when destroyed, because it holds every opt-out and suppression. The table stays in AWS but Alchemy stops tracking it: a new deploy of `prod` creates a fresh, empty table, and recovering the old data is manual. Every other stage deletes its table.

## Use

`pnpm emailer` runs the CLI with the `.env` in the repository root; variables already set in your shell take precedence. To use another file, run Node directly, e.g. `node --env-file=.env.test apps/cli/src/main.ts …`.

```sh
pnpm emailer --help
pnpm emailer campaigns create --help
```

Successful commands print JSON on **stdout** and exit **0**. Diagnostics go to stderr. A usage error prints help on stdout and exits nonzero, so stdout is machine-readable only when the exit status is zero.

Every command also accepts:

- `--wizard`: builds the command by asking for each argument and flag.
- `--log-level <level>`: how much diagnostic output to write to stderr.
- `--completions <bash|zsh|fish|sh>`: prints a completion script for a command named `emailer`, e.g. an alias for `pnpm emailer`.

### Your first campaign

1. Create a list and note the `id` it prints:

   ```sh
   pnpm emailer lists create --name "Readers"
   ```

2. Put your contacts in a JSON file outside this repository, so their addresses never end up in a commit. `name` and `attributes` are optional:

   ```json
   {
     "contacts": [
       { "email": "ada@example.com", "name": "Ada", "attributes": { "plan": "pro" } },
       { "email": "grace@example.com" }
     ]
   }
   ```

   A CSV file (`.csv`) works too, such as a spreadsheet export. Its header row names the columns: `email` is required, `name` is optional, and every other column becomes an attribute:

   ```csv
   email,name,plan
   ada@example.com,Ada,pro
   grace@example.com,,
   ```

   Import it, whatever its size:

   ```sh
   pnpm emailer lists import <listId> --file ~/emailer/contacts.json
   ```

3. Write the campaign as one Markdown file ([`apps/cli/test/newsletter.md`](apps/cli/test/newsletter.md) is a sample), and create a draft from it:

   ```sh
   pnpm emailer campaigns create --list <listId> --subject "What's new" --markdown newsletter.md
   ```

4. Open a preview. The link works for 24 hours in any browser, including on a phone or from a headless machine; `--open` also opens it locally:

   ```sh
   pnpm emailer campaigns preview <campaignId> --open
   ```

5. Edit the file, update the draft, and reload the same link:

   ```sh
   pnpm emailer campaigns update <campaignId> --markdown newsletter.md
   ```

6. Send yourself a `[Test]` copy:

   ```sh
   pnpm emailer campaigns test <campaignId> --to you@example.com
   ```

7. Send it now, or schedule it:

   ```sh
   pnpm emailer campaigns send <campaignId>
   pnpm emailer campaigns schedule <campaignId> --at 2030-01-15T09:00Z
   ```

8. Follow its progress with `pnpm emailer campaigns get <campaignId>`.

**Writing in Markdown.** The CLI renders both parts from the same file: HTML with inline styles in a 600px layout, and plain text. Use absolute `https://` image URLs. Raw HTML passes through unstyled. The service stores only the rendered result, so keep your Markdown file. For your own design, pass `--text` and `--html` files instead of `--markdown`.

### Commands

Each command below is run as `pnpm emailer <command>`. `[…]` marks an optional flag, `a | b` marks alternatives, and `…` marks a flag you can repeat.

**Contacts**

| Command                                                                                                | What it does                                             |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `contacts create --email <address> [--name <name>]`                                                    | Create a contact                                         |
| `contacts get <contactId>`                                                                             | Show a contact                                           |
| `contacts by-email --email <address>`                                                                  | Find the contact that holds an address                   |
| `contacts list [--limit <n>] [--cursor <cursor>]`                                                      | List contacts in the order they were created             |
| `contacts update <contactId> [--email <address>] [--name <name> \| --clear-name] [--attr key=value …]` | Change a contact; an omitted flag leaves its field alone |
| `contacts delete <contactId>`                                                                          | Delete a contact and remove it from every list           |

**Lists**

| Command                                                    | What it does                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `lists create --name <name>`                               | Create a list                                                              |
| `lists get <listId>`                                       | Show a list                                                                |
| `lists list [--limit <n>] [--cursor <cursor>]`             | List lists in the order they were created                                  |
| `lists members <listId> [--limit <n>] [--cursor <cursor>]` | List a list's contacts                                                     |
| `lists rename <listId> --name <name>`                      | Rename a list                                                              |
| `lists add-contact <listId> <contactId>`                   | Add a contact to a list; repeating it changes nothing                      |
| `lists remove-contact <listId> <contactId>`                | Remove a contact from a list; repeating it changes nothing                 |
| `lists import <listId> --file <file>`                      | Create or find the contacts in a JSON or CSV file and add them to the list |
| `lists delete <listId>`                                    | Delete a list and its memberships; its contacts stay                       |

**Campaigns**

| Command                                                                                                                                                               | What it does                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `campaigns create --list <listId> --subject <subject> (--markdown <file> \| --text <file> [--html <file>]) [--filter key=value …]`                                    | Create a draft                                                |
| `campaigns update <campaignId> [--list <listId>] [--subject <subject>] [--markdown <file> \| --text <file> [--html <file>]] [--filter key=value … \| --clear-filter]` | Change a draft; an omitted flag leaves its field alone        |
| `campaigns preview <campaignId> [--open]`                                                                                                                             | Create a 24-hour preview link                                 |
| `campaigns test <campaignId> (--to <address> … \| --list <listId> [--yes])`                                                                                           | Send a `[Test]` copy now                                      |
| `campaigns send <campaignId>`                                                                                                                                         | Queue the campaign for sending now                            |
| `campaigns schedule <campaignId> --at <date-time>`                                                                                                                    | Send the campaign at a future time                            |
| `campaigns cancel <campaignId>`                                                                                                                                       | Withdraw a scheduled or queued send                           |
| `campaigns resume <campaignId>`                                                                                                                                       | Continue a paused campaign                                    |
| `campaigns get <campaignId>`                                                                                                                                          | Show a campaign with its body and progress                    |
| `campaigns list [--limit <n>] [--cursor <cursor>]`                                                                                                                    | List campaigns in the order they were created, without bodies |
| `campaigns delete <campaignId>`                                                                                                                                       | Delete a draft                                                |

**Addresses**

| Command                                  | What it does                                                       |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `addresses status --email <address>`     | Show an address's opt-out, suppression and SES account suppression |
| `addresses unsuppress --email <address>` | Clear an address's local and SES account suppression               |

### What commands print

- **A contact:** `{ id, email, name?, attributes?, createdAt }`. **A list:** `{ id, name, createdAt }`.
- **Listings:** `{ items, nextCursor? }`. Pass `nextCursor` as `--cursor` to get the next page.
- **`lists add-contact` / `remove-contact`:** `{ listId, contactId, member }`. **Deletes:** `{ id, deleted: true }`.
- **`lists import`:** `{ contacts: [{ email, contactId, member }] }`, one entry per imported address, in file order.
- **A campaign:** `{ id, listId, subject, createdAt, filter?, submission, text, html? }`; `campaigns list` leaves out `text` and `html`.
  - `submission.state` is `draft`, `scheduled` (with `sendAt`), `queued`, `sending`, `paused` (with a `reason`) or `completed`.
  - From `sending` on, it carries `progress` (`accepted`, `rejected`, `uncertain`, `skipped`) and `feedback` (`bounced`, `complained`).
- **`campaigns test`:** `{ recipients: [{ email, outcome, … }] }`. The `outcome` is one of:
  - `accepted`, with the SES `messageId`;
  - `skipped`, with a `reason`: `unsubscribed`, `suppressed` or `bouncing`;
  - `rejected`, with a `rejectionCode`;
  - `uncertain`: SES's answer was lost.
- **`campaigns preview`:** `{ url, expiresAt }`.
- **`addresses status` / `unsuppress`:** `{ email, status, unsubscribedAt?, suppression?, transientBounces, accountSuppression }`, where `status` is `mailable`, `unsubscribed`, `suppressed` or `bouncing`.
- **A failure** goes to stderr as the error the API answered, named by its `_tag`, and the command exits non-zero:
  - **400** for a request the contract refuses, including a value over a limit below;
  - **401** `Unauthorized` for a missing or wrong API token;
  - **404** `ContactNotFound`, `ListNotFound` or `CampaignNotFound`;
  - **409** for a conflict: `EmailAlreadyUsed`, `AddressOptedOut`, `ContactChanged`, `CampaignStateConflict`, `SendAtNotInFuture` or `TestAudienceTooLarge`;
  - **503** when sending is halted (`SendingPaused`) or a dependency is unavailable: `StorageUnavailable`, `EmailServiceUnavailable`, `QueueUnavailable`, `SchedulerUnavailable` or `AlarmsUnavailable`, each naming the `operation` and the `failure`.

### Limits

| What                   | Limit                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Subject                | 200 characters                                                                       |
| Contact and list names | 200 characters                                                                       |
| Text body              | 64 KB (UTF-8), including a body rendered from Markdown                               |
| HTML body              | 256 KB (UTF-8), including a body rendered from Markdown                              |
| Contact attributes     | 20 entries; keys up to 64 characters, values up to 512                               |
| `lists import`         | any file size, sent 20 contacts per call; one address may not appear twice in a file |
| `campaigns test`       | 20 recipients                                                                        |
| Listings               | `--limit` 1–100, default 25                                                          |

### Behavior

- An address identifies at most one contact, case-insensitively. Creating or updating onto an address another contact holds answers **409** `EmailAlreadyUsed`.
- An update, delete or import that races another change to the same contact tries again twice, then answers **409** `ContactChanged`; run it again.
- `--attr` replaces the whole attribute map; it does not merge. Repeat it per entry. `--clear-name` removes the name.
- `lists import` rejects a file with a key the format does not declare, such as a misspelled `attributs`, before anything is sent, and names the key's path. It reports where each address stands after the import, not what changed, so running the same file again is safe and returns the same answer. An address that already has a contact gains the membership but keeps its name and attributes; use `contacts update` for those.
- `lists import` sends the file 20 contacts per call, 4 calls at a time: about 250 contacts a second into one list, near the most DynamoDB takes for one list without throttling. A call that fails in transit, times out or answers 408, 429 or 5xx is sent again for about two minutes. Progress goes to stderr every 1,000 contacts. If the import stops, stderr says how many contacts went in; running the same file again completes it.
- A `.csv` file is read as CSV. The header's `email` and `name` columns match in any case, and every other column becomes an attribute named by its header, so delete export columns you don't want first. Empty cells are left out. A missing `email` column or a column named twice is rejected, and a row that fails the checks is named by its line.
- `--filter` keeps members whose attributes equal every `key=value` (AND). Omit it for the whole list. Members that don't match are left out entirely and are not counted in `skipped`.
- An opt-out holds the address. While opted out, moving the contact onto a different address answers **409** `AddressOptedOut`. Deleting the contact and creating another at the same address does not make it mailable.
- `addresses unsuppress` clears local suppression and the SES **account** suppression list (one list per account and Region, shared with every other sender there). SES stores suppression entries case-sensitively, so pass the address in the case SES stored it: as the contact holds it (`contacts by-email` shows it) or as `aws sesv2 list-suppressed-destinations` lists it. `addresses status` echoes the address you pass, so another case shows no account entry rather than an error. It never clears an opt-out.
- Deleting a contact removes it from every list; deleting a list removes every membership in it. Neither deletes the other side. A delete that times out on a large list is safe to repeat.
- Listings page in created order. A page's `nextCursor` is absent when there is nothing more; a full last page may still carry one that leads to an empty page.
- `campaigns send` exits zero when the campaign is **queued**. Poll `campaigns get` for `progress`, `feedback` and a `paused` reason.
- `campaigns schedule` exits zero when the campaign is `scheduled`. `--at` is an ISO date (`YYYY-MM-DD`) or date-time; no zone means UTC. Past instants are **409**. The scheduler fires with 60-second precision. `campaigns send` on a scheduled campaign sends now.
- `campaigns cancel` withdraws a pending send. A `scheduled` campaign, or a `queued` first send that never started, returns to `draft`. A `queued` resume returns to `paused` with reason `manual`. A campaign that is `sending` or `completed`, or whose send another command replaced in the meantime, answers **409** `CampaignStateConflict`. Cancel does not stop messages already handed to SES, or recall mail.
- `campaigns update` and `campaigns delete` apply to drafts only; any other state is **409** `CampaignStateConflict`. Cancel a scheduled campaign to edit it. Content flags replace the whole body: `--text` without `--html` drops an earlier HTML body. `--markdown` excludes `--text`/`--html`. `--clear-filter` sends to the whole list again.
- `campaigns preview`: anyone holding the link sees that campaign until it expires, so share it like a password. It always renders the campaign as it is now, with a placeholder instead of the recipient's unsubscribe link. A single link cannot be revoked; destroying the stage revokes all of them.
- `campaigns test` sends right away to the `--to` addresses, or to every member of a `--list`; the campaign's filter does not apply. For `--list` it shows the member count and asks on stderr; pass `--yes` when no one can answer (a script or pipe). The subject gets a `[Test] ` prefix. Unsubscribed, suppressed and bouncing addresses are skipped, and each address gets one attempt. It uses the account's daily quota and send pacing, and answers **503** `SendingPaused` while a reputation halt or the daily budget stops sending. **The unsubscribe link in a test message is real**: clicking it opts that address out of every campaign. A test bounce or complaint suppresses the address but never counts against the campaign.
- An individual recipient is never retried automatically. A recipient whose SES response was lost stays `uncertain`.

Every message gets a postal footer, `List-Unsubscribe` and one-click `List-Unsubscribe-Post`. Open/click tracking is off.

## Operate

**Pause reasons.**

- `reputation`: wait for the alarm to clear or the account to heal, then `campaigns resume`. A forced `ALARM` persists under `TreatMissingData: ignore` until reset (`aws cloudwatch set-alarm-state --state-value OK …`).
- `feedback`: this campaign's list bounced or complained too much (5% hard bounces after 200 accepted, or 0.1% complaints after 1,000 accepted). Clean the list before resuming.
- `rate-limited` / `daily-quota` / `sending-paused`: wait, then resume.

**Alarms** all notify the stage's alert topic.

| Alarm                                        | Meaning                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `FeedbackFailuresVisible`                    | A bounce/complaint was accepted and could not be processed five times. Redrive it.                           |
| `DispatchFailuresVisible`                    | The dispatcher failed on a campaign's queue message five times. The campaign is stuck `sending`; redrive it. |
| `SetBounceRate` / `SetComplaintRate`         | This configuration set at 2% bounces / 0.05% complaints. Silent until the set has sent.                      |
| `AccountBounceRate` / `AccountComplaintRate` | The whole account at 5% / 0.1%, including every other SES sender in the account.                             |

A fresh stage with `EMAILER_ALERT_EMAIL` set can mail several `OK:` notifications on deploy (`OKActions` fire `INSUFFICIENT_DATA` → `OK`). Those actions stay: an alarm returning to OK is the signal to resume a `reputation` pause.

**Redrive failed feedback:**

```sh
aws sqs start-message-move-task \
  --source-arn <FeedbackFailures ARN> \
  --destination-arn <FeedbackEvents ARN>
```

A redriven event that already landed changes nothing.

**Redrive a campaign stuck `sending`:**

```sh
aws sqs start-message-move-task \
  --source-arn <DispatchFailures ARN> \
  --destination-arn <Dispatch ARN>
```

`campaigns resume` does not apply to `sending`. The dispatcher continues where it stopped.

**A campaign stuck `scheduled`.** Passing the scheduled minute is not proof of failure: the scheduler fires within 60 seconds, and the queue adds a delay. If it needs to start now, run `campaigns send`; the scheduled trigger is then ignored when it arrives.

Gmail sends no complaint feedback loop to SES. Watch the domain in Google Postmaster Tools, and read DMARC aggregate reports at the `rua` address you published.

The account suppression list survives `alchemy destroy`. A test run can leave `simulator.amazonses.com` entries; remove them with `addresses unsuppress`, passing each address as `aws sesv2 list-suppressed-destinations` lists it.

## Develop and test

`pnpm check` checks formatting, runs lint (including unused-suppression reporting), knip (unused files, exports and dependencies), typecheck, the unit tests and an import probe.

The live integration suite runs against an ephemeral stage. Automated sends go only to SES mailbox-simulator addresses. One case temporarily disables the stage's dispatcher event-source mapping, so never point the suite at a real stage.

1. Deploy a throwaway stage with `.env.test`, which holds the same deploy keys as `.env` (API token, sender identity, From address, postal address, Region) plus the test keys:

   ```sh
   pnpm exec alchemy deploy --config alchemy.run.ts --stage test --env-file .env.test --profile emailer --yes --no-input
   ```

2. Point `.env.test` at that stage's values:
   - `EMAILER_API_URL` and `EMAILER_UNSUBSCRIBE_URL`: the `apiUrl` and `unsubscribeUrl` outputs.
   - `EMAILER_UNSUBSCRIBE_SECRET`: read from the unsubscribe function's environment (`aws lambda get-function-configuration --function-name emailer-test-unsubscribe --query Environment.Variables.EMAILER_UNSUBSCRIBE_SECRET --output text`).
   - `EMAILER_TEST_TABLE_NAME`, `EMAILER_TEST_DISPATCH_FAILURES_QUEUE_URL`, `EMAILER_TEST_DISPATCHER_FUNCTION_NAME` and `EMAILER_TEST_SET_BOUNCE_ALARM`: from the deploy's resource inventory.
3. Run `pnpm test:integration`. It loads `.env.test` itself.
4. Destroy the stage:

   ```sh
   pnpm exec alchemy destroy --config alchemy.run.ts --stage test --env-file .env.test --profile emailer --yes --no-input
   ```

## License and credits

[MIT](LICENSE).

This repository vendors [anti-slop](https://github.com/dmmulroy/anti-slop) by Dillon Mulroy, MIT licensed, for its Oxlint rules. The copy lives at `tools/oxlint/anti-slop` with its [LICENSE](tools/oxlint/anti-slop/LICENSE) and [provenance](tools/oxlint/anti-slop/UPSTREAM.md).
