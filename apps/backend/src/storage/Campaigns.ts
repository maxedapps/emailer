import { CampaignNotFound, CampaignStateConflict, DraftChanged } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Context, Crypto, Data, Effect, Layer, Predicate, Schema } from "effect";

import {
  bodyKey,
  campaignKey,
  itemReader,
  itemWriter,
  listingAttributes,
  num,
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

/**
 * The campaign's own copy, which also records the alternate copies' rules in order: the one item a
 * slice already reads, rather than `META`, which every settlement rewrites and pays for by size.
 * The rules are a JSON string, which nothing evaluates into. `revision` counts draft edits, so an
 * edit or a delete writes only against the copies it read; a body from before revisions has none.
 */
const BodyRecord = Schema.Struct({
  ...Schemas.CampaignBody.fields,
  variants: Schema.optionalKey(Schema.fromJsonString(Schemas.VariantRoutes)),
  revision: Schema.optionalKey(Schema.Int),
});

type BodyRecord = typeof BodyRecord.Type;

const readBody = itemReader(BodyRecord);

const writeBody = itemWriter(BodyRecord);

/** An alternate copy's content, one item per variant; its rule lives on the default body. */
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

const draftNames = { "#state": "state", "#filter": "filter" };

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

/** A variant's rule, without its content. */
const routeOf = (variant: Schemas.Variant): Schemas.VariantRoute =>
  variant.when === undefined
    ? { key: variant.key, percent: variant.percent }
    : { key: variant.key, when: variant.when };

const variantOf = (route: Schemas.VariantRoute, body: typeof VariantBody.Type): Schemas.Variant =>
  route.when === undefined
    ? { key: route.key, percent: route.percent, ...body }
    : { key: route.key, when: route.when, ...body };

/** Every copy's item, the campaign's own body first; `revision` is the edit it is written as. */
const copyItems = (campaign: Schemas.Campaign, revision: number) =>
  Effect.gen(function* () {
    const text = { text: campaign.text, revision };
    const withHtml = campaign.html === undefined ? text : { ...text, html: campaign.html };

    const own = yield* writeBody(
      campaign.variants === undefined
        ? withHtml
        : { ...withHtml, variants: campaign.variants.map(routeOf) },
    );

    const variants = yield* Effect.forEach(
      campaign.variants ?? [],
      ({ key, when: _when, percent: _percent, ...content }) =>
        Effect.map(writeVariantBody(content), (attributes) => ({
          ...variantBodyKey(campaign.id, key),
          ...attributes,
        })),
    );

    return { own: { ...bodyKey(campaign.id), ...own }, variants };
  });

/** The condition a draft write asserts on the body it read: the same edit, or none before them. */
const sameRevision = (revision: number | undefined) =>
  revision === undefined
    ? { ConditionExpression: "attribute_not_exists(revision)" }
    : {
        ConditionExpression: "revision = :revision",
        ExpressionAttributeValues: { ":revision": num(revision) },
      };

/** A draft write that lost a race with another edit or a delete retries from a fresh read. */
const retryDraftRace = <A, E, R>(write: Effect.Effect<A, E, R>) =>
  Effect.retry(write, { times: 2, while: Predicate.isTagged("DraftChanged") });

/** The reads a campaign's content needs, and all the public preview function may do. */
const campaignReads = (primitives: ReadPrimitives) => {
  const { readItem } = primitives;

  /**
   * Every copy: the campaign's own body, then each variant its rules name, each by `GetItem`, so
   * the preview function needs nothing broader. No absent case: every caller holds a META that
   * proves the campaign exists, so a missing body is corrupt, which decoding an undefined item
   * reports.
   */
  const getOwnBody = Effect.fn("Storage.getOwnBody")(function* (campaignId: string) {
    const response = yield* readItem("getOwnBody", bodyKey(campaignId));

    return yield* readBody("getOwnBody", response.Item);
  });

  const getCopies = Effect.fn("Storage.getCopies")(function* (campaignId: string) {
    const stored = yield* getOwnBody(campaignId);

    const variants = yield* Effect.forEach(
      stored.variants ?? [],
      (route) =>
        readItem("getCopies", variantBodyKey(campaignId, route.key)).pipe(
          Effect.flatMap((variant) => readVariantBody("getCopies", variant.Item)),
          Effect.map((body) => variantOf(route, body)),
        ),
      { concurrency: "unbounded" },
    );

    const body: Schemas.CampaignBody =
      stored.html === undefined ? { text: stored.text } : { text: stored.text, html: stored.html };

    return { body, variants, revision: stored.revision };
  });

  /** The whole campaign, and the revision of the copies it was read at. */
  const loadCampaign = Effect.fn("Storage.loadCampaign")(function* (campaignId: string) {
    const response = yield* readItem("getCampaign", campaignKey(campaignId));

    if (response.Item === undefined) {
      return yield* new CampaignNotFound();
    }

    const stored = yield* readCampaign("getCampaign", response.Item);
    const { body, variants, revision } = yield* getCopies(campaignId);
    const campaign: Schemas.Campaign = { ...summaryOf(stored), ...body };

    return { campaign: variants.length === 0 ? campaign : { ...campaign, variants }, revision };
  });

  const getCampaign = Effect.fn("Storage.getCampaign")(function* (campaignId: string) {
    return (yield* loadCampaign(campaignId)).campaign;
  });

  return { getCopies, loadCampaign, getCampaign } as const;
};

export const campaignOperations = (
  primitives: ReadPrimitives &
    WritePrimitives &
    TransactionPrimitives &
    UpdatePrimitives &
    PagePrimitives,
) => {
  const { readEntityPage, readItem, recordOnce, transact, updateIf } = primitives;
  const { getCopies, loadCampaign, getCampaign } = campaignReads(primitives);

  // Every key is fresh, so an item already there can only be this request landing again after a
  // lost response: `recordOnce` reports that as done, which it is. The bodies go first so that
  // META is the commit point: a create interrupted before it leaves nothing that any key, index
  // entry or query can reach.
  const createCampaign = Effect.fn("Storage.createCampaign")(function* (
    campaign: Schemas.Campaign,
  ) {
    const copies = yield* copyItems(campaign, 1);

    for (const item of [...copies.variants, copies.own]) {
      yield* recordOnce("createCampaign", item);
    }

    const {
      text: _text,
      html: _html,
      variants: _variants,
      submission: _submission,
      ...summary
    } = campaign;

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
   * Rewrites a draft as `edit` makes it from the draft just read, in one fixed shape: META's
   * editable fields, only while the campaign is still a draft, and every copy, with the bodies of
   * dropped variants deleted. The body is written only against the revision read, so a concurrent
   * edit or delete makes this one retry from a fresh read rather than leave a body behind. A
   * campaign deleted meanwhile fails META's condition, since its state no longer exists, and the
   * item the condition returns tells the two apart.
   */
  const updateDraft = Effect.fn("Storage.updateDraft")(function* (
    campaignId: string,
    edit: (current: Schemas.Campaign) => Schemas.Campaign,
  ) {
    const { campaign: current, revision } = yield* loadCampaign(campaignId);

    if (current.submission.state !== "draft") {
      return yield* new CampaignStateConflict({ state: current.submission.state });
    }

    const next = edit(current);
    const copies = yield* copyItems(next, (revision ?? 0) + 1);
    const kept = new Set((next.variants ?? []).map((variant) => variant.key));

    const values = {
      ":subject": str(next.subject),
      ":listId": str(next.listId),
      ":draft": str("draft"),
    };

    const actions: Array<Action<CampaignNotFound | CampaignStateConflict | DraftChanged>> = [
      {
        Update: {
          Table: tableLogicalId,
          Key: campaignKey(campaignId),
          ConditionExpression: "#state = :draft",
          ExpressionAttributeNames: draftNames,
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          ...(next.filter === undefined
            ? {
                UpdateExpression: "SET subject = :subject, listId = :listId REMOVE #filter",
                ExpressionAttributeValues: values,
              }
            : {
                UpdateExpression: "SET subject = :subject, listId = :listId, #filter = :filter",
                ExpressionAttributeValues: { ...values, ":filter": strMap(next.filter) },
              }),
        },
        refused: notADraft("updateDraft"),
      },
      {
        Put: { Table: tableLogicalId, Item: copies.own, ...sameRevision(revision) },
        refused: () => new DraftChanged(),
      },
      ...copies.variants.map((item) => ({ Put: { Table: tableLogicalId, Item: item } })),
      ...(current.variants ?? [])
        .filter((variant) => !kept.has(variant.key))
        .map((variant) => ({
          Delete: { Table: tableLogicalId, Key: variantBodyKey(campaignId, variant.key) },
        })),
    ];

    yield* transact("updateDraft", actions);

    return next;
  }, retryDraftRace);

  /** Deletes a draft and every copy the body it read names, only while that body is unchanged. */
  const deleteDraft = Effect.fn("Storage.deleteDraft")(function* (id: string) {
    // Read first, so a campaign another delete already removed is simply not found.
    const response = yield* readItem("deleteDraft", bodyKey(id));

    if (response.Item === undefined) {
      return yield* new CampaignNotFound();
    }

    const { variants = [], revision } = yield* readBody("deleteDraft", response.Item);

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
      {
        Delete: { Table: tableLogicalId, Key: bodyKey(id), ...sameRevision(revision) },
        refused: () => new DraftChanged(),
      },
      ...variants.map((variant) => ({
        Delete: { Table: tableLogicalId, Key: variantBodyKey(id, variant.key) },
      })),
    ]);
  }, retryDraftRace);

  return {
    createCampaign,
    getCopies,
    getCampaign,
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
