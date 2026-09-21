# Clean codebase implementation review

- Date: 2026-09-14
- Target: commits `1c2e01f..73ac6e3` on `clean-codebase` — T1, T4, T2 and T3.
- Reviewer: independent agent, given the plan and both ADRs and no conclusions of the implementer's.
- Method: isolated detached worktree at `73ac6e3` with workspace links re-pointed at that tree, so
  the reviewer was unaffected by work in progress on the main checkout. 410/410 unit tests and
  `tsc --noEmit` green there. Findings were reproduced by execution, not by reading alone.

## Findings and dispositions

### R2 — A finalize-phase send failure lost its storage classification

**Finding (Low, confirmed).** `Campaigns.send` wraps a `StorageFailure` from `finalizeCampaign` in
`SendFailure`, and `reportSendFailure` reduced the cause to the name `StorageFailure` — dropping the
`operationId` and the `unavailable`/`corrupt` classification the failure was still carrying. Proved
under a collecting logger. Scenario: SES accepts the message, the finalizing transaction is
throttled; the campaign stays `unconfirmed` with mail already delivered, and the operator's one log
line cannot distinguish a throttle (retry) from a corrupt item (repair). The plan requires that
classification to survive to the boundary.

**Disposition: Fix now.** `reportSendFailure` unwraps a `StorageFailure` cause and records its
operation and classification alongside the phase. A submission cause keeps its own tag, which _is_
its classification. Two cases in `Diagnostics.test.ts` assert the exact recorded fields for both.

### R3 — The feedback read schema was stricter than the writer

**Finding (Low, confirmed mechanism).** T3 gave `StoredFeedback` domain rules the ingest schema does
not enforce: `recipient` as a full address and the provider's classifications as non-empty strings.
The consumer could therefore durably persist a record `readCampaignFeedback` then reports as
`corrupt` — permanently, because `FeedbackStore` holds `PutItem` alone and nothing can remove it.
Proved through the real writer and reader: `user@[192.168.1.1]`, `postmaster@localhost` and an empty
`bounceType` all wrote successfully and read back corrupt. This was T3's one behaviour regression.

**Disposition: Fix now**, and at the schema rather than at ingest. Rejecting these events on the way
in would be worse than storing them: the suppression is the part that stops mail to a hard-bouncing
address, and dropping the event to protect a read would keep sending. The stored schema now says
what the writer can actually produce — our own fields keep our rules, the recipient and the four
provider classifications are strings, because they are whatever the mail system reported. Three
round-trip cases in `Storage/Feedback.test.ts` pin it. A read must not be able to refuse a write.

### R4 — A vacuous assertion

**Finding.** `Storage/Items.test.ts` asserted `Object.getPrototypeOf(value)).not.toBe("evil")`, which
can never fail.

**Disposition: Fix now.** Replaced with `toBe(Object.prototype)`, which is the claim that matters:
the `__proto__` key stayed data instead of becoming the object's prototype.

## Areas the reviewer cleared, with evidence

- **Unsubscribe token.** A fourteen-case adversarial probe — trailing newline, `V1`, doubled
  separator, padded base64, raw base64 `+`/`/`, non-ASCII, NUL, CRLF, non-canonical case, leading-dot
  local part, IP-literal and dotless domains — rejected everything it should. Order is length,
  structure, signature, then decode, so nothing attacker-supplied is decoded before the HMAC. Every
  log call site in `apps/backend/src` was audited for address, token or URL disclosure and none
  carries one; `Effect.fn` in RC112 attaches no argument attributes to its span, so the pervasive
  `Effect.fn("Storage.…")(email)` calls do not leak either.
- **Import holder check.** A reservation deleted, moved or reassigned between the advisory read and
  the commit fails the condition — a missing item fails `contactId = :holder` too — so no membership
  write can commit for an address the contact no longer holds. Twenty candidates is 81 actions.
- **IAM narrowing.** Binding construction appears only in the four `*StoreLive` layers and matches
  ADR-0008 exactly. No transitive construction: `Addresses.ts` → `Feedback.ts` is `import type`, and
  `Api.ts` yields the bare `UnsubscribeFunction` tag rather than the inline class.
- **Batch completeness.** A short read cannot succeed; retries are bounded at four; the deadline sits
  on the whole operation rather than per attempt; pending keys are re-keyed with `ConsistentRead`
  re-set. The private `IncompleteBatch` signal never escapes as a failure type.
- **Error boundaries.** No internal cause reaches an HTTP response or a log body. The one
  framework-rendered path was reproduced with a realistic transport error wrapping a DynamoDB
  request: message and URL only, no request body, no mailbox. Nothing that should end an invocation
  becomes a success.
- **Test decisiveness.** The reviewer applied the revert test to six named behaviours — short reads,
  the whole-operation deadline, the import holder check, the raw-cause log, the fatal feedback
  boundary and the unsubscribe durability — and each test fails when its behaviour is reverted.

## Verification limits

This review covers T1–T4 as committed, not the deployed system. Effective runtime IAM, the live
stale-import interleaving, destination capture and replay, cold starts and DKIM coverage of the two
unsubscribe headers belong to T9 and were not verified here. T5–T8 were implemented after this
review ran and are covered by the final review instead.
