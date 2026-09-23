# Plan review: Drafting, previews and test sends

> **Reviewer:** independent adversarial plan review, 2026-09-23.
> **Targets:** [the plan](drafting-and-preview.md), [ADR-0019](../0019-markdown-campaign-bodies.md) and [ADR-0020](../0020-drafts-previews-and-test-sends.md). All three were read in full and none was edited.
> **Evidence sources:** the repo at `public`, and the installed sources of `alchemy@2.0.0-beta.77` and `effect@4.0.0-rc.112`, cited below as `alchemy/…` and `effect/…`.
> **What was not done:** no deploys, no AWS or Cloudflare calls, no `.env` reads.
> **File names:** unqualified names are under `apps/backend/src/` in today's layout, before T1 moves anything. `Storage/…` names refer to today's capitalised folder.

## Verdict

**Changes requested.** There is one major finding (R1) and ten minor ones (R2–R11).

The hard constraints hold:
- Nothing in T1, T5 or T14 plans a replacement.
- No Function URL changes.
- The unsubscribe token format and `Random("UnsubscribeSecret")` stay intact (see Q1 and Q7).

## Findings

### R1: T7 lands the contract six tasks before its handlers (major)

**Evidence**
- **The plan accepts the gap.** At plan:314 it says: "expect errors only at the backend and CLI handlers that T8–T13 fill in". The `preview` handler arrives only in T14 (plan:461-490).
- **T7's dependency allows early execution.** T7 depends only on T1 (plan:308), but T5 verifies with `pnpm check` (plan:258).
- **Handlers break at compile time.** Two places must cover every endpoint:
  - `handleAll` in the API (`apps/backend/src/Api.ts:69-79`);
  - the CLI harness's in-memory service (`apps/cli/src/Commands.test.ts`).

  Removing `CampaignCancellationConflict` also breaks `Campaigns.ts` until T8.
- **The interim verify steps cannot see type errors.** T8–T13 verify with `pnpm test` only (plan:324, 354, 389, 419, 428, 459).
  - `test` is `vitest run`, which strips types (`package.json:15`).
  - `lint` is type-aware with `--type-check` (`package.json:12`), so it is red too.

**Consequence**
- From T7 until T14, `pnpm typecheck` and `pnpm lint` are red for reasons outside the current task.
- Type and lint regressions introduced in T8–T13 are therefore invisible, because those tasks' verify steps are green anyway.
- T14 inherits the accumulated pile, and the intermediate commits do not compile.
- If T7 runs before T5, which the declared dependencies allow, T5's `pnpm check` fails.

**Correction.** Drop T7 as a standalone task and land each contract change with the task that implements it:

| Contract change | Lands with |
|---|---|
| The error rename (contract, backend, CLI and tests) | T8 |
| `PATCH` and `DELETE` | T9 |
| `test` | T10 |
| `preview` | T14 |

- Each task also adds the matching handler to the CLI harness's in-memory service.
- Each task then ends with `pnpm check` green.
- T13 keeps only the CLI commands.

### R2: the `Effect.context` capture is not equivalent to today's `Layer.build`, because it carries the init Scope into every request (minor)

**Evidence**
1. **The capture takes the whole context.** `Effect.context()` returns the whole fiber context (`effect/internal/effect.ts:2153`).
2. **The captured values win.** `provideContext` is `updateContext(self, Context.merge(context))` (`effect/internal/effect.ts:2197`), and in `Context.merge` the second argument's services override the first's (`effect/Context.ts:1755`).
3. **The constructor's context holds an instance Scope at cold start.**
   - The constructor runs as `Layer.effect(tag, entrypoint)` (`alchemy/Runtime.ts:36`).
   - `Layer.effect` runs its effect under `Scope.provide(effect, scope)` (`effect/Layer.ts:1481`).
   - The bootstrap also applies `Scope.provide(instanceScope)` (`alchemy/Runtime/Bootstrap/Lambda.ts:82`).
4. **The request scope sits outside the handler.** Each invocation's request scope is `Layer.succeed(Scope.Scope, scope)` (`alchemy/AWS/Lambda/Function.ts:1063`), provided *outside* `fetch` and the event listeners.
5. **Today's capture excludes Scope.** Today's API captures the output of `Layer.build(...)` (`Api.ts:198-224`). That output holds only the built services plus `CurrentMemoMap` (`effect/Layer.ts:762`).

**Consequence**
- **Finalizers leak to shutdown.** Inside `handle`, and inside the Dispatcher's and Feedback's callbacks, `Scope.Scope` would resolve to the instance-lifetime scope. Any finalizer registered there would run only at SIGTERM and accumulate across warm invocations (a future `acquireRelease`, for example).
- **The risk is latent today.** No current code path registers such a finalizer.
- **Two things give it weight:**
  - The existing "request scope" test (`Api.test.ts:1093-1119`) registers its finalizer outside `handle` (line 1101 versus 1107), so it cannot catch this.
  - T15 writes the pattern into `wiki/alchemy/runtime-and-bindings.md` (plan:517), which would spread it.

**Correction**
- **Constructor:** `const services = yield* Layer.build(<Function>Live)`. This is today's API shape without the `Layer.succeed` re-wrap, and it builds the Live Layer in the instance scope rather than in a transient `Effect.provide` scope.
- **Handler:** `Effect.provideContext(handle, services)`.
- **Tests:** `builtHandler` mirrors the constructor.
- **Wiki:** the T15 note documents this shape.
- **If `Effect.context` stays:** apply `Context.omit(Scope.Scope)` before providing.

### R3: the test-send budget has no stated anchor (minor)

**Evidence**
- **The plan leaves the start point open.** Plan:64 and plan:366 speak of "the time left in the 45 s budget" but never say when the budget starts.
- **Work happens before the loop.**
  - `Campaigns.get` makes two reads.
  - The list read and the member page follow.
  - `SendGuard.current` calls `GetAccount` and `DescribeAlarms`, neither of which has a timeout (`SendGuard.ts:47`).
- **The numbers involved:**
  - `reservationFor` is the limiter delay plus 8 s plus 2 × 5 s (`Dispatching.ts:59`, `Mailer.ts:18`);
  - the API timeout is 60 s (`Api.ts:34`);
  - the CLI's request timeout is 70 s (`Commands.ts:24`).

**Consequence**
- If the 45 s clock starts after the pre-loop reads, a slow guard or storage read pushes the invocation past 60 s, and Lambda times out.
- The operator then gets no per-recipient result, even for messages that were sent.

**Correction**
- Take the deadline once, at handler entry: `now + 45 s`. The dispatcher already does this with `now + invocationTimeout` (`Dispatcher.ts:96`).
- The worst case is then about 45 s plus the response, inside both 60 s and 70 s.
- Neither the cap nor the reservation needs to change (see Q6).

### R4: "more than 20" must be read from `nextCursor`, not from the item count (minor)

**Evidence**
- The plan counts at plan:361 and plan:443.
- `listMembers` queries with `Limit: limit` (`Storage/Membership.ts:220`). It then hydrates the page through BatchGet (`:241`), which drops any membership whose contact item is gone.
- `nextCursor` comes from `LastEvaluatedKey` (`:252`), which `Storage/Primitives.ts:83` describes as independent of the page's length.

**Consequence**
- Suppose orphaned memberships sit among the first 21 entries. Then `items.length ≤ 20` even though more members exist.
- The server would silently send the test to a subset, and the CLI's prompt would show the wrong N.
- This is rare, but the check *is* the cap.

**Correction**
- The server and the CLI both refuse when `nextCursor !== undefined || items.length > 20`.
- This is exact: a query on the key alone with `Limit: 21` returns a `LastEvaluatedKey` exactly when 21 entries were read.

### R5: in `test --list`, the prompt and the POST must not share one `withClient` (minor)

**Evidence**
- `withClient` wraps the whole `use` callback in `Effect.timeout(requestTimeout)`, which is 70 s (`apps/cli/src/Commands.ts:33-40`).
- T13 chains three GETs, a prompt and the POST (plan:441-444).
- The timeout's own comment says it exists to outlast the API's 60 s (`Commands.ts:19-23`).

**Consequence**
- If a single `withClient` wraps the whole flow, the operator's think time and the three GETs use up part of the POST's 70 s.
- The CLI could then abandon a test send that the API completes. That is exactly the "outcome unknown to the operator" case the timeout exists to prevent.

**Correction.** State the split in T13:
- the three pre-reads run in one `withClient`;
- the confirmation runs outside any `withClient`;
- the POST runs in its own `withClient`.

### R6: the draft transaction shapes are proven only against a table double that does not validate expressions (minor)

**Evidence**
- **The shapes.** T9 uses an Update or a ConditionCheck on META, with `SET` or `REMOVE #filter` (plan:332-336).
- **The proof.** The unit tests use a scripted table (plan:351), and the integration test makes one round trip (plan:522).
- **The wiki's warning.** A table double will not catch expression errors (`wiki/effect/retries-and-concurrency.md:54`).
- **A reserved word is involved.** `filter` is reserved (`Storage/Campaigns.ts:289`).
- **One case is undefined.** Under the absent/null convention, the empty payload `{}` is valid (`UpdateContactPayload`, `packages/api/src/Schemas.ts:339`). The plan does not say what `updateDraft` does when neither the META fields nor the body change.

**Consequence**
- DynamoDB rejects two kinds of request with a `ValidationException`:
  - unused `ExpressionAttributeNames` or values, such as `#filter` carried into the body-only ConditionCheck;
  - an empty `UpdateExpression`.
- Both would surface as a 503 `StorageUnavailable` while the unit tests stay green.

**Correction**
- **Specify `{}`:** the CLI refuses `update` with no flags, and the server treats `{}` as the draft check followed by `get`, with no transaction.
- **Broaden the integration round trip in T15** to cover three variants:
  - body only;
  - META only, with `filter: null`;
  - both.

### R7: the `verifyToken` signature drops the length-bound step and leaves the character set open (minor)

**Evidence**
- **The order today:**
  1. the length bound (`Unsubscribe.ts:73`);
  2. the structure check `^v1\.([A-Za-z0-9_-]+)\.([0-9a-f]{64})$` (`:41`);
  3. the HMAC comparison (`:87`);
  4. the payload decode (`:91`).
- **The plan is inconsistent about the bound:**
  - it defines `verifyToken(key, token, fieldCount)` (plan:178);
  - it says the bound stays in `Unsubscribe.ts` (plan:180);
  - yet `SignedToken.test` tests "the bound" (plan:185).

**Consequence**
- The implementer has to choose where the bound lives.
- If the bound is checked after `verifyToken`, the documented order changes: HMAC work would run before the cheap checks.
- A wider field character set than base64url would widen what reaches the HMAC.
- Outcomes for real links do not change, because the golden vector and the round-trip test pin mint and verify. That keeps this minor.

**Correction**
- **Signature:** `verifyToken(key, token, { fields, maxLength })`.
- **Order inside it:**
  1. the length check;
  2. the structure check `^v1(\.[A-Za-z0-9_-]+){fields}\.[0-9a-f]{64}$`;
  3. the constant-time comparison;
  4. return the fields.
- **Callers:**
  - Unsubscribe passes `(1, 407)`;
  - Preview passes `(2, 115)`, then checks the UUID, the integer and the expiry.

### R8: two verify claims do not prove what they say (minor)

**Evidence**
- **(a) `check:imports` never touches marked.** T11 says "`pnpm check:imports`; expect success" (plan:419). The script imports only `alchemy`, `alchemy/AWS`, `alchemy/Cloudflare` and `NodeRuntime` (`package.json:18`). It never imports `marked` or the CLI.
- **(b) A plan cannot prove constructor wiring.** T5 says the constructor wiring "is proven by the prod plan (T16)" (plan:256).
  - A plan never runs the cold-start constructor.
  - The wiki records a class of failure that appears only at cold start, after a clean plan and deploy (`wiki/alchemy/runtime-and-bindings.md:21`).
  - So the first runtime proof of T1 and T5 is T15, ten tasks later.

**Consequence**
- (a) gives false comfort.
- (b) lets a wiring regression from the refactor surface in the middle of the feature gate, where it is hard to bisect across T6–T14.

**Correction**
- (a) Drop the `check:imports` claim. The spawned-CLI test in T11 (plan:418) is the real proof that `marked` loads.
- (b) After T5, deploy `--stage test`, run the existing `pnpm test:integration`, then destroy the stage. This uses the same procedure as T15 and needs no new tests.

### R9: the leak check is undefined and runs before the evidence it has to cover (minor)

**Evidence**
- **T15 names no command.** The check appears only in T15's verify list (plan:546).
- **Later tasks create more evidence:**
  - the ADR Confirmation is filled "after the gate" (plan:519);
  - T16 then "records" the prod plans (plan:551).
- **Final acceptance omits it** (plan:561-567).
- **A precedent exists.** The previous plan defines the form, including untracked files (`sending-dns.md:262-267, 297`).

**Consequence.** Gate and prod-plan evidence can reach the public branch unchecked. That evidence can include function URLs, account identifiers, and the operator mailbox or domain from G2.

**Correction**
- Name the command, reusing the `sending-dns.md` form.
- Run it as the last step before every commit that carries evidence, including after T16.
- Add it to Final acceptance.

### R10: `Reputation.ts` under `feedback/` creates a sending↔feedback folder cycle (minor)

**Evidence**
- **The plan's placement.** Plan:83 puts `Reputation.ts` in `feedback/`. `SendGuardLive`, in `sending/`, yields `reputationAlarms` (plan:222).
- **The cycle.** `Reputation.ts` imports `configurationSet` from `Mailer.ts` (`Reputation.ts:4`).
- **The Feedback function doesn't need it.** It imports only `configurationSet` (`Feedback.ts:9`).
- **The real consumers** are `alchemy.run.ts` and the send guard.

**Consequence.** `sending/SendGuard` → `feedback/Reputation` → `sending/Mailer`, so the concern layout reads backwards.

**Correction**
- Place `Reputation.ts` in `sending/`.
- Optionally, apply the same reasoning to `SignedToken.ts`. It is used by `api/Auth` and `campaigns/Previews`, so the root beside `Identifiers.ts` fits it better than `consent/`.

### R11: two ADR statements are inaccurate (minor)

**Evidence**
- **The capability count.**
  - ADR-0020:18 and plan:8 and plan:331 call `CampaignReader` "a fifth capability".
  - ADR-0011:53 already added a capability for the limiter (`RateLimitStoreLive`, `Storage/RateLimit.ts:137-143`).
  - So `CampaignReader` is the sixth.
- **The revocation lever.** ADR-0020:65 offers "destroying the stage" as the way to revoke preview links, but prod is never destroyed.

**Correction**
- Say "a sixth capability".
- Add: "on a live stage, replacing the `PreviewSecret` Random revokes every preview link without touching `UnsubscribeSecret`."

## Answers by question

### Q1. Moving files in T1

**No finding.** Replacements and URL changes are both ruled out:

- **The diff has only three replace triggers** (`alchemy/AWS/Lambda/Function.ts:2034-2073`):
  - a changed `functionName` (`:2054`);
  - a switch between image and zip packaging (`:2058`);
  - a flip of `durableConfig` (`:2071`).
- **A moved `main` is an update, not a replacement.** It changes the bundle hash, and a changed hash is an update (`:2095`). A changed prop is also an update.
- **Function URLs survive updates.** A Function URL is create-or-update (`:1916-1949`), so an existing URL is kept.
- **Role names are unaffected.** They derive from the logical ID (`:1135`).
- **Log groups and `Random` resources are unaffected.** Their fully qualified name is the logical ID (`alchemy/Resource.ts:359-360`), and Functions never push a namespace.
- **The moved modules keep working at runtime.** The generated entry imports the `default` export of `main` (`alchemy/AWS/Lambda/FunctionBundle.ts:187-189`), which every moved function module keeps.
- **The bare tag keeps its key.** The `UnsubscribeFunction` bare tag is keyed `"Unsubscribe"`, and moving it changes nothing.

**One caution for T5:** `main: import.meta.url` must stay in each function module. It must never move into `lambdaBasics` (plan:241-244): if it did, every function's entry would become `Lambda.ts`, which has no default export.

### Q2. The `Effect.context` capture in T5

- **Equivalence:** see R2. The capture is not equivalent. The key collision that matters today is `Scope`; the per-invocation telemetry services would collide as well if telemetry were ever enabled.
- **The callbacks:** nothing else breaks for either callback.
  - `Crypto` must be in the Live Layer's output (`provideMerge(NodeCrypto.layer)`), because today it is only fed in through `Layer.provide`. The type checker enforces this.
- **Config reads:**
  - `MailerLive` (`Mailer.ts:78`) and `SendGuardLive` read Config at construction. That is a deploy-time capture, so the API's environment gains the sender, the postal address and the ceiling (ADR-0020:63). This is correct.
  - No Live Layer reads `AWSEnvironment`. `feedbackPublishing`, the only one that does, stays in the Stack.
- **Keep `unsubscribeLink`'s Config read inside `Mailer.send`.** If it were hoisted into `MailerLive`, the plan would fail, because the URL and secret are pinned values that don't exist on the deploy machine (`wiki/alchemy/runtime-and-bindings.md:23-25, 54`).

### Q3. The API constructor after T10

**No finding.**
- **No module cycle:**
  - `SendGuard` → `Reputation` → `Mailer` → {`Unsubscribe`, `Message`, `SendingIdentity`};
  - none of these imports back.
  - The folder-level back-edge is covered in R10.
- **Env:**
  - the unsubscribe URL and secret are already pinned (`Api.ts:134-135`);
  - Config capture adds the sender, the postal address and the ceiling;
  - T14 adds the preview URL and secret.
- **IAM:** there is no surprise. The limiter's `UpdateItem` (`Storage/RateLimit.ts:141`) is already on the API through the audience and campaign stores.

### Q4. The bare-tag Preview function in T14

**No finding.**
- **Providing the Layer:**
  - today: `Effect.provide(UnsubscribePage)` (`alchemy.run.ts:108`);
  - with Preview: `Effect.provide(Layer.mergeAll(UnsubscribePage, PreviewPage))` works the same way.
- **`senderSettings`:**
  - The page needs it for From and for the postal footer.
  - Capturing it at deploy time is correct, and matches the Dispatcher.
  - The secret must be read per request, as the plan already states for `previewLink`.
- **Reserved concurrency of 2 is plausible:**
  - the Unsubscribe function already reserves 10 per stage;
  - adding 2 per stage leaves the account's required 100 unreserved executions untouched in practice.

### Q5. Storage design in T9

- **One transaction may touch both items.** META and BODY are distinct items (`Storage/Items.ts:26-34`).
- **META is touched once per transaction.** Update takes an Update or a ConditionCheck, never both; delete takes one Delete.
- **Conflicts resolve through the condition index.** `runTransaction` reports `ConditionalCheckFailed` indices (`Storage/Primitives.ts:421-438`), with META at index 0.
- **A concurrent `send`:**
  1. the META condition fails;
  2. the whole transaction is cancelled, so no BODY Put lands;
  3. the handler re-reads the campaign;
  4. it answers 409 with the state `queued`.
- **Delete racing `send` or `schedule`:** symmetric. Their conditions fail on a missing META, and the re-read answers 404.
- **The `#filter` alias** is correct.
- **Remaining gap:** R6.

### Q6. Test sends in T10

- **The 45 s budget is coherent once it is anchored** (R3). The last admission comes at about 27 s, since each attempt reserves the limiter delay plus 18 s.
- **The cap of 20 is justified.**
  - It matches `maxImportEntries` (`packages/api/src/Schemas.ts:21`).
  - At the 1/s floor (`SendGuard.ts:61`), the 20th recipient starts about 20 s in.
  - That holds only while no running campaign shares the `ses-send` key. If one does, the tail is reported `not-attempted`, as the design intends.
- **`listMembers` with a limit of 21:** see R4.

### Q7. Signed tokens in T2

- **Unsubscribe tokens:** the format is preserved. The golden vector plus the existing round-trip test pin both mint and verify. The verify order needs R7.
- **Preview token length:** 115 characters is right: 2 + 1 + 36 + 1 + 10 + 1 + 64.
  - IDs are UUID v4, and epoch seconds stay at 10 digits until 2286.
  - 115 exceeds the router's default parameter cap of 100, so the plan raises it.
- **Expiry order:** the expiry is checked after the signature (plan:468).

### Q8. CLI stdin and prompt in T6 and T13

**No finding.**
- **The ended-stdin default is safe.** Today's default stdin is a pipe that never ends (`apps/cli/src/Commands.test.ts:459`). No command reads stdin, so an ended default changes nothing for existing tests, and it prevents prompt hangs.
- **The stderr wrapper is sound.**
  - `Terminal.make` accepts any implementation (`effect/Terminal.ts:186`).
  - The CLI framework uses `Terminal` only for prompts and its interactive wizard; help goes through `Console`, so only prompts move to stderr.
- **stdout carries only results.** Nothing in the plan writes other output there, and the browser opener's stdio is ignored.

### Q9. Sequencing and coverage

- **Sequencing:** R1.
- **Verify commands:** R8.
- **Leak check:** R9.
- **No missing tasks otherwise:**
  - `.env.example` and `.env.test` need no new keys. The preview secret is a Random, the URLs are outputs, and the integration suite mints links through the API.
  - `apps/mcp` has an empty `src`, so no contract consumer needs updating.
- **Oxlint:**
  - new `node:crypto` use needs the same `effecttsgo/node-builtin-import` suppression that `Unsubscribe.ts` has;
  - no anti-slop rule conflicts with the planned names, since none imports a project-local `make*`.

### Q10. Accuracy

- **Inaccurate:** see R11.
- **Checked and correct:**
  - the 39 s backoff arithmetic: 1 + 2 + 4 s, plus 4 × 8 s (`Dispatching.ts:53`, `Mailer.ts:18`);
  - the API's 60 s budget;
  - "no resource identity" changes from the move;
  - the quotes superseded from ADR-0011 and ADR-0014, which are verbatim;
  - the Effect source citations spot-checked in the plan (`Terminal.ts:186`, `Flag.between`, `NodeChildProcessSpawner` `unref` handling).

## Verdict

**Changes requested.** R1 is major; R2–R11 are minor.

---

# Round 2: re-review of the revised plan and ADR-0020

> **Targets re-read in full:**
> - the revised plan (624 lines);
> - the revised ADR-0020;
> - [the decomplex review](drafting-and-preview-decomplex.md), for context.
>
> **Line numbers:** ADR-0019 is unchanged. `plan:` line numbers below refer to the revised plan.
> **Permissions:** unchanged. This section is the only edit.

## Status of the round-1 findings

| Finding | Status | Reason |
|---|---|---|
| R1 | **Resolved** | Contract changes now arrive with their feature tasks (T7 plan:313-317, T9 plan:360-362, T10 plan:403-408, T11 plan:457). Each task also adds the matching handler to the CLI harness, and each verifies with `pnpm check`. T6 merges before T7 (plan:305). |
| R2 | **Resolved** | Each function now uses `Layer.build(<Fn>Live)` and serves under `provideContext` (plan:117, 270-273). `builtHandler` mirrors the constructor (plan:278), and the wiki note documents the pattern (plan:519). ADR-0020:49 records it. |
| R3 | **Moot (accepted)** | The budget is removed (plan:59, 166-167). A timeout without per-recipient outcomes is now a written consequence (ADR-0020:69), which is acceptable under the no-edge-case rule. See "Removed budget" below. |
| R4 | **Resolved** | `nextCursor` decides the cap on both the server and the CLI (plan:411, 428), with a test for an orphaned member (plan:439). |
| R5 | **Resolved** | The pre-reads, the prompt and the POST each run separately (plan:428-429). |
| R6 | **Resolved** | The one fixed shape always sets `subject` and `listId`, so an empty expression can no longer occur, and `{}` simply rewrites the same values. The integration suite covers both expression shapes (plan:525). |
| R7 | **Resolved** | `verifyToken(key, token, { fields, maxLength })` checks in the order length, structure, HMAC, fields (plan:116, 196). Unsubscribe passes `{ fields: 1, maxLength: 407 }` (plan:199). The tests cover over-length input and characters outside the set (plan:206). |
| R8 | **Resolved** | The `check:imports` claim is gone; T8 relies on the spawned CLI instead (plan:354). T5 adds a test-stage deploy, the integration suite and a destroy (plan:285-291). |
| R9 | **Resolved,** with a leftover issue (N1) | The command is defined, and it runs at T1, T5, T12, T13 and in Final acceptance (plan:566-575, 561, 584). |
| R10 | **Resolved** | `Reputation.ts` is in `sending/`, and `SignedToken.ts` is at the root (plan:88, 97, 105-108, 174). |
| R11 | **Resolved** | "Sixth capability" (ADR-0020:18, plan:14), and revocation by replacing `PreviewSecret` (ADR-0020:67). |

## Checks on the revision

### Sequencing across T1–T13, including T6 in parallel

**No finding.**

- **The dependency graph:**

  | Task | Depends on |
  |---|---|
  | T2 | T1 |
  | T3 | T2 |
  | T4 | T1 |
  | T5 | T3, T4 |
  | T6 | nothing; runs in its own worktree after T1 and merges before T7 |
  | T7 | T5, T6 |
  | T8 | T6 |
  | T9 | T7, T8 |
  | T10 | T3, T4, T5, T7 |
  | T11 | T2, T3, T5, T9, T10 |
  | T12 | T1–T11 |
  | T13 | T12 |

- **Every task boundary compiles.** Each feature task adds its endpoint together with the backend handler and the harness handler, so every `handleAll` compiles at every boundary.
- **The T6 merge cannot conflict.** T6 touches only `apps/cli`, and T2–T5 touch only the backend. T7's `pnpm check` is the first run on the merged state, which is enough.
- **One practical note:** T9 and T10 both edit `commands/Campaigns.ts`, the harness and the contract. Run them one after the other, in either order the graph allows, not in parallel worktrees.

### Removed budget

**No finding.**
- **No retries on either side.** A Function URL invocation is synchronous, so Lambda doesn't retry it after a timeout, and the API client has no retry either (`packages/api/src/Client.ts`).
- **Nothing is left half-written.** Test sends write no rows. The only side effects besides the mail itself are the consumed limiter slots.
- **The cost of the pathological case** is the lost per-recipient report, plus possibly a duplicate test mail when the operator re-runs. ADR-0020:69 states exactly that.

### The untagged-feedback info log

**No finding.**
- **Other configuration sets are still dropped** (`Feedback.ts:138`).
- **Test mail still reaches the handler.** The `SendEmail` binding still injects the configuration set, so untagged test mail passes that filter.
- **`MailerLive` is still the only sender.**
- **Two tests must change.**
  - The existing unit test pins the level `Warn` (`Feedback.test.ts:443-444`), and the plan retargets it (plan:445).
  - The delivery-delay test (`Feedback.test.ts:555`) asserts that the old message `"feedback event without a campaign tag"` is logged zero times. It must also be retargeted to the new message name. Otherwise, after the rename it passes no matter what the code logs, and silently stops checking anything.
- **The remaining guard against mistagging:** a campaign send that loses its tags would now log only at info level. T3's exact SES-request tests keep the campaign tags pinned, so they are the guard against that regression.

### The fixed update transaction

**No finding.** Both shapes are valid `TransactWriteItems`.

- **META Update.** The expression is one of two shapes, each conditioned on `#state = :draft`:
  - `SET subject = :subject, listId = :listId, #filter = :filter`;
  - `SET subject = :subject, listId = :listId REMOVE #filter`.

  Why this is valid:
  - each shape uses every name and value it declares;
  - `REMOVE` on an absent attribute is allowed;
  - `filter` and `state` are aliased;
  - `subject` and `listId` are not reserved words.
- **BODY Put.** It is a different item from META (`Storage/Items.ts:26-34`), so the one-operation-per-item rule holds.
  - A Put replaces the whole item, so a removed `html` disappears as intended.
  - It must still write `v`, because the body decoder requires it. The integration round trip reads the body back, so a missing `v` would be caught.
- **Conflicts.** A failed condition cancels both writes, and `runTransaction` maps it to a conflict (`Storage/Primitives.ts:421-438`).

### The leftover schedule on delete

**No finding: the stale-wake claim is true.**

1. `beginRun` is a conditional `UpdateItem` with the condition `runToken = :run AND #state IN (:queued, :sending, :scheduled)` (`Storage/Campaigns.ts:504`).
2. On a deleted META the condition is false. DynamoDB raises `ConditionalCheckFailedException` and writes nothing; a failed conditional update never creates the item.
3. `updateIf` maps the exception to `applied: false` (`Storage/Primitives.ts:170-176`), and `beginRun` returns `stale` (`Storage/Campaigns.ts:516`).
4. `runSlice` logs "stale wake discarded" and returns (`Dispatching.ts:98-99`), so the SQS message is acknowledged.
5. The schedule was created with `ActionAfterCompletion: "DELETE"` (`CampaignSchedule.ts:27`), so it deletes itself after it fires.

### `Layer.build` inside the constructor

**No finding.**
- **Behaviour matches today.** `Layer.build` runs the Live Layers' bindings in the constructor fiber, so IAM registration and deploy-time Config capture work exactly as they do now. Today's API already calls `Layer.build` in its constructor (`Api.ts:198`).
- **It improves lifetimes.** The Live Layers now live on the instance scope.
- **One note, which the type checker enforces anyway:** the event-source Layers and the constructor-only bindings must stay provided to the constructor itself, not only inside `services`, because the consumers are yielded in the constructor:
  - `consumeQueueMessages` in `Dispatcher.ts:90`, with `QueueEventSource` provided at `:109`;
  - the failure-queue binding and `consumeEmailEvents` in `Feedback.ts:200-204`, with `EventSource` and `SendMessageHttp` provided at `:219`.

## New findings

### N1: the leak-check command can pass while checking nothing (minor)

**Evidence** (plan:570-575)
- **The pattern file may be missing or empty.** It lives in "this session's" scratchpad, which is tied to one session, so the implementation session may not have it. `grep -f` with an empty file matches nothing, which prints nothing, which reads as a pass.
- **Deleted paths are no longer excluded.** The previous plan excluded them with `--diff-filter=d` (`sending-dns.md:163`), and this one does not. T6's split deletes `Commands.ts` and `Commands.test.ts`, and grep errors on those paths.

**Consequence**
- An empty pattern file, or one only partly recreated, gives a false green on the public branch.
- A missing file or a deleted path produces stderr noise that can be misread.

**Correction**
- Keep the pattern at a durable path outside the repository.
- Fail when the file is missing or empty (`test -s "$LEAK_PATTERN"`).
- Restore `--diff-filter=d` on the first `git diff`.

### N2: ADR-0019 names a file that no longer exists (minor)

**Evidence.** ADR-0019:46 says "Changing it means changing `EmailLayout.ts`". DEX-006 collapsed that file into `apps/cli/src/Markdown.ts` (plan:100, 330-331).

**Correction.** Change the sentence to "changing the layout section of `apps/cli/src/Markdown.ts`".

## Round 2 verdict

**Clear.**
- All eleven round-1 findings are resolved, or moot with the consequence documented.
- The revision adds no material problem, and the hard constraints still hold.
- N1 and N2 are minor, non-blocking fixes to make in passing, as is the `Feedback.test.ts:555` retarget noted above.
