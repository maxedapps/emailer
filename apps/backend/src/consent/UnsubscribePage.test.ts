import * as Schemas from "@emailer/api/Schemas";
import { ConfigProvider, Effect, Layer, Redacted, Scope } from "effect";
import { HttpEffect } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { StorageFailure } from "../storage/Errors.ts";
import { UnsubscribeStore } from "../storage/Unsubscribe.ts";
import { maxTokenLength, mintToken } from "./Unsubscribe.ts";
import { makeUnsubscribeHandler } from "./UnsubscribePage.ts";

import type { AddressUnsubscribe } from "../storage/Addresses.ts";

const baseUrl = "http://unsubscribe.test";

const signingKey = "6f1c2d3e4a5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

const email = "Max@Example.com";

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
  // conditional write. There is no contact read to stub out and none to reach:
  // the service the handler is given does not have one.
  const operations: UnsubscribeStore["Service"] = {
    unsubscribeAddress: (unsubscribe) =>
      writeFails
        ? Effect.fail(
            new StorageFailure({
              operationId: "unsubscribeAddress",
              reason: "unavailable",
              cause: "boom",
            }),
          )
        : Effect.sync(() => {
            const key = Schemas.mailboxKey(unsubscribe.email);

            // recordOnce makes a repeated opt-out a real no-op, so the double
            // keeps only the first record for an address.
            if (!keys.has(key)) {
              keys.add(key);
              written.push(unsubscribe);
            }
          }),
  };

  return { operations, written };
};

/** Built once, as the deployed function builds it, and then asked to answer many requests. */
const handlerFor = (store: Store) => {
  const scope = Scope.makeUnsafe();

  const handle = Effect.runSync(
    makeUnsubscribeHandler.pipe(
      Effect.provide(configuration),
      Effect.provideService(Scope.Scope, scope),
    ),
  );

  return HttpEffect.toWebHandler(
    handle.pipe(
      Effect.provideService(UnsubscribeStore, store.operations),
      Effect.provide(configuration),
    ),
  );
};

const tokenFor = (address: string) => mintToken(Redacted.make(signingKey), address);

const validToken = tokenFor(email);

const responding = (
  store: Store,
  method: string,
  token: string = validToken,
  init: RequestInit = {},
) =>
  Effect.promise(() =>
    handlerFor(store)(new Request(`${baseUrl}/unsubscribe/${token}`, { method, ...init })),
  );

const bodyOf = (response: Response) => Effect.promise(() => response.text());

describe("GET /unsubscribe/:token", () => {
  it("offers the opt-out without performing it, so a scanner cannot unsubscribe anyone", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = storeWith();

        const response = yield* responding(store, "GET");

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(store.written).toHaveLength(0);
      }),
    ));

  it("posts the confirmation to the current URL rather than interpolating the token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* bodyOf(yield* responding(storeWith(), "GET"));

        expect(body).toContain('method="post"');
        expect(body).not.toContain("action=");
        expect(body).not.toContain(validToken);
      }),
    ));

  it("refuses a forged signature rather than offering a button that cannot work", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = storeWith();
        const forged = mintToken(Redacted.make("a different key"), email);

        const response = yield* responding(store, "GET", forged);

        expect(response.status).toBe(404);
        expect(store.written).toHaveLength(0);
      }),
    ));

  // Verifying is not acting. The scanner-safety property is that a GET reaches
  // no storage at all, which a 200 alone would not show.
  it("reads no storage even for a token it accepts", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = storeWith();

        expect((yield* responding(store, "GET")).status).toBe(200);
        expect(store.written).toHaveLength(0);
      }),
    ));
});

describe("POST /unsubscribe/:token", () => {
  it("writes the opt-out keyed by the mailbox the token named", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = storeWith();

        const response = yield* responding(store, "POST");

        expect(response.status).toBe(200);
        expect(store.written).toHaveLength(1);
        expect(store.written[0]?.email).toBe("max@example.com");
      }),
    ));

  // The body is never read, which is how both of RFC 8058's permitted encodings
  // are accepted without parsing either.
  it.each([
    [
      "the form encoding RFC 8058 specifies",
      {
        body: "List-Unsubscribe=One-Click",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
    ],
    ["an empty body and no content type", { body: "" }],
  ])("honours a one-click POST sent with %s", (_description, init) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = storeWith();

        const response = yield* responding(store, "POST", validToken, init);

        expect(response.status).toBe(200);
        expect(store.written).toHaveLength(1);
      }),
    ),
  );

  it("accepts the longest link the address schema can produce", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = storeWith();
        const token = tokenFor(longestAddress);

        expect(token).toHaveLength(maxTokenLength);

        const response = yield* responding(store, "POST", token);

        expect(response.status).toBe(200);
        expect(store.written[0]?.email).toBe(longestAddress);
      }),
    ));

  it("still confirms a repeated opt-out without writing again", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = storeWith();

        expect((yield* responding(store, "POST")).status).toBe(200);
        expect((yield* responding(store, "POST")).status).toBe(200);
        expect(store.written).toHaveLength(1);
      }),
    ));

  it("refuses a forged signature with a 404 and writes nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = storeWith();
        const forged = mintToken(Redacted.make("a different key"), email);

        expect((yield* responding(store, "POST", forged)).status).toBe(404);
        expect(store.written).toHaveLength(0);
      }),
    ));

  it("never claims an opt-out the write did not durably record", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* responding(storeWith(true), "POST");

        expect(response.status).toBe(500);
        expect(yield* bodyOf(response)).not.toContain("unsubscribed");
      }),
    ));
});

describe("application lifetime", () => {
  // One built router answers many invocations, so a refusal must not be able to follow a success
  // or the other way round.
  it("judges each consecutive request on its own token", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = storeWith();
        const forged = mintToken(Redacted.make("a different key"), email);

        expect((yield* responding(store, "POST")).status).toBe(200);
        expect((yield* responding(store, "POST", forged)).status).toBe(404);
        expect((yield* responding(store, "POST", tokenFor("other@example.com"))).status).toBe(200);

        expect(store.written.map((entry) => entry.email)).toStrictEqual([
          "max@example.com",
          "other@example.com",
        ]);
      }),
    ));
});
