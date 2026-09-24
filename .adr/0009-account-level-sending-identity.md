# ADR-0009: Account-level sending identity, created once and retained

- Status: Accepted
- Date: 2026-09-14
- Accepted: 2026-09-14
- Authority: The user chose `mail.example.com` as the sending domain, and `EmailerSending` at stage `shared` for the owning stack, on 2026-09-14, after the investigation recorded in shared sender identity research (`work/shared-sender-identity-research.md`, in git history), and accepted the design for implementation pending the go/no-go gate in the plan (`work/sending-identity.md`, in git history). The gate passed on 2026-09-14: two Emailer `test` deploy/send/destroy cycles delivered `dkim=pass header.d=mail.example.com` with unchanged `LastKeyGenerationTimestamp` and no `DeleteEmailIdentity`.
- Supersedes in part: [ADR-0002](0002-domain-sending-identity.md)'s per-stage identity lifecycle, its `example.com` domain choice, and its propagation-race explanation with the `INSYNC`/`dig` obligation built on it. Also two clauses of [ADR-0001](0001-resource-owning-effect-services.md): "Keep one root `alchemy.run.ts`", since the identity has its own stack; and the SES identity's placement inside `Mailer.ts`, which keeps its service, configuration set, send binding and implementation. ADR-0001's own allowance for "a small separate resource module … if a concrete shared ownership need arises" is the need met here.
- Extended by: [ADR-0010](0010-aligned-mail-from-spf-and-dmarc.md) — MAIL FROM, SPF and DMARC records join the retained inventory.
- Superseded in part: [ADR-0017](0017-adopted-root-domain-sending-identity.md) — the `mail.example.com` domain choice and "created once": the root-domain identity is adopted, not created.
- Superseded in part: [ADR-0018](0018-optional-dns-management.md) — "published **once**, operationally" and alternative 5: with `EMAILER_DNS` the stack declares the records itself.
- Amended: 2026-09-24, in the simplification plan (`work/simplify.md` T4) — clerical: the mailer answers an uncertain submission with an `uncertain` outcome, no longer a `SubmissionUncertain` failure, so identity drift is reported as that outcome.

## Context

The SES domain identity has been declared inside the per-stage Emailer stack since the first campaign slice. Every ephemeral `--stage test` destroy deleted it and every deploy recreated it. CloudTrail records eight `CreateEmailIdentity` and seven `DeleteEmailIdentity` calls for `example.com` between 2026-09-11 and 2026-09-14, once only 27 seconds apart.

Easy DKIM tokens are deterministic per domain, and all eight creations returned the same three. After that history, the key SES published under the reused selector matched the signing key of none of five messages from three generations. That was demonstrated by RSA-opening each signature with the published key, with the `amazonses.com` signature on the same messages as a control.

A never-created subdomain identity, sent to through the same account, Region, request shape and receiver, passed DKIM 73 seconds after key generation. No defect was found in application or infrastructure code (research F13–F15).

Two platform facts shape the design:

- SES allows one identity per domain per account and Region. Alchemy's stage isolation relies on generated physical names, which a domain identity does not have (F5).
- References read Alchemy's state store, and `AWS.state()` is an account-regional S3 bucket, so references cannot cross AWS accounts (F8, F16).

## Decision

The sending identity is **account-level infrastructure, created once and never deleted**.

- A separate one-shot stack, `stacks/sending-identity.ts` (Stack `EmailerSending`), declares `AWS.SES.EmailIdentity` for **`mail.example.com`** with Easy DKIM, `RemovalPolicy.retain()` and `AWS.state()`. It is deployed once per AWS account and Region at the pinned stage `shared`.
- Every Emailer stage references that identity with `AWS.SES.EmailIdentity.ref(<logical id>, { stack: "EmailerSending", stage: "shared" })` and binds `AWS.SES.SendEmail` to the reference. Test stages stay fully ephemeral; destroying them never touches the identity.
- Both stacks read `EMAILER_SENDER_IDENTITY`. The identity itself comes from the reference, while the Emailer's From-address check (`belongsToIdentity`) keeps using the configured value. A referenced identity's attributes cannot be read during construction at plan time: yielding an `Output` registers a Lambda environment variable and reads `process.env`, which is unset at plan.
- The three DKIM `CNAME` records are published **once**, operationally, targeting `<token>.<SigningHostedZone>` as returned by `GetEmailIdentity`, never a hardcoded zone. They are never deleted while the identity exists.
- `example.com` is abandoned as a sending identity. It has no identity and no DKIM records.

## Alternatives considered

1. **`RemovalPolicy.retain()` inside the Emailer stack, no reference.** One line, documented (F1), and it stops the churn. But ownership stays tagged to one stage, so a second stage in the same account would fail with `OwnedBySomeoneElse` (F2). It remains the fallback if the reference path fails the gate.
2. **Owner and borrower in the same stack, keyed on stage.** This is the pattern the Alchemy docs lead with (F4), but it presumes a long-lived stage that exists for its own sake. The Emailer has none, and a permanent full Emailer stage solely to own an identity is not documented either (F16).
3. **Keep `example.com` and recreate it once more, retained.** Unproven: none of the seven earlier recreations yielded a matching key, including one 3½ hours after deletion.
4. **Keep `example.com` with BYODKIM.** Likely to work, because it bypasses SES's published record. But Alchemy beta.77's provider cannot manage it, and declaring `dkimSigningKeyLength` would silently revert it to `AWS_SES` (`EmailIdentity.ts:338`). It also adds a private key to store and rotate.
5. **Declare the DKIM records as `AWS.Route53.Record`.** In beta.77 the provider silently adopts and overwrites existing records in a live zone (F11). Records that are published once do not justify that exposure.

## Consequences

- **Deploy order.** The `EmailerSending` stack must be deployed to `shared` in the same account and Region before any Emailer plan or deploy. Otherwise the Emailer's plan fails with `InvalidReferenceError`.
- **Destroying the owner.** Destroying `EmailerSending` leaves the identity in SES, because it is retained, but drops its state row. Every Emailer plan and deploy then fails with `InvalidReferenceError` until `EmailerSending` is redeployed. Destroying an Emailer stage still works: destroy plans against an empty desired state and resolves no references (`Plan.ts:2127-2138`, verified by a live probe on 2026-09-14). Redeploying silently re-adopts the identity through its unchanged stack, stage and logical-ID tags, with no create and therefore no new DKIM key (F2, F16).
- **`alchemy unsafe nuke`** enumerates and deletes every SES identity it can see, regardless of retention. Any run must exclude `AWS.SES.*` (F6).
- **Separate production account.** If production moves to its own AWS account, each account gets its own `EmailerSending` deployment and its own sending identity, because references cannot cross the account-regional state store.
- **Partly documented path.** The References page says a reference can be passed "anywhere the real thing is accepted", but no Alchemy example passes one into an AWS binding during a Lambda's construction phase (F16). Construction and plan-time resolution through `SendEmail` were demonstrated with a local probe on 2026-09-14. Deploy, the IAM grant and a verifying send are proven by the plan's go/no-go gate, not assumed.
- **SPF and DMARC.** Published under ADR-0010; see there for the records.
- **ADR-0004's DKIM-coverage confirmation must be re-established.** The 2026-09-12 check read `List-Unsubscribe` coverage from the `d=example.com` signature, which never verified, and RFC 8058 requires a _valid_ signature. The gate re-confirms coverage on a verifying `mail.example.com` signature.
- **Changing the domain replaces the identity.** `EMAILER_SENDER_IDENTITY` is the prop whose change plans a replacement, so deploying `EmailerSending` with a different value plans a replacement. That creates a new identity and leaves the old one retained but untracked. If the two stacks' values drift, the Emailer's From check passes on its own value, but the role's grant covers only the referenced identity, so the send is denied (IAM `AccessDenied`, reported as an uncertain outcome) and no mail goes out.
- **IAM scope.** The send binding's grant moves from `identity/*@example.com` to `identity/*@mail.example.com`.
- **Another project on this account shows the same pattern.** Another project's `mail.other.example.net` identity was recreated nine times across its `prod`, `dev` and `dev-max` stages. It is outside this decision.

## Confirmation

The plan's gate deploys and destroys the Emailer `test` stage **twice** against one `EmailerSending` deployment. Both cycles must deliver a message whose `Authentication-Results` show `dkim=pass header.d=mail.example.com`, with `h=` covering `List-Unsubscribe` and `List-Unsubscribe-Post`. After both destroys, the identity must still exist with an unchanged `LastKeyGenerationTimestamp` and no `DeleteEmailIdentity` in CloudTrail.

## References

- Shared sender identity research (`work/shared-sender-identity-research.md`, in git history), F1–F16
- Sending identity plan (`work/sending-identity.md`, in git history)
- [ADR-0001: Resource-owning Effect services](0001-resource-owning-effect-services.md)
- [ADR-0002: Domain sending identity with Easy DKIM](0002-domain-sending-identity.md)
- [ADR-0004: Sender-owned one-click unsubscribe](0004-sender-owned-one-click-unsubscribe.md)
- [Alchemy: References](https://alchemy.run/infrastructure-as-code/references)
- [Alchemy: Resource lifecycle › Removal policy](https://alchemy.run/infrastructure-as-code/resource-lifecycle#removal-policy)
- [Amazon SES: Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html)
- [Amazon SES: Managing Easy DKIM and BYODKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy-managing.html)
