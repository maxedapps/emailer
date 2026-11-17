import { ErrorReporter, Schema } from "effect";

import { CampaignState, NormalizedEmailAddress, PauseReason, Timestamp } from "./Schemas.ts";

/**
 * Every error the API answers with. Each failure has its own class, so an endpoint declares exactly
 * what it can answer and the client can tell every case apart.
 *
 * The reporting annotations are getters, which live on the prototype: as own fields they would
 * travel into every printed error.
 */

export class Unauthorized extends Schema.TaggedError<
  Unauthorized,
  { readonly brand: unique symbol }
>()("Unauthorized", {}, { httpApiStatus: 401 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class ApiKeyNotFound extends Schema.TaggedError<
  ApiKeyNotFound,
  { readonly brand: unique symbol }
>()("ApiKeyNotFound", {}, { httpApiStatus: 404 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/** A scoped key may not act on the list the request names. */
export class Forbidden extends Schema.TaggedError<Forbidden, { readonly brand: unique symbol }>()(
  "Forbidden",
  {},
  { httpApiStatus: 403 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class ContactNotFound extends Schema.TaggedError<
  ContactNotFound,
  { readonly brand: unique symbol }
>()("ContactNotFound", {}, { httpApiStatus: 404 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class ListNotFound extends Schema.TaggedError<
  ListNotFound,
  { readonly brand: unique symbol }
>()("ListNotFound", {}, { httpApiStatus: 404 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class CampaignNotFound extends Schema.TaggedError<
  CampaignNotFound,
  { readonly brand: unique symbol }
>()("CampaignNotFound", {}, { httpApiStatus: 404 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class EmailAlreadyUsed extends Schema.TaggedError<
  EmailAlreadyUsed,
  { readonly brand: unique symbol }
>()("EmailAlreadyUsed", { email: NormalizedEmailAddress }, { httpApiStatus: 409 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/**
 * The address left a list: the contact holding it may not move to another address, and a single
 * opt-in sign-up may not rejoin the list it left (ADR-0037).
 */
export class AddressOptedOut extends Schema.TaggedError<
  AddressOptedOut,
  { readonly brand: unique symbol }
>()("AddressOptedOut", { email: NormalizedEmailAddress }, { httpApiStatus: 409 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/**
 * The contact changed while the request was writing it — another request moved or deleted it, or
 * took the address it was moving to — and it kept changing on each retry.
 */
export class ContactChanged extends Schema.TaggedError<
  ContactChanged,
  { readonly brand: unique symbol }
>()("ContactChanged", {}, { httpApiStatus: 409 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class SendAtNotInFuture extends Schema.TaggedError<
  SendAtNotInFuture,
  { readonly brand: unique symbol }
>()("SendAtNotInFuture", { sendAt: Timestamp }, { httpApiStatus: 409 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/**
 * The campaign is in a state the operation does not apply to: cancelling one that is sending, or
 * editing or deleting one that is no longer a draft. `state` is what it was found in.
 */
export class CampaignStateConflict extends Schema.TaggedError<
  CampaignStateConflict,
  { readonly brand: unique symbol }
>()("CampaignStateConflict", { state: CampaignState }, { httpApiStatus: 409 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/**
 * The address refuses mail: the mail system reported it suppressed, or it is bouncing. It cannot
 * sign up until the operator unsuppresses it.
 */
export class AddressUndeliverable extends Schema.TaggedError<
  AddressUndeliverable,
  { readonly brand: unique symbol }
>()(
  "AddressUndeliverable",
  { reason: Schema.Literals(["suppressed", "bouncing"]) },
  { httpApiStatus: 422 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/**
 * The confirmation link is not valid: it never was, it expired, or it was already used. The
 * subscriber can sign up again for a new one.
 */
export class ConfirmationNotFound extends Schema.TaggedError<
  ConfirmationNotFound,
  { readonly brand: unique symbol }
>()("ConfirmationNotFound", {}, { httpApiStatus: 404 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/** A confirmation mail went to this address for this list within the hour. */
export class ConfirmationRecentlySent extends Schema.TaggedError<
  ConfirmationRecentlySent,
  { readonly brand: unique symbol }
>()("ConfirmationRecentlySent", { retryAfter: Timestamp }, { httpApiStatus: 429 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/** The test list has more members than a test send may reach. */
export class TestAudienceTooLarge extends Schema.TaggedError<
  TestAudienceTooLarge,
  { readonly brand: unique symbol }
>()("TestAudienceTooLarge", { limit: Schema.Int }, { httpApiStatus: 409 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/** The campaign has no copy under this key. */
export class VariantNotFound extends Schema.TaggedError<
  VariantNotFound,
  { readonly brand: unique symbol }
>()("VariantNotFound", { variant: Schema.String }, { httpApiStatus: 404 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/**
 * The draft's variants changed while the request was writing them — another variant edit or a
 * delete landed first — and they kept changing on each retry.
 */
export class DraftChanged extends Schema.TaggedError<
  DraftChanged,
  { readonly brand: unique symbol }
>()("DraftChanged", {}, { httpApiStatus: 409 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/** Setting the variant would give the campaign more variants than a campaign may hold. */
export class TooManyVariants extends Schema.TaggedError<
  TooManyVariants,
  { readonly brand: unique symbol }
>()("TooManyVariants", { limit: Schema.Int }, { httpApiStatus: 422 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/** Setting the variant would make the percent variants take more than everyone. */
export class SplitOverfull extends Schema.TaggedError<
  SplitOverfull,
  { readonly brand: unique symbol }
>()("SplitOverfull", { percent: Schema.Int }, { httpApiStatus: 422 }) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/** Merging the change would leave the contact with more attributes than a contact may hold. */
export class TooManyAttributes extends Schema.TaggedError<
  TooManyAttributes,
  { readonly brand: unique symbol }
>()(
  "TooManyAttributes",
  { email: NormalizedEmailAddress, limit: Schema.Int },
  { httpApiStatus: 422 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/**
 * The account-wide guard refuses every send right now: a reputation halt, an SES account whose
 * sending is paused, or a spent daily budget.
 */
export class SendingPaused extends Schema.TaggedError<
  SendingPaused,
  { readonly brand: unique symbol }
>()(
  "SendingPaused",
  { reason: PauseReason.pick(["reputation", "sending-paused", "daily-quota"]) },
  { httpApiStatus: 503 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/**
 * A dependency that failed: which operation, and the failure's name — a classification such as
 * `ThrottlingException` or `TimeoutError`, never a payload. Both are what gets reported.
 */
const dependencyFailure = { operation: Schema.String, failure: Schema.String };

export class StorageUnavailable extends Schema.TaggedError<
  StorageUnavailable,
  { readonly brand: unique symbol }
>()("StorageUnavailable", dependencyFailure, { httpApiStatus: 503 }) {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation, failure: this.failure };
  }
}

/** SES: the account's state or its suppression list. */
export class EmailServiceUnavailable extends Schema.TaggedError<
  EmailServiceUnavailable,
  { readonly brand: unique symbol }
>()("EmailServiceUnavailable", dependencyFailure, { httpApiStatus: 503 }) {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation, failure: this.failure };
  }
}

export class QueueUnavailable extends Schema.TaggedError<
  QueueUnavailable,
  { readonly brand: unique symbol }
>()("QueueUnavailable", dependencyFailure, { httpApiStatus: 503 }) {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation, failure: this.failure };
  }
}

export class SchedulerUnavailable extends Schema.TaggedError<
  SchedulerUnavailable,
  { readonly brand: unique symbol }
>()("SchedulerUnavailable", dependencyFailure, { httpApiStatus: 503 }) {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation, failure: this.failure };
  }
}

/** CloudWatch, read for the account-wide reputation alarms before anything is sent. */
export class AlarmsUnavailable extends Schema.TaggedError<
  AlarmsUnavailable,
  { readonly brand: unique symbol }
>()("AlarmsUnavailable", dependencyFailure, { httpApiStatus: 503 }) {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation, failure: this.failure };
  }
}
