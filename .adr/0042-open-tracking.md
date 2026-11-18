# ADR-0042: Open tracking per campaign, copy and recipient

- Status: Proposed
- Date: 2026-11-18
- Authority: Task 4102. A cost study (artifact `emailer-4102-open-tracking-cost`) priced SES open events through the existing feedback path at about $0.003 per 1,000 opens and $0 idle. Max then decided on 2026-11-18:
  - build open tracking. This is his explicit go for its added running cost under [ADR-0032](0032-low-running-cost-is-a-hard-constraint.md);
  - record who opened, not only counts;
  - no click tracking.
  The worker chose the design below, including untracked test and confirmation mail, under the cost rule.
- Amends:
  - [ADR-0003](0003-feedback-events-through-eventbridge.md): the rule also routes `Email Opened`, and two configuration sets publish to it.
  - [ADR-0028](0028-campaign-variants-and-attribute-merge.md): copies are compared by their opens as well as by UTM links in site analytics.
  - [ADR-0041](0041-personalized-templates.md) decision 7: links still carry no per-person code, but the open pixel SES inserts does. Who opened is recorded.
- Plan: [0042-open-tracking.plan.md](0042-open-tracking.plan.md)

## Context

- SES inserts an open pixel into the HTML part of every mail sent through a configuration set that publishes `OPEN` events, and into no other mail ([SES FAQ: metrics](https://docs.aws.amazon.com/ses/latest/dg/faqs-metrics.html)). A custom tracking domain is optional. Text-only mail gets no pixel.
- Each open is one `Email Opened` event on the default bus. Its `detail.open` holds `timestamp`, `userAgent`, `ipAddress` and `isBotEvent` (`Likely` or `Unlikely`). The mailbox simulator produces no opens.
- Apple Mail Privacy Protection loads the pixel when mail arrives, so unread mail counts as opened. Image blocking hides real opens. Opens compare copies sent to similar audiences; they do not prove that someone read the mail.
- Until now every mail used one configuration set, `EmailerMail`, which publishes `BOUNCE` and `COMPLAINT`. Campaign mail carried the tags `campaignId`, `sendId` and `variant`. A send row is keyed by campaign and contact.

## Decision

1. **Only campaign mail is tracked.** `EmailerMail` takes campaign mail and publishes `BOUNCE`, `COMPLAINT` and `OPEN`. A second set, `EmailerUntrackedMail`, takes test copies and sign-up confirmations. It publishes `BOUNCE` and `COMPLAINT` with the same SES suppression, so neither kind of mail carries a pixel. A confirmation goes to someone who has not consented yet. A test copy's opens would belong to no campaign. Both would cost events that record nothing. The second set and its event destination cost nothing.
2. **Campaign mail is also tagged with its `contactId`,** so an open finds its send row without a lookup.
3. **One rule, one queue, one consumer.** The default-bus rule also matches `Email Opened`. The feedback Lambda accepts events from either set. It records an open of tagged campaign mail and logs and drops everything else: a bot-likely open (`isBotEvent: Likely`), an open whose tags or send row are missing, and a redelivery.
4. **An open is one strongly consistent read and one two-item transaction.**
   - The read: the send row (`SEND#<contactId>`).
   - The send row's update: `openedAt` set to the earlier of its value and this open's time, `opens` plus one, and `lastOpen` set to the EventBridge event's ID. It is conditioned on the `sendId` the mail was tagged with and on the `opens` value just read.
   - The copy's counter item, `OPENS#<copy>` under the campaign: `total` plus one, and `unique` plus one on a recipient's first open.
   - A redelivered event finds its own ID in `lastOpen` and writes nothing. Only when another open of the same mail was recorded in between does it count once more in the total. An open racing another of the same mail fails the condition and is read again. Unique counts are exact; totals are exact apart from that redelivery and what SES itself loses or duplicates.
5. **Reads.**
   - `Campaign.opens` holds `{ unique, total, copies: { <copy>: { unique, total } } }`. It is present once the submission carries progress (sending, paused, completed), comes from one Query of the counter items, and lists every copy, opened or not. `campaigns list` leaves it out.
   - `GET /campaigns/:id/opens?cursor=<contactId>` answers one DynamoDB page of the campaign's send rows, filtered to those opened: `{ contactId, email, copy, firstOpenedAt, opens }`. `campaigns opens <id>` pages through all of them and prints them by first open.
6. **No other personal data is kept.** The IP address and user agent in the event are neither stored nor logged.

## Cost

Steady state, us-east-1 on-demand prices, free tiers ignored:

| Per open event                     | Cost        | Notes                                                              |
| ---------------------------------- | ----------- | ------------------------------------------------------------------ |
| EventBridge                        | $0          | AWS-service event to a target in the same account                  |
| SQS                                | $0.0000012  | send, receive, delete                                              |
| Lambda                             | ~$0.0000009 | one invocation, warm 10–20 ms at 256 MB, some cold starts          |
| DynamoDB read                      | $0.000000125 | 1 RRU, strongly consistent, send row under 4 KB                    |
| DynamoDB transaction               | $0.0000025  | 2 items × 2 WRU, each item under 1 KB; no GSI write                |
| CloudWatch Logs                    | ~$0.0000003 | one info line                                                      |
| **Total**                          | **~$0.005 per 1,000 opens** |                                                    |

- A bot-likely open costs SQS and Lambda, no DynamoDB.
- Storage: three attributes (~70 B) on each opened send row, and one ~100 B counter item per opened copy.
- Idle: $0. The second configuration set, its event destination and the rule pattern are free.
- Reads: `campaigns get` adds one Query of at most 51 small items (≤1 RRU) for a started campaign. `campaigns opens` reads each of the campaign's send rows, about 350 B each, once per listing: about 9,000 RRU, or $0.001, for 100,000 recipients.
- Example: 100,000 campaign mails a month, half of them opened, 1.5 opens each, is about $0.38 a month against $10 for sending them.

## Alternatives

- **The study's design: first open only, one conditional write, counted at read time.** It is the cheapest per open (~$0.003 per 1,000) and the simplest that could work. But it keeps no totals or per-recipient count. `campaigns get` would also read every send row on each call, which costs ~$0.0005 per call at 100,000 recipients on an endpoint the README says to poll while sending. Rejected.
- **Two plain updates instead of a transaction** (2 WRU, ~$0.004 per 1,000). A failure between them loses or doubles a count, against [ADR-0013](0013-repeat-safe-writes.md). Rejected.
- **Counters on the campaign's `META`.** Fifty copies' counters would grow the item that every send settlement rewrites, and the settlement is billed by item size, so sending would cost more. Rejected.
- **A sparse index of openers.** One more write per first open, plus index storage, only to speed up `campaigns opens`, which runs rarely. Rejected.
- **Trying the first-open transaction and falling back on refusal, instead of reading first.** A refused transaction still consumes its writes, so a repeat open costs 8 WRU instead of 1 RRU and 4 WRU. Rejected.
- **CloudWatch metrics as the destination.** $0.30 per metric-month per campaign and copy, total opens only, nobody per recipient. Rejected in the study.
- **One configuration set for all mail.** It puts a pixel into confirmations sent before consent and into test copies whose opens no campaign takes. Rejected.

## Consequences

- Opens are inflated by Apple Mail Privacy Protection and hidden by image blocking. Text-only copies record none. The README says so.
- Who opened is personal data. It lives on the send rows, as long as the campaign does, and `campaigns opens` lists it. Tracking pixels may need consent under EU rules. That is the operator's call.
- An open rate per copy needs the number of mails each copy sent. Only the send rows hold that, so the API gives none. Counting sends per copy would add a write to every send.
- Set-level reputation alarms cover `EmailerMail` only. Test and confirmation mail counts toward the account-level alarms, which halt sending ([ADR-0036](0036-only-account-wide-signals-halt-sending.md)).
- An open of mail sent before this change carries no `contactId` tag and is dropped. emailer is not in production yet.

## Confirmation

To be filled in when the change lands: unit tests, the live feedback suite (an injected `Email Opened` event reaches `campaigns get` and `GET /opens`), and a CLI check on a test stage.
