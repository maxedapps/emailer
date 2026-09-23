import * as AWS from "alchemy/AWS";
import { fromCredentials } from "alchemy/AWS/Credentials";
import { Effect, Layer, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { str } from "./Items.ts";
import { transactionPrimitives, updatePrimitives } from "./Primitives.ts";
import { tokensFor } from "./Testing.ts";

/**
 * The scripted table sits above the AWS client, so it cannot see the client's own retries. These
 * tests run the two conditional primitives over a stubbed transport and prove the property the
 * store relies on: a transient answer is retried by the client with the identical request, token
 * included, while a conflict cancellation is retried by the store as a new call with a new token.
 */

interface Transport {
  readonly fetch: typeof globalThis.fetch;
  readonly attempts: Array<string>;
}

const transportReplying = (responses: ReadonlyArray<() => Response>): Transport => {
  const attempts: Array<string> = [];

  const fetchStub: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);

    return request.text().then((body) => {
      attempts.push(body);

      const respond = responses[attempts.length - 1] ?? responses[responses.length - 1];

      if (respond === undefined) {
        throw new Error("no scripted response");
      }

      return respond();
    });
  };

  return { fetch: fetchStub, attempts };
};

interface DynamoDBReply {
  readonly __type?: string;
  readonly message?: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code: string }>;
}

const json = (status: number, body: DynamoDBReply) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/x-amz-json-1.0" },
  });

const serverError = () =>
  json(500, { __type: "com.amazonaws.dynamodb.v20120810#InternalServerError", message: "boom" });

const conflictCancellation = () =>
  json(400, {
    __type: "com.amazonaws.dynamodb.v20120810#TransactionCanceledException",
    message: "Transaction cancelled",
    CancellationReasons: [{ Code: "TransactionConflict" }],
  });

const ok = () => json(200, {});

const credentials = fromCredentials(
  { accessKeyId: "AKIAEXAMPLEEXAMPLE00", secretAccessKey: "not-a-real-secret" },
  "eu-central-1",
);

const bindings = (transport: Transport) =>
  Layer.provide(
    Layer.merge(AWS.DynamoDB.UpdateItemHttp, AWS.DynamoDB.TransactWriteItemsHttp),
    Layer.merge(
      credentials,
      Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport.fetch)),
    ),
  );

interface ResourceStandIn {
  readonly LogicalId: string;
}

const asResource = <Resource extends ResourceStandIn>(value: ResourceStandIn): Resource =>
  // SAFETY: outside a binding host the table bindings read only `LogicalId` and `tableName`.
  value as Resource;

const tableStandIn = {
  LogicalId: "EmailerData",
  tableName: Effect.succeed(Effect.succeed("emailer-test-EmailerData-9f3c")),
};

const table = asResource<AWS.DynamoDB.Table>(tableStandIn);

const key = { pk: str("CAMPAIGN#x"), sk: str("META") };

const tokenOf = (body: string): string | undefined => {
  // SAFETY: the transport records the JSON body the client sent.
  const sent = JSON.parse(body) as { ClientRequestToken?: string };

  return sent.ClientRequestToken;
};

const runUpdateIf = (transport: Transport) =>
  Effect.gen(function* () {
    const updateItem = yield* AWS.DynamoDB.UpdateItem(table);
    const { updateIf } = updatePrimitives({ updateItem });

    return yield* Effect.result(
      updateIf("checkpoint", {
        Key: key,
        UpdateExpression: "SET #state = :s",
        ConditionExpression: "#state = :p",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":s": str("sending"), ":p": str("queued") },
      }),
    );
  }).pipe(Effect.provide(bindings(transport)));

const runTransaction = (transport: Transport) =>
  Effect.gen(function* () {
    const transactWriteItems = yield* AWS.DynamoDB.TransactWriteItems(table);

    const { runTransaction } = transactionPrimitives(
      { transactWriteItems },
      tokensFor(transport.attempts),
    );

    return yield* Effect.result(
      runTransaction("claimRecipient", {
        TransactItems: [
          {
            Put: {
              Table: table.LogicalId,
              Item: key,
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );
  }).pipe(Effect.provide(bindings(transport)));

const runLifecycleTransaction = (transport: Transport) =>
  Effect.gen(function* () {
    const transactWriteItems = yield* AWS.DynamoDB.TransactWriteItems(table);

    const { runTransaction } = transactionPrimitives(
      { transactWriteItems },
      tokensFor(transport.attempts),
    );

    return yield* Effect.result(
      runTransaction("enqueueCampaign", {
        TransactItems: [
          {
            Update: {
              Table: table.LogicalId,
              Key: key,
              UpdateExpression:
                "SET #state = :queued, queuedAt = :now, runToken = :run, runAccepted = accepted, runBounced = bounced, runComplained = complained",
              ConditionExpression: "#state = :draft AND attribute_not_exists(runToken)",
              ExpressionAttributeNames: { "#state": "state" },
              ExpressionAttributeValues: {
                ":queued": str("queued"),
                ":now": str("2026-09-11T10:00:04.000Z"),
                ":run": str("0195f0a0-1111-4222-8333-44444444e5d2"),
                ":draft": str("draft"),
              },
            },
          },
        ],
      }),
    );
  }).pipe(Effect.provide(bindings(transport)));

describe("conditional primitives over the real client", () => {
  it("updateIf lets the client retry a server error with the identical request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying([serverError, ok]);

        const outcome = yield* runUpdateIf(transport);

        expect(Result.isSuccess(outcome) && outcome.success).toStrictEqual({
          applied: true,
          attributes: undefined,
        });
        expect(transport.attempts).toHaveLength(2);
        expect(transport.attempts[1]).toBe(transport.attempts[0]);
      }),
    ));

  it("runTransaction lets the client retry a server error with the same token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying([serverError, ok]);

        const outcome = yield* runTransaction(transport);

        expect(Result.isSuccess(outcome) && outcome.success).toStrictEqual({ committed: true });
        expect(transport.attempts).toHaveLength(2);
        expect(transport.attempts[1]).toBe(transport.attempts[0]);
        expect(tokenOf(transport.attempts[0] ?? "")).toBe("token-1");
      }),
    ));

  it("runTransaction retries a conflict cancellation itself, as a new call with a new token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying([conflictCancellation, ok]);

        const outcome = yield* runTransaction(transport);

        expect(Result.isSuccess(outcome) && outcome.success).toStrictEqual({ committed: true });
        expect(transport.attempts.map(tokenOf)).toStrictEqual(["token-1", "token-2"]);
      }),
    ));

  it("retries a lifecycle Update with the identical body and ClientRequestToken after a server error", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying([serverError, ok]);

        const outcome = yield* runLifecycleTransaction(transport);

        expect(Result.isSuccess(outcome) && outcome.success).toStrictEqual({ committed: true });
        expect(transport.attempts).toHaveLength(2);
        expect(transport.attempts[1]).toBe(transport.attempts[0]);
        expect(tokenOf(transport.attempts[0] ?? "")).toBe("token-1");
        expect(transport.attempts[0]).toContain("attribute_not_exists");
        expect(transport.attempts[0]).toContain("ClientRequestToken");
      }),
    ));

  it("retries a lifecycle Update conflict cancellation as a new call with a new token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying([conflictCancellation, ok]);

        const outcome = yield* runLifecycleTransaction(transport);

        expect(Result.isSuccess(outcome) && outcome.success).toStrictEqual({ committed: true });
        expect(transport.attempts.map(tokenOf)).toStrictEqual(["token-1", "token-2"]);
      }),
    ));
});
