import { DateTime, Option, Schema, SchemaTransformation } from "effect";

export const maxNameLength = 200;

export const maxSubjectLength = 200;

export const maxTextBytes = 64 * 1024;

export const maxHtmlBytes = 256 * 1024;

export const maxRequestBytes = 512 * 1024;

export const maxEmailLength = 254;

export const maxAttributeEntries = 20;

export const maxAttributeKeyLength = 64;

export const maxAttributeValueLength = 512;

export const maxImportEntries = 20;

/**
 * The most recipients one test send reaches. It goes out synchronously inside the API's 60-second
 * budget, and at SES's slowest pace of one message a second twenty still fit.
 */
export const maxTestRecipients = 20;

export const minPageSize = 1;

export const maxPageSize = 100;

export const defaultPageSize = 25;

const utf8 = new TextEncoder();

export const utf8ByteLength = (value: string): number => utf8.encode(value).length;

export const utf8ByteCeiling = (maxBytes: number) =>
  Schema.makeFilter((value: string) =>
    utf8ByteLength(value) <= maxBytes ? undefined : `Expected at most ${maxBytes} UTF-8 bytes`,
  );

export const normalizeEmailAddress = (value: string): string => {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("@");

  if (separator <= 0) {
    return trimmed;
  }

  return `${trimmed.slice(0, separator)}@${trimmed.slice(separator + 1).toLowerCase()}`;
};

/**
 * The one address derivation every address-keyed item uses: `EMAIL#` uniqueness reservations,
 * `SUPPRESSION#`, and consent. Uniqueness and consent are therefore case-insensitive, while a
 * stored `email` keeps its local-part case.
 */
export const mailboxKey = (email: string): string => email.trim().toLowerCase();

const mailboxPattern =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const EntityId = Schema.String.check(Schema.isUUID(4));

export type EntityId = typeof EntityId.Type;

export const Timestamp = Schema.String.check(
  Schema.isPattern(isoUtcPattern, { message: "Expected an ISO-8601 UTC timestamp" }),
  // Parsing alone can roll an impossible calendar date into the next month.
  Schema.makeFilter((value: string) =>
    Option.exists(DateTime.make(value), (instant) => DateTime.formatIso(instant) === value)
      ? undefined
      : "Expected a valid calendar instant in canonical ISO-8601 UTC format",
  ),
);

export type Timestamp = typeof Timestamp.Type;

export const NormalizedEmailAddress = Schema.String.check(
  Schema.isMaxLength(maxEmailLength),
  Schema.isPattern(mailboxPattern, { message: "Expected an ASCII email address" }),
);

/**
 * An address exactly as the SES account suppression list stores it. SES keeps the case it received
 * and its management APIs require an exact match, so nothing here changes case: only surrounding
 * whitespace is trimmed. Local rows key on `mailboxKey` regardless.
 */
export const ListedEmailAddress = Schema.String.pipe(
  Schema.decodeTo(NormalizedEmailAddress, SchemaTransformation.trim()),
);

export type ListedEmailAddress = typeof ListedEmailAddress.Type;

export const EmailAddress = Schema.String.pipe(
  Schema.decodeTo(
    NormalizedEmailAddress,
    SchemaTransformation.transform({
      decode: normalizeEmailAddress,
      encode: (value: string) => value,
    }),
  ),
);

export type EmailAddress = typeof EmailAddress.Type;

export const EntityName = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maxNameLength)),
    SchemaTransformation.trim(),
  ),
);

export type EntityName = typeof EntityName.Type;

export const CampaignSubject = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(maxSubjectLength),
      Schema.isPattern(/^[^\r\n]*$/, { message: "Expected a single-line subject" }),
    ),
    SchemaTransformation.trim(),
  ),
);

export type CampaignSubject = typeof CampaignSubject.Type;

export const CampaignText = Schema.String.check(Schema.isNonEmpty(), utf8ByteCeiling(maxTextBytes));

export type CampaignText = typeof CampaignText.Type;

export const CampaignHtml = Schema.String.check(Schema.isNonEmpty(), utf8ByteCeiling(maxHtmlBytes));

export type CampaignHtml = typeof CampaignHtml.Type;

/**
 * Bounded caller-supplied attributes. The key bound is `isPropertyNames` plus `isMaxProperties`
 * rather than a check on the `Record` key schema: a key check narrows which properties are
 * *selected*, so an over-long key would be silently dropped instead of rejected.
 */
export const ContactAttributes = Schema.Record(
  Schema.String,
  Schema.String.check(Schema.isMaxLength(maxAttributeValueLength)),
).check(
  Schema.isPropertyNames(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maxAttributeKeyLength)),
  ),
  Schema.isMaxProperties(maxAttributeEntries),
);

export type ContactAttributes = typeof ContactAttributes.Type;

export const Contact = Schema.Struct({
  id: EntityId,
  email: NormalizedEmailAddress,
  name: Schema.optional(EntityName),
  attributes: Schema.optional(ContactAttributes),
  createdAt: Timestamp,
});

export type Contact = typeof Contact.Type;

export const ContactList = Schema.Struct({
  id: EntityId,
  name: EntityName,
  createdAt: Timestamp,
});

export type ContactList = typeof ContactList.Type;

export const RejectionCode = Schema.Literals([
  "message-rejected",
  "identity-not-verified",
  "sending-paused",
  "rate-limited",
  "invalid-request",
]);

export type RejectionCode = typeof RejectionCode.Type;

export const CampaignProgress = Schema.Struct({
  accepted: Schema.Natural,
  rejected: Schema.Natural,
  uncertain: Schema.Natural,
  skipped: Schema.Natural,
});

export type CampaignProgress = typeof CampaignProgress.Type;

export const CampaignFeedback = Schema.Struct({
  bounced: Schema.Natural,
  complained: Schema.Natural,
});

export type CampaignFeedback = typeof CampaignFeedback.Type;

export const PauseReason = Schema.Literals([
  "sending-paused",
  "daily-quota",
  "rate-limited",
  "reputation",
  "feedback",
  "manual",
]);

export type PauseReason = typeof PauseReason.Type;

export const CampaignState = Schema.Literals([
  "draft",
  "scheduled",
  "queued",
  "sending",
  "paused",
  "completed",
]);

export type CampaignState = typeof CampaignState.Type;

export const CampaignSubmission = Schema.Union([
  Schema.Struct({ state: Schema.Literal("draft") }),
  Schema.Struct({
    state: Schema.Literal("scheduled"),
    sendAt: Timestamp,
  }),
  Schema.Struct({
    state: Schema.Literal("queued"),
    queuedAt: Timestamp,
  }),
  Schema.Struct({
    state: Schema.Literal("sending"),
    queuedAt: Timestamp,
    startedAt: Timestamp,
    progress: CampaignProgress,
    feedback: CampaignFeedback,
  }),
  Schema.Struct({
    state: Schema.Literal("paused"),
    queuedAt: Timestamp,
    startedAt: Timestamp,
    progress: CampaignProgress,
    feedback: CampaignFeedback,
    reason: PauseReason,
  }),
  Schema.Struct({
    state: Schema.Literal("completed"),
    queuedAt: Timestamp,
    startedAt: Timestamp,
    finishedAt: Timestamp,
    progress: CampaignProgress,
    feedback: CampaignFeedback,
  }),
]);

export type CampaignSubmission = typeof CampaignSubmission.Type;

export const CampaignSummary = Schema.Struct({
  id: EntityId,
  listId: EntityId,
  subject: CampaignSubject,
  createdAt: Timestamp,
  submission: CampaignSubmission,
  /** AND of attribute equalities; absent or `{}` means the whole list. */
  filter: Schema.optionalKey(ContactAttributes),
});

export type CampaignSummary = typeof CampaignSummary.Type;

export const CampaignBody = Schema.Struct({
  text: CampaignText,
  html: Schema.optionalKey(CampaignHtml),
});

export type CampaignBody = typeof CampaignBody.Type;

/** A campaign is its summary, which `list` answers alone, plus its body. */
export const Campaign = Schema.Struct({ ...CampaignSummary.fields, ...CampaignBody.fields });

export type Campaign = typeof Campaign.Type;

export const AddressStatus = Schema.Literals([
  "mailable",
  "unsubscribed",
  "suppressed",
  "bouncing",
]);

export type AddressStatus = typeof AddressStatus.Type;

export const SkipReason = AddressStatus.pick(["unsubscribed", "suppressed", "bouncing"]);

export type SkipReason = typeof SkipReason.Type;

export const SuppressionReason = Schema.Literals(["bounce", "complaint"]);

export type SuppressionReason = typeof SuppressionReason.Type;

/**
 * Account-list presence is always reported: `null` means SES has no entry. Local unsubscribe and
 * suppression rows are optional keys because they may not exist.
 */
export const AddressRecord = Schema.Struct({
  email: ListedEmailAddress,
  status: AddressStatus,
  unsubscribedAt: Schema.optionalKey(Timestamp),
  suppression: Schema.optionalKey(
    Schema.Struct({
      reason: SuppressionReason,
      suppressedAt: Timestamp,
      bounceSubType: Schema.optionalKey(Schema.String),
      complaintFeedbackType: Schema.optionalKey(Schema.String),
      complaintSubType: Schema.optionalKey(Schema.String),
    }),
  ),
  transientBounces: Schema.Array(Schema.String),
  accountSuppression: Schema.NullOr(
    Schema.Struct({
      reason: SuppressionReason,
      lastUpdateTime: Timestamp,
    }),
  ),
});

export type AddressRecord = typeof AddressRecord.Type;

export const CreateContactPayload = Schema.Struct({
  email: EmailAddress,
  name: Schema.optional(EntityName),
  attributes: Schema.optional(ContactAttributes),
});

export type CreateContactPayload = typeof CreateContactPayload.Type;

export const CreateListPayload = Schema.Struct({
  name: EntityName,
});

export type CreateListPayload = typeof CreateListPayload.Type;

export const CreateCampaignPayload = Schema.Struct({
  listId: EntityId,
  subject: CampaignSubject,
  text: CampaignText,
  html: Schema.optionalKey(CampaignHtml),
  /** AND of attribute equalities; absent or `{}` means the whole list. */
  filter: Schema.optionalKey(ContactAttributes),
});

export type CreateCampaignPayload = typeof CreateCampaignPayload.Type;

export const ScheduleCampaignPayload = Schema.Struct({ sendAt: Timestamp });

export type ScheduleCampaignPayload = typeof ScheduleCampaignPayload.Type;

/**
 * `optionalKey(NullOr(...))` rather than `optional`: absent leaves the field alone and an explicit
 * null clears it. Plain `optional` would additionally admit `{ name: undefined }`, a third state
 * with no meaning that the typed client can genuinely construct.
 */
export const UpdateContactPayload = Schema.Struct({
  email: Schema.optionalKey(EmailAddress),
  name: Schema.optionalKey(Schema.NullOr(EntityName)),
  attributes: Schema.optionalKey(Schema.NullOr(ContactAttributes)),
});

export type UpdateContactPayload = typeof UpdateContactPayload.Type;

/**
 * A draft edit, with `UpdateContactPayload`'s convention: absent leaves a field alone, and null
 * removes an optional one — the HTML body, or the filter so the campaign goes to the whole list.
 */
export const UpdateCampaignPayload = Schema.Struct({
  listId: Schema.optionalKey(EntityId),
  subject: Schema.optionalKey(CampaignSubject),
  text: Schema.optionalKey(CampaignText),
  html: Schema.optionalKey(Schema.NullOr(CampaignHtml)),
  filter: Schema.optionalKey(Schema.NullOr(ContactAttributes)),
});

export type UpdateCampaignPayload = typeof UpdateCampaignPayload.Type;

export const UpdateListPayload = Schema.Struct({
  name: EntityName,
});

export type UpdateListPayload = typeof UpdateListPayload.Type;

export const PageSize = Schema.Int.check(
  Schema.isBetween({ minimum: minPageSize, maximum: maxPageSize }),
);

export type PageSize = typeof PageSize.Type;

const isTimestamp = Schema.is(Timestamp);

const isEntityId = Schema.is(EntityId);

/**
 * Entity listings page in created order, so the cursor is the two domain values that order is
 * built from, joined: `<createdAt>#<id>`. It is validated here, at the boundary, rather than
 * parsed into a pair — the value a page reports is then exactly the value the next request
 * accepts, at every layer, and a database key is still never taken from a caller.
 */
export const EntityCursor = Schema.String.pipe(
  Schema.refine(
    (value: string): value is string => {
      const separator = value.indexOf("#");

      return (
        separator > 0 &&
        isTimestamp(value.slice(0, separator)) &&
        isEntityId(value.slice(separator + 1))
      );
    },
    { message: "Expected a <createdAt>#<id> cursor" },
  ),
);

export type EntityCursor = typeof EntityCursor.Type;

export const page = <Item extends Schema.Top, Cursor extends Schema.Top>(
  item: Item,
  cursor: Cursor,
) => Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.optional(cursor) });

const ImportContactEntry = Schema.Struct({
  email: EmailAddress,
  name: Schema.optional(EntityName),
  attributes: Schema.optional(ContactAttributes),
});

const ImportContactEntries = Schema.Struct({
  contacts: Schema.Array(ImportContactEntry).check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maxImportEntries),
  ),
});

/**
 * Two entries sharing a mailbox key are rejected here rather than at the database: they would
 * become two actions against one item, which `TransactWriteItems` refuses outright.
 */
export const ImportContactsPayload = ImportContactEntries.pipe(
  Schema.refine(
    (payload: typeof ImportContactEntries.Type): payload is typeof ImportContactEntries.Type =>
      new Set(payload.contacts.map((entry) => mailboxKey(entry.email))).size ===
      payload.contacts.length,
    { message: "Expected each address to appear at most once" },
  ),
);

export type ImportContactsPayload = typeof ImportContactsPayload.Type;

/**
 * Converged state, not a delta: for every submitted address this reports the contact it resolves
 * to and that the contact is now a member, so a repeated import returns an identical body.
 */
export const ImportContactsResult = Schema.Struct({
  contacts: Schema.Array(
    Schema.Struct({ email: NormalizedEmailAddress, contactId: EntityId, member: Schema.Boolean }),
  ),
});

export type ImportContactsResult = typeof ImportContactsResult.Type;

const TestRecipients = Schema.Array(EmailAddress).check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maxTestRecipients),
);

/** Explicit addresses, each at most once, or one list whose every member is a recipient. */
export const TestSendPayload = Schema.Union([
  Schema.Struct({
    to: TestRecipients.pipe(
      Schema.refine(
        (to: typeof TestRecipients.Type): to is typeof TestRecipients.Type =>
          new Set(to.map(mailboxKey)).size === to.length,
        { message: "Expected each address to appear at most once" },
      ),
    ),
  }),
  Schema.Struct({ listId: EntityId }),
]);

export type TestSendPayload = typeof TestSendPayload.Type;

export const TestSendOutcome = Schema.Union([
  Schema.Struct({
    email: NormalizedEmailAddress,
    outcome: Schema.Literal("accepted"),
    messageId: Schema.String,
  }),
  Schema.Struct({
    email: NormalizedEmailAddress,
    outcome: Schema.Literal("skipped"),
    reason: SkipReason,
  }),
  Schema.Struct({
    email: NormalizedEmailAddress,
    outcome: Schema.Literal("rejected"),
    rejectionCode: RejectionCode,
  }),
  Schema.Struct({ email: NormalizedEmailAddress, outcome: Schema.Literal("uncertain") }),
]);

export type TestSendOutcome = typeof TestSendOutcome.Type;

/** One entry per recipient, in the order they were given or listed. */
export const TestSendResult = Schema.Struct({ recipients: Schema.Array(TestSendOutcome) });

export type TestSendResult = typeof TestSendResult.Type;

/** A short-lived public link to a campaign's rendered preview. */
export const PreviewLink = Schema.Struct({ url: Schema.String, expiresAt: Timestamp });

export type PreviewLink = typeof PreviewLink.Type;

const EntityKind = Schema.Literals(["contact", "list", "campaign"]);

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { entity: EntityKind },
  { httpApiStatus: 404 },
) {}

export class EmailAlreadyUsed extends Schema.TaggedError<EmailAlreadyUsed>()(
  "EmailAlreadyUsed",
  { email: NormalizedEmailAddress },
  { httpApiStatus: 409 },
) {}

/** The contact's current address is opted out, so the contact may not be moved off it. */
export class AddressOptedOut extends Schema.TaggedError<AddressOptedOut>()(
  "AddressOptedOut",
  { email: NormalizedEmailAddress },
  { httpApiStatus: 409 },
) {}

export class SendAtNotInFuture extends Schema.TaggedError<SendAtNotInFuture>()(
  "SendAtNotInFuture",
  { sendAt: Timestamp },
  { httpApiStatus: 409 },
) {}

/**
 * The campaign is in a state the operation does not apply to: cancelling one that is sending, or
 * editing or deleting one that is no longer a draft. `state` is what it was found in.
 */
export class CampaignStateConflict extends Schema.TaggedError<CampaignStateConflict>()(
  "CampaignStateConflict",
  { state: CampaignState },
  { httpApiStatus: 409 },
) {}

/** The test list has more members than a test send may reach. */
export class TestAudienceTooLarge extends Schema.TaggedError<TestAudienceTooLarge>()(
  "TestAudienceTooLarge",
  { limit: Schema.Int },
  { httpApiStatus: 409 },
) {}

/** The account-wide guard refuses every send right now: a reputation halt or a spent daily budget. */
export class SendingPaused extends Schema.TaggedError<SendingPaused>()(
  "SendingPaused",
  { reason: PauseReason.pick(["reputation", "daily-quota"]) },
  { httpApiStatus: 503 },
) {}

export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()(
  "PayloadTooLarge",
  { limitBytes: Schema.Int },
  { httpApiStatus: 413 },
) {}

export class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()(
  "StorageUnavailable",
  { operationId: Schema.NonEmptyString },
  { httpApiStatus: 503 },
) {}
