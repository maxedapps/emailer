# Shared sender identity — Alchemy research

> **Status:** Complete — the decision is drafted as [ADR-0009](../0009-account-level-sending-identity.md) and planned in [sending identity](sending-identity.md)
> **Updated:** 2026-09-14

## Question

The SES domain identity `example.com` is declared inside the per-stage Emailer stack (`apps/backend/src/Mailer.ts`, logical ID `EmailerSender`). Every ephemeral `--stage test` destroy deletes it, and the next deploy recreates it. What does Alchemy document — and what does beta.77 actually implement — for keeping such a resource alive across stage lifecycles and sharing it between stages?

## Scope and constraints

- Target version: `alchemy@2.0.0-beta.77`, installed. Live docs at alchemy.run may be newer; where docs and installed source disagree, the installed source governs.
- Sources: the live docs as raw markdown (`https://alchemy.run/<page>.md`), the installed package source, and the project wiki.
- Research only. No change to the stack, the identity or DNS.

## Known context

- SES allows one `example.com` domain identity per account and Region; stages do not isolate it.
- 2026-09-14 13:06:02Z: the test deploy recreated the identity. SES reported `LastKeyGenerationTimestamp` at that instant, with the same three Easy DKIM selector tokens as before.
- 13:08:40Z: a campaign sent to `dmarc@reports.example.net` drew `dkim=fail (verification failed) header.d=example.com` at Cloudflare. An independent `mailauth` verification against the key served by all four authoritative nameservers also reports `bad signature`, with the body hash matching. The published key did not match the signing key.
- A background poll re-verified that same message against the authoritative key every two minutes until 13:56Z. The key never changed and the signature never verified (F13); the poll was then stopped.

## Findings

Sources are the live docs as raw markdown (`https://alchemy.run/<page>.md`, section indexes at `<section>/index.md`), retrieved 2026-09-14, and `alchemy@2.0.0-beta.77` source under `node_modules/alchemy/src`.

### F1 — Retention is documented, stage-conditionable, and drops ownership

[Resource Lifecycle › Removal policy](https://alchemy.run/infrastructure-as-code/resource-lifecycle#removal-policy):

> | `retain` | Skips `provider.delete`, then drops the state row |
>
> Under `retain`, alchemy forgets the resource either way — only the cloud object survives.

The page gives a stage-conditional form: `RemovalPolicy.retain(stack.stage === "prod")`. It also warns: "Retain a resource **before** the deploy that would remove it". [destroy › Retained resources](https://alchemy.run/cli/destroy) adds: "the orphan sweep reads the policy from the state row, not from your code."

Installed source agrees (`RemovalPolicy.ts`). The policy is captured per resource when it is registered (`Resource.ts:465`).

### F2 — Ownership is stack + stage + logical ID; a different owner is refused

[Adopting Resources](https://alchemy.run/cli/adopting-resources):

> "Owned" means the provider can prove the resource was created by _this_ stack/stage/logical-id — typically by inspecting tags or a naming convention.

The engine routes as follows:

| `read` returns | Without adoption          | With adoption |
| -------------- | ------------------------- | ------------- |
| `undefined`    | create                    | create        |
| owned          | silent adopt              | silent adopt  |
| `Unowned`      | fail `OwnedBySomeoneElse` | take over     |

The SES provider implements exactly this. Its `read` compares `alchemy::stack`, `alchemy::stage` and `alchemy::id` tags (`Tags.ts:82-94`; `AWS/SES/EmailIdentity.ts:260-273`).

Consequence: an identity retained by `test` is silently re-adopted by the next `test` deploy and refused by every other stage or stack.

### F3 — Docs/source conflict: `adopt()` _can_ be scoped to one resource in beta.77

The live docs say the `adopt` combinator "must wrap the _deploy_ … — not the inner resource-declaration effect", and that `--adopt` "is provided as a single `AdoptPolicy` layer over the whole stack execution, not per resource."

The installed source says otherwise, and the installed source governs:

- `Resource.ts:133-137` documents a "Per-resource adoption policy captured from the ambient AdoptPolicy at registration time (e.g. via `.pipe(adopt(true))`)".
- `Resource.ts:468` captures it.
- `Plan.ts:1316` resolves `resource.Adopt ?? shouldAdopt`.
- The `AdoptPolicy.ts` header comment says the override is "most commonly applied at the resource or stack scope."
- The mailbox stack already pipes `AdoptPolicy.adopt()` onto a single resource.

So a one-time takeover of just the identity is possible without the stack-wide `--adopt` flag.

### F4 — The documented idiom for this problem is owner/borrower via `Resource.ref`

[References](https://alchemy.run/infrastructure-as-code/references):

> The ref has the same type as `yield* Neon.Project("app-db", { … })` — pass it anywhere the real thing is accepted. Here `staging` owns the database and `pr-*` stages borrow it; destroying a borrower never touches the Resources it references.

[Shared database across stages](https://alchemy.run/cloudflare/data/shared-database) names the category:

> Most resources should be isolated. But some — a Neon Postgres project, a shared S3 bucket, a global rate limiter — are too expensive or too stateful to re-provision per stage. PR-preview stages should _point at_ the shared instance instead.

The canonical shape is a stage-conditional declaration inside the same stack:

```text
const { stage } = yield* Alchemy.Stack;
const project = stage.startsWith("pr-")
  ? yield* Neon.Project.ref("app-db", { stage: "staging" })
  : yield* Neon.Project("app-db", { region: "aws-us-east-1" });
```

Teardown: "deletes the branch but leaves the shared project alone — Alchemy doesn't own it from this stage's perspective." A cross-stack form exists: `Resource.ref(id, { stack: "shared-infra", stage: "prod" })`. So does a per-PR owner (`stage: \`staging-${stage}\``).

Deploy order is strict. The references page says: "The upstream must already be deployed to the exact `{ stack, stage }` the reference names, or the plan fails fast with a typed `InvalidReferenceError` — there is no deploy-and-hope path … Destroy in reverse order."

Installed source agrees (`Output.ts:663-684`; `Resource.ts:72` `ref(id, { stage?, stack? })`).

### F5 — Stage isolation depends on generated physical names, and the SES identity has none

[Stages](https://alchemy.run/environments/stages) says: "Each stage gets its own … **Physical names** … Because of this, deploying or destroying one stage **never touches** another." That guarantee holds only for resources whose physical name Alchemy generates from stack, stage and logical ID.

An SES domain identity's physical name _is_ the domain. It is one per account and Region, regardless of stage. The project wiki already records this: "Stage names do not isolate account-wide quotas or singleton settings; SES quotas and reputation are examples" (`wiki/alchemy/environments-and-state.md:11`).

### F6 — `nuke` ignores retention and ownership

[nuke](https://alchemy.run/cli/nuke):

> `nuke` is **not** scoped to a stack, a stage, or the state store … each provider's `list()` then enumerates **every** resource of that type in the ambient account/region/zone — including resources alchemy never created — and deletes them all.

The SES provider implements `list`. A retained or shared identity is therefore not protected from `alchemy unsafe nuke` unless the run uses `--exclude 'AWS.SES.*'` or a `--filter`. The command is hidden from `--help`.

### F7 — First-party precedent: account-level singletons live in their own stack

[AWS Part 5: CI/CD](https://alchemy.run/aws/tutorial/part-5) puts the GitHub OIDC provider in a separate `stacks/github.ts`. That provider is an IAM singleton, one per account per issuer URL, the same class of resource as an SES domain identity. The tutorial calls it "a one-shot stack you'll deploy from your laptop", deployed with `alchemy deploy --config stacks/github.ts --profile admin` and sharing `AWS.state()`: "You only need to re-run this stack when you want to change the role".

The tutorial does **not** pin `--stage` for that stack, so each operator gets `live_$USER`. A stack that others reference must pin its stage.

Supporting passages:

- [Stacks](https://alchemy.run/infrastructure-as-code/stack): "**any TypeScript file with a default-exported Stack works**".
- [Monorepo](https://alchemy.run/project-structure/monorepo): "Go **Multiple Stacks** when you need to `destroy` one package without touching the other."
- [Branch from a shared database](https://alchemy.run/cloudflare/data/branch-from-shared-database), whose examples include "a DNS zone": "Anywhere a per-stage copy is wasteful, lift it to a long-lived stage and reference it from the rest."

### F8 — References need a shared state store; the Emailer already has one

[State Store](https://alchemy.run/state-store): "State is scoped by **stack name** and **stage**". References read that store at plan time. The Emailer uses `AWS.state()` (`alchemy.run.ts:16`), which the AWS tutorial describes as storing state "in an account-regional S3 bucket. Every deploy — local or from CI — reads and writes state through that bucket." A cross-stack reference therefore resolves from any machine.

### F9 — A ref to an identity satisfies the SES binding by construction

The SES send binding reads only `identity.emailIdentity` and `identity.identityArn` (`AWS/SES/BindingHttp.ts:283-318`). Both are `Output` attributes, which a ref resolves. [Phases](https://alchemy.run/infrastructure-as-effects/phases) says Construction "**Resolves infrastructure references at deploy time** — bindings know which bucket ARN, queue URL, etc. to inject". So no state read is expected inside a running Lambda.

The stage-conditional form needs `Stack` during construction. `Api.ts:97` and `UnsubscribePage.ts:128` already use `const { stage } = yield* Stack` in deployed code.

_Not verified:_ no first-party example passes a ref to an AWS binding. The binding's label template interpolates the identity, so a ref may rename the IAM binding once. Confirm with `alchemy plan`.

### F10 — Migrating ownership deletes the resource unless retained first

[Migrating from v1](https://alchemy.run/migrating-from-v1) warns:

> After adopting, **do not run `destroy` in your v1 project** — its state still points at the same physical resources, so destroying the v1 stack would delete the resources v2 now manages.

Here, once a shared owner adopts `example.com`, the `test` stage still holds a row for `EmailerSender`. Either of these would delete the identity from under its new owner:

- a `test` destroy; or
- the first `test` deploy after the declaration becomes a ref, because the row is then an orphan.

[Issue #1404](https://github.com/alchemy-run/alchemy/issues/1404), closed 2026-09-05, is this exact incident in production. A `retain()` added with no prop change was not persisted, and moving the declaration to another stack "really deletes the live resource".

**Fixed in beta.77.** The installed no-op branch (`Apply.ts:703-750`) commits a changed `removalPolicy` and emits a `removal policy destroy → retain` note. beta.77 was published 2026-09-09. The operational lesson still applies: verify the policy reached state before removing the declaration.

`alchemy state delete <stack>/<stage>/<resource>` removes one record "local-only — the actual cloud resources are not touched" ([state](https://alchemy.run/cli/state)). It is an alternative, but the binding rows that reference the identity make it riskier than retain-first.

### F11 — DNS: the documented adoption safety is Cloudflare-only

[Domains & DNS](https://alchemy.run/cloudflare/networking/domains):

> If a record with the same `(name, type)` already exists in the zone — a hand-edited apex `A` record, an email DKIM/SPF entry — the deploy refuses to take it over unless you pipe `adopt(true)` … overwriting it silently would be the worst possible default.

The same page shows `adopt(true)` piped onto a single declaration, which agrees with F3.

AWS `Route53.Record` in beta.77 does **not** follow this. Its `read` never returns `Unowned` (`AWS/Route53/Record.ts:654-680`), so an existing record is silently adopted and overwritten by `UPSERT`. Its `delete` removes the live record and waits for `INSYNC`; `hostedZoneId` is optional and otherwise inferred. Declaring the DKIM CNAMEs is possible ([Record reference](https://alchemy.run/providers/aws/route53/record)), but offers no protection in a live zone.

### F12 — Neither Alchemy nor AWS documents SES recreation semantics

- [Sending & managing email](https://alchemy.run/aws/email/sending) and the [EmailIdentity reference](https://alchemy.run/providers/aws/ses/emailidentity) say nothing about retention, stage sharing, or DKIM behaviour on recreation. The same page gives `AccountSettings`, an "account/region singleton", a no-op delete; `EmailIdentity` gets no such treatment.
- [Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html) covers only key-length changes: "if you change keys too quickly or frequently, DNS may not be able to DKIM authenticate your email as the former key may already be invalidated."
- [DEED](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-deed.html) is multi-region replication and advises "Keep parent identities active". It does not cover same-region recreation.
- A search snippet claiming recreation yields "new DKIM tokens and a new key" is rejected. No primary page supports it, and it contradicts the identical tokens observed.

### F13 — Empirical: the published key signed none of four messages across two generations

Tested 2026-09-14 against the live `us-east-1` identity. Nothing was changed.

| Message                                | Identity generation    | Selector    | Header signature vs published key | RSA-open with published key       |
| -------------------------------------- | ---------------------- | ----------- | --------------------------------- | --------------------------------- |
| 09:32:27 (pasted headers)              | earlier deploy         | `tecne7g2…` | false                             | random bytes                      |
| 09:36:43 (pasted headers)              | earlier deploy         | `tecne7g2…` | false                             | random bytes                      |
| 13:08:40                               | key generated 13:06:02 | `tecne7g2…` | false                             | random bytes                      |
| 13:32:14 (26 min after key generation) | key generated 13:06:02 | `tecne7g2…` | false                             | random bytes                      |
| Control: `amazonses.com` on all four   | —                      | `224i4yxa…` | true                              | valid PKCS#1 + SHA-256 DigestInfo |

Method:

- Header-hash verification was implemented from RFC 6376 §3.7. It was validated by the `amazonses.com` control, and by agreement with Cloudflare and `mailauth` on the new messages.
- For "RSA-open", `sᵉ mod n` with the published key yields the PKCS#1 v1.5 structure only if that key produced the signature. Random bytes rule out header modification and canonicalization, and isolate a pure key mismatch.

Further observations:

- Both generations signed with the same selector, `tecne7g2…`, which confirms the tokens are stable across recreation.
- The authoritative servers publish a key only for `tecne7g2…`. `dujx…` and `gonw…` publish an empty TXT (`""`).
- The published key did not change between 13:10Z and 13:36Z.
- No `example.com` identity exists in any other Region, so a token collision across Regions is ruled out.

Inference, not proven: the key published under the reused selector belongs to neither recent generation. SES appears not to republish it when an identity is recreated under the same tokens. A message from the first generation would settle it, but none is available.

**Consequence for retention:** retaining is _necessary but not sufficient_. It stops creating new mismatches, but it does not repair an identity already in this state. A one-time repair is needed first, unless the poll shows the key converging on its own.

### F14 — Is it our code? Eliminations, and the churn record

The user asked whether our code is at fault rather than SES. Each suspect was tested directly.

| Suspect                                     | Test                                                                                                                                         | Result                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Location-dependent DNS answer               | Authoritative query with EDNS Client Subnet from six regions                                                                                 | Same key everywhere; ECS scope `/0`                                                                           |
| Wrong hosted zone in our CNAMEs             | `GetEmailIdentity.SigningHostedZone`, and the regional `dkim.us-east-1.amazonses.com`                                                        | SES returns `dkim.amazonses.com`, which matches our CNAMEs; no regional record exists                         |
| Application send path                       | `Mailer.ts` `makeSubmit`                                                                                                                     | Standard SES v2 `SendEmail`, `Content.Simple` plus two headers, no `FromEmailAddressIdentityArn`              |
| Infrastructure calls rotating the key       | CloudTrail, all SES calls 13:04–13:12Z                                                                                                       | One `CreateEmailIdentity` with no DKIM parameters, then reads only; no `Put*Dkim*` calls                      |
| An identity in another Region or via SES v1 | CloudTrail sweep of every Region: `CreateEmailIdentity`, `VerifyDomainDkim`, `VerifyDomainIdentity`, `PutEmailIdentityDkimSigningAttributes` | None outside `us-east-1` in 90 days                                                                           |
| Signing with another identity's key         | RSA-open with `mail.other.example.net`'s tokens                                                                                                   | That identity's keys are no longer published (deleted); `example.com`'s signature does not open with any key |
| Verification-method error                   | `amazonses.com` control on every message                                                                                                     | Always opens correctly                                                                                        |

**Churn record** (CloudTrail, `us-east-1`, local +02:00). There were eight `CreateEmailIdentity` and seven `DeleteEmailIdentity` calls for `example.com` between 2026-09-11 14:57 and 2026-09-14 15:06. One delete→create gap was 27 seconds (11:29:20 → 11:29:47). **All eight creations returned the identical three tokens.** `mail.other.example.net`, from a separate another project on this account, shows the same pattern: nine creations across `prod`, `dev` and `dev-max` stages, each returning identical tokens.

**Mismatch now spans three generations.** A Sep 12 09:01:01Z message (generation created 08:58:38Z), recovered from an earlier session transcript, also fails to open with the published key.

**Assessment.** No defect in our application or infrastructure code was found. What we are doing wrong is operational: a domain identity whose Easy DKIM tokens are deterministic has been deleted and recreated repeatedly, and after that the key SES publishes under those tokens does not match the key it signs with. Whether AWS would call this a defect is moot; AWS's Easy DKIM page already warns that "if you change keys too quickly or frequently, DNS may not be able to DKIM authenticate your email". Which generation the published key belongs to is unknown; generations 1–4 and 6 have no surviving messages.

**Next decisive test:** create a never-before-used subdomain identity once, publish its CNAMEs, send one message, and read the verdict. A pass shows that a non-churned identity works and that retention on a fresh identity is the fix.

### F15 — Controlled experiment: a never-recreated identity passes

Run 2026-09-14 in the same account, Region, pipeline and receiver as the failing sends, with the same request shape (`Content.Simple` plus `List-Unsubscribe`/`List-Unsubscribe-Post` headers). The only variable changed was the identity's history.

| Step                                                                                                                              | Time (UTC) |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Confirmed `dkim-check.example.com` never existed: `GetEmailIdentity` NotFound, no CloudTrail create or delete in 90 days, no DNS | —          |
| `CreateEmailIdentity` via AWS CLI, outside Alchemy, tag `purpose=dkim-churn-control-2026-09-14`; key generated                    | 13:49:00   |
| SES published a key under token 1 immediately; tokens 2 and 3 had **no record**                                                   | 13:49:xx   |
| Three CNAMEs created in `example.com` (Route 53), INSYNC                                                                         | 13:49:54   |
| SES `DkimStatus=SUCCESS`, `VerifiedForSending=true`                                                                               | 13:50:01   |
| `SendEmail` to `dmarc@reports.example.net`                                                                                     | 13:50:13   |

Result:

- Cloudflare: `dkim=pass header.d=dkim-check.example.com`.
- `mailauth` against live DNS: `pass`, body hash matching.
- RSA-open with the published key: valid PKCS#1 structure.

The send was 73 seconds after key generation, sooner than any of the failing sends.

Two contrasts with the churned `example.com` identity:

- **Verdict:** the fresh identity passes on its first message; the churned identity fails on every message from three generations.
- **Unused selectors:** the fresh identity has _no record_ under tokens 2 and 3, whereas `example.com` has _empty TXT records_ there, which look like leftovers from earlier generations.

**Conclusion (demonstrated, not inferred):** Easy DKIM works correctly for an identity that has not been recreated. The `example.com` failure is caused by its eight create/delete cycles under deterministic tokens, not by application code, request shape, sending pipeline or timing. Retention is therefore the right fix going forward. It does not repair `example.com` as it stands, so the sending identity should be created once on a name with no churn history, or `example.com` repaired by other means, and then kept for good.

**Torn down 2026-09-14 ~13:56Z**, verified against the account:

- `alchemy destroy --stage test` removed 16 resources, including the `example.com` identity for the last time.
- The `dkim-check.example.com` identity is deleted.
- All six DKIM CNAMEs are removed from `example.com`; its authoritative servers return NXDOMAIN.
- No Emailer Lambda, table, queue, alarm, role, log group, event rule or configuration set remains, and no Alchemy state exists for `Emailer`.
- The account's SES identities are back to the three pre-existing `existing.example.net` ones.

### F16 — Critical check: does "separate shared stack + retain + cross-stack ref" follow the docs?

**Documented and followed**

- Cross-stack `Resource.ref(id, { stack, stage })` for one shared resource: [References](https://alchemy.run/infrastructure-as-code/references) (`stack: "shared-infra", stage: "prod"`) and "Cross-stack too" in [Shared database across stages](https://alchemy.run/cloudflare/data/shared-database).
- A pinned stage: the References page says "Pin `stage` when the stacks' stages don't line up".
- `Resource.ref` rather than a Stack handle for a single resource: the References page says "Prefer `Resource.ref` and `yield* MyStack`", and the wiki (`outputs-and-references.md:48`) says "Prefer a resource reference when it needs one existing resource".
- A separate stack file deployed with `--config`: [Stacks](https://alchemy.run/infrastructure-as-code/stack) says any default-exported Stack works; [CI](https://alchemy.run/environments/ci) says "We recommend managing this with a dedicated `stacks/github.ts` that you deploy once locally".
- Splitting stacks for a different cadence and independent destroy: [Monorepo](https://alchemy.run/project-structure/monorepo), "Go **Multiple Stacks** when packages deploy on different cadences … or … need to `destroy` one package without touching the other."
- Deploy order and `InvalidReferenceError` handling: References page.
- Retaining a resource that is effectively irreplaceable: [Resource Lifecycle](https://alchemy.run/infrastructure-as-code/resource-lifecycle), where zones default to `retain` because "contents are irreplaceable". F13–F15 show that recreating an Easy DKIM identity breaks its signing, which puts it in that category.

**Deviations and gaps**

1. **Not the docs' primary pattern.** Every shared-resource guide leads with owner and borrower in the _same_ stack, keyed on stage (`stage.startsWith("pr-") ? X.ref(id, { stage: "staging" }) : X(...)`); cross-stack is the secondary variant. That pattern presumes a long-lived stage that exists for its own sake. The Emailer has none, and inventing a permanent full Emailer stage only to own an identity is not documented either. A further boundary: `AWS.state()` is "an account-regional S3 bucket" ([AWS Part 5](https://alchemy.run/aws/tutorial/part-5)), so a reference cannot cross AWS accounts. If production ever moves to its own account, as the wiki advises for isolation, a `prod`-owned identity could not serve a test account, while an owner stack per account can. Choosing cross-stack is therefore a reasoned judgement, not a documented prescription.
2. **Retaining the owner is our addition.** None of the shared-resource guides retains the owner resource; they protect it by keeping the owner stage alive. Retain adds protection against an accidental destroy of the owner stack, at a documented cost: "alchemy forgets the resource". After the owner is destroyed, the identity survives in SES but its state row is gone. Every borrower's plan then fails with `InvalidReferenceError`, because references read state, not the cloud. Redeploying the owner silently re-adopts the identity through its unchanged stack, stage and ID tags (F2), without creating it and so without generating a new key.
3. **Unproven path: a ref inside a Lambda binding.** The docs claim a ref can be passed "anywhere the real thing is accepted", but every documented ref example feeds _resource props at stack level_ (`Neon.Branch({ project })`, `Hyperdrive({ origin })`). None passes a ref into an AWS binding inside a Function's construction phase, which is our exact use (`AWS.SES.SendEmail(identity, mail)` in `MailerLive`). Source analysis (F9) supports it, but it must be demonstrated by `alchemy plan`, a deploy and a send before the design depends on it.
4. **The account-level precedent doesn't cover consumption.** `stacks/github.ts` is deployed without `--stage`, so it lands on `live_$USER` per operator, and the app stack never references it (GitHub consumes its outputs). The shared stack must pin its stage; the precedent is silent on that.
5. **Cost of multiple stacks.** Monorepo says "Start with a **Single Stack**"; multiple stacks cost "a deploy order". Accepted here for the documented reasons.
6. **Naming.** Stage `shared` is not a documented convention. The docs' example is `stack: "shared-infra", stage: "prod"`. Cosmetic.
7. **`nuke` ignores retain** (F6).

**Verdict:** consistent with Alchemy's documented mechanisms and its reasons for splitting stacks, and justified over the primary pattern by the account-regional state boundary and the absence of a long-lived Emailer stage. It is not a documented recipe. Its one load-bearing unproven step (3) must be the first thing verified. If it fails, the documented fallback is Option A: `RemovalPolicy.retain()` in the Emailer stack, with no reference at all.

## Documentation conflicts

| Topic                                        | Live docs                                                                              | beta.77 source / other docs                                                                                                     | Governs          |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Scope of `adopt()`                           | [Adopting Resources](https://alchemy.run/cli/adopting-resources): must wrap the deploy | `Resource.ts:468` per-resource capture; [Domains](https://alchemy.run/cloudflare/networking/domains) pipes it onto one resource | source           |
| Default stage                                | [Stacks](https://alchemy.run/infrastructure-as-code/stack): `dev_$USER`                | [Stages](https://alchemy.run/environments/stages): `live_$USER` for deploy; the wiki agrees                                     | Stages page      |
| DNS record adoption safety                   | Cloudflare records refuse existing records                                             | AWS `Route53.Record` silently overwrites                                                                                        | per provider     |
| "Destroying one stage never touches another" | [Stages](https://alchemy.run/environments/stages)                                      | false for singletons named by the user, such as SES domain identities                                                           | physical reality |

## Options

|                                                      | A. Retain in place                                  | B. Same-stack owner/borrower                                                      | C. Separate shared stack                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Shape                                                | `.pipe(RemovalPolicy.retain())` on `EmailerSender`  | `stage === "test" ? EmailIdentity.ref(id, { stage: owner }) : EmailIdentity(...)` | new stack file declares the identity with `retain()`; every Emailer stage uses `EmailIdentity.ref(id, { stack, stage })` |
| Documented as                                        | F1                                                  | canonical in F4                                                                   | F4 cross-stack form, F7 precedent                                                                                        |
| Survives `test` destroy                              | yes; re-adopted by the next `test` deploy (F2)      | yes                                                                               | yes                                                                                                                      |
| Survives destroy of the owner                        | n/a                                                 | only if the owner also retains                                                    | yes, with `retain()`                                                                                                     |
| Test and a future prod in the same account           | conflict: the other stage gets `OwnedBySomeoneElse` | works, if prod is the owner                                                       | works                                                                                                                    |
| Cost                                                 | one line                                            | needs a long-lived full Emailer stage; none exists today                          | one small stack plus a deploy-order rule                                                                                 |
| Matches the resource's real scope (account + Region) | no                                                  | no                                                                                | yes                                                                                                                      |

## Recommendation

**Superseded by the plan.** The recommendation below the Options table was written while `example.com` still existed and before F15 and F16. Three things have changed:

- **`example.com` is abandoned.** F15 showed a never-recreated identity passes, and seven delete/recreate cycles never produced a matching key. On 2026-09-14 the user chose the fresh subdomain **`mail.example.com`**. The old migration order (retain first, then adopt or recreate `example.com`) therefore no longer applies: the stage was torn down, and there is no existing identity to move.
- **Option C stands with F16's adjustments.** The owning stack is **`EmailerSending`** at pinned stage **`shared`** (user choice). The undocumented reference-in-binding path is the first live gate, and Option A is the explicit fallback.
- **The Emailer keeps `EMAILER_SENDER_IDENTITY`** for its From-address check. A referenced identity's attributes resolve through `process.env`, unset at plan time (plan review R1), so both stacks read the same key (user choice).

See [ADR-0009](../0009-account-level-sending-identity.md) for the decision and [the plan](sending-identity.md) for tasks, gate and verification.

## Open questions

None remain for the research. Implementation-time questions live in [the plan](sending-identity.md): the reference-in-binding gate (T4), and the user's confirmation before T3's DNS write.

## Next action

Implement [the plan](sending-identity.md), starting at T1.
