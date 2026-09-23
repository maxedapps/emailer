import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { NodeCrypto } from "@effect/platform-node";
import { makeEmailerClient } from "@emailer/api/Client";
import type { EmailerClient } from "@emailer/api/Client";
import * as AWS from "alchemy/AWS";
import * as Schemas from "@emailer/api/Schemas";
import { DateTime, Effect, Layer, Option, Redacted, Result, Schema, Scope } from "effect";
import { FetchHttpClient, HttpEffect } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { AccountSuppression } from "../audience/Addresses.ts";
import { makeApiHandler } from "./Api.ts";
import { CampaignSchedule } from "../campaigns/CampaignSchedule.ts";
import { CampaignWake } from "../sending/Dispatch.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { StorageFailure } from "../storage/Errors.ts";
import { unusedAudience } from "../storage/Testing.ts";

import type { AddressStatus } from "../storage/Addresses.ts";
import type { StoredContactList } from "../storage/Lists.ts";

const token = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

const otherToken = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp_Oo-NnMmLlK";

const baseUrl = "http://emailer.test";

const allowedRecipient = "max@example.com";

const knownId = "0195f0a0-1111-4222-8333-44444444c001";

interface Store {
  readonly layer: Layer.Layer<
    AudienceStore | CampaignStore | CampaignWake | CampaignSchedule | AccountSuppression
  >;
  readonly reads: Array<string>;
  readonly writes: Array<string>;
  readonly sequence: Array<string>;
  readonly sesRequests: Array<string>;
  readonly wakes: Array<{ readonly campaignId: string; readonly runToken: string }>;
  readonly setCampaign: (campaign: Schemas.Campaign, runToken?: string) => void;
  readonly beforeWrite: (action: () => void) => void;
  readonly failControl: () => void;
  readonly failSesGet: (error: sesv2.GetSuppressedDestinationError) => void;
  readonly listOnAccount: (destination: sesv2.SuppressedDestination) => void;
  readonly failSesDelete: (error: sesv2.DeleteSuppressedDestinationError) => void;
}

const unusedCampaignStore = {
  getCampaignBody: () =>
    Effect.die(new Error("CampaignStore.getCampaignBody is not exercised by this test")),
  beginRun: () => Effect.die(new Error("CampaignStore.beginRun is not exercised by this test")),
  claimRecipient: () =>
    Effect.die(new Error("CampaignStore.claimRecipient is not exercised by this test")),
  skipRecipient: () =>
    Effect.die(new Error("CampaignStore.skipRecipient is not exercised by this test")),
  settleRecipient: () =>
    Effect.die(new Error("CampaignStore.settleRecipient is not exercised by this test")),
  checkpoint: () => Effect.die(new Error("CampaignStore.checkpoint is not exercised by this test")),
  completeRun: () =>
    Effect.die(new Error("CampaignStore.completeRun is not exercised by this test")),
  pauseRun: () => Effect.die(new Error("CampaignStore.pauseRun is not exercised by this test")),
  scheduleCampaign: () =>
    Effect.die(new Error("CampaignStore.scheduleCampaign is not exercised by this test")),
  cancelCampaign: () =>
    Effect.die(new Error("CampaignStore.cancelCampaign is not exercised by this test")),
};

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
  const lists = new Map<string, StoredContactList>();
  const members = new Map<string, Array<string>>();
  const campaigns = new Map<string, Schemas.Campaign>();
  const runTokens = new Map<string, string>();
  const startedAtById = new Map<string, string>();

  const history = new Map<
    string,
    {
      readonly queuedAt: string;
      readonly startedAt: string;
      readonly progress: Schemas.CampaignProgress;
      readonly feedback: Schemas.CampaignFeedback;
    }
  >();

  let pendingWrite: (() => void) | undefined;
  let controlFailure: StorageFailure | undefined;

  const audience = Layer.succeed(AudienceStore)({
    ...unusedAudience,
    createContact: (contact) =>
      Effect.suspend(() => {
        writes.push("createContact");

        for (const existing of contacts.values()) {
          if (Schemas.mailboxKey(existing.email) === Schemas.mailboxKey(contact.email)) {
            return Effect.succeed("email-taken" as const);
          }
        }

        contacts.set(contact.id, contact);

        return Effect.succeed("created" as const);
      }),
    getContact: (id) =>
      Effect.sync(() => {
        reads.push("getContact");

        return Option.fromUndefinedOr(contacts.get(id));
      }),
    getContactByEmail: (address) =>
      Effect.sync(() => {
        reads.push("getContactByEmail");

        for (const contact of contacts.values()) {
          if (Schemas.mailboxKey(contact.email) === Schemas.mailboxKey(address)) {
            return Option.some(contact);
          }
        }

        return Option.none<Schemas.Contact>();
      }),
    listContacts: (limit) =>
      Effect.sync(() => {
        reads.push("listContacts");

        const page = [...contacts.values()].slice(0, limit);

        return { items: page, nextCursor: undefined };
      }),
    updateContact: (id, update) =>
      Effect.sync(() => {
        writes.push("updateContact");

        const found = contacts.get(id);

        if (found === undefined) {
          return { outcome: "contact-missing" as const };
        }

        const email = update.email ?? found.email;

        // `status` stands for the stored address, so a move off it is what an opt-out refuses.
        if (
          addressStatus === "unsubscribed" &&
          Schemas.mailboxKey(email) !== Schemas.mailboxKey(found.email)
        ) {
          return { outcome: "opted-out" as const, email: found.email };
        }

        for (const other of contacts.values()) {
          if (other.id !== id && Schemas.mailboxKey(other.email) === Schemas.mailboxKey(email)) {
            return { outcome: "email-taken" as const, email };
          }
        }

        const updated: Schemas.Contact = { ...found, email };

        contacts.set(id, updated);

        return { outcome: "updated" as const, contact: updated };
      }),
    deleteContact: (id) =>
      Effect.sync(() => {
        writes.push("deleteContact");

        return contacts.delete(id) ? ("deleted" as const) : ("contact-missing" as const);
      }),
    createList: (list) =>
      Effect.sync(() => {
        writes.push("createList");
        lists.set(list.id, { list, membershipVersion: 0 });
      }),
    getList: (id) =>
      Effect.sync(() => {
        reads.push("getList");

        return Option.fromUndefinedOr(lists.get(id));
      }),
    listLists: (limit) =>
      Effect.sync(() => {
        reads.push("listLists");

        const page = [...lists.values()].slice(0, limit).map((stored) => stored.list);

        return { items: page, nextCursor: undefined };
      }),
    renameList: (id, name) =>
      Effect.sync(() => {
        writes.push("renameList");

        const stored = lists.get(id);

        if (stored === undefined) {
          return Option.none<Schemas.ContactList>();
        }

        const renamed = { ...stored.list, name };

        lists.set(id, { list: renamed, membershipVersion: stored.membershipVersion });

        return Option.some(renamed);
      }),
    deleteList: (id) =>
      Effect.sync(() => {
        writes.push("deleteList");

        if (!lists.delete(id)) {
          return "list-missing" as const;
        }

        members.delete(id);

        return "deleted" as const;
      }),
    listMembers: (listId, limit) =>
      Effect.sync(() => {
        reads.push("listMembers");

        if (!lists.has(listId)) {
          return Option.none<{
            readonly items: ReadonlyArray<Schemas.Contact>;
            readonly nextCursor: string | undefined;
          }>();
        }

        const joined: Array<Schemas.Contact> = [];

        for (const id of (members.get(listId) ?? []).slice(0, limit)) {
          const contact = contacts.get(id);

          if (contact !== undefined) {
            joined.push(contact);
          }
        }

        return Option.some({ items: joined, nextCursor: undefined });
      }),
    removeMember: (listId, contactId) =>
      Effect.sync(() => {
        writes.push("removeMember");

        const stored = lists.get(listId);

        if (stored === undefined) {
          return "list-missing" as const;
        }

        members.set(
          listId,
          (members.get(listId) ?? []).filter((id) => id !== contactId),
        );
        lists.set(listId, { list: stored.list, membershipVersion: stored.membershipVersion + 1 });

        return "removed" as const;
      }),
    importContacts: (listId, candidates, addedAt) =>
      Effect.sync(() => {
        writes.push("importContacts");

        const stored = lists.get(listId);

        if (stored === undefined) {
          return { outcome: "list-missing" as const };
        }

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
        lists.set(listId, { list: stored.list, membershipVersion: stored.membershipVersion + 1 });

        return { outcome: "imported" as const, contacts: imported };
      }),
    addMember: (listId, contactId) =>
      Effect.sync(() => {
        writes.push("addMember");

        if (!contacts.has(contactId)) {
          return "contact-missing" as const;
        }

        const stored = lists.get(listId);

        if (stored === undefined) {
          return "list-missing" as const;
        }

        const current = members.get(listId) ?? [];

        if (current.includes(contactId)) {
          return "already-member" as const;
        }

        members.set(listId, [...current, contactId]);
        lists.set(listId, { list: stored.list, membershipVersion: stored.membershipVersion + 1 });

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
    ...unusedCampaignStore,
    createCampaign: (campaign) =>
      Effect.sync(() => {
        writes.push("createCampaign");
        campaigns.set(campaign.id, { ...campaign, submission: { state: "draft" } });
      }),
    getCampaign: (id) =>
      Effect.sync(() => {
        reads.push("getCampaign");

        return Option.fromUndefinedOr(campaigns.get(id));
      }),
    listCampaigns: (limit) =>
      Effect.sync(() => {
        reads.push("listCampaigns");

        const page = [...campaigns.values()].slice(0, limit);

        return { items: page, nextCursor: undefined };
      }),
    getCampaignControl: (id) =>
      Effect.gen(function* () {
        reads.push("getCampaignControl");

        if (controlFailure !== undefined) {
          return yield* controlFailure;
        }

        const campaign = campaigns.get(id);

        if (campaign === undefined) {
          return Option.none();
        }

        const submission = campaign.submission;

        return Option.some({
          state: submission.state,
          runToken: runTokens.get(id),
          startedAt:
            startedAtById.get(id) ?? ("startedAt" in submission ? submission.startedAt : undefined),
          pausedReason: submission.state === "paused" ? submission.reason : undefined,
        });
      }),
    enqueueCampaign: (id, expected, newToken, now) =>
      Effect.sync(() => {
        writes.push("enqueueCampaign");

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
    scheduleCampaign: (id, expected, newToken, sendAt) =>
      Effect.sync(() => {
        writes.push("scheduleCampaign");

        const campaign = campaigns.get(id);

        if (
          campaign === undefined ||
          campaign.submission.state !== expected.state ||
          runTokens.get(id) !== expected.runToken
        ) {
          return "conflict" as const;
        }

        campaigns.set(id, { ...campaign, submission: { state: "scheduled", sendAt } });
        runTokens.set(id, newToken);

        return "scheduled" as const;
      }),
    cancelCampaign: (id, source) =>
      Effect.sync(() => {
        writes.push("cancelCampaign");
        pendingWrite?.();
        pendingWrite = undefined;

        const campaign = campaigns.get(id);

        if (
          campaign === undefined ||
          campaign.submission.state !== source.state ||
          runTokens.get(id) !== source.runToken
        ) {
          return "conflict" as const;
        }

        if (source.state === "scheduled") {
          campaigns.set(id, { ...campaign, submission: { state: "draft" } });

          return "applied" as const;
        }

        const started =
          startedAtById.get(id) !== undefined ||
          ("startedAt" in campaign.submission && campaign.submission.startedAt !== undefined);

        if (started !== source.started) {
          return "conflict" as const;
        }

        if (!started) {
          campaigns.set(id, { ...campaign, submission: { state: "draft" } });

          return "applied" as const;
        }

        const recorded = history.get(id);

        if (recorded === undefined) {
          return "conflict" as const;
        }

        campaigns.set(id, {
          ...campaign,
          submission: {
            state: "paused",
            queuedAt: recorded.queuedAt,
            startedAt: recorded.startedAt,
            progress: recorded.progress,
            feedback: recorded.feedback,
            reason: "manual",
          },
        });

        return "applied" as const;
      }),
    resumeCampaign: (id, expected, newToken, now) =>
      Effect.sync(() => {
        writes.push("resumeCampaign");

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
    remove: (_runToken) =>
      Effect.sync(() => {
        sequence.push("removeSchedule");
      }),
  });

  const rememberHistory = (campaign: Schemas.Campaign) => {
    const submission = campaign.submission;

    if (
      submission.state === "paused" ||
      submission.state === "sending" ||
      submission.state === "completed"
    ) {
      startedAtById.set(campaign.id, submission.startedAt);
      history.set(campaign.id, {
        queuedAt: submission.queuedAt,
        startedAt: submission.startedAt,
        progress: submission.progress,
        feedback: submission.feedback,
      });
    }
  };

  const setCampaign = (campaign: Schemas.Campaign, runToken?: string) => {
    campaigns.set(campaign.id, campaign);

    if (runToken !== undefined) {
      runTokens.set(campaign.id, runToken);
    }

    rememberHistory(campaign);
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
    layer: Layer.mergeAll(audience, campaignStore, wake, schedule, accountSuppression),
    reads,
    writes,
    sequence,
    sesRequests,
    wakes,
    setCampaign,
    beforeWrite: (action: () => void) => {
      pendingWrite = action;
    },
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
        JSON.stringify({ email: " MAX@Example.COM ", name: " Max " }),
        authorized(),
      ),
    )
      .then((response) => {
        expect(response.status).toBe(201);

        return response.json();
      })
      .then((body) => {
        expect(body).toMatchObject({ email: "MAX@example.com", name: "Max" });
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

  it("answers 503 with a typed body when the dispatch wake fails", () => {
    const store = inMemory(true);
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

        const list = yield* client.lists.create({ payload: { name: "Readers" } });

        const campaign = yield* client.campaigns.create({
          payload: { listId: list.id, subject: "Release notes", text: "Hello" },
        });

        const attempt = yield* Effect.result(
          client.campaigns.send({ params: { id: campaign.id } }),
        );

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
      ),
    );
  });

  it("answers 404 with a typed body when cancelling a campaign that does not exist", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );
  });

  it("answers 503 with a typed body when cancelling cannot read campaign control", () => {
    const store = inMemory();
    const handler = webHandler(store);

    store.failControl();

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );
  });

  it.each(["2099-13-01T00:00:00.000Z", "2099-02-29T09:00:00.000Z"])(
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

      return Effect.runPromise(
        Effect.gen(function* () {
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

          expect(yield* campaigns.getCampaign(knownId)).toStrictEqual(Option.some(campaign));
          expect(yield* campaigns.getCampaignControl(knownId)).toStrictEqual(
            Option.some({
              state: "scheduled",
              runToken,
              startedAt: undefined,
              pausedReason: undefined,
            }),
          );
        }).pipe(Effect.provide(store.layer)),
      );
    },
  );

  it("answers 409 with a typed body when sendAt is not in the future", () => {
    const store = inMemory();
    const handler = webHandler(store);
    const sendAt = "2026-09-11T10:00:01.000Z";

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
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

  it("answers a native event with a native result", () =>
    Effect.runPromise(
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
    ));

  it("keeps the challenge on a native unauthorized result", () =>
    Effect.runPromise(
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
    ));
});

describe("generated client round trip", () => {
  it("runs the whole flow from contact to a queued campaign without a mailer", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

        const contact = yield* client.contacts.create({
          payload: { email: allowedRecipient, name: "Max" },
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
      ),
    );
  });

  it("returns the same html from GET after creating a campaign with html", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );
  });

  it("returns the same filter from GET after creating a campaign with a filter", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );
  });

  it("resumes a paused campaign onto the same queued contract", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

        const list = yield* client.lists.create({ payload: { name: "Readers" } });

        const campaign = yield* client.campaigns.create({
          payload: { listId: list.id, subject: "Release notes", text: "Hello" },
        });

        store.setCampaign(
          {
            ...campaign,
            submission: {
              state: "paused",
              queuedAt: campaign.createdAt,
              startedAt: campaign.createdAt,
              progress: { accepted: 0, rejected: 0, uncertain: 0, skipped: 0 },
              feedback: { bounced: 0, complained: 0 },
              reason: "rate-limited",
            },
          },
          "0195f0a0-1111-4222-8333-44444444e5d2",
        );

        const resumed = yield* client.campaigns.resume({ params: { id: campaign.id } });

        expect(resumed.submission.state).toBe("queued");
        expect(store.wakes).toHaveLength(1);
        expect(store.wakes[0]?.campaignId).toBe(campaign.id);
        expect(store.wakes[0]?.runToken).not.toBe("0195f0a0-1111-4222-8333-44444444e5d2");

        // A repeated resume on the now queued campaign changes nothing but re-sends the wake-up
        // under the same run token: that is the repair for a lost enqueue or a lost response.
        const repeated = yield* client.campaigns.resume({ params: { id: campaign.id } });

        expect(repeated.submission).toStrictEqual(resumed.submission);
        expect(store.wakes).toHaveLength(2);
        expect(store.wakes[1]?.runToken).toBe(store.wakes[0]?.runToken);
      }).pipe(
        Effect.provide(
          Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
        ),
      ),
    );
  });

  it("schedules a draft for a future instant", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

        const list = yield* client.lists.create({ payload: { name: "Readers" } });

        const campaign = yield* client.campaigns.create({
          payload: { listId: list.id, subject: "Release notes", text: "Hello" },
        });

        const sendAt = "2099-01-01T00:00:00.000Z";

        const scheduled = yield* client.campaigns.schedule({
          params: { id: campaign.id },
          payload: { sendAt },
        });

        expect(scheduled.submission).toStrictEqual({ state: "scheduled", sendAt });
      }).pipe(
        Effect.provide(
          Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
        ),
      ),
    );
  });

  it("cancels a scheduled campaign back to draft", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

        const list = yield* client.lists.create({ payload: { name: "Readers" } });

        const campaign = yield* client.campaigns.create({
          payload: { listId: list.id, subject: "Release notes", text: "Hello" },
        });

        store.setCampaign(
          {
            ...campaign,
            submission: { state: "scheduled", sendAt: "2099-01-01T00:00:00.000Z" },
          },
          "0195f0a0-1111-4222-8333-44444444e5d2",
        );

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
      ),
    );
  });

  it("cancels a never-started queued campaign back to draft", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );
  });

  it("cancels a queued resume to paused with reason manual and keeps history", () => {
    const store = inMemory();
    const handler = webHandler(store);
    const runToken = "0195f0a0-1111-4222-8333-44444444e5d2";
    const queuedAt = "2026-09-11T10:00:01.000Z";
    const startedAt = "2026-09-11T10:00:02.000Z";
    const progress = { accepted: 2, rejected: 1, uncertain: 0, skipped: 3 };
    const feedback = { bounced: 1, complained: 0 };

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

        const list = yield* client.lists.create({ payload: { name: "Readers" } });

        const campaign = yield* client.campaigns.create({
          payload: { listId: list.id, subject: "Release notes", text: "Hello" },
        });

        store.setCampaign(
          {
            ...campaign,
            submission: {
              state: "paused",
              queuedAt,
              startedAt,
              progress,
              feedback,
              reason: "rate-limited",
            },
          },
          runToken,
        );
        store.setCampaign({ ...campaign, submission: { state: "queued", queuedAt } }, runToken);

        const cancelled = yield* client.campaigns.cancel({ params: { id: campaign.id } });

        expect(cancelled.submission).toStrictEqual({
          state: "paused",
          queuedAt,
          startedAt,
          progress,
          feedback,
          reason: "manual",
        });
        expect(cancelled).not.toHaveProperty("runToken");

        const response = yield* Effect.promise(() => handler(cancelRequest(campaign.id)));

        expect(response.status).toBe(200);

        const body = yield* Effect.promise(() => response.text());

        expect(body).not.toContain("runToken");
        expect((yield* campaignFromJson(body)).submission).toStrictEqual(cancelled.submission);
      }).pipe(
        Effect.provide(
          Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
        ),
      ),
    );
  });

  it.each([
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
  ] as const)("answers 409 without mutating a %s campaign", (_label, submission) => {
    const store = inMemory();
    const handler = webHandler(store);
    const runToken = "0195f0a0-1111-4222-8333-44444444e5d2";

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
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
          new Schemas.CampaignCancellationConflict({ state: submission.state }),
        );

        const response = yield* Effect.promise(() => handler(cancelRequest(campaign.id)));

        expect(response.status).toBe(409);

        const body = yield* Effect.promise(() => response.text());

        expect(body).toContain('"CampaignCancellationConflict"');
        expect(body).toContain(`"state":"${submission.state}"`);
        expect(body).not.toContain("runToken");
        expect(store.writes).not.toContain("cancelCampaign");
        expect(store.sequence).not.toContain("removeSchedule");

        const fetched = yield* client.campaigns.get({ params: { id: campaign.id } });

        expect(fetched).toStrictEqual(current);
      }).pipe(
        Effect.provide(
          Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
        ),
      ),
    );
  });

  it("answers 409 when cancel loses to a replacement paused generation", () => {
    const store = inMemory();
    const handler = webHandler(store);
    const scheduledToken = "0195f0a0-1111-4222-8333-44444444e5d2";
    const replacementToken = "0195f0a0-1111-4222-8333-44444444e5d3";
    const queuedAt = "2026-09-11T10:00:01.000Z";
    const startedAt = "2026-09-11T10:00:02.000Z";

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

        const list = yield* client.lists.create({ payload: { name: "Readers" } });

        const campaign = yield* client.campaigns.create({
          payload: { listId: list.id, subject: "Release notes", text: "Hello" },
        });

        const scheduled: Schemas.Campaign = {
          ...campaign,
          submission: { state: "scheduled", sendAt: "2099-01-01T00:00:00.000Z" },
        };

        const replacement: Schemas.Campaign = {
          ...campaign,
          submission: {
            state: "paused",
            queuedAt,
            startedAt,
            progress: { accepted: 2, rejected: 0, uncertain: 0, skipped: 0 },
            feedback: { bounced: 0, complained: 0 },
            reason: "rate-limited",
          },
        };

        const loseToReplacement = () => {
          store.setCampaign(scheduled, scheduledToken);
          store.beforeWrite(() => {
            store.setCampaign(replacement, replacementToken);
          });
        };

        loseToReplacement();

        const attempt = yield* Effect.result(
          client.campaigns.cancel({ params: { id: campaign.id } }),
        );

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toStrictEqual(
          new Schemas.CampaignCancellationConflict({ state: "paused" }),
        );
        expect(store.sequence).not.toContain("removeSchedule");

        const fetched = yield* client.campaigns.get({ params: { id: campaign.id } });

        expect(fetched).toStrictEqual(replacement);

        loseToReplacement();

        const response = yield* Effect.promise(() => handler(cancelRequest(campaign.id)));

        expect(response.status).toBe(409);

        const body = yield* Effect.promise(() => response.text());

        expect(body).toContain('"CampaignCancellationConflict"');
        expect(body).toContain('"state":"paused"');
        expect(body).not.toContain("runToken");
        expect(store.sequence).not.toContain("removeSchedule");
      }).pipe(
        Effect.provide(
          Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
        ),
      ),
    );
  });

  it("surfaces a public error from the service as a typed client failure", () => {
    const store = inMemory();
    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeEmailerClient(baseUrl, Redacted.make(token));

        const attempt = yield* Effect.result(client.contacts.get({ params: { id: knownId } }));

        expect(Result.isFailure(attempt) ? attempt.failure : undefined).toBeInstanceOf(
          Schemas.NotFound,
        );
      }).pipe(
        Effect.provide(
          Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
        ),
      ),
    );
  });
});

const clientOver = (store: Store) => {
  const handler = webHandler(store);

  const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

  return <A, E>(use: (client: EmailerClient) => Effect.Effect<A, E, never>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* makeEmailerClient(baseUrl, Redacted.make(token)));
      }).pipe(
        Effect.provide(
          Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport)),
        ),
      ),
    );
};

describe("contact management", () => {
  it("refuses a second contact on an address another one already holds", () => {
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

  it("finds a contact by an address written in a different case", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const created = yield* client.contacts.create({ payload: { email: "Max@example.com" } });

        const found = yield* client.contacts.getByEmail({ query: { email: "MAX@EXAMPLE.COM" } });

        expect(found.id).toBe(created.id);
      }),
    );
  });

  it("carries attributes through creation, listing and an update that replaces them", () => {
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

  it("removes a contact and then reports it as gone", () => {
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

  it("refuses an update onto an address another contact holds", () => {
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

  it("refuses to move a contact off an address that opted out", () => {
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
  it("renames a list and answers with the list as it now stands", () => {
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

  it("tells a list with no members apart from a list that is not there", () => {
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

  it("answers a bulk import with converged state, identically on a re-run", () => {
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

  it("removes a member, leaving the contact itself alone", () => {
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

  it("deletes a list and then reports it as gone", () => {
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

  it("refuses an import naming one address twice, without touching storage", () => {
    const store = inMemory();

    return clientOver(store)((client) => client.lists.create({ payload: { name: "Weekly" } })).then(
      (created) => {
        store.writes.length = 0;

        return webHandler(store)(
          jsonRequest(
            `/lists/${created.id}/contacts`,
            "POST",
            JSON.stringify({
              contacts: [{ email: "Max@example.com" }, { email: "max@EXAMPLE.com" }],
            }),
            authorized(),
          ),
        ).then((response) => {
          expect(response.status).toBe(400);
          expect(store.writes).toHaveLength(0);
        });
      },
    );
  });
});

describe("campaign listing", () => {
  it("returns created campaigns as summaries without the body and honours limit", () => {
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
        expect(page.items[0]).not.toHaveProperty("text");
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

  it("refuses a wrong credential after accepting a right one on the same application", () => {
    const store = inMemory();
    const handler = webHandler(store);

    return handler(new Request(`${baseUrl}/contacts`, { headers: authorized() }))
      .then((first) => {
        expect(first.status).toBe(200);

        return handler(
          new Request(`${baseUrl}/contacts`, {
            headers: { authorization: "Bearer 3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXZ" },
          }),
        );
      })
      .then((second) => {
        expect(second.status).toBe(401);
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

  it("returns the local record with a null account entry when SES has none", () => {
    const store = inMemory();

    return clientOver(store)((client) =>
      Effect.gen(function* () {
        const record = yield* client.addresses.status({ query: { email: allowedRecipient } });

        expect(record).toStrictEqual(mailable);
        expect(store.sequence).toStrictEqual(["addressRecord", "getSuppressedDestination"]);
      }),
    );
  });

  it("maps a present account entry to its reason and an ISO timestamp", () => {
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

  it("passes the address to SES exactly as given and reports it back unchanged", () => {
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

  it("clears the local rows when SES has no entry to delete", () => {
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

  it("answers 503 naming the delete when SES refuses it for another reason", () => {
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

  it("answers 503 with a typed body when the suppression lookup fails for another reason", () => {
    const store = inMemory();

    store.failSesGet(new sesv2.TooManyRequestsException({ message: "slow" }));

    const handler = webHandler(store);

    const transport: typeof globalThis.fetch = (input, init) => handler(new Request(input, init));

    return Effect.runPromise(
      Effect.gen(function* () {
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
      ),
    );
  });

  it("deletes the account entry before the local rows and returns the refreshed record", () => {
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
  });

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
