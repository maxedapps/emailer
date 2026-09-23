# ADR-0005: Contact identity and membership access paths

- Status: Accepted; the single-Storage-tag choice is superseded
- Date: 2026-09-11
- Accepted: 2026-09-12
- Superseded in part: [ADR-0008](0008-storage-capabilities-and-error-boundaries.md) replaces the exactly-one-`Storage`-tag choice with four capability services. The single table, its access paths, the `EMAIL#` reservation, the conditional transactions and the accepted cascade race all remain in effect.
- Superseded in part: [ADR-0011](0011-open-recipient-set-and-paced-dispatch.md) for the two-member audience probe (`readAudience` as a probe for the single-recipient send invariant).
- Amended: [campaign-listing](work/campaign-listing.md) — campaign META items join the listing index
- Superseded in part: [ADR-0023](0023-lists-carry-no-membership-version.md) removes `membershipVersion`. Membership writes check that the list exists instead of bumping it, the contact cascade needs no bump-free fallback, the list cascade deletes `META` on its own after the last page, and imports carry no bump. Every other clause here about the version is historical.
- Authority: The user asked for a contact-management slice to be built in parallel with consent/unsubscribe, and explicitly selected bounded custom attributes and list deletion as additional scope. The user accepted this record on 2026-09-12, after the [slice](work/contact-list.md) was implemented and its decisive checks were confirmed against a live `test` stage.
- Documentation corrected: 2026-09-15. The GSI migration and partition-splitting statements below are corrected against AWS documentation and the pinned provider. The selected projection and accepted cascade concurrency tradeoff are unchanged.

## Context

After the [first slice](work/first-campaign-slice.md) and the [feedback and suppression slice](work/feedback-and-suppression.md), contacts exist only as create-and-get-by-UUID. `readAudience` caps at two members because it is a probe for the single-recipient send invariant, not an audience read. There is no way to enumerate a list, find a contact by address, change one, remove one, or add more than one at a time, and nothing prevents two contacts sharing one email address.

That last gap is not cosmetic. Suppression is keyed by address (`SUPPRESSION#<address>`), and the parallel consent slice keys unsubscribe the same way. A contact model permitting duplicate addresses cannot be reconciled with consent that is address-scoped. The [contact management slice](work/contact-list.md) closes these gaps, deliberately confined to the audience data model: the send path is unchanged, and mailability remains invisible on a contact.

Three constraints shaped every decision below.

1. **Global secondary indexes cannot be read consistently.** The installed SDK is explicit — "Global secondary indexes support eventually consistent reads only, so do not specify `ConsistentRead` when querying a global secondary index" — and the types do not prevent the mistake; it fails at runtime. The repository already records the governing rule: _"A stale index result must not establish lock ownership or authorize an irreversible state transition"_ (`wiki/aws/dynamodb.md:67`).
2. **`TransactWriteItems` allows at most 100 actions and cannot target one item twice** (`wiki/aws/dynamodb-outbox.md:31`).
3. **`ClientRequestToken` is a ten-minute transaction window, not API idempotency** (`wiki/aws/dynamodb-outbox.md:33`).

## Decision

**One address derivation, in one file.** `Storage.ts`'s `suppressionAddress` moves to `packages/api/src/Schemas.ts` as an exported `mailboxKey`, beside `normalizeEmailAddress`, and is used for every address-keyed item: the new `EMAIL#` uniqueness reservation, `SUPPRESSION#`, and the parallel slice's `UNSUBSCRIBE#`. The derivation is unchanged — trim and lowercase in full — so the parallel slice's behaviour is unaffected. Uniqueness and consent are therefore case-insensitive, while the stored `email` preserves local-part case only, since `EmailAddress` already lowercases the domain at the HTTP boundary (`Schemas.ts:48-56`).

**Contact identity is a reservation item.** `CONTACT#<id>/META` and `EMAIL#<mailboxKey>/META` are written in one conditional transaction. A reservation conflict is a success-channel outcome mapped to a public `EmailAlreadyUsed`, following the existing treatment of `AddMemberOutcome` and `ClaimOutcome` — _"a conditional conflict can be a normal business outcome"_ (`wiki/aws/dynamodb.md:50`). The reservation doubles as lookup-by-address at no extra cost.

**Membership is stored in both directions, in one transaction.** Alongside the forward item `LIST#<listId>/MEMBER#<contactId>`, a reverse item `CONTACT#<contactId>/LISTOF#<listId>` is written in the same transaction, making contact→lists a strongly-consistent base-table query. Because the index below is sparse over contact and list `META` items only, **no index covers member items**: the reverse item is not redundancy layered onto an existing path, it _is_ the access path. This is the second option in the repository's own table — _"Lookup by external ID | Secondary index **or a dedicated lookup item**"_ (`wiki/aws/dynamodb.md:20`).

**Deletes are paged, and `META` is deleted last.** There is no tombstone and no marker state. Ordering `META` last is what makes a repeated `DELETE` resume, and `addMember`'s existing existence checks close the door the moment `META` is gone — its contact `ConditionCheck` for a contact delete, and its list `Update`'s own `ConditionExpression` for a list delete (both in `Storage/Membership.ts`).

Every cascade transaction carries an explicit bound, because one that exceeds 100 actions fails _identically on every retry_ and would leave an entity permanently undeletable:

- The **contact cascade** runs one 3-action transaction per membership — delete forward, delete reverse, bump that list — so no page arithmetic applies. A `ConditionalCheckFailed` in the bump slot means the list was concurrently deleted; that membership is then removed with a 2-action transaction carrying no bump.
- The **list cascade** pages its member query at 40, removing both directions plus one bump: 81 actions. The **final page carries no bump** and deletes `LIST#…/META` in its place, because the bump and the deletion address the same item — the shared `listKey` in `Storage/Lists.ts` — and a transaction may not target one item twice. That is safe: `claimCampaign`'s `ConditionCheck` fails on an absent list whatever version it expects (`Storage/Campaigns.ts`), giving `membership-changed` exactly as a bump would.
- The final contact transaction deletes `META` and the reservation together, **conditioned on the stored address still matching what was just read**, so a concurrent address change cannot strand a reservation. That condition also fails when the item is simply absent, so a condition failure there is returned as a **failure, not a success**; the client's repeated `DELETE` re-reads and completes. There is no in-request re-read-and-rebuild branch — resume already covers it.

**One sparse index, for listing only.** Two attributes, `gsi1pk` and `gsi1sk`, are written **only** to contact and list `META` items; `gsi1sk` is `<createdAt>#<id>`, giving created-order listing. Projection is `KEYS_ONLY`, and pages are hydrated through `BatchGetItem` with per-table `ConsistentRead: true`.

**Bulk import reports converged state.** For each submitted address the response gives its contact id and whether it is now a member — identical on every call. The batch is capped at 20.

**Storage is split by item ownership, before any new code is written.** `Storage.ts` becomes modules under `apps/backend/src/Storage/`: `Contacts` (`CONTACT#`/`EMAIL#`), `Lists` (`LIST#`), `Membership` (`MEMBER#`/`LISTOF#`), `Campaigns` (`CAMPAIGN#`/`SEND#`) and `Feedback` (`SUPPRESSION#`/`FEEDBACK#`), over a plumbing layer. There remains exactly **one** `Storage` service tag and one table owner; entity modules export plain operation groups that the plumbing composes into the same flat object the service exposes today.

The plumbing is **two** files rather than one. `Table.ts` holds the operation primitives, the single table declaration, the `Storage` tag and `StorageLive`, and so must import the entity modules to compose them — while each entity module needs the shared stored-record version when its own module body runs, to build its `Schema.Struct`. Under ESM a module's dependencies are evaluated before its own body, so a single plumbing file would have entity modules read an uninitialized binding: a temporal-dead-zone `ReferenceError` at import, which neither the type checker nor the linter reports. `Items.ts` therefore holds the leaf constants and attribute helpers and imports nothing from its siblings, and entity modules take **values** only from it and **types** only from `Table.ts` — type imports being erased, no runtime cycle can form.

## Alternatives considered

**A plain inverted index (`partition=sk, sort=pk`) serving both reverse lookup and listing.** Attractive because it needs no new attributes, and it is what the design first assumed. Rejected on three counts. It indexes _every_ item in the table, so every campaign send and every bounce event would write to it — the slice claims to be off the send path, and this would quietly break that claim. All `META` items share one sort-key value, so contacts, lists and campaigns would land in one index partition (`wiki/aws/dynamodb.md:22`). And listing would become a _filtered_ query, running into the empty-page-with-more-pages trap the wiki names explicitly (`:69`).

**Keeping the index non-sparse so contact→lists could be served from it, with no reverse item.** This is the cheaper design. Rejected because deleting a contact is an irreversible transition driven by a discovery read, and the index cannot be read consistently: discover-then-conditionally-claim repairs a _stale_ discovered item but not a _missing_ one. A membership written moments before a delete may not have propagated and would be orphaned by a cascade that never saw it — observable as a permanent 503 on send, since `Campaigns.send` maps a missing contact to `StorageUnavailable` (`Campaigns.ts:88-89`). The reverse item costs one action per membership, lowering the import ceiling from 33 to 24; the batch caps at 20 for headroom.

**A `deletingAt` tombstone closing the membership set before draining it.** Considered and rejected as disproportionate. `META`-last ordering already provides resumability, and `addMember`'s existing existence check already closes the window once `META` is gone. What the tombstone additionally buys is protection against a membership landing _during_ a cascade — a window of seconds requiring two simultaneous admin operations on the same entity. It would also have introduced a state with no defined meaning in any read path: a tombstoned contact would read as 200 from `GET`, 404 from `addMember` and 503 from `DELETE`. The residual is accepted below.

**An `INCLUDE` projection carrying email and name, to avoid hydration reads.** Cheaper per page, and DynamoDB maintains it automatically. Rejected because serving the projection directly accepts stale email/name values, whereas `KEYS_ONLY` plus a strongly consistent `BatchGetItem` returns current items and drops deleted ones. Both approaches can miss new entries pending index propagation. The original rationale also treated the projection as permanent; that was too broad. `isSameGsiDefinition` makes a direct same-name change replace the table in Alchemy beta.77, but a staged migration to a new index can preserve the table. The chosen hydration behavior remains the reason for `KEYS_ONLY`.

**A persisted idempotency record for bulk import** — caller-scoped key, request fingerprint and original result, per `wiki/aws/dynamodb-outbox.md:33`. Rejected as disproportionate for one endpoint. Defining the response as converged state achieves re-execution safety without new machinery, at the price of not reporting a delta.

**A typed "deletion incomplete" error with a `Clock` budget**, mirroring `SendNotAttempted`. Rejected: a list cascade clears roughly 49 memberships per transaction, which at the existing 25-second budget is about 12,000 members in one request, while import is capped at 20 per call. Beyond that the request times out and the client repeats the `DELETE`, which resumes. The precedent does not transfer — a send has an irreversible external effect that must not begin without time to record it; a delete has none.

## Consequences

- **Contact addresses become case-insensitively unique.** `Max@e.com` and `max@e.com` can no longer both exist — a deliberate narrowing that aligns identity with how consent and suppression already behave.
- **Every membership costs two items and two actions.** Import batches cap at 20 contacts per request; larger imports are a client-side loop. Asynchronous import jobs remain out of scope.
- **A concurrent `addMember` or import during a delete cascade can orphan a membership.** This is the accepted residual of dropping the tombstone. An addition after the final discovery read but before parent deletion still sees the parent and can commit. Repeating the parent delete returns missing and does not drain the orphan. The contact cascade's vanished-list fallback can remove an orphaned membership when that contact is subsequently deleted; it provides a cleanup path, not automatic eventual cleanup. This requires simultaneous admin operations on the same entity and remains an accepted tradeoff.
- **`membershipVersion` moves on every bulk import, including a no-op re-run.** The bump is unconditional, which is the safe direction: making it conditional on the advisory pre-read would mean that a concurrent `removeMember` between the read and the write lets the import re-add a membership _without_ moving the version — the audience changing while the version did not, which is exactly what `claimCampaign` exists to prevent.
- **The index is write-amplified only by contact and list creation**, never by sends or feedback, so the parallel slice's new item type is untouched.
- **The listing index can concentrate writes.** `gsi1pk` takes one value per entity kind and `gsi1sk` advances with creation time. DynamoDB can split item collections by sort key, including in GSIs, but monotonically increasing writes may remain concentrated at the newest end. Measure that traffic before adding write shards and fan-out queries. [AWS split-for-heat guidance](https://aws.amazon.com/blogs/database/part-3-scaling-dynamodb-how-partitions-hot-keys-and-split-for-heat-impact-performance/).
- **Changing the projection needs an index migration.** Directly editing this same-named GSI's schema or projection through Alchemy beta.77 plans table replacement. A differently named GSI can instead be added, made active and adopted by readers before removing the old index, preserving table data. [AWS online index operations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.OnlineOps.html).
- **Bulk import does not report a delta.** A retry returns the same converged state as the original call.
- **A cascade over a very large list can exhaust the request**, and the caller repeats the `DELETE`. Continuing after the response is unavailable: _"detached promises do not extend Lambda's reliable execution lifetime"_ (`wiki/aws/lambda-and-api.md:30`).
- **`Schema.optionalKey(Schema.NullOr(...))` is introduced for update payloads**, diverging from the `Schema.optional` used elsewhere in the contract. `Schema.optional` also admits an explicit `undefined`, producing a third state that carries no meaning but that the typed CLI client can genuinely construct, forcing every handler to defend against it.
- **The split lands first, as a pure refactor, and costs a slice-wide merge up front.** It is sequenced before any new operation so that every later task writes into the module where its code belongs, rather than into a monolith that is torn up afterwards; its correctness guard is that the existing suites pass with no assertion rewritten. The shape is constrained from both sides: `no-service-constructor-imports` forbids entity modules exporting `make*` for a runtime owner to import, so they export plain operation groups, while `wiki/effect/services-and-layers.md:52` and ADR-0001:15 forbid one service tag per entity. A strictly per-entity decomposition also fails on contact with the code — `addMember` spans contacts, lists and members, and `claimCampaign` spans lists, campaigns and sends — so membership is its own module and ownership follows **item type**, which is what the keys already express.

## Confirmation

Unit tests protect what the stub can falsify: that an over-long attribute key is **rejected rather than silently dropped** (the `Schema.Record` key-check trap), that `removeMember`, both cascades and bulk import all move `membershipVersion`, that `nextCursor` derives from `LastEvaluatedKey` rather than page length, that `META` is deleted last and an interrupted cascade resumes, that a concurrently-deleted list falls back to the 2-action membership removal, that a re-run import writes no new items, and that batch responses keyed by a physical table name are handled.

The storage stub evaluates no conditions, has no index and **models no transaction action limit**, so the decisive checks are live. They were run on an ephemeral `test` stage and passed:

- **The index is an in-place update, not a replacement.** The pre-index schema was deployed first, so the upgrade path itself could be observed: `alchemy plan` reported the table as `update`, and afterwards its `TableId` and `CreationDateTime` were unchanged. The index came up `ACTIVE` and backfilled, `KEYS_ONLY`, with its two key attributes added by the same `UpdateTable`.
- **The index query succeeds without `ConsistentRead`**, and pages through a cursor built from domain values.
- **A list of 60 members — more than one 40-member cascade page — deleted in full**, list and `META` gone, after which each of the 60 contacts deleted cleanly. The recorded run did not establish that the reverse `LISTOF#` items went with it: no read path exposes them, and `listMembers` reads the list's `META` first, so its empty answer reports the list's absence and nothing about its members. Both cascades now prove it by rebuilding the deleted entity and re-adding the membership, which the member `Put`'s absence condition can only accept if the reverse item is gone; until the next live run, the guarantee rests on the unit suites.
- **`membershipVersion` moves on a removal**, and a campaign claim carrying the value read beforehand is refused as `membership-changed`.
- **Addresses are unique and case-insensitive** live, a reservation moves with an address change and frees the old one, and a contact delete removes the forward member item.

The send path was not re-verified: this stage's SES identity is not DNS-verified, so every send is rejected before SES accepts anything. That is the condition [ADR-0002](0002-domain-sending-identity.md) describes, and it is independent of this record — the send path's source is unchanged by this slice.

Details and evidence live in the [slice plan](work/contact-list.md) under T11.

## References

- [ADR-0001: Resource-owning Effect services](0001-resource-owning-effect-services.md)
- [ADR-0003: Feedback events through EventBridge](0003-feedback-events-through-eventbridge.md)
- [Contact management slice](work/contact-list.md)
- [Repository wiki: DynamoDB access paths and consistency](../wiki/aws/dynamodb.md)
- [Repository wiki: transactions, streams and the outbox](../wiki/aws/dynamodb-outbox.md)
- [Repository wiki: Effect services and layers](../wiki/effect/services-and-layers.md)
- [DynamoDB Query API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html)
- [DynamoDB transaction APIs](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)
