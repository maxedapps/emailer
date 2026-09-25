import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Authorization, EmailerApi } from "@emailer/api/Api";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, FileSystem, Layer, PlatformError, Redacted, Schema, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const token = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

export const otherToken = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp_Oo-NnMmLlK";

export const contactId = "0195f0a0-1111-4222-8333-44444444c001";

export const listId = "0195f0a0-1111-4222-8333-44444444109e";

export const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

export const createdAt = "2026-09-11T10:00:00.000Z";

interface Service {
  readonly routes: Layer.Layer<never, never, HttpRouter.HttpRouter>;
  readonly authorizations: Array<string>;
  readonly updates: Array<Schemas.ContactAttributes>;
  readonly campaigns: Map<string, Schemas.Campaign>;
  readonly campaignUpdates: Array<Schemas.UpdateCampaignPayload>;
  readonly testSends: Array<Schemas.TestSendPayload>;
  readonly startedAt: Map<string, string>;
  /** The contacts each import call carried, in arrival order, refused calls included. */
  readonly importCalls: Array<Schemas.ImportContactsPayload["contacts"]>;
  /** A list named "Readers" at `listId` whose members hold these addresses. */
  readonly seedList: (emails: ReadonlyArray<string>) => void;
}

const queuedSubmission: Schemas.CampaignSubmission = {
  state: "queued",
  queuedAt: createdAt,
};

export const pausedSubmission: Schemas.CampaignSubmission = {
  state: "paused",
  queuedAt: createdAt,
  startedAt: createdAt,
  progress: { accepted: 0, rejected: 0, uncertain: 0, skipped: 0 },
  feedback: { bounced: 0, complained: 0 },
  reason: "rate-limited",
};

export const inMemoryService = (
  accepted: string,
  options: {
    readonly queueUnavailable?: boolean;
    /** The first import call answers 503, as a throttled table would. */
    readonly importUnavailableOnce?: boolean;
  } = {},
): Service => {
  const authorizations: Array<string> = [];
  const updates: Array<Schemas.ContactAttributes> = [];
  const contacts = new Map<string, Schemas.Contact>();
  const lists = new Map<string, Schemas.ContactList>();
  const members = new Map<string, Array<string>>();
  const campaigns = new Map<string, Schemas.Campaign>();
  const campaignUpdates: Array<Schemas.UpdateCampaignPayload> = [];
  const testSends: Array<Schemas.TestSendPayload> = [];
  const startedAt = new Map<string, string>();
  const importCalls: Array<Schemas.ImportContactsPayload["contacts"]> = [];
  let importedContacts = 0;

  const authorization = Layer.succeed(Authorization)(
    Authorization.of({
      bearer: (httpEffect, options) => {
        const credential = Redacted.value(options.credential);

        authorizations.push(credential);

        return credential === accepted ? httpEffect : Effect.fail(new Errors.Unauthorized());
      },
    }),
  );

  const contactsGroup = HttpApiBuilder.group(EmailerApi, "contacts", (handlers) =>
    handlers.handleAll({
      create: (request) =>
        Effect.sync(() => {
          const contact: Schemas.Contact = { id: contactId, ...request.payload, createdAt };

          contacts.set(contact.id, contact);

          return contact;
        }),
      get: (request) =>
        Effect.suspend(() => {
          const found = contacts.get(request.params.id);

          return found === undefined
            ? Effect.fail(new Errors.ContactNotFound())
            : Effect.succeed(found);
        }),
      getByEmail: (request) =>
        Effect.suspend(() => {
          for (const contact of contacts.values()) {
            if (Schemas.mailboxKey(contact.email) === Schemas.mailboxKey(request.query.email)) {
              return Effect.succeed(contact);
            }
          }

          return Effect.fail(new Errors.ContactNotFound());
        }),
      list: () => Effect.sync(() => ({ items: [...contacts.values()] })),
      update: (request) =>
        Effect.suspend(() => {
          const found = contacts.get(request.params.id);

          if (found === undefined) {
            return Effect.fail(new Errors.ContactNotFound());
          }

          if (request.payload.attributes !== undefined && request.payload.attributes !== null) {
            updates.push(request.payload.attributes);
          }

          const updated: Schemas.Contact =
            request.payload.email === undefined
              ? found
              : { ...found, email: request.payload.email };

          contacts.set(updated.id, updated);

          return Effect.succeed(updated);
        }),
      remove: (request) =>
        Effect.suspend(() => {
          if (!contacts.delete(request.params.id)) {
            return Effect.fail(new Errors.ContactNotFound());
          }

          return Effect.void;
        }),
    }),
  );

  const listsGroup = HttpApiBuilder.group(EmailerApi, "lists", (handlers) =>
    handlers.handleAll({
      create: (request) =>
        Effect.sync(() => {
          const list: Schemas.ContactList = { id: listId, name: request.payload.name, createdAt };

          lists.set(list.id, list);

          return list;
        }),
      get: (request) =>
        Effect.suspend(() => {
          const found = lists.get(request.params.id);

          return found === undefined
            ? Effect.fail(new Errors.ListNotFound())
            : Effect.succeed(found);
        }),
      addContact: (request) =>
        Effect.suspend(() => {
          if (!contacts.has(request.params.contactId)) {
            return Effect.fail(new Errors.ContactNotFound());
          }

          const current = members.get(request.params.listId) ?? [];

          members.set(request.params.listId, [...current, request.params.contactId]);

          return Effect.void;
        }),
      list: () => Effect.sync(() => ({ items: [...lists.values()] })),
      update: (request) =>
        Effect.suspend(() => {
          const found = lists.get(request.params.id);

          if (found === undefined) {
            return Effect.fail(new Errors.ListNotFound());
          }

          const renamed: Schemas.ContactList = { ...found, name: request.payload.name };

          lists.set(renamed.id, renamed);

          return Effect.succeed(renamed);
        }),
      remove: (request) =>
        Effect.suspend(() => {
          if (!lists.delete(request.params.id)) {
            return Effect.fail(new Errors.ListNotFound());
          }

          members.delete(request.params.id);

          return Effect.void;
        }),
      listMembers: (request) =>
        Effect.suspend(() => {
          if (!lists.has(request.params.listId)) {
            return Effect.fail(new Errors.ListNotFound());
          }

          const joined: Array<Schemas.Contact> = [];

          for (const id of members.get(request.params.listId) ?? []) {
            const contact = contacts.get(id);

            if (contact !== undefined) {
              joined.push(contact);
            }
          }

          const limit = request.query.limit ?? Schemas.defaultPageSize;
          const page = joined.slice(0, limit);
          const last = page.at(-1);

          // Like DynamoDB behind the real service, a full page reports a cursor.
          return Effect.succeed(
            page.length === limit && last !== undefined
              ? { items: page, nextCursor: last.id }
              : { items: page },
          );
        }),
      removeContact: (request) =>
        Effect.suspend(() => {
          if (!lists.has(request.params.listId)) {
            return Effect.fail(new Errors.ListNotFound());
          }

          const current = members.get(request.params.listId) ?? [];

          members.set(
            request.params.listId,
            current.filter((id) => id !== request.params.contactId),
          );

          return Effect.void;
        }),
      import: (request) =>
        Effect.gen(function* () {
          importCalls.push(request.payload.contacts);

          if (options.importUnavailableOnce === true && importCalls.length === 1) {
            return yield* new Errors.StorageUnavailable({
              operation: "importContacts",
              failure: "ThrottlingException",
            });
          }

          if (!lists.has(request.params.listId)) {
            return yield* new Errors.ListNotFound();
          }

          const imported = request.payload.contacts.map((entry) => {
            importedContacts += 1;

            const id = `0195f0a0-1111-4222-8333-4444444d${String(importedContacts).padStart(4, "0")}`;
            const contact: Schemas.Contact = { id, email: entry.email, createdAt };

            contacts.set(id, contact);

            return { email: entry.email, contactId: id, member: true };
          });

          members.set(request.params.listId, [
            ...(members.get(request.params.listId) ?? []),
            ...imported.map((entry) => entry.contactId),
          ]);

          return { contacts: imported };
        }),
    }),
  );

  const campaignsGroup = HttpApiBuilder.group(EmailerApi, "campaigns", (handlers) =>
    handlers.handleAll({
      create: (request) =>
        Effect.sync(() => {
          const campaign = {
            id: campaignId,
            listId: request.payload.listId,
            subject: request.payload.subject,
            text: request.payload.text,
            createdAt,
            submission: { state: "draft" } as const,
          };

          const withHtml =
            request.payload.html === undefined
              ? campaign
              : { ...campaign, html: request.payload.html };

          const created: Schemas.Campaign =
            request.payload.filter === undefined
              ? withHtml
              : { ...withHtml, filter: request.payload.filter };

          campaigns.set(created.id, created);

          return created;
        }),
      get: (request) =>
        Effect.suspend(() => {
          const found = campaigns.get(request.params.id);

          return found === undefined
            ? Effect.fail(new Errors.CampaignNotFound())
            : Effect.succeed(found);
        }),
      update: (request) =>
        Effect.gen(function* () {
          const found = campaigns.get(request.params.id);

          if (found === undefined) {
            return yield* new Errors.CampaignNotFound();
          }

          if (found.submission.state !== "draft") {
            return yield* new Errors.CampaignStateConflict({ state: found.submission.state });
          }

          campaignUpdates.push(request.payload);

          const { html, filter, ...rest } = found;
          const change = request.payload;

          const campaign = {
            ...rest,
            listId: change.listId ?? found.listId,
            subject: change.subject ?? found.subject,
            text: change.text ?? found.text,
          };

          const nextHtml = change.html === undefined ? html : (change.html ?? undefined);
          const nextFilter = change.filter === undefined ? filter : (change.filter ?? undefined);
          const withHtml = nextHtml === undefined ? campaign : { ...campaign, html: nextHtml };

          const updated: Schemas.Campaign =
            nextFilter === undefined ? withHtml : { ...withHtml, filter: nextFilter };

          campaigns.set(updated.id, updated);

          return updated;
        }),
      remove: (request) =>
        Effect.gen(function* () {
          const found = campaigns.get(request.params.id);

          if (found === undefined) {
            return yield* new Errors.CampaignNotFound();
          }

          if (found.submission.state !== "draft") {
            return yield* new Errors.CampaignStateConflict({ state: found.submission.state });
          }

          campaigns.delete(found.id);
        }),
      preview: (request) =>
        Effect.suspend(() =>
          campaigns.has(request.params.id)
            ? Effect.succeed({
                url: `https://preview.example/previews/${request.params.id}`,
                expiresAt: "2026-09-12T10:00:00.000Z",
              })
            : Effect.fail(new Errors.CampaignNotFound()),
        ),
      test: (request) =>
        Effect.gen(function* () {
          if (!campaigns.has(request.params.id)) {
            return yield* new Errors.CampaignNotFound();
          }

          testSends.push(request.payload);

          const recipients =
            "to" in request.payload
              ? request.payload.to
              : (members.get(request.payload.listId) ?? []).flatMap((id) => {
                  const contact = contacts.get(id);

                  return contact === undefined ? [] : [contact.email];
                });

          return {
            recipients: recipients.map((email, index) => ({
              email,
              outcome: "accepted" as const,
              messageId: `message-${index + 1}`,
            })),
          };
        }),
      send: (request) =>
        Effect.gen(function* () {
          const found = campaigns.get(request.params.id);

          if (found === undefined) {
            return yield* new Errors.CampaignNotFound();
          }

          if (options.queueUnavailable === true) {
            return yield* new Errors.QueueUnavailable({
              operation: "dispatch",
              failure: "ServiceUnavailable",
            });
          }

          if (found.submission.state !== "draft") {
            return found;
          }

          const queued: Schemas.Campaign = { ...found, submission: queuedSubmission };

          campaigns.set(queued.id, queued);

          return queued;
        }),
      resume: (request) =>
        Effect.gen(function* () {
          const found = campaigns.get(request.params.id);

          if (found === undefined) {
            return yield* new Errors.CampaignNotFound();
          }

          if (options.queueUnavailable === true) {
            return yield* new Errors.QueueUnavailable({
              operation: "dispatch",
              failure: "ServiceUnavailable",
            });
          }

          if (found.submission.state !== "paused") {
            return found;
          }

          const resumed: Schemas.Campaign = { ...found, submission: queuedSubmission };

          campaigns.set(resumed.id, resumed);

          return resumed;
        }),
      schedule: (request) =>
        Effect.gen(function* () {
          const found = campaigns.get(request.params.id);

          if (found === undefined) {
            return yield* new Errors.CampaignNotFound();
          }

          const scheduled: Schemas.Campaign = {
            ...found,
            submission: { state: "scheduled", sendAt: request.payload.sendAt },
          };

          campaigns.set(scheduled.id, scheduled);

          return scheduled;
        }),
      cancel: (request) =>
        Effect.gen(function* () {
          const found = campaigns.get(request.params.id);

          if (found === undefined) {
            return yield* new Errors.CampaignNotFound();
          }

          switch (found.submission.state) {
            case "sending":
            case "completed":
              return yield* new Errors.CampaignStateConflict({
                state: found.submission.state,
              });
            case "draft":
            case "paused":
              return found;
            case "scheduled": {
              const cancelled: Schemas.Campaign = { ...found, submission: { state: "draft" } };

              campaigns.set(cancelled.id, cancelled);

              return cancelled;
            }

            case "queued": {
              const started = startedAt.get(found.id);

              if (started === undefined) {
                const cancelled: Schemas.Campaign = { ...found, submission: { state: "draft" } };

                campaigns.set(cancelled.id, cancelled);

                return cancelled;
              }

              const paused: Schemas.Campaign = {
                ...found,
                submission: {
                  state: "paused",
                  queuedAt: found.submission.queuedAt,
                  startedAt: started,
                  progress: { accepted: 0, rejected: 0, uncertain: 0, skipped: 0 },
                  feedback: { bounced: 0, complained: 0 },
                  reason: "manual",
                },
              };

              campaigns.set(paused.id, paused);

              return paused;
            }
          }
        }),
      list: () => Effect.sync(() => ({ items: [...campaigns.values()] })),
    }),
  );

  const addressesGroup = HttpApiBuilder.group(EmailerApi, "addresses", (handlers) =>
    handlers.handleAll({
      // The two fakes answer differently so a test can tell which endpoint the CLI called.
      status: (request) =>
        Effect.succeed({
          email: request.query.email,
          status: "suppressed" as const,
          suppression: { reason: "bounce" as const, suppressedAt: "2026-09-15T10:00:00.000Z" },
          transientBounces: [],
          accountSuppression: {
            reason: "bounce" as const,
            lastUpdateTime: "2026-09-15T10:00:00.000Z",
          },
        }),
      unsuppress: (request) =>
        Effect.succeed({
          email: request.payload.email,
          status: "mailable" as const,
          transientBounces: [],
          accountSuppression: null,
        }),
    }),
  );

  const routes = HttpApiBuilder.layer(EmailerApi).pipe(
    Layer.provide(Layer.mergeAll(contactsGroup, listsGroup, campaignsGroup, addressesGroup)),
    Layer.provide(authorization),
    Layer.provide(HttpServer.layerServices),
  );

  const seedList = (emails: ReadonlyArray<string>) => {
    lists.set(listId, { id: listId, name: "Readers", createdAt });

    const ids = emails.map((email, index) => {
      const id = `0195f0a0-1111-4222-8333-4444444c${String(index).padStart(4, "0")}`;

      contacts.set(id, { id, email, createdAt });

      return id;
    });

    members.set(listId, ids);
  };

  return {
    routes,
    authorizations,
    updates,
    campaigns,
    campaignUpdates,
    testSends,
    startedAt,
    importCalls,
    seedList,
  };
};

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

export const runCli = (
  baseUrl: string,
  credential: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {},
  stdin = "",
): Effect.Effect<CliResult, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const command = ChildProcess.make("node", ["apps/cli/src/main.ts", ...args], {
      extendEnv: true,
      stdin: Stream.encodeText(Stream.make(stdin)),
    }).pipe(
      ChildProcess.setEnv({
        EMAILER_API_URL: baseUrl,
        EMAILER_API_TOKEN: credential,
        ...environment,
      }),
    );

    const handle = yield* spawner.spawn(command);

    const captured = yield* Effect.all(
      [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );

    return { stdout: captured[0], stderr: captured[1], exitCode: Number(captured[2]) };
  }).pipe(Effect.scoped);

export const withService = <A, E>(
  service: Service,
  use: (baseUrl: string) => Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.gen(function* () {
    const handle = yield* HttpRouter.toHttpEffect(service.routes);

    yield* HttpServer.serveEffect(handle);

    const baseUrl = yield* HttpServer.addressFormattedWith((address) =>
      Effect.succeed(address.replace("0.0.0.0", "127.0.0.1")),
    );

    return yield* use(baseUrl);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer)),
  );

export const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** A file for the CLI to read through a flag, removed when the enclosing scope closes. */
export const tempFile = (extension: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.makeTempFileScoped({ suffix: `.${extension}` });

    yield* fs.writeFileString(file, contents);

    return file;
  });

export const textBody = "Hello there";

export const toJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
