# ADR-0007: Immutable recipient unsubscribe links

- Status: Accepted
- Date: 2026-09-14
- Accepted: 2026-09-14
- Authority: The user requested the refactor plan and explicitly permits redeploying the application, erasing development data, and invalidating existing links. The user then requested implementation of the plan (`work/clean-codebase.md`, in git history), which accepts this record.
- Supersedes: ADR-0004's contact-ID token decision and ADR-0006's mutable-contact lookup residual; other consent policies remain in effect.
- Amended: [ADR-0020](0020-drafts-previews-and-test-sends.md) — the signing code moved to a shared `SignedToken` module that preview links use too. The token format and the secret are unchanged, and a frozen token in the tests pins them.
- Superseded in part: [ADR-0024](0024-typed-errors-and-cost-neutral-storage.md) for the POST's `PutItem`-only capability. It holds `UpdateItem` only and keeps the first opt-out with `if_not_exists` rather than a conditional put.
- Superseded in part: [ADR-0027](0027-signup-api-scoped-keys-and-double-opt-in.md) for the token's payload, which also names the list: the signed fields are `[base64url(mailbox), listId]`. The POST adds that list to the address's `optOuts` set. The shared signing module is now `Tokens`.

## Context

The current link signs a contact ID, then resolves that contact's current address when clicked. Editing the contact changes the link's meaning; deleting the contact makes the link unusable. Unsubscribe records already belong to canonical email addresses and outlive contacts.

## Decision

Use a versioned, signed canonical mailbox payload:

```text
v1.<unpadded base64url(mailboxKey(email))>.<lowercase hex HMAC-SHA256("v1." + payload)>
```

Mint from the same resolved address supplied to the durable send claim and SES, before claiming. Retain the existing Alchemy-owned signing secret. Verify bounded structure and signature before decoding; then require canonical encoding and a valid canonical mailbox. Derive the maximum token length from the shared email schema: currently 254 ASCII address bytes produce a 407-character token.

GET verifies and presents a confirmation form without storage access. POST writes the verified mailbox directly using a PutItem-only capability. Remove contact lookup, the missing-contact rejection, and contact-ID metadata from unsubscribe records. Preserve conditional first-write behavior, non-success on failed persistence, and the rule that an already opted-out contact cannot move to a different address.

Use a clean cutover. Do not implement a legacy token decoder, migration, or fallback to mutable contact lookup.

## Alternatives considered

- **Signed campaign/send reference:** requires a lookup and ties old links to send-record retention. A send ID is not an existing standalone lookup key.
- **Stored opaque token mapping:** hides the address in the URL but adds allocation, writes, lookup, and retention. No current revocation or URL-confidentiality requirement justifies it.
- **Immutable mailbox entity:** adds another identity model across contacts, imports, sending, and consent.
- **Encrypted token:** avoids a lookup but introduces encryption and nonce management without an established need.
- **Current signed contact ID:** authenticates an identifier but does not preserve the original recipient.

## Consequences

The mailbox is encoded, not encrypted, and can be recovered from the link. RFC 8058 permits plaintext or encoded recipient identity. Do not log the token, complete URL, or decoded address. Signing-key replacement still invalidates previously issued links; retain the resource across normal deployments.

The current router limit must increase to accommodate the actual token bound. Preserve one-click POST support without cookies, additional authentication, or redirects, and preserve DKIM coverage of both unsubscribe headers.

## Confirmation

Prove signature interoperability with an independent vector; malformed and maximum-size inputs through the real HTTP router; no writes on GET; both permitted POST encodings; durable idempotent POST; A-to-B contact edit and contact deletion without changing the link's target; and refusal to send after reimporting opted-out A. Verify a delivered message's link and DKIM coverage during the ephemeral deployment.

## References

- Implementation plan (`work/clean-codebase.md`, in git history), T4 and T9
- [ADR-0004](0004-sender-owned-one-click-unsubscribe.md)
- [ADR-0006](0006-consent-survives-a-contacts-address-change.md)
- [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html)
- [RFC 4648](https://www.rfc-editor.org/rfc/rfc4648.html)
- [Node 24 Buffer encodings](https://nodejs.org/docs/latest-v24.x/api/buffer.html)
- [Node 24 timingSafeEqual](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptotimingsafeequala-b)
- [SES header limits](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_MessageHeader.html)
