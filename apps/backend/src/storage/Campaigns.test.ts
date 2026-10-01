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

const body = (html?: string, stored: dynamodb.AttributeMap = {}) => ({
  ...withOptional(
    {
      pk: { S: `CAMPAIGN#${campaignId}` },
      sk: { S: "BODY" },
      v: { N: "1" },
      text: { S: "Body" },
    },
    [["html", html]],
  ),
  ...stored,
});

const routesKey = { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "ROUTES" } };

/** The read of a campaign no variant was ever set on. */
const noRoutes = Effect.succeed({});

/** The variants' rules as a variant write stores them, at a revision. */
const routesAt = (revision: number, routes: ReadonlyArray<Schemas.VariantRoute>) => ({
  ...routesKey,
  v: { N: "1" },
  routes: { S: JSON.stringify(routes) },
  revision: { N: String(revision) },
});

const routesRead = (revision: number, routes: ReadonlyArray<Schemas.VariantRoute>) =>
  Effect.succeed({ Item: routesAt(revision, routes) });

const variantKey = (key: string) => ({
  pk: { S: `CAMPAIGN#${campaignId}` },
  sk: { S: `BODY#${key}` },
});

const metaKey = { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } };

const variantBody = (key: string, subject: string, text: string) => ({
  ...variantKey(key),
  v: { N: "1" },
  subject: { S: subject },
  text: { S: text },
});

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

      expect(writtenBody).not.toHaveProperty("revision");
      expect(writtenBody["text"]).toStrictEqual({ S: multiByteText });
      expect(writtenBody["html"]).toStrictEqual({ S: multiByteHtml });
      expect(table.putItemRequests[1]?.Item).not.toHaveProperty("html");

      const readBack = withStorage({
        getItem: [
          noRoutes,
          Effect.succeed({ Item: writtenBody }),
          Effect.succeed({ Item: table.putItemRequests[1]?.Item ?? {} }),
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
        // Every `getCampaign` reads BODY then META, so the replies interleave.
        getItem: [
          noRoutes,
          Effect.succeed({ Item: body() }),
          Effect.succeed({ Item: meta({ state: "draft" }) }),
          noRoutes,
          Effect.succeed({ Item: body() }),
          Effect.succeed({ Item: meta({ state: "scheduled", queuedAt }) }),
          noRoutes,
          Effect.succeed({ Item: body() }),
          Effect.succeed({ Item: meta({ state: "queued", queuedAt }) }),
          noRoutes,
          Effect.succeed({ Item: body() }),
          Effect.succeed({
            Item: meta({
              state: "sending",
              queuedAt,
              startedAt,
              ...progress,
            }),
          }),
          noRoutes,
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
          noRoutes,
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
          noRoutes,
          Effect.succeed({ Item: body() }),
          Effect.succeed({
            Item: meta({ state: "sending", startedAt }),
          }),
        ],
      });

      const defect = yield* defectOf(storage.getCampaign(campaignId));

      expect(defect).toStrictEqual(new CorruptItem({ operation: "getSummary" }));
    }),
  );

  it.effect("reads ROUTES, BODY, then META and merges them into one campaign", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({
        getItem: [
          noRoutes,
          Effect.succeed({ Item: body() }),
          Effect.succeed({ Item: meta({ state: "draft" }) }),
        ],
      });

      const campaign = yield* storage.getCampaign(campaignId);

      expect(table.getItemRequests.map((request) => request.Key)).toStrictEqual([
        routesKey,
        { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "BODY" } },
        { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
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
          noRoutes,
          Effect.succeed({ Item: body() }),
          Effect.succeed({ Item: meta({ state: "draft", filter: { plan: "pro" } }) }),
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
        getItem: [noRoutes, Effect.succeed({}), Effect.succeed({ Item: meta({ state: "draft" }) })],
      });

      const defect = yield* defectOf(storage.getCampaign(campaignId));

      expect(defect).toStrictEqual(new CorruptItem({ operation: "getCampaign" }));
    }),
  );
});

describe("getCampaign with variants", () => {
  it.effect("carries the variants' rules in order, and none of their content", () =>
    Effect.gen(function* () {
      const routes = [
        { key: "berlin", when: { city: "Berlin" } },
        { key: "half", percent: 50 },
      ];

      const { table, storage } = withStorage({
        getItem: [
          routesRead(3, routes),
          Effect.succeed({ Item: body() }),
          Effect.succeed({ Item: meta({ state: "draft" }) }),
        ],
      });

      expect((yield* storage.getCampaign(campaignId)).variants).toStrictEqual(routes);
      expect(table.getItemRequests).toHaveLength(3);
    }),
  );

  it.effect("leaves variants out once the last one was removed", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        getItem: [
          routesRead(4, []),
          Effect.succeed({ Item: body() }),
          Effect.succeed({ Item: meta({ state: "draft" }) }),
        ],
      });

      expect(yield* storage.getCampaign(campaignId)).not.toHaveProperty("variants");
    }),
  );

  it.effect("answers an unavailable store as StorageUnavailable, not a defect", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({ getItem: [Effect.fail(serverError)] });

      expect(yield* Effect.flip(storage.getCampaign(campaignId))).toBeInstanceOf(
        Errors.StorageUnavailable,
      );
    }),
  );
});

describe("getVariant", () => {
  const half = { key: "half", percent: 50 };

  it.effect("reads the rules, then the one variant's body, and answers it with its rule", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({
        getItem: [
          routesRead(3, [{ key: "berlin", when: { city: "Berlin" } }, half]),
          Effect.succeed({ Item: variantBody("half", "Half", "Split copy") }),
        ],
      });

      expect(yield* storage.getVariant(campaignId, "half")).toStrictEqual({
        ...half,
        subject: "Half",
        text: "Split copy",
      });
      expect(table.getItemRequests.map((request) => request.Key)).toStrictEqual([
        routesKey,
        variantKey("half"),
      ]);
    }),
  );

  it.effect.each([
    [
      "VariantNotFound for a key the rules don't name",
      Effect.succeed({ Item: meta({ state: "draft" }) }),
      new Errors.VariantNotFound({ variant: "half" }),
    ],
    [
      "CampaignNotFound when there is no campaign",
      Effect.succeed({}),
      new Errors.CampaignNotFound(),
    ],
  ] as const)("answers %s, reading META only then", ([, metaRead, expected]) =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({ getItem: [noRoutes, metaRead] });

      expect(yield* Effect.flip(storage.getVariant(campaignId, "half"))).toStrictEqual(expected);
      expect(table.getItemRequests.map((request) => request.Key)).toStrictEqual([
        routesKey,
        metaKey,
      ]);
    }),
  );

  it.effect("reads again when a removal landed between the rules and the body", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        getItem: [
          routesRead(1, [half]),
          Effect.succeed({}),
          routesRead(2, []),
          routesRead(2, []),
          Effect.succeed({ Item: meta({ state: "draft" }) }),
        ],
      });

      expect(yield* Effect.flip(storage.getVariant(campaignId, "half"))).toStrictEqual(
        new Errors.VariantNotFound({ variant: "half" }),
      );
    }),
  );

  it.effect("treats a body missing under unchanged rules as corrupt", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        getItem: [routesRead(1, [half]), Effect.succeed({}), routesRead(1, [half])],
      });

      expect(yield* defectOf(storage.getVariant(campaignId, "half"))).toStrictEqual(
        new CorruptItem({ operation: "getVariant" }),
      );
    }),
  );
});

describe("getBody", () => {
  it.effect("answers CampaignNotFound when a delete landed after META was read", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({ getItem: [Effect.succeed({}), Effect.succeed({})] });

      expect(yield* Effect.flip(storage.getBody(campaignId))).toStrictEqual(
        new Errors.CampaignNotFound(),
      );
    }),
  );

  it.effect("treats a body missing under a META that is still there as corrupt", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({
        getItem: [Effect.succeed({}), Effect.succeed({ Item: meta({ state: "draft" }) })],
      });

      expect(yield* defectOf(storage.getBody(campaignId))).toStrictEqual(
        new CorruptItem({ operation: "getBody" }),
      );
    }),
  );
});

describe("getVariantContent", () => {
  it.effect("treats a body missing during a run as corrupt, since no edit can remove it", () =>
    Effect.gen(function* () {
      const { storage } = withStorage({ getItem: [Effect.succeed({})] });

      expect(yield* defectOf(storage.getVariantContent(campaignId, "half"))).toStrictEqual(
        new CorruptItem({ operation: "getVariantContent" }),
      );
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

const draftCheck = {
  ConditionCheck: {
    Table: tableLogicalId,
    Key: metaKey,
    ConditionExpression: "#state = :draft",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: { ":draft": { S: "draft" } },
    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
  },
};

const bodyKey = { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "BODY" } };

const halfContent = { subject: "Half", text: "Split copy" };

describe("updateDraft", () => {
  it.effect(
    "updates exactly the fields given, in one draft-only transaction, without reading first",
    () =>
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        yield* storage.updateDraft(campaignId, {
          subject: "New",
          html: "<p>Body</p>",
          filter: { plan: "pro" },
        });

        expect(table.getItemRequests).toHaveLength(0);
        expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
          {
            Update: {
              ...draftCheck.ConditionCheck,
              UpdateExpression: "SET #subject = :subject, #filter = :filter",
              ExpressionAttributeNames: {
                "#state": "state",
                "#subject": "subject",
                "#filter": "filter",
              },
              ExpressionAttributeValues: {
                ":draft": { S: "draft" },
                ":subject": { S: "New" },
                ":filter": { M: { plan: { S: "pro" } } },
              },
            },
          },
          {
            Update: {
              Table: tableLogicalId,
              Key: bodyKey,
              UpdateExpression: "SET #html = :html",
              ExpressionAttributeNames: { "#html": "html" },
              ExpressionAttributeValues: { ":html": { S: "<p>Body</p>" } },
            },
          },
        ]);
      }),
  );

  it.effect("removes the fields given as null", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.updateDraft(campaignId, { text: "New", html: null, filter: null });

      const [update, bodyUpdate] = table.transactionRequests[0]?.TransactItems ?? [];

      expect(update?.Update?.UpdateExpression).toBe("REMOVE #filter");
      expect(update?.Update?.ExpressionAttributeValues).toStrictEqual({ ":draft": { S: "draft" } });
      expect(bodyUpdate?.Update).toMatchObject({
        UpdateExpression: "SET #text = :text REMOVE #html",
        ExpressionAttributeNames: { "#text": "text", "#html": "html" },
        ExpressionAttributeValues: { ":text": { S: "New" } },
      });
    }),
  );

  it.effect("only checks the draft when the change gives no field of META, and no body item", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({});

      yield* storage.updateDraft(campaignId, {});

      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([draftCheck]);
    }),
  );
});

describe("setVariant", () => {
  const half = { key: "half", percent: 50 };

  const berlin = { key: "berlin", when: { city: "Berlin" } };

  it.effect(
    "appends a variant: its rules at the first revision, only if none were ever set, and its body",
    () =>
      Effect.gen(function* () {
        const { table, storage } = withStorage({ getItem: [noRoutes] });

        yield* storage.setVariant(campaignId, "half", { percent: 50, ...halfContent });

        expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
          draftCheck,
          {
            Put: {
              Table: tableLogicalId,
              Item: routesAt(1, [half]),
              ConditionExpression: "attribute_not_exists(revision)",
            },
          },
          { Put: { Table: tableLogicalId, Item: variantBody("half", "Half", "Split copy") } },
        ]);
      }),
  );

  it.effect("replaces the variant with its key where it stands, at the next revision", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({ getItem: [routesRead(4, [berlin, half])] });

      yield* storage.setVariant(campaignId, "berlin", { percent: 10, ...halfContent });

      expect(table.transactionRequests[0]?.TransactItems[1]).toStrictEqual({
        Put: {
          Table: tableLogicalId,
          Item: routesAt(5, [{ key: "berlin", percent: 10 }, half]),
          ConditionExpression: "revision = :revision",
          ExpressionAttributeValues: { ":revision": { N: "4" } },
        },
      });
    }),
  );

  const full = Array.from({ length: Schemas.maxVariants }, (_, index) => ({
    key: `v${index}`,
    when: { n: `${index}` },
  }));

  it.effect("takes as many variants as a campaign may hold, and refuses one more", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({
        getItem: [routesRead(1, full.slice(1)), routesRead(2, full)],
      });

      yield* storage.setVariant(campaignId, "v0", { when: { n: "0" }, ...halfContent });

      expect(
        yield* Effect.flip(storage.setVariant(campaignId, "extra", { percent: 1, ...halfContent })),
      ).toStrictEqual(new Errors.TooManyVariants({ limit: Schemas.maxVariants }));
      expect(table.transactionRequests).toHaveLength(1);
    }),
  );

  it.effect("replaces a variant of a full campaign", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({ getItem: [routesRead(2, full)] });

      yield* storage.setVariant(campaignId, "v7", { percent: 5, ...halfContent });

      expect(table.transactionRequests).toHaveLength(1);
    }),
  );

  it.effect("refuses percents that would add up to more than 100, writing nothing", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({ getItem: [routesRead(1, [half])] });

      expect(
        yield* Effect.flip(storage.setVariant(campaignId, "c", { percent: 51, ...halfContent })),
      ).toStrictEqual(new Errors.SplitOverfull({ percent: 101 }));
      expect(table.transactionRequests).toHaveLength(0);
    }),
  );

  it.effect(
    "retries from fresh rules when another edit changed them first, keeping its change",
    () =>
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          getItem: [noRoutes, routesRead(1, [berlin])],
          transactWriteItems: [cancelled("None", "ConditionalCheckFailed", "None")],
        });

        yield* storage.setVariant(campaignId, "half", { percent: 50, ...halfContent });

        expect(table.transactionRequests).toHaveLength(2);
        expect(table.transactionRequests[1]?.TransactItems[1]?.Put?.Item).toStrictEqual(
          routesAt(2, [berlin, half]),
        );
      }),
  );

  it.effect("answers DraftChanged when the rules keep changing on every retry", () =>
    Effect.gen(function* () {
      const race = cancelled("None", "ConditionalCheckFailed", "None");

      const { storage } = withStorage({
        getItem: [routesRead(1, []), routesRead(2, []), routesRead(3, [])],
        transactWriteItems: [race, race, race],
      });

      expect(
        yield* Effect.flip(storage.setVariant(campaignId, "half", { percent: 50, ...halfContent })),
      ).toStrictEqual(new Errors.DraftChanged());
    }),
  );
});

describe("removeVariant", () => {
  it.effect(
    "keeps the rules item when the last variant goes, so its revision never starts over",
    () =>
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          getItem: [routesRead(3, [{ key: "half", percent: 50 }])],
        });

        yield* storage.removeVariant(campaignId, "half");

        expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
          draftCheck,
          {
            Put: {
              Table: tableLogicalId,
              Item: routesAt(4, []),
              ConditionExpression: "revision = :revision",
              ExpressionAttributeValues: { ":revision": { N: "3" } },
            },
          },
          { Delete: { Table: tableLogicalId, Key: variantKey("half") } },
        ]);
      }),
  );

  it.effect("writes nothing for a key the rules don't name", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({
        getItem: [routesRead(3, [{ key: "half", percent: 50 }])],
      });

      yield* storage.removeVariant(campaignId, "other");

      expect(table.transactionRequests).toHaveLength(0);
    }),
  );
});

describe("deleteDraft", () => {
  const metaDelete = {
    Delete: {
      Table: tableLogicalId,
      Key: metaKey,
      ConditionExpression: "#state = :draft",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":draft": { S: "draft" } },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    },
  };

  it.effect(
    "drops each variant in its own transaction, then META only while a draft, BODY and the rules",
    () =>
      Effect.gen(function* () {
        const half = { key: "half", percent: 50 };
        const berlin = { key: "berlin", when: { city: "Berlin" } };
        const { table, storage } = withStorage({ getItem: [routesRead(2, [half, berlin])] });

        yield* storage.deleteDraft(campaignId);

        expect(table.getItemRequests).toHaveLength(1);
        expect(table.transactionRequests.map((request) => request.TransactItems)).toStrictEqual([
          [
            draftCheck,
            {
              Put: {
                Table: tableLogicalId,
                Item: routesAt(3, [berlin]),
                ConditionExpression: "revision = :revision",
                ExpressionAttributeValues: { ":revision": { N: "2" } },
              },
            },
            { Delete: { Table: tableLogicalId, Key: variantKey("half") } },
          ],
          [
            draftCheck,
            {
              Put: {
                Table: tableLogicalId,
                Item: routesAt(4, []),
                ConditionExpression: "revision = :revision",
                ExpressionAttributeValues: { ":revision": { N: "3" } },
              },
            },
            { Delete: { Table: tableLogicalId, Key: variantKey("berlin") } },
          ],
          [
            metaDelete,
            { Delete: { Table: tableLogicalId, Key: bodyKey } },
            {
              Delete: {
                Table: tableLogicalId,
                Key: routesKey,
                ConditionExpression: "revision = :revision",
                ExpressionAttributeValues: { ":revision": { N: "4" } },
              },
            },
          ],
        ]);
      }),
  );

  it.effect("deletes the rules only if none were ever set, when it read none", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({ getItem: [noRoutes] });

      yield* storage.deleteDraft(campaignId);

      expect(table.transactionRequests[0]?.TransactItems).toStrictEqual([
        metaDelete,
        { Delete: { Table: tableLogicalId, Key: bodyKey } },
        {
          Delete: {
            Table: tableLogicalId,
            Key: routesKey,
            ConditionExpression: "attribute_not_exists(revision)",
          },
        },
      ]);
    }),
  );

  it.effect("starts over from fresh rules when an edit set a variant meanwhile", () =>
    Effect.gen(function* () {
      const { table, storage } = withStorage({
        getItem: [noRoutes, routesRead(1, [{ key: "half", percent: 50 }])],
        transactWriteItems: [cancelled("None", "None", "ConditionalCheckFailed")],
      });

      yield* storage.deleteDraft(campaignId);

      expect(table.transactionRequests).toHaveLength(3);
      expect(table.transactionRequests[1]?.TransactItems[2]).toStrictEqual({
        Delete: { Table: tableLogicalId, Key: variantKey("half") },
      });
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
        yield* storage.claimRecipient(
          campaignId,
          runToken,
          contactId,
          recipient,
          "half",
          sendId,
          now,
        ),
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
        variant: { S: "half" },
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
  | SettlementNotApplied
  | Errors.DraftChanged
  | Errors.TooManyVariants
  | Errors.SplitOverfull;

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
      (storage) => storage.updateDraft(campaignId, { text: "New" }),
      Result.fail(new Errors.CampaignNotFound()),
    ],
    [
      "updateDraft answers the state a campaign that left draft is in",
      {
        transactWriteItems: [cancelled({ Code: "ConditionalCheckFailed", Item: sending }, "None")],
      },
      (storage) => storage.updateDraft(campaignId, { subject: "New" }),
      Result.fail(new Errors.CampaignStateConflict({ state: "sending" })),
    ],
    [
      "setVariant answers the state a campaign that left draft is in",
      {
        transactWriteItems: [
          cancelled({ Code: "ConditionalCheckFailed", Item: sending }, "None", "None"),
        ],
      },
      (storage) => storage.setVariant(campaignId, "half", { percent: 50, ...halfContent }),
      Result.fail(new Errors.CampaignStateConflict({ state: "sending" })),
    ],
    [
      "removeVariant answers CampaignNotFound when the campaign is gone",
      {
        getItem: [routesRead(1, [{ key: "half", percent: 50 }])],
        transactWriteItems: [cancelled("ConditionalCheckFailed", "None", "None")],
      },
      (storage) => storage.removeVariant(campaignId, "half"),
      Result.fail(new Errors.CampaignNotFound()),
    ],
    [
      "deleteDraft answers CampaignNotFound when the campaign is gone",
      { transactWriteItems: [cancelled("ConditionalCheckFailed", "None", "None")] },
      (storage) => storage.deleteDraft(campaignId),
      Result.fail(new Errors.CampaignNotFound()),
    ],
    [
      "deleteDraft answers the state a campaign that left draft is in",
      {
        transactWriteItems: [
          cancelled({ Code: "ConditionalCheckFailed", Item: sending }, "None", "None"),
        ],
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
      (storage) =>
        storage.claimRecipient(campaignId, runToken, contactId, recipient, "half", sendId, now),
      Result.fail(new RunSuperseded()),
    ],
    [
      "claimRecipient reports an existing row as already claimed",
      { transactWriteItems: [cancelled("None", "ConditionalCheckFailed")] },
      (storage) =>
        storage.claimRecipient(campaignId, runToken, contactId, recipient, "half", sendId, now),
      Result.succeed("already-claimed"),
    ],
    [
      "claimRecipient answers RunSuperseded when both conditions fail",
      { transactWriteItems: [cancelled("ConditionalCheckFailed", "ConditionalCheckFailed")] },
      (storage) =>
        storage.claimRecipient(campaignId, runToken, contactId, recipient, "half", sendId, now),
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
