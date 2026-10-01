import {
  CampaignNotFound,
  CampaignStateConflict,
  DraftChanged,
  SplitOverfull,
  TooManyVariants,
  VariantNotFound,
} from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { Context, Crypto, Data, Effect, Layer, Predicate, Schema } from "effect";

import { CorruptItem } from "../Errors.ts";

import {
  bodyKey,
  campaignKey,
  itemReader,
  itemWriter,
  listingAttributes,
  num,
  routesKey,
  str,
  strMap,
  tableLogicalId,
  variantBodyKey,
} from "./Items.ts";
import { allPrimitives, readPrimitives } from "./Primitives.ts";
import { AllTableOperationsHttp, allTableOperations, dataTable } from "./Table.ts";

import type { TableOperations } from "./Items.ts";
import type {
  Action,
  PagePrimitives,
  ReadPrimitives,
  StoredItem,
  StoredPage,
  TransactionPrimitives,
  TransactionTokens,
  UpdatePrimitives,
  WritePrimitives,
} from "./Primitives.ts";

const campaignKind = "campaign";

const sendKey = (campaignId: string, contactId: string) => ({
  pk: str(`CAMPAIGN#${campaignId}`),
  sk: str(`SEND#${contactId}`),
});

/** What every state shares: the summary's fields, the counters and the current run's baselines. */
const always = {
  id: Schemas.EntityId,
  listId: Schemas.EntityId,
  subject: Schemas.CampaignSubject,
  createdAt: Schemas.Timestamp,
  filter: Schema.optionalKey(Schemas.ContactAttributes),
  ...Schemas.CampaignProgress.fields,
  ...Schemas.CampaignFeedback.fields,
  runAccepted: Schema.Int,
  runBounced: Schema.Int,
  runComplained: Schema.Int,
};

const SendingRecord = Schema.Struct({
  ...always,
  state: Schema.Literal("sending"),
  runToken: Schemas.EntityId,
  queuedAt: Schemas.Timestamp,
  startedAt: Schemas.Timestamp,
  cursor: Schema.optionalKey(Schemas.EntityId),
});

/**
 * The campaign's `META` item, by state. A draft keeps the token of a cancelled run; every other
 * state holds its run's token. `queuedAt` is when the run was queued or, while scheduled, when its
 * wake-up is due. A queued run that resumes a paused one keeps its `startedAt` and its cursor.
 */
const CampaignRecord = Schema.Union([
  Schema.Struct({
    ...always,
    state: Schema.Literal("draft"),
    runToken: Schema.optionalKey(Schemas.EntityId),
  }),
  Schema.Struct({
    ...always,
    state: Schema.Literal("scheduled"),
    runToken: Schemas.EntityId,
    queuedAt: Schemas.Timestamp,
  }),
  Schema.Struct({
    ...always,
    state: Schema.Literal("queued"),
    runToken: Schemas.EntityId,
    queuedAt: Schemas.Timestamp,
    startedAt: Schema.optionalKey(Schemas.Timestamp),
    cursor: Schema.optionalKey(Schemas.EntityId),
  }),
  SendingRecord,
  Schema.Struct({
    ...always,
    state: Schema.Literal("paused"),
    runToken: Schemas.EntityId,
    queuedAt: Schemas.Timestamp,
    startedAt: Schemas.Timestamp,
    pausedReason: Schemas.PauseReason,
    cursor: Schema.optionalKey(Schemas.EntityId),
  }),
  Schema.Struct({
    ...always,
    state: Schema.Literal("completed"),
    runToken: Schemas.EntityId,
    queuedAt: Schemas.Timestamp,
    startedAt: Schemas.Timestamp,
    finishedAt: Schemas.Timestamp,
  }),
]);

type CampaignRecord = typeof CampaignRecord.Type;

const readCampaign = itemReader(CampaignRecord);

/** A run that has just begun is sending, and anything else there is corrupt. */
const readSending = itemReader(SendingRecord);

const writeCampaign = itemWriter(CampaignRecord);

/** The campaign's own copy's text and HTML; its subject is on META, which the listing reads. */
const readBody = itemReader(Schemas.CampaignBody);

const writeBody = itemWriter(Schemas.CampaignBody);

/**
 * The variants' rules in order, on their own item rather than on `META`, which every settlement
 * rewrites and pays for by size, or on a body, which they would push past the item cap. The rules
 * are a JSON string, which nothing evaluates into. `revision` counts variant edits, so an edit or a
 * delete writes only against the rules it read. The item stays once the last variant is removed:
 * deleted, its revision would count from the start again, and a stale edit could pass.
 */
const RoutesRecord = Schema.Struct({
  routes: Schema.fromJsonString(Schemas.VariantRoutes),
  revision: Schema.Int,
});

const readRoutesRecord = itemReader(RoutesRecord);

const writeRoutes = itemWriter(RoutesRecord);

/** The rules as read, and the revision a write against them asserts: none before any was set. */
interface Routes {
  readonly routes: Schemas.VariantRoutes;
  readonly revision: number | undefined;
}

const noRoutes: Routes = { routes: [], revision: undefined };

/** An alternate copy's content, one item per variant; its rule lives on `ROUTES`. */
const VariantBody = Schema.Struct({
  subject: Schemas.CampaignSubject,
  text: Schemas.CampaignText,
  html: Schema.optionalKey(Schemas.CampaignHtml),
});

const readVariantBody = itemReader(VariantBody);

const writeVariantBody = itemWriter(VariantBody);

/** A send row is claimed before its submission and settled after it, or skipped outright. */
const SendRecord = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("unconfirmed"),
    sendId: Schemas.EntityId,
    contactId: Schemas.EntityId,
    recipient: Schemas.NormalizedEmailAddress,
    variant: Schemas.CopyKey,
    startedAt: Schemas.Timestamp,
  }),
  Schema.Struct({
    state: Schema.Literal("skipped"),
    contactId: Schemas.EntityId,
    recipient: Schemas.NormalizedEmailAddress,
    skipReason: Schemas.SkipReason,
    startedAt: Schemas.Timestamp,
    finishedAt: Schemas.Timestamp,
  }),
]);

const writeSend = itemWriter(SendRecord);

/**
 * What one SES submission came to: the mailer answers it, and a send row is settled from it.
 * `uncertain` means no definite answer came back, so whether the message went out is unknown.
 */
export type SubmissionOutcome =
  | { readonly outcome: "accepted"; readonly messageId: string }
  | { readonly outcome: "rejected"; readonly rejectionCode: Schemas.RejectionCode }
  | { readonly outcome: "uncertain" };

interface CampaignRun {
  readonly listId: string;
  readonly subject: string;
  readonly cursor: string | undefined;
  readonly filter: Schemas.ContactAttributes | undefined;
  readonly run: {
    readonly accepted: number;
    readonly bounced: number;
    readonly complained: number;
  };
}

/**
 * What the commands decide by: a campaign's state, with the run token, start and pause reason that
 * state holds. Derived from the record, so each state carries exactly what it stores.
 */
type ControlOf<Stored> = Stored extends unknown
  ? Pick<Stored, Extract<keyof Stored, "state" | "runToken" | "startedAt" | "pausedReason">>
  : never;

export type CampaignControl = ControlOf<CampaignRecord>;

/** The run a worker holds is no longer the campaign's: it moved on to another run or state. */
export class RunSuperseded extends Data.TaggedError("RunSuperseded") {}

/**
 * The state a command observed no longer holds. `current` is the campaign's control as the refused
 * condition found it, or undefined when the campaign is gone.
 */
export class CampaignChanged extends Data.TaggedError("CampaignChanged")<{
  readonly current: CampaignControl | undefined;
}> {}

/** A settlement's send row is no longer this attempt's to settle, or its campaign is gone. */
export class SettlementNotApplied extends Data.TaggedError("SettlementNotApplied") {}

/** Another slice already wrote this recipient's send row. */
class AlreadyClaimed extends Data.TaggedError("AlreadyClaimed") {}

/** A variant edit landed between reading the rules and reading the variant they named. */
class CopiesMoved extends Data.TaggedError("CopiesMoved") {}

const superseded = () => new RunSuperseded();

const changed = (operation: string) => (current: StoredItem) =>
  current === undefined
    ? Effect.fail(new CampaignChanged({ current: undefined }))
    : Effect.flatMap(readCampaign(operation, current), (control) =>
        Effect.fail(new CampaignChanged({ current: control })),
      );

/** A draft write refused because the campaign is gone, or is no longer a draft. */
const notADraft = (operation: string) => (current: StoredItem) =>
  current === undefined
    ? Effect.fail(new CampaignNotFound())
    : Effect.flatMap(readCampaign(operation, current), (stored) =>
        Effect.fail(new CampaignStateConflict({ state: stored.state })),
      );

export type RunSource = {
  readonly state: "draft" | "scheduled" | "paused";
  readonly runToken: string | undefined;
};

export type CancelSource =
  | { readonly state: "scheduled"; readonly runToken: string }
  | { readonly state: "queued"; readonly runToken: string; readonly started: boolean };

const countersOf = (stored: CampaignRecord) => ({
  progress: {
    accepted: stored.accepted,
    rejected: stored.rejected,
    uncertain: stored.uncertain,
    skipped: stored.skipped,
  },
  feedback: { bounced: stored.bounced, complained: stored.complained },
});

const submissionOf = (stored: CampaignRecord): Schemas.CampaignSubmission => {
  switch (stored.state) {
    case "draft":
      return { state: "draft" };
    case "scheduled":
      return { state: "scheduled", sendAt: stored.queuedAt };
    case "queued":
      return { state: "queued", queuedAt: stored.queuedAt };
    case "sending":
      return {
        state: "sending",
        queuedAt: stored.queuedAt,
        startedAt: stored.startedAt,
        ...countersOf(stored),
      };
    case "paused":
      return {
        state: "paused",
        queuedAt: stored.queuedAt,
        startedAt: stored.startedAt,
        ...countersOf(stored),
        reason: stored.pausedReason,
      };
    case "completed":
      return {
        state: "completed",
        queuedAt: stored.queuedAt,
        startedAt: stored.startedAt,
        finishedAt: stored.finishedAt,
        ...countersOf(stored),
      };
  }
};

const summaryOf = (stored: CampaignRecord): Schemas.CampaignSummary => {
  const summary = {
    id: stored.id,
    listId: stored.listId,
    subject: stored.subject,
    createdAt: stored.createdAt,
    submission: submissionOf(stored),
  };

  return stored.filter === undefined ? summary : { ...summary, filter: stored.filter };
};

const stateName = { "#state": "state" };

const stateAndCursorNames = { "#state": "state", "#cursor": "cursor" };

const observedTokenCondition = (runToken: string | undefined) =>
  runToken === undefined ? "attribute_not_exists(runToken)" : "runToken = :expected";

const observedTokenValues = (runToken: string | undefined) =>
  runToken === undefined ? {} : { ":expected": str(runToken) };

const sendingAndRun = (runToken: string) => ({
  ":sending": str("sending"),
  ":run": str(runToken),
});

const settlementWrite = (settlement: SubmissionOutcome) => {
  switch (settlement.outcome) {
    case "accepted":
      return {
        expression: "SET #state = :state, finishedAt = :finishedAt, messageId = :messageId",
        values: {
          ":state": str("accepted"),
          ":messageId": str(settlement.messageId),
        },
        counter: "accepted" as const,
      };
    case "rejected":
      return {
        expression: "SET #state = :state, finishedAt = :finishedAt, rejectionCode = :rejectionCode",
        values: {
          ":state": str("rejected"),
          ":rejectionCode": str(settlement.rejectionCode),
        },
        counter: "rejected" as const,
      };
    case "uncertain":
      return {
        expression: "SET #state = :state, finishedAt = :finishedAt",
        values: { ":state": str("uncertain") },
        counter: "uncertain" as const,
      };
  }
};

const variantOf = (route: Schemas.VariantRoute, body: typeof VariantBody.Type): Schemas.Variant =>
  route.when === undefined
    ? { key: route.key, percent: route.percent, ...body }
    : { key: route.key, when: route.when, ...body };

/** The rule a variant is set with, under its key. */
const routeOf = (key: string, variant: Schemas.VariantPayload): Schemas.VariantRoute =>
  variant.when === undefined ? { key, percent: variant.percent } : { key, when: variant.when };

/** The condition a variant write asserts on the rules it read: the same edit, or none ever. */
const sameRevision = (revision: number | undefined) =>
  revision === undefined
    ? { ConditionExpression: "attribute_not_exists(revision)" }
    : {
        ConditionExpression: "revision = :revision",
        ExpressionAttributeValues: { ":revision": num(revision) },
      };

/** A variant write that lost a race with another edit or a delete retries from a fresh read. */
const retryDraftRace = <A, E, R>(write: Effect.Effect<A, E, R>) =>
  Effect.retry(write, { times: 2, while: Predicate.isTagged("DraftChanged") });

/** The META condition every draft write carries, refused as the campaign is found. */
const draftCheck = (campaignId: string, operation: string) => ({
  ConditionCheck: {
    Table: tableLogicalId,
    Key: campaignKey(campaignId),
    ConditionExpression: "#state = :draft",
    ExpressionAttributeNames: stateName,
    ExpressionAttributeValues: { ":draft": str("draft") },
    ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
  },
  refused: notADraft(operation),
});

interface FieldUpdate {
  readonly UpdateExpression: string;
  readonly ExpressionAttributeNames: Readonly<Record<string, string>>;
  readonly ExpressionAttributeValues?: Readonly<Record<string, dynamodb.AttributeValue>>;
}

/**
 * One update of exactly the fields given: `SET` for a value, `REMOVE` for null, nothing for
 * undefined. None when no field is given.
 */
const fieldUpdate = (
  fields: Readonly<Record<string, dynamodb.AttributeValue | null | undefined>>,
): FieldUpdate | undefined => {
  const given = Object.entries(fields).filter(([, value]) => value !== undefined);

  if (given.length === 0) {
    return undefined;
  }

  const set = given.flatMap(([name, value]) =>
    value === null || value === undefined ? [] : [[name, value] as const],
  );

  const removed = given.flatMap(([name, value]) => (value === null ? [name] : []));

  const clauses = [
    set.length === 0 ? [] : [`SET ${set.map(([name]) => `#${name} = :${name}`).join(", ")}`],
    removed.length === 0 ? [] : [`REMOVE ${removed.map((name) => `#${name}`).join(", ")}`],
  ].flat();

  const update = {
    UpdateExpression: clauses.join(" "),
    ExpressionAttributeNames: Object.fromEntries(given.map(([name]) => [`#${name}`, name])),
  };

  // DynamoDB refuses an empty value map, which an update that only removes would have.
  return set.length === 0
    ? update
    : {
        ...update,
        ExpressionAttributeValues: Object.fromEntries(
          set.map(([name, value]) => [`:${name}`, value]),
        ),
      };
};

/** The reads a campaign's content needs, and all the public preview function may do. */
const campaignReads = (primitives: ReadPrimitives) => {
  const { readItem } = primitives;

  /** The variants' rules, and the revision they were read at; none ever set reads as no rules. */
  const getRoutes = Effect.fn("Storage.getRoutes")(function* (campaignId: string) {
    const response = yield* readItem("getRoutes", routesKey(campaignId));

    if (response.Item === undefined) {
      return noRoutes;
    }

    const stored = yield* readRoutesRecord("getRoutes", response.Item);

    return { routes: stored.routes, revision: stored.revision } satisfies Routes;
  });

  const getSummary = Effect.fn("Storage.getSummary")(function* (campaignId: string) {
    const response = yield* readItem("getSummary", campaignKey(campaignId));

    if (response.Item === undefined) {
      return yield* new CampaignNotFound();
    }

    return summaryOf(yield* readCampaign("getSummary", response.Item));
  });

  /**
   * The campaign's own text and HTML, read after its META. A body missing then is a delete that
   * landed in between, unless META is still there: the body is written first and deleted with it.
   */
  const getBody = Effect.fn("Storage.getBody")(function* (campaignId: string) {
    const response = yield* readItem("getBody", bodyKey(campaignId));

    if (response.Item === undefined) {
      yield* getSummary(campaignId);

      return yield* Effect.die(new CorruptItem({ operation: "getBody" }));
    }

    return yield* readBody("getBody", response.Item);
  });

  /**
   * The campaign with its own copy and the variants' rules. The rules and the body are read before
   * META, so a delete landing in between answers not found rather than a body gone missing.
   */
  const getCampaign = Effect.fn("Storage.getCampaign")(function* (campaignId: string) {
    const { routes } = yield* getRoutes(campaignId);
    const body = yield* readItem("getCampaign", bodyKey(campaignId));
    const summary = yield* getSummary(campaignId);

    if (body.Item === undefined) {
      return yield* Effect.die(new CorruptItem({ operation: "getCampaign" }));
    }

    const campaign: Schemas.Campaign = {
      ...summary,
      ...(yield* readBody("getCampaign", body.Item)),
    };

    return routes.length === 0 ? campaign : { ...campaign, variants: routes };
  });

  /**
   * One variant with its content: its rule, then its body, each by `GetItem`, so the preview
   * function needs nothing broader. The two reads can straddle an edit: a body missing under a
   * rule is read again from fresh rules when they changed, and is corrupt only when they did not.
   */
  const getVariant = Effect.fn("Storage.getVariant")(
    function* (campaignId: string, key: string) {
      const { routes, revision } = yield* getRoutes(campaignId);
      const route = routes.find((candidate) => candidate.key === key);

      if (route === undefined) {
        // Read only to answer NotFound for a campaign that does not exist.
        yield* getSummary(campaignId);

        return yield* new VariantNotFound({ variant: key });
      }

      const response = yield* readItem("getVariant", variantBodyKey(campaignId, key));

      if (response.Item === undefined) {
        if ((yield* getRoutes(campaignId)).revision === revision) {
          return yield* Effect.die(new CorruptItem({ operation: "getVariant" }));
        }

        return yield* new CopiesMoved();
      }

      return variantOf(route, yield* readVariantBody("getVariant", response.Item));
    },
    // Each round needs another edit to have landed in between, so running out is a defect.
    (read) =>
      Effect.retry(read, { times: 3, while: Predicate.isTagged("CopiesMoved") }).pipe(
        Effect.catchTag("CopiesMoved", (moved) => Effect.die(moved)),
      ),
  );

  return { getRoutes, getSummary, getBody, getCampaign, getVariant } as const;
};

export const campaignOperations = (
  primitives: ReadPrimitives &
    WritePrimitives &
    TransactionPrimitives &
    UpdatePrimitives &
    PagePrimitives,
) => {
  const { readEntityPage, readItem, recordOnce, transact, updateIf } = primitives;
  const reads = campaignReads(primitives);
  const { getRoutes } = reads;

  // Every key is fresh, so an item already there can only be this request landing again after a
  // lost response: `recordOnce` reports that as done, which it is. The body goes first so that
  // META is the commit point: a create interrupted before it leaves nothing that any key, index
  // entry or query can reach.
  const createCampaign = Effect.fn("Storage.createCampaign")(function* (
    campaign: Schemas.Campaign,
  ) {
    const { text, html, variants: _variants, submission: _submission, ...summary } = campaign;
    const body = yield* writeBody(html === undefined ? { text } : { text, html });

    yield* recordOnce("createCampaign", { ...bodyKey(campaign.id), ...body });

    const stored = yield* writeCampaign({
      ...summary,
      state: "draft",
      accepted: 0,
      rejected: 0,
      uncertain: 0,
      skipped: 0,
      bounced: 0,
      complained: 0,
      runAccepted: 0,
      runBounced: 0,
      runComplained: 0,
    });

    yield* recordOnce("createCampaign", {
      ...campaignKey(campaign.id),
      ...listingAttributes(campaignKind, campaign.createdAt, campaign.id),
      ...stored,
    });
  });

  const listCampaigns = Effect.fn("Storage.listCampaigns")(function* (
    limit: number,
    cursor: string | undefined,
  ) {
    const page = yield* readEntityPage("listCampaigns", campaignKind, campaignKey, limit, cursor);

    const campaigns = yield* Effect.forEach(page.items, (item) =>
      Effect.map(readCampaign("listCampaigns", item), summaryOf),
    );

    return { ...page, items: campaigns } satisfies StoredPage<Schemas.CampaignSummary, string>;
  });

  const getCampaignControl = Effect.fn("Storage.getCampaignControl")(function* (
    campaignId: string,
  ) {
    const response = yield* readItem("getCampaignControl", campaignKey(campaignId));

    if (response.Item === undefined) {
      return yield* new CampaignNotFound();
    }

    const control: CampaignControl = yield* readCampaign("getCampaignControl", response.Item);

    return control;
  });

  /**
   * A command's change of state, as a single-item transaction so that a transport retry reuses its
   * `ClientRequestToken`. A refused change answers the campaign as it now is.
   */
  const commitLifecycle = (
    operation: string,
    id: string,
    update: {
      readonly UpdateExpression: string;
      readonly ConditionExpression: string;
      readonly ExpressionAttributeValues: Record<string, ReturnType<typeof str>>;
    },
  ) =>
    transact(operation, [
      {
        Update: {
          Table: tableLogicalId,
          Key: campaignKey(id),
          ExpressionAttributeNames: stateName,
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          ...update,
        },
        refused: changed(operation),
      },
    ]);

  /**
   * Starts a new run, and only from the state and token the caller observed: the campaign becomes
   * `queued` or `scheduled` under a fresh run token, with the run baselines taken from the counters
   * as they stand. `queuedAt` is when it was queued or, for a schedule, when the wake-up is due.
   * Only a paused source carries a pause reason, and it goes. Send, schedule and resume keep their
   * own operation ids, so a failure names the command that hit it.
   */
  const newRun = Effect.fn("Storage.newRun")(function* (
    id: string,
    expected: RunSource,
    newToken: string,
    target: "queued" | "scheduled",
    queuedAt: string,
  ) {
    const operation =
      target === "scheduled"
        ? "scheduleCampaign"
        : expected.state === "paused"
          ? "resumeCampaign"
          : "enqueueCampaign";

    yield* commitLifecycle(operation, id, {
      UpdateExpression:
        "SET #state = :target, queuedAt = :queuedAt, runToken = :run, runAccepted = accepted, runBounced = bounced, runComplained = complained REMOVE pausedReason",
      ConditionExpression: `#state = :expectedState AND ${observedTokenCondition(expected.runToken)}`,
      ExpressionAttributeValues: {
        ":target": str(target),
        ":queuedAt": str(queuedAt),
        ":run": str(newToken),
        ":expectedState": str(expected.state),
        ...observedTokenValues(expected.runToken),
      },
    });
  });

  const cancelCampaign = Effect.fn("Storage.cancelCampaign")(function* (
    id: string,
    source: CancelSource,
  ) {
    yield* source.state === "scheduled"
      ? commitLifecycle("cancelCampaign", id, {
          UpdateExpression: "SET #state = :draft REMOVE queuedAt",
          ConditionExpression: "#state = :scheduled AND runToken = :expected",
          ExpressionAttributeValues: {
            ":draft": str("draft"),
            ":scheduled": str("scheduled"),
            ":expected": str(source.runToken),
          },
        })
      : source.started
        ? commitLifecycle("cancelCampaign", id, {
            UpdateExpression: "SET #state = :paused, pausedReason = :manual",
            ConditionExpression:
              "#state = :queued AND runToken = :expected AND attribute_exists(startedAt)",
            ExpressionAttributeValues: {
              ":paused": str("paused"),
              ":manual": str("manual"),
              ":queued": str("queued"),
              ":expected": str(source.runToken),
            },
          })
        : commitLifecycle("cancelCampaign", id, {
            UpdateExpression: "SET #state = :draft REMOVE queuedAt",
            ConditionExpression:
              "#state = :queued AND runToken = :expected AND attribute_not_exists(startedAt)",
            ExpressionAttributeValues: {
              ":draft": str("draft"),
              ":queued": str("queued"),
              ":expected": str(source.runToken),
            },
          });
  });

  const beginRun = Effect.fn("Storage.beginRun")(function* (
    id: string,
    runToken: string,
    now: string,
  ) {
    const begun = yield* updateIf(
      "beginRun",
      {
        Key: campaignKey(id),
        UpdateExpression: "SET #state = :sending, startedAt = if_not_exists(startedAt, :now)",
        ConditionExpression: "runToken = :run AND #state IN (:queued, :sending, :scheduled)",
        ExpressionAttributeNames: stateName,
        ExpressionAttributeValues: {
          ":sending": str("sending"),
          ":now": str(now),
          ":run": str(runToken),
          ":queued": str("queued"),
          ":scheduled": str("scheduled"),
        },
        ReturnValues: "ALL_NEW",
      },
      superseded,
    );

    const stored = yield* readSending("beginRun", begun);

    return {
      listId: stored.listId,
      subject: stored.subject,
      cursor: stored.cursor,
      filter: stored.filter,
      run: {
        accepted: stored.accepted - stored.runAccepted,
        bounced: stored.bounced - stored.runBounced,
        complained: stored.complained - stored.runComplained,
      },
    } satisfies CampaignRun;
  });

  const claimRecipient = Effect.fn("Storage.claimRecipient")(function* (
    id: string,
    runToken: string,
    contactId: string,
    recipient: string,
    variant: Schemas.CopyKey,
    sendId: string,
    now: string,
  ) {
    const row = yield* writeSend({
      state: "unconfirmed",
      sendId,
      contactId,
      recipient,
      variant,
      startedAt: now,
    });

    // The run comes first: a superseded run decides over a row another slice already claimed.
    return yield* transact("claimRecipient", [
      {
        ConditionCheck: {
          Table: tableLogicalId,
          Key: campaignKey(id),
          ConditionExpression: "#state = :sending AND runToken = :run",
          ExpressionAttributeNames: stateName,
          ExpressionAttributeValues: sendingAndRun(runToken),
        },
        refused: superseded,
      },
      {
        Put: {
          Table: tableLogicalId,
          Item: { ...sendKey(id, contactId), ...row },
          ConditionExpression: "attribute_not_exists(pk)",
        },
        refused: () => new AlreadyClaimed(),
      },
    ]).pipe(
      Effect.as("claimed" as const),
      Effect.catchTag("AlreadyClaimed", () => Effect.succeed("already-claimed" as const)),
    );
  });

  const skipRecipient = Effect.fn("Storage.skipRecipient")(function* (
    id: string,
    runToken: string,
    contactId: string,
    recipient: string,
    reason: Schemas.SkipReason,
    now: string,
  ) {
    const row = yield* writeSend({
      state: "skipped",
      contactId,
      recipient,
      skipReason: reason,
      startedAt: now,
      finishedAt: now,
    });

    // The row comes first: a recipient already settled by an earlier slice stays settled.
    return yield* transact("skipRecipient", [
      {
        Put: {
          Table: tableLogicalId,
          Item: { ...sendKey(id, contactId), ...row },
          ConditionExpression: "attribute_not_exists(pk)",
        },
        refused: () => new AlreadyClaimed(),
      },
      {
        Update: {
          Table: tableLogicalId,
          Key: campaignKey(id),
          UpdateExpression: "ADD skipped :one",
          ConditionExpression: "#state = :sending AND runToken = :run",
          ExpressionAttributeNames: stateName,
          ExpressionAttributeValues: {
            ":one": num(1),
            ...sendingAndRun(runToken),
          },
        },
        refused: superseded,
      },
    ]).pipe(
      Effect.as("skipped" as const),
      Effect.catchTag("AlreadyClaimed", () => Effect.succeed("already-claimed" as const)),
    );
  });

  const settleRecipient = Effect.fn("Storage.settleRecipient")(function* (
    id: string,
    sendId: string,
    contactId: string,
    settlement: SubmissionOutcome,
    now: string,
  ) {
    const terminal = settlementWrite(settlement);

    // The row is no longer this attempt's to settle, or the campaign is gone.
    const notApplied = () => new SettlementNotApplied();

    yield* transact("settleRecipient", [
      {
        Update: {
          Table: tableLogicalId,
          Key: sendKey(id, contactId),
          UpdateExpression: terminal.expression,
          ConditionExpression: "#state = :unconfirmed AND sendId = :sendId",
          ExpressionAttributeNames: stateName,
          ExpressionAttributeValues: {
            ...terminal.values,
            ":finishedAt": str(now),
            ":unconfirmed": str("unconfirmed"),
            ":sendId": str(sendId),
          },
        },
        refused: notApplied,
      },
      {
        Update: {
          Table: tableLogicalId,
          Key: campaignKey(id),
          UpdateExpression: `ADD ${terminal.counter} :one`,
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":one": num(1) },
        },
        refused: notApplied,
      },
    ]);
  });

  /**
   * Advances the cursor from the page this slice walked to the next one. The slice records its
   * own identifier with the cursor, so the condition also holds when this request lands a second
   * time after a lost response — while a concurrent duplicate walking the same page, which has
   * its own identifier, still loses and enqueues no second chain.
   */
  const checkpoint = Effect.fn("Storage.checkpoint")(function* (
    id: string,
    runToken: string,
    sliceId: string,
    previous: string | undefined,
    next: string,
  ) {
    const alreadyMine = "(#cursor = :next AND sliceId = :slice)";

    const from = previous === undefined ? "attribute_not_exists(#cursor)" : "#cursor = :previous";
    const values = { ...sendingAndRun(runToken), ":next": str(next), ":slice": str(sliceId) };

    yield* updateIf(
      "checkpoint",
      {
        Key: campaignKey(id),
        UpdateExpression: "SET #cursor = :next, sliceId = :slice",
        ConditionExpression: `#state = :sending AND runToken = :run AND (${from} OR ${alreadyMine})`,
        ExpressionAttributeNames: stateAndCursorNames,
        ExpressionAttributeValues:
          previous === undefined ? values : { ...values, ":previous": str(previous) },
      },
      superseded,
    );
  });

  const completeRun = Effect.fn("Storage.completeRun")(function* (
    id: string,
    runToken: string,
    now: string,
  ) {
    yield* updateIf(
      "completeRun",
      {
        Key: campaignKey(id),
        UpdateExpression: "SET #state = :completed, finishedAt = :now REMOVE #cursor, sliceId",
        ConditionExpression: "#state = :sending AND runToken = :run",
        ExpressionAttributeNames: stateAndCursorNames,
        ExpressionAttributeValues: {
          ":completed": str("completed"),
          ":now": str(now),
          ...sendingAndRun(runToken),
        },
      },
      superseded,
    );
  });

  const pauseRun = Effect.fn("Storage.pauseRun")(function* (
    id: string,
    runToken: string,
    reason: Schemas.PauseReason,
    cursor: string | undefined,
  ) {
    const values = { ":paused": str("paused"), ":reason": str(reason), ...sendingAndRun(runToken) };

    yield* updateIf(
      "pauseRun",
      cursor === undefined
        ? {
            Key: campaignKey(id),
            UpdateExpression: "SET #state = :paused, pausedReason = :reason REMOVE #cursor",
            ConditionExpression: "#state = :sending AND runToken = :run",
            ExpressionAttributeNames: stateAndCursorNames,
            ExpressionAttributeValues: values,
          }
        : {
            Key: campaignKey(id),
            UpdateExpression: "SET #state = :paused, pausedReason = :reason, #cursor = :cursor",
            ConditionExpression: "#state = :sending AND runToken = :run",
            ExpressionAttributeNames: stateAndCursorNames,
            ExpressionAttributeValues: { ...values, ":cursor": str(cursor) },
          },
      superseded,
    );
  });

  /**
   * Edits a draft's own copy and settings: one transaction that updates exactly the fields the
   * change gives, while the campaign is still a draft. Nothing is read first, so two edits of
   * different fields both land. A campaign deleted meanwhile fails META's condition, since its
   * state no longer exists, and the item the condition returns tells the two apart.
   */
  const updateDraft = Effect.fn("Storage.updateDraft")(function* (
    campaignId: string,
    change: Schemas.UpdateCampaignPayload,
  ) {
    const meta = fieldUpdate({
      subject: change.subject === undefined ? undefined : str(change.subject),
      listId: change.listId === undefined ? undefined : str(change.listId),
      filter:
        change.filter === undefined || change.filter === null
          ? change.filter
          : strMap(change.filter),
    });

    const body = fieldUpdate({
      text: change.text === undefined ? undefined : str(change.text),
      html: change.html === undefined || change.html === null ? change.html : str(change.html),
    });

    const check = draftCheck(campaignId, "updateDraft");

    yield* transact("updateDraft", [
      meta === undefined
        ? check
        : {
            Update: {
              ...check.ConditionCheck,
              UpdateExpression: meta.UpdateExpression,
              ExpressionAttributeNames: { ...stateName, ...meta.ExpressionAttributeNames },
              ExpressionAttributeValues: {
                ...check.ConditionCheck.ExpressionAttributeValues,
                ...meta.ExpressionAttributeValues,
              },
            },
            refused: check.refused,
          },
      ...(body === undefined
        ? []
        : [
            {
              Update: {
                Table: tableLogicalId,
                Key: bodyKey(campaignId),
                ...body,
              },
            },
          ]),
    ]);
  });

  /** Writes the rules and one variant's body, only while the rules are those read at `revision`. */
  const writeVariant = (
    campaignId: string,
    operation: string,
    routes: Schemas.VariantRoutes,
    revision: number | undefined,
    copy: Action<never>,
  ) =>
    Effect.flatMap(writeRoutes({ routes, revision: (revision ?? 0) + 1 }), (stored) =>
      transact(operation, [
        draftCheck(campaignId, operation),
        {
          Put: {
            Table: tableLogicalId,
            Item: { ...routesKey(campaignId), ...stored },
            ...sameRevision(revision),
          },
          refused: () => new DraftChanged(),
        },
        copy,
      ]),
    );

  /**
   * Sets one variant of a draft: the one with its key is replaced where it stands, so its `when`
   * keeps its turn, and any other is appended. Its rule and its body are written together.
   */
  const setVariant = Effect.fn("Storage.setVariant")(function* (
    campaignId: string,
    key: string,
    variant: Schemas.VariantPayload,
  ) {
    const { routes, revision } = yield* getRoutes(campaignId);
    const route = routeOf(key, variant);
    const index = routes.findIndex((existing) => existing.key === key);
    const next = index === -1 ? [...routes, route] : routes.with(index, route);

    if (next.length > Schemas.maxVariants) {
      return yield* new TooManyVariants({ limit: Schemas.maxVariants });
    }

    const percent = Schemas.splitPercent(next);

    if (percent > Schemas.maxPercent) {
      return yield* new SplitOverfull({ percent });
    }

    const { when: _when, percent: _percent, ...content } = variant;
    const body = yield* writeVariantBody(content);

    yield* writeVariant(campaignId, "setVariant", next, revision, {
      Put: { Table: tableLogicalId, Item: { ...variantBodyKey(campaignId, key), ...body } },
    });
  }, retryDraftRace);

  /** Removes one variant of a draft, its rule and its body together; an unknown key changes nothing. */
  const removeVariant = Effect.fn("Storage.removeVariant")(function* (
    campaignId: string,
    key: string,
  ) {
    const { routes, revision } = yield* getRoutes(campaignId);
    const kept = routes.filter((route) => route.key !== key);

    if (kept.length < routes.length) {
      yield* writeVariant(campaignId, "removeVariant", kept, revision, {
        Delete: { Table: tableLogicalId, Key: variantBodyKey(campaignId, key) },
      });
    }
  }, retryDraftRace);

  /** Deletes a draft and every copy the rules it read name, only while those rules are unchanged. */
  const deleteDraft = Effect.fn("Storage.deleteDraft")(function* (id: string) {
    const { routes, revision } = yield* getRoutes(id);

    // A campaign another delete already removed fails META's condition as not found.
    yield* transact("deleteDraft", [
      {
        Delete: {
          Table: tableLogicalId,
          Key: campaignKey(id),
          ConditionExpression: "#state = :draft",
          ExpressionAttributeNames: stateName,
          ExpressionAttributeValues: { ":draft": str("draft") },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
        refused: notADraft("deleteDraft"),
      },
      { Delete: { Table: tableLogicalId, Key: bodyKey(id) } },
      {
        Delete: { Table: tableLogicalId, Key: routesKey(id), ...sameRevision(revision) },
        refused: () => new DraftChanged(),
      },
      ...routes.map((route) => ({
        Delete: { Table: tableLogicalId, Key: variantBodyKey(id, route.key) },
      })),
    ]);
  }, retryDraftRace);

  /** A variant's content during a run, which no edit can change, so a missing body is corrupt. */
  const getVariantContent = Effect.fn("Storage.getVariantContent")(function* (
    campaignId: string,
    key: string,
  ) {
    const response = yield* readItem("getVariantContent", variantBodyKey(campaignId, key));

    if (response.Item === undefined) {
      return yield* Effect.die(new CorruptItem({ operation: "getVariantContent" }));
    }

    return yield* readVariantBody("getVariantContent", response.Item);
  });

  return {
    ...reads,
    createCampaign,
    getVariantContent,
    listCampaigns,
    getCampaignControl,
    newRun,
    cancelCampaign,
    beginRun,
    claimRecipient,
    skipRecipient,
    settleRecipient,
    checkpoint,
    completeRun,
    pauseRun,
    updateDraft,
    setVariant,
    removeVariant,
    deleteDraft,
  } as const;
};

/**
 * Campaign persistence, including the bounce and complaint counters a `campaigns get` projects.
 * Command transitions (enqueue, schedule, resume, cancel) are single-item transactions so a
 * transport retry reuses `ClientRequestToken`. Worker updates stay on `UpdateItem`; per-recipient
 * claims and settlements remain transactions.
 */
export const campaignStoreOperations = (operations: TableOperations, tokens: TransactionTokens) =>
  campaignOperations(allPrimitives(operations, tokens));

export type CampaignStoreOperations = ReturnType<typeof campaignStoreOperations>;

export class CampaignStore extends Context.Service<CampaignStore, CampaignStoreOperations>()(
  "emailer/backend/CampaignStore",
) {
  static readonly layer = Layer.effect(CampaignStore)(
    Effect.gen(function* () {
      const operations = yield* allTableOperations;
      const crypto = yield* Crypto.Crypto;

      return CampaignStore.of(
        campaignStoreOperations(operations, Effect.orDie(crypto.randomUUIDv4)),
      );
    }),
  ).pipe(Layer.provide(AllTableOperationsHttp));
}

/**
 * Read-only access to one campaign by id. The public preview function holds this and `GetItem`
 * alone, so a leaked preview link can at most read the campaign it names.
 */
export type CampaignReads = ReturnType<typeof campaignReads>;

export class CampaignReader extends Context.Service<CampaignReader, CampaignReads>()(
  "emailer/backend/CampaignReader",
) {
  static readonly layer = Layer.effect(CampaignReader)(
    Effect.gen(function* () {
      const table = yield* dataTable;

      return CampaignReader.of(
        campaignReads(readPrimitives({ getItem: yield* AWS.DynamoDB.GetItem(table) })),
      );
    }),
  ).pipe(Layer.provide(AWS.DynamoDB.GetItemHttp));
}
