import { ErrorReporter, Schema } from "effect";

import { CampaignState, NormalizedEmailAddress, PauseReason, Timestamp } from "./Schemas.ts";

/**
 * Every error the API answers with. Each failure has its own class, so an endpoint declares exactly
 * what it can answer and the client can tell every case apart.
 *
 * The reporting annotations are getters, which live on the prototype: as own fields they would
 * travel into every printed error.
 */

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class ContactNotFound extends Schema.TaggedError<ContactNotFound>()(
  "ContactNotFound",
  {},
  { httpApiStatus: 404 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class ListNotFound extends Schema.TaggedError<ListNotFound>()(
  "ListNotFound",
  {},
  { httpApiStatus: 404 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class CampaignNotFound extends Schema.TaggedError<CampaignNotFound>()(
  "CampaignNotFound",
  {},
  { httpApiStatus: 404 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class EmailAlreadyUsed extends Schema.TaggedError<EmailAlreadyUsed>()(
  "EmailAlreadyUsed",
  { email: NormalizedEmailAddress },
  { httpApiStatus: 409 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/** The contact's current address is opted out, so the contact may not be moved off it. */
export class AddressOptedOut extends Schema.TaggedError<AddressOptedOut>()(
  "AddressOptedOut",
  { email: NormalizedEmailAddress },
  { httpApiStatus: 409 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/**
 * The contact changed while the request was writing it — another request moved or deleted it, or
 * took the address it was moving to — and it kept changing on each retry.
 */
export class ContactChanged extends Schema.TaggedError<ContactChanged>()(
  "ContactChanged",
  {},
  { httpApiStatus: 409 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

export class SendAtNotInFuture extends Schema.TaggedError<SendAtNotInFuture>()(
  "SendAtNotInFuture",
  { sendAt: Timestamp },
  { httpApiStatus: 409 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/**
 * The campaign is in a state the operation does not apply to: cancelling one that is sending, or
 * editing or deleting one that is no longer a draft. `state` is what it was found in.
 */
export class CampaignStateConflict extends Schema.TaggedError<CampaignStateConflict>()(
  "CampaignStateConflict",
  { state: CampaignState },
  { httpApiStatus: 409 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/** The test list has more members than a test send may reach. */
export class TestAudienceTooLarge extends Schema.TaggedError<TestAudienceTooLarge>()(
  "TestAudienceTooLarge",
  { limit: Schema.Int },
  { httpApiStatus: 409 },
) {
  override get [ErrorReporter.ignore]() {
    return true;
  }
}

/** The account-wide guard refuses every send right now: a reputation halt or a spent daily budget. */
export class SendingPaused extends Schema.TaggedError<SendingPaused>()(
  "SendingPaused",
  { reason: PauseReason.pick(["reputation", "daily-quota"]) },
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

export class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()(
  "StorageUnavailable",
  dependencyFailure,
  { httpApiStatus: 503 },
) {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation, failure: this.failure };
  }
}

/** SES: the account's state or its suppression list. */
export class EmailServiceUnavailable extends Schema.TaggedError<EmailServiceUnavailable>()(
  "EmailServiceUnavailable",
  dependencyFailure,
  { httpApiStatus: 503 },
) {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation, failure: this.failure };
  }
}

export class QueueUnavailable extends Schema.TaggedError<QueueUnavailable>()(
  "QueueUnavailable",
  dependencyFailure,
  { httpApiStatus: 503 },
) {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation, failure: this.failure };
  }
}

export class SchedulerUnavailable extends Schema.TaggedError<SchedulerUnavailable>()(
  "SchedulerUnavailable",
  dependencyFailure,
  { httpApiStatus: 503 },
) {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation, failure: this.failure };
  }
}

/** CloudWatch, read for the reputation alarms before anything is sent. */
export class AlarmsUnavailable extends Schema.TaggedError<AlarmsUnavailable>()(
  "AlarmsUnavailable",
  dependencyFailure,
  { httpApiStatus: 503 },
) {
  override get [ErrorReporter.attributes]() {
    return { operation: this.operation, failure: this.failure };
  }
}
