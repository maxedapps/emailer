import * as AWS from "alchemy/AWS";
import { fromCredentials } from "alchemy/AWS/Credentials";
import { Data, Effect, Layer, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { StorageUnavailable } from "@emailer/api/Errors";

import { FunctionServicesLive } from "../Lambda.ts";
import { str } from "./Items.ts";
import { transactionPrimitives, updatePrimitives } from "./Primitives.ts";
import { tokensFor } from "./Testing.ts";

/**
 * The scripted table sits above the AWS client, so it cannot see the client's own retries. These
 * tests run the two conditional primitives over a stubbed transport, under the services every
 * function provides, and prove the properties the store relies on: a transient answer is retried by
 * the client with the identical request, token included, and within the operation timeout; a
 * conflict cancellation is retried by the store as a new call with a new token; and every reply is
 * requested uncompressed.
 */

interface Transport {
  readonly fetch: typeof globalThis.fetch;
  readonly attempts: Array<string>;
  readonly encodings: Array<string | null>;
}

const transportReplying = (responses: ReadonlyArray<() => Response>): Transport => {
  const attempts: Array<string> = [];
  const encodings: Array<string | null> = [];

  const fetchStub: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);

    encodings.push(request.headers.get("accept-encoding"));

    return request.text().then((body) => {
      attempts.push(body);

      const respond = responses[attempts.length - 1] ?? responses[responses.length - 1];

      if (respond === undefined) {
        throw new Error("no scripted response");
      }

      return respond();
    });
  };

  return { fetch: fetchStub, attempts, encodings };
};

interface DynamoDBReply {
  readonly __type?: string;
  readonly message?: string;
  readonly CancellationReasons?: ReadonlyArray<{
    readonly Code: string;
    readonly Item?: Readonly<Record<string, { readonly S: string }>>;
  }>;
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

const conditionCancellation = () =>
  json(400, {
    __type: "com.amazonaws.dynamodb.v20120810#TransactionCanceledException",
    message: "Transaction cancelled",
    CancellationReasons: [
      { Code: "ConditionalCheckFailed", Item: { pk: { S: "CAMPAIGN#x" }, state: { S: "paused" } } },
    ],
  });

const ok = () => json(200, {});

class Refused extends Data.TaggedError("Refused")<{ readonly current: unknown }> {}

const credentials = fromCredentials(
  { accessKeyId: "AKIAEXAMPLEEXAMPLE00", secretAccessKey: "not-a-real-secret" },
  "eu-central-1",
);

const bindings = (transport: Transport) => {
  const http = Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, transport.fetch),
  );

  return Layer.merge(
    Layer.provide(
      Layer.merge(AWS.DynamoDB.UpdateItemHttp, AWS.DynamoDB.TransactWriteItemsHttp),
      Layer.merge(credentials, http),
    ),
    Layer.provide(FunctionServicesLive, http),
  );
};

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
      updateIf(
        "checkpoint",
        {
          Key: key,
          UpdateExpression: "SET #state = :s",
          ConditionExpression: "#state = :p",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":s": str("sending"), ":p": str("queued") },
        },
        (current) => new Refused({ current }),
      ),
    );
  }).pipe(Effect.provide(bindings(transport)));

const runTransaction = (transport: Transport) =>
  Effect.gen(function* () {
    const transactWriteItems = yield* AWS.DynamoDB.TransactWriteItems(table);

    const { transact } = transactionPrimitives(
      { transactWriteItems },
      tokensFor(transport.attempts),
    );

    return yield* Effect.result(
      transact("claimRecipient", [
        {
          Put: {
            Table: table.LogicalId,
            Item: key,
            ConditionExpression: "attribute_not_exists(pk)",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
          refused: (current) => new Refused({ current }),
        },
      ]),
    );
  }).pipe(Effect.provide(bindings(transport)));

const runLifecycleTransaction = (transport: Transport) =>
  Effect.gen(function* () {
    const transactWriteItems = yield* AWS.DynamoDB.TransactWriteItems(table);

    const { transact } = transactionPrimitives(
      { transactWriteItems },
      tokensFor(transport.attempts),
    );

    return yield* Effect.result(
      transact("enqueueCampaign", [
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
      ]),
    );
  }).pipe(Effect.provide(bindings(transport)));

describe("conditional primitives over the real client", () => {
  it.live("updateIf lets the client retry a server error with the identical request", () =>
    Effect.gen(function* () {
      const transport = transportReplying([serverError, ok]);

      const outcome = yield* runUpdateIf(transport);

      expect(Result.isSuccess(outcome)).toBe(true);
      expect(transport.attempts).toHaveLength(2);
      expect(transport.attempts[1]).toBe(transport.attempts[0]);
    }),
  );

  // DynamoDB labels large error replies gzip without compressing them, which fetch cannot decode.
  it.live("asks for every reply uncompressed, retries included", () =>
    Effect.gen(function* () {
      const transport = transportReplying([serverError, ok]);

      yield* runTransaction(transport);

      expect(transport.encodings).toStrictEqual(["identity", "identity"]);
    }),
  );

  // Live: the client backs off on the real clock. Without the retry budget, its default policy
  // would still be retrying when the operation timeout fired, and the store would report a timeout.
  it.live(
    "gives up on a persistent server error inside the timeout, with the service's error",
    () =>
      Effect.gen(function* () {
        const transport = transportReplying([serverError]);

        const outcome = yield* runUpdateIf(transport);

        expect(Result.isFailure(outcome) && outcome.failure).toStrictEqual(
          new StorageUnavailable({ operation: "checkpoint", failure: "InternalServerError" }),
        );
        expect(transport.attempts.length).toBeGreaterThan(1);
      }),
  );

  it.live("transact lets the client retry a server error with the same token", () =>
    Effect.gen(function* () {
      const transport = transportReplying([serverError, ok]);

      const outcome = yield* runTransaction(transport);

      expect(Result.isSuccess(outcome)).toBe(true);
      expect(transport.attempts).toHaveLength(2);
      expect(transport.attempts[1]).toBe(transport.attempts[0]);
      expect(tokenOf(transport.attempts[0] ?? "")).toBe("token-1");
    }),
  );

  it.live("transact retries a conflict cancellation itself, as a new call with a new token", () =>
    Effect.gen(function* () {
      const transport = transportReplying([conflictCancellation, ok]);

      const outcome = yield* runTransaction(transport);

      expect(Result.isSuccess(outcome)).toBe(true);
      expect(transport.attempts.map(tokenOf)).toStrictEqual(["token-1", "token-2"]);
    }),
  );

  it.live(
    "retries a lifecycle Update with the identical body and ClientRequestToken after a server error",
    () =>
      Effect.gen(function* () {
        const transport = transportReplying([serverError, ok]);

        const outcome = yield* runLifecycleTransaction(transport);

        expect(Result.isSuccess(outcome)).toBe(true);
        expect(transport.attempts).toHaveLength(2);
        expect(transport.attempts[1]).toBe(transport.attempts[0]);
        expect(tokenOf(transport.attempts[0] ?? "")).toBe("token-1");
        expect(transport.attempts[0]).toContain("attribute_not_exists");
        expect(transport.attempts[0]).toContain("ClientRequestToken");
      }),
  );

  it.live("passes the item a failed condition returned to the refusal, as the SDK parsed it", () =>
    Effect.gen(function* () {
      const transport = transportReplying([conditionCancellation]);

      const outcome = yield* runTransaction(transport);

      expect(Result.isFailure(outcome) && outcome.failure).toStrictEqual(
        new Refused({ current: { pk: { S: "CAMPAIGN#x" }, state: { S: "paused" } } }),
      );
      expect(transport.attempts).toHaveLength(1);
      expect(transport.attempts[0]).toContain('"ReturnValuesOnConditionCheckFailure":"ALL_OLD"');
    }),
  );

  it.live("retries a lifecycle Update conflict cancellation as a new call with a new token", () =>
    Effect.gen(function* () {
      const transport = transportReplying([conflictCancellation, ok]);

      const outcome = yield* runLifecycleTransaction(transport);

      expect(Result.isSuccess(outcome)).toBe(true);
      expect(transport.attempts.map(tokenOf)).toStrictEqual(["token-1", "token-2"]);
    }),
  );
});
