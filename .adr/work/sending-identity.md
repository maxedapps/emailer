# Account-level sending identity

> **Status:** Complete
> **Authorization:** Accepted for implementation by the user on 2026-09-14, after the independent review and a second source, docs and live-probe check (see Reviews). T4 gate passed the same day; ADR-0009 is Accepted.
> **ADRs:** [0009 — Account-level sending identity, created once and retained](../0009-account-level-sending-identity.md) (Accepted); supersedes parts of [0002](../0002-domain-sending-identity.md) and [0001](../0001-resource-owning-effect-services.md)
> **Research:** [Shared sender identity research](shared-sender-identity-research.md), F1–F16
> **Updated:** 2026-09-14

## Outcome and boundaries

- **Problem and target:** The SES domain identity lived inside the per-stage Emailer stack. Every ephemeral test deploy and destroy recreated it. After eight recreations under deterministic Easy DKIM tokens, the key SES published no longer matched the key it signed with, and sender-domain DKIM never verified. A never-recreated identity passed immediately (research F13–F15). **Target:** one sending identity per AWS account and Region, **`mail.example.com`**. It is owned by a separate retained stack `EmailerSending` at the pinned stage `shared`, created exactly once, and referenced by every Emailer stage. Delivered mail must verify `dkim=pass header.d=mail.example.com` across repeated test deploy/destroy cycles.
- **In scope:**
  - A new one-shot stack file declaring the retained identity, plus the tooling to typecheck it
  - One shared definition of the identity's address (stack, stage, logical ID), used by both sides
  - `MailerLive` binding `SendEmail` to a reference; the From-address check keeps reading `EMAILER_SENDER_IDENTITY`, which both stacks read
  - One-time deployment of `EmailerSending` and one-time publication of its DKIM `CNAME`s in `example.com`
  - A live go/no-go gate across two test cycles
  - Corrections to the README, `.env.example`, ADR lifecycle links and ADR-0004's evidence, and the wiki
- **Out of scope:**
  - Repairing `example.com` (abandoned; F15)
  - BYODKIM
  - Declaring DKIM records as `AWS.Route53.Record` (F11)
  - SPF, DMARC and custom MAIL FROM (still open under ADR-0002)
  - Automated DKIM regression tests (see Deferrals)
  - A separate production account
  - The another project's `mail.other.example.net` (flag only)
  - Any change to the feedback path, which depends only on the per-stage configuration set
- **Approach:** Use Alchemy's documented cross-stack reference form (References page, "Cross-stack too") and its guidance on splitting stacks with different cadences (Monorepo). This is a reasoned deviation from the docs' primary same-stack pattern (F16). The docs say a reference can be passed "anywhere the real thing is accepted" but show no AWS-binding example. Construction and plan-time resolution through `SendEmail` are already demonstrated (Research); the live gate proves deploy, the IAM grant and a verifying send, with an explicit fallback. DKIM records stay manual and are published once.

```text
EmailerSending / shared   (deploy once, never destroy)
  └─ AWS.SES.EmailIdentity "EmailerSender"  mail.example.com  retain()
         ▲  EmailIdentity.ref("EmailerSender", { stack: "EmailerSending", stage: "shared" })
Emailer / test (ephemeral) ── ApiFunction ── MailerLive ── SES.SendEmail(ref, configurationSet)
```

## Key files, evidence, and decisions

| File or source                                                                                                 | Why it matters                                                                                                                                                                                | Plan impact                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src/Mailer.ts:178-197` (`MailerLive`)                                                            | Declares `AWS.SES.EmailIdentity(senderLogicalId, …)` at `:182-184` and binds `SendEmail(identity, mail)` at `:187`                                                                            | T2 replaces the declaration with the reference; `mailerAddresses` is unchanged                                                                                                                                                                                                                                                                                                           |
| `apps/backend/src/Mailer.ts:7, 82-103`                                                                         | `senderLogicalId`; `mailerAddresses` reads `EMAILER_SENDER_IDENTITY`, then enforces `belongsToIdentity` and `SenderNotOnIdentity`                                                             | Unchanged. A referenced identity's attributes are not readable during construction at plan time: yielding an `Output` registers a Lambda environment variable and reads `process.env`, unset at plan (`node_modules/alchemy/src/Output.ts:155-162`, `AWS/Lambda/Function.ts:1003-1016`, `wiki/alchemy/runtime-and-bindings.md:25`). So the check keeps reading `EMAILER_SENDER_IDENTITY` |
| `apps/backend/src/Api.ts:185`                                                                                  | `ApiFunction` is the **only** provider of `MailerLive`, so the only SES send grant                                                                                                            | T4 checks that role's IAM against the shared identity ARN                                                                                                                                                                                                                                                                                                                                |
| `apps/backend/src/Feedback.ts:34-40, 172-177, 238`; `Mailer.ts:105-116`                                        | The event rule and handler filter on the **configuration set** only, never on identity or domain                                                                                              | Not changed; the feedback path is unaffected                                                                                                                                                                                                                                                                                                                                             |
| `apps/backend/src/Mailer.test.ts:327-342, 357-430`                                                             | `belongsToIdentity` and `mailerAddresses` cases; **no** case asserts that `mailerAddresses` fails with `SenderNotOnIdentity`, even though ADR-0002's Confirmation claims it                   | T2 adds the missing mismatch case; `SenderNotOnIdentity` is raised with `Effect.die`, so the test observes the exit, not a result                                                                                                                                                                                                                                                        |
| `tsconfig.json:3`                                                                                              | `include` omits any `stacks/` path, so a new stack file would **silently skip `tsc`**                                                                                                         | T1 adds `stacks/**/*.ts`                                                                                                                                                                                                                                                                                                                                                                 |
| `alchemy.run.ts:11-16`                                                                                         | Stack `Emailer`, `AWS.providers()`, `AWS.state()`                                                                                                                                             | The shared stack mirrors providers and state; references need the same account-regional store (F8)                                                                                                                                                                                                                                                                                       |
| `node_modules/alchemy/src/Resource.ts:70-73`; `AWS/SES/SendEmail.ts:72-83`                                     | `ref(...)` returns `Effect<EmailIdentity>`; `SendEmail<I extends EmailIdentity>` accepts it at the type level                                                                                 | Type-compatible. Runtime behaviour during Lambda construction is **undocumented** (F16 gap 3) and gated in T4                                                                                                                                                                                                                                                                            |
| `node_modules/alchemy/src/AWS/SES/BindingHttp.ts:279-340`                                                      | The binding reads `emailIdentity`, `identityArn` and `LogicalId` from the identity; grants `identity/*@<domain>`                                                                              | IAM scope moves to `*@mail.example.com`; a reference satisfies these by construction (F9)                                                                                                                                                                                                                                                                                               |
| `node_modules/alchemy/src/Apply.ts:703-750`                                                                    | beta.77 persists a changed `removalPolicy` on a no-op (fix for issue #1404/#1248)                                                                                                             | `retain()` is in place before `EmailerSending` could ever be destroyed                                                                                                                                                                                                                                                                                                                   |
| `node_modules/alchemy/src/Plan.ts:2127-2138` (`Plan.destroy`)                                                  | Destroy plans against an empty desired state and resolves no Outputs, so a borrower's destroy never reads the reference (live probe, Research)                                                | Plan and deploy need the owner; destroy does not. ADR-0009, T5 and T7 say so                                                                                                                                                                                                                                                                                                             |
| `node_modules/alchemy/src/Plan.ts:1298-1316`; `AWS/SES/EmailIdentity.ts:260-273`                               | With no state row the planner probes `read` with `olds: news`, and the SES provider checks ownership tags, so a second stage in the same account is refused (`OwnedBySomeoneElse`)            | Confirms ADR-0009 alternative 1's reason for rejection; the separate stack stands                                                                                                                                                                                                                                                                                                        |
| `alchemy.run.ts:14`; `node_modules/alchemy/src/AWS/Providers.ts:242-2003`                                      | `AWS.providers()` is typed `Layer<…, never, any>`, so the `providers:` line carries a scoped `oxlint-disable-next-line`; the `any` is the library's, and a cast would be the same suppression | T1 mirrors the comment; T7 records the trap                                                                                                                                                                                                                                                                                                                                              |
| `README.md:23, 172-245`                                                                                        | The module table and the whole DKIM/deploy/teardown section encode the per-run identity lifecycle and the disproven cache and propagation explanations                                        | T5 rewrites them                                                                                                                                                                                                                                                                                                                                                                         |
| `.env.example:9-15`                                                                                            | Comments describe `EMAILER_SENDER_IDENTITY` as the Emailer's domain                                                                                                                           | T2: read by **both** stacks, which must hold the same value; the From address moves to the subdomain                                                                                                                                                                                                                                                                                     |
| `.adr/0002-domain-sending-identity.md:36, 42-44`                                                               | Manual record deletion and the propagation-race obligation                                                                                                                                    | T6: "Superseded in part" link to ADR-0009                                                                                                                                                                                                                                                                                                                                                |
| `.adr/0001-resource-owning-effect-services.md:13-14, 19`                                                       | "Keep one root `alchemy.run.ts`" (`:13`) and "`Mailer.ts` owns its … SES identity" (`:14`); `:19` allows a separate resource module for a shared ownership need                               | T6: "Superseded in part" link naming `:13` and `:14`                                                                                                                                                                                                                                                                                                                                     |
| `.adr/0004-sender-owned-one-click-unsubscribe.md:45`                                                           | "DKIM coverage of the two headers is proven", read from the `d=example.com` signature that never verified                                                                                    | T4 re-establishes coverage; T6 rewrites the evidence sentence in place                                                                                                                                                                                                                                                                                                                   |
| `.adr/work/consent-and-unsubscribe.md:275-276`, `clean-codebase.md:15, 262`, `clean-codebase-pr-review.md:120` | Historical run records whose guidance rests on the disproven cause                                                                                                                            | Left unchanged (review R7): the README, ADR-0009 and the research document are authoritative                                                                                                                                                                                                                                                                                             |
| Memory `dns-changes-stay-in-scope`                                                                             | DNS changes only in `example.com`, confirmed before the first record                                                                                                                         | T3 needs explicit user confirmation naming the zone at implementation time                                                                                                                                                                                                                                                                                                               |

## Research

Complete; see the research document. Decision-relevant results:

- **F15:** a never-recreated identity passes.
- **F11:** `Route53.Record` overwrites silently.
- **F2:** owned re-adoption through tags.
- **F3:** `adopt()` can be scoped to a single resource in beta.77.
- **F6:** `nuke` ignores retain.
- **F16:** a documentation-alignment check and the undocumented reference-in-binding path.

Two facts established during planning:

- Deleting `example.com` removed its keys from `dkim.amazonses.com` (NXDOMAIN at the authoritative servers). Earlier deletions presumably did the same and recreations still failed, so deletion is no repair.
- Alchemy beta.77's `EmailIdentity` provider has no BYODKIM support.

Established during the second check (2026-09-14, against the live docs, the installed source and a live probe):

- **Probe.** A throwaway stack with local state, whose Lambda init bound `SendEmail` to a ref to a nonexistent upstream: `alchemy plan` failed with `InvalidReferenceError` from `Plan.ts:1712`, and `alchemy destroy` printed `Plan: no resources` and succeeded. The reference is accepted by the binding at construction, resolved at plan, and never touched by destroy (`Plan.destroy`, `Plan.ts:2127-2138`; destroy docs: "`destroy` is `deploy` with the desired state zeroed out").
- **SID.** The ref proxy answers `"LogicalId" in ref` with `true` (`Output.ts:512-523`), so the binding SID stays `Allow(Api, AWS.SES.SendEmail(EmailerSender, EmailerMail))` and the throwing `String(ref)` branch is never reached.
- **FQN.** The reference resolves state by `fqn: expr.resourceId` (`Plan.ts:960-966`), and state is keyed by FQN, "the namespace path and logical ID" (State store docs). The owner must therefore declare `EmailerSender` at the stack root.
- **Docs alignment.** References, Resource lifecycle, destroy, state, the plan/deploy/destroy flag tables, Secrets, Phases and State store all agree with the source claims above. The only docs/source disagreement remains `adopt()` scope (F3).

## Tasks

#### T1 — Declare the retained identity in its own stack

- **Change:**
  - Add `apps/backend/src/SendingIdentity.ts`, the single definition both sides share. It exports `sendingIdentityStack = "EmailerSending"`, `sendingIdentityStage = "shared"`, `senderLogicalId = "EmailerSender"` (moved from `Mailer.ts:7`), and `sendingIdentity`, an Effect equal to `AWS.SES.EmailIdentity.ref(senderLogicalId, { stack: sendingIdentityStack, stage: sendingIdentityStage })`.
  - Add `stacks/sending-identity.ts`: `export default Stack("EmailerSending", { providers: AWS.providers(), state: AWS.state() }, …)`. It reads `EMAILER_SENDER_IDENTITY` with `Config`, declares `AWS.SES.EmailIdentity(senderLogicalId, { emailIdentity })` piped through `RemovalPolicy.retain()`, and returns `{ emailIdentity, dkimTokens }` as stack outputs.
  - Add a header comment stating three things: deploy once per account and Region at stage `shared`; never destroy; `nuke` must exclude `AWS.SES.*`.
  - Mirror the `oxlint-disable-next-line effecttsgo/any-unknown-in-error-context, typescript/no-unsafe-assignment` from `alchemy.run.ts:14` on the `providers:` line. The `any` is in Alchemy's `providers()` signature, not in this code; narrowing cannot remove it and a cast would be the same suppression behind a SAFETY comment.
  - Declare the identity directly in the stack program, never inside `Namespace.push`. The Emailer's reference resolves by FQN and names `EmailerSender` bare.
  - Add `"stacks/**/*.ts"` to `tsconfig.json`'s `include`.
  - Set `EMAILER_SENDER_IDENTITY=mail.example.com` and `EMAILER_FROM_EMAIL=emailer-test@mail.example.com` in the local `.env.test`. Keep `dmarc@reports.example.net` first in `EMAILER_ALLOWED_RECIPIENTS`. This must happen here: the plan check below reads this file, and today it still names the abandoned `example.com`.
- **Starts at:** `tsconfig.json:3`, `apps/backend/src/Mailer.ts:7`, `alchemy.run.ts` (shape to mirror)
- **Depends on:** none
- **Status:** Verified
- **Evidence:**
  - Parent implemented in the shared checkout: T1 and T2 share `Mailer.ts`, so they are sequential same-checkout writers rather than isolated lanes.
  - `pnpm exec tsc --listFilesOnly -p tsconfig.json | grep -c "stacks/sending-identity.ts"` → `1`.
  - `pnpm exec alchemy plan --config stacks/sending-identity.ts --stage shared --env-file .env.test --profile emailer-test --detailed` → `Plan: 1 to create`, only `[EmailerSender] create`, `emailIdentity: mail.example.com`. No adoption or replacement.
  - `pnpm check` green (format, lint 0 warnings, tsc, 470 unit tests, imports).
  - T1+T2 review: [sending-identity-t1t2-review.md](sending-identity-t1t2-review.md), Clear, no findings. Parent re-inspected the diffs and the plan output; accepted.
- **Tests:** No unit test. The file is a declaration with no logic, and `tsc`/`oxlint` through `pnpm check` cover it. The observable behaviour, exactly one retained identity planned, is checked by `alchemy plan` below and exercised in T3.
- **Verify:**
  - Run `pnpm check`; expect it green.
  - Run `pnpm exec tsc --listFilesOnly -p tsconfig.json | grep -c "stacks/sending-identity.ts"`; expect `1`. The file is inside the typechecked program; without the include this prints `0`.
  - Run `pnpm exec alchemy plan --config stacks/sending-identity.ts --stage shared --env-file .env.test --profile emailer-test`; expect `Plan: 1 to create` with only `[EmailerSender]` for `mail.example.com`, and no adoption or replacement.
- **Risk/recovery:** None; the plan is read-only.

#### T2 — Point the Emailer at the shared identity

- **Change:**
  - In `MailerLive`, replace `AWS.SES.EmailIdentity(senderLogicalId, …)` with `yield* sendingIdentity`, and keep `AWS.SES.SendEmail(identity, mail)` as is.
  - Leave `mailerAddresses` unchanged. It keeps reading `EMAILER_SENDER_IDENTITY` for the From-address check, because a referenced identity's attributes are unavailable during construction at plan time (see Key files).
  - Update `.env.example:9-15`: `EMAILER_SENDER_IDENTITY` is read by **both** stacks and must hold the same value (`mail.example.com`). Never change it for `EmailerSending`: the identity is its only prop, so a different value plans a _replacement_, which creates a new identity and leaves the old one retained but untracked. `EMAILER_FROM_EMAIL` must be an address at that domain.
- **Starts at:** `apps/backend/src/Mailer.ts:82-103` and `:178-197`, `apps/backend/src/Mailer.test.ts:357-430`
- **Depends on:** T1
- **Status:** Verified
- **Evidence:**
  - `MailerLive` yields `sendingIdentity`; `mailerAddresses` unchanged.
  - `pnpm check` green; unit count 470, `Mailer.test.ts` 24 (was 22).
  - `pnpm exec vitest run --project unit apps/backend/src/Mailer.test.ts` — 24 passed, including the parent-domain `belongsToIdentity` case and `SenderNotOnIdentity` via `Effect.exit` / `Cause.findDefect`.
  - T1+T2 review: [sending-identity-t1t2-review.md](sending-identity-t1t2-review.md), Clear, no findings. Parent accepted.
- **Tests:** `apps/backend/src/Mailer.test.ts` (unit):
  - Add a `belongsToIdentity` case: `emailer-test@example.com` against identity `mail.example.com` is **false** (a parent-domain sender must not pass for a subdomain identity).
  - Add the missing case: with `EMAILER_SENDER_IDENTITY=mail.example.com` and `EMAILER_FROM_EMAIL=emailer-test@example.com`, `mailerAddresses` dies with `SenderNotOnIdentity`. It is raised with `Effect.die`, so run it with `Effect.exit`, assert `Exit.isFailure`, and read the defect with `Cause.findDefect(exit.cause)`, expecting a `SenderNotOnIdentity`. The existing `Effect.result` helper does not capture defects, and a bare "rejects" assertion would also pass for an unrelated `TypeError`.
  - The `makeSubmit`/binding cases (`:112-305`) use a resource stand-in and stay valid.
  - The live reference path is **not** unit-testable (it needs deployed upstream state), so T4 covers it.
- **Verify:**
  - Run `pnpm check`; expect green, with the unit count rising by the added case.
  - Run `pnpm exec vitest run --project unit apps/backend/src/Mailer.test.ts`; expect the new `SenderNotOnIdentity` case to pass.
- **Risk/recovery:** The two stacks' values can drift. The Emailer's check then passes on its own value, but the role's grant covers only the referenced identity, so the send is denied (IAM `AccessDenied`, reported as `SubmissionUncertain`). No mail goes out. T4 asserts the two agree.

#### T3 — Deploy `EmailerSending` once and publish its DKIM records

- **Change:**
  - **Before any cloud write,** get the user's explicit go-ahead naming the zone (`example.com`, Route 53 `Z00000000000000`).
  - **Preflight:** `aws sesv2 get-email-identity --email-identity mail.example.com` returns `NotFoundException`; CloudTrail (`us-east-1`) has no `CreateEmailIdentity` or `DeleteEmailIdentity` for it; the zone has no records under `mail.example.com`.
  - Deploy: `pnpm exec alchemy deploy --config stacks/sending-identity.ts --stage shared --env-file .env.test --profile emailer-test --yes --no-input`.
  - Read `DkimAttributes.Tokens`, `SigningHostedZone` and `LastKeyGenerationTimestamp` from `get-email-identity`. Record the timestamp as the T4 baseline.
  - Create three `CNAME`s `<token>._domainkey.mail.example.com → <token>.<SigningHostedZone>` in `Z00000000000000` (TTL 1800). Poll the change to `INSYNC`.
  - Wait for `DkimAttributes.Status=SUCCESS` and `VerifiedForSendingStatus=true`.
- **Starts at:** T1's stack file; the operator commands recorded in the research document (F15 steps)
- **Depends on:** T1
- **Status:** Verified
- **Evidence:**
  - User confirmed T3 go-ahead naming `example.com` / Route 53 `Z00000000000000` on 2026-09-14.
  - Preflight: `GetEmailIdentity mail.example.com` → `NotFoundException`. CloudTrail us-east-1 `CreateEmailIdentity`/`DeleteEmailIdentity` (50 most recent each): no `mail.example.com` (hits are `example.com`, `dkim-check.example.com`, `mail.other.example.net`). Zone `Z00000000000000` had only NS and SOA for `example.com.`.
  - Deploy `EmailerSending/shared`: `Plan: 1 to create`, `[EmailerSender] created`, ARN `arn:aws:ses:us-east-1:123456789012:identity/mail.example.com`.
  - `alchemy state read EmailerSending/shared/EmailerSender` → `removalPolicy: "retain"`, `fqn: "EmailerSender"`.
  - `GetEmailIdentity`: tokens `xrqbcrri2cif2ux65a5aostry7f4z2bb`, `ixmhocuwuirmqu54wozurxf47psumwzf`, `q62anaqkteolcnkh3cdjuo3rhzqdzy6n`; `SigningHostedZone=dkim.amazonses.com`; **T4 baseline `LastKeyGenerationTimestamp=2026-09-14T17:30:33.252000+02:00`**.
  - Route 53 change `/change/C10164353QW7M9TAPWIEB` → `INSYNC`. `dig +short @8.8.8.8 <token>._domainkey.mail.example.com CNAME` matches `<token>.dkim.amazonses.com.` for all three.
  - `DkimAttributes.Status=SUCCESS`, `VerifiedForSendingStatus=true`.
- **Tests:** Operational one-time step with no automation (a live account change). Validated by the preflight and verification commands below, and exercised end to end in T4.
- **Verify:**
  - Run `pnpm exec alchemy state read EmailerSending/shared/EmailerSender --config stacks/sending-identity.ts --env-file .env.test --profile emailer-test`; expect `removalPolicy: "retain"`. This is the only check that shows retention; plan output does not.
  - Run `dig +short @8.8.8.8 <token>._domainkey.mail.example.com CNAME` for each token; expect `<token>.<SigningHostedZone>.`.
  - Run `aws sesv2 get-email-identity --email-identity mail.example.com --query DkimAttributes.Status`; expect `SUCCESS`.
- **Risk/recovery:**
  - A failed deploy leaves at most one identity. Fix and redeploy: owned tags mean silent re-adoption with no new key.
  - **Never delete this identity to "retry"**; recreation is the failure mode this plan exists to stop.

#### T4 — Go/no-go gate: two test cycles against the shared identity

- **Change:**
  - Run `pnpm exec alchemy plan --config alchemy.run.ts --stage test --env-file .env.test --profile emailer-test`. Expect Emailer creates with **no** `AWS.SES.EmailIdentity` create, no `InvalidReferenceError`, and an SES send binding. Record the binding's plan entry as evidence (F9); there is no earlier state to compare it against after the teardown.
  - **Cycle 1:**
    - Deploy `test` and copy the outputs into `.env.test`.
    - Create a contact for `dmarc@reports.example.net`, a list and a campaign, then send.
    - Read the delivered message's headers through the operator mailbox (`mailbox_get_message_headers`).
    - Destroy `test`.
  - **Cycle 2:** repeat deploy, send, read and destroy.
  - After each destroy, re-read `get-email-identity` and CloudTrail `DeleteEmailIdentity`.
  - **Fallback only if the reference itself fails**, per ADR-0009 alternative 1. That means exactly one of two signals: `InvalidReferenceError` while `EmailerSending/shared` is deployed in the same Region and state bucket, or the `api` role's policy not granting the shared identity ARNs. Construction and plan-time resolution of the reference through `SendEmail` are already demonstrated (Research), so any other error (configuration, credentials, the From check, a plan-time defect) is fixed in place and does **not** trigger the fallback:
    - Destroy `EmailerSending` (the identity is retained and survives).
    - Declare the identity in `MailerLive` with `RemovalPolicy.retain()` and a one-time resource-scoped `AdoptPolicy.adopt()` (F3). Remove `adopt()` after the first deploy.
    - Delete `stacks/sending-identity.ts` and `SendingIdentity.ts`'s reference.
    - Record the deviation, and revise ADR-0009 before acceptance.
    - The DKIM records and the identity stay untouched, so no recreation happens.
  - **Block, don't retry,** if a verifying setup still yields `dkim=fail header.d=mail.example.com`: that contradicts F15 and needs investigation.
- **Starts at:** `README.md:215-216, 242` (command shapes), `apps/backend/test/IntegrationSupport.ts`, the operator mailbox
- **Depends on:** T2, T3
- **Status:** Verified
- **Evidence:**
  - Emailer `test` plan: `Plan: 15 to create, 10 binding changes`; `[Api/Allow(Api, AWS.SES.SendEmail(EmailerSender, EmailerMail))] create`; **no** `EmailIdentity` create; no `InvalidReferenceError`.
  - Cycle 1 send `f8c46e11-2b82-4a27-99d8-e34f5bac5255` accepted (`messageId` `010001a0a0920134-…`). Delivered source: `Authentication-Results` contains `dkim=pass header.d=mail.example.com`; `d=mail.example.com` `h=` includes `List-Unsubscribe:List-Unsubscribe-Post`. API role `Emailer-Api-test-r7d2pffxxup7tli3` grants `ses:SendEmail` on `identity/mail.example.com` and `identity/*@mail.example.com`. Destroy: 15 deleted, identity not in the plan. After destroy: `LastKeyGenerationTimestamp` still `2026-09-14T17:30:33.252000+02:00`; no CloudTrail `DeleteEmailIdentity` for `mail.example.com`.
  - Cycle 2 send `a9d5a43a-e9e7-40f2-861b-6f69016b8f37` accepted. Same `dkim=pass header.d=mail.example.com` and `h=` coverage; role `Emailer-Api-test-njrxsswft3gx4mnv` same SES ARNs. Destroy: 15 deleted.
  - After cycle 2: identity `SUCCESS` / unchanged timestamp; `example.com` `NotFoundException`; no `emailer-test-*` Lambdas, `Emailer-*` tables/queues/alarms/roles/log groups/event rules/configuration sets; `alchemy state list Emailer` → `path does not exist`; three DKIM `CNAME`s remain in `Z00000000000000`; `EMAILER_SENDER_IDENTITY=mail.example.com` equals the `EmailerSending` output.
  - Headers were read from the operator mailbox's archived source (`the mailbox CLI messages source`) because the session's the operator mailbox MCP was `auth required`. That is the same rfc822 archive `mailbox_get_message_headers` reads.
  - Fallback not taken.
- **Tests:** Live acceptance only; this is the gate that protects the outcome. Both cycles must satisfy every one of:
  - `Authentication-Results` contains `dkim=pass header.d=mail.example.com`.
  - That signature's `h=` includes `List-Unsubscribe:List-Unsubscribe-Post` (re-establishing ADR-0004's coverage on a _verifying_ signature).
  - `LastKeyGenerationTimestamp` equals the T3 baseline.
  - No `DeleteEmailIdentity` for `mail.example.com` appears in CloudTrail.
  - The `api` role's SES policy targets the `mail.example.com` identity ARN.

  Automated DKIM regression is deferred (see Final acceptance).

- **Verify:**
  - Run `aws sesv2 get-email-identity --email-identity mail.example.com --query '[DkimAttributes.Status,DkimAttributes.LastKeyGenerationTimestamp]'` after each destroy; expect `SUCCESS` and the unchanged baseline.
  - During a cycle, find the generated role through the function (`aws lambda get-function-configuration --function-name emailer-test-api --query Role`), then read its **inline** policies (`aws iam list-role-policies`, `get-role-policy`). Expect `ses:SendEmail` on `…:identity/mail.example.com` and `…:identity/*@mail.example.com`.
  - Confirm the two stacks agree: the `EmailerSending` output `emailIdentity` equals `EMAILER_SENDER_IDENTITY` in `.env.test`.
  - Check the account after cycle 2: no `emailer-test-*` Lambda, `Emailer-*` table, queue, alarm, role, log group, event rule or configuration set, and no Alchemy state for `Emailer/test`. The identity and its three `CNAME`s still exist.
- **Risk/recovery:** Test stages stay ephemeral; each cycle ends destroyed. If cycle 1 fails after deploy, destroy `test` before investigating.

#### T5 — Rewrite the README's identity and DKIM guidance

- **Change:**
  - Update the `README.md:23` module row: `Mailer.ts` owns the service, configuration set, event destination and send binding, and _references_ the shared identity. Add rows for `stacks/sending-identity.ts` (the one-shot owner stack) and `apps/backend/src/SendingIdentity.ts` (the identity's shared address), and reword the `alchemy.run.ts` row so it no longer implies a single Stack.
  - Add a one-time "Sending identity" setup section, placed before "Deploying an ephemeral test stage":
    - deploy `stacks/sending-identity.ts` at `--stage shared`, once per account and Region, in the same Region as the Emailer;
    - publish the three `CNAME`s from `SigningHostedZone`;
    - confirm `dkim=pass` in a delivered message's `Authentication-Results`.
  - State the rules:
    - deploy the shared stack before any Emailer plan or deploy (`InvalidReferenceError` otherwise); destroying a test stage does not need it, because destroy resolves no references;
    - never destroy it; if it is destroyed, redeploy it (no new key); never delete the identity to retry;
    - `alchemy unsafe nuke` must exclude `AWS.SES.*`.
  - **Delete the stale text** (research lane report):
    - `:191` "after the first deploy, read the identity's DKIM tokens"
    - `:193` fresh tokens, republishing every run
    - `:195-202` "prefer leaving the records in place", the cause "not isolated", and the negative-cache and stale-key theories, including the hardcoded `dkim.amazonses.com` at `:200`
    - `:204-210` the propagation-race routine
    - `:245` hand-deleting DKIM records, and "the SES identity" in the teardown inventory
  - Replace them with the churn finding and a link to research F14/F15.
  - Adjust `:219` "no adoption or replacement": the Emailer plan references, and does not create, the identity.
- **Starts at:** `README.md:23`, `:172-245`
- **Depends on:** T4 (the text reflects the gate's actual outcome, including the fallback if taken)
- **Status:** Verified
- **Evidence:**
  - Module table rows for `stacks/sending-identity.ts` and `SendingIdentity.ts`; `Mailer.ts` references the shared identity; `alchemy.run.ts` is the Emailer stack.
  - New "Sending identity" section before ephemeral deploy; stale DKIM republish/cache/propagation/teardown text deleted (former `:191-210` and `:245` ranges replaced, not rephrased).
  - `pnpm format:check` clean. Stale-phrase grep: no matches. Relative-link check: none broken.
- **Tests:** Documentation; no automation. Validated by review against T4's evidence and by a link check.
- **Verify:**
  - Run `pnpm format:check`; expect clean.
  - Run `grep -niE "republish|negative.?cach|negative answer|stale key|leaving the dkim|dkim\.amazonses\.com|mints fresh|not isolated|under 90 seconds|first deploy, read|delete the three dkim" README.md`; expect no matches. Against today's README it matches all eight stale lines (`:191`, `:193`, `:195`, `:197`, `:199`, `:200`, `:210`, `:245`), so the check can fail.
  - Read the former `README.md:191-210` and `:245` ranges in the diff line by line; expect each stale statement replaced, not merely rephrased around the grep.
  - Resolve every relative Markdown link in `README.md` (`python3` link check as used in previous plans); expect none broken.

#### T6 — Correct lifecycle links and forward-looking guidance in the records

- **Change:**
  - ADR-0002 header: add `Superseded in part:` linking ADR-0009 (identity lifecycle, domain, propagation-race cause and obligation), matching the header shape of ADR-0004, ADR-0005 and ADR-0006. The body stays as the preserved rationale.
  - ADR-0001 header: add `Superseded in part:` linking ADR-0009 for two clauses: "Keep one root `alchemy.run.ts`" (`:13`), since the identity now has its own stack, and the SES identity's placement in `Mailer.ts` (`:14`). Note that `:19` already allows "a small separate resource module … if a concrete shared ownership need arises", which this is.
  - ADR-0004 `:45`: rewrite the evidence sentence in place as a clerical correction, per the repository's preference for landing corrections as if built that way. Coverage is established on the verifying `mail.example.com` signature from T4. Link ADR-0009.
  - Leave historical work documents unchanged. The README, ADR-0009 and the research document are the authoritative guidance, and the outcome does not need correction notes appended to old run records.
  - ADR-0009: once T4 passes and the user accepts, set `Status: Accepted` with `Accepted:` date and authority. If the fallback was taken, revise its Decision first.
- **Starts at:** `.adr/0002-domain-sending-identity.md:3`, `.adr/0001-resource-owning-effect-services.md:3`, `.adr/0004-sender-owned-one-click-unsubscribe.md:45`
- **Depends on:** T4
- **Status:** Verified
- **Evidence:**
  - ADR-0001 and ADR-0002 each have one `Superseded in part` line linking ADR-0009 (`grep -n "Superseded in part" .adr/0001-*.md .adr/0002-*.md`).
  - ADR-0004 evidence sentence rewritten in place for the verifying `mail.example.com` signature from T4.
  - ADR-0009 `Status: Accepted` with `Accepted: 2026-09-14` after the gate passed. Fallback not taken, so the Decision was not revised.
  - Relative-link check over `.adr/**/*.md`: none broken.
- **Tests:** Documentation; no automation. Validated by the link check.
- **Verify:**
  - Run the relative-link check over `.adr/**/*.md`; expect none broken.
  - Run `grep -n "Superseded in part" .adr/0001-*.md .adr/0002-*.md`; expect one line each.

#### T7 — Record the reusable knowledge in the wiki

- **Change:**
  - `wiki/aws/ses.md` (after `:11`): the Easy DKIM recreate trap, and that `SigningHostedZone` must never be hardcoded. Cross-link from `wiki/aws/deliverability.md:11` and `wiki/alchemy/environments-and-state.md:11`.
  - `wiki/alchemy/version-specific-traps.md`: add rows for per-resource `adopt()` in beta.77 (live docs say it must wrap the deploy), `Route53.Record` silently overwriting existing records, `nuke` ignoring retain, and `AWS.providers()` returning `any` in its requirements channel (`AWS/Providers.ts:242-2003`), which is why stack files carry a scoped `oxlint-disable-next-line`; recheck on upgrade.
  - `wiki/alchemy/cli-and-deployment.md:41`: adoption can be scoped to one resource.
  - `wiki/alchemy/aws-domains-and-http.md:40`: `read` never returns `Unowned`, so adoption is silent.
  - `wiki/alchemy/outputs-and-references.md:36-48`: a retained owner's destroy breaks every borrower plan and deploy until the owner is redeployed, while a borrower's destroy still works because `Plan.destroy` resolves nothing (probe, Research); and that a reference can be passed into an AWS binding during construction, demonstrated through plan, with deploy and send confirmed only if T4 passed. Add the caveat that a reference's attributes are `undefined` at plan time, so it must never feed a construction-time value check (plan review R1).
- **Starts at:** the files above
- **Depends on:** T4
- **Status:** Verified
- **Evidence:**
  - `wiki/aws/ses.md`: Easy DKIM recreate trap and `SigningHostedZone`; AWS Easy DKIM URLs.
  - Cross-links from `wiki/aws/deliverability.md` and `wiki/alchemy/environments-and-state.md`.
  - `wiki/alchemy/version-specific-traps.md`: per-resource `adopt()`, Route53 silent overwrite, `nuke` vs retain, `AWS.providers()` `any`.
  - `wiki/alchemy/cli-and-deployment.md`, `aws-domains-and-http.md`, `outputs-and-references.md` updated as specified (destroy/borrower, binding ref, plan-time `undefined` attributes).
  - Relative-link check over `wiki/**/*.md`: none broken.
- **Tests:** Documentation; no automation.
- **Verify:**
  - Run the relative-link check over `wiki/**/*.md`; expect none broken.
  - Confirm each new wiki statement cites its source: an Alchemy docs URL, a beta.77 source path, or research F-number.

## Final acceptance

- **Checks:**
  - `pnpm check` green.
  - T1's plan shows exactly one create (plan output cannot show retention; T3's state read does).
  - T3's state read shows `removalPolicy: "retain"`.
  - T4 passes on both cycles: `dkim=pass header.d=mail.example.com`; `h=` covering both unsubscribe headers; unchanged `LastKeyGenerationTimestamp`; no `DeleteEmailIdentity`; IAM on the `mail.example.com` ARNs.
  - Relative-link checks clean over `README.md`, `.adr/` and `wiki/`.
- **End state:**
  - The account holds exactly one Emailer-related long-lived resource set: the `mail.example.com` identity in `EmailerSending/shared` and its three `CNAME`s.
  - No Emailer test stage exists.
  - `example.com` has no SES identity and no DKIM records.
  - ADR-0009 is Accepted (or revised for the fallback), and ADR-0001/0002/0004 carry their links.
- **Operator steps:** T3's DNS write needs explicit user confirmation naming `example.com`. Retained resources are intentional and listed in the Handoff.
- **Deferrals or blockers:**
  - **Automated DKIM regression check** (deferred): it would need the live suite to read the operator mailbox, which means a cross-project OAuth credential in the test environment. T4's manual gate is the acceptance for now.
  - **SPF and DMARC** for `mail.example.com` remain open under ADR-0002's Consequences.
  - **Production in a separate AWS account** would require one `EmailerSending` deployment per account (ADR-0009 Consequences).

## Handoff

- **Next action:** None.
- **Deviations:**
  - T4 headers were read with `the mailbox CLI messages source` (archived rfc822) because this session's the operator mailbox MCP was `auth required`. Same archive `mailbox_get_message_headers` reads. Not a product change.
  - T1 and T2 were implemented in the parent checkout (shared `Mailer.ts`); T3–T7 likewise (live ops and docs). Independent review was delegated at T1+T2 and at full-plan close.
- **Resources:** Shared checkout `the repository`; no worktree. Reviewer subagents completed with no extra resources. Planning documents remain untracked until a later commit. **Retained in AWS:** `mail.example.com` SES identity (`EmailerSending/shared`, `removalPolicy: retain`) and three DKIM `CNAME`s in `example.com` (`Z00000000000000`). Intentional and permanent.
- **Reviews:**
  - Plan review (prior): [sending-identity-review.md](sending-identity-review.md). Dispositions recorded below.
  - T1+T2 implementation review: [sending-identity-t1t2-review.md](sending-identity-t1t2-review.md). Findings: none. Closure: Clear. Parent accepted (re-inspected diffs; parent-run `alchemy plan` covers the skipped plan re-run).
  - Full-plan implementation review: [sending-identity-implementation-review.md](sending-identity-implementation-review.md). Findings: none. Closure: Clear. Live T3/T4 rows Unverifiable for the reviewer (not re-probed); parent holds that evidence. T7 citation Partials (ses recreate trap, nuke row, two outputs-and-references bullets) dispositioned **Fix now** — sources added; not re-reviewed (citation-only).
- **Retained resources after implementation:** the `mail.example.com` SES identity (`EmailerSending/shared`, `retain`) and its three DKIM `CNAME`s in `example.com`. These are intentional and permanent.
- **Complexity gate:** Built-in gate applied (no separate `decomplex` run). The plan adds one small stack file, one shared-constants module and one `tsconfig` include, and introduces a deploy-order rule. It removes the per-run DNS publish and delete routine, and every manual DKIM teardown step. A smaller alternative (ADR-0009 alternative 1, retain in place) was weighed and kept as the fallback. It was re-weighed on 2026-09-14: its refusal of a second same-account stage is real in beta.77 (`Plan.ts:1298-1316`), so the second stack stands, justified by the account-level ownership boundary and the absence of a long-lived Emailer stage (F16).
- **Reviews:** [Independent plan review](sending-identity-review.md). Eight findings and two suspicions. Dispositions:
  - **R1 (High) — Accept.** Confirmed in source: a referenced identity's `emailIdentity` resolves through `process.env` and is `undefined` at plan time, so "take the domain from the reference" would have failed T4's first plan. The user chose to keep `EMAILER_SENDER_IDENTITY` in both stacks. T2 no longer changes `mailerAddresses`, and T4's fallback trigger is narrowed to failures of the reference itself.
  - **R2 — Accept.** T5's grep is case-insensitive with working patterns, plus a line-by-line review of the former ranges.
  - **R3 — Accept.** The role is found through the function; policies are inline.
  - **R4 — Accept.** The mismatch test uses `Effect.exit`, and a parent-domain `belongsToIdentity` case is added.
  - **R5 — Accept.** The `tsconfig` check uses `tsc --listFilesOnly`.
  - **R6 — Accept with correction.** The departure is from ADR-0001 `:13` _and_ `:14`, not only `:14`; `:19` supports the separate module.
  - **R7 — Accept.** ADR-0004 is rewritten in place; historical work-document notes are dropped.
  - **R8 — Accept as mitigation.** With the env key kept, the plan documents that changing it replaces the identity, and T4 asserts the two stacks agree.
  - **S1 — Accept.** `--env-file` is added to the state read.
  - **S2 — Already covered** by T3's state read.
  - **Re-review — Clear.** All nine corrections were verified: the replacement claim against `EmailIdentity.ts:275-284` and `Apply.ts:2164-2173`, and `tsc --listFilesOnly` against the installed `7.0.2`. Two low-severity leftovers were applied:
    - **RR1:** T5's grep extended; it now matches all eight stale README lines.
    - **RR2:** four lines still describing the old design corrected, plus a caveat on T7's wiki note that a reference's attributes are `undefined` at plan time.
  - The drift wording was corrected in the plan and ADR-0009: the refusal is an IAM `AccessDenied` reported as `SubmissionUncertain`, not an SES rejection.
- **Second check (2026-09-14):** every disposition above re-verified against the live Alchemy docs, the installed beta.77 source, the Effect RC112 source and a live probe (Research). Changes applied to this plan and ADR-0009:
  - T1: the scoped lint comment mirrored from `alchemy.run.ts:14`, and the stack-root (FQN) rule.
  - T2: the mismatch test names `Effect.exit`, `Exit.isFailure` and `Cause.findDefect`.
  - T4: the fallback trigger narrowed to `InvalidReferenceError` or a missing IAM grant.
  - T5: README rows for the two new files, and the destroy-does-not-need-the-owner rule.
  - T7: wiki rows for the destroy finding and the `providers()` typing hole.
  - ADR-0009: "Destroying the owner" now says plan and deploy fail while destroy works; "Undocumented path" became "Partly documented path".
  - Decisions confirmed and left alone: the separate stack, the env key read by both stacks (R8 residual, accepted by the user), manual DNS (F11), deferred DKIM automation.
  - Outside this plan: SPF and DMARC remain open under ADR-0002 and are the next deliverability step.
