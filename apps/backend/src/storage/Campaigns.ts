import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Context, Crypto, Effect, Layer, Schema, SchemaTransformation, Struct } from "effect";

import { corrupt } from "./Errors.ts";
import {
  attributeOf,
  bodyKey,
  campaignKey,
  listingAttributes,
  num,
  NumberAttribute,
  recordVersion,
  str,
  StoredVersionAttribute,
  StringMapAttribute,
  strMap,
  tableLogicalId,
  withOptional,
} from "./Items.ts";
import { allPrimitives, readPrimitives } from "./Primitives.ts";
import { AllTableOperationsHttp, allTableOperations, dataTable } from "./Table.ts";

import type { TableOperations } from "./Items.ts";
import type {
  PagePrimitives,
  ReadPrimitives,
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

const StoredCount = NumberAttribute.check(Schema.isInt());

const StoredCampaign = Schema.Struct({
  v: StoredVersionAttribute,
  id: attributeOf(Schemas.EntityId),
  listId: attributeOf(Schemas.EntityId),
  subject: attributeOf(Schemas.CampaignSubject),
  createdAt: attributeOf(Schemas.Timestamp),
  state: attributeOf(Schemas.CampaignState),
  queuedAt: Schema.optionalKey(attributeOf(Schemas.Timestamp)),
  startedAt: Schema.optionalKey(attributeOf(Schemas.Timestamp)),
  finishedAt: Schema.optionalKey(attributeOf(Schemas.Timestamp)),
  pausedReason: Schema.optionalKey(attributeOf(Schemas.PauseReason)),
  cursor: Schema.optionalKey(attributeOf(Schemas.EntityId)),
  runToken: Schema.optionalKey(attributeOf(Schemas.EntityId)),
  filter: Schema.optionalKey(
    StringMapAttribute.pipe(
      Schema.decodeTo(Schemas.ContactAttributes, SchemaTransformation.passthrough()),
    ),
  ),
  accepted: StoredCount,
  rejected: StoredCount,
  uncertain: StoredCount,
  skipped: StoredCount,
  bounced: StoredCount,
  complained: StoredCount,
  runAccepted: StoredCount,
  runBounced: StoredCount,
  runComplained: StoredCount,
});

const decodeStoredCampaign = Schema.decodeUnknownEffect(StoredCampaign);

const StoredCampaignBody = Schema.Struct({
  v: StoredVersionAttribute,
  text: attributeOf(Schemas.CampaignText),
  html: Schema.optionalKey(attributeOf(Schemas.CampaignHtml)),
});

const decodeStoredCampaignBody = Schema.decodeUnknownEffect(StoredCampaignBody);

const decodeSubmission = Schema.decodeUnknownEffect(Schemas.CampaignSubmission);

export type RecipientSettlement =
  | { readonly state: "accepted"; readonly messageId: string }
  | { readonly state: "rejected"; readonly rejectionCode: Schemas.RejectionCode }
  | { readonly state: "uncertain" };

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

export interface CampaignControl {
  readonly state: Schemas.CampaignState;
  readonly runToken: string | undefined;
  readonly startedAt: string | undefined;
  readonly pausedReason: Schemas.PauseReason | undefined;
}

export type RunSource = {
  readonly state: "draft" | "scheduled" | "paused";
  readonly runToken: string | undefined;
};

export type CancelSource =
  | { readonly state: "scheduled"; readonly runToken: string }
  | { readonly state: "queued"; readonly runToken: string; readonly started: boolean };

const submissionOf = (stored: typeof StoredCampaign.Type) => {
  const run = {
    queuedAt: stored.queuedAt,
    startedAt: stored.startedAt,
    progress: {
      accepted: stored.accepted,
      rejected: stored.rejected,
      uncertain: stored.uncertain,
      skipped: stored.skipped,
    },
    feedback: { bounced: stored.bounced, complained: stored.complained },
  };

  switch (stored.state) {
    case "draft":
      return { state: "draft" as const };
    case "scheduled":
      // For a scheduled campaign `queuedAt` is the instant the wake-up is due.
      return { state: "scheduled" as const, sendAt: stored.queuedAt };
    case "queued":
      return { state: "queued" as const, queuedAt: stored.queuedAt };
    case "sending":
      return { state: "sending" as const, ...run };
    case "paused":
      return { state: "paused" as const, ...run, reason: stored.pausedReason };
    case "completed":
      return { state: "completed" as const, ...run, finishedAt: stored.finishedAt };
  }
};

const summaryOf = (stored: typeof StoredCampaign.Type) =>
  decodeSubmission(submissionOf(stored)).pipe(
    Effect.map((submission): Schemas.CampaignSummary => {
      const summary = {
        id: stored.id,
        listId: stored.listId,
        subject: stored.subject,
        createdAt: stored.createdAt,
        submission,
      };

      return stored.filter === undefined ? summary : { ...summary, filter: stored.filter };
    }),
  );

const controlOf = (stored: typeof StoredCampaign.Type): CampaignControl => ({
  state: stored.state,
  runToken: stored.runToken,
  startedAt: stored.startedAt,
  pausedReason: stored.pausedReason,
});

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

const settlementWrite = (settlement: RecipientSettlement) => {
  switch (settlement.state) {
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

const bodyItem = (campaign: Schemas.Campaign) =>
  withOptional({ ...bodyKey(campaign.id), v: num(recordVersion), text: str(campaign.text) }, [
    ["html", campaign.html],
  ]);

/** The two reads a campaign's content needs, and all the public preview function may do. */
const campaignReads = (primitives: ReadPrimitives) => {
  const { readItem } = primitives;

  // No absent case: every caller holds a META that proves the campaign exists, so a missing body
  // is corrupt, which decoding an undefined item reports.
  const getCampaignBody = Effect.fn("Storage.getCampaignBody")(function* (campaignId: string) {
    const response = yield* readItem("getCampaignBody", bodyKey(campaignId));

    const stored = yield* decodeStoredCampaignBody(response.Item).pipe(
      Effect.mapError(corrupt("getCampaignBody")),
    );

    return Struct.omit(stored, ["v"]);
  });

  const getCampaign = Effect.fn("Storage.getCampaign")(function* (campaignId: string) {
    const response = yield* readItem("getCampaign", campaignKey(campaignId));

    if (response.Item === undefined) {
      return yield* new Schemas.NotFound({ entity: "campaign" });
    }

    const stored = yield* decodeStoredCampaign(response.Item).pipe(
      Effect.mapError(corrupt("getCampaign")),
    );

    const summary = yield* summaryOf(stored).pipe(Effect.mapError(corrupt("getCampaign")));
    const body = yield* getCampaignBody(campaignId);

    return { ...summary, ...body } satisfies Schemas.Campaign;
  });

  return { getCampaignBody, getCampaign } as const;
};

export const campaignOperations = (
  primitives: ReadPrimitives &
    WritePrimitives &
    TransactionPrimitives &
    UpdatePrimitives &
    PagePrimitives,
) => {
  const { readEntityPage, readItem, recordOnce, runTransaction, updateIf } = primitives;
  const { getCampaignBody, getCampaign } = campaignReads(primitives);

  // Both keys are fresh identifiers, so an item already there can only be this request landing
  // again after a lost response: `recordOnce` reports that as done, which it is. BODY goes first
  // so that META is the commit point: a create interrupted between the two leaves nothing that
  // any key, index entry or query can reach.
  const createCampaign = Effect.fn("Storage.createCampaign")(function* (
    campaign: Schemas.Campaign,
  ) {
    yield* recordOnce("createCampaign", bodyItem(campaign));

    const item = {
      ...campaignKey(campaign.id),
      ...listingAttributes(campaignKind, campaign.createdAt, campaign.id),
      v: num(recordVersion),
      id: str(campaign.id),
      listId: str(campaign.listId),
      subject: str(campaign.subject),
      createdAt: str(campaign.createdAt),
      state: str("draft"),
      accepted: num(0),
      rejected: num(0),
      uncertain: num(0),
      skipped: num(0),
      bounced: num(0),
      complained: num(0),
      runAccepted: num(0),
      runBounced: num(0),
      runComplained: num(0),
    };

    // `filter` is a reserved word; no expression names it, and any future one must alias `#filter`.
    yield* recordOnce(
      "createCampaign",
      campaign.filter === undefined ? item : { ...item, filter: strMap(campaign.filter) },
    );
  });

  const listCampaigns = Effect.fn("Storage.listCampaigns")(function* (
    limit: number,
    cursor: string | undefined,
  ) {
    const page = yield* readEntityPage("listCampaigns", campaignKind, campaignKey, limit, cursor);

    const campaigns = yield* Effect.forEach(page.items, (item) =>
      decodeStoredCampaign(item).pipe(
        Effect.flatMap(summaryOf),
        Effect.mapError(corrupt("listCampaigns")),
      ),
    );

    return { ...page, items: campaigns } satisfies StoredPage<Schemas.CampaignSummary, string>;
  });

  // Tokenless virgin drafts are valid here; a missing token on queued/scheduled is the command's
  // problem, not a second decoder.
  const getCampaignControl = Effect.fn("Storage.getCampaignControl")(function* (
    campaignId: string,
  ) {
    const response = yield* readItem("getCampaignControl", campaignKey(campaignId));

    if (response.Item === undefined) {
      return yield* new Schemas.NotFound({ entity: "campaign" });
    }

    const stored = yield* decodeStoredCampaign(response.Item).pipe(
      Effect.mapError(corrupt("getCampaignControl")),
    );

    return controlOf(stored);
  });

  const commitLifecycle = (
    operationId: string,
    id: string,
    update: {
      readonly UpdateExpression: string;
      readonly ConditionExpression: string;
      readonly ExpressionAttributeValues: Record<string, ReturnType<typeof str>>;
    },
  ) =>
    runTransaction(operationId, {
      TransactItems: [
        {
          Update: {
            Table: tableLogicalId,
            Key: campaignKey(id),
            ExpressionAttributeNames: stateName,
            ...update,
          },
        },
      ],
    });

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
    const operationId =
      target === "scheduled"
        ? "scheduleCampaign"
        : expected.state === "paused"
          ? "resumeCampaign"
          : "enqueueCampaign";

    const outcome = yield* commitLifecycle(operationId, id, {
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

    return outcome.committed ? target : ("conflict" as const);
  });

  const cancelCampaign = Effect.fn("Storage.cancelCampaign")(function* (
    id: string,
    source: CancelSource,
  ) {
    const outcome =
      source.state === "scheduled"
        ? yield* commitLifecycle("cancelCampaign", id, {
            UpdateExpression: "SET #state = :draft REMOVE queuedAt",
            ConditionExpression: "#state = :scheduled AND runToken = :expected",
            ExpressionAttributeValues: {
              ":draft": str("draft"),
              ":scheduled": str("scheduled"),
              ":expected": str(source.runToken),
            },
          })
        : source.started
          ? yield* commitLifecycle("cancelCampaign", id, {
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
          : yield* commitLifecycle("cancelCampaign", id, {
              UpdateExpression: "SET #state = :draft REMOVE queuedAt",
              ConditionExpression:
                "#state = :queued AND runToken = :expected AND attribute_not_exists(startedAt)",
              ExpressionAttributeValues: {
                ":draft": str("draft"),
                ":queued": str("queued"),
                ":expected": str(source.runToken),
              },
            });

    return outcome.committed ? ("applied" as const) : ("conflict" as const);
  });

  const beginRun = Effect.fn("Storage.beginRun")(function* (
    id: string,
    runToken: string,
    now: string,
  ) {
    const outcome = yield* updateIf("beginRun", {
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
    });

    if (!outcome.applied) {
      return "stale" as const;
    }

    const stored = yield* decodeStoredCampaign(outcome.attributes).pipe(
      Effect.mapError(corrupt("beginRun")),
    );

    return {
      outcome: "running" as const,
      campaign: {
        listId: stored.listId,
        subject: stored.subject,
        cursor: stored.cursor,
        filter: stored.filter,
        run: {
          accepted: stored.accepted - stored.runAccepted,
          bounced: stored.bounced - stored.runBounced,
          complained: stored.complained - stored.runComplained,
        },
      } satisfies CampaignRun,
    };
  });

  const claimRecipient = Effect.fn("Storage.claimRecipient")(function* (
    id: string,
    runToken: string,
    contactId: string,
    recipient: string,
    sendId: string,
    now: string,
  ) {
    const outcome = yield* runTransaction("claimRecipient", {
      TransactItems: [
        {
          ConditionCheck: {
            Table: tableLogicalId,
            Key: campaignKey(id),
            ConditionExpression: "#state = :sending AND runToken = :run",
            ExpressionAttributeNames: stateName,
            ExpressionAttributeValues: sendingAndRun(runToken),
          },
        },
        {
          Put: {
            Table: tableLogicalId,
            Item: {
              ...sendKey(id, contactId),
              v: num(recordVersion),
              sendId: str(sendId),
              contactId: str(contactId),
              recipient: str(recipient),
              state: str("unconfirmed"),
              startedAt: str(now),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    });

    if (outcome.committed) {
      return "claimed" as const;
    }

    if (outcome.conditionFailures.has(0)) {
      return "stale" as const;
    }

    return "already-claimed" as const;
  });

  const skipRecipient = Effect.fn("Storage.skipRecipient")(function* (
    id: string,
    runToken: string,
    contactId: string,
    recipient: string,
    reason: Schemas.SkipReason,
    now: string,
  ) {
    const outcome = yield* runTransaction("skipRecipient", {
      TransactItems: [
        {
          Put: {
            Table: tableLogicalId,
            Item: {
              ...sendKey(id, contactId),
              v: num(recordVersion),
              contactId: str(contactId),
              recipient: str(recipient),
              state: str("skipped"),
              skipReason: str(reason),
              startedAt: str(now),
              finishedAt: str(now),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
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
        },
      ],
    });

    if (outcome.committed) {
      return "skipped" as const;
    }

    if (outcome.conditionFailures.has(0)) {
      return "already-claimed" as const;
    }

    return "stale" as const;
  });

  const settleRecipient = Effect.fn("Storage.settleRecipient")(function* (
    id: string,
    sendId: string,
    contactId: string,
    settlement: RecipientSettlement,
    now: string,
  ) {
    const terminal = settlementWrite(settlement);

    const outcome = yield* runTransaction("settleRecipient", {
      TransactItems: [
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
        },
        {
          Update: {
            Table: tableLogicalId,
            Key: campaignKey(id),
            UpdateExpression: `ADD ${terminal.counter} :one`,
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeValues: { ":one": num(1) },
          },
        },
      ],
    });

    return outcome.committed ? ("settled" as const) : ("not-current" as const);
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

    const outcome = yield* updateIf("checkpoint", {
      Key: campaignKey(id),
      UpdateExpression: "SET #cursor = :next, sliceId = :slice",
      ConditionExpression: `#state = :sending AND runToken = :run AND (${from} OR ${alreadyMine})`,
      ExpressionAttributeNames: stateAndCursorNames,
      ExpressionAttributeValues:
        previous === undefined ? values : { ...values, ":previous": str(previous) },
    });

    return outcome.applied ? ("updated" as const) : ("condition-failed" as const);
  });

  const completeRun = Effect.fn("Storage.completeRun")(function* (
    id: string,
    runToken: string,
    now: string,
  ) {
    const outcome = yield* updateIf("completeRun", {
      Key: campaignKey(id),
      UpdateExpression: "SET #state = :completed, finishedAt = :now REMOVE #cursor, sliceId",
      ConditionExpression: "#state = :sending AND runToken = :run",
      ExpressionAttributeNames: stateAndCursorNames,
      ExpressionAttributeValues: {
        ":completed": str("completed"),
        ":now": str(now),
        ...sendingAndRun(runToken),
      },
    });

    return outcome.applied ? ("completed" as const) : ("stale" as const);
  });

  const pauseRun = Effect.fn("Storage.pauseRun")(function* (
    id: string,
    runToken: string,
    reason: Schemas.PauseReason,
    cursor: string | undefined,
  ) {
    const values = { ":paused": str("paused"), ":reason": str(reason), ...sendingAndRun(runToken) };

    const outcome = yield* updateIf(
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
    );

    return outcome.applied ? ("paused" as const) : ("stale" as const);
  });

  // One fixed shape: the caller merges the change into the whole draft, so META's editable fields
  // and BODY are rewritten together, and only while the campaign is still a draft. A campaign
  // deleted meanwhile fails the same condition, since its state no longer exists.
  const updateDraft = Effect.fn("Storage.updateDraft")(function* (campaign: Schemas.Campaign) {
    const values = {
      ":subject": str(campaign.subject),
      ":listId": str(campaign.listId),
      ":draft": str("draft"),
    };

    const outcome = yield* runTransaction("updateDraft", {
      TransactItems: [
        {
          Update: {
            Table: tableLogicalId,
            Key: campaignKey(campaign.id),
            ConditionExpression: "#state = :draft",
            ExpressionAttributeNames: draftNames,
            ...(campaign.filter === undefined
              ? {
                  UpdateExpression: "SET subject = :subject, listId = :listId REMOVE #filter",
                  ExpressionAttributeValues: values,
                }
              : {
                  UpdateExpression: "SET subject = :subject, listId = :listId, #filter = :filter",
                  ExpressionAttributeValues: { ...values, ":filter": strMap(campaign.filter) },
                }),
          },
        },
        { Put: { Table: tableLogicalId, Item: bodyItem(campaign) } },
      ],
    });

    return outcome.committed ? ("updated" as const) : ("conflict" as const);
  });

  const deleteDraft = Effect.fn("Storage.deleteDraft")(function* (id: string) {
    const outcome = yield* runTransaction("deleteDraft", {
      TransactItems: [
        {
          Delete: {
            Table: tableLogicalId,
            Key: campaignKey(id),
            ConditionExpression: "#state = :draft",
            ExpressionAttributeNames: stateName,
            ExpressionAttributeValues: { ":draft": str("draft") },
          },
        },
        { Delete: { Table: tableLogicalId, Key: bodyKey(id) } },
      ],
    });

    return outcome.committed ? ("deleted" as const) : ("conflict" as const);
  });

  return {
    createCampaign,
    getCampaignBody,
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
) {}

/**
 * Read-only access to one campaign by id. The public preview function holds this and `GetItem`
 * alone, so a leaked preview link can at most read the campaign it names.
 */
export type CampaignReads = ReturnType<typeof campaignReads>;

export class CampaignReader extends Context.Service<CampaignReader, CampaignReads>()(
  "emailer/backend/CampaignReader",
) {}

export const CampaignReaderLive = Layer.effect(CampaignReader)(
  Effect.gen(function* () {
    const table = yield* dataTable;

    return CampaignReader.of(
      campaignReads(readPrimitives({ getItem: yield* AWS.DynamoDB.GetItem(table) })),
    );
  }),
).pipe(Layer.provide(AWS.DynamoDB.GetItemHttp));

export const CampaignStoreLive = Layer.effect(CampaignStore)(
  Effect.gen(function* () {
    const operations = yield* allTableOperations;
    const crypto = yield* Crypto.Crypto;

    return CampaignStore.of(campaignStoreOperations(operations, Effect.orDie(crypto.randomUUIDv4)));
  }),
).pipe(Layer.provide(AllTableOperationsHttp));
