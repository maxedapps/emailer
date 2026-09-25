import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Result } from "effect";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { CorruptItem } from "../Errors.ts";
import {
  CampaignChanged,
  campaignOperations,
  RunSuperseded,
  SettlementNotApplied,
} from "./Campaigns.ts";
import { str, strMap, tableLogicalId } from "./Items.ts";
import {
  campaignId,
  cancelled,
  conditionFailed,
  contactId,
  createdAt,
  defectOf,
  listId,
  primitivesFor,
  scriptedTable,
  serverError,
  withOptional,
} from "./Testing.ts";

import type { Table } from "./Testing.ts";

import type { ScriptedReplies } from "./Testing.ts";

const operationsFor = (table: Table) => campaignOperations(primitivesFor(table));

/** A plausible physical table name: what AWS keys batch responses by, and the binding never maps back. */
const physicalName = "emailer-test-EmailerData-9f3c";

const otherCampaignId = "0195f0a0-1111-4222-8333-4444444ca40a";

const olderCreatedAt = "2026-09-10T10:00:00.000Z";

const sendId = "0195f0a0-1111-4222-8333-44444444e5d1";

const runToken = "0195f0a0-1111-4222-8333-44444444e5d2";

const sliceId = "0195f0a0-1111-4222-8333-44444444s1ce";

const nextContactId = "0195f0a0-1111-4222-8333-44444444c002";

const queuedAt = "2026-09-11T10:00:01.000Z";

const startedAt = "2026-09-11T10:00:02.000Z";

const finishedAt = "2026-09-11T10:00:03.000Z";

const now = "2026-09-11T10:00:04.000Z";

const multiByteText = "Grüße 😀\nzweite Zeile\t— ende";

const multiByteHtml = "<p>Grüße 😀</p>\n<p>zweite Zeile\t— ende</p>";

const recipient = "success@simulator.amazonses.com";

const progress = { accepted: 1, rejected: 2, uncertain: 3, skipped: 4 };

const reservedAttributeName = /(?<![:#])\b(count|state|cursor|text|filter)\b/;

const expectAliasedReservedNames = (table: Table) => {
  const expressions: Array<string | undefined> = [];

  for (const request of table.updateItemRequests) {
    expressions.push(request.ConditionExpression, request.UpdateExpression);
  }

  for (const request of table.transactionRequests) {
    for (const item of request.TransactItems) {
      expressions.push(
        item.ConditionCheck?.ConditionExpression,
        item.Put?.ConditionExpression,
        item.Update?.ConditionExpression,
        item.Update?.UpdateExpression,
      );
    }
  }

  for (const expression of expressions) {
    if (expression !== undefined) {
      expect(expression).not.toMatch(reservedAttributeName);
    }
  }
};

interface StoredCampaignFields {
  readonly state: string;
  readonly queuedAt?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly finishedAt?: string | undefined;
  readonly pausedReason?: string | undefined;
  readonly cursor?: string | undefined;
  readonly runToken?: string | undefined;
  readonly accepted?: number | undefined;
  readonly rejected?: number | undefined;
  readonly uncertain?: number | undefined;
  readonly skipped?: number | undefined;
  readonly bounced?: number | undefined;
  readonly complained?: number | undefined;
  readonly runAccepted?: number | undefined;
  readonly runBounced?: number | undefined;
  readonly runComplained?: number | undefined;
  readonly filter?: Schemas.ContactAttributes;
}

const meta = (fields: StoredCampaignFields): dynamodb.AttributeMap => {
  const item = withOptional(
    {
      pk: { S: `CAMPAIGN#${campaignId}` },
      sk: { S: "META" },
      v: { N: "1" },
      id: { S: campaignId },
      listId: { S: listId },
      subject: { S: "Release" },
      createdAt: { S: createdAt },
      state: { S: fields.state },
      accepted: { N: String(fields.accepted ?? 0) },
      rejected: { N: String(fields.rejected ?? 0) },
      uncertain: { N: String(fields.uncertain ?? 0) },
      skipped: { N: String(fields.skipped ?? 0) },
      bounced: { N: String(fields.bounced ?? 0) },
      complained: { N: String(fields.complained ?? 0) },
      runAccepted: { N: String(fields.runAccepted ?? 0) },
      runBounced: { N: String(fields.runBounced ?? 0) },
      runComplained: { N: String(fields.runComplained ?? 0) },
    },
    [
      ["queuedAt", fields.queuedAt],
      ["startedAt", fields.startedAt],
      ["finishedAt", fields.finishedAt],
      ["pausedReason", fields.pausedReason],
      ["cursor", fields.cursor],
      // Every state past draft holds its run's token.
      ["runToken", fields.runToken ?? (fields.state === "draft" ? undefined : runToken)],
    ],
  );

  return fields.filter === undefined ? item : { ...item, filter: strMap(fields.filter) };
};

const body = (html?: string) =>
  withOptional(
    {
      pk: { S: `CAMPAIGN#${campaignId}` },
      sk: { S: "BODY" },
      v: { N: "1" },
      text: { S: "Body" },
    },
    [["html", html]],
  );

type CampaignStorage = ReturnType<typeof operationsFor>;

/** Every table the running test created, so the sweep below reaches each of them. */
const tables: Array<Table> = [];

const withStorage = (replies: ScriptedReplies) => {
  const table = scriptedTable(replies);

  tables.push(table);

  return { table, storage: operationsFor(table) };
};

afterEach(() => {
  for (const table of tables.splice(0)) {
    expectAliasedReservedNames(table);
  }
});

describe("campaign records", () => {
  it.effect("stores html in the body item, never on META, and reads it back", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.createCampaign({
        id: campaignId,
        listId,
        subject: "Grüße 😀",
        text: multiByteText,
        html: multiByteHtml,
        createdAt,
        submission: { state: "draft" },
      });

      const writtenBody = table.putItemRequests[0]?.Item ?? {};

      expect(writtenBody["text"]).toStrictEqual({ S: multiByteText });
      expect(writtenBody["html"]).toStrictEqual({ S: multiByteHtml });
      expect(table.putItemRequests[1]?.Item).not.toHaveProperty("html");

      const readBack = withStorage({
        getItem: [
          Effect.succeed({ Item: table.putItemRequests[1]?.Item ?? {} }),
          Effect.succeed({ Item: writtenBody }),
        ],
      });

      const campaign = yield* readBack.storage.getCampaign(campaignId);

      expect(campaign).toStrictEqual({
        id: campaignId,
        listId,
        subject: "Grüße 😀",
        text: multiByteText,
        html: multiByteHtml,
        createdAt,
        submission: { state: "draft" },
      });
    }),
  );

  it.effect(
    "always stores a new campaign as a draft with zero counters, whatever the caller passed",
    () =>
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        yield* storage.createCampaign({
          id: campaignId,
          listId,
          subject: "Release",
          text: "Body",
          createdAt,
          submission: {
            state: "completed",
            queuedAt,
            startedAt,
            finishedAt,
            progress,
            feedback: { bounced: 0, complained: 0 },
          },
        });

        const written = table.putItemRequests[1]?.Item ?? {};

        expect(written["state"]).toStrictEqual({ S: "draft" });
        expect(written["accepted"]).toStrictEqual({ N: "0" });
        expect(written["rejected"]).toStrictEqual({ N: "0" });
        expect(written["uncertain"]).toStrictEqual({ N: "0" });
        expect(written["skipped"]).toStrictEqual({ N: "0" });
        expect(written["bounced"]).toStrictEqual({ N: "0" });
        expect(written["complained"]).toStrictEqual({ N: "0" });
        expect(written["runAccepted"]).toStrictEqual({ N: "0" });
        expect(written["runBounced"]).toStrictEqual({ N: "0" });
        expect(written["runComplained"]).toStrictEqual({ N: "0" });
        expect(written).not.toHaveProperty("runToken");
        expect(written).not.toHaveProperty("cursor");
        expect(written).not.toHaveProperty("queuedAt");
        expect(written).not.toHaveProperty("html");
        expect(written).not.toHaveProperty("sendId");
        expect(written).not.toHaveProperty("messageId");
        expect(written).not.toHaveProperty("filter");
      }),
  );

  it.effect("decodes every public state including progress", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        // Every `getCampaign` reads META then BODY, so the replies interleave.
        getItem: [
          Effect.succeed({ Item: meta({ state: "draft" }) }),
          Effect.succeed({ Item: body() }),
          Effect.succeed({ Item: meta({ state: "scheduled", queuedAt }) }),
          Effect.succeed({ Item: body() }),
          Effect.succeed({ Item: meta({ state: "queued", queuedAt }) }),
          Effect.succeed({ Item: body() }),
          Effect.succeed({
            Item: meta({
              state: "sending",
              queuedAt,
              startedAt,
              ...progress,
            }),
          }),
          Effect.succeed({ Item: body() }),
          Effect.succeed({
            Item: meta({
              state: "paused",
              queuedAt,
              startedAt,
              pausedReason: "rate-limited",
              ...progress,
            }),
          }),
          Effect.succeed({ Item: body() }),
          Effect.succeed({
            Item: meta({
              state: "completed",
              queuedAt,
              startedAt,
              finishedAt,
              ...progress,
            }),
          }),
          Effect.succeed({ Item: body() }),
        ],
      });

      expect((yield* storage.getCampaign(campaignId)).submission).toStrictEqual({
        state: "draft",
      });
      expect((yield* storage.getCampaign(campaignId)).submission).toStrictEqual({
        state: "scheduled",
        sendAt: queuedAt,
      });
      expect((yield* storage.getCampaign(campaignId)).submission).toStrictEqual({
        state: "queued",
        queuedAt,
      });
      expect((yield* storage.getCampaign(campaignId)).submission).toStrictEqual({
        state: "sending",
        queuedAt,
        startedAt,
        progress,
        feedback: { bounced: 0, complained: 0 },
      });
      expect((yield* storage.getCampaign(campaignId)).submission).toStrictEqual({
        state: "paused",
        queuedAt,
        startedAt,
        progress,
        feedback: { bounced: 0, complained: 0 },
        reason: "rate-limited",
      });
      expect((yield* storage.getCampaign(campaignId)).submission).toStrictEqual({
        state: "completed",
        queuedAt,
        startedAt,
        finishedAt,
        progress,
        feedback: { bounced: 0, complained: 0 },
      });
    }),
  );

  it.effect("treats a sending campaign without a queuedAt as corrupt", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        getItem: [
          Effect.succeed({
            Item: meta({ state: "sending", startedAt }),
          }),
        ],
      });

      const defect = yield* defectOf(storage.getCampaign(campaignId));

      expect(defect).toStrictEqual(new CorruptItem({ operation: "getCampaign" }));
    }),
  );

  it.effect("reads META then BODY and merges them into one campaign", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({
        getItem: [
          Effect.succeed({ Item: meta({ state: "draft" }) }),
          Effect.succeed({ Item: body() }),
        ],
      });

      const campaign = yield* storage.getCampaign(campaignId);

      expect(table.getItemRequests.map((request) => request.Key)).toStrictEqual([
        { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "BODY" } },
      ]);
      expect(campaign).toStrictEqual({
        id: campaignId,
        listId,
        subject: "Release",
        createdAt,
        submission: { state: "draft" },
        text: "Body",
      });
    }),
  );

  it.effect("projects a stored filter into the campaign", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        getItem: [
          Effect.succeed({ Item: meta({ state: "draft", filter: { plan: "pro" } }) }),
          Effect.succeed({ Item: body() }),
        ],
      });

      expect(yield* storage.getCampaign(campaignId)).toStrictEqual({
        id: campaignId,
        listId,
        subject: "Release",
        createdAt,
        submission: { state: "draft" },
        text: "Body",
        filter: { plan: "pro" },
      });
    }),
  );

  it.effect("treats a META without a BODY as corrupt", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        getItem: [Effect.succeed({ Item: meta({ state: "draft" }) }), Effect.succeed({})],
      });

      const defect = yield* defectOf(storage.getCampaign(campaignId));

      expect(defect).toStrictEqual(new CorruptItem({ operation: "getCampaignBody" }));
    }),
  );
});

describe("getCampaignBody", () => {
  it.effect("reads the BODY key and projects the text", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({
        getItem: [Effect.succeed({ Item: body() })],
      });

      expect(yield* storage.getCampaignBody(campaignId)).toStrictEqual({ text: "Body" });
      expect(table.getItemRequests[0]?.Key).toStrictEqual({
        pk: { S: `CAMPAIGN#${campaignId}` },
        sk: { S: "BODY" },
      });
    }),
  );
});

describe("getCampaignControl", () => {
  it.effect(
    "returns state, run token, startedAt and pausedReason from one strongly consistent META read",
    () =>
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          getItem: [
            Effect.succeed({
              Item: meta({
                state: "paused",
                queuedAt,
                startedAt,
                pausedReason: "manual",
                runToken,
              }),
            }),
          ],
        });

        expect(yield* storage.getCampaignControl(campaignId)).toMatchObject({
          state: "paused",
          runToken,
          startedAt,
          pausedReason: "manual",
        });
        expect(table.getItemRequests).toStrictEqual([
          {
            Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
            ConsistentRead: true,
          },
        ]);
      }),
  );

  it.effect("treats a tokenless draft as a valid control snapshot", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        getItem: [Effect.succeed({ Item: meta({ state: "draft" }) })],
      });

      const control = yield* storage.getCampaignControl(campaignId);

      expect(control.state).toBe("draft");
      expect(control).not.toHaveProperty("runToken");
    }),
  );

  it.effect("answers NotFound when the campaign is missing", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        getItem: [Effect.succeed({})],
      });

      expect(yield* Effect.flip(storage.getCampaignControl(campaignId))).toStrictEqual(
        new Errors.CampaignNotFound(),
      );
    }),
  );

  it.effect("treats a queued campaign without a run token as corrupt", () =>
    Effect.gen(function* () {
      const item = meta({ state: "queued", queuedAt });
      const { runToken: _missing, ...tokenless } = item;

      const { storage } = withStorage({ getItem: [Effect.succeed({ Item: tokenless })] });

      expect(yield* defectOf(storage.getCampaignControl(campaignId))).toStrictEqual(
        new CorruptItem({ operation: "getCampaignControl" }),
      );
    }),
  );
});

describe("createCampaign", () => {
  it.effect("writes the BODY item then the META item, each only where nothing is", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.createCampaign({
        id: campaignId,
        listId,
        subject: "Release",
        text: "Body",
        createdAt,
        submission: { state: "draft" },
      });

      expect(table.putItemRequests).toHaveLength(2);
      expect(table.putItemRequests[0]?.ConditionExpression).toBe("attribute_not_exists(pk)");
      expect(table.putItemRequests[0]?.Item).toStrictEqual(body());
      expect(table.putItemRequests[1]?.ConditionExpression).toBe("attribute_not_exists(pk)");
      expect(table.putItemRequests[1]?.Item?.["sk"]).toStrictEqual({ S: "META" });
      expect(table.putItemRequests[1]?.Item).not.toHaveProperty("text");
    }),
  );

  it.effect(
    "writes the listing attributes, without which the campaign is invisible to the index",
    () =>
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        yield* storage.createCampaign({
          id: campaignId,
          listId,
          subject: "Release",
          text: "Body",
          createdAt,
          submission: { state: "draft" },
        });

        const item = table.putItemRequests[1]?.Item ?? {};

        expect(item["gsi1pk"]).toStrictEqual({ S: "campaign" });
        expect(item["gsi1sk"]).toStrictEqual({ S: `${createdAt}#${campaignId}` });
      }),
  );
});

const draft: Schemas.Campaign = {
  id: campaignId,
  listId,
  subject: "Release",
  text: "Body",
  createdAt,
  submission: { state: "draft" },
};

describe("updateDraft", () => {
  const metaKey = { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } };

  it.effect("rewrites the editable META fields and BODY in one draft-only transaction", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.updateDraft({ ...draft, html: "<p>Body</p>", filter: { plan: "pro" } });
      expect(table.transactionRequests).toHaveLength(1);
      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        {
          Update: {
            Table: tableLogicalId,
            Key: metaKey,
            ConditionExpression: "#state = :draft",
            ExpressionAttributeNames: { "#state": "state", "#filter": "filter" },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            UpdateExpression: "SET subject = :subject, listId = :listId, #filter = :filter",
            ExpressionAttributeValues: {
              ":subject": { S: "Release" },
              ":listId": { S: listId },
              ":draft": { S: "draft" },
              ":filter": { M: { plan: { S: "pro" } } },
            },
          },
        },
        { Put: { Table: tableLogicalId, Item: body("<p>Body</p>") } },
      ]);
    }),
  );

  it.effect("removes the filter and writes a BODY without html when the draft has neither", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.updateDraft(draft);

      const [update, put] = table.transactionRequests[0]?.TransactItems ?? [];

      expect(update?.Update?.UpdateExpression).toBe(
        "SET subject = :subject, listId = :listId REMOVE #filter",
      );
      expect(update?.Update?.ExpressionAttributeValues).not.toHaveProperty(":filter");
      expect(put?.Put?.Item).toStrictEqual(body());
    }),
  );
});

describe("deleteDraft", () => {
  it.effect("deletes META, only while a draft, together with BODY", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.deleteDraft(campaignId);
      expect(table.transactionRequests).toHaveLength(1);
      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        {
          Delete: {
            Table: tableLogicalId,
            Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
            ConditionExpression: "#state = :draft",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":draft": { S: "draft" } },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        },
        {
          Delete: {
            Table: tableLogicalId,
            Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "BODY" } },
          },
        },
      ]);
    }),
  );
});

describe("listCampaigns", () => {
  const listingItem = (id: string, at: string, fields: StoredCampaignFields) => ({
    ...meta(fields),
    pk: { S: `CAMPAIGN#${id}` },
    id: { S: id },
    createdAt: { S: at },
    gsi1pk: { S: "campaign" },
    gsi1sk: { S: `${at}#${id}` },
  });

  it.effect(
    "queries its own index partition and yields draft and paused summaries in index order",
    () =>
      Effect.gen(function* () {
        const older = listingItem(otherCampaignId, olderCreatedAt, { state: "draft" });

        const newer = listingItem(campaignId, createdAt, {
          state: "paused",
          queuedAt,
          startedAt,
          pausedReason: "rate-limited",
          ...progress,
        });

        const { table, storage } = withStorage({
          query: [Effect.succeed({ Items: [older, newer] })],
          // A batch read answers in no particular order; the newer campaign comes back first.
          batchGetItem: [Effect.succeed({ Responses: { [physicalName]: [newer, older] } })],
        });

        const page = yield* storage.listCampaigns(25, undefined);

        expect(table.queryRequests[0]?.ExpressionAttributeValues?.[":kind"]).toStrictEqual(
          str("campaign"),
        );
        expect(page.items).toStrictEqual([
          {
            id: otherCampaignId,
            listId,
            subject: "Release",
            createdAt: olderCreatedAt,
            submission: { state: "draft" },
          },
          {
            id: campaignId,
            listId,
            subject: "Release",
            createdAt,
            submission: {
              state: "paused",
              queuedAt,
              startedAt,
              progress,
              feedback: { bounced: 0, complained: 0 },
              reason: "rate-limited",
            },
          },
        ]);
      }),
  );
});

const lifecycleUpdate = (table: Table) => table.transactionRequests[0]?.TransactItems[0]?.Update;

const observed = (state: "draft" | "scheduled" | "paused", token?: string) => ({
  state,
  runToken: token,
});

describe("newRun", () => {
  const nextToken = "0195f0a0-1111-4222-8333-44444444e5d3";

  it.effect("queues a tokenless draft under a new run token and the run baselines", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.newRun(campaignId, observed("draft"), runToken, "queued", now);
      expect(table.transactionRequests).toHaveLength(1);
      expect(table.transactionRequests[0]?.ClientRequestToken).toBe("token-1");
      expect(lifecycleUpdate(table)).toStrictEqual({
        Table: tableLogicalId,
        Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        UpdateExpression:
          "SET #state = :target, queuedAt = :queuedAt, runToken = :run, runAccepted = accepted, runBounced = bounced, runComplained = complained REMOVE pausedReason",
        ConditionExpression: "#state = :expectedState AND attribute_not_exists(runToken)",
        ExpressionAttributeNames: { "#state": "state" },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        ExpressionAttributeValues: {
          ":target": { S: "queued" },
          ":queuedAt": { S: now },
          ":run": { S: runToken },
          ":expectedState": { S: "draft" },
        },
      });
      expect(table.updateItemRequests).toHaveLength(0);
    }),
  );

  it.effect(
    "re-queues a paused campaign under its observed token and clears the pause reason",
    () =>
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        yield* storage.newRun(campaignId, observed("paused", runToken), nextToken, "queued", now);
        expect(lifecycleUpdate(table)).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
          UpdateExpression:
            "SET #state = :target, queuedAt = :queuedAt, runToken = :run, runAccepted = accepted, runBounced = bounced, runComplained = complained REMOVE pausedReason",
          ConditionExpression: "#state = :expectedState AND runToken = :expected",
          ExpressionAttributeNames: { "#state": "state" },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          ExpressionAttributeValues: {
            ":target": { S: "queued" },
            ":queuedAt": { S: now },
            ":run": { S: nextToken },
            ":expectedState": { S: "paused" },
            ":expected": { S: runToken },
          },
        });
      }),
  );

  it.effect("reschedules by matching the observed scheduled token, not an IN-list of states", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.newRun(
        campaignId,
        observed("scheduled", runToken),
        nextToken,
        "scheduled",
        queuedAt,
      );
      expect(lifecycleUpdate(table)?.ConditionExpression).toBe(
        "#state = :expectedState AND runToken = :expected",
      );
      expect(lifecycleUpdate(table)?.ExpressionAttributeValues).toStrictEqual({
        ":target": { S: "scheduled" },
        ":queuedAt": { S: queuedAt },
        ":run": { S: nextToken },
        ":expectedState": { S: "scheduled" },
        ":expected": { S: runToken },
      });
    }),
  );

  it.effect.each([
    ["draft", "queued", "enqueueCampaign"],
    ["draft", "scheduled", "scheduleCampaign"],
    ["paused", "queued", "resumeCampaign"],
  ] as const)(
    "keeps a server error from %s to %s unavailable under %s",
    ([source, target, operationId]) =>
      Effect.gen(function* () {
        const { storage } = withStorage({
          transactWriteItems: [Effect.fail(serverError)],
        });

        const failure = yield* Effect.flip(
          storage.newRun(campaignId, observed(source, runToken), nextToken, target, now),
        );

        expect(failure).toBeInstanceOf(Errors.StorageUnavailable);
        expect(failure).toMatchObject({ operation: operationId });
      }),
  );
});

describe("cancelCampaign", () => {
  it.effect("returns a scheduled generation to draft, retains the token and removes queuedAt", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.cancelCampaign(campaignId, { state: "scheduled", runToken });
      expect(table.transactionRequests).toHaveLength(1);
      expect(table.transactionRequests[0]?.ClientRequestToken).toBe("token-1");
      expect(lifecycleUpdate(table)).toStrictEqual({
        Table: tableLogicalId,
        Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        UpdateExpression: "SET #state = :draft REMOVE queuedAt",
        ConditionExpression: "#state = :scheduled AND runToken = :expected",
        ExpressionAttributeNames: { "#state": "state" },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        ExpressionAttributeValues: {
          ":draft": { S: "draft" },
          ":scheduled": { S: "scheduled" },
          ":expected": { S: runToken },
        },
      });
      expect(table.updateItemRequests).toHaveLength(0);
    }),
  );

  it.effect(
    "returns a never-started queued generation to draft and requires startedAt to be absent",
    () =>
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        yield* storage.cancelCampaign(campaignId, {
          state: "queued",
          runToken,
          started: false,
        });
        expect(lifecycleUpdate(table)).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
          UpdateExpression: "SET #state = :draft REMOVE queuedAt",
          ConditionExpression:
            "#state = :queued AND runToken = :expected AND attribute_not_exists(startedAt)",
          ExpressionAttributeNames: { "#state": "state" },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          ExpressionAttributeValues: {
            ":draft": { S: "draft" },
            ":queued": { S: "queued" },
            ":expected": { S: runToken },
          },
        });
      }),
  );

  it.effect("pauses a queued resume as manual without resetting history fields", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.cancelCampaign(campaignId, {
        state: "queued",
        runToken,
        started: true,
      });
      expect(lifecycleUpdate(table)).toStrictEqual({
        Table: tableLogicalId,
        Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        UpdateExpression: "SET #state = :paused, pausedReason = :manual",
        ConditionExpression:
          "#state = :queued AND runToken = :expected AND attribute_exists(startedAt)",
        ExpressionAttributeNames: { "#state": "state" },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        ExpressionAttributeValues: {
          ":paused": { S: "paused" },
          ":manual": { S: "manual" },
          ":queued": { S: "queued" },
          ":expected": { S: runToken },
        },
      });
    }),
  );
});

describe("beginRun", () => {
  const runningItem = meta({
    state: "sending",
    queuedAt,
    startedAt,
    runToken,
    cursor: contactId,
  });

  it.effect("returns the decoded meta and sets sending under the run token", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({
        updateItem: [Effect.succeed({ Attributes: runningItem })],
      });

      expect(yield* storage.beginRun(campaignId, runToken, now)).toStrictEqual({
        listId,
        subject: "Release",
        cursor: contactId,
        filter: undefined,
        run: { accepted: 0, bounced: 0, complained: 0 },
      });
      expect(table.updateItemRequests[0]).toStrictEqual({
        Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        UpdateExpression: "SET #state = :sending, startedAt = if_not_exists(startedAt, :now)",
        ConditionExpression: "runToken = :run AND #state IN (:queued, :sending, :scheduled)",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":sending": { S: "sending" },
          ":now": { S: now },
          ":run": { S: runToken },
          ":queued": { S: "queued" },
          ":scheduled": { S: "scheduled" },
        },
        ReturnValues: "ALL_NEW",
      });
    }),
  );

  it.effect("projects the filter and run deltas from the counters minus the run baselines", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        updateItem: [
          Effect.succeed({
            Attributes: meta({
              state: "sending",
              queuedAt,
              startedAt,
              runToken,
              accepted: 10,
              bounced: 4,
              complained: 2,
              runAccepted: 3,
              runBounced: 1,
              runComplained: 0,
              filter: { plan: "pro" },
            }),
          }),
        ],
      });

      expect(yield* storage.beginRun(campaignId, runToken, now)).toStrictEqual({
        listId,
        subject: "Release",
        cursor: undefined,
        filter: { plan: "pro" },
        run: { accepted: 7, bounced: 3, complained: 2 },
      });
    }),
  );
});

describe("claimRecipient", () => {
  it.effect("checks the run then puts an unconfirmed send row", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      expect(
        yield* storage.claimRecipient(campaignId, runToken, contactId, recipient, sendId, now),
      ).toBe("claimed");
      expect(table.transactionRequests).toHaveLength(1);

      const items = table.transactionRequests[0]?.TransactItems ?? [];

      expect(items).toHaveLength(2);
      expect(items[0]?.ConditionCheck).toStrictEqual({
        Table: tableLogicalId,
        Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        ConditionExpression: "#state = :sending AND runToken = :run",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":sending": { S: "sending" },
          ":run": { S: runToken },
        },
      });
      expect(items[1]?.Put?.ConditionExpression).toBe("attribute_not_exists(pk)");
      expect(items[1]?.Put?.Item).toStrictEqual({
        pk: { S: `CAMPAIGN#${campaignId}` },
        sk: { S: `SEND#${contactId}` },
        v: { N: "1" },
        sendId: { S: sendId },
        contactId: { S: contactId },
        recipient: { S: recipient },
        state: { S: "unconfirmed" },
        startedAt: { S: now },
      });
    }),
  );
});

describe("skipRecipient", () => {
  it.effect("puts a skipped row then increments the skipped counter", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      expect(
        yield* storage.skipRecipient(
          campaignId,
          runToken,
          contactId,
          recipient,
          "unsubscribed",
          now,
        ),
      ).toBe("skipped");
      expect(table.transactionRequests).toHaveLength(1);

      const items = table.transactionRequests[0]?.TransactItems ?? [];

      expect(items).toHaveLength(2);
      expect(items[0]?.Put?.ConditionExpression).toBe("attribute_not_exists(pk)");
      expect(items[0]?.Put?.Item).toStrictEqual({
        pk: { S: `CAMPAIGN#${campaignId}` },
        sk: { S: `SEND#${contactId}` },
        v: { N: "1" },
        contactId: { S: contactId },
        recipient: { S: recipient },
        state: { S: "skipped" },
        skipReason: { S: "unsubscribed" },
        startedAt: { S: now },
        finishedAt: { S: now },
      });
      expect(items[1]?.Update).toStrictEqual({
        Table: tableLogicalId,
        Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        UpdateExpression: "ADD skipped :one",
        ConditionExpression: "#state = :sending AND runToken = :run",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":one": { N: "1" },
          ":sending": { S: "sending" },
          ":run": { S: runToken },
        },
      });
    }),
  );
});

describe("settleRecipient", () => {
  it.effect("writes acceptance on the send row and adds the accepted counter", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.settleRecipient(
        campaignId,
        sendId,
        contactId,
        {
          outcome: "accepted",
          messageId: "0100019",
        },
        now,
      );

      expect(table.transactionRequests).toHaveLength(1);

      const items = table.transactionRequests[0]?.TransactItems ?? [];

      expect(items).toHaveLength(2);
      expect(items[0]?.Update?.Key).toStrictEqual({
        pk: { S: `CAMPAIGN#${campaignId}` },
        sk: { S: `SEND#${contactId}` },
      });
      expect(items[0]?.Update?.ConditionExpression).toBe(
        "#state = :unconfirmed AND sendId = :sendId",
      );
      expect(items[0]?.Update?.UpdateExpression).toBe(
        "SET #state = :state, finishedAt = :finishedAt, messageId = :messageId",
      );
      expect(items[0]?.Update?.ExpressionAttributeValues?.[":messageId"]).toStrictEqual({
        S: "0100019",
      });
      expect(items[1]?.Update).toStrictEqual({
        Table: tableLogicalId,
        Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        UpdateExpression: "ADD accepted :one",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":one": { N: "1" } },
      });
    }),
  );

  it.effect("writes a rejection code and adds the rejected counter", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.settleRecipient(
        campaignId,
        sendId,
        contactId,
        {
          outcome: "rejected",
          rejectionCode: "message-rejected",
        },
        now,
      );

      const items = table.transactionRequests[0]?.TransactItems ?? [];

      expect(items[0]?.Update?.UpdateExpression).toBe(
        "SET #state = :state, finishedAt = :finishedAt, rejectionCode = :rejectionCode",
      );
      expect(items[0]?.Update?.ExpressionAttributeValues?.[":rejectionCode"]).toStrictEqual({
        S: "message-rejected",
      });
      expect(items[0]?.Update?.ExpressionAttributeValues).not.toHaveProperty(":messageId");
      expect(items[1]?.Update?.UpdateExpression).toBe("ADD rejected :one");
    }),
  );

  it.effect("writes an uncertain settlement without a message id or rejection code", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.settleRecipient(campaignId, sendId, contactId, { outcome: "uncertain" }, now);

      const update = table.transactionRequests[0]?.TransactItems[0]?.Update;

      expect(update?.UpdateExpression).toBe("SET #state = :state, finishedAt = :finishedAt");
      expect(update?.ExpressionAttributeValues).not.toHaveProperty(":messageId");
      expect(update?.ExpressionAttributeValues).not.toHaveProperty(":rejectionCode");
      expect(table.transactionRequests[0]?.TransactItems[1]?.Update?.UpdateExpression).toBe(
        "ADD uncertain :one",
      );
    }),
  );
});

describe("checkpoint", () => {
  it.effect("advances from an absent cursor on the first page", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.checkpoint(campaignId, runToken, sliceId, undefined, contactId);
      expect(table.updateItemRequests[0]).toStrictEqual({
        Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        UpdateExpression: "SET #cursor = :next, sliceId = :slice",
        ConditionExpression:
          "#state = :sending AND runToken = :run AND (attribute_not_exists(#cursor) OR (#cursor = :next AND sliceId = :slice))",
        ExpressionAttributeNames: { "#state": "state", "#cursor": "cursor" },
        ExpressionAttributeValues: {
          ":sending": { S: "sending" },
          ":run": { S: runToken },
          ":next": { S: contactId },
          ":slice": { S: sliceId },
        },
      });
    }),
  );

  it.effect("advances from the previous cursor on a later page", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.checkpoint(campaignId, runToken, sliceId, contactId, nextContactId);
      expect(table.updateItemRequests[0]?.ConditionExpression).toBe(
        "#state = :sending AND runToken = :run AND (#cursor = :previous OR (#cursor = :next AND sliceId = :slice))",
      );
      expect(table.updateItemRequests[0]?.ExpressionAttributeValues).toStrictEqual({
        ":sending": { S: "sending" },
        ":run": { S: runToken },
        ":next": { S: nextContactId },
        ":slice": { S: sliceId },
        ":previous": { S: contactId },
      });
    }),
  );
});

describe("completeRun", () => {
  it.effect("marks the campaign completed and removes the cursor", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.completeRun(campaignId, runToken, now);
      expect(table.updateItemRequests[0]).toStrictEqual({
        Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        UpdateExpression: "SET #state = :completed, finishedAt = :now REMOVE #cursor, sliceId",
        ConditionExpression: "#state = :sending AND runToken = :run",
        ExpressionAttributeNames: { "#state": "state", "#cursor": "cursor" },
        ExpressionAttributeValues: {
          ":completed": { S: "completed" },
          ":now": { S: now },
          ":sending": { S: "sending" },
          ":run": { S: runToken },
        },
      });
    }),
  );
});

describe("pauseRun", () => {
  it.effect("pauses the campaign at the resume cursor", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.pauseRun(campaignId, runToken, "daily-quota", contactId);
      expect(table.updateItemRequests[0]).toStrictEqual({
        Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
        UpdateExpression: "SET #state = :paused, pausedReason = :reason, #cursor = :cursor",
        ConditionExpression: "#state = :sending AND runToken = :run",
        ExpressionAttributeNames: { "#state": "state", "#cursor": "cursor" },
        ExpressionAttributeValues: {
          ":paused": { S: "paused" },
          ":reason": { S: "daily-quota" },
          ":cursor": { S: contactId },
          ":sending": { S: "sending" },
          ":run": { S: runToken },
        },
      });
    }),
  );

  it.effect("removes the cursor when pausing at the start of the list", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.pauseRun(campaignId, runToken, "sending-paused", undefined);
      expect(table.updateItemRequests[0]?.UpdateExpression).toBe(
        "SET #state = :paused, pausedReason = :reason REMOVE #cursor",
      );
      expect(table.updateItemRequests[0]?.ExpressionAttributeValues).not.toHaveProperty(":cursor");
    }),
  );
});

type Refusal =
  | Errors.CampaignNotFound
  | Errors.CampaignStateConflict
  | CampaignChanged
  | RunSuperseded
  | SettlementNotApplied;

describe("condition failures", () => {
  const sending = meta({ state: "sending", queuedAt, startedAt });

  it.effect.each<
    readonly [
      string,
      ScriptedReplies,
      (storage: CampaignStorage) => Effect.Effect<unknown, Refusal | Errors.StorageUnavailable>,
      Result.Result<unknown, Refusal>,
    ]
  >([
    [
      "updateDraft answers CampaignNotFound when the campaign is gone",
      { transactWriteItems: [cancelled("ConditionalCheckFailed", "None")] },
      (storage) => storage.updateDraft(draft),
      Result.fail(new Errors.CampaignNotFound()),
    ],
    [
      "updateDraft answers the state a campaign that left draft is in",
      {
        transactWriteItems: [cancelled({ Code: "ConditionalCheckFailed", Item: sending }, "None")],
      },
      (storage) => storage.updateDraft(draft),
      Result.fail(new Errors.CampaignStateConflict({ state: "sending" })),
    ],
    [
      "deleteDraft answers CampaignNotFound when the campaign is gone",
      { transactWriteItems: [cancelled("ConditionalCheckFailed", "None")] },
      (storage) => storage.deleteDraft(campaignId),
      Result.fail(new Errors.CampaignNotFound()),
    ],
    [
      "deleteDraft answers the state a campaign that left draft is in",
      {
        transactWriteItems: [cancelled({ Code: "ConditionalCheckFailed", Item: sending }, "None")],
      },
      (storage) => storage.deleteDraft(campaignId),
      Result.fail(new Errors.CampaignStateConflict({ state: "sending" })),
    ],
    [
      "newRun answers CampaignChanged without a campaign when it is gone",
      { transactWriteItems: [cancelled("ConditionalCheckFailed")] },
      (storage) => storage.newRun(campaignId, observed("draft"), runToken, "queued", now),
      Result.fail(new CampaignChanged({ current: undefined })),
    ],
    [
      "beginRun answers RunSuperseded for a run token that is no longer current",
      { updateItem: [conditionFailed] },
      (storage) => storage.beginRun(campaignId, runToken, now),
      Result.fail(new RunSuperseded()),
    ],
    [
      "claimRecipient answers RunSuperseded when the meta condition fails",
      { transactWriteItems: [cancelled("ConditionalCheckFailed", "None")] },
      (storage) => storage.claimRecipient(campaignId, runToken, contactId, recipient, sendId, now),
      Result.fail(new RunSuperseded()),
    ],
    [
      "claimRecipient reports an existing row as already claimed",
      { transactWriteItems: [cancelled("None", "ConditionalCheckFailed")] },
      (storage) => storage.claimRecipient(campaignId, runToken, contactId, recipient, sendId, now),
      Result.succeed("already-claimed"),
    ],
    [
      "claimRecipient answers RunSuperseded when both conditions fail",
      { transactWriteItems: [cancelled("ConditionalCheckFailed", "ConditionalCheckFailed")] },
      (storage) => storage.claimRecipient(campaignId, runToken, contactId, recipient, sendId, now),
      Result.fail(new RunSuperseded()),
    ],
    [
      "skipRecipient reports an existing row as already claimed",
      { transactWriteItems: [cancelled("ConditionalCheckFailed", "None")] },
      (storage) =>
        storage.skipRecipient(campaignId, runToken, contactId, recipient, "suppressed", now),
      Result.succeed("already-claimed"),
    ],
    [
      "skipRecipient answers RunSuperseded when the meta condition fails",
      { transactWriteItems: [cancelled("None", "ConditionalCheckFailed")] },
      (storage) =>
        storage.skipRecipient(campaignId, runToken, contactId, recipient, "suppressed", now),
      Result.fail(new RunSuperseded()),
    ],
    [
      "settleRecipient answers SettlementNotApplied when the row is not this attempt's",
      { transactWriteItems: [cancelled("ConditionalCheckFailed", "None")] },
      (storage) =>
        storage.settleRecipient(
          campaignId,
          sendId,
          contactId,
          { outcome: "accepted", messageId: "0100019" },
          now,
        ),
      Result.fail(new SettlementNotApplied()),
    ],
    [
      "checkpoint answers RunSuperseded when it lost the page",
      { updateItem: [conditionFailed] },
      (storage) => storage.checkpoint(campaignId, runToken, sliceId, undefined, contactId),
      Result.fail(new RunSuperseded()),
    ],
    [
      "completeRun answers RunSuperseded for a stale run",
      { updateItem: [conditionFailed] },
      (storage) => storage.completeRun(campaignId, runToken, now),
      Result.fail(new RunSuperseded()),
    ],
    [
      "pauseRun answers RunSuperseded for a stale run",
      { updateItem: [conditionFailed] },
      (storage) => storage.pauseRun(campaignId, runToken, "rate-limited", contactId),
      Result.fail(new RunSuperseded()),
    ],
  ])("%s", ([_name, replies, run, expected]) =>
    Effect.gen(function* () {
      const { storage } = withStorage(replies);

      expect(yield* Effect.result(run(storage))).toStrictEqual(expected);
    }),
  );

  it.effect.each([
    [
      "newRun",
      (storage: CampaignStorage) =>
        storage.newRun(campaignId, observed("draft"), runToken, "queued", now),
    ],
    [
      "cancelCampaign",
      (storage: CampaignStorage) =>
        storage.cancelCampaign(campaignId, { state: "scheduled", runToken }),
    ],
  ] as const)("%s answers the campaign as its refused condition found it", ([_name, run]) =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({
        transactWriteItems: [cancelled({ Code: "ConditionalCheckFailed", Item: sending })],
      });

      const failure = yield* Effect.flip(run(storage));

      expect(failure).toBeInstanceOf(CampaignChanged);
      expect(failure).toMatchObject({ current: { state: "sending", runToken, startedAt } });
      expect(
        table.transactionRequests[0]?.TransactItems[0]?.Update?.ReturnValuesOnConditionCheckFailure,
      ).toBe("ALL_OLD");
    }),
  );
});
