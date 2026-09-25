import { describe, expect, it } from "@effect/vitest";
import { StorageUnavailable } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { HttpEffect } from "effect/unstable/http";

import { UnsubscribeStore } from "../storage/Unsubscribe.ts";
import { maxTokenLength, mintToken } from "./Unsubscribe.ts";
import { makeUnsubscribeHandler } from "./UnsubscribePage.ts";

import type { AddressUnsubscribe } from "../storage/Addresses.ts";

const baseUrl = "http://unsubscribe.test";

const signingKey = "6f1c2d3e4a5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

const email = "Sam@Example.com";

const longestAddress = `${"a".repeat(Schemas.maxEmailLength - "@example.com".length)}@example.com`;

const configuration = Layer.succeed(ConfigProvider.ConfigProvider)(
  ConfigProvider.fromEnvRecord({ EMAILER_UNSUBSCRIBE_SECRET: signingKey }),
);

interface Store {
  readonly operations: UnsubscribeStore["Service"];
  readonly written: Array<AddressUnsubscribe>;
}

const storeWith = (writeFails = false): Store => {
  const written: Array<AddressUnsubscribe> = [];
  const keys = new Set<string>();

  // The whole capability, stated in full, because the whole capability is one
  // update. There is no contact read to stub out and none to reach:
  // the service the handler is given does not have one.
  const operations: UnsubscribeStore["Service"] = {
    unsubscribeAddress: (unsubscribe) =>
      writeFails
        ? Effect.fail(
            new StorageUnavailable({
              operation: "unsubscribeAddress",
              failure: "InternalServerError",
            }),
          )
        : Effect.sync(() => {
            const key = Schemas.mailboxKey(unsubscribe.email);

            // The store keeps the first opt-out an address item holds, so the
            // double keeps only the first record for an address.
            if (!keys.has(key)) {
              keys.add(key);
              written.push(unsubscribe);
            }
          }),
  };

  return { operations, written };
};

/**
 * Built as the deployed function builds it, inside the test's scope, and then able to answer many
 * requests.
 */
const handlerFor = (store: Store) =>
  Effect.map(makeUnsubscribeHandler.pipe(Effect.provide(configuration)), (handle) =>
    HttpEffect.toWebHandler(
      handle.pipe(
        Effect.provideService(UnsubscribeStore, store.operations),
        Effect.provide(configuration),
      ),
    ),
  );

type Handler = Effect.Success<ReturnType<typeof handlerFor>>;

const ask = (handler: Handler, request: Request) => Effect.promise(() => handler(request));

const tokenFor = (address: string) => mintToken(Redacted.make(signingKey), address);

const validToken = tokenFor(email);

const responding = (
  store: Store,
  method: string,
  token: string = validToken,
  init: RequestInit = {},
) =>
  Effect.flatMap(handlerFor(store), (handler) =>
    ask(handler, new Request(`${baseUrl}/unsubscribe/${token}`, { method, ...init })),
  );

const bodyOf = (response: Response) => Effect.promise(() => response.text());

describe("GET /unsubscribe/:token", () => {
  it.effect(
    "offers the opt-out without performing it, so a scanner cannot unsubscribe anyone",
    () =>
      Effect.gen(function* () {
        const store = storeWith();

        const response = yield* responding(store, "GET");

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(store.written).toHaveLength(0);
      }),
  );

  it.effect("posts the confirmation to the current URL rather than interpolating the token", () =>
    Effect.gen(function* () {
      const body = yield* bodyOf(yield* responding(storeWith(), "GET"));

      expect(body).toContain('method="post"');
      expect(body).not.toContain("action=");
      expect(body).not.toContain(validToken);
    }),
  );

  it.effect("refuses a forged signature rather than offering a button that cannot work", () =>
    Effect.gen(function* () {
      const store = storeWith();
      const forged = mintToken(Redacted.make("a different key"), email);

      const response = yield* responding(store, "GET", forged);

      expect(response.status).toBe(404);
      expect(store.written).toHaveLength(0);
    }),
  );
});

describe("POST /unsubscribe/:token", () => {
  it.effect("writes the opt-out keyed by the mailbox the token named", () =>
    Effect.gen(function* () {
      const store = storeWith();

      const response = yield* responding(store, "POST");

      expect(response.status).toBe(200);
      expect(store.written).toHaveLength(1);
      expect(store.written[0]?.email).toBe("sam@example.com");
    }),
  );

  // The body is never read, which is how both of RFC 8058's permitted encodings
  // are accepted without parsing either.
  it.effect.each([
    [
      "the form encoding RFC 8058 specifies",
      {
        body: "List-Unsubscribe=One-Click",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
    ],
    ["an empty body and no content type", { body: "" }],
  ] as const)("honours a one-click POST sent with %s", ([_description, init]) =>
    Effect.gen(function* () {
      const store = storeWith();

      const response = yield* responding(store, "POST", validToken, init);

      expect(response.status).toBe(200);
      expect(store.written).toHaveLength(1);
    }),
  );

  it.effect("accepts the longest link the address schema can produce", () =>
    Effect.gen(function* () {
      const store = storeWith();
      const token = tokenFor(longestAddress);

      expect(token).toHaveLength(maxTokenLength);

      const response = yield* responding(store, "POST", token);

      expect(response.status).toBe(200);
      expect(store.written[0]?.email).toBe(longestAddress);
    }),
  );

  it.effect("refuses a forged signature with a 404 and writes nothing", () =>
    Effect.gen(function* () {
      const store = storeWith();
      const forged = mintToken(Redacted.make("a different key"), email);

      expect((yield* responding(store, "POST", forged)).status).toBe(404);
      expect(store.written).toHaveLength(0);
    }),
  );

  it.effect("never claims an opt-out the write did not durably record", () =>
    Effect.gen(function* () {
      const response = yield* responding(storeWith(true), "POST");

      expect(response.status).toBe(500);
      expect(yield* bodyOf(response)).not.toContain("unsubscribed");
    }),
  );
});

describe("application lifetime", () => {
  // One built router answers many invocations, so a refusal must not be able to follow a success
  // or the other way round.
  it.effect("judges each consecutive request on its own token", () =>
    Effect.gen(function* () {
      const store = storeWith();
      const handler = yield* handlerFor(store);
      const forged = mintToken(Redacted.make("a different key"), email);

      const post = (token: string) =>
        ask(handler, new Request(`${baseUrl}/unsubscribe/${token}`, { method: "POST" }));

      expect((yield* post(validToken)).status).toBe(200);
      expect((yield* post(forged)).status).toBe(404);
      expect((yield* post(tokenFor("other@example.com"))).status).toBe(200);

      expect(store.written.map((entry) => entry.email)).toStrictEqual([
        "sam@example.com",
        "other@example.com",
      ]);
    }),
  );
});
