# Codebase cleanup and dependency upgrade

> **Status:** Partial. Every task is verified and merged with main's drafting slice (see [Sync with main](#sync-with-main)). Two deviations await the user's approval: T3.2's API-level annotation, which waits for the Effect RC that ships effect#8423 (ADR-0022), and T3.3, descoped in the sync.
> **Updated:** 2026-09-23
> **ADRs:** [0021](../0021-whole-project-unused-code-check.md) (T1), [0005](../0005-contact-identity-and-membership-access-paths.md) (amended by T4), [0004](../0004-sender-owned-one-click-unsubscribe.md) (who mints the links, T2 and the sync), [0008](../0008-storage-capabilities-and-error-boundaries.md), [0011](../0011-open-recipient-set-and-paced-dispatch.md). [0022](../0022-api-contract-rejects-undeclared-fields.md) (T3), [0023](../0023-lists-carry-no-membership-version.md) (T4). ADR numbers 0019–0020 belong to the drafting slice merged from main.

## Outcome and boundaries

- **Target:** the codebase reads as if it had been built clean from the start:
  - current compatible dependencies;
  - no dead code or stale comments;
  - leftovers caught by the check suite from now on;
  - the four correctness gaps from the whole-codebase review closed.
- **Authority:** the user approved the 37-item plan on 2026-09-23 ("do it … big refactors and rewrites are welcome").
- **Constraints:**
  - Never destroy or redeploy `prod` or `EmailerSending/shared`. Live checks use the ephemeral stage `test-cleanup` only, and each is destroyed afterwards.
  - `pnpm check` must be green at every commit.
- **Out of scope:**
  - renaming `StorageFailure`;
  - object parameters on storage methods;
  - merging the two stores or the primitive factories;
  - splitting large files;
  - CLI error-dump polish;
  - DynamoDB Local, `@effect/vitest` or a coverage tool;
  - oxlint 1.85, which is blocked because `@effect/tsgo` 0.45.0 supports only oxlint 1.81/1.82.
- **Worktree:** `~/worktrees/emailer/codebase-cleanup`, branch `codebase-cleanup` off `public` at `c72055b`. It merges back with `--no-ff` once the final review is clear.

## Tasks

### T0 — Dependency upgrade

- **Status:** Verified
- **Items:**
  - T0.1: `effect` and `@effect/platform-node` to 4.0.0-rc.117. Move the overrides to rc.117; they now exist to keep a single Effect RC.
  - T0.2: `alchemy` to 2.0.0-beta.79 and `@distilled.cloud/aws` to 1.0.0-rc.12.
  - T0.3: `oxfmt` 0.70.0, `vitest` 5.0.1, `@types/node` 24.13.6.
  - T0.4: delete Alchemy's vitest 4.1.11 extension and the stale `minimumReleaseAgeExclude` entries; re-key the TypeScript 6.0.3 extension to `@alchemy.run/cloudflare-runtime@2.0.0-beta.79`.
  - T0.5: the Effect renames (`Config.String`, `Redacted`, `Int`, `Literals`; `Flag.*`; `Argument.String`).
  - T0.6: wiki refresh (lowercase Effect names; the Alchemy traps table).
- **Acceptance:**
  - `pnpm check` is green.
  - Exactly one `effect` and one `@distilled.cloud/aws` in the lockfile.
  - Every entry module imports.
  - A `test-cleanup` deploy plus the full integration suite plus a `ReplayFeedback` run all pass.
  - The stage stays up until T4, so that T4's redeploy proves on existing functions that a changed bundle ships (`CodeSha256` recorded below); it is destroyed after T4.
- **Evidence:**
  - **Upgrade:**
    - A scratch trial made the renames mechanical: 46 call sites, plus the DNS work's `Config.Literals` and `Config.String`.
    - The lockfile has exactly one version each of `effect` (rc.117), `@distilled.cloud/*` (rc.12), `alchemy` (beta.79) and `vitest` (5.0.1).
    - `pnpm check` is green with 737 unit tests.
    - Api, Dispatcher, Feedback, UnsubscribePage, ReplayFeedback and the CLI all import with AWS credentials removed.
  - **Deploy:** `test-cleanup` deployed 28 resources in 90 s.
  - **Replay:** `ReplayFeedback` through the SSO profile (Distilled's new credential chain) printed `replayed 0 message(s)`.
  - **First full integration run:** 33/35. Neither failure came from the upgrade. Both were live races.
    - **Alarm pause:** the forced alarm pauses the first slice before `send` re-reads its campaign, so the response can already say `paused`. The assertion now accepts `paused`.
    - **Stale wake held by disabling the mapping:** the dispatcher consumed the wake anyway. Probed live:
      - on a quiet stage, a message sent 1 s after `Disabled` was still invoked, and one sent 12 s after stayed queued;
      - after a busy suite, the pollers kept invoking for more than 20 s, with up to 5 s pickup delay.
      - `disableDispatcherMapping` now waits until a probe wake (a campaign that does not exist, discarded as stale later) stays queued for a full 20 s long-poll cycle. The finding is recorded in `wiki/aws/sqs.md`.
    - Both cases passed 3/3 in isolation afterwards.
  - **Final full integration run:** 35/35 in 502 s.
  - **`CodeSha256` after the T0 deploy:**
    - api `IO9u/ZNE…`
    - dispatcher `s1/6Tk3D…`
    - feedback `QH6LVA+E…`
    - unsubscribe `Q430SHJy…`
  - **Wiki:** 23 pages refreshed for beta.79, RC117 and Distilled rc.12. The traps table lost the RC112 pin row and gained rows for the Lambda update wait and Distilled's own signer and credential chain.

### T1 — Tooling that catches leftovers, and clearing what it finds

- **Status:** Verified
- **Items:**
  - T1.1: knip dev dependency, `knip.config.ts` and a `knip` script, all in `pnpm check`.
  - T1.2: `--report-unused-disable-directives` on the lint script.
  - T1.3: delete stale disable comments (`Unsubscribe.ts:5`, `Commands.test.ts:14`).
  - T1.4: delete `apps/mcp` and the MCP SDK catalog entry.
  - T1.5: delete `CreateContactOutcome`, `AllPrimitives` and `StoredFeedback`/`StoredFeedbackRecord`; turn `FeedbackKind`/`FeedbackOutcome` into plain unions.
  - T1.6: remove `export` from names used only inside their own module.
  - T1.7: replace the `MemberCursor` alias with `EntityId`.
  - T1.8: new ADR for the whole-project unused-code gate.
- **Acceptance:** `pnpm check`, including knip, is green with zero findings.
- **Evidence:**
  - **Tooling:**
    - knip 6.37.0 runs in `pnpm check` after lint. `knip.config.ts` names the two stack entry points, the vendored lint rules, the tsgo plugin key, and `includeEntryExports` for `packages/api`.
    - Lint runs with `--report-unused-disable-directives`, which found a third stale directive, in `stacks/sending-identity.ts`.
    - A temporary unused export failed knip with exit 1.
  - **Deleted:**
    - `apps/mcp` and the MCP SDK catalog entry;
    - `CreateContactOutcome`, `AllPrimitives`, `StoredFeedback`/`StoredFeedbackRecord`, and the unused `AddressStatus`/`EntityKind` type aliases;
    - three stale disable directives.
    - `FeedbackKind`/`FeedbackOutcome` are now plain unions.
  - **Un-exported:** about 40 module-private names. Two extras from `ReplayFeedback.ts`, which knip cannot see because it is a script entry. Four HttpApi group classes plus the `AddressStatus`/`EntityKind` schemas in `packages/api`.
  - **Replaced:** the `MemberCursor` alias with `EntityId`, keeping a comment on `memberQuery`. `stacks/sending-identity.ts` names its stack with the shared `sendingIdentityStack` constant (same value, `EmailerSending`).
  - **Check:** `pnpm check` exit 0. 737 unit tests; knip reports nothing.
  - **ADR:** [0021](../0021-whole-project-unused-code-check.md).

### T2 — Simplify

- **Status:** Verified
- **Items:**
  - T2.1: drop `pauseRun`'s `_now` parameter.
  - T2.2: the API Lambda no longer carries the unsubscribe URL or secret, and the stale `alchemy.run.ts` comment goes.
  - T2.3: one shared table-binding Layer for the audience and campaign stores.
  - T2.4: one `campaignWake(sendMessage)`.
  - T2.5: use the `removeMembership` helper in `Membership.ts`.
  - T2.6: `readItems` becomes a plain loop.
  - T2.7: `SendGuard.halted` becomes a boolean.
  - T2.8: drop the `predecessor !== runToken` check.
  - T2.9: `FetchHttpClient.layer` without `mergeAll`.
  - T2.10: replace `Buffer` with Effect `Encoding` in `Unsubscribe.ts`, keeping the round-trip check.
  - T2.11: fix stale and wrong comments.
- **Acceptance:** `pnpm check` is green; existing tests are updated only where a signature changed.
- **Evidence:**
  - **Shared helpers:**
    - `allTableOperations` / `AllTableOperationsHttp` in `Storage/Table.ts`, used by both stores.
    - `campaignWake(sendMessage)` in `Dispatch.ts`, used by the API and the dispatcher.
  - **`readItems`:** a plain loop with one deadline and `catchTag("TimeoutError")`. No `instanceof` and no private-error control flow remain. `Primitives.test.ts` is unchanged, 26/26.
  - **API Lambda:** no longer carries the unsubscribe URL or secret. An import walk from `Api.ts` (23 modules) finds no reader. The bare-tag comment in `alchemy.run.ts` now names the Dispatcher, and ADR-0004's ADR-0011 line says the dispatcher mints the links.
  - **Unsubscribe tokens:** `Encoding` base64url replaces `Buffer`. The new golden test "mints and verifies the exact token already issued for %s" passed on `Buffer` before the switch and on `Encoding` after (21- and 20-byte addresses).
  - **`halted`:** now a boolean, so the precedence test lost its meaning and was removed.
  - **Smaller changes:** `pauseRun`'s `_now` is gone; `predecessor !== undefined`; `FetchHttpClient.layer`.
  - **Comments:** stale comments rewritten in `Api.ts`, `Diagnostics.ts`, `Items.ts`, `Membership.ts`, `Testing.ts`, `Primitives.ts` (worst case 3.8 s), `FeedbackClassification.ts` (the `Suppressed` subtype is the global list), `Feedback.ts` and `IntegrationSupport.ts`.
  - **Check:** `pnpm check` exit 0, 738 unit tests.

### T3 — Correctness and error handling

- **Status:** Verified, except T3.2's API-level annotation, which is blocked upstream (below), and T3.3, descoped in the [sync with main](#sync-with-main) pending approval
- **Items:**
  - T3.1: log the reason and cause of every `uncertain` submission, without the recipient.
  - T3.2: reject unknown request fields. `HttpApi.ParseOptions` goes on `EmailerApi`, and `lists import --file` decodes strictly. Adds a new ADR.
  - T3.3: mint the unsubscribe link before the recipient is claimed.
  - T3.4: `Max24HourSend: -1` means no daily limit.
- **Acceptance:** each item has a new test; `pnpm check` is green.
- **Evidence:**
  - **T3.1:** `submitClaimed` logs `submission uncertain` with `campaignId`, `sendId`, `reason` and `describeCause(cause)`. Test: "logs why a submission ended uncertain, without the recipient's address". The address sits inside the SDK error's message and appears nowhere in the captured logs.
  - **T3.3:** the link is minted after the budget check and before the claim. Test: "claims no recipient when the unsubscribe link cannot be minted". It failed on the old order, with one claim recorded.
  - **T3.4:** a negative `Max24HourSend` means no account limit, so only the ceiling applies. Tests: "is not exhausted when Max24HourSend is -1…" and "exhausts an unlimited quota at the daily ceiling".
  - **T3.2, CLI:** `lists import --file` reads with `Flag.File` and decodes with `{ onExcessProperty: "error" }`. A typo fails as `Invalid value for flag --file: "<path>". Expected no excess property … at ["contacts"][0]["attributs"]`, before any request. Tests: the typo case (no request reaches the server) and a new well-formed import.
  - **T3.2, API: blocked upstream.**
    - `HttpApi.ParseOptions` with `"error"` on `EmailerApi` made 29 `Api.test.ts` cases answer 500. RC117's excess-key check uses `Reflect.ownKeys`, which sees a `Schema.TaggedError`'s non-enumerable `stack`. The standalone repro is `encodeUnknownSync(TaggedError)(instance, { onExcessProperty: "error" })`, which throws at `["stack"]`.
    - [effect#8423](https://github.com/Effect-TS/effect/pull/8423) fixes it. It was merged on 2026-09-23 and is not in any published RC yet.
    - Recorded in [ADR-0022](../0022-api-contract-rejects-undeclared-fields.md) and in `wiki/effect/http-cli-and-runtime.md`.
    - **Follow-up when upgrading to an RC containing #8423:** add the one-line annotation to `EmailerApi`, plus `400` tests for an unknown payload key (`fitler` on campaign create, an extra key on contact create) and an unknown query parameter.
  - **Review fix L1:** `disableDispatcherMapping` registers its restore before waiting for `Disabled` and for the pollers to stop. Live proof comes in T4.
  - **Check:** `pnpm check` exit 0, 744 unit tests.

### T4 — Remove `membershipVersion`

- **Status:** Verified
- **Items:**
  - T4.1: a list-existence `ConditionCheck` replaces the increments. The field goes, along with the `deleteContact` fallback, `deleteList`'s last-page special case, and the stale comments.
  - T4.2: update the unit pins; replace the counter oracle in `Api.integration.test.ts`; add a live case proving that adding to a deleted list is refused.
  - T4.3: a new ADR amending ADR-0005.
- **Acceptance:** `pnpm check` is green, plus a `test-cleanup` deploy and the full integration suite, then destroy.
- **Evidence:**
  - **Lists:** no version is stored. `getList` returns `Option<ContactList>`; old items with the attribute still decode.
  - **List check:** `addMember`, `removeMember` and `importContacts` carry `listExists` (`ConditionCheck` with `attribute_exists(pk)`) in the old slot, so the index mapping is unchanged.
  - **Cascades:** the contact cascade is one 2-delete transaction per membership, with no fallback. The list cascade uses 80-action pages, skips empty pages, and deletes META last on its own.
  - **Unit tests:** pins updated. `pnpm check` exit 0, 742 unit tests.
  - **Redeploy of `test-cleanup` (phases 1–4):**
    - A plain `deploy` updated only the API, whose env changed. Dispatcher, Feedback and Unsubscribe reported `noop` with unchanged `CodeSha256`: the known Alchemy trap, confirmed on beta.79 and recorded in the wiki.
    - `deploy --force` updated all 28 resources, and every function's `CodeSha256` changed (api `6Vg+9cR7…`, dispatcher `+R/SAIM2…`, feedback `y9pA6RIa…`, unsubscribe `VeIxwzgX…`).
    - The API's env no longer has `EMAILER_UNSUBSCRIBE_*`.
  - **Full integration suite:** 36/36 in 552 s. It includes the rewritten "treats a repeated membership as a no-op" and the new "refuses a membership in a list that is not there and writes neither direction" (a real `ConditionCheck`), and the L1-reworked mapping hold passed.
  - **ADR:** [0023](../0023-lists-carry-no-membership-version.md), linked from ADR-0005.

### T5 — Tests and docs

- **Status:** Verified
- **Items:**
  - T5.1: one shared unused-`CampaignStore` stub.
  - T5.2: trim `Api.test.ts` to what only the HTTP layer can break.
  - T5.3: `test:integration` loads `.env.test`, plus a README section.
  - T5.4: README updates:
    - the address-case advice;
    - unknown fields are rejected;
    - knip is part of `pnpm check`.
- **Acceptance:** `pnpm check` is green; no protected HTTP behaviour loses its test.
- **Evidence:**
  - **T5.1:** `unusedCampaigns` sits beside `unusedAudience`, sharing one private helper, and replaces three hand-written copies.
  - **T5.2:** five campaign-rule cases in `Api.test.ts` were removed, each mapped to the `Campaigns.test.ts` case that covers the same rule: resume, schedule, scheduled cancel, manual-pause cancel, and replacement-generation 409.
    - Every auth, decoding, size, scope and error-status case stays, and so does a round trip per group, including one cancel round trip with the runToken checks. The resume round trip was one of the five removed.
    - The fake shrank by 140 lines; the file went from 2325 to 1911 lines.
    - **Accepted:** the resume route is now reached over HTTP only by the live suite (the alarm-pause case).
  - **T5.3:** `test:integration` is `node --env-file=.env.test node_modules/vitest/vitest.mjs run --project integration`.
  - **T5.4 (README):**
    - a new "Develop and test" section;
    - the `--force` / `CodeSha256` redeploy note;
    - address-case advice corrected in both places;
    - import strictness and the "existing contact unchanged" note;
    - the Requirements line pins beta.79 and rc.117.
  - **Check:** `pnpm check` exit 0, 737 unit tests (742 minus the five duplicates).
  - **Final live gate:**
    - The first `pnpm test:integration` run (the new script) went 35/36. The opt-out case asserted exactly `queued` after `send`, but the dispatcher can begin before `send` re-reads. That is the same race the API suite already tolerates with its `submitted` states. The constant now lives in `IntegrationSupport` and both suites use it.
    - Rerun: 36/36 in 530 s.
    - `test-cleanup` was destroyed (28 resources). The inventory shows no function, table, queue, alarm, schedule group, topic, log group, rule, configuration set, role or mapping left for the stage. Prod's four functions are untouched, and no account-suppression entries were added.

## Sync with main

On 2026-09-23 the drafting slice (ADR-0019, ADR-0020) landed on `origin/main` from the same base, `c72055b`. It moved the backend into concern folders, split the CLI into command groups, built each function's services from Live layers, and moved message composition and link minting into the Mailer. This branch merged `origin/main` to open its PR, with 26 conflicting files. Main's layout and design were kept, and this plan's changes were ported into them.

- **Ported:**
  - the rc.117 renames in main's new files, including `Prompt.Confirm`;
  - the boolean `halted` and the `-1` quota rule in `sending/SendGuard.ts`, used by test sends as well. Their alarm and enforcement fixtures collapsed into one case;
  - the `submission uncertain` log in `sending/Dispatching.ts`;
  - the strict import decode in `commands/Lists.ts`, with both CLI tests;
  - `Encoding` base64url in main's `consent/Unsubscribe.ts`, whose tokens now sign through `SignedToken`. Both golden-token tests pass;
  - `unusedCampaigns`, gaining main's `updateDraft`/`deleteDraft`;
  - `allTableOperations`, which the campaign store shares while main's `CampaignReaderLive` binds `GetItem` alone;
  - the `membershipVersion` removal, including main's new test fakes;
  - the restore-before-wait order around main's poller canary.
- **Superseded by main:**
  - **T2.2:** reverted. Test sends go out from the API, so the API again carries the unsubscribe URL and secret, plus the preview pair. ADR-0004's minting line now names the mailer.
  - **T2.4:** main's `CampaignWakeLive` layer replaces `campaignWake(sendMessage)`.
  - **Poller probe:** both branches fixed the stale-wake hold. Main's canary stays: a 25-second window that also requires no in-flight receive. This plan's 20-second probe is dropped.
- **Descoped, pending approval — T3.3:** main mints the link inside `Mailer.send`, after the claim. The link settings are env the function's props pin. Alchemy captures a constructor `Config` read on the deploy machine at plan time, so the Mailer cannot read them once at construction ([wiki](../../wiki/alchemy/runtime-and-bindings.md)). Keeping the old order would mean changing the Mailer's contract or reading the config twice. The read can only fail on a deploy missing its own env; every send then fails identically and the live suite catches it at the first send. The ordering test is removed, and `makeSend`'s comment now gives the real reason for the per-send read.
- **Found by the new checks in main's code:** seven exports used only in their own module (knip), and three stale lint suppressions.
- **Merge drop check:** the merged tree was compared with `origin/main` and with `public`, line by line. One line of main's was silently lost: the `addressStatus` override in `Api.test.ts`'s fake, next to a removed `membershipVersion` line. It is restored.
- **Checks:** `pnpm check` is green with 871 unit tests.

## Handoff

- **Next action:** the user reviews the PR and decides on the T3.2 and T3.3 deviations. Follow-ups:
  - prod runs the old code until it is redeployed with `--force` (then check `CodeSha256`);
  - add the `EmailerApi` `HttpApi.ParseOptions` annotation on the Effect RC containing effect#8423;
  - upgrade oxlint when `@effect/tsgo` supports a version newer than 1.82.
- **Reviews:**
  - **Checkpoint A** (fresh reviewer, commits `c72055b..0f35cd5`, git objects only): no regressions. Dispositions:
    - **L1:** the probe inside acquire could leave the mapping disabled. Fixed now: the waits moved after `acquireRelease`.
    - **L2:** ADR-0008 said "Table.ts owns only the resource". Fixed now with an Amended line.
    - **L3:** ADR number collision with the main checkout's untracked 0019/0020 proposals. Fixed now: this branch's ADRs renumbered to 0021+.
  - **Final plan-backed review** (fresh reviewer, `c72055b..eaad137`): **Clear**, no findings admitted.
    - Compliance: every item done, except T3.2 (partial, blocked upstream, recorded honestly) and T5.2 (deviation recorded above).
    - Notes applied: an ADR-0011 amendment for the -1 quota, the README noting that `.env.test` needs the deploy keys, and corrected T5.2 wording.
    - Notes kept as they are:
      - the typed `committed` check on unconditional cascade transactions stays, because it keeps the code correct if a condition is ever added;
      - `Flag.File` plus read stays, because `Flag.FileText` would put the file's content, not its path, in the error.
- **Deviations:**
  - **T5.2, resume coverage:** removing the duplicated resume case leaves the resume route and paused-campaign encoding reached over HTTP only by the live suite (`Api.integration.test.ts` alarm pause, and `CampaignCancellation.integration.test.ts`). The handler is a one-line typed call. Accepted as the plan's "trim to what only the HTTP layer can break"; the final review found no material impact.
  - **Plan numbering:** the 37-item plan maps to 36 subtasks. Item 30 (the strict-contract ADR) is part of T3.2.
  - **T1, index slip:** the worker briefly staged and unstaged the `apps/mcp` deletion. The index was back at HEAD before the commit; nothing was lost.
  - **T0, live test fixes:** two integration-test fixes (the alarm-pause assertion, and the probe-based mapping hold). Both correct test races observed live and change no product code.
- **Resources:**
  - the worktree and branch above;
  - the ephemeral stage `Emailer/test-cleanup` (us-east-1): deployed for T0, redeployed for T4, destroyed after the final gate, with teardown verified against the AWS inventory;
  - an untracked `.env.test` in the worktree, pointed at that stage; it is removed with the worktree.
