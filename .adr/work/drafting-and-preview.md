# Drafting, previews and test sends

> **Status:** Implemented and live-gated on 2026-09-23, and deployed to prod the same day on the user's word (G3), by destroying and redeploying the stage (see T13). The user's instruction to implement the plan accepted ADR-0019 and ADR-0020.
> **ADRs:**
> - **New, Accepted:**
>   - [0019 — Markdown campaign bodies rendered by the CLI](../0019-markdown-campaign-bodies.md)
>   - [0020 — Editable drafts, preview links and test sends](../0020-drafts-previews-and-test-sends.md)
> - **Superseded in part by 0020:**
>   - [0011](../0011-open-recipient-set-and-paced-dispatch.md): "the API never submits to SES again"
>   - [0014](../0014-campaign-body-item-and-summaries.md): "No campaign delete exists"
> - **Amended by 0020:**
>   - [0001](../0001-resource-owning-effect-services.md): concern folders
>   - [0007](../0007-immutable-recipient-unsubscribe-links.md): the token code is shared, the format is unchanged
>   - [0008](../0008-storage-capabilities-and-error-boundaries.md): a sixth capability, `CampaignReader`
> - **Preserved:** [0004](../0004-sender-owned-one-click-unsubscribe.md). Public surfaces live in their own least-privilege functions.
>
> **Updated:** 2026-09-23

## Outcome and boundaries

- **Problem and target:**
  - **Today:** a campaign is plain text plus an optional hand-written HTML file. It cannot be edited or deleted, and the only way to see it is to send it.
  - **Target workflow:**
    1. The operator writes one Markdown file and creates a draft from it.
    2. They open a short-lived preview link, which also works from a headless machine and on a phone.
    3. They edit the file and update the draft. The same link shows the change.
    4. They send a `[Test]` copy to a few addresses or to a small list.
    5. They send the campaign.
  - **Code target:** the codebase reads as if it had always been built this way (the memory rule "rewrite over bolt-on").
- **In scope:**
  - **Backend layout:** reorganized into concern folders.
  - **Seams extracted once:**
    - the message composer;
    - signed tokens;
    - send admission (the guard and the pacing slot);
    - `*Live` Layers for every service that is wired inline today;
    - the shared Lambda props.
  - **Function wiring:** every function builds its Live Layer once and provides the built context to its handler.
  - **Drafts:** draft-only update and delete.
  - **Previews:** a dedicated public Preview function with signed, expiring links.
  - **Test sends:** synchronous test sends from the API.
  - **Errors:** one `CampaignStateConflict`.
  - **CLI:**
    - split into modules;
    - `--markdown` rendered by `marked`;
    - `campaigns update | delete | preview [--open] | test (--to … | --list …) [--yes]`;
    - the confirmation prompt shows on stderr.
  - **Dead code:** a sweep over what this slice touches.
  - **Docs:** README, wiki, ADRs and back-links.
  - **Live proof:** an ephemeral test-stage check after the wiring refactor, a live gate at the end, and a prod plan.
- **Out of scope:**
  - **Templates:** personalization, merge tags, a configurable layout or theme, preheader text, multi-column layouts, MJML.
  - **Images and consent:** image hosting, double opt-in.
  - **Scheduled campaigns:** editing one. Cancel first, which returns it to draft.
  - **Previews:** local-file previews without a draft, and a local preview mode.
  - **Test sends:**
    - routing them through the dispatcher;
    - more than 20 recipients;
    - retries or a time budget. One attempt each; a pathological run ends as the API's timeout.
  - **Other:** member counts in the API, the MCP app, upgrades of Alchemy or Effect, and deleting non-draft campaigns.
  - **Prod:** deploying prod. That happens only on the user's word after T13.
- **Approach:**
  - **Move first, change later.** T1 is a pure relocation, and a prod `alchemy plan` must show code updates only before anything behaves differently.
  - **Seams next, each proven by the existing tests.** T2–T5 extract the shared pieces. After T5, a throwaway `--stage test` deploy and the existing integration suite prove the rewired functions at cold start.
  - **Features as vertical tasks.** Each one carries its own contract change, backend, CLI command, test-harness handler and tests, and ends with `pnpm check` green.
  - **One composer.** `sending/Message.ts` turns content, an unsubscribe URL and the postal address into the final subject, text, HTML and headers.
    - The Mailer uses it for every send, and mints each recipient's link itself, so no caller can forget it.
    - The Preview page uses it with a placeholder link.
  - **Public surfaces stay separate** (ADR-0004, ADR-0008). The preview page is its own function:
    - `emailer-<stage>-preview`;
    - a public URL, reserved concurrency 2, `GetItem` only through `CampaignReader`;
    - its own `Random("PreviewSecret")`.

    The API mints links through the bare-tag reference pattern that `UnsubscribeFunction` already uses.
  - **Test sends share account-wide admission.**
    - Same `SendGuard` (reputation alarms, enforcement, daily budget) and the same `ses-send` pacing key as campaigns.
    - One attempt per recipient.
    - Subject prefix `[Test] `, and **no** campaign tags. Feedback still suppresses the address but never touches campaign counters.
  - **Drafts are editable only while `draft`.**
    - Update: the service merges in memory, then writes one fixed transaction: an Update on META, conditioned on `draft`, plus a Put of BODY.
    - Delete: one transaction. A Delete on META, conditioned on `draft`, plus a Delete on BODY.
  - **Markdown renders in the CLI.** The API contract keeps `text` and `html` (ADR-0019).

## Target structure

```
apps/backend/src/
  Diagnostics.ts  Identifiers.ts  Lambda.ts (new)  SignedToken.ts (new)
  api/        Api.ts (fn "Api")  Auth.ts
  audience/   Addresses.ts (+AccountSuppressionLive)  Contacts.ts  Lists.ts
  campaigns/  Campaigns.ts  CampaignSchedule.ts (+tag, +Live)  TestSends.ts
              Previews.ts (secret, PreviewFunction tag, tokens, links)  PreviewPage.ts (fn "Preview")
  consent/    Unsubscribe.ts  UnsubscribePage.ts (fn "Unsubscribe")
  feedback/   Feedback.ts (fn "Feedback")  FeedbackClassification.ts  ReplayFeedback.ts
  identity/   SendingDns.ts  SendingIdentity.ts
  sending/    Dispatch.ts (+CampaignWake tag, +Live)  Dispatcher.ts (fn "Dispatcher")  Dispatching.ts
              Mailer.ts  Message.ts (new)  Reputation.ts  SendGuard.ts (+service, +Live, +consumeSlot)
  storage/    today's Storage/, lowercased; CampaignReader added in Campaigns.ts
apps/cli/src/
  main.ts  Emailer.ts (root)  Client.ts  Flags.ts  Terminal.ts  Markdown.ts  Diagnostics.ts
  commands/   Contacts.ts  Lists.ts  Campaigns.ts  Addresses.ts
apps/cli/test/CliHarness.ts
```

Tests sit beside their modules. Three things differ from the layout the user saw:
- **`Diagnostics.ts` is at the root.** All five functions use it.
- **`SignedToken.ts` is at the root.** Its users are `api/Auth`, `consent/Unsubscribe` and `campaigns/Previews`.
- **`Reputation.ts` is in `sending/`.** Its consumers are the stack and `SendGuard`. Keeping it in `feedback/` would make `sending` and `feedback` import each other (review R10).

## Key files, evidence, and decisions

| File or source | Why it matters | Decision or plan impact |
|---|---|---|
| `apps/backend/src/Mailer.ts:20-28, 112-212` | `OutgoingMessage` always carries `campaignId`/`sendId`. `makeSubmit` composes footers and builds the SES request in one place. `Mailer.sender` is never read. | T3: the composer moves to `Message.ts`. `Mailer.send(recipient, content, purpose)`, where `purpose` is `{campaign, campaignId, sendId} \| {test}`. A test send gets no tags. |
| `apps/backend/src/Mailer.test.ts:138-330, 523-543` | Six exact SES-request assertions | Retargeted in T3 and kept exact. A test-purpose case is added. |
| `apps/backend/src/Unsubscribe.ts:26-118`, `Unsubscribe.test.ts:39-64, 105` | Only the independent-signature check and the 407-character bound pin the format. There is no frozen literal. | T2: a golden vector goes in first. `SignedToken.verifyToken(key, token, { fields, maxLength })` keeps the order: length, structure, HMAC, fields. |
| `apps/backend/src/Api.ts:176-237`, `Dispatcher.ts:53-116`, `Feedback.ts:190-224` | Services are yielded, then re-wrapped with `Layer.succeed`. `CampaignWake` is implemented twice (Api:206-214, Dispatcher:75-83). `CampaignSchedule`, `AccountSuppression` and `DispatchGuard` are built inline. | T5: `*Live` Layers sit beside their tags. Each constructor runs `const services = yield* Layer.build(<Fn>Live)` and serves `Effect.provideContext(handle, services)`. This is today's API shape minus the re-wrap. `Effect.context()` is not used, because it would carry the init `Scope` into requests (review R2). |
| `apps/backend/src/Api.ts:108-138` and three siblings | Duplicated props: stage name, 7-day log group, `nodejs24.x`, arm64, `EMAILER_LOG_GROUP` | T5: `Lambda.ts` `lambdaBasics(id, name)`. Logical IDs (`ApiLogs`, …) and names are unchanged. `main: import.meta.url` stays in each function module. |
| `apps/backend/src/Dispatching.ts:35, 49-75`, `SendGuard.ts:25-73` | `DispatchGuard` and `consumeSlot` are private to the dispatcher. `sendGuard` takes two effect thunks. | T4 moves the guard service (with its Live) and `consumeSlot` to `sending/SendGuard.ts`, and makes `sendGuard` a pure function of the two responses. The backoff and `reservationFor` stay in the dispatcher. |
| `apps/backend/src/Feedback.ts:83-89`; `Storage/Feedback.ts:125-133`; `Storage/Campaigns.ts:536-538` | Tagged feedback increments campaign counters, and the per-run breaker reads them. Untagged feedback suppresses, then logs a warning. | Test sends carry no tags. T10 turns the untagged warning into an info line naming the likely cause, a test send. |
| `apps/backend/src/Storage/Campaigns.ts:241-293`; Alchemy `AWS/DynamoDB/TransactWriteItemsHttp.ts:42-57` | Create writes BODY, then META. Every delete in the store is a transaction `Delete`. The binding grants `DeleteItem`/`ConditionCheckItem`. | T9: `updateDraft` and `deleteDraft` as fixed-shape transactions. No new IAM. |
| `apps/backend/src/Storage/Membership.ts:220, 241, 252`; `Primitives.ts:83` | `listMembers` queries with `Limit`, hydrates, and drops orphans. `nextCursor` comes from `LastEvaluatedKey`. | T10: "more than 20" means a member page of 21 that returns a `nextCursor`. The same rule applies on the server and in the CLI (review R4). |
| `apps/cli/src/Commands.ts` (643 lines), `Commands.test.ts:52-518` | One file. The tests spawn the real CLI against an in-memory HTTP server. `runCli` never ends the child's stdin. | T6 splits by group and moves the harness to `apps/cli/test/CliHarness.ts`, with a `stdin` option (default: an ended stream). |
| Effect rc.112 `unstable/cli/Prompt.ts:836-857`, `Terminal.ts:186`; platform-node-shared `NodeTerminal.ts:36-37, 143` | `NodeTerminal` hard-codes stdout. `Terminal.make` accepts any implementation. | T10: a stderr-display Terminal that overrides `columns`/`rows`. `QuitError` becomes `CliError.UserError` ("… pass --yes"). Verified by experiment. |
| Effect rc.112 `unstable/process/ChildProcess.ts:603`; `NodeChildProcessSpawner.ts:484-510` | Without `unref`, the scope finalizer kills a detached child | T11 `openInBrowser`: detached, stdio `ignore`, then `unref`. Opener: `open` on macOS, `xdg-open` otherwise. |
| Effect rc.112 `unstable/cli/Flag.ts:1521`; `Param.ts:2953-3002` | `Flag.between(0, 20)` gives a repeatable flag with each value validated. There is no either/or combinator. | Exclusivity is checked in the handler with `CliError.UserError`. |
| marked 18.0.14 (MIT, 0 dependencies, bundled types); `scratchpad/md-research/fp/lean/` | Renderer overrides plus a table layout produced about 6 KB of inline-styled HTML. The first `codespan` override forgot to escape its text. | T8 (ADR-0019). Every override escapes its own output, and tests pin it. |
| [Alchemy Layers](https://alchemy.run/infrastructure-as-effects/layers/), [File layout](https://alchemy.run/project-structure/file-layout/) | Services are yielded in init and used by the handler. A shared Layer value shares its resources. "Group Resources that travel together by concern." | Grounds T1 and T5. |
| `wiki/aws/ses.md:31`; `SendGuard.ts:61`; ADR-0011 | Admission is shared across every sender, and the limit floors at 1/s | Test sends take the shared pacing slot. The cap of 20 is about 20 s even at 1/s. |
| ADR-0004 "Alternatives"; the ADR-0008 table | A public route on the admin function was rejected, and public functions hold least privilege | The user chose a dedicated Preview function (2026-09-23). |

- **Open gates:**
  - **G1:** closed. The instruction to implement accepted ADR-0019 and ADR-0020.
  - **G2:** granted on 2026-09-23 for one address only: the operator's test inbox, which the umail MCP reads. Sends go from `--stage test` only, never from prod.
  - **G3:** prod deploys only on the user's word, after T13.

## Research

- **Markdown to email.** The conversation and `scratchpad/md-research/` hold the detail. Compared approaches:

  | Approach | Finding |
  |---|---|
  | MJML 5.4.1 | Stable and async. 234 packages (61 MB). Unscoped Markdown CSS leaked into its own tables, and there is no image `width` attribute. |
  | marked + juice | 45 packages, and it only saves writing the styles inline. |
  | react-email | Needs JSX and a build, and its Markdown component is stale. |
  | Maizzle | A framework, not a library. |
  | Plain text from marked's tokens | No dependency, and it reads well. |

  Conformance essentials (caniemail raw data; Microsoft's Outlook lifecycle page):
  - inline every style;
  - `color-scheme: light`;
  - a fluid 600px table plus an `mso` 600px table;
  - `width="552"` on images;
  - absolute https image URLs;
  - classic Outlook matters until at least 2029.
- **Preview hosting: S3 was rejected.**
  - `AWS.S3.PresignGetObject` exists, but a URL signed with Lambda role credentials expires with the role session.
  - Lifecycle expiry works in whole days, so copies linger.
  - S3 cannot send `sandbox`, `no-referrer` or `noindex`.
  - It would keep a second copy of the body, which ADR-0014 rejected in alternative 6.
- **The preview token.**
  - It has the form `v1.<uuid>.<epoch s>.<64 hex>`, which is 115 characters.
  - The router's default parameter cap is 100, so `PreviewPage` raises `RouterConfig.maxParamLength` to the derived bound, as `UnsubscribePage.ts:115-125` does.
  - Epoch seconds stay at 10 digits until 2286.
- **Test sends.**
  - **One attempt, no retries.** The dispatcher's backoff can take about 39 s for one recipient (1 + 2 + 4 s, plus four 8 s submission timeouts), which does not fit a synchronous API call. A throttled or hung test recipient is reported `rejected` or `uncertain`, and the operator re-runs.
  - **No time budget.** Twenty sends at the pacing floor take about 20 s against the API's 60 s. Exceeding it needs a sandbox-rate account and a concurrent campaign, or SES hanging; that ends as a timeout, and the operator re-runs. The decomplex review found a budget and a `not-attempted` outcome unwarranted.

## Tasks

#### T1 — Backend concern folders (pure move)

- **Change:**
  - `git mv` every backend module and its test into the target folders (`Reputation.ts` goes to `sending/`), and rename `Storage/` to `storage/`.
  - Update imports in `apps/backend`, `alchemy.run.ts` and `stacks/sending-identity.ts`, plus the `package.json` script `feedback:replay`.
  - Update backend path references in `README.md` and `wiki/`. ADR and work-document history stays untouched.
  - No identifier, logical ID, function name or behaviour changes.
- **Starts at:** `apps/backend/src/*`, `alchemy.run.ts:5-12`, `stacks/sending-identity.ts:19-29`, `package.json:8`
- **Status:** Done. `pnpm check` passed with 31 files and 737 tests, the same as before. The prod plan showed `4 to update` (Api, Dispatcher, Feedback, Unsubscribe) with every other resource `noop`, and the identity stack plan showed `no changes`.
- **Tests:** the whole unit suite moves with its modules. It protects every behaviour across the move.
- **Verify:**
  - `pnpm check`: expect a pass, with the same test count as before.
  - `git diff -M --stat HEAD`: expect renames, plus import-line edits only.
  - With AWS credentials exported per the memory "live-gate credentials", run `pnpm exec alchemy plan --config alchemy.run.ts --stage prod --env-file .env`. Expect in-place updates of the four functions and no replace or delete. Alchemy's Lambda provider replaces only on a changed `functionName`, a packaging switch or a `durableConfig` flip (`AWS/Lambda/Function.ts:2034-2073`).
  - Plan the identity stack with the Cloudflare profile, per the memory. Expect no changes.
- **Risk/recovery:**
  - If any function plans a replacement, stop, revert that move and ask the user.
  - This task gets its own commit.

#### T2 — Signed tokens

- **Change:**
  - First, add a golden vector to the unsubscribe tests: a fixed key, a fixed mailbox and the literal expected token. It must pass before and after the change.
  - Add `SignedToken.ts`:
    - `signToken(key, fields)` returns `v1.<fields joined by ".">.<hex HMAC-SHA256("v1." + fields)>`.
    - `verifyToken(key, token, { fields, maxLength })` checks in this order: the length bound, then `^v1(\.[A-Za-z0-9_-]+){fields}\.[0-9a-f]{64}$`, then a constant-time digest comparison. It returns the fields.
    - `tokensMatch` moves here from `api/Auth.ts`, and `Auth.ts` imports it.
  - Rewrite `consent/Unsubscribe.ts` on top of it:
    - it passes `{ fields: 1, maxLength: 407 }`;
    - it keeps the base64url round trip and the canonical-mailbox check;
    - the format and the secret are unchanged.
- **Starts at:** `consent/Unsubscribe.ts:26-100`, `api/Auth.ts:20-28`
- **Depends on:** T1
- **Status:** Done. The frozen unsubscribe token was added first and passed before and after the rewrite.
- **Tests:**
  - `SignedToken.test.ts` (unit): the round trip, a tampered field or digest, the wrong field count or version, uppercase hex, over-length input, a character outside the set.
  - `consent/Unsubscribe.test.ts` (unit): the golden vector, the independent signature, and the existing rejections. These protect already-delivered links.
  - `UnsubscribePage.test.ts` stays unchanged.
- **Verify:** `pnpm check`: expect a pass.

#### T3 — Message composer and Mailer

- **Change:**
  - `sending/Message.ts` (pure):
    - `compose(content, unsubscribeUrl, postalAddress)` returns `{ subject, text, html?, headers }`. The headers are `List-Unsubscribe` and `-Post`.
    - The text footer is unchanged.
    - The HTML footer becomes a self-contained block:
      - a centred table, capped at 600px, with inline font, size, colour and background;
      - still inserted before the last `</body>` (case-insensitive), or appended;
      - it escapes its own interpolations.
    - `senderSettings`: today's `mailerAddresses`, renamed.
  - The `Mailer` service becomes `send(recipient, content, purpose)`. It:
    - mints the recipient's unsubscribe link with `unsubscribeLink`, read per call, never hoisted into the Layer;
    - composes the message;
    - builds the tags: `campaignId` and `sendId` for a campaign, none for a test;
    - submits with the existing outcome mapping, the 8 s timeout and `Retry.none`.
  - Delete `OutgoingMessage`, the footer code in `makeSubmit` and `Mailer.sender`.
  - `Dispatching.ts` calls `send` with the campaign purpose.
- **Starts at:** `sending/Mailer.ts:20-212`, `sending/Dispatching.ts:224-238`
- **Depends on:** T2
- **Status:** Done. `MessageContent.html` is optional, so a stored campaign composes as it is.
- **Tests:**
  - `sending/Message.test.ts` (unit, new): footer placement with `</BODY>`, `İ` and no body tag; escaping; headers; text only.
  - `sending/Mailer.test.ts` (unit): the six exact SES-request assertions, retargeted, plus a test-purpose request without `EmailTags`.
  - `sending/Dispatching.test.ts`: the Mailer double asserts the campaign purpose.
- **Verify:** `pnpm check`: expect a pass. The exact-request assertions keep both unsubscribe headers.

#### T4 — Send admission

- **Change:**
  - `sending/SendGuard.ts`:
    - the `SendGuard` service (`current: Effect<SendAllowance>`), renamed from `DispatchGuard`. Today's interface is renamed `SendAllowance`.
    - `sendGuard(account, alarms, ceiling)` becomes a pure function of the two responses.
    - `SendGuardLive`:
      - binds `SES.GetAccount` and `CloudWatch.DescribeAlarms(...reputationAlarms)`;
      - reads the optional daily ceiling;
      - reads both concurrently, as today.
    - `SendPacingLive`, plus an exported `consumeSlot(limit)` moved from `Dispatching.ts`.
  - The dispatcher keeps its backoff and `reservationFor`.
  - Fix the "Per-run" comment: the guard is evaluated per slice.
- **Starts at:** `sending/Dispatching.ts:35-75`, `sending/SendGuard.ts`, `sending/Dispatcher.ts:63-68, 84-86`
- **Depends on:** T1
- **Status:** Done. `DescribeAlarms` types its failure as `any`, so `SendGuardLive` pins it with `Effect.orDie` before combining the two reads.
- **Tests:**
  - `sending/SendGuard.test.ts` (unit): the guard cases as direct assertions, and `consumeSlot` against the memory RateLimiter.
  - `sending/Dispatching.test.ts`: stubs retargeted to `SendGuard`.
- **Verify:** `pnpm check`: expect a pass.

#### T5 — Live Layers, function wiring, shared props

- **Change:**
  - **New Live Layers beside their tags:**
    - `CampaignWakeLive`: the tag moves from `Campaigns.ts` to `sending/Dispatch.ts`, with the SQS `SendMessage` binding.
    - `CampaignScheduleLive`: the tag moves into `campaigns/CampaignSchedule.ts`, beside its factory.
    - `AccountSuppressionLive` in `audience/Addresses.ts`.
  - **`Lambda.ts` `lambdaBasics(id, name)`:**
    - declares `${id}Logs` with 7-day retention;
    - returns `functionName`, `runtime`, `architecture` and `logGroupName`;
    - is used by all functions, with logical IDs and names unchanged. `main: import.meta.url` stays in each module.
  - **One shape for every function** (Api, Dispatcher, Feedback, Unsubscribe):
    - the constructor runs `const services = yield* Layer.build(<Fn>Live)`;
    - the handler or event callback runs under `Effect.provideContext(…, services)`;
    - `<Fn>Live` merges the stores and bindings with `Layer.provideMerge(NodeCrypto.layer)`.
  - **Removed:**
    - the `Layer.succeed` re-wraps;
    - the Dispatcher's per-batch `Effect.provide`;
    - the duplicated wake-up code.
  - `makeApiHandler(token)` keeps its signature, and its test's `builtHandler` mirrors the constructor.
- **Starts at:** `api/Api.ts:108-138, 176-237`, `sending/Dispatcher.ts:25-116`, `feedback/Feedback.ts:163-224`, `consent/UnsubscribePage.ts:128-169`
- **Depends on:** T3, T4
- **Status:** Done.
  - `pnpm check` passed: 37 files, 759 tests.
  - The prod plan showed `4 to update` with a resource and binding set identical to T1's, so there is no IAM delta.
  - A fresh `--stage test` deploy ran the whole integration suite green: 4 files, 35 tests.
  - **Found on the way:** one pre-existing case failed twice. Lambda reports a disabled SQS mapping as `Disabled` before its pollers stop. A probe enqueued straight to SQS one second after `Disabled` was still consumed; one enqueued two minutes later was not. `disableDispatcherMapping` now waits for a canary stale wake to sit unreceived for longer than a long poll.
  - **Deviation:** the stage stays up until T12's gate, which redeploys over it. That rehearses prod's in-place upgrade. It is destroyed at the end of T12.
- **Tests:**
  - The existing unit suites provide doubles for the same tags.
  - The constructor wiring has no unit coverage, so it is proven live below.
- **Verify:**
  1. `pnpm check`: expect a pass.
  2. Plan prod, as in T1. Expect updates only, with no IAM delta and unchanged log-group logical IDs.
  3. Deploy `--stage test` and repoint `.env.test` (memory "live-gate credentials").
  4. Run the existing `pnpm test:integration`: expect all green.
  5. Destroy the stage, and check the account inventory shows no `emailer-test-*` resources.
- **Risk/recovery:** if a cold-start failure appears, fix it in this task. Do not carry it into the feature tasks.

#### T6 — CLI modules and harness (pure refactor)

- **Change:**
  - Split `Commands.ts` into:
    - `Client.ts`: `emailerClient`, `withClient`, `report`, `requestTimeout`;
    - `Flags.ts`: `idArgument`, the page flags, `pageQuery`;
    - `commands/{Contacts,Lists,Campaigns,Addresses}.ts`. `contactChange` moves to contacts, and schedule parsing to campaigns;
    - `Emailer.ts`: the root command.
  - Split `Commands.test.ts` into `commands/*.test.ts` and `Emailer.test.ts` (the cross-cutting cases).
  - Move `inMemoryService`, `runCli`, `withService` and the fixtures to `apps/cli/test/CliHarness.ts`. `runCli` gains a `stdin` option, which defaults to an ended stream.
  - Change no behaviour or output.
- **Starts at:** `apps/cli/src/Commands.ts`, `Commands.test.ts:18-518`
- **Depends on:** none. It can run in its own worktree after T1, and merge before T7.
- **Status:** Done in an isolated worktree, which has since been removed. There were 54 CLI tests before and after, with identical titles and identical help and completion output.
- **Tests:** every CLI test is kept. They protect the unchanged output and exit codes.
- **Verify:** `pnpm check`: expect a pass, with the same CLI test count.

#### T7 — One campaign state conflict

- **Change:**
  - Replace `CampaignCancellationConflict` with `CampaignStateConflict{state}` (409), at every site:
    - the contract (`Schemas.ts:465-471`, `Api.ts:206`);
    - `campaigns/Campaigns.ts:289, 320`;
    - the CLI harness;
    - all tests.
  - Update the README's 409 wording (`README.md:214`).
- **Depends on:** T5, T6
- **Status:** Done.
- **Tests:** the existing cancel-conflict tests are retargeted. They protect the unchanged 409 behaviour.
- **Verify:**
  - `grep -rn CampaignCancellationConflict apps packages README.md`: expect no output.
  - `pnpm check`: expect a pass.

#### T8 — Markdown rendering (CLI)

- **Change:**
  - Add `marked: 18.0.14` to the `pnpm-workspace.yaml` catalog and `"marked": "catalog:"` to `apps/cli/package.json`, then run `pnpm install`.
  - `apps/cli/src/Markdown.ts`:
    - one `styles` record and `layout({ title, body })`. The layout has the doctype, `lang`, charset and viewport metas, `x-apple-disable-message-reformatting`, the `color-scheme` light meta, a fluid table capped at 600px, and an `mso` 600px wrapper.
    - `renderMarkdown(markdown, subject)` returns a `CampaignBody`:
      - the **HTML instance** overrides `heading`, `paragraph`, `link`, `image`, `list`, `blockquote`, `codespan`, `code`, `hr` and `table`. Images get `width="552"` and fluid CSS. Each override escapes its own text.
      - the **text instance** renders headings in capitals, links as `label (url)`, images as `[alt]`, list markers as-is, table rows as `a | b`, and quotes as `> `.
  - `commands/Campaigns.ts` gets `contentFlags` and `resolveContent`:
    - the choice is either `--markdown <file>`, or `--text <file>` with an optional `--html <file>`;
    - both, or neither on create, is a `CliError.UserError`;
    - output is validated against `CampaignText` and `CampaignHtml`;
    - `create` uses them, and `--text` becomes optional.
- **Starts at:** new `apps/cli/src/Markdown.ts`; `commands/Campaigns.ts` (create)
- **Depends on:** T6
- **Status:** Done. The reference newsletter renders to about 5 KB of HTML.
- **Tests:**
  - `Markdown.test.ts` (unit; the fixture comes from `scratchpad/md-research/newsletter.md`). It protects:
    - every element's inline style;
    - escaping in text, code spans, fenced code, and link and image attributes. A multi-parameter URL gets `&amp;` exactly once.
    - the image `width` attribute and the table output;
    - the text rendering of each element;
    - fixture output well under 102 KB.
  - `commands/Campaigns.test.ts` (spawned CLI):
    - `create --markdown` sends layout HTML plus text without Markdown syntax;
    - flag exclusivity is refused before any request.

    This also proves `marked` loads in the real CLI.
- **Verify:** `pnpm check`: expect a pass.

#### T9 — Draft update and delete

- **Change:**
  - **Contract:**
    - `UpdateCampaignPayload`: `optionalKey` fields `listId`, `subject`, `text`, plus `html` and `filter` as `NullOr`, following `UpdateContactPayload`'s absent-or-null convention;
    - `CampaignsGroup` gains `update` (`PATCH /:id`) and `remove` (`DELETE /:id`, 204).
  - **`storage/Campaigns.ts`:**
    - `campaignReads(readPrimitives)` provides `getCampaign` and `getCampaignBody`, and `campaignOperations` reuses it.
    - `CampaignReader` + `CampaignReaderLive`, with `GetItem` only.
    - `updateDraft(campaign)` is one fixed `runTransaction`:
      - Update META with `SET subject, listId` plus either `SET #filter = :filter` or `REMOVE #filter`, conditioned on `#state = :draft`;
      - Put BODY with `v`, the text and the optional html.
      - Outcomes: `updated | conflict`.
    - `deleteDraft(id)` is one transaction: Delete META, conditioned on `draft`, plus Delete BODY. Outcomes: `deleted | conflict`.
    - Drop `pauseRun`'s unused `_now` parameter and update its five callers.
  - **`campaigns/Campaigns.ts`:**
    - `update`:
      1. `get` the campaign (`NotFound`).
      2. If it is not a draft, fail with `CampaignStateConflict`.
      3. If `listId` is given, check that the list exists (`NotFound` list).
      4. Merge the payload in memory. `null` removes `html` or `filter`.
      5. Run `updateDraft`. On conflict, re-read the control record and fail with `NotFound` or `CampaignStateConflict`.
      6. Return the merged campaign.
    - `remove`: the same draft check, then `deleteDraft`, with the same conflict mapping. A leftover schedule is left alone: if it fires, it finds no campaign, its wake-up is discarded as stale, and it deletes itself.
  - **API:** `update` and `remove` handlers, through `publicly`.
  - **CLI:** `commands/Campaigns.ts`
    - `update <id>`: `--list`, `--subject`, `--filter`, `--clear-filter` and `contentFlags`. Content flags replace the whole body, so without `--html` the command sends `html: null`.
    - `delete <id>`.
    - The harness gets both handlers.
- **Starts at:** `storage/Campaigns.ts:241-330, 736-771`, `campaigns/Campaigns.ts:57-86`, `packages/api/src/Schemas.ts:296-306`
- **Depends on:** T7, T8
- **Status:** Done. `update --markdown` without `--subject` reads the draft's subject for the HTML title, but only when a Markdown body needs it.
- **Tests:**
  - `storage/Campaigns.test.ts` (unit, scripted table): both exact transaction shapes (filter set and removed), delete, and the conflict mapping.
  - `campaigns/Campaigns.test.ts` (unit):
    - the draft-only rules and the list-existence check;
    - the merge, where `null` removes;
    - the race where the state flips between the read and the write, which maps to 409.
  - `api/Api.test.ts` (real handlers): PATCH then `get`, DELETE then 404, and 409 on a queued campaign.
  - `packages/api` `Schemas.test.ts`: absent versus `null` decoding.
  - `commands/Campaigns.test.ts` (spawned CLI): the update payload including `html: null` and `filter: null`, and the delete output.
- **Verify:** `pnpm check`: expect a pass.

#### T10 — Test sends

- **Change:**
  - **Contract:**
    - `maxTestRecipients = 20`;
    - `TestSendPayload` is a union of `{ to: EmailAddress[] }` (1–20 entries, with distinct mailbox keys) and `{ listId }`;
    - `TestSendResult` is `{ recipients: Array<{ email, outcome }> }`. The outcome is one of `accepted`, `skipped{reason: unsubscribed|suppressed|bouncing}`, `rejected{rejectionCode}` or `uncertain`;
    - new errors: `TestAudienceTooLarge{limit}` (409) and `SendingPaused{reason: reputation|daily-quota}` (503);
    - endpoint `test` (`POST /:id/test`).
  - **`campaigns/TestSends.ts` `sendTest(campaignId, payload)`:**
    1. `Campaigns.get` (`NotFound`).
    2. Resolve the recipients. Either the `to` addresses, or `listMembers(listId, 21)`: a missing list is `NotFound` list, and a `nextCursor` means `TestAudienceTooLarge`. The campaign's filter is not applied.
    3. Read `SendGuard.current`. If halted, fail with `SendingPaused{reputation}`. If the daily budget is exhausted, fail with `SendingPaused{daily-quota}`.
    4. For each recipient in order:
       - check `addressStatus`; a non-mailable address is reported `skipped`;
       - otherwise take `consumeSlot(limit)` and sleep;
       - then `Mailer.send(recipient, { subject: "[Test] " + subject, text, html }, { kind: "test" })`.
    5. Return the outcomes.

    No store writes happen.
  - **API:** the `test` handler. `ApiLive` gains `MailerLive`, `SendGuardLive` and `SendPacingLive`. The constructor's Config capture adds the sender, the postal address and the ceiling to the env.
  - **Feedback:** `feedback/Feedback.ts` logs untagged feedback at info level, as "feedback without a campaign tag (a test send)". Suppression is unchanged.
  - **CLI:**
    - `Terminal.ts` holds:
      - `stderrTerminal`, which wraps `NodeTerminal.make` and displays on stderr with stderr's `columns`/`rows`. It is provided in `main.ts`.
      - `confirm(message)`, where a `QuitError` becomes `CliError.UserError` ("… pass --yes").
    - `commands/Campaigns.ts` `test <id>`:
      - flags: `--to` (repeatable, `Flag.between(0, 20)`), `--list` and `--yes`. Exactly one of `--to`/`--list` is allowed, otherwise `UserError`.
      - With `--list`, one `withClient` first reads the campaign, the list and a member page of 21. A `nextCursor` means refusing locally. Otherwise, unless `--yes` is given, it asks, outside any `withClient`: "Send a test of "<subject>" to N members of "<list>"?".
      - The POST gets its own `withClient`, so think time never eats its 70 s.
      - It prints `TestSendResult`.
    - The harness gets the handler.
- **Starts at:** new `campaigns/TestSends.ts`; `api/Api.ts`; `feedback/Feedback.ts:83-89`; new `apps/cli/src/Terminal.ts`; `main.ts:11-15`
- **Depends on:** T3, T4, T5, T7, T9 (T9 and T10 edit the same contract and CLI files, so they run in sequence)
- **Status:** Done.
  - `accepted` also carries the `messageId`, to match a message in an inbox.
  - The typed client splits a union payload per member, so the CLI branches its call.
  - The harness pages members the way DynamoDB does: a full page reports a cursor.
- **Tests:**
  - `campaigns/TestSends.test.ts` (unit, with `TestClock` and doubles):
    - the `[Test]` subject and the test purpose;
    - the skip reasons;
    - a list refused when the page has a `nextCursor`, and an orphaned member does not hide the 21st entry;
    - a halted guard and an exhausted daily budget are refused;
    - rejected and uncertain are mapped;
    - no store writes (a CampaignStore double whose writes fail the test);
    - order is preserved.
  - `api/Api.test.ts`: decoding and error mapping.
  - `feedback/Feedback.test.ts`: an untagged permanent bounce still suppresses, writes no history or counter, and logs at info. Retarget both assertions on the old warning text (today at `Feedback.test.ts:443-444` and `:555`): the zero-count check would otherwise pass vacuously.
  - `commands/Campaigns.test.ts` (spawned CLI with stdin):
    - both flags given, or neither, is refused before any request;
    - `--list` with `y` sends and with `n` does not. The prompt shows on stderr only, and stdout carries only JSON, or nothing when declined;
    - a closed stdin exits 1 with the `--yes` hint;
    - `--yes` skips the prompt;
    - a 21-member page is refused locally.
- **Verify:** `pnpm check`: expect a pass.

#### T11 — Preview function

- **Change:**
  - **Contract:** `PreviewLink` `{ url, expiresAt }`, and the endpoint `preview` (`POST /:id/preview`).
  - **`campaigns/Previews.ts`:**
    - `previewSecret = Random("PreviewSecret")`;
    - the bare tag `PreviewFunction` (`"Preview"`);
    - `previewLifetime` of 24 hours;
    - `maxPreviewTokenLength` (115, derived);
    - minting and verifying through `SignedToken` with the fields `[campaignId, expiresAtSeconds]`. After the signature it checks the UUID and the integer, and compares the expiry with `Clock`;
    - `previewLink(campaignId)` reads `EMAILER_PREVIEW_URL` and `EMAILER_PREVIEW_SECRET` per call.
  - **`campaigns/PreviewPage.ts`, `PreviewFunction.make`:**
    - **Props** via `lambdaBasics("Preview", "preview")`: 256 MB, a 10 s timeout, `reservedConcurrentExecutions: 2`, a public URL, and the `EMAILER_PREVIEW_SECRET` env.
    - **Constructor:** builds `PreviewLive`, which is `CampaignReaderLive` plus `senderSettings` captured from Config.
    - **Route** `GET /previews/:token`, with `RouterConfig.maxParamLength` set to the bound:
      - verify, then read, then compose with a fixed, visibly non-functional placeholder unsubscribe URL;
      - the page shows From, Subject, the HTML part in `<iframe sandbox srcdoc>` (attribute-escaped) and the text in `<pre>`.
    - **Headers:**
      - `Content-Security-Policy: sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-src 'self'`. Adjust it only if T12's browser check shows the frame or links blocked.
      - `Referrer-Policy: no-referrer`
      - `X-Robots-Tag: noindex, nofollow`
      - `Cache-Control: no-store`
    - **Failures:** an invalid or expired token, or a missing campaign, answers 404 "This preview link is not valid or has expired". A storage failure fails through `reportedAndFatal`.
  - **`alchemy.run.ts`:** yield `PreviewFunction`, and provide `Layer.mergeAll(UnsubscribePage, PreviewPage)`.
  - **API:**
    - `apiProps` adds `EMAILER_PREVIEW_URL: preview.functionUrl` and `EMAILER_PREVIEW_SECRET: secret.text`, via bare-tag references;
    - the `preview` handler: `Campaigns.get` (`NotFound`), then `previewLink`.
  - **CLI:**
    - `commands/Campaigns.ts` `preview <id> [--open]` prints the JSON link, then opens it;
    - `Terminal.ts` `openInBrowser`: detached, stdio `ignore`, `unref`;
    - the harness gets the handler.
- **Starts at:** new `campaigns/Previews.ts` and `campaigns/PreviewPage.ts`; `alchemy.run.ts:104-109`; `api/Api.ts` (props)
- **Depends on:** T2, T3, T5, T9 (`CampaignReader`), T10 (`Terminal.ts`)
- **Status:** Done.
  - Links in the sandboxed frame open in a new tab: a `<base target="_blank">` goes into the frame's copy of the HTML.
  - The prod plan showed `3 to create, 4 to update, 4 binding changes` and nothing replaced or deleted.
- **Tests:**
  - `campaigns/Previews.test.ts` (unit, `TestClock`): the round trip, the expiry boundary, tampering, the wrong field shape, and the length bound.
  - `campaigns/PreviewPage.test.ts` (unit, composed router, `CampaignReader` double):
    - 200 with all four headers;
    - an escaped subject and srcdoc;
    - the placeholder footer;
    - an expired or forged token answers 404 without a storage read;
    - a missing campaign answers 404;
    - a 115-character token is routed and not capped.
  - `api/Api.test.ts`: the preview endpoint returns a URL under the configured base, and 404 for a missing campaign.
  - `commands/Campaigns.test.ts`: the preview JSON output.
  - `--open` is not automated, because it launches a browser. The scout verified the spawn with `true` and `sleep`, and T12 checks it by hand.
- **Verify:**
  - `pnpm check`: expect a pass.
  - Plan prod. Expect `+` for the Preview Function, PreviewLogs and PreviewSecret, the Api IAM additions (`ses:SendEmail`, `ses:GetAccount`, `cloudwatch:DescribeAlarms`), and no replace or delete.

#### T12 — Sweep, docs and live gate

- **Change:**
  - **Sweep** (the scout-verified list only):
    - delete `CreateContactOutcome`, `StoredFeedbackRecord` and `AllPrimitives`;
    - un-export module-local symbols that have no external or test use;
    - rewrite comments that cite plan task IDs or past designs (`api/Api.ts` "T4 only registered", "used to be assembled"; `Diagnostics.ts:43`; `storage/Items.ts:43`; `storage/Membership.ts:37`; `storage/Testing.ts:170-172`) so they state current behaviour.
  - **README "Use":**
    - the drafting workflow;
    - the new commands;
    - the PATCH, DELETE, preview and test contracts;
    - a note that the unsubscribe link in test mail is real.
  - **Wiki:**
    - new `wiki/email/html-email.md`, covering the conformance essentials and the marked approach, including the escaping trap;
    - `wiki/effect/http-cli-and-runtime.md`: the stderr Terminal, `Flag.between`, detached `ChildProcess` plus `unref`, `CliError.UserError`, and the lack of an either/or combinator;
    - `wiki/alchemy/runtime-and-bindings.md`: the `Layer.build` capture, and why not `Effect.context()`.
  - **ADRs:**
    - mark 0019 and 0020 `Accepted` when implementation is authorized;
    - add lifecycle lines to 0001, 0007, 0008, 0011 and 0014;
    - fill in Confirmation after the gate.
  - **Integration cases** (`*.integration.test.ts`, with a new `IntegrationSupport` guard that refuses non-simulator explicit addresses):
    - draft update in both expression shapes (filter set, then `filter: null` with a body change);
    - delete, then 404, and 409 on a non-draft;
    - preview mint, then a GET that checks the four headers, and 404 for a forged token;
    - a test send to two simulator success addresses: accepted, and the campaign's counters and SEND rows unchanged;
    - a test send to the bounce simulator: the address ends up suppressed, and the campaign's `feedback` stays 0 after the event;
    - a test send to a list.
  - **Live gate on `--stage test`:**
    1. Deploy and repoint `.env.test`, then run `pnpm test:integration`.
    2. CLI walkthrough, in this order:
       - create from the sample Markdown;
       - `preview`, checked with `curl -sI` and agent-browser screenshots at desktop and 390px width;
       - `update`, then reload the same link;
       - `test --to` simulator addresses;
       - `test --list` with piped `y`, and again with `--yes`;
       - `delete` a second draft;
       - send the campaign to a simulator list;
       - `--open` by hand.
    3. **G2:** with the user's yes, send one `test --to` to the operator inbox and read it through the umail MCP. Expect `dkim=pass` with both unsubscribe headers in `h=`, the footer under the card, and a legible text part.
    4. Destroy the stage, and verify the inventory.
- **Depends on:** T1–T11
- **Status:** Done.
  - **Sweep:** limited to the three dead types, the symbols this slice introduced without outside users, and comments that described replaced designs. The older module-local exports stay as they are.
  - **Deploy trap:** redeploying over the T5 stage exposed that Alchemy beta.77 plans code-only changes as `noop` (the diff returns early on an unresolved `exports.handler`). The stage was redeployed with `--force`, and the cause is recorded in `wiki/alchemy/version-specific-traps.md`.
  - **Integration suite:** 5 files, 40 cases, green in 621 s.
  - **Walkthrough:** passed, including G2 in the operator's test inbox: `dkim=pass`, both unsubscribe headers signed, `dmarc=pass`, styles intact, text part legible.
  - **`--open`:** on this headless machine it prints the link and exits 0 with no process left behind. Opening an actual desktop browser was not observed.
  - **Teardown:** the stage was destroyed, and the account inventory shows no `test` resources.
  - **Secrets:** the test-stage API token was replaced after a `--detailed` plan printed it into a local log, and that log was deleted.
- **Tests:** the integration cases above protect what unit tests cannot see: IAM, bindings, the Function URLs, and the feedback path.
- **Verify:**
  - `pnpm check`: expect a pass.
  - `pnpm test:integration` against the test stage: expect all green.
  - The leak check (below): expect no output.
  - After destroy: expect no `emailer-test-*` resources.

#### T13 — Prod plan

- **Change:** none to code. Plan both stacks and record the result, anonymized.
- **Depends on:** T12
- **Status:** Done, differently from planned. On 2026-09-23 the user granted G3 after this slice merged with the codebase cleanup (PR #1, `60061cd`). Prod held only a test list, so the user chose to destroy `Emailer/prod` and deploy it fresh rather than apply the in-place plan below. The evidence is in the cleanup's [handoff](codebase-cleanup.md#handoff). The `campaigns preview` and `campaigns test --to` checks were not run, because the user named no recipients.
  - **Prod plan, superseded:** `3 to create, 4 to update, 4 binding changes`.
    - Creates: Preview, PreviewLogs, PreviewSecret.
    - Updates: Api, Dispatcher, Feedback, Unsubscribe.
    - New permissions: `SendEmail`, `GetAccount` and `DescribeAlarms` for Api, and `GetItem` for Preview.
    - Nothing is replaced or deleted.
  - **Identity stack:** `no changes`.
  - **Code shipping:** each function's `main` path differs from prod's state, so a plain deploy ships the current bundles. Check `CodeSha256` afterwards.
- **Verify:**
  - Plan prod. Expect updates to Api, Dispatcher, Feedback and Unsubscribe, creates for Preview, PreviewLogs and PreviewSecret, and zero replace or delete.
  - Plan the identity stack: expect no changes.
  - Run the leak check again after recording: expect no output.
- **Risk/recovery:**
  - Any replace means stop and ask.
  - Deploy only on the user's word (G3). Afterwards, check `campaigns preview` and `campaigns test --to` against prod, with recipients the user chooses.

## Leak check

The public repository is anonymized. Before every commit that carries evidence (T1, T5, T12, T13), run:

```
test -s "$LEAK_PATTERN" || { echo "leak pattern missing or empty" >&2; exit 1; }
{ git diff --name-only --diff-filter=d <slice-start>; git diff --name-only --cached --diff-filter=d; git ls-files --others --exclude-standard; } \
  | sort -u | xargs -r grep -nIEf "$LEAK_PATTERN"
```

- **The pattern file:** `$LEAK_PATTERN` is a file outside the repository. It lists the private domains, the operator addresses, the account ID and the production Function URL hosts.
- **Where it lives:** this planning session has it in its scratchpad (`leak-pattern.txt`). Before T1, copy it to a lasting path outside the repository.
- **Why the guard:** an empty or missing file would match nothing and pass silently, so `test -s` refuses it.
- **Expect:** no output.

## Final acceptance

- **Checks:**
  - `pnpm check` passes after every task.
  - The T5 cold-start check and the T12 integration suite are green on ephemeral stages, and both stages are destroyed and verified.
  - The live walkthrough is recorded, plus the G2 inbox check if granted.
  - The prod plans show no replace or delete.
  - The leak check produces no output.
- **End state:**
  - The drafting loop works end to end from one Markdown file.
  - The backend is in concern folders, with one composer, one signed-token module and one send-admission module.
  - No function re-wraps services, and there is no duplicated wake-up code.
  - The CLI is split by command group, with a reusable harness.
  - Delivered unsubscribe links still verify, which the golden vector proves.
- **Deferrals or blockers:** G1 (ADR acceptance), G2 (the operator-inbox send), G3 (the prod deploy).

## Handoff

- **Next action:** on the user's instruction to implement:
  1. accept ADR-0019 and ADR-0020;
  2. branch from `public`;
  3. start T1.
- **Reviews:**
  - **[Adversarial review](drafting-and-preview-review.md), round 1: Changes requested, all 11 findings dispositioned.**

    | Finding | Disposition |
    |---|---|
    | R1 (major) | Accept. Contract changes land with their feature tasks, and every task ends green. |
    | R2 | Accept. `Layer.build` capture, not `Effect.context()`. |
    | R3 | Moot. The budget was removed per DEX-001. |
    | R4 | Accept. `nextCursor` decides "more than 20". |
    | R5 | Accept. Separate `withClient` calls around the prompt. |
    | R6 | Accept. A fixed transaction per DEX-002, and integration covers both expression shapes. |
    | R7 | Accept. `verifyToken(…, { fields, maxLength })`, order kept. |
    | R8 | Accept. The `check:imports` claim is dropped, and a cold-start check is added after T5. |
    | R9 | Accept. The leak check is defined and repeated after T13. |
    | R10 | Accept. `Reputation.ts` moves to `sending/`, and `SignedToken.ts` to the root. |
    | R11 | Accept. "Sixth capability", and revocation by replacing `PreviewSecret`. |

  - **[Adversarial review](drafting-and-preview-review.md), round 2: Clear.**
    - R1, R2 and R4–R11 are resolved, and R3 is moot.
    - Three new minor items, all accepted:
      - **N1:** the leak check now has a `test -s` guard and `--diff-filter=d`, and its pattern moves to a lasting path.
      - **N2:** ADR-0019 no longer names `EmailLayout.ts`.
      - **The feedback test note:** both assertions on the old warning are retargeted.
    - Also taken from the round: T9 and T10 run in sequence, and the BODY Put carries `v`.
  - **[Decomplex prevention](drafting-and-preview-decomplex.md): all six findings accepted.**

    | Finding | Change |
    |---|---|
    | DEX-001 | No test budget or `not-attempted`, and `reservationFor` stays private. |
    | DEX-002 | One fixed update transaction, merged in memory. |
    | DEX-003 | Test sends are untagged. The separate Feedback task is gone, and an info log replaces the warning. |
    | DEX-004 | `sendGuard` is pure. |
    | DEX-005 | Delete leaves a leftover schedule alone. |
    | DEX-006 | `content/` collapses into `Markdown.ts`. The user saw only the backend layout, so this needs no question. |
