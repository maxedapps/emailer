import { Effect, Redacted, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { makeEmailerClient } from "./Client.ts";
import * as Schemas from "./Schemas.ts";

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
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      return yield* Effect.result(use(client));
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
    ),
  );

describe("makeEmailerClient", () => {
  it("attaches the bearer credential and encodes the request body", () => {
    const transport = transportReplying(() =>
      json(201, JSON.stringify({ id: contactId, email: "max@example.com", createdAt })),
    );

    return withTransport(transport, (client) =>
      client.contacts.create({ payload: { email: "max@example.com" } }),
    ).then((result) => {
      expect(Result.isSuccess(result)).toBe(true);
      expect(transport.recorded).toHaveLength(1);

      const [sent] = transport.recorded;

      expect(sent?.method).toBe("POST");
      expect(sent?.url).toBe(`${baseUrl}/contacts`);
      expect(sent?.authorization).toBe(`Bearer ${token}`);
      expect(JSON.parse(sent?.body ?? "")).toStrictEqual({ email: "max@example.com" });
    });
  });

  it("decodes a successful response through the shared schema", () => {
    const transport = transportReplying(() =>
      json(
        201,
        JSON.stringify({ id: contactId, email: "max@example.com", name: "Max", createdAt }),
      ),
    );

    return withTransport(transport, (client) =>
      client.contacts.create({ payload: { email: "max@example.com", name: "Max" } }),
    ).then((result) => {
      expect(Result.isSuccess(result) && result.success).toStrictEqual({
        id: contactId,
        email: "max@example.com",
        name: "Max",
        createdAt,
      });
    });
  });

  it("surfaces a declared public error as a typed failure", () => {
    const notFoundBody = '{"_tag":"NotFound","entity":"contact"}';

    const transport = transportReplying(() => json(404, notFoundBody));

    return withTransport(transport, (client) =>
      client.contacts.get({ params: { id: contactId } }),
    ).then((result) => {
      expect(Result.isFailure(result) ? result.failure : undefined).toBeInstanceOf(
        Schemas.NotFound,
      );
      expect(Result.isFailure(result) && result.failure).toMatchObject({ entity: "contact" });
    });
  });

  it("surfaces a cancellation conflict as a typed failure", () => {
    const conflictBody = '{"_tag":"CampaignCancellationConflict","state":"sending"}';

    const transport = transportReplying(() => json(409, conflictBody));

    return withTransport(transport, (client) =>
      client.campaigns.cancel({ params: { id: contactId } }),
    ).then((result) => {
      expect(Result.isFailure(result) ? result.failure : undefined).toBeInstanceOf(
        Schemas.CampaignCancellationConflict,
      );
      expect(Result.isFailure(result) && result.failure).toMatchObject({ state: "sending" });
      expect(Result.isFailure(result) && result.failure).not.toHaveProperty("runToken");
    });
  });

  it("fails instead of accepting a malformed success body", () => {
    const transport = transportReplying(() =>
      json(201, JSON.stringify({ id: contactId, createdAt })),
    );

    return withTransport(transport, (client) =>
      client.contacts.create({ payload: { email: "max@example.com" } }),
    ).then((result) => {
      expect(Result.isFailure(result)).toBe(true);
    });
  });

  it("does not retry a mutation when the service fails", () => {
    const transport = transportReplying(() => json(500, JSON.stringify({ error: "boom" })));

    return withTransport(transport, (client) =>
      client.campaigns.send({ params: { id: contactId } }),
    ).then((result) => {
      expect(Result.isFailure(result)).toBe(true);
      expect(transport.recorded).toHaveLength(1);
    });
  });

  it("does not retry a mutation when the transport fails", () => {
    const transport = transportReplying(() => {
      throw new Error("connection reset");
    });

    return withTransport(transport, (client) =>
      client.contacts.create({ payload: { email: "max@example.com" } }),
    ).then((result) => {
      expect(Result.isFailure(result)).toBe(true);
      expect(transport.recorded).toHaveLength(1);
    });
  });
});
