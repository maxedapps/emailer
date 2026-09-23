import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { campaignOperations } from "./Campaigns.ts";
import { str, strMap, tableLogicalId, withOptional } from "./Items.ts";
import {
  campaignId,
  cancelled,
  conditionFailed,
  contactId,
  createdAt,
  failureOf,
  listId,
  primitivesFor,
  scriptedTable,
  serverError,
} from "./Testing.ts";

import type * as Schemas from "@emailer/api/Schemas";
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

const meta = (fields: StoredCampaignFields) => {
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
      ["runToken", fields.runToken],
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

const withStorage = (replies: ScriptedReplies) => {
  const table = scriptedTable(replies);

  return { table, storage: operationsFor(table) };
};

describe("campaign records", () => {
  it("round-trips multi-byte content through the stored encoding", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        yield* storage.createCampaign({
          id: campaignId,
          listId,
          subject: "Grüße 😀",
          text: multiByteText,
          createdAt,
          submission: { state: "draft" },
        });

        const readBack = scriptedTable({
          getItem: [
            Effect.succeed({ Item: table.putItemRequests[1]?.Item ?? {} }),
            Effect.succeed({ Item: table.putItemRequests[0]?.Item ?? {} }),
          ],
        });

        const campaign = yield* operationsFor(readBack).getCampaign(campaignId);

        expect(table.putItemRequests[0]?.Item).not.toHaveProperty("html");
        expect(Option.getOrUndefined(campaign)).toStrictEqual({
          id: campaignId,
          listId,
          subject: "Grüße 😀",
          text: multiByteText,
          createdAt,
          submission: { state: "draft" },
        });
        expect(Option.getOrUndefined(campaign)).not.toHaveProperty("html");
        expectAliasedReservedNames(table);
        expectAliasedReservedNames(readBack);
      }),
    ));

  it("stores html beside text and round-trips multi-byte HTML", () =>
    Effect.runPromise(
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

        const readBack = scriptedTable({
          getItem: [
            Effect.succeed({ Item: table.putItemRequests[1]?.Item ?? {} }),
            Effect.succeed({ Item: writtenBody }),
          ],
        });

        const campaign = yield* operationsFor(readBack).getCampaign(campaignId);

        expect(Option.getOrUndefined(campaign)).toStrictEqual({
          id: campaignId,
          listId,
          subject: "Grüße 😀",
          text: multiByteText,
          html: multiByteHtml,
          createdAt,
          submission: { state: "draft" },
        });
        expectAliasedReservedNames(table);
        expectAliasedReservedNames(readBack);
      }),
    ));

  it("projects html from a stored body that has it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const html = "<p>Hello there</p>";

        const { table, storage } = withStorage({
          getItem: [
            Effect.succeed({ Item: meta({ state: "draft" }) }),
            Effect.succeed({ Item: body(html) }),
          ],
        });

        expect(Option.getOrUndefined(yield* storage.getCampaign(campaignId))).toStrictEqual({
          id: campaignId,
          listId,
          subject: "Release",
          text: "Body",
          html,
          createdAt,
          submission: { state: "draft" },
        });
        expectAliasedReservedNames(table);
      }),
    ));

  it("always stores a new campaign as a draft with zero counters, whatever the caller passed", () =>
    Effect.runPromise(
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
        expectAliasedReservedNames(table);
      }),
    ));

  it("decodes every public state including progress", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
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

        expect(
          Option.getOrUndefined(yield* storage.getCampaign(campaignId))?.submission,
        ).toStrictEqual({
          state: "draft",
        });
        expect(
          Option.getOrUndefined(yield* storage.getCampaign(campaignId))?.submission,
        ).toStrictEqual({
          state: "scheduled",
          sendAt: queuedAt,
        });
        expect(
          Option.getOrUndefined(yield* storage.getCampaign(campaignId))?.submission,
        ).toStrictEqual({
          state: "queued",
          queuedAt,
        });
        expect(
          Option.getOrUndefined(yield* storage.getCampaign(campaignId))?.submission,
        ).toStrictEqual({
          state: "sending",
          queuedAt,
          startedAt,
          progress,
          feedback: { bounced: 0, complained: 0 },
        });
        expect(
          Option.getOrUndefined(yield* storage.getCampaign(campaignId))?.submission,
        ).toStrictEqual({
          state: "paused",
          queuedAt,
          startedAt,
          progress,
          feedback: { bounced: 0, complained: 0 },
          reason: "rate-limited",
        });
        expect(
          Option.getOrUndefined(yield* storage.getCampaign(campaignId))?.submission,
        ).toStrictEqual({
          state: "completed",
          queuedAt,
          startedAt,
          finishedAt,
          progress,
          feedback: { bounced: 0, complained: 0 },
        });
        expectAliasedReservedNames(table);
      }),
    ));

  it("treats a sending campaign without a queuedAt as corrupt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          getItem: [
            Effect.succeed({
              Item: meta({ state: "sending", startedAt }),
            }),
          ],
        });

        const attempt = yield* Effect.result(storage.getCampaign(campaignId));

        expect(failureOf(attempt).reason).toBe("corrupt");
        expectAliasedReservedNames(table);
      }),
    ));

  it("reads META then BODY and merges them into one campaign", () =>
    Effect.runPromise(
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
        expect(Option.getOrUndefined(campaign)).toStrictEqual({
          id: campaignId,
          listId,
          subject: "Release",
          createdAt,
          submission: { state: "draft" },
          text: "Body",
        });
        expectAliasedReservedNames(table);
      }),
    ));

  it("projects a stored filter into the campaign", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          getItem: [
            Effect.succeed({ Item: meta({ state: "draft", filter: { plan: "pro" } }) }),
            Effect.succeed({ Item: body() }),
          ],
        });

        expect(Option.getOrUndefined(yield* storage.getCampaign(campaignId))).toStrictEqual({
          id: campaignId,
          listId,
          subject: "Release",
          createdAt,
          submission: { state: "draft" },
          text: "Body",
          filter: { plan: "pro" },
        });
        expectAliasedReservedNames(table);
      }),
    ));

  it("treats a META without a BODY as corrupt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          getItem: [Effect.succeed({ Item: meta({ state: "draft" }) }), Effect.succeed({})],
        });

        const attempt = yield* Effect.result(storage.getCampaign(campaignId));

        expect(failureOf(attempt).reason).toBe("corrupt");
        expect(failureOf(attempt).operationId).toBe("getCampaignBody");
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("getCampaignBody", () => {
  it("reads the BODY key and projects the text", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          getItem: [Effect.succeed({ Item: body() })],
        });

        expect(yield* storage.getCampaignBody(campaignId)).toStrictEqual({ text: "Body" });
        expect(table.getItemRequests[0]?.Key).toStrictEqual({
          pk: { S: `CAMPAIGN#${campaignId}` },
          sk: { S: "BODY" },
        });
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("getCampaignControl", () => {
  it("returns state, run token, startedAt and pausedReason from one strongly consistent META read", () =>
    Effect.runPromise(
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

        expect(Option.getOrUndefined(yield* storage.getCampaignControl(campaignId))).toStrictEqual({
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
        expectAliasedReservedNames(table);
      }),
    ));

  it("treats a tokenless draft as a valid control snapshot", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          getItem: [Effect.succeed({ Item: meta({ state: "draft" }) })],
        });

        expect(Option.getOrUndefined(yield* storage.getCampaignControl(campaignId))).toStrictEqual({
          state: "draft",
          runToken: undefined,
          startedAt: undefined,
          pausedReason: undefined,
        });
        expectAliasedReservedNames(table);
      }),
    ));

  it("returns none when the campaign is missing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          getItem: [Effect.succeed({})],
        });

        expect(yield* storage.getCampaignControl(campaignId)).toStrictEqual(Option.none());
        expectAliasedReservedNames(table);
      }),
    ));

  it("decodes a queued record without a run token rather than treating it as corrupt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          getItem: [Effect.succeed({ Item: meta({ state: "queued", queuedAt }) })],
        });

        expect(Option.getOrUndefined(yield* storage.getCampaignControl(campaignId))).toStrictEqual({
          state: "queued",
          runToken: undefined,
          startedAt: undefined,
          pausedReason: undefined,
        });
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("createCampaign", () => {
  it("writes the BODY item then the META item, each only where nothing is", () =>
    Effect.runPromise(
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
        expectAliasedReservedNames(table);
      }),
    ));

  it("writes the listing attributes, without which the campaign is invisible to the index", () =>
    Effect.runPromise(
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
    ));

  it("writes filter as a string map on the META put", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        yield* storage.createCampaign({
          id: campaignId,
          listId,
          subject: "Release",
          text: "Body",
          createdAt,
          submission: { state: "draft" },
          filter: { plan: "pro" },
        });

        expect(table.putItemRequests[1]?.Item?.["filter"]).toStrictEqual({
          M: { plan: { S: "pro" } },
        });
        expectAliasedReservedNames(table);
      }),
    ));
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

  it("queries its own index partition and yields draft and paused summaries in index order", () =>
    Effect.runPromise(
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
    ));
});

const lifecycleUpdate = (table: Table) => table.transactionRequests[0]?.TransactItems[0]?.Update;

const expectedIdle = (state: "draft" | "scheduled", token?: string) => ({
  state,
  runToken: token,
});

describe("enqueueCampaign", () => {
  it("queues a tokenless draft under a new run token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.enqueueCampaign(campaignId, expectedIdle("draft"), runToken, now),
        ).toBe("queued");
        expect(table.transactionRequests[0]?.ClientRequestToken).toBe("token-1");
        expect(lifecycleUpdate(table)).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
          UpdateExpression:
            "SET #state = :queued, queuedAt = :now, runToken = :run, runAccepted = accepted, runBounced = bounced, runComplained = complained",
          ConditionExpression: "#state = :expectedState AND attribute_not_exists(runToken)",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":queued": { S: "queued" },
            ":now": { S: now },
            ":run": { S: runToken },
            ":expectedState": { S: "draft" },
          },
        });
        expect(table.updateItemRequests).toHaveLength(0);
        expectAliasedReservedNames(table);
      }),
    ));

  it("queues a draft that still holds a retired run token by matching that token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.enqueueCampaign(
            campaignId,
            expectedIdle("draft", runToken),
            "0195f0a0-1111-4222-8333-44444444e5d3",
            now,
          ),
        ).toBe("queued");
        expect(lifecycleUpdate(table)?.ConditionExpression).toBe(
          "#state = :expectedState AND runToken = :expected",
        );
        expect(lifecycleUpdate(table)?.ExpressionAttributeValues).toMatchObject({
          ":expectedState": { S: "draft" },
          ":expected": { S: runToken },
          ":run": { S: "0195f0a0-1111-4222-8333-44444444e5d3" },
        });
        expect(lifecycleUpdate(table)?.ConditionExpression).not.toContain("attribute_not_exists");
        expect(lifecycleUpdate(table)?.ConditionExpression).not.toContain(" IN ");
        expectAliasedReservedNames(table);
      }),
    ));

  it("queues a scheduled campaign only under its observed token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.enqueueCampaign(
            campaignId,
            expectedIdle("scheduled", runToken),
            "0195f0a0-1111-4222-8333-44444444e5d3",
            now,
          ),
        ).toBe("queued");
        expect(lifecycleUpdate(table)?.ConditionExpression).toBe(
          "#state = :expectedState AND runToken = :expected",
        );
        expect(lifecycleUpdate(table)?.ExpressionAttributeValues).toMatchObject({
          ":expectedState": { S: "scheduled" },
          ":expected": { S: runToken },
        });
        expect(lifecycleUpdate(table)?.ConditionExpression).not.toContain("attribute_not_exists");
        expect(lifecycleUpdate(table)?.ConditionExpression).not.toContain(" IN ");
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports conflict when the expected source no longer holds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [cancelled("ConditionalCheckFailed")],
        });

        expect(
          yield* storage.enqueueCampaign(campaignId, expectedIdle("draft"), runToken, now),
        ).toBe("conflict");
        expectAliasedReservedNames(table);
      }),
    ));

  it("keeps a server error unavailable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [Effect.fail(serverError)],
        });

        const attempt = yield* Effect.result(
          storage.enqueueCampaign(campaignId, expectedIdle("draft"), runToken, now),
        );

        expect(failureOf(attempt).reason).toBe("unavailable");
        expect(failureOf(attempt).operationId).toBe("enqueueCampaign");
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("scheduleCampaign", () => {
  it("schedules a tokenless draft with sendAt, a new token and the run baselines", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.scheduleCampaign(campaignId, expectedIdle("draft"), runToken, queuedAt),
        ).toBe("scheduled");
        expect(table.transactionRequests[0]?.ClientRequestToken).toBe("token-1");
        expect(lifecycleUpdate(table)).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
          UpdateExpression:
            "SET #state = :scheduled, queuedAt = :sendAt, runToken = :run, runAccepted = accepted, runBounced = bounced, runComplained = complained",
          ConditionExpression: "#state = :expectedState AND attribute_not_exists(runToken)",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":scheduled": { S: "scheduled" },
            ":sendAt": { S: queuedAt },
            ":run": { S: runToken },
            ":expectedState": { S: "draft" },
          },
        });
        expect(table.updateItemRequests).toHaveLength(0);
        expectAliasedReservedNames(table);
      }),
    ));

  it("reschedules by matching the observed scheduled token, not an IN-list of states", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.scheduleCampaign(
            campaignId,
            expectedIdle("scheduled", runToken),
            "0195f0a0-1111-4222-8333-44444444e5d3",
            queuedAt,
          ),
        ).toBe("scheduled");
        expect(lifecycleUpdate(table)?.ConditionExpression).toBe(
          "#state = :expectedState AND runToken = :expected",
        );
        expect(lifecycleUpdate(table)?.ExpressionAttributeValues).toMatchObject({
          ":expectedState": { S: "scheduled" },
          ":expected": { S: runToken },
        });
        expect(lifecycleUpdate(table)?.ConditionExpression).not.toContain(" IN ");
        expectAliasedReservedNames(table);
      }),
    ));

  it("matches a draft's retained token rather than token absence", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.scheduleCampaign(
            campaignId,
            expectedIdle("draft", runToken),
            "0195f0a0-1111-4222-8333-44444444e5d3",
            queuedAt,
          ),
        ).toBe("scheduled");
        expect(lifecycleUpdate(table)?.ConditionExpression).toBe(
          "#state = :expectedState AND runToken = :expected",
        );
        expect(lifecycleUpdate(table)?.ConditionExpression).not.toContain("attribute_not_exists");
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports conflict when the expected source no longer holds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [cancelled("ConditionalCheckFailed")],
        });

        expect(
          yield* storage.scheduleCampaign(campaignId, expectedIdle("draft"), runToken, queuedAt),
        ).toBe("conflict");
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("cancelCampaign", () => {
  it("returns a scheduled generation to draft, retains the token and removes queuedAt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(yield* storage.cancelCampaign(campaignId, { state: "scheduled", runToken })).toBe(
          "applied",
        );
        expect(table.transactionRequests[0]?.ClientRequestToken).toBe("token-1");
        expect(lifecycleUpdate(table)).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
          UpdateExpression: "SET #state = :draft REMOVE queuedAt",
          ConditionExpression: "#state = :scheduled AND runToken = :expected",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":draft": { S: "draft" },
            ":scheduled": { S: "scheduled" },
            ":expected": { S: runToken },
          },
        });
        expect(lifecycleUpdate(table)?.UpdateExpression).not.toContain("runToken");
        expect(lifecycleUpdate(table)?.ConditionExpression).not.toContain(" IN ");
        expect(table.updateItemRequests).toHaveLength(0);
        expectAliasedReservedNames(table);
      }),
    ));

  it("returns a never-started queued generation to draft and requires startedAt to be absent", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.cancelCampaign(campaignId, {
            state: "queued",
            runToken,
            started: false,
          }),
        ).toBe("applied");
        expect(lifecycleUpdate(table)).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
          UpdateExpression: "SET #state = :draft REMOVE queuedAt",
          ConditionExpression:
            "#state = :queued AND runToken = :expected AND attribute_not_exists(startedAt)",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":draft": { S: "draft" },
            ":queued": { S: "queued" },
            ":expected": { S: runToken },
          },
        });
        expect(lifecycleUpdate(table)?.UpdateExpression).not.toContain("runToken");
        expectAliasedReservedNames(table);
      }),
    ));

  it("pauses a queued resume as manual without resetting history fields", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.cancelCampaign(campaignId, {
            state: "queued",
            runToken,
            started: true,
          }),
        ).toBe("applied");
        expect(lifecycleUpdate(table)).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
          UpdateExpression: "SET #state = :paused, pausedReason = :manual",
          ConditionExpression:
            "#state = :queued AND runToken = :expected AND attribute_exists(startedAt)",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":paused": { S: "paused" },
            ":manual": { S: "manual" },
            ":queued": { S: "queued" },
            ":expected": { S: runToken },
          },
        });
        expect(lifecycleUpdate(table)?.UpdateExpression).not.toContain("REMOVE");
        expect(lifecycleUpdate(table)?.UpdateExpression).not.toContain("runAccepted");
        expect(lifecycleUpdate(table)?.UpdateExpression).not.toContain("queuedAt");
        expect(lifecycleUpdate(table)?.UpdateExpression).not.toContain("startedAt");
        expect(lifecycleUpdate(table)?.UpdateExpression).not.toContain("cursor");
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports conflict when the expected source no longer holds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [cancelled("ConditionalCheckFailed")],
        });

        expect(yield* storage.cancelCampaign(campaignId, { state: "scheduled", runToken })).toBe(
          "conflict",
        );
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("resumeCampaign", () => {
  it("re-enqueues a paused campaign under a new token and clears the pause reason", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});
        const nextToken = "0195f0a0-1111-4222-8333-44444444e5d3";

        expect(
          yield* storage.resumeCampaign(campaignId, { state: "paused", runToken }, nextToken, now),
        ).toBe("queued");
        expect(table.transactionRequests[0]?.ClientRequestToken).toBe("token-1");
        expect(lifecycleUpdate(table)).toStrictEqual({
          Table: tableLogicalId,
          Key: { pk: { S: `CAMPAIGN#${campaignId}` }, sk: { S: "META" } },
          UpdateExpression:
            "SET #state = :queued, runToken = :run, queuedAt = :now, runAccepted = accepted, runBounced = bounced, runComplained = complained REMOVE pausedReason",
          ConditionExpression: "#state = :paused AND runToken = :expected",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":queued": { S: "queued" },
            ":run": { S: nextToken },
            ":now": { S: now },
            ":paused": { S: "paused" },
            ":expected": { S: runToken },
          },
        });
        expect(lifecycleUpdate(table)?.ConditionExpression).not.toContain(" OR ");
        expect(table.updateItemRequests).toHaveLength(0);
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports conflict when the expected paused token no longer holds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [cancelled("ConditionalCheckFailed")],
        });

        expect(
          yield* storage.resumeCampaign(
            campaignId,
            { state: "paused", runToken },
            "0195f0a0-1111-4222-8333-44444444e5d3",
            now,
          ),
        ).toBe("conflict");
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("beginRun", () => {
  const runningItem = meta({
    state: "sending",
    queuedAt,
    startedAt,
    runToken,
    cursor: contactId,
  });

  it("returns the decoded meta and sets sending under the run token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          updateItem: [Effect.succeed({ Attributes: runningItem })],
        });

        expect(yield* storage.beginRun(campaignId, runToken, now)).toStrictEqual({
          outcome: "running",
          campaign: {
            listId,
            subject: "Release",
            cursor: contactId,
            filter: undefined,
            run: { accepted: 0, bounced: 0, complained: 0 },
          },
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
        expectAliasedReservedNames(table);
      }),
    ));

  it("omits the cursor when the meta has none", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          updateItem: [
            Effect.succeed({
              Attributes: meta({
                state: "sending",
                queuedAt,
                startedAt,
                runToken,
              }),
            }),
          ],
        });

        expect(yield* storage.beginRun(campaignId, runToken, now)).toStrictEqual({
          outcome: "running",
          campaign: {
            listId,
            subject: "Release",
            cursor: undefined,
            filter: undefined,
            run: { accepted: 0, bounced: 0, complained: 0 },
          },
        });
        expectAliasedReservedNames(table);
      }),
    ));

  it("projects run deltas from the counters minus the run baselines", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
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
              }),
            }),
          ],
        });

        expect(yield* storage.beginRun(campaignId, runToken, now)).toStrictEqual({
          outcome: "running",
          campaign: {
            listId,
            subject: "Release",
            cursor: undefined,
            filter: undefined,
            run: { accepted: 7, bounced: 3, complained: 2 },
          },
        });
        expectAliasedReservedNames(table);
      }),
    ));

  it("projects a stored filter from META into the run", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          updateItem: [
            Effect.succeed({
              Attributes: meta({
                state: "sending",
                queuedAt,
                startedAt,
                runToken,
                filter: { plan: "pro" },
              }),
            }),
          ],
        });

        expect(yield* storage.beginRun(campaignId, runToken, now)).toStrictEqual({
          outcome: "running",
          campaign: {
            listId,
            subject: "Release",
            cursor: undefined,
            filter: { plan: "pro" },
            run: { accepted: 0, bounced: 0, complained: 0 },
          },
        });
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports a stale run token as stale, not unavailable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({ updateItem: [conditionFailed] });

        expect(yield* storage.beginRun(campaignId, runToken, now)).toBe("stale");
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("claimRecipient", () => {
  it("checks the run then puts an unconfirmed send row", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.claimRecipient(campaignId, runToken, contactId, recipient, sendId, now),
        ).toBe("claimed");

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
        expect(items[1]?.Put?.Item).not.toHaveProperty("sender");
        expect(items[1]?.Put?.Item).not.toHaveProperty("subject");
        expect(items[1]?.Put?.Item).not.toHaveProperty("text");
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports a stale run when the meta condition fails", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
        });

        expect(
          yield* storage.claimRecipient(campaignId, runToken, contactId, recipient, sendId, now),
        ).toBe("stale");
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports an existing row as already claimed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [cancelled("None", "ConditionalCheckFailed")],
        });

        expect(
          yield* storage.claimRecipient(campaignId, runToken, contactId, recipient, sendId, now),
        ).toBe("already-claimed");
        expectAliasedReservedNames(table);
      }),
    ));

  it("prefers stale when both conditions fail", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [cancelled("ConditionalCheckFailed", "ConditionalCheckFailed")],
        });

        expect(
          yield* storage.claimRecipient(campaignId, runToken, contactId, recipient, sendId, now),
        ).toBe("stale");
        expectAliasedReservedNames(table);
      }),
    ));

  it("keeps an unknown transaction outcome unavailable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [Effect.fail(serverError)],
        });

        const attempt = yield* Effect.result(
          storage.claimRecipient(campaignId, runToken, contactId, recipient, sendId, now),
        );

        expect(failureOf(attempt).reason).toBe("unavailable");
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("skipRecipient", () => {
  it("puts a skipped row then increments the skipped counter", () =>
    Effect.runPromise(
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
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports an existing row as already claimed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
        });

        expect(
          yield* storage.skipRecipient(
            campaignId,
            runToken,
            contactId,
            recipient,
            "suppressed",
            now,
          ),
        ).toBe("already-claimed");
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports a stale run when the meta condition fails", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [cancelled("None", "ConditionalCheckFailed")],
        });

        expect(
          yield* storage.skipRecipient(
            campaignId,
            runToken,
            contactId,
            recipient,
            "suppressed",
            now,
          ),
        ).toBe("stale");
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("settleRecipient", () => {
  it("writes acceptance on the send row and adds the accepted counter", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.settleRecipient(
            campaignId,
            sendId,
            contactId,
            {
              state: "accepted",
              messageId: "0100019",
            },
            now,
          ),
        ).toBe("settled");

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
        expectAliasedReservedNames(table);
      }),
    ));

  it("writes a rejection code and adds the rejected counter", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        yield* storage.settleRecipient(
          campaignId,
          sendId,
          contactId,
          {
            state: "rejected",
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
        expectAliasedReservedNames(table);
      }),
    ));

  it("writes an uncertain settlement without a message id or rejection code", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        yield* storage.settleRecipient(campaignId, sendId, contactId, { state: "uncertain" }, now);

        const update = table.transactionRequests[0]?.TransactItems[0]?.Update;

        expect(update?.UpdateExpression).toBe("SET #state = :state, finishedAt = :finishedAt");
        expect(update?.ExpressionAttributeValues).not.toHaveProperty(":messageId");
        expect(update?.ExpressionAttributeValues).not.toHaveProperty(":rejectionCode");
        expect(table.transactionRequests[0]?.TransactItems[1]?.Update?.UpdateExpression).toBe(
          "ADD uncertain :one",
        );
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports that the row is no longer the current attempt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({
          transactWriteItems: [cancelled("ConditionalCheckFailed", "None")],
        });

        expect(
          yield* storage.settleRecipient(
            campaignId,
            sendId,
            contactId,
            {
              state: "accepted",
              messageId: "0100019",
            },
            now,
          ),
        ).toBe("not-current");
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("checkpoint", () => {
  it("advances from an absent cursor on the first page", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(yield* storage.checkpoint(campaignId, runToken, sliceId, undefined, contactId)).toBe(
          "updated",
        );
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
        expectAliasedReservedNames(table);
      }),
    ));

  it("advances from the previous cursor on a later page", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(
          yield* storage.checkpoint(campaignId, runToken, sliceId, contactId, nextContactId),
        ).toBe("updated");
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
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports a lost checkpoint as condition-failed, not unavailable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({ updateItem: [conditionFailed] });

        expect(yield* storage.checkpoint(campaignId, runToken, sliceId, undefined, contactId)).toBe(
          "condition-failed",
        );
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("completeRun", () => {
  it("marks the campaign completed and removes the cursor", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(yield* storage.completeRun(campaignId, runToken, now)).toBe("completed");
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
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports a stale run as stale, not unavailable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({ updateItem: [conditionFailed] });

        expect(yield* storage.completeRun(campaignId, runToken, now)).toBe("stale");
        expectAliasedReservedNames(table);
      }),
    ));
});

describe("pauseRun", () => {
  it("pauses the campaign at the resume cursor", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(yield* storage.pauseRun(campaignId, runToken, "daily-quota", contactId)).toBe(
          "paused",
        );
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
        expectAliasedReservedNames(table);
      }),
    ));

  it("removes the cursor when pausing at the start of the list", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({});

        expect(yield* storage.pauseRun(campaignId, runToken, "sending-paused", undefined)).toBe(
          "paused",
        );
        expect(table.updateItemRequests[0]?.UpdateExpression).toBe(
          "SET #state = :paused, pausedReason = :reason REMOVE #cursor",
        );
        expect(table.updateItemRequests[0]?.ExpressionAttributeValues).not.toHaveProperty(
          ":cursor",
        );
        expectAliasedReservedNames(table);
      }),
    ));

  it("reports a stale run as stale, not unavailable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { table, storage } = withStorage({ updateItem: [conditionFailed] });

        expect(yield* storage.pauseRun(campaignId, runToken, "rate-limited", contactId)).toBe(
          "stale",
        );
        expectAliasedReservedNames(table);
      }),
    ));
});
