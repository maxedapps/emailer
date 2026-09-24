# ADR-0020: Editable drafts, preview links and test sends

- Status: Accepted
- Date: 2026-09-23
- Accepted: 2026-09-23
- Confirmed: 2026-09-23 on the ephemeral stage `test`, which was then destroyed and checked against the account inventory:
  - The whole integration suite passed: 5 files, 40 cases, including the new drafting, preview and test-send cases.
  - A CLI walkthrough exercised create, preview, update and the same link reloaded, test sends to `--to` and to `--list` (answered `y`, answered `n`, closed stdin, `--yes`), delete, and a real send. The real send's `accepted: 3` counted none of the eight test sends made before it.
  - One `[Test]` copy reached the operator's test inbox with `dkim=pass` for the sending domain, both unsubscribe headers in the signed `h=` list, and `dmarc=pass`.
  - The preview answered with all four headers, and a link clicked inside its frame opened a new tab.
  - The prod plan shows three creates (Preview, PreviewLogs, PreviewSecret) and nothing replaced or deleted.
- Deployed to prod: 2026-09-23, from `60061cd` together with the codebase cleanup. Prod held only a test list, so the user chose to destroy the stage and deploy it fresh instead of upgrading it in place; the in-place plan above was not applied. The identity stack was not touched. Details are in the cleanup's handoff (`work/codebase-cleanup.md`, in git history).
- Amended: codebase-cleanup (`work/codebase-cleanup.md`, in git history) — each sender mints the recipient's unsubscribe link before it changes any state, the dispatcher before its claim, and hands it to the mailer, which composes and submits. A link that cannot be minted then stops a slice with no claimed row left unsettled. The one composer is unchanged; the preview still passes its placeholder.
- Authority: On 2026-09-23 the user asked for more ways to draft and preview campaigns: a preview that works on a headless machine through a short-lived public URL, and a test command that sends to several addresses or to one list, with a recipient-count warning. They followed every recommendation that the research produced:
  - editable and deletable drafts;
  - a confirmation prompt with `--yes`;
  - synchronous capped test sends that share the account-wide guards;
  - a preview link with an optional `--open`.

  They then chose, over a route on the API function, a dedicated preview function, because of ADR-0004 and ADR-0008. They also chose concern folders for the backend. See the plan (`work/drafting-and-preview.md`, in git history).
- Supersedes in part:
  - [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md): "The API never submits to SES again and no longer constructs the mailer". The API now sends test messages, and its role regains `ses:SendEmail`.
  - [ADR-0014](0014-campaign-body-item-and-summaries.md): "No campaign delete exists". Drafts can be deleted, both items together.
  - [ADR-0016](0016-cancelling-pending-campaign-runs.md): the cancel-only conflict. Every wrong-state operation answers one `CampaignStateConflict`.
- Amends:
  - [ADR-0001](0001-resource-owning-effect-services.md): capabilities are grouped into concern folders.
  - [ADR-0007](0007-immutable-recipient-unsubscribe-links.md): the signing code is shared with preview tokens; the unsubscribe format and secret are unchanged.
  - [ADR-0008](0008-storage-capabilities-and-error-boundaries.md): a sixth capability, `CampaignReader` (`GetItem`). The rate limiter's store is the fifth.

## Context

A campaign is created once and can then only be sent, scheduled or cancelled. To see a campaign, you have to send it. The operator works partly from a headless machine, so "open a local file" is not enough. A draft's content is in DynamoDB, and the footer is composed per recipient inside the mailer.

Three existing rules constrain the design:
- **Public surfaces are separate, least-privilege functions.** ADR-0004 rejected an unauthenticated route on the administrative function, and ADR-0008 gives the unsubscribe function `PutItem` only.
- **Admission is account-wide.** ADR-0011 and ADR-0012 require every sender to share the reputation guard, the daily budget and the `ses-send` pacing limiter. The API function has a 60 s budget.
- **Feedback counts on the campaign tag.** Feedback adds bounces and complaints to the counters of the campaign in the `campaignId` tag, and those counters feed the per-run breaker.

## Decision

- **Drafts are editable and deletable while in `draft`.**
  - **Update:** `PATCH /campaigns/:id` changes list, subject, text, html (null removes it) and filter (null removes it). The service merges the change in memory and writes one fixed transaction: an Update on META, conditioned on `draft`, plus a Put of BODY.
  - **Delete:** `DELETE /campaigns/:id` is one transaction that removes META (conditioned on `draft`) and BODY. A leftover schedule from an earlier cancel is left alone. If it fires, it finds no campaign, its wake-up is discarded as stale, and it deletes itself.
  - **Conflicts:** any other state answers `CampaignStateConflict {state}` (409). This one error replaces `CampaignCancellationConflict`.
- **Preview links point at a dedicated public function.**
  - **Minting:** `POST /campaigns/:id/preview` returns `{ url, expiresAt }`. The token is `v1.<campaignId>.<expires epoch seconds>.<hex HMAC-SHA256>`, signed with its own `Random("PreviewSecret")` and valid for 24 hours. The CLI prints the link; `--open` also launches the browser.
  - **The function:** `emailer-<stage>-preview` holds `GetItem` only, through `CampaignReader`, and 2 reserved concurrent executions.
  - **Serving:** it verifies before it reads, and renders the *current* draft through the same composer the mailer uses, with a placeholder unsubscribe link. The page shows From, Subject, the HTML part in a sandboxed frame, and the text part.
  - **Headers:** `Content-Security-Policy` sandbox, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` and `Cache-Control: no-store`.
- **Test sends run synchronously in the API and share admission.**
  - **Endpoint:** `POST /campaigns/:id/test` takes `{ to: [1–20 addresses] }` or `{ listId }` with at most 20 members. The campaign filter is not applied.
  - **Refusals:** it refuses when the reputation guard is halted or the daily budget is spent (`SendingPaused`).
  - **Per recipient:** it skips unsubscribed, suppressed and bouncing addresses, and waits for the shared `ses-send` limiter. It makes one attempt, with no backoff and no time budget: 20 sends at the 1/s pacing floor take about 20 s of the API's 60 s.
  - **Each message:** the subject is prefixed `[Test] `. It carries a real per-recipient unsubscribe link, and **no** message tags, so no campaign is named.
  - **What it writes:** no SEND rows and no campaign counters. A bounce or complaint still suppresses the address.
  - **The CLI:** it counts a list first and asks for confirmation on stderr; `--yes` skips the prompt.
- **One composer.** The mailer mints each recipient's unsubscribe link and composes through one pure function. The preview uses the same function.
- **The backend is organized in concern folders:** `api`, `audience`, `campaigns`, `consent`, `feedback`, `identity`, `sending` and `storage`. Cross-cutting modules (`Diagnostics`, `Identifiers`, `Lambda`, `SignedToken`) stay at the root. Logical IDs and function names are unchanged.
- **Every function builds its services once.** Its constructor builds the function's Live Layer with `Layer.build`, and the handler runs under that context. Nothing re-wraps services, and every service that was wired inline gets a `*Live` Layer beside its tag.

## Alternatives considered

- **A public preview route on the API function.** It needs the least code. Rejected by the user, for ADR-0004's reason: an unauthenticated route inside the function that holds every administrative permission.
- **S3 objects with presigned URLs.** A URL signed with Lambda role credentials expires with the role session, whose length is undocumented. Lifecycle expiry works in whole days, so copies linger. S3 cannot send the sandbox, no-referrer or noindex headers. And it would keep a second copy of the body, which ADR-0014 rejected.
- **CloudFront signed URLs.** A distribution, a key group and a private key for a preview.
- **Previews and tests from local files, without a stored draft.** It needs temporary storage and previews something other than what will be sent. Every correction would still leave an undeletable draft.
- **Test sends through the dispatcher.** No cap, and it reuses backoff. But the result becomes asynchronous, and the dispatcher's run state would have to carry a second kind of run. Rejected for a feature whose audience is a handful of addresses.
- **A warning instead of a confirmation.** A warning printed just before sending protects nothing.
- **Tagging test sends with the campaign.** Rejected: test bounces would count against the campaign's feedback and its breaker.
- **A `purpose=test` tag and a feedback branch for it.** Rejected: the mailer is the only sender on the configuration set, and every campaign send carries its campaign tag, so an untagged event already identifies a test send.
- **Retrying throttled test sends, or a time budget with a `not-attempted` outcome.** The dispatcher's backoff can take about 39 s for one recipient, so it does not fit the API's budget. A budget guards only a sandbox-rate account with a concurrent campaign, or a hanging SES. The operator re-runs the test instead.

## Consequences

- **The API function can send mail again.** It also binds `GetAccount` and `DescribeAlarms`, and its environment captures the sender, postal address and daily ceiling.
- **A third public Function URL exists.** Invalid tokens are refused before any read; the function holds `GetItem` only and at most two concurrent executions.
- **A preview link lets anyone holding it read that campaign for 24 hours.** Links cannot be revoked individually. Replacing the `PreviewSecret` resource revokes every preview link without touching `UnsubscribeSecret`.
- **The unsubscribe link in a test message is real.** Clicking it, or a provider's one-click button, opts that mailbox out of every campaign.
- **Test sends consume the account's daily quota and share its pacing,** so a test during a running campaign slows both slightly. A test that outruns the API's 60 s (only plausible at sandbox rate with a campaign running, or with SES hanging) ends as a timeout. The operator does not see the per-recipient outcomes and re-runs the test.
- **Scheduled campaigns cannot be edited.** `cancel` returns them to draft first.
- **Feedback for an untagged message is logged at info level,** as a likely test send, and recorded only as suppression.
- **Moving files changed every function's code bundle, but no resource identity.**

## Confirmation

- **Unit tests pin:**
  - the transaction shapes and draft-only rules;
  - token round trip, expiry and forgery for both token kinds, plus a frozen unsubscribe vector;
  - the preview page headers and the 404 before any read;
  - the test-send outcomes, skips, cap (decided by the member page's `nextCursor`) and guard refusal, with no store writes;
  - the CLI's exclusivity, the prompt on stderr and `--yes`.
- **The ephemeral live gate proves:**
  - a draft round trip;
  - a preview served with its headers;
  - test sends to simulator addresses leave the campaign's counters untouched, while a bounce simulator still suppresses.
- **The production plan** shows no replacement before the user decides to deploy.

## References

- Plan (`work/drafting-and-preview.md`, in git history)
- [ADR-0004](0004-sender-owned-one-click-unsubscribe.md), [ADR-0007](0007-immutable-recipient-unsubscribe-links.md), [ADR-0008](0008-storage-capabilities-and-error-boundaries.md), [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md), [ADR-0012](0012-reputation-guardrails.md), [ADR-0014](0014-campaign-body-item-and-summaries.md), [ADR-0019](0019-markdown-campaign-bodies.md)
- [Alchemy Layers](https://alchemy.run/infrastructure-as-effects/layers/), [Alchemy file layout](https://alchemy.run/project-structure/file-layout/)
- [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), [S3 lifecycle expiration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html)
- [MDN: CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox), [MDN: Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)
