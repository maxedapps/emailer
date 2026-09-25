import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { makeEmailerClient } from "@emailer/api/Client";
import type { EmailerClient } from "@emailer/api/Client";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import {
  Clock,
  ConfigProvider,
  Duration,
  Effect,
  Inspectable,
  Layer,
  Logger,
  Option,
  Redacted,
  Result,
  Schema,
  Scope,
} from "effect";
import { FetchHttpClient, HttpEffect } from "effect/unstable/http";

import { makeApiHandler } from "./Api.ts";
import { AccountSuppression } from "../audience/Addresses.ts";
import { CampaignSchedule } from "../campaigns/CampaignSchedule.ts";
import { verifyPreviewToken } from "../campaigns/Previews.ts";
import { ReportingLive } from "../Reporting.ts";
import { CampaignWake } from "../sending/Dispatch.ts";
import { Mailer } from "../sending/Mailer.ts";
import { SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { unusedAudience, unusedCampaigns } from "../storage/Testing.ts";

import type { AudienceOperations } from "../storage/Audience.ts";
import type { CampaignControl, CampaignStoreOperations } from "../storage/Campaigns.ts";

/**
 * The HTTP layer: routing, decoding, authorization, encoding and the mapping of every error to its
 * status. What each operation does is its own module's suite; here every service is a stub that
 * answers one case, and one that a test does not state dies if reached.
 */

const token = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

const otherToken = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp_Oo-NnMmLlK";

const baseUrl = "http://emailer.test";

const email = "sam@example.com";

const contactId = "0195f0a0-1111-4222-8333-44444444c001";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const runToken = "0195f0a0-1111-4222-8333-44444444e5d2";

const createdAt = "2026-09-11T10:00:00.000Z";

const previewKey = "5d41402abc4b2a76b9719d911017c5925d41402abc4b2a76b9719d911017c592";

const contact: Schemas.Contact = { id: contactId, email, createdAt };

const list: Schemas.ContactList = { id: listId, name: "Readers", createdAt };

const campaign: Schemas.Campaign = {
  id: campaignId,
  listId,
  subject: "Release notes",
  text: "Hello",
  createdAt,
  submission: { state: "draft" },
};

const draft: CampaignControl = { state: "draft" };

const record = {
  email,
  status: "mailable" as const,
  transientBounces: [],
  accountSuppression: null,
};

const notExercised = (operation: string) => () =>
  Effect.die(new Error(`${operation} is not exercised by this test`));

/** Answers `value` and records the arguments of every call. */
const recording =
  <A>(calls: Array<ReadonlyArray<unknown>>, value: A) =>
  (...args: ReadonlyArray<unknown>) =>
    Effect.sync(() => {
      calls.push(args);

      return value;
    });

interface Stubs {
  readonly audience?: Partial<AudienceOperations>;
  readonly campaigns?: Partial<CampaignStoreOperations>;
  readonly suppression?: Partial<AccountSuppression["Service"]>;
  readonly wake?: CampaignWake["Service"];
  readonly schedule?: CampaignSchedule["Service"];
  readonly mailer?: Mailer["Service"];
  readonly guard?: SendGuard["Service"];
}

/** Every service the API uses, as the deployed function composes them, from the stubs. */
const servicesFor = (stubs: Stubs) =>
  Layer.mergeAll(
    Layer.succeed(AudienceStore)({ ...unusedAudience, ...stubs.audience }),
    Layer.succeed(CampaignStore)({ ...unusedCampaigns, ...stubs.campaigns }),
    Layer.succeed(AccountSuppression)({
      getSuppressedDestination: notExercised("AccountSuppression.getSuppressedDestination"),
      deleteSuppressedDestination: notExercised("AccountSuppression.deleteSuppressedDestination"),
      ...stubs.suppression,
    }),
    Layer.succeed(CampaignWake)(stubs.wake ?? { enqueue: notExercised("CampaignWake.enqueue") }),
    Layer.succeed(CampaignSchedule)(
      stubs.schedule ?? { create: notExercised("CampaignSchedule.create") },
    ),
    Layer.succeed(Mailer)(stubs.mailer ?? { send: notExercised("Mailer.send") }),
    Layer.succeed(SendGuard)(
      stubs.guard ?? {
        current: Effect.die(new Error("SendGuard.current is not exercised by this test")),
        slot: notExercised("SendGuard.slot"),
      },
    ),
    Layer.succeed(ConfigProvider.ConfigProvider)(
      ConfigProvider.fromEnvRecord({
        EMAILER_UNSUBSCRIBE_URL: "https://unsubscribe.example/",
        EMAILER_UNSUBSCRIBE_SECRET:
          "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718293a4b5c6d7e8f90",
        EMAILER_PREVIEW_URL: "https://preview.example/",
        EMAILER_PREVIEW_SECRET: previewKey,
      }),
    ),
    NodeCrypto.layer,
    ReportingLive,
  );

/**
 * The application built once, as the deployed function builds it, and then asked to answer many
 * requests: a suite that rebuilt per request could not see anything leaking between them. Every
 * line the reporter logs is kept, rendered whole, so a leaked value would show.
 */
const api = (stubs: Stubs = {}) => {
  const lines: Array<string> = [];

  const logger = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      lines.push(`${logLevel} ${Inspectable.toStringUnknown(message)}`);
    }),
  ]);

  const handle = Effect.runSync(
    Layer.build(Layer.mergeAll(servicesFor(stubs), logger)).pipe(
      Effect.flatMap((services) =>
        makeApiHandler(Redacted.make(token)).pipe(
          Effect.provideContext(services),
          Effect.map((built) => Effect.provideContext(built, services)),
        ),
      ),
      Effect.provideService(Scope.Scope, Scope.makeUnsafe()),
    ),
  );

  const fetch = HttpEffect.toWebHandler(handle);

  /** Runs the generated client against the application. */
  const call = <A, E>(use: (client: EmailerClient) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      return yield* use(yield* makeEmailerClient(baseUrl, Redacted.make(token)));
    }).pipe(
      Effect.provide(
        Layer.provide(
          FetchHttpClient.layer,
          Layer.succeed(FetchHttpClient.Fetch)((input, init) => fetch(new Request(input, init))),
        ),
      ),
    );

  /** A raw request, for what the client cannot show: status codes, headers and bodies. */
  const respond = (request: Request) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => fetch(request));

      return {
        status: response.status,
        headers: response.headers,
        body: yield* Effect.promise(() => response.text()),
      };
    });

  return { handle, fetch, call, respond, lines };
};

const authorized = (extra: Readonly<Record<string, string>> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

const get = (path: string, headers: Readonly<Record<string, string>> = authorized()) =>
  new Request(`${baseUrl}${path}`, { headers });

/** A JSON request, its body written out, so a malformed one can be sent as well. */
const send = (
  method: string,
  path: string,
  body: string,
  headers: Readonly<Record<string, string>> = authorized(),
) =>
  new Request(`${baseUrl}${path}`, {
    method,
    body,
    headers: { "content-type": "application/json", ...headers },
  });

describe("contacts", () => {
  it.effect("creates a contact from the normalized payload and answers it with 201", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];
      const { call, respond } = api({ audience: { createContact: recording(calls, undefined) } });

      const created = yield* call((client) =>
        client.contacts.create({ payload: { email: "SAM@Example.COM", name: " Sam " } }),
      );

      expect(created).toMatchObject({ email: "SAM@example.com", name: "Sam" });
      expect(calls).toStrictEqual([[created]]);
      expect((yield* respond(send("POST", "/contacts", `{"email":"${email}"}`))).status).toBe(201);
    }),
  );

  it.effect("lists a page, passing the default page size and the cursor", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];
      const cursor = `${createdAt}#${contactId}`;

      const { call } = api({
        audience: { listContacts: recording(calls, { items: [contact], nextCursor: cursor }) },
      });

      const page = yield* call((client) => client.contacts.list({ query: {} }));
      yield* call((client) => client.contacts.list({ query: { limit: 7, cursor } }));

      expect(page).toStrictEqual({ items: [contact], nextCursor: cursor });
      expect(calls).toStrictEqual([
        [25, undefined],
        [7, cursor],
      ]);
    }),
  );

  // `/contacts/by-email` is a static segment, so it is a lookup rather than an identifier.
  it.effect("finds a contact by address", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];
      const { call } = api({ audience: { getContactByEmail: recording(calls, contact) } });

      const found = yield* call((client) =>
        client.contacts.getByEmail({ query: { email: "Sam@EXAMPLE.com" } }),
      );

      expect(found).toStrictEqual(contact);
      expect(calls).toStrictEqual([["Sam@example.com"]]);
    }),
  );

  it.effect("gets, updates and removes a contact by its identifier", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];
      const renamed = { ...contact, name: "Sam" };

      const { call, respond } = api({
        audience: {
          getContact: recording(calls, contact),
          updateContact: recording(calls, renamed),
          deleteContact: recording(calls, undefined),
        },
      });

      expect(
        yield* call((client) => client.contacts.get({ params: { id: contactId } })),
      ).toStrictEqual(contact);
      expect(
        yield* call((client) =>
          client.contacts.update({ params: { id: contactId }, payload: { name: "Sam" } }),
        ),
      ).toStrictEqual(renamed);
      expect(
        (yield* respond(
          new Request(`${baseUrl}/contacts/${contactId}`, {
            method: "DELETE",
            headers: authorized(),
          }),
        )).status,
      ).toBe(204);
      expect(calls).toStrictEqual([[contactId], [contactId, { name: "Sam" }], [contactId]]);
    }),
  );
});

describe("lists", () => {
  it.effect("creates, gets, lists, renames and removes a list", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];
      const renamed = { ...list, name: "Monthly" };

      const { call } = api({
        audience: {
          createList: recording(calls, undefined),
          getList: recording(calls, list),
          listLists: recording(calls, { items: [list] }),
          renameList: recording(calls, renamed),
          deleteList: recording(calls, undefined),
        },
      });

      const created = yield* call((client) =>
        client.lists.create({ payload: { name: " Weekly " } }),
      );

      expect(created.name).toBe("Weekly");
      expect(yield* call((client) => client.lists.get({ params: { id: listId } }))).toStrictEqual(
        list,
      );
      expect(yield* call((client) => client.lists.list({ query: {} }))).toStrictEqual({
        items: [list],
      });
      expect(
        yield* call((client) =>
          client.lists.update({ params: { id: listId }, payload: { name: "Monthly" } }),
        ),
      ).toStrictEqual(renamed);
      yield* call((client) => client.lists.remove({ params: { id: listId } }));

      expect(calls).toStrictEqual([
        [created],
        [listId],
        [25, undefined],
        [listId, "Monthly"],
        [listId],
      ]);
    }),
  );

  it.effect("lists, adds and removes members, and imports contacts", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];
      const imported = { contacts: [{ email, contactId, member: true }] };

      const { call } = api({
        audience: {
          listMembers: recording(calls, { items: [contact], nextCursor: contactId }),
          addMember: recording(calls, undefined),
          removeMember: recording(calls, undefined),
          importContacts: recording(calls, imported),
        },
      });

      expect(
        yield* call((client) =>
          client.lists.listMembers({ params: { listId }, query: { cursor: contactId } }),
        ),
      ).toStrictEqual({ items: [contact], nextCursor: contactId });
      yield* call((client) => client.lists.addContact({ params: { listId, contactId } }));
      yield* call((client) => client.lists.removeContact({ params: { listId, contactId } }));
      expect(
        yield* call((client) =>
          client.lists.import({ params: { listId }, payload: { contacts: [{ email }] } }),
        ),
      ).toStrictEqual(imported);

      expect(calls[0]).toStrictEqual([listId, 25, contactId]);
      expect(calls[1]?.slice(0, 2)).toStrictEqual([listId, contactId]);
      expect(calls[2]).toStrictEqual([listId, contactId]);
      expect(calls[3]?.[0]).toBe(listId);
    }),
  );
});

describe("campaigns", () => {
  it.effect("creates a draft on a list that exists and answers it with 201", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];

      const { call } = api({
        audience: { getList: recording(calls, list) },
        campaigns: { createCampaign: recording(calls, undefined) },
      });

      const created = yield* call((client) =>
        client.campaigns.create({
          payload: { listId, subject: "Release notes", text: "Hello", filter: { plan: "pro" } },
        }),
      );

      expect(created).toMatchObject({
        listId,
        subject: "Release notes",
        filter: { plan: "pro" },
        submission: { state: "draft" },
      });
      expect(calls).toStrictEqual([[listId], [created]]);
    }),
  );

  it.effect("lists summaries and gets a whole campaign", () =>
    Effect.gen(function* () {
      const { text: _text, ...summary } = campaign;

      const { call } = api({
        campaigns: {
          listCampaigns: () => Effect.succeed({ items: [summary] }),
          getCampaign: () => Effect.succeed(campaign),
        },
      });

      expect(yield* call((client) => client.campaigns.list({ query: {} }))).toStrictEqual({
        items: [summary],
      });
      expect(
        yield* call((client) => client.campaigns.get({ params: { id: campaignId } })),
      ).toStrictEqual(campaign);
    }),
  );

  it.effect("edits a draft and deletes one", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];

      const { call } = api({
        campaigns: {
          getCampaign: () => Effect.succeed(campaign),
          getCampaignControl: () => Effect.succeed(draft),
          updateDraft: recording(calls, undefined),
          deleteDraft: recording(calls, undefined),
        },
      });

      const edited = yield* call((client) =>
        client.campaigns.update({ params: { id: campaignId }, payload: { subject: "New" } }),
      );

      yield* call((client) => client.campaigns.remove({ params: { id: campaignId } }));

      expect(edited).toStrictEqual({ ...campaign, subject: "New" });
      expect(calls).toStrictEqual([[edited], [campaignId]]);
    }),
  );

  it.effect("sends a test copy and reports each recipient's outcome", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];

      const { call } = api({
        audience: { addressStatus: () => Effect.succeed("mailable" as const) },
        campaigns: { getCampaign: () => Effect.succeed(campaign) },
        guard: {
          current: Effect.succeed({ limit: 14 }),
          slot: () => Effect.succeed(Duration.zero),
        },
        mailer: {
          send: (recipient) =>
            Effect.sync(() => {
              sent.push(recipient);

              return `message-${sent.length}`;
            }),
        },
      });

      const result = yield* call((client) =>
        client.campaigns.test({ params: { id: campaignId }, payload: { to: [email] } }),
      );

      expect(result).toStrictEqual({
        recipients: [{ email, outcome: "accepted", messageId: "message-1" }],
      });
      expect(sent).toStrictEqual([email]);
    }),
  );

  // Live: the server mints the expiry on the real clock, so "now" here must be the real clock too.
  it.live("links to a preview that names the campaign, reading only its control item", () =>
    Effect.gen(function* () {
      const { call } = api({
        campaigns: { getCampaignControl: () => Effect.succeed(draft) },
      });

      const link = yield* call((client) =>
        client.campaigns.preview({ params: { id: campaignId } }),
      );

      const previewToken = link.url.replace("https://preview.example/previews/", "");

      expect(link.url.startsWith("https://preview.example/previews/v1.")).toBe(true);
      expect(
        verifyPreviewToken(
          Redacted.make(previewKey),
          previewToken,
          Math.floor((yield* Clock.currentTimeMillis) / 1000),
        ),
      ).toStrictEqual(Option.some(campaignId));
    }),
  );

  it.effect.each([
    ["send", draft],
    [
      "resume",
      { state: "paused", runToken, startedAt: createdAt, pausedReason: "manual" } as const,
    ],
  ] as const)("%ss by starting a queued run and waking it", ([command, control]) =>
    Effect.gen(function* () {
      const wakes: Array<ReadonlyArray<unknown>> = [];
      const runs: Array<ReadonlyArray<unknown>> = [];

      const queued: Schemas.Campaign = {
        ...campaign,
        submission: { state: "queued", queuedAt: createdAt },
      };

      const { call } = api({
        campaigns: {
          getCampaignControl: () => Effect.succeed(control),
          newRun: recording(runs, undefined),
          getCampaign: () => Effect.succeed(queued),
        },
        wake: { enqueue: recording(wakes, undefined) },
      });

      const answered = yield* call((client) =>
        client.campaigns[command]({ params: { id: campaignId } }),
      );

      expect(answered).toStrictEqual(queued);
      expect(runs[0]?.slice(0, 2)).toStrictEqual([
        campaignId,
        { state: control.state, runToken: control.runToken },
      ]);
      expect(wakes).toStrictEqual([[campaignId, runs[0]?.[2]]]);
    }),
  );

  it.effect("schedules a run under a new token for the requested instant", () =>
    Effect.gen(function* () {
      const schedules: Array<ReadonlyArray<unknown>> = [];
      const runs: Array<ReadonlyArray<unknown>> = [];
      const sendAt = "2099-06-01T09:00:00.000Z";

      const { call } = api({
        campaigns: {
          getCampaignControl: () => Effect.succeed(draft),
          newRun: recording(runs, undefined),
          getCampaign: () => Effect.succeed(campaign),
        },
        schedule: { create: recording(schedules, undefined) },
      });

      yield* call((client) =>
        client.campaigns.schedule({ params: { id: campaignId }, payload: { sendAt } }),
      );

      expect(schedules).toStrictEqual([[campaignId, runs[0]?.[2], sendAt]]);
    }),
  );

  it.effect("cancels a scheduled run", () =>
    Effect.gen(function* () {
      const cancels: Array<ReadonlyArray<unknown>> = [];

      const { call } = api({
        campaigns: {
          getCampaignControl: () => Effect.succeed({ state: "scheduled", runToken } as const),
          cancelCampaign: recording(cancels, undefined),
          getCampaign: () => Effect.succeed(campaign),
        },
      });

      expect(
        yield* call((client) => client.campaigns.cancel({ params: { id: campaignId } })),
      ).toStrictEqual(campaign);
      expect(cancels).toStrictEqual([[campaignId, { state: "scheduled", runToken }]]);
    }),
  );
});

describe("addresses", () => {
  it.effect("reports an address's status and unsuppresses it", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<unknown>> = [];
      const notListed = Effect.fail(new sesv2.NotFoundException({ message: "not listed" }));

      const { call } = api({
        audience: {
          addressRecord: recording(calls, record),
          unsuppress: recording(calls, undefined),
        },
        suppression: {
          getSuppressedDestination: () => notListed,
          deleteSuppressedDestination: () => notListed,
        },
      });

      expect(yield* call((client) => client.addresses.status({ query: { email } }))).toStrictEqual(
        record,
      );
      expect(
        yield* call((client) => client.addresses.unsuppress({ payload: { email } })),
      ).toStrictEqual(record);
      expect(calls).toStrictEqual([[email], [email], [email]]);
    }),
  );
});

describe("public errors", () => {
  const conflict = { state: "sending", runToken, startedAt: createdAt } as const;

  const cases = [
    {
      error: "ContactNotFound",
      status: 404,
      request: () => get(`/contacts/${contactId}`),
      stubs: { audience: { getContact: () => Effect.fail(new Errors.ContactNotFound()) } },
    },
    {
      error: "ListNotFound",
      status: 404,
      request: () => get(`/lists/${listId}`),
      stubs: { audience: { getList: () => Effect.fail(new Errors.ListNotFound()) } },
    },
    {
      error: "CampaignNotFound",
      status: 404,
      request: () => get(`/campaigns/${campaignId}`),
      stubs: { campaigns: { getCampaign: () => Effect.fail(new Errors.CampaignNotFound()) } },
    },
    {
      error: "EmailAlreadyUsed",
      status: 409,
      request: () => send("POST", "/contacts", `{"email":"${email}"}`),
      stubs: {
        audience: { createContact: () => Effect.fail(new Errors.EmailAlreadyUsed({ email })) },
      },
    },
    {
      error: "AddressOptedOut",
      status: 409,
      request: () => send("PATCH", `/contacts/${contactId}`, '{"email":"elsewhere@example.com"}'),
      stubs: {
        audience: { updateContact: () => Effect.fail(new Errors.AddressOptedOut({ email })) },
      },
    },
    {
      error: "CampaignStateConflict",
      status: 409,
      request: () => send("POST", `/campaigns/${campaignId}/cancel`, "{}"),
      stubs: { campaigns: { getCampaignControl: () => Effect.succeed(conflict) } },
    },
    {
      error: "SendAtNotInFuture",
      status: 409,
      request: () =>
        send("POST", `/campaigns/${campaignId}/schedule`, '{"sendAt":"2020-01-01T00:00:00.000Z"}'),
      stubs: {
        campaigns: { getCampaignControl: () => Effect.succeed(draft) },
      },
    },
    {
      error: "TestAudienceTooLarge",
      status: 409,
      request: () => send("POST", `/campaigns/${campaignId}/test`, `{"listId":"${listId}"}`),
      stubs: {
        audience: {
          listMembers: () => Effect.succeed({ items: [contact], nextCursor: contactId }),
        },
        campaigns: { getCampaign: () => Effect.succeed(campaign) },
      },
    },
    {
      error: "SendingPaused",
      status: 503,
      request: () => send("POST", `/campaigns/${campaignId}/test`, `{"to":["${email}"]}`),
      stubs: {
        campaigns: { getCampaign: () => Effect.succeed(campaign) },
        guard: {
          current: Effect.succeed({ limit: 14, refusal: "reputation" as const }),
          slot: notExercised("SendGuard.slot"),
        },
      },
    },
  ] as const;

  it.effect.each(cases)("answers $error with $status and its tag, and logs nothing", (entry) =>
    Effect.gen(function* () {
      const { respond, lines } = api(entry.stubs);
      const { status, body } = yield* respond(entry.request());

      expect(status).toBe(entry.status);
      expect(body).toContain(`"_tag":"${entry.error}"`);
      expect(lines).toStrictEqual([]);
    }),
  );

  it.effect("reaches the generated client as a typed failure", () =>
    Effect.gen(function* () {
      const { call } = api(cases[0].stubs);

      const attempt = yield* Effect.result(
        call((client) => client.contacts.get({ params: { id: contactId } })),
      );

      expect(Result.isFailure(attempt) && attempt.failure).toStrictEqual(
        new Errors.ContactNotFound(),
      );
    }),
  );
});

describe("failure reporting", () => {
  const unavailable = { failure: "ThrottlingException" } as const;

  const cases = [
    {
      error: "StorageUnavailable",
      operation: "listContacts",
      failure: "ThrottlingException",
      request: () => get("/contacts"),
      stubs: {
        audience: {
          listContacts: () =>
            Effect.fail(
              new Errors.StorageUnavailable({ operation: "listContacts", ...unavailable }),
            ),
        },
      },
    },
    {
      error: "EmailServiceUnavailable",
      operation: "getSuppressedDestination",
      failure: "TooManyRequestsException",
      request: () => get(`/addresses/status?email=${email}`),
      stubs: {
        audience: { addressRecord: () => Effect.succeed(record) },
        suppression: {
          getSuppressedDestination: () =>
            Effect.fail(new sesv2.TooManyRequestsException({ message: "slow" })),
        },
      },
    },
    {
      error: "QueueUnavailable",
      operation: "dispatch",
      failure: "ThrottlingException",
      request: () => send("POST", `/campaigns/${campaignId}/send`, "{}"),
      stubs: {
        campaigns: {
          getCampaignControl: () => Effect.succeed(draft),
          newRun: () => Effect.void,
        },
        wake: {
          enqueue: () =>
            Effect.fail(new Errors.QueueUnavailable({ operation: "dispatch", ...unavailable })),
        },
      },
    },
    {
      error: "SchedulerUnavailable",
      operation: "schedule",
      failure: "ThrottlingException",
      request: () =>
        send("POST", `/campaigns/${campaignId}/schedule`, '{"sendAt":"2099-06-01T09:00:00.000Z"}'),
      stubs: {
        campaigns: {
          getCampaignControl: () => Effect.succeed(draft),
          newRun: () => Effect.void,
        },
        schedule: {
          create: () =>
            Effect.fail(new Errors.SchedulerUnavailable({ operation: "schedule", ...unavailable })),
        },
      },
    },
    {
      error: "AlarmsUnavailable",
      operation: "describeAlarms",
      failure: "ThrottlingException",
      request: () => send("POST", `/campaigns/${campaignId}/test`, `{"to":["${email}"]}`),
      stubs: {
        campaigns: { getCampaign: () => Effect.succeed(campaign) },
        guard: {
          current: Effect.fail(
            new Errors.AlarmsUnavailable({ operation: "describeAlarms", ...unavailable }),
          ),
          slot: notExercised("SendGuard.slot"),
        },
      },
    },
  ] as const;

  it.effect.each(cases)(
    "answers $error with 503 and its tag, and logs it once with its operation and failure",
    (entry) =>
      Effect.gen(function* () {
        const { respond, lines } = api(entry.stubs);
        const { status, body } = yield* respond(entry.request());

        expect(status).toBe(503);
        expect(body).toContain(`"_tag":"${entry.error}"`);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(`"error": "${entry.error}"`);
        expect(lines[0]).toContain(`"operation": "${entry.operation}"`);
        expect(lines[0]).toContain(`"failure": "${entry.failure}"`);
      }),
  );

  it.effect("answers a defect with an empty 500 and logs one line without the payload", () =>
    Effect.gen(function* () {
      const { respond, lines } = api({
        audience: { getContact: () => Effect.die(new Error(`decode failed for ${email}`)) },
      });

      const { status, body } = yield* respond(get(`/contacts/${contactId}`));

      expect(status).toBe(500);
      expect(body).toBe("");
      expect(lines).toHaveLength(1);
      expect(lines.join("\n")).not.toContain(email);
    }),
  );

  it.effect("logs an authenticated malformed request once, by its tag alone", () =>
    Effect.gen(function* () {
      const { respond, lines } = api();
      const { status } = yield* respond(send("POST", "/contacts", '{"email":"no-at-sign"}'));

      expect(status).toBe(400);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"error": "HttpApiSchemaError"');
      expect(lines[0]).not.toContain("no-at-sign");
    }),
  );

  it.effect("keeps the router's 404 for an unknown path and logs nothing", () =>
    Effect.gen(function* () {
      const { respond, lines } = api();

      expect((yield* respond(get("/nowhere"))).status).toBe(404);
      expect(lines).toStrictEqual([]);
    }),
  );
});

// Every stub a test does not state dies if reached, so a refused request that answers its own
// status has also reached no service.
describe("authorization", () => {
  it.effect("refuses a request with no credential and challenges for Bearer", () =>
    Effect.gen(function* () {
      const { respond } = api();
      const response = yield* respond(get(`/contacts/${contactId}`, {}));

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }),
  );

  it.effect.each([
    ["a wrong credential", `Bearer ${otherToken}`],
    ["a credential joined with a duplicate", `Bearer ${token}, Bearer ${token}`],
  ] as const)("refuses %s", ([_label, authorization]) =>
    Effect.gen(function* () {
      const { respond } = api();

      expect((yield* respond(get(`/contacts/${contactId}`, { authorization }))).status).toBe(401);
    }),
  );

  it.effect("refuses an unauthenticated request before reading its body, and logs nothing", () =>
    Effect.gen(function* () {
      const { respond, lines } = api();

      expect((yield* respond(send("POST", "/contacts", "{not json", {}))).status).toBe(401);
      expect(lines).toStrictEqual([]);
    }),
  );

  // The application is built once and answers many invocations: a caller's identity must not
  // outlive its request, in either direction.
  it.effect("judges each consecutive request on its own credential", () =>
    Effect.gen(function* () {
      const { respond } = api({ audience: { listContacts: () => Effect.succeed({ items: [] }) } });

      expect((yield* respond(get("/contacts"))).status).toBe(200);
      expect((yield* respond(get("/contacts", {}))).status).toBe(401);
      expect((yield* respond(get("/contacts"))).status).toBe(200);
    }),
  );
});

describe("request decoding", () => {
  it.effect.each([
    ["a malformed body", () => send("POST", "/contacts", "{not json")],
    ["a path parameter that is not an identifier", () => get("/contacts/not-a-uuid")],
    ["a page size outside the contract", () => get("/contacts?limit=500")],
    ["a tampered cursor", () => get("/contacts?cursor=not-a-cursor")],
    [
      "a name over its limit",
      () => send("POST", "/lists", `{"name":"${"n".repeat(Schemas.maxNameLength + 1)}"}`),
    ],
    // The field limits bound a request's size: there is no separate body limit.
    [
      "a text body over its limit",
      () =>
        send(
          "POST",
          "/campaigns",
          `{"listId":"${listId}","subject":"Release notes","text":"${"t".repeat(Schemas.maxTextBytes + 1)}"}`,
        ),
    ],
  ] as const)("answers 400 for %s, reaching no service", ([_label, request]) =>
    Effect.gen(function* () {
      const { respond } = api();

      expect((yield* respond(request())).status).toBe(400);
    }),
  );
});

describe("request scope", () => {
  it.effect("closes a request's finalizers after the handler, once per invocation", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const { handle } = api({ audience: { listContacts: () => Effect.succeed({ items: [] }) } });

      const web = HttpEffect.toWebHandler(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              events.push("finalized");
            }),
          );

          const response = yield* handle;

          events.push("handled");

          return response;
        }),
      );

      yield* Effect.promise(() => web(get("/contacts")));
      yield* Effect.promise(() => web(get("/contacts")));

      expect(events).toStrictEqual(["handled", "finalized", "handled", "finalized"]);
    }),
  );
});

describe("Function URL event adaptation", () => {
  const functionUrlEvent = (
    method: string,
    path: string,
    authorization: string,
    body?: string,
  ) => ({
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    headers: {
      authorization,
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

  const decodeNative = Schema.decodeUnknownEffect(
    Schema.Struct({
      statusCode: Schema.Int,
      headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      body: Schema.optional(Schema.String),
    }),
  );

  const nativeResult = (
    handle: ReturnType<typeof api>["handle"],
    event: ReturnType<typeof functionUrlEvent>,
  ) =>
    Effect.gen(function* () {
      const handled = AWS.Lambda.makeFunctionHttpHandler(handle)(event);

      return yield* decodeNative(
        yield* Effect.scoped(handled ?? Effect.die("no handler matched the event")),
      );
    });

  it.effect("answers a native event with a native result", () =>
    Effect.gen(function* () {
      const { handle } = api({ audience: { createContact: recording([], undefined) } });

      const result = yield* nativeResult(
        handle,
        functionUrlEvent("POST", "/contacts", `Bearer ${token}`, `{"email":"${email}"}`),
      );

      expect(result.statusCode).toBe(201);
      expect(result.headers?.["content-type"]).toContain("application/json");
      expect(result.body).toContain(email);
    }),
  );

  it.effect("keeps the challenge on a native unauthorized result", () =>
    Effect.gen(function* () {
      const { handle } = api();

      const result = yield* nativeResult(
        handle,
        functionUrlEvent("GET", `/contacts/${contactId}`, `Bearer ${otherToken}`),
      );

      expect(result.statusCode).toBe(401);
      expect(result.headers?.["www-authenticate"]).toBe("Bearer");
    }),
  );
});
