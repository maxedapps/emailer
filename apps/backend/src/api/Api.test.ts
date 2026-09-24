import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { makeEmailerClient } from "@emailer/api/Client";
import type { EmailerClient } from "@emailer/api/Client";
import * as AWS from "alchemy/AWS";
import * as Schemas from "@emailer/api/Schemas";
import {
  Clock,
  ConfigProvider,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
  Scope,
} from "effect";
import { FetchHttpClient, HttpEffect } from "effect/unstable/http";

import { AccountSuppression } from "../audience/Addresses.ts";
import { makeApiHandler } from "./Api.ts";
import { CampaignSchedule } from "../campaigns/CampaignSchedule.ts";
import { verifyPreviewToken } from "../campaigns/Previews.ts";
import { CampaignWake } from "../sending/Dispatch.ts";
import { Mailer } from "../sending/Mailer.ts";
import { SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { StorageFailure } from "../storage/Errors.ts";
import { unusedAudience, unusedCampaigns } from "../storage/Testing.ts";

import type { SendPurpose } from "../sending/Mailer.ts";
import type { SendAllowance } from "../sending/SendGuard.ts";
import type { AddressStatus } from "@emailer/api/Schemas";

const token = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

const otherToken = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp_Oo-NnMmLlK";

const baseUrl = "http://emailer.test";

const allowedRecipient = "sam@example.com";

const knownId = "0195f0a0-1111-4222-8333-44444444c001";

interface Store {
  readonly layer: Layer.Layer<
    | AudienceStore
    | CampaignStore
    | CampaignWake
    | CampaignSchedule
    | AccountSuppression
    | Mailer
    | SendGuard
  >;
  readonly mailed: Array<{
    readonly recipient: string;
    readonly subject: string;
    readonly purpose: SendPurpose;
  }>;
  readonly holdSending: (allowance: SendAllowance) => void;
  readonly reads: Array<string>;
  readonly writes: Array<string>;
  readonly sequence: Array<string>;
  readonly sesRequests: Array<string>;
  readonly wakes: Array<{ readonly campaignId: string; readonly runToken: string }>;
  readonly setCampaign: (campaign: Schemas.Campaign, runToken?: string) => void;
  readonly failControl: () => void;
  readonly failSesGet: (error: sesv2.GetSuppressedDestinationError) => void;
  readonly listOnAccount: (destination: sesv2.SuppressedDestination) => void;
  readonly failSesDelete: (error: sesv2.DeleteSuppressedDestinationError) => void;
}

/** A stored entity, or the store's answer for one that is not there. */
const found = <A>(value: A | undefined, entity: Schemas.NotFound["entity"]) =>
  value === undefined ? Effect.fail(new Schemas.NotFound({ entity })) : Effect.succeed(value);

const inMemory = (wakeFails = false, status: AddressStatus = "mailable"): Store => {
  const reads: Array<string> = [];
  const writes: Array<string> = [];
  const sequence: Array<string> = [];
  const sesRequests: Array<string> = [];
  const wakes: Array<{ readonly campaignId: string; readonly runToken: string }> = [];
  let addressStatus: AddressStatus = status;

  let sesGet: Effect.Effect<
    sesv2.GetSuppressedDestinationResponse,
    sesv2.GetSuppressedDestinationError
  > = Effect.fail(new sesv2.NotFoundException({ message: "not listed" }));

  let sesDelete: Effect.Effect<
    sesv2.DeleteSuppressedDestinationResponse,
    sesv2.DeleteSuppressedDestinationError
  > = Effect.succeed({});

  const contacts = new Map<string, Schemas.Contact>();
  const lists = new Map<string, Schemas.ContactList>();
  const members = new Map<string, Array<string>>();
  const campaigns = new Map<string, Schemas.Campaign>();
  const runTokens = new Map<string, string>();

  let controlFailure: StorageFailure | undefined;

  const mailed: Array<{
    readonly recipient: string;
    readonly subject: string;
    readonly purpose: SendPurpose;
  }> = [];

  let allowance: SendAllowance = { limit: 14 };

  const sending = Layer.mergeAll(
    Layer.succeed(Mailer)({
      send: (recipient, content, _unsubscribeUrl, purpose) =>
        Effect.sync(() => {
          mailed.push({ recipient, subject: content.subject, purpose });

          return { outcome: "accepted" as const, messageId: `message-${mailed.length}` };
        }),
    }),
    Layer.succeed(SendGuard)({
      current: Effect.sync(() => allowance),
      slot: () => Effect.succeed(Duration.zero),
    }),
  );

  const audience = Layer.succeed(AudienceStore)({
    ...unusedAudience,
    createContact: (contact) =>
      Effect.gen(function* () {
        writes.push("createContact");

        for (const existing of contacts.values()) {
          if (Schemas.mailboxKey(existing.email) === Schemas.mailboxKey(contact.email)) {
            return yield* new Schemas.EmailAlreadyUsed({ email: contact.email });
          }
        }

        contacts.set(contact.id, contact);
      }),
    getContact: (id) =>
      Effect.suspend(() => {
        reads.push("getContact");

        return found(contacts.get(id), "contact");
      }),
    getContactByEmail: (address) =>
      Effect.suspend(() => {
        reads.push("getContactByEmail");

        return found(
          [...contacts.values()].find(
            (contact) => Schemas.mailboxKey(contact.email) === Schemas.mailboxKey(address),
          ),
          "contact",
        );
      }),
    listContacts: (limit) =>
      Effect.sync(() => {
        reads.push("listContacts");

        return { items: [...contacts.values()].slice(0, limit) };
      }),
    updateContact: (id, update) =>
      Effect.gen(function* () {
        writes.push("updateContact");

        const current = yield* found(contacts.get(id), "contact");
        const email = update.email ?? current.email;

        // `status` stands for the stored address, so a move off it is what an opt-out refuses.
        if (
          addressStatus === "unsubscribed" &&
          Schemas.mailboxKey(email) !== Schemas.mailboxKey(current.email)
        ) {
          return yield* new Schemas.AddressOptedOut({ email: current.email });
        }

        for (const other of contacts.values()) {
          if (other.id !== id && Schemas.mailboxKey(other.email) === Schemas.mailboxKey(email)) {
            return yield* new Schemas.EmailAlreadyUsed({ email });
          }
        }

        const updated: Schemas.Contact = { ...current, email };

        contacts.set(id, updated);

        return updated;
      }),
    deleteContact: (id) =>
      Effect.gen(function* () {
        writes.push("deleteContact");

        if (!contacts.delete(id)) {
          return yield* new Schemas.NotFound({ entity: "contact" });
        }
      }),
    createList: (list) =>
      Effect.sync(() => {
        writes.push("createList");
        lists.set(list.id, list);
      }),
    getList: (id) =>
      Effect.suspend(() => {
        reads.push("getList");

        return found(lists.get(id), "list");
      }),
    renameList: (id, name) =>
      Effect.gen(function* () {
        writes.push("renameList");

        const renamed = { ...(yield* found(lists.get(id), "list")), name };

        lists.set(id, renamed);

        return renamed;
      }),
    deleteList: (id) =>
      Effect.gen(function* () {
        writes.push("deleteList");

        if (!lists.delete(id)) {
          return yield* new Schemas.NotFound({ entity: "list" });
        }

        members.delete(id);
      }),
    listMembers: (listId, limit) =>
      Effect.gen(function* () {
        reads.push("listMembers");

        yield* found(lists.get(listId), "list");

        const joined: Array<Schemas.Contact> = [];

        for (const id of (members.get(listId) ?? []).slice(0, limit)) {
          const contact = contacts.get(id);

          if (contact !== undefined) {
            joined.push(contact);
          }
        }

        return { items: joined };
      }),
    removeMember: (listId, contactId) =>
      Effect.gen(function* () {
        writes.push("removeMember");

        if (!lists.has(listId)) {
          return yield* new Schemas.NotFound({ entity: "list" });
        }

        members.set(
          listId,
          (members.get(listId) ?? []).filter((id) => id !== contactId),
        );
      }),
    importContacts: (listId, candidates, addedAt) =>
      Effect.gen(function* () {
        writes.push("importContacts");

        yield* found(lists.get(listId), "list");

        const joined = members.get(listId) ?? [];

        const imported = candidates.map((candidate) => {
          let held: string | undefined;

          for (const contact of contacts.values()) {
            if (Schemas.mailboxKey(contact.email) === Schemas.mailboxKey(candidate.email)) {
              held = contact.id;
            }
          }

          const id = held ?? candidate.id;

          if (held === undefined) {
            contacts.set(id, { id, email: candidate.email, createdAt: addedAt });
          }

          if (!joined.includes(id)) {
            joined.push(id);
          }

          return { email: candidate.email, contactId: id, member: true };
        });

        members.set(listId, joined);

        return { contacts: imported };
      }),
    addMember: (listId, contactId) =>
      Effect.gen(function* () {
        writes.push("addMember");

        yield* found(contacts.get(contactId), "contact");
        yield* found(lists.get(listId), "list");

        const current = members.get(listId) ?? [];

        if (current.includes(contactId)) {
          return "already-member" as const;
        }

        members.set(listId, [...current, contactId]);

        return "added" as const;
      }),
    addressStatus: () => Effect.succeed(addressStatus),
    addressRecord: (email) =>
      Effect.sync(() => {
        reads.push("addressRecord");
        sequence.push("addressRecord");

        return {
          email,
          status: addressStatus,
          transientBounces: [],
          accountSuppression: null,
        };
      }),
    unsuppress: () =>
      Effect.sync(() => {
        writes.push("unsuppress");
        sequence.push("unsuppress");
        addressStatus = "mailable";

        return undefined;
      }),
  });

  const accountSuppression = Layer.succeed(AccountSuppression)({
    getSuppressedDestination: (request) =>
      Effect.suspend(() => {
        sequence.push("getSuppressedDestination");
        sesRequests.push(request.EmailAddress);

        return sesGet;
      }),
    deleteSuppressedDestination: (_request) =>
      Effect.suspend(() => {
        sequence.push("deleteSuppressedDestination");

        return sesDelete;
      }),
  });

  const campaignStore = Layer.succeed(CampaignStore)({
    ...unusedCampaigns,
    createCampaign: (campaign) =>
      Effect.sync(() => {
        writes.push("createCampaign");
        campaigns.set(campaign.id, { ...campaign, submission: { state: "draft" } });
      }),
    getCampaign: (id) =>
      Effect.suspend(() => {
        reads.push("getCampaign");

        return found(campaigns.get(id), "campaign");
      }),
    updateDraft: (campaign) =>
      Effect.sync(() => {
        writes.push("updateDraft");

        if (campaigns.get(campaign.id)?.submission.state !== "draft") {
          return "conflict" as const;
        }

        campaigns.set(campaign.id, campaign);

        return "updated" as const;
      }),
    deleteDraft: (id) =>
      Effect.sync(() => {
        writes.push("deleteDraft");

        if (campaigns.get(id)?.submission.state !== "draft") {
          return "conflict" as const;
        }

        campaigns.delete(id);

        return "deleted" as const;
      }),
    listCampaigns: (limit) =>
      Effect.sync(() => {
        reads.push("listCampaigns");

        return { items: [...campaigns.values()].slice(0, limit) };
      }),
    getCampaignControl: (id) =>
      Effect.gen(function* () {
        reads.push("getCampaignControl");

        if (controlFailure !== undefined) {
          return yield* controlFailure;
        }

        const { submission } = yield* found(campaigns.get(id), "campaign");

        return {
          state: submission.state,
          runToken: runTokens.get(id),
          startedAt: "startedAt" in submission ? submission.startedAt : undefined,
          pausedReason: submission.state === "paused" ? submission.reason : undefined,
        };
      }),
    // Every run this suite starts is a send; scheduling and resuming belong to Campaigns.test.ts.
    newRun: (id, expected, newToken, _target, now) =>
      Effect.sync(() => {
        writes.push("newRun");

        const campaign = campaigns.get(id);

        if (
          campaign === undefined ||
          campaign.submission.state !== expected.state ||
          runTokens.get(id) !== expected.runToken
        ) {
          return "conflict" as const;
        }

        campaigns.set(id, { ...campaign, submission: { state: "queued", queuedAt: now } });
        runTokens.set(id, newToken);

        return "queued" as const;
      }),
    // Every cancel this suite drives returns to draft; the resume-to-paused rule belongs to
    // Campaigns.test.ts.
    cancelCampaign: (id, source) =>
      Effect.sync(() => {
        writes.push("cancelCampaign");

        const campaign = campaigns.get(id);

        if (
          campaign === undefined ||
          campaign.submission.state !== source.state ||
          runTokens.get(id) !== source.runToken
        ) {
          return "conflict" as const;
        }

        campaigns.set(id, { ...campaign, submission: { state: "draft" } });

        return "applied" as const;
      }),
  });

  const wake = Layer.succeed(CampaignWake)({
    enqueue: (campaignId, runToken) =>
      Effect.gen(function* () {
        if (wakeFails) {
          return yield* new StorageFailure({
            operationId: "dispatch",
            reason: "unavailable",
            cause: "lost",
          });
        }

        wakes.push({ campaignId, runToken });
      }),
  });

  const schedule = Layer.succeed(CampaignSchedule)({
    create: (_campaignId, _runToken, _sendAt) =>
      Effect.sync(() => {
        sequence.push("createSchedule");
      }),
  });

  const setCampaign = (campaign: Schemas.Campaign, runToken?: string) => {
    campaigns.set(campaign.id, campaign);

    if (runToken !== undefined) {
      runTokens.set(campaign.id, runToken);
    }
  };

  const listOnAccount = (destination: sesv2.SuppressedDestination) => {
    sesGet = Effect.succeed({ SuppressedDestination: destination });
  };

  const failSesDelete = (error: sesv2.DeleteSuppressedDestinationError) => {
    sesDelete = Effect.fail(error);
  };

  const failSesGet = (error: sesv2.GetSuppressedDestinationError) => {
    sesGet = Effect.fail(error);
  };

  return {
    layer: Layer.mergeAll(audience, campaignStore, wake, schedule, accountSuppression, sending),
    mailed,
    holdSending: (held) => {
      allowance = held;
    },
    reads,
    writes,
    sequence,
    sesRequests,
    wakes,
    setCampaign,
    failControl: () => {
      controlFailure = new StorageFailure({
        operationId: "getCampaignControl",
        reason: "unavailable",
        cause: "lost",
      });
    },
    failSesGet,
    listOnAccount,
    failSesDelete,
  };
};

/**
 * Builds the application once — as the deployed function does — and returns a handler that answers
 * many requests. A suite that rebuilt per request could not observe anything leaking between them,
 * because there would be nothing shared to leak.
 */
const builtHandler = (store: Store, accepted: string = token) => {
  const scope = Scope.makeUnsafe();

  return Effect.runSync(
    Layer.build(Layer.mergeAll(store.layer, NodeCrypto.layer)).pipe(
      Effect.flatMap((capabilities) =>
        Effect.provideContext(makeApiHandler(Redacted.make(accepted)), capabilities).pipe(
          Effect.map((handle) => Effect.provideContext(handle, capabilities)),
        ),
      ),
      Effect.provideService(Scope.Scope, scope),
    ),
  );
};

const webHandler = (store: Store, accepted: string = token) =>
  HttpEffect.toWebHandler(builtHandler(store, accepted));

const authorized = (extra: Readonly<Record<string, string>> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

const jsonRequest = (
  path: string,
  method: string,
  body: string,
  headers: Readonly<Record<string, string>>,
) =>
  new Request(`${baseUrl}${path}`, {
    method,
    body,
    headers: { "content-type": "application/json", ...headers },
  });

const cancelRequest = (id: string) =>
  new Request(`${baseUrl}/campaigns/${id}/cancel`, {
    method: "POST",
    headers: authorized(),
  });

const campaignFromJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schemas.Campaign));

describe("authentication", () => {
  it("refuses a request with no credential and challenges for Bearer", () => {
    const store = inMemory();

    return webHandler(store)(new Request(`${baseUrl}/contacts/${knownId}`)).then((response) => {
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(store.reads).toHaveLength(0);
      expect(store.writes).toHaveLength(0);
    });
  });

  it("refuses a wrong credential without touching storage or the mailer", () => {
    const store = inMemory();

    return webHandler(store)(
      new Request(`${baseUrl}/contacts/${knownId}`, {
        headers: { authorization: `Bearer ${otherToken}` },
      }),
    ).then((response) => {
      expect(response.status).toBe(401);
      expect(store.reads).toHaveLength(0);
      expect(store.writes).toHaveLength(0);
      expect(store.wakes).toHaveLength(0);
    });
  });

  it("refuses a credential joined with a duplicate", () => {
    const store = inMemory();

    return webHandler(store)(
      new Request(`${baseUrl}/contacts/${knownId}`, {
        headers: { authorization: `Bearer ${token}, Bearer ${token}` },
      }),
    ).then((response) => {
      expect(response.status).toBe(401);
      expect(store.reads).toHaveLength(0);
    });
  });

  it("evaluates each consecutive request independently", () => {
    const store = inMemory();
    const handler = webHandler(store);

    return handler(
      jsonRequest("/contacts", "POST", JSON.stringify({ email: allowedRecipient }), authorized()),
    )
      .then((first) => {
        expect(first.status).toBe(201);

        return handler(
          jsonRequest("/contacts", "POST", JSON.stringify({ email: allowedRecipient }), {
            authorization: `Bearer ${otherToken}`,
          }),
        );
      })
      .then((second) => {
        expect(second.status).toBe(401);
        expect(store.writes).toStrictEqual(["createContact"]);
      });
  });
});

describe("request decoding", () => {
  it("creates a contact and returns it with 201", () => {
    const store = inMemory();

    return webHandler(store)(
      jsonRequest(
        "/contacts",
        "POST",
        JSON.stringify({ email: " SAM@Example.COM ", name: " Sam " }),
        authorized(),
      ),
    )
      .then((response) => {
        expect(response.status).toBe(201);

        return response.json();
      })
      .then((body) => {
        expect(body).toMatchObject({ email: "SAM@example.com", name: "Sam" });
      });
  });

  it("answers 400 for a malformed body", () => {
    const store = inMemory();

    return webHandler(store)(jsonRequest("/contacts", "POST", "{not json", authorized())).then(
      (response) => {
        expect(response.status).toBe(400);
        expect(store.writes).toHaveLength(0);
      },
    );
  });

  it("answers 400 for a path parameter that is not an identifier", () => {
    const store = inMemory();

    return webHandler(store)(
      new Request(`${baseUrl}/contacts/not-a-uuid`, { headers: authorized() }),
    ).then((response) => {
      expect(response.status).toBe(400);
      expect(store.reads).toHaveLength(0);
    });
  });

  it("answers 400 for a value that violates the contract's limits", () => {
    const store = inMemory();

    return webHandler(store)(
      jsonRequest(
        "/lists",
        "POST",
        JSON.stringify({ name: "n".repeat(Schemas.maxNameLength + 1) }),
        authorized(),
      ),
    ).then((response) => {
      expect(response.status).toBe(400);
      expect(store.writes).toHaveLength(0);
    });
  });
});

describe("request size", () => {
  const oversize = JSON.stringify({ name: "n".repeat(Schemas.maxRequestBytes) });

  it("refuses an oversized body declared by Content-Length", () => {
    const store = inMemory();

    return webHandler(store)(jsonRequest("/lists", "POST", oversize, authorized()))
      .then((response) => {
        expect(response.status).toBe(413);
        expect(store.writes).toHaveLength(0);

        return response.text();
      })
      .then((body) => {
        expect(body).toContain('"PayloadTooLarge"');
        expect(body).toContain(`"limitBytes":${Schemas.maxRequestBytes}`);
      });
  });

  it("refuses an oversized body that declares no Content-Length", () => {
    const store = inMemory();

    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversize));
        controller.close();
      },
    });

    const request = new Request(`${baseUrl}/lists`, {
      method: "POST",
      body: streamed,
      headers: authorized(),
      duplex: "half",
    });

    expect(request.headers.get("content-length")).toBeNull();

    return webHandler(store)(request).then((response) => {
      expect(response.status).toBe(413);
      expect(store.writes).toHaveLength(0);
    });
  });
});

describe("public errors", () => {
  it("answers 404 with a typed body for a contact that does not exist", () => {
    const store = inMemory();

    return webHandler(store)(
      new Request(`${baseUrl}/contacts/${knownId}`, { headers: authorized() }),
    )
      .then((response) => {
        expect(response.status).toBe(404);

        return response.text();
      })
      .then((body) => {
        expect(body).toContain('"NotFound"');
        expect(body).toContain('"entity":"contact"');
      });
  });

  it.effect("answers 503 with a typed body when the dispatch wake fails", () => {
    const store = inMemory(true);
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      const campaign = yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello" },
      });

      const attempt = yield* Effect.result(client.campaigns.send({ params: { id: campaign.id } }));

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
        new Schemas.StorageUnavailable({ operationId: "dispatch" }),
      );

      const response = yield* Effect.promise(() =>
        handler(
          new Request(`${baseUrl}/campaigns/${campaign.id}/send`, {
            method: "POST",
            headers: authorized(),
          }),
        ),
      );

      expect(response.status).toBe(503);

      const body = yield* Effect.promise(() => response.text());

      expect(body).toContain('"StorageUnavailable"');
      expect(body).toContain('"operationId":"dispatch"');

      const queued = yield* client.campaigns.get({ params: { id: campaign.id } });

      expect(queued.submission.state).toBe("queued");
      expect(store.wakes).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
  });

  it.effect("answers 404 with a typed body when cancelling a campaign that does not exist", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const attempt = yield* Effect.result(client.campaigns.cancel({ params: { id: knownId } }));

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
        new Schemas.NotFound({ entity: "campaign" }),
      );

      const response = yield* Effect.promise(() => handler(cancelRequest(knownId)));

      expect(response.status).toBe(404);

      const body = yield* Effect.promise(() => response.text());

      expect(body).toContain('"NotFound"');
      expect(body).toContain('"entity":"campaign"');
      expect(body).not.toContain("runToken");
      expect(store.writes).toHaveLength(0);
      expect(store.sequence).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
  });

  it.effect("answers 503 with a typed body when cancelling cannot read campaign control", () => {
    const store = inMemory();
    const handler = webHandler(store);

    store.failControl();

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const attempt = yield* Effect.result(client.campaigns.cancel({ params: { id: knownId } }));

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
        new Schemas.StorageUnavailable({ operationId: "getCampaignControl" }),
      );

      const response = yield* Effect.promise(() => handler(cancelRequest(knownId)));

      expect(response.status).toBe(503);

      const body = yield* Effect.promise(() => response.text());

      expect(body).toContain('"StorageUnavailable"');
      expect(body).toContain('"operationId":"getCampaignControl"');
      expect(store.writes).toHaveLength(0);
      expect(store.sequence).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
  });

  it.effect.each(["2099-13-01T00:00:00.000Z", "2099-02-29T09:00:00.000Z"])(
    "rejects calendar-invalid sendAt %s without changing an existing schedule",
    (sendAt) => {
      const store = inMemory();
      const handler = webHandler(store);
      const runToken = "0195f0a0-1111-4222-8333-44444444e5d2";

      const campaign: Schemas.Campaign = {
        id: knownId,
        listId: knownId,
        subject: "Release notes",
        text: "Hello",
        createdAt: "2026-09-11T10:00:00.000Z",
        submission: { state: "scheduled", sendAt: "2099-06-01T09:00:00.000Z" },
      };

      store.setCampaign(campaign, runToken);

      return Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            jsonRequest(
              `/campaigns/${knownId}/schedule`,
              "POST",
              `{"sendAt":"${sendAt}"}`,
              authorized(),
            ),
          ),
        );

        expect(response.status).toBe(400);
        expect(store.writes).toHaveLength(0);
        expect(store.sequence).toHaveLength(0);
        expect(store.wakes).toHaveLength(0);

        const campaigns = yield* CampaignStore;

        expect(yield* campaigns.getCampaign(knownId)).toStrictEqual(campaign);
        expect(yield* campaigns.getCampaignControl(knownId)).toStrictEqual({
          state: "scheduled",
          runToken,
          startedAt: undefined,
          pausedReason: undefined,
        });
      }).pipe(Effect.provide(store.layer));
    },
  );

  it.effect("answers 409 with a typed body when sendAt is not in the future", () => {
    const store = inMemory();
    const handler = webHandler(store);
    const sendAt = "2026-09-11T10:00:01.000Z";

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      const campaign = yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello" },
      });

      const attempt = yield* Effect.result(
        client.campaigns.schedule({ params: { id: campaign.id }, payload: { sendAt } }),
      );

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
        new Schemas.SendAtNotInFuture({ sendAt }),
      );

      const response = yield* Effect.promise(() =>
        handler(
          jsonRequest(
            `/campaigns/${campaign.id}/schedule`,
            "POST",
            `{"sendAt":"${sendAt}"}`,
            authorized(),
          ),
        ),
      );

      expect(response.status).toBe(409);

      const body = yield* Effect.promise(() => response.text());

      expect(body).toContain('"SendAtNotInFuture"');
      expect(body).toContain(`"sendAt":"${sendAt}"`);

      const draft = yield* client.campaigns.get({ params: { id: campaign.id } });

      expect(draft.submission.state).toBe("draft");
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
  });
});

describe("request scope", () => {
  it("keeps a request-scoped resource open through the handler and closes it before responding", () => {
    const store = inMemory();
    const events: Array<string> = [];

    const handle = builtHandler(store);

    const app = Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push("finalized");
        }),
      );

      const response = yield* handle;

      events.push("handled");

      return response;
    });

    return HttpEffect.toWebHandler(app)(
      jsonRequest("/contacts", "POST", JSON.stringify({ email: allowedRecipient }), authorized()),
    ).then((response) => {
      expect(response.status).toBe(201);
      expect(events).toStrictEqual(["handled", "finalized"]);
    });
  });
});

describe("Function URL event adaptation", () => {
  const functionUrlEvent = (method: string, path: string, body?: string) => ({
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    headers: {
      authorization: `Bearer ${token}`,
      host: "emailer.lambda-url.eu-central-1.on.aws",
      "x-forwarded-proto": "https",
      "content-type": "application/json",
    },
    requestContext: {
      domainName: "emailer.lambda-url.eu-central-1.on.aws",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "203.0.113.7" },
    },
    body,
    isBase64Encoded: false,
  });

  const NativeResult = Schema.Struct({
    statusCode: Schema.Int,
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    body: Schema.optional(Schema.String),
  });

  const decodeNative = Schema.decodeUnknownEffect(NativeResult);

  const nativeHandler = (store: Store) => AWS.Lambda.makeFunctionHttpHandler(builtHandler(store));

  it.effect("answers a native event with a native result", () =>
    Effect.gen(function* () {
      const store = inMemory();

      const handled = nativeHandler(store)(
        functionUrlEvent("POST", "/contacts", `{"email":"${allowedRecipient}"}`),
      );

      expect(handled).toBeDefined();

      const result = yield* decodeNative(
        yield* Effect.scoped(handled ?? Effect.die("no handler matched the event")),
      );

      expect(result.statusCode).toBe(201);
      expect(result.headers?.["content-type"]).toContain("application/json");
      expect(result.body).toContain(allowedRecipient);
      expect(store.writes).toStrictEqual(["createContact"]);
    }),
  );

  it.effect("keeps the challenge on a native unauthorized result", () =>
    Effect.gen(function* () {
      const store = inMemory();
      const event = functionUrlEvent("GET", `/contacts/${knownId}`);

      event.headers.authorization = `Bearer ${otherToken}`;

      const handled = nativeHandler(store)(event);

      const result = yield* decodeNative(
        yield* Effect.scoped(handled ?? Effect.die("no handler matched the event")),
      );

      expect(result.statusCode).toBe(401);
      expect(result.headers?.["www-authenticate"]).toBe("Bearer");
      expect(store.reads).toHaveLength(0);
    }),
  );
});

describe("generated client round trip", () => {
  it.effect("runs the whole flow from contact to a queued campaign without a mailer", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const contact = yield* client.contacts.create({
        payload: { email: allowedRecipient, name: "Sam" },
      });

      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      yield* client.lists.addContact({ params: { listId: list.id, contactId: contact.id } });

      const campaign = yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello" },
      });

      expect(campaign.submission.state).toBe("draft");

      const sent = yield* client.campaigns.send({ params: { id: campaign.id } });

      expect(sent.submission.state).toBe("queued");
      expect(store.wakes).toHaveLength(1);
      expect(store.wakes[0]?.campaignId).toBe(campaign.id);

      const fetched = yield* client.campaigns.get({ params: { id: campaign.id } });

      expect(fetched.submission).toStrictEqual(sent.submission);

      const replayed = yield* client.campaigns.send({ params: { id: campaign.id } });

      expect(replayed.submission).toStrictEqual(sent.submission);
      expect(store.wakes).toHaveLength(2);
      expect(store.wakes[1]?.runToken).toBe(store.wakes[0]?.runToken);
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
  });

  it.effect("returns the same html from GET after creating a campaign with html", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      const html = "<p>Hello there</p>";

      const campaign = yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello", html },
      });

      expect(campaign.html).toBe(html);

      const fetched = yield* client.campaigns.get({ params: { id: campaign.id } });

      expect(fetched.html).toBe(html);
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
  });

  it.effect("returns the same filter from GET after creating a campaign with a filter", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      const filter = { plan: "pro" };

      const campaign = yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello", filter },
      });

      expect(campaign.filter).toStrictEqual(filter);

      const fetched = yield* client.campaigns.get({ params: { id: campaign.id } });

      expect(fetched.filter).toStrictEqual(filter);
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
  });

  it.effect("cancels a never-started queued campaign back to draft", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      const campaign = yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello" },
      });

      const queued = yield* client.campaigns.send({ params: { id: campaign.id } });

      expect(queued.submission.state).toBe("queued");

      const cancelled = yield* client.campaigns.cancel({ params: { id: campaign.id } });

      expect(cancelled.submission).toStrictEqual({ state: "draft" });
      expect(cancelled).not.toHaveProperty("runToken");

      const response = yield* Effect.promise(() => handler(cancelRequest(campaign.id)));

      expect(response.status).toBe(200);

      const body = yield* Effect.promise(() => response.text());

      expect(body).not.toContain("runToken");
      expect((yield* campaignFromJson(body)).submission).toStrictEqual({ state: "draft" });
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
  });

  it.effect.each([
    [
      "sending",
      {
        state: "sending" as const,
        queuedAt: "2026-09-11T10:00:01.000Z",
        startedAt: "2026-09-11T10:00:02.000Z",
        progress: { accepted: 1, rejected: 0, uncertain: 0, skipped: 0 },
        feedback: { bounced: 0, complained: 0 },
      },
    ],
    [
      "completed",
      {
        state: "completed" as const,
        queuedAt: "2026-09-11T10:00:01.000Z",
        startedAt: "2026-09-11T10:00:02.000Z",
        finishedAt: "2026-09-11T10:00:03.000Z",
        progress: { accepted: 1, rejected: 0, uncertain: 0, skipped: 0 },
        feedback: { bounced: 0, complained: 0 },
      },
    ],
  ] as const)("answers 409 without mutating a %s campaign", ([_label, submission]) => {
    const store = inMemory();
    const handler = webHandler(store);
    const runToken = "0195f0a0-1111-4222-8333-44444444e5d2";

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      const campaign = yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello" },
      });

      const current = { ...campaign, submission };

      store.setCampaign(current, runToken);

      const attempt = yield* Effect.result(
        client.campaigns.cancel({ params: { id: campaign.id } }),
      );

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
        new Schemas.CampaignStateConflict({ state: submission.state }),
      );

      const response = yield* Effect.promise(() => handler(cancelRequest(campaign.id)));

      expect(response.status).toBe(409);

      const body = yield* Effect.promise(() => response.text());

      expect(body).toContain('"CampaignStateConflict"');
      expect(body).toContain(`"state":"${submission.state}"`);
      expect(body).not.toContain("runToken");
      expect(store.writes).not.toContain("cancelCampaign");

      const fetched = yield* client.campaigns.get({ params: { id: campaign.id } });

      expect(fetched).toStrictEqual(current);
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
  });

  it.effect("surfaces a public error from the service as a typed client failure", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const attempt = yield* Effect.result(client.contacts.get({ params: { id: knownId } }));

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toBeInstanceOf(
        Schemas.NotFound,
      );
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
  });
});

const clientOver = (store: Store) => {
  const handler = webHandler(store);

  const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

  return <A, E>(use: (client: EmailerClient) => Effect.Effect<A, E, never>) =>
    Effect.gen(function* () {
      return yield* use(yield* makeEmailerClient(baseUrl, Redacted.make(token)));
    }).pipe(
      Effect.provide(
        Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
      ),
    );
};

describe("contact management", () => {
  it.effect("refuses a second contact on an address another one already holds", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        yield* client.contacts.create({ payload: { email: allowedRecipient } });

        const attempt = yield* Effect.result(
          client.contacts.create({ payload: { email: allowedRecipient } }),
        );

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toBeInstanceOf(
          Schemas.EmailAlreadyUsed,
        );
      }),
    );
  });

  it.effect("finds a contact by an address written in a different case", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const created = yield* client.contacts.create({ payload: { email: "Sam@example.com" } });

        const found = yield* client.contacts.getByEmail({ query: { email: "SAM@EXAMPLE.COM" } });

        expect(found.id).toBe(created.id);
      }),
    );
  });

  it.effect("carries attributes through creation, listing and an update that replaces them", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const created = yield* client.contacts.create({
          payload: { email: allowedRecipient, attributes: { plan: "pro" } },
        });

        expect(created.attributes).toStrictEqual({ plan: "pro" });

        const page = yield* client.contacts.list({ query: {} });

        expect(page.items).toStrictEqual([created]);
        expect(page.nextCursor).toBeUndefined();
      }),
    );
  });

  it.effect("removes a contact and then reports it as gone", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const created = yield* client.contacts.create({ payload: { email: allowedRecipient } });

        yield* client.contacts.remove({ params: { id: created.id } });

        const attempt = yield* Effect.result(client.contacts.get({ params: { id: created.id } }));

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toBeInstanceOf(
          Schemas.NotFound,
        );
      }),
    );
  });

  it.effect("refuses an update onto an address another contact holds", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const first = yield* client.contacts.create({ payload: { email: allowedRecipient } });

        yield* client.contacts.create({ payload: { email: "other@example.com" } });

        const attempt = yield* Effect.result(
          client.contacts.update({
            params: { id: first.id },
            payload: { email: "other@example.com" },
          }),
        );

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toBeInstanceOf(
          Schemas.EmailAlreadyUsed,
        );
      }),
    );
  });

  it.effect("refuses to move a contact off an address that opted out", () => {
    const store = inMemory(false, "unsubscribed");

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const created = yield* client.contacts.create({ payload: { email: allowedRecipient } });

        const attempt = yield* Effect.result(
          client.contacts.update({
            params: { id: created.id },
            payload: { email: "elsewhere@example.com" },
          }),
        );

        expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
          new Schemas.AddressOptedOut({ email: allowedRecipient }),
        );
      }),
    );
  });

  it("reads a literal lookup path as a lookup rather than as an identifier", () => {
    const store = inMemory();

    return webHandler(store)(
      new Request(`${baseUrl}/contacts/by-email?email=nobody%40example.com`, {
        headers: authorized(),
      }),
    )
      .then((response) => {
        expect(response.status).toBe(404);

        return response.text();
      })
      .then((body) => {
        expect(body).toContain('"NotFound"');
        expect(body).toContain('"entity":"contact"');
      });
  });

  it("refuses a page size outside the contract without touching storage", () => {
    const store = inMemory();

    return webHandler(store)(
      new Request(`${baseUrl}/contacts?limit=500`, { headers: authorized() }),
    ).then((response) => {
      expect(response.status).toBe(400);
      expect(store.reads).toHaveLength(0);
    });
  });

  it("refuses a tampered cursor without reaching storage", () => {
    const store = inMemory();

    return webHandler(store)(
      new Request(`${baseUrl}/contacts?cursor=not-a-cursor`, { headers: authorized() }),
    ).then((response) => {
      expect(response.status).toBe(400);
      expect(store.reads).toHaveLength(0);
    });
  });

  it("refuses an attribute key the contract bounds, without touching storage", () => {
    const store = inMemory();

    return webHandler(store)(
      jsonRequest(
        "/contacts",
        "POST",
        JSON.stringify({
          email: allowedRecipient,
          attributes: { [`k${"x".repeat(Schemas.maxAttributeKeyLength)}`]: "v" },
        }),
        authorized(),
      ),
    ).then((response) => {
      expect(response.status).toBe(400);
      expect(store.writes).toHaveLength(0);
    });
  });

  it("answers a delete of something absent with not found", () => {
    const store = inMemory();

    return webHandler(store)(
      new Request(`${baseUrl}/contacts/${knownId}`, { method: "DELETE", headers: authorized() }),
    ).then((response) => {
      expect(response.status).toBe(404);
    });
  });
});

describe("list management", () => {
  it.effect("renames a list and answers with the list as it now stands", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const created = yield* client.lists.create({ payload: { name: "Weekly" } });

        const renamed = yield* client.lists.update({
          params: { id: created.id },
          payload: { name: "Monthly" },
        });

        expect(renamed).toStrictEqual({ ...created, name: "Monthly" });
      }),
    );
  });

  it.effect("tells a list with no members apart from a list that is not there", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const created = yield* client.lists.create({ payload: { name: "Weekly" } });

        const empty = yield* client.lists.listMembers({
          params: { listId: created.id },
          query: {},
        });

        expect(empty.items).toStrictEqual([]);

        const attempt = yield* Effect.result(
          client.lists.listMembers({ params: { listId: knownId }, query: {} }),
        );

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toBeInstanceOf(
          Schemas.NotFound,
        );
      }),
    );
  });

  it.effect("answers a bulk import with converged state, identically on a re-run", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const created = yield* client.lists.create({ payload: { name: "Weekly" } });

        const payload = { contacts: [{ email: allowedRecipient }] };

        const first = yield* client.lists.import({ params: { listId: created.id }, payload });
        const second = yield* client.lists.import({ params: { listId: created.id }, payload });

        expect(second).toStrictEqual(first);
        expect(first.contacts[0]?.member).toBe(true);

        const members = yield* client.lists.listMembers({
          params: { listId: created.id },
          query: {},
        });

        expect(members.items).toHaveLength(1);
      }),
    );
  });

  it.effect("removes a member, leaving the contact itself alone", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const contact = yield* client.contacts.create({ payload: { email: allowedRecipient } });
        const list = yield* client.lists.create({ payload: { name: "Weekly" } });

        yield* client.lists.addContact({ params: { listId: list.id, contactId: contact.id } });

        yield* client.lists.removeContact({
          params: { listId: list.id, contactId: contact.id },
        });

        const members = yield* client.lists.listMembers({
          params: { listId: list.id },
          query: {},
        });

        expect(members.items).toStrictEqual([]);
        expect(yield* client.contacts.get({ params: { id: contact.id } })).toStrictEqual(contact);
      }),
    );
  });

  it.effect("deletes a list and then reports it as gone", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const created = yield* client.lists.create({ payload: { name: "Weekly" } });

        yield* client.lists.remove({ params: { id: created.id } });

        const attempt = yield* Effect.result(client.lists.get({ params: { id: created.id } }));

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toBeInstanceOf(
          Schemas.NotFound,
        );
      }),
    );
  });

  it.effect("refuses an import naming one address twice, without touching storage", () => {
    const store = inMemory();

    return Effect.gen(function* () {
      const created = yield* clientOver(store)((client) =>
        client.lists.create({ payload: { name: "Weekly" } }),
      );

      store.writes.length = 0;

      const body = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))({
        contacts: [{ email: "Sam@example.com" }, { email: "sam@EXAMPLE.com" }],
      });

      const response = yield* Effect.promise(() =>
        webHandler(store)(jsonRequest(`/lists/${created.id}/contacts`, "POST", body, authorized())),
      );

      expect(response.status).toBe(400);
      expect(store.writes).toHaveLength(0);
    });
  });
});

describe("draft editing", () => {
  const clientLayer = (store: Store) => {
    const handler = webHandler(store);
    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return {
      handler,
      layer: Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
    };
  };

  it.effect(
    "edits a draft, removing its html and filter with null, and reads the edit back",
    () => {
      const store = inMemory();
      const { layer } = clientLayer(store);

      return Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));
        const list = yield* client.lists.create({ payload: { name: "Readers" } });

        const campaign = yield* client.campaigns.create({
          payload: {
            listId: list.id,
            subject: "Release notes",
            text: "Hello",
            html: "<p>Hello</p>",
            filter: { plan: "pro" },
          },
        });

        const updated = yield* client.campaigns.update({
          params: { id: campaign.id },
          payload: { subject: "New notes", text: "Hi", html: null, filter: null },
        });

        expect(updated).toStrictEqual({
          id: campaign.id,
          listId: list.id,
          subject: "New notes",
          text: "Hi",
          createdAt: campaign.createdAt,
          submission: { state: "draft" },
        });
        expect(yield* client.campaigns.get({ params: { id: campaign.id } })).toStrictEqual(updated);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("deletes a draft with 204, after which it is not found", () => {
    const store = inMemory();
    const { handler, layer } = clientLayer(store);

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));
      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      const campaign = yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello" },
      });

      const response = yield* Effect.promise(() =>
        handler(
          new Request(`${baseUrl}/campaigns/${campaign.id}`, {
            method: "DELETE",
            headers: authorized(),
          }),
        ),
      );

      expect(response.status).toBe(204);

      const attempt = yield* Effect.result(client.campaigns.get({ params: { id: campaign.id } }));

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
        new Schemas.NotFound({ entity: "campaign" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers 409 with the state to editing or deleting a queued campaign", () => {
    const store = inMemory();
    const { layer } = clientLayer(store);

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));
      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      const campaign = yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello" },
      });

      const queued: Schemas.Campaign = {
        ...campaign,
        submission: { state: "queued", queuedAt: "2026-09-11T10:00:01.000Z" },
      };

      store.setCampaign(queued, "0195f0a0-1111-4222-8333-44444444e5d2");

      const edit = yield* Effect.result(
        client.campaigns.update({ params: { id: campaign.id }, payload: { subject: "x" } }),
      );

      const removal = yield* Effect.result(
        client.campaigns.remove({ params: { id: campaign.id } }),
      );

      const conflict = new Schemas.CampaignStateConflict({ state: "queued" });

      expect(Result.isFailure(edit) ? edit.failure : undefined).toStrictEqual(conflict);
      expect(Result.isFailure(removal) ? removal.failure : undefined).toStrictEqual(conflict);

      expect(yield* client.campaigns.get({ params: { id: campaign.id } })).toStrictEqual(queued);
    }).pipe(Effect.provide(layer));
  });
});

describe("test sends", () => {
  const clientLayer = (store: Store) => {
    const handler = HttpEffect.toWebHandler(
      builtHandler(store).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            EMAILER_UNSUBSCRIBE_URL: "https://unsubscribe.example/",
            EMAILER_UNSUBSCRIBE_SECRET:
              "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718293a4b5c6d7e8f90",
          }),
        ),
      ),
    );

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return {
      handler,
      layer: Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
    };
  };

  const draftFor = (client: EmailerClient) =>
    Effect.gen(function* () {
      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      return yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello" },
      });
    });

  it.effect(
    "sends an untagged [Test] copy to each address in order and reports every outcome",
    () => {
      const store = inMemory();
      const { layer } = clientLayer(store);

      return Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));
        const campaign = yield* draftFor(client);

        const result = yield* client.campaigns.test({
          params: { id: campaign.id },
          payload: { to: ["first@example.com", "Second@Example.com"] },
        });

        expect(result).toStrictEqual({
          recipients: [
            { email: "first@example.com", outcome: "accepted", messageId: "message-1" },
            { email: "Second@example.com", outcome: "accepted", messageId: "message-2" },
          ],
        });
        expect(store.mailed).toStrictEqual([
          {
            recipient: "first@example.com",
            subject: "[Test] Release notes",
            purpose: { kind: "test" },
          },
          {
            recipient: "Second@example.com",
            subject: "[Test] Release notes",
            purpose: { kind: "test" },
          },
        ]);
        expect(store.writes).not.toContain("claimRecipient");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([
    [
      "more than twenty addresses",
      { to: Array.from({ length: 21 }, (_, n) => `r${n}@example.com`) },
    ],
    ["the same mailbox twice", { to: ["a@example.com", "A@example.com"] }],
    ["no address", { to: [] }],
  ])("refuses %s with 400 before sending", ([_label, payload]) => {
    const store = inMemory();
    const { handler } = clientLayer(store);

    return Effect.gen(function* () {
      const body = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        payload,
      );

      const response = yield* Effect.promise(() =>
        handler(
          jsonRequest(
            "/campaigns/0195f0a0-1111-4222-8333-4444444ca409/test",
            "POST",
            body,
            authorized(),
          ),
        ),
      );

      expect(response.status).toBe(400);
      expect(store.mailed).toHaveLength(0);
    });
  });

  it.effect("answers 503 SendingPaused while the account-wide guard halts sending", () => {
    const store = inMemory();
    const { layer } = clientLayer(store);

    return Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));
      const campaign = yield* draftFor(client);

      store.holdSending({ limit: 14, refusal: "reputation" });

      const attempt = yield* Effect.result(
        client.campaigns.test({
          params: { id: campaign.id },
          payload: { to: ["a@example.com"] },
        }),
      );

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
        new Schemas.SendingPaused({ reason: "reputation" }),
      );
      expect(store.mailed).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("preview links", () => {
  const previewKey = "5d41402abc4b2a76b9719d911017c5925d41402abc4b2a76b9719d911017c592";

  const clientLayer = (store: Store) => {
    const handler = HttpEffect.toWebHandler(
      builtHandler(store).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            EMAILER_PREVIEW_URL: "https://preview.example/",
            EMAILER_PREVIEW_SECRET: previewKey,
          }),
        ),
      ),
    );

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport));
  };

  // Live: the server mints the expiry on the real clock, so "now" here must be the real clock too.
  it.live("mints a link under the preview function's URL that names the campaign", () =>
    Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));
      const list = yield* client.lists.create({ payload: { name: "Readers" } });

      const campaign = yield* client.campaigns.create({
        payload: { listId: list.id, subject: "Release notes", text: "Hello" },
      });

      const link = yield* client.campaigns.preview({ params: { id: campaign.id } });
      const previewToken = link.url.replace("https://preview.example/previews/", "");

      expect(link.url.startsWith("https://preview.example/previews/v1.")).toBe(true);
      expect(
        verifyPreviewToken(
          Redacted.make(previewKey),
          previewToken,
          Math.floor((yield* Clock.currentTimeMillis) / 1000),
        ),
      ).toStrictEqual(Option.some(campaign.id));
    }).pipe(Effect.provide(clientLayer(inMemory()))),
  );

  it.effect("answers 404 for a campaign that does not exist", () =>
    Effect.gen(function* () {
      const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

      const attempt = yield* Effect.result(
        client.campaigns.preview({ params: { id: "0195f0a0-1111-4222-8333-4444444ca409" } }),
      );

      expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
        new Schemas.NotFound({ entity: "campaign" }),
      );
    }).pipe(Effect.provide(clientLayer(inMemory()))),
  );
});

describe("campaign listing", () => {
  it.effect("returns created campaigns as summaries without the body and honours limit", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const list = yield* client.lists.create({ payload: { name: "Readers" } });

        const first = yield* client.campaigns.create({
          payload: { listId: list.id, subject: "Release notes", text: "Hello" },
        });

        yield* client.campaigns.create({
          payload: { listId: list.id, subject: "Follow-up", text: "Later" },
        });

        const page = yield* client.campaigns.list({ query: { limit: 1 } });

        expect(page.items).toStrictEqual([
          {
            id: first.id,
            listId: list.id,
            subject: "Release notes",
            createdAt: first.createdAt,
            submission: { state: "draft" },
          },
        ]);
        expect(yield* client.campaigns.get({ params: { id: first.id } })).toStrictEqual(first);
      }),
    );
  });
});

describe("application lifetime", () => {
  // The router is built once and answers many invocations. Whatever is shared between them is
  // immutable setup; anything carrying a caller's identity must not survive past its request.
  it("does not carry a credential from one request into the next", () => {
    const store = inMemory();
    const handler = webHandler(store);

    return handler(new Request(`${baseUrl}/contacts`, { headers: authorized() }))
      .then((first) => {
        expect(first.status).toBe(200);

        // No credential at all on the second request, against the same built application.
        return handler(new Request(`${baseUrl}/contacts`));
      })
      .then((second) => {
        expect(second.status).toBe(401);
        expect(second.headers.get("www-authenticate")).toBe("Bearer");
      });
  });

  it("runs a request-scoped finalizer once per invocation, not once per application", () => {
    const store = inMemory();
    const events: Array<string> = [];
    const handle = builtHandler(store);

    const web = HttpEffect.toWebHandler(
      Effect.andThen(
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            events.push("finalized");
          }),
        ),
        handle,
      ),
    );

    return web(new Request(`${baseUrl}/contacts`, { headers: authorized() }))
      .then(() => web(new Request(`${baseUrl}/contacts`, { headers: authorized() })))
      .then(() => {
        expect(events).toStrictEqual(["finalized", "finalized"]);
      });
  });
});

describe("addresses", () => {
  const mailable = {
    email: allowedRecipient,
    status: "mailable" as const,
    transientBounces: [],
    accountSuppression: null,
  };

  it.effect("returns the local record with a null account entry when SES has none", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const record = yield* client.addresses.status({ query: { email: allowedRecipient } });

        expect(record).toStrictEqual(mailable);
        expect(store.sequence).toStrictEqual(["addressRecord", "getSuppressedDestination"]);
      }),
    );
  });

  it.effect("maps a present account entry to its reason and an ISO timestamp", () => {
    const store = inMemory();

    store.listOnAccount({
      EmailAddress: allowedRecipient,
      Reason: "BOUNCE",
      LastUpdateTime: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-15T10:20:30.000Z")),
    });

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const record = yield* client.addresses.status({ query: { email: allowedRecipient } });

        expect(record).toStrictEqual({
          ...mailable,
          accountSuppression: { reason: "bounce", lastUpdateTime: "2026-09-15T10:20:30.000Z" },
        });
      }),
    );
  });

  it.effect("passes the address to SES exactly as given and reports it back unchanged", () => {
    const store = inMemory();
    const listed = "User@Example.com";

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const record = yield* client.addresses.status({ query: { email: listed } });

        expect(record.email).toBe(listed);
        expect(store.sesRequests).toStrictEqual([listed]);
      }),
    );
  });

  it.effect("clears the local rows when SES has no entry to delete", () => {
    const store = inMemory(false, "bouncing");

    store.failSesDelete(new sesv2.NotFoundException({ message: "not listed" }));

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const record = yield* client.addresses.unsuppress({
          payload: { email: allowedRecipient },
        });

        expect(record).toStrictEqual(mailable);
        expect(store.sequence).toStrictEqual([
          "deleteSuppressedDestination",
          "unsuppress",
          "addressRecord",
          "getSuppressedDestination",
        ]);
      }),
    );
  });

  it.effect("answers 503 naming the delete when SES refuses it for another reason", () => {
    const store = inMemory(false, "suppressed");

    store.failSesDelete(new sesv2.TooManyRequestsException({ message: "slow" }));

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const attempt = yield* Effect.result(
          client.addresses.unsuppress({ payload: { email: allowedRecipient } }),
        );

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
          new Schemas.StorageUnavailable({ operationId: "deleteSuppressedDestination" }),
        );
        expect(store.writes).not.toContain("unsuppress");
      }),
    );
  });

  it.effect(
    "answers 503 with a typed body when the suppression lookup fails for another reason",
    () => {
      const store = inMemory();

      store.failSesGet(new sesv2.TooManyRequestsException({ message: "slow" }));

      const handler = webHandler(store);

      const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

      return Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

        const attempt = yield* Effect.result(
          client.addresses.status({ query: { email: allowedRecipient } }),
        );

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
          new Schemas.StorageUnavailable({ operationId: "getSuppressedDestination" }),
        );

        const response = yield* Effect.promise(() =>
          handler(
            new Request(
              `${baseUrl}/addresses/status?email=${encodeURIComponent(allowedRecipient)}`,
              { headers: authorized() },
            ),
          ),
        );

        expect(response.status).toBe(503);

        const body = yield* Effect.promise(() => response.text());

        expect(body).toContain('"StorageUnavailable"');
        expect(body).toContain('"operationId":"getSuppressedDestination"');
      }).pipe(
        Effect.provide(
          Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
        ),
      );
    },
  );

  it.effect(
    "deletes the account entry before the local rows and returns the refreshed record",
    () => {
      const store = inMemory(false, "suppressed");

      return clientOver(store)((client) =>
        Effect.gen(function* () {
          const record = yield* client.addresses.unsuppress({
            payload: { email: allowedRecipient },
          });

          expect(record).toStrictEqual(mailable);
          expect(store.sequence).toStrictEqual([
            "deleteSuppressedDestination",
            "unsuppress",
            "addressRecord",
            "getSuppressedDestination",
          ]);
        }),
      );
    },
  );

  it("refuses addresses status without a credential", () => {
    const store = inMemory();

    return webHandler(store)(
      new Request(`${baseUrl}/addresses/status?email=${encodeURIComponent(allowedRecipient)}`),
    ).then((response) => {
      expect(response.status).toBe(401);
      expect(store.sequence).toHaveLength(0);
    });
  });

  it("refuses addresses unsuppress without a credential", () => {
    const store = inMemory();

    return webHandler(store)(
      jsonRequest("/addresses/unsuppress", "POST", JSON.stringify({ email: allowedRecipient }), {}),
    ).then((response) => {
      expect(response.status).toBe(401);
      expect(store.sequence).toHaveLength(0);
    });
  });
});
