# Independent plan review — sending identity

> **Reviewed:** [sending identity plan](sending-identity.md), [ADR-0009](../0009-account-level-sending-identity.md) (Proposed), [research](shared-sender-identity-research.md) F1–F16
> **Against:** `alchemy@2.0.0-beta.77` installed source, the repository at `1bcfe82`, the project wiki, and read-only AWS/DNS lookups (profile `deploy`, `us-east-1`)
> **Date:** 2026-09-14

**Verdict: not ready as written, but the design survives.** One defect blocks the plan. T2's "take the domain from the reference" cannot work during construction. Yielding a reference attribute inside a Lambda's outer constructor returns an accessor, and that accessor yields `undefined` at plan time. I confirmed this from source and with a local probe. It is not a Lambda-runtime unknown that T4 has to discover. It follows from the same Alchemy mechanism the project wiki already documents. As written, the first command of T4 dies in `mailerAddresses` before anything about the reference is learned. T4's broad fallback trigger could then send the implementer into an unnecessary architecture reversal. The fix is a deletion: keep `EMAILER_SENDER_IDENTITY` in the Emailer, which is already T2's own fallback, or replace both sides' reads with one constant.

The reference-in-binding path itself is sound by source analysis. The identity ARN resolves from state at plan time, and the binding's own `FromIdentity` is read lazily at invocation, so F9 holds for the binding. The rest checked out:

- The retention and fallback mechanics.
- Import structure.
- State-store and Region alignment.
- The DNS scope.
- Every file:line citation in the plan.

The remaining findings are verification commands that cannot detect what they claim to, a mis-targeted ADR-0001 supersession, and small scope and test-shape issues. Nothing found puts the identity at risk of deletion or recreation under the plan's normal path.

## Confirmed defects

### R1 — High: T2 reads the identity's domain at construction, where a reference attribute is `undefined` during planning

**At fault:**

- The plan, `sending-identity.md:14` ("taking the identity's domain from it"), `:97` (`yield* identity.emailIdentity` passed into `mailerAddresses`), `:111` ("discovered in T4") and `:254` (the complexity gate claims a removed duplicate configuration source).
- ADR-0009 Decision, bullet 3 (`0009-account-level-sending-identity.md:27`).
- The research Recommendation, bullet 3 (`shared-sender-identity-research.md:305`).

**Evidence:**

- `yield*` on any Output attribute goes through `BaseExpr[Symbol.iterator]` → `asEffect()` → `bind()`. That runs `RuntimeContext.set(key, this)` and returns `ctx.get(key)`, an **Effect** (an `Accessor<A>`), not the value (`node_modules/alchemy/src/Output.ts:142-163`). This holds for references and for locally declared resources alike.
- The Lambda runtime context's `set` stores the Output into the function's `env` for deploy-time resolution. Its `get` reads `process.env[key]` (`node_modules/alchemy/src/AWS/Lambda/Function.ts:1003-1016`). Platform merges that `env` into the function's props (`Platform.ts:647`). Plan resolves a `RefExpr` in those props from state (`Plan.ts:958-978`). So at cold start the value is present, but during `alchemy plan` the key does not exist in the deploying process.
- The SES binding already relies on exactly this split. `const FromIdentity = yield* identity.emailIdentity` at construction (`AWS/SES/BindingHttp.ts:283`), and `yield* FromIdentity` only inside the per-request callable (`:330`).
- A local probe mirrored the Lambda context's `get`: `yield* (yield* AWS.SES.EmailIdentity.ref("EmailerSender", { stack: "EmailerSending", stage: "shared" })).emailIdentity`.
  - The first `yield*` returned an Effect.
  - The second returned `undefined`.
  - It registered the env key `ref_EmailerSender____stack__EmailerSending__stage__shared____emailIdentity`.
  - The ref's `LogicalId` came back as the string `"EmailerSender"`.
- The Config path works today for a different reason. Platform's `ConfigProvider` interceptor loads the value from the **deploy machine's** environment during plan and binds it into the function env (`Platform.ts:572-578`). At runtime it reads it back (`:579-590`).
- The wiki states the rule. The outer constructor "can only read configuration that exists where the deploy runs … Read such values inside the handler" (`wiki/alchemy/runtime-and-bindings.md:25`). The feedback function follows it: the configuration-set name is read inside the event callback, not the constructor (`apps/backend/src/Feedback.ts:236-240`).
- `mailerAddresses` validates at construction and dies on mismatch (`apps/backend/src/Mailer.ts:90-95`). It runs during planning because `MailerLive` is provided to `ApiFunction`'s init (`Api.ts:185`), and Platform evaluates that init at plan time.
- The Stack program also runs during `destroy` (`Destroy.ts` → `evalStack`, `Stack.ts:285`). The same construction failure would therefore block tearing a stage down, not only deploying it.

**Failure scenario:**

1. In T2, `mailerAddresses(identity: string)` rejects `Accessor<string>`.
2. The implementer adds a second `yield*`, which typechecks.
3. The unit tests pass, because they pass the identity as a literal, so T2's `pnpm check` goes green.
4. T4's first command, `alchemy plan --stage test`, then dies:
   - either `belongsToIdentity(sender, undefined)` → `Effect.die(SenderNotOnIdentity({ identity: undefined }))`;
   - or a `TypeError` on `.trim()` if normalization moves with the parameter.
5. T4's fallback trigger is "plan or deploy error" (`sending-identity.md:145`). That invites destroying `EmailerSending`, adopting the identity into the Emailer and deleting the new stack file, for a defect unrelated to references.

The identity itself survives that path (see "Checked and clear"). The cost is a needless reversal of ADR-0009 and a wrong conclusion in the T7 wiki entry about references in bindings.

**Smallest correction:**

- **Plan T2.** Replace the declaration with `yield* sendingIdentity` and leave `mailerAddresses` reading `EMAILER_SENDER_IDENTITY` unchanged. The T2 fallback becomes the design. Drop "the identity becomes a parameter" and the signature change in the tests.
- **`.env.example`.** Say that both stacks read the same key.
- **Plan `:14`, `:111` and `:254`.** Delete the corresponding claims.
- **ADR-0009 Decision bullet 3.** Reword to: "The Emailer keeps `EMAILER_SENDER_IDENTITY` for its construction-time From check; the reference supplies the binding's ARN."
- **Research Recommendation bullet 3.** Reword to match.
- **T4 fallback trigger.** Narrow it to `InvalidReferenceError` or an SES grant that does not name the `mail.example.com` ARNs.
- **T7.** The wiki note should say that reference attributes, like any Output, are accessors that are `undefined` during planning.

_Alternative, and arguably cleaner — the user's call._ Export `sendingDomain = "mail.example.com"` from `SendingIdentity.ts`. Use it both as the stack's `emailIdentity` prop and in `mailerAddresses`, and remove `EMAILER_SENDER_IDENTITY` everywhere. That keeps ADR-0009's one-source-of-truth claim true, without the construction-time read, and also closes R8.

### R2 — Medium: T5's grep check cannot detect most of the stale text it exists to catch

**At fault:** `sending-identity.md:196`, `grep -n "republish\|negative-cach\|dkim.amazonses.com\|leaving the DKIM" README.md`.

**Evidence:** Run against today's README, it matches only `:195` ("leaving the DKIM") and `:200` (`dkim.amazonses.com`).

- `republish` is case-sensitive, and the README says "**Republishing**" at `:193`.
- `negative-cach` appears nowhere; `:199` says "cached the negative answer".
- `:191` ("After the first deploy, read the identity's DKIM tokens"), `:193` ("mints fresh DKIM tokens"), the SOA trap at `:199` and the propagation-race routine at `:204-210` match no pattern at all.

**Failure scenario:** T5 rewrites `:195-202` only and leaves `:191`, `:193` and `:204-210`. The per-run DKIM routine and the disproven propagation-race advice survive, and the check passes.

**Smallest correction:** `grep -inE "republish|negative|86400|fresh DKIM|first deploy, read|INSYNC|dkim.amazonses.com|leaving the DKIM" README.md`, expecting no matches outside the new one-time section. Or check that the section heading and paragraphs at `:191-210` are gone.

### R3 — Low: T4's IAM check names a role that does not exist under that name

**At fault:** `sending-identity.md:166`, "`aws iam get-role-policy`/`list-role-policies` on `emailer-test-api`'s role".

**Evidence:** Alchemy names the role and the inline policy with `createPhysicalName(id)` (`AWS/Lambda/Function.ts:1135-1139`), so the name is stack/stage/ID-derived, not the function's explicit name. Binding statements are written with `iam.putRolePolicy` (`:1217-1219`), so they appear under `list-role-policies`, not attached managed policies. The plan's intent is right, but the command as worded fails on the first try.

**Smallest correction:** Prefix the check with `aws lambda get-function-configuration --function-name emailer-test-api --query Role --output text` and use the role name from that ARN.

### R4 — Low: the new `SenderNotOnIdentity` unit case is specified as a failure, but the code raises a defect

**At fault:** `sending-identity.md:104`, "a From address outside the identity makes `mailerAddresses` fail with `SenderNotOnIdentity`".

**Evidence:** `Mailer.ts:94` uses `Effect.die(new SenderNotOnIdentity(...))`. The existing `resolving` helper wraps with `Effect.result` (`Mailer.test.ts:358-362`), which captures typed failures only. A die escapes it and rejects `Effect.runPromise`.

**Failure scenario:** The implementer reuses `resolving` and asserts `Result.isFailure`. The test errors instead of asserting anything. It gets rewritten as "expect the promise to reject", which also passes for an unrelated `TypeError`.

**Smallest correction:**

- Specify `Effect.exit` and assert that the defect in the `Cause` is a `SenderNotOnIdentity`.
- Add the direction that matters for this migration to the `belongsToIdentity` table: `belongsToIdentity("emailer-test@example.com", "mail.example.com") === false`. That is the stale `.env.test` case T1 warns about. Today's table only has the reverse (`Mailer.test.ts:332-334`).

### R5 — Low: T1's "remove the include to prove it is load-bearing" check has no observable

**At fault:** `sending-identity.md:89`.

**Evidence:** `pnpm typecheck` is green both with and without the include, because a well-typed file produces no diagnostics either way. "Confirm the stack file is no longer checked" names nothing to look at. The include itself is correct and needed: nothing under `tsconfig.json:3`'s globs imports `stacks/`.

**Smallest correction:** `pnpm exec tsc --noEmit --listFilesOnly | grep stacks/sending-identity.ts`, which should list the file with the include. Or drop the ceremony and keep only the include.

### R6 — Low: ADR-0001 "Superseded in part" names the wrong clause

**At fault:**

- ADR-0009 `:6` ("ADR-0001's placement of the SES identity inside `Mailer.ts`").
- Plan T6 `:203`.

**Evidence:** Moving a shared resource into its own module is something ADR-0001 already permits: "A small separate resource module remains valid if a concrete shared ownership need arises" (`.adr/0001-resource-owning-effect-services.md:19`). ADR-0008 changed module structure more than this and recorded "preserves ADR-0001's resource-owning capabilities" rather than superseding it (`.adr/0008-storage-capabilities-and-error-boundaries.md:8`).

What this design does depart from is "Keep **one** root `alchemy.run.ts` for Stack name, AWS providers/state" (`0001:13`). The plan introduces a second Stack entry point.

**Smallest correction:**

- Retarget the supersession to `0001:13`: a second, one-shot stack owns account-level resources.
- Or record no supersession, and state in ADR-0009 that the module move applies `0001:19`.
- Either way, follow the house header shape: the Status line gains "; the … is superseded", as in ADR-0004, ADR-0005 and ADR-0006 `:3`. T6 names only the `Superseded in part:` line.

### R7 — Low: T6 appends sediment that the outcome does not need, against a standing user preference

**At fault:** `sending-identity.md:204-205`:

- a "dated clerical correction" appended at ADR-0004 `:45`;
- one-line correction pointers added to four historical work documents.

**Evidence:** Project memory `rewrite-over-bolt-on` says to rewrite the affected section rather than append a correction, with the honesty marker in Authority. ADR-0004 `:45-46` already stacks a bullet and a "(Superseded by the line above.)" sibling, and a third layer compounds it. The work documents are dated evidence of what was believed at the time. The README (T5), ADR-0002's supersession and ADR-0009 already carry the forward-looking guidance, so nothing in the outcome depends on the pointers.

**Smallest correction:**

- Rewrite ADR-0004's DKIM-coverage bullet in place so that coverage is confirmed on a verifying `mail.example.com` signature (T4 evidence), with one Authority note.
- Drop the four work-document pointers.

### R8 — Low: the retained owner reads its domain from a local env file, and a different value replaces the identity

**At fault:** T1 `:80`, where the stack reads `EMAILER_SENDER_IDENTITY` with `Config`, and T3 `:118` and ADR-0009 Consequences `:42`, which deploy and redeploy with `--env-file .env.test`.

**Evidence:** `EmailIdentity`'s `diff` returns `{ action: "replace" }` when `emailIdentity` changes (`AWS/SES/EmailIdentity.ts:275-284`). Under `retain`, the old generation is skipped rather than deleted (`Apply.ts:2168-2173`), and the new name is created. `.env.test` is an untracked, per-machine file. T1 notes it names `example.com` today, and so will any copy on another machine.

**Failure scenario:** The documented recovery ("if destroyed, redeploy it") is run with a stale env file. It creates an `example.com` identity, a ninth creation of the churned domain. State and every Emailer reference now point at it. `mail.example.com` survives, but it is forgotten.

**Smallest correction:** Declare the domain as a constant in `SendingIdentity.ts` (R1's alternative), so the one-shot stack has no environment input. If `Config` stays, add a README rule: the redeploy must use the same value, and check the plan shows no replace.

## Suspicions

### S1 — T3's `alchemy state read` probably fails without `--env-file`

**At fault:** `sending-identity.md:127`, `alchemy state read EmailerSending/shared/EmailerSender --config stacks/sending-identity.ts --profile emailer-test`.

**Evidence:**

- The path syntax is correct: stack/stage/FQN (`State/Tree.ts:215-237`; `Cli/commands/state.ts:34`).
- The default `configured` backend opens a session that imports the entrypoint and yields the stack effect (`Alchemist/Session.ts:276-309`).
- Yielding a `Stack(...)` effect runs the user program (`Stack.ts:170-185`, `:285`).
- If `stacks/sending-identity.ts` does `yield* Config.string("EMAILER_SENDER_IDENTITY")` in the program body, and no `--env-file` is given, that yield raises a `ConfigError` before any state is read.
- It would not fail if the Config is passed as a lazy prop, which Plan resolves later (`Plan.ts:838-845`).
- I did not run it.

**Correction:** Add `--env-file .env.test`, or use `--backend aws --env-file .env.test`, which skips the entrypoint. The fallback's "Destroy `EmailerSending`" has the same requirement (`Destroy.ts` → `evalStack`), and the plan gives no command for it. R8's constant makes both moot.

### S2 — Plan output does not show removal policy

**At fault:** Final acceptance `:235`, "T1's plan shows exactly one retained create".

**Evidence:** `retain` is a declaration decoration, not a prop, so it is not visible in plan output. T3's state read is the real check, and it is already listed.

**Correction:** Reword `:235` to "exactly one create".

## Checked and clear

- **Retention and fallback mechanics (question 4).**
  - Destroying `EmailerSending` with `retain` plans the row as `orphaned` (`Plan.ts:2033`), and apply only deletes the state row (`Apply.ts:2152-2158`), so no `DeleteEmailIdentity` call is made.
  - `removalPolicy` is committed on create and adopt paths (`Apply.ts:781` and following) and re-committed on a no-op (`:724-748`).
  - SES `read` compares the stack, stage and ID tags and returns `Unowned` otherwise (`EmailIdentity.ts:260-273`).
  - A resource-scoped `adopt()` overrides the default (`Plan.ts:1316`). The takeover retags in `reconcile` without a create (`EmailIdentity.ts:388-403`).
  - Once `adopt()` is removed, each ephemeral test deploy re-adopts through its own tags.
  - No window exists in which the Emailer stage's orphan sweep sees an `EmailerSender` row, because under the reference design the Emailer never persists one. The live state bucket is empty today.
  - With R1 fixed, the fallback is correct as described.
- **Reference in the binding (question 1, binding half).**
  - The binding label uses `LogicalId`, which the ref proxy serves as a static string (`Output.ts:33-36`, `:556-559`; probe confirmed). The SID is therefore unchanged: `Allow(Api, AWS.SES.SendEmail(EmailerSender, EmailerMail))`.
  - `identityArn` in the policy resolves from state at plan time (`Plan.ts:958-978`).
  - `upstream()` produces no local dependency edge for a `RefExpr` (`Output.ts:784-816`).
  - At cold start no state access is needed, because the only runtime read is the env-injected `FromIdentity`, and `makeSubmit` sets `FromEmailAddress` explicitly anyway (`Mailer.ts:131`).
- **Imports and cycles (question 2).**
  - `SendingIdentity.ts` would import only `alchemy/AWS`, and `Mailer.ts` would import it, so there is no cycle.
  - `Mailer.ts:13`'s `configurationSet` is an unevaluated Effect and adds nothing unless yielded. The shared stack does not import `Mailer.ts` anyway.
  - Nothing else imports `senderLogicalId`.
  - `oxlint` and `oxfmt` do not ignore `stacks/`, and CI runs `pnpm check` (`.github/workflows/checks.yml`).
- **State and Region (question 3).**
  - Both stacks use `AWS.state()`, the account-regional bucket, under the same profile.
  - `.env.test` carries `AWS_REGION=us-east-1` (`AWS/Region.ts:21`).
  - `--env-file .env.test` is correct for the shared stack's plan and deploy.
- **Untouched consumers (question 6).**
  - The unsubscribe function, the CLI and `IntegrationSupport.ts` never read the sender or identity. `IntegrationSupport.ts` imports only `allowedRecipients`.
  - `vitest.config.ts` needs no change.
  - `.env.example` already lists `AWS_REGION`.
  - Minor omission for T5: the README module table (`README.md:19-30`) should gain rows for `stacks/sending-identity.ts` and `SendingIdentity.ts`, and `:21` should stop implying a single Stack.
- **Test adequacy (question 5).**
  - Deferring automated DKIM regression is justified. It needs a live receiver and a cross-project credential.
  - The regression that matters, recreation, is structurally removed and checked by `LastKeyGenerationTimestamp` and CloudTrail in T4.
  - T4 checks behaviour at the correct, live layer.
- **ADR-0009 honesty (question 7).**
  - The counts match F13–F15: eight creates, seven deletes, a 27-second gap, five messages across three generations, and a pass 73 seconds after key generation.
  - The `EmailIdentity.ts:338` citation is exact.
  - F16's "reasoned deviation, not a documented recipe" is carried faithfully into the plan's Approach and ADR-0009's "Undocumented path" consequence.
  - The overclaims are only those in R1 and R6.
- **DNS scope (question 8).**
  - `Z00000000000000` is the public `example.com.` zone.
  - `mail.example.com` has no delegated zone (no NS answer, and no Route 53 zone of that name), so the three `CNAME`s belong in `example.com`.
  - T3 requires confirmation naming the zone before the first write.
  - The user chose the subdomain as a mail identity (ADR-0009 Authority), which satisfies the memory's "related reach" clause.
  - Current account state matches T3's preflight: SES holds only `existing.example.net`, `sender@existing.example.net` and `newsletter@existing.example.net`; there are no `_domainkey` records in the zone; and the Alchemy state bucket is empty.
- **Citations.** Every file:line reference in the plan's Key files table resolves to the described code or text:
  - `Mailer.ts:7, 82-103, 178-197`
  - `Api.ts:185`
  - `Feedback.ts:172-177, 238`
  - `Mailer.test.ts:112-305, 327-342, 357-430`
  - `tsconfig.json:3`
  - `alchemy.run.ts:11-16`
  - `Resource.ts:70-73`
  - `SendEmail.ts:72-83`
  - `BindingHttp.ts:279-340`
  - `Apply.ts:703-750`
  - `README.md:23, 172-245`
  - `.env.example:9-15`
  - ADR-0001 `:14`, ADR-0002 `:36, 42-44`, ADR-0004 `:45`
  - the four work-document lines
  - the wiki anchors

  `Feedback.ts:34-40` is approximate: the configuration-set constant and its `Config` read are at `:35-40`.

## Re-review

> **Scope:** only the corrections applied after the first review (coordinator's items 1–9), against the updated plan and ADR-0009, the installed `alchemy@2.0.0-beta.77` source, and the current README. The plan, ADR and research document were not edited.
> **Date:** 2026-09-14

**Verdict: Clear.** Two small residuals need no design change:

- **RR1:** T5's grep still misses two stale paragraphs.
- **RR2:** four plan lines still describe the pre-disposition design.

Neither can harm the identity or the gate.

### Items checked

1. **Replacement claim: accurate.**
   - `EmailIdentity`'s `diff` returns `{ action: "replace" }` when `emailIdentity` changes (`AWS/SES/EmailIdentity.ts:275-284`). No `deleteFirst` is set, so the replacement is create-first.
   - The new generation's `reconcile` receives `olds: undefined`, and `output` is undefined because the provider has no `precreate` (`Apply.ts:1321-1330`). The name therefore comes from `news.emailIdentity` and a new identity is created.
   - Garbage collection honours `retain` for the old generation (`Apply.ts:2164-2173`), which matches the `RemovalPolicy.ts` header. The old identity is left in SES and its row leaves the replacement chain, so it is retained and untracked.
   - Non-blocking nuance: if the new value names an identity that already exists in the account, `reconcile` does not create one. It finds that identity and syncs tags and the configuration-set association onto it, with no ownership check (`EmailIdentity.ts:295-324`, `:388-403`). "Never change it" already covers this, so no edit is needed.
2. **Fallback trigger: unambiguous enough.**
   - `InvalidReferenceError` names the stack, stage and logical ID in its message (`Plan.ts:969-975`).
   - A mis-granted role is directly observable with T4's IAM check.
   - "Any other error … is fixed in place" closes the misattribution path from R1.
   - The middle clause ("attributable to passing the reference into `SendEmail`") takes judgement, but the two concrete signals bracket it.
3. **Agreement check and role lookup: correct.**
   - T1's stack returns `emailIdentity`, which is readable at `EmailerSending/shared/output` with the T3 `state read` flags.
   - The Emailer's From check uses the value captured from `.env.test` at deploy (`Platform.ts:572-578`), so comparing the two is the right assertion.
   - Looking up the role through `get-function-configuration` and then its inline policies matches `Function.ts:1135-1139` and `:1217`.
4. **Unit cases: correct.** `belongsToIdentity("emailer-test@example.com", "mail.example.com")` compares the domain `example.com`:
   - `=== "mail.example.com"` is false;
   - `endsWith(".mail.example.com")` is false;
   - so the result is **false** (`Mailer.ts:66-70`).

   The mismatch case (identity `mail.example.com`, From `emailer-test@example.com`) reaches `Effect.die` at `Mailer.ts:94`, so `Effect.exit` is the right observation.

5. **`tsc --listFilesOnly`: works.**
   - `node_modules/.bin/tsc --version` reports `7.0.2+effect-tsgo.0.45.0`.
   - `pnpm exec tsc --listFilesOnly -p tsconfig.json` exits 0 and lists absolute paths.
   - `grep -c "alchemy.run.ts"` prints `1` today, so the same form for `stacks/sending-identity.ts` prints `1` with the include and `0` without it.
6. **State read: correct.** `--env-file .env.test` is present (plan `:127`), which covers the stack program's `Config` read when the configured backend opens the entrypoint.
7. **T5 grep: can fail today, but does not cover every stale paragraph.** Run against the current README, it matches `:193`, `:195`, `:197`, `:200` and `:210`, so it is not a false green for those blocks. It matches **nothing** on:
   - `:191` ("After the first deploy, read the identity's DKIM tokens");
   - `:199` ("cached the negative answer": `negative.?cach` needs "negative" before "cach");
   - `:245` ("delete the three DKIM `CNAME` records by hand").

   `:191` and `:245` are standalone paragraphs, so only the line-by-line review would catch them. See RR1.

8. **T6: sound.**
   - The ADR-0001 supersession names `:13` and `:14` and cites `:19`.
   - ADR-0004 is rewritten in place.
   - The work documents are left unchanged.
   - Optional: "matching the header shape of ADR-0004/0005/0006" should include those records' Status-line suffix ("Accepted; the … is superseded").
9. **ADR-0009: no remaining overclaim.**
   - Decision bullet 3 is accurate. Yielding an Output registers the environment variable and returns an accessor, and running the accessor reads `process.env`, which is unset at plan.
   - The Supersedes line matches item 8.
   - The replacement Consequence matches item 1.
   - "SES refuses the send" on drift is in practice an IAM `AccessDenied` on the unscoped ARN. `makeSubmit` maps it to `SubmissionUncertain`, so no mail is sent and it still fails closed.

### Remaining defects

- **RR1 — Low: T5's grep misses `:191`, `:199` and `:245`.** Smallest correction: extend the pattern.

  ```sh
  grep -niE "republish|negative.?cach|negative answer|stale key|leaving the dkim|dkim\.amazonses\.com|mints fresh|not isolated|under 90 seconds|first deploy, read|delete the three dkim" README.md
  ```

  Run against today's README, this matches `:191`, `:193`, `:195`, `:197`, `:199`, `:200`, `:210` and `:245`.

- **RR2 — Low: leftover text from before the dispositions.** Smallest correction, one clause each:
  - Key files `:51` (`.env.example`) still says "it becomes the `EmailerSending` input". It should say both stacks read it.
  - Key files `:54` (ADR-0004) still says "T6 adds a correction link". It should say T6 rewrites the evidence in place.
  - Final acceptance `:237` still says "T1's plan shows exactly one retained create". It should say "exactly one create", since retention is shown only by T3's state read.
  - T7 `:224` should record, next to "references work in AWS bindings during construction", that a reference's attributes are accessors that are `undefined` at plan time. That is R1's lesson, and without it the wiki entry repeats the original mistake.
