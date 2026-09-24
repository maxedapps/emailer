import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { makeEmailerClient } from "./Client.ts";
import * as Errors from "./Errors.ts";

const baseUrl = "http://emailer.test";

const token = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

const contactId = "0195f0a0-1111-4222-8333-444444444441";

const createdAt = "2026-09-11T10:00:00.000Z";

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string;
}

interface Transport {
  readonly fetch: typeof globalThis.fetch;
  readonly recorded: Array<RecordedRequest>;
}

const transportReplying = (respond: (attempt: number) => Response): Transport => {
  const recorded: Array<RecordedRequest> = [];

  const fetchStub: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);

    return request.text().then((body) => {
      recorded.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body,
      });

      return respond(recorded.length);
    });
  };

  return { fetch: fetchStub, recorded };
};

const json = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

const withTransport = <A, E>(
  transport: Transport,
  use: (client: Effect.Success<ReturnType<typeof makeEmailerClient>>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

    return yield* Effect.result(use(client));
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
  );

describe("makeEmailerClient", () => {
  it.effect("attaches the bearer credential and encodes the request body", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() =>
        json(201, JSON.stringify({ id: contactId, email: "sam@example.com", createdAt })),
      );

      const result = yield* withTransport(transport, (client) =>
        client.contacts.create({ payload: { email: "sam@example.com" } }),
      );

      expect(Result.isSuccess(result)).toBe(true);
      expect(transport.recorded).toHaveLength(1);

      const [sent] = transport.recorded;

      expect(sent?.method).toBe("POST");
      expect(sent?.url).toBe(`${baseUrl}/contacts`);
      expect(sent?.authorization).toBe(`Bearer ${token}`);
      expect(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(sent?.body),
      ).toStrictEqual({ email: "sam@example.com" });
    }),
  );

  it.effect("decodes a successful response through the shared schema", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() =>
        json(
          201,
          JSON.stringify({ id: contactId, email: "sam@example.com", name: "Sam", createdAt }),
        ),
      );

      const result = yield* withTransport(transport, (client) =>
        client.contacts.create({ payload: { email: "sam@example.com", name: "Sam" } }),
      );

      expect(Result.isSuccess(result) && result.success).toStrictEqual({
        id: contactId,
        email: "sam@example.com",
        name: "Sam",
        createdAt,
      });
    }),
  );

  it.effect("surfaces a declared public error as a typed failure", () =>
    Effect.gen(function* () {
      const notFoundBody = '{"_tag":"ContactNotFound"}';

      const transport = transportReplying(() => json(404, notFoundBody));

      const result = yield* withTransport(transport, (client) =>
        client.contacts.get({ params: { id: contactId } }),
      );

      expect(Result.isFailure(result) ? result.failure : undefined).toBeInstanceOf(
        Errors.ContactNotFound,
      );
    }),
  );

  it.effect("surfaces a cancellation conflict as a typed failure", () =>
    Effect.gen(function* () {
      const conflictBody = '{"_tag":"CampaignStateConflict","state":"sending"}';

      const transport = transportReplying(() => json(409, conflictBody));

      const result = yield* withTransport(transport, (client) =>
        client.campaigns.cancel({ params: { id: contactId } }),
      );

      expect(Result.isFailure(result) ? result.failure : undefined).toBeInstanceOf(
        Errors.CampaignStateConflict,
      );
      expect(Result.isFailure(result) && result.failure).toMatchObject({ state: "sending" });
      expect(Result.isFailure(result) && result.failure).not.toHaveProperty("runToken");
    }),
  );

  it.effect("fails instead of accepting a malformed success body", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() =>
        json(201, JSON.stringify({ id: contactId, createdAt })),
      );

      const result = yield* withTransport(transport, (client) =>
        client.contacts.create({ payload: { email: "sam@example.com" } }),
      );

      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("does not retry a mutation when the service fails", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() => json(500, JSON.stringify({ error: "boom" })));

      const result = yield* withTransport(transport, (client) =>
        client.campaigns.send({ params: { id: contactId } }),
      );

      expect(Result.isFailure(result)).toBe(true);
      expect(transport.recorded).toHaveLength(1);
    }),
  );

  it.effect("does not retry a mutation when the transport fails", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() => {
        throw new Error("connection reset");
      });

      const result = yield* withTransport(transport, (client) =>
        client.contacts.create({ payload: { email: "sam@example.com" } }),
      );

      expect(Result.isFailure(result)).toBe(true);
      expect(transport.recorded).toHaveLength(1);
    }),
  );
});
