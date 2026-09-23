import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Authorization, EmailerApi, Unauthorized } from "@emailer/api/Api";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Layer, PlatformError, Redacted, Schema, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { writeFile, rm } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const token = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

const otherToken = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp_Oo-NnMmLlK";

const contactId = "0195f0a0-1111-4222-8333-44444444c001";

const listId = "0195f0a0-1111-4222-8333-44444444109e";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const createdAt = "2026-09-11T10:00:00.000Z";

interface Service {
  readonly routes: Layer.Layer<never, never, HttpRouter.HttpRouter>;
  readonly authorizations: Array<string>;
  readonly updates: Array<Schemas.ContactAttributes>;
  readonly campaigns: Map<string, Schemas.Campaign>;
  readonly startedAt: Map<string, string>;
}

const queuedSubmission: Schemas.CampaignSubmission = {
  state: "queued",
  queuedAt: createdAt,
};

const pausedSubmission: Schemas.CampaignSubmission = {
  state: "paused",
  queuedAt: createdAt,
  startedAt: createdAt,
  progress: { accepted: 0, rejected: 0, uncertain: 0, skipped: 0 },
  feedback: { bounced: 0, complained: 0 },
  reason: "rate-limited",
};

const inMemoryService = (
  accepted: string,
  options: { readonly dispatchUnavailable?: boolean } = {},
): Service => {
  const authorizations: Array<string> = [];
  const updates: Array<Schemas.ContactAttributes> = [];
  const contacts = new Map<string, Schemas.Contact>();
  const lists = new Map<string, Schemas.ContactList>();
  const members = new Map<string, Array<string>>();
  const campaigns = new Map<string, Schemas.Campaign>();
  const startedAt = new Map<string, string>();

  const authorization = Layer.succeed(Authorization)(
    Authorization.of({
      bearer: (httpEffect, options) => {
        const credential = Redacted.value(options.credential);

        authorizations.push(credential);

        return credential === accepted ? httpEffect : Effect.fail(new Unauthorized());
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
            ? Effect.fail(new Schemas.NotFound({ entity: "contact" }))
            : Effect.succeed(found);
        }),
      getByEmail: (request) =>
        Effect.suspend(() => {
          for (const contact of contacts.values()) {
            if (Schemas.mailboxKey(contact.email) === Schemas.mailboxKey(request.query.email)) {
              return Effect.succeed(contact);
            }
          }

          return Effect.fail(new Schemas.NotFound({ entity: "contact" }));
        }),
      list: () => Effect.sync(() => ({ items: [...contacts.values()] })),
      update: (request) =>
        Effect.suspend(() => {
          const found = contacts.get(request.params.id);

          if (found === undefined) {
            return Effect.fail(new Schemas.NotFound({ entity: "contact" }));
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
            return Effect.fail(new Schemas.NotFound({ entity: "contact" }));
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
            ? Effect.fail(new Schemas.NotFound({ entity: "list" }))
            : Effect.succeed(found);
        }),
      addContact: (request) =>
        Effect.suspend(() => {
          if (!contacts.has(request.params.contactId)) {
            return Effect.fail(new Schemas.NotFound({ entity: "contact" }));
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
            return Effect.fail(new Schemas.NotFound({ entity: "list" }));
          }

          const renamed: Schemas.ContactList = { ...found, name: request.payload.name };

          lists.set(renamed.id, renamed);

          return Effect.succeed(renamed);
        }),
      remove: (request) =>
        Effect.suspend(() => {
          if (!lists.delete(request.params.id)) {
            return Effect.fail(new Schemas.NotFound({ entity: "list" }));
          }

          members.delete(request.params.id);

          return Effect.void;
        }),
      listMembers: (request) =>
        Effect.suspend(() => {
          if (!lists.has(request.params.listId)) {
            return Effect.fail(new Schemas.NotFound({ entity: "list" }));
          }

          const joined: Array<Schemas.Contact> = [];

          for (const id of members.get(request.params.listId) ?? []) {
            const contact = contacts.get(id);

            if (contact !== undefined) {
              joined.push(contact);
            }
          }

          return Effect.succeed({ items: joined });
        }),
      removeContact: (request) =>
        Effect.suspend(() => {
          if (!lists.has(request.params.listId)) {
            return Effect.fail(new Schemas.NotFound({ entity: "list" }));
          }

          const current = members.get(request.params.listId) ?? [];

          members.set(
            request.params.listId,
            current.filter((id) => id !== request.params.contactId),
          );

          return Effect.void;
        }),
      import: (request) =>
        Effect.suspend(() => {
          if (!lists.has(request.params.listId)) {
            return Effect.fail(new Schemas.NotFound({ entity: "list" }));
          }

          const imported = request.payload.contacts.map((entry, index) => {
            const id = `0195f0a0-1111-4222-8333-4444444c${String(index).padStart(4, "0")}`;
            const contact: Schemas.Contact = { id, email: entry.email, createdAt };

            contacts.set(id, contact);

            return { email: entry.email, contactId: id, member: true };
          });

          members.set(
            request.params.listId,
            imported.map((entry) => entry.contactId),
          );

          return Effect.succeed({ contacts: imported });
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
            ? Effect.fail(new Schemas.NotFound({ entity: "campaign" }))
            : Effect.succeed(found);
        }),
      send: (request) =>
        Effect.gen(function* () {
          const found = campaigns.get(request.params.id);

          if (found === undefined) {
            return yield* new Schemas.NotFound({ entity: "campaign" });
          }

          if (options.dispatchUnavailable === true) {
            return yield* new Schemas.StorageUnavailable({ operationId: "dispatch" });
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
            return yield* new Schemas.NotFound({ entity: "campaign" });
          }

          if (options.dispatchUnavailable === true) {
            return yield* new Schemas.StorageUnavailable({ operationId: "dispatch" });
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
            return yield* new Schemas.NotFound({ entity: "campaign" });
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
            return yield* new Schemas.NotFound({ entity: "campaign" });
          }

          switch (found.submission.state) {
            case "sending":
            case "completed":
              return yield* new Schemas.CampaignCancellationConflict({
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

  return { routes, authorizations, updates, campaigns, startedAt };
};

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.runFold(
    stream,
    () => "",
    (accumulated: string, chunk) => accumulated + new TextDecoder().decode(chunk),
  );

const runCli = (
  baseUrl: string,
  credential: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {},
): Effect.Effect<CliResult, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const command = ChildProcess.make("node", ["apps/cli/src/main.ts", ...args], {
      extendEnv: true,
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

const withService = <A, E>(
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
    Effect.provide(
      Layer.mergeAll(NodeHttpServer.layer(createServer, { port: 0 }), NodeServices.layer),
    ),
  );

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** A file for the CLI to read through a body flag, removed once `use` has settled. */
const withTempFile = <A, E, R>(
  extension: string,
  contents: string,
  use: (file: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => `${tmpdir()}/emailer-${randomUUID()}.${extension}`).pipe(
      Effect.tap((file) => Effect.promise(() => writeFile(file, contents))),
    ),
    use,
    (file) => Effect.promise(() => rm(file, { force: true })),
  );

const textBody = "Hello there";

const toJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

describe("the emailer executable", () => {
  it("prints help without credentials or a service", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* runCli("http://127.0.0.1:1", "", ["--help"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Manage contacts, lists, campaigns and addresses");
        expect(result.stdout).toContain("campaigns");
        expect(result.stdout).toContain("addresses");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("rejects an unknown subcommand with a nonzero exit and usage on stdout", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* runCli("http://127.0.0.1:1", token, ["contacts", "destroy"]);

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toContain("USAGE");
        expect(result.stdout.startsWith("{")).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("rejects an argument the contract does not accept, before any request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["contacts", "create", "--email", "not-an-address"]),
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Invalid value for flag --email");
        expect(result.stdout.startsWith("{")).toBe(false);

        expect(service.authorizations).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("attaches the configured credential to its requests", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["contacts", "create", "--email", "max@example.com"]),
        );

        expect(result.exitCode).toBe(0);
        expect(service.authorizations).toStrictEqual([token]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("reports a refused credential on stderr and exits nonzero", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, otherToken, ["contacts", "create", "--email", "max@example.com"]),
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Unauthorized");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("reports a missing entity on stderr and exits nonzero", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["campaigns", "get", campaignId]),
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("NotFound");
        expect(result.stdout).toBe("");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it(
    "runs the whole flow and prints machine-readable results on stdout",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          const outcome = yield* withService(service, (baseUrl) =>
            Effect.gen(function* () {
              const contact = yield* runCli(baseUrl, token, [
                "contacts",
                "create",
                "--email",
                "max@example.com",
                "--name",
                "Max",
              ]);

              const list = yield* runCli(baseUrl, token, ["lists", "create", "--name", "Readers"]);

              const member = yield* runCli(baseUrl, token, [
                "lists",
                "add-contact",
                listId,
                contactId,
              ]);

              const campaign = yield* withTempFile("txt", textBody, (text) =>
                runCli(baseUrl, token, [
                  "campaigns",
                  "create",
                  "--list",
                  listId,
                  "--subject",
                  "Release notes",
                  "--text",
                  text,
                ]),
              );

              const sent = yield* runCli(baseUrl, token, ["campaigns", "send", campaignId]);
              const replayed = yield* runCli(baseUrl, token, ["campaigns", "send", campaignId]);

              return { contact, list, member, campaign, sent, replayed };
            }),
          );

          expect(outcome.contact.exitCode).toBe(0);
          expect(yield* parseJson(outcome.contact.stdout)).toStrictEqual({
            id: contactId,
            email: "max@example.com",
            name: "Max",
            createdAt,
          });

          expect(outcome.list.exitCode).toBe(0);
          expect(outcome.member.exitCode).toBe(0);
          expect(outcome.campaign.exitCode).toBe(0);

          const created = yield* parseJson(outcome.campaign.stdout);

          expect(created).toMatchObject({
            submission: { state: "draft" },
          });
          expect(created).not.toHaveProperty("html");

          expect(outcome.sent.exitCode).toBe(0);
          expect(yield* parseJson(outcome.sent.stdout)).toMatchObject({
            submission: { state: "queued", queuedAt: createdAt },
          });

          expect(yield* parseJson(outcome.replayed.stdout)).toStrictEqual(
            yield* parseJson(outcome.sent.stdout),
          );
          expect(outcome.replayed.exitCode).toBe(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "resumes a paused campaign and leaves a non-paused campaign unchanged",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: pausedSubmission,
          });

          const outcome = yield* withService(service, (baseUrl) =>
            Effect.gen(function* () {
              const resumed = yield* runCli(baseUrl, token, ["campaigns", "resume", campaignId]);
              const again = yield* runCli(baseUrl, token, ["campaigns", "resume", campaignId]);

              return { resumed, again };
            }),
          );

          expect(outcome.resumed.exitCode).toBe(0);
          expect(yield* parseJson(outcome.resumed.stdout)).toMatchObject({
            submission: { state: "queued", queuedAt: createdAt },
          });

          expect(outcome.again.exitCode).toBe(0);
          expect(yield* parseJson(outcome.again.stdout)).toStrictEqual(
            yield* parseJson(outcome.resumed.stdout),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it.each([
    ["2026-09-20T09:00Z", "2026-09-20T09:00:00.000Z"],
    ["2026-09-20", "2026-09-20T00:00:00.000Z"],
    ["2028-02-29T00:30+02:00", "2028-02-28T22:30:00.000Z"],
    ["2026-09-20T09:00:12.1Z", "2026-09-20T09:00:12.100Z"],
    ["2026-09-20T09:00:12.123-05:30", "2026-09-20T14:30:12.123Z"],
  ])(
    "schedules the ISO input %s at %s",
    (input, sendAt) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: { state: "draft" },
          });

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "schedule", campaignId, "--at", input]),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toMatchObject({
            submission: { state: "scheduled", sendAt },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "reads a zone-less --at as UTC regardless of the operator's TZ",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: { state: "draft" },
          });

          const result = yield* withService(service, (baseUrl) =>
            runCli(
              baseUrl,
              token,
              ["campaigns", "schedule", campaignId, "--at", "2026-09-20T09:00"],
              { TZ: "Europe/Berlin" },
            ),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toMatchObject({
            submission: { state: "scheduled", sendAt: "2026-09-20T09:00:00.000Z" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it.each([
    "nonsense",
    "2099-02-29T09:00Z",
    "2099-04-31T09:00+02:00",
    "2099-01-01T24:00Z",
    "2099-01-01T09:00+24:00",
    "2099-01-01T09:00Z\n",
    "2099-01-01T09:00:00.1234Z",
    "9999-12-31T23:59-01:00",
  ])(
    "rejects invalid --at %s before issuing any request",
    (input) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: { state: "draft" },
          });

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "schedule", campaignId, "--at", input]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout.startsWith("{")).toBe(false);
          expect(service.authorizations).toHaveLength(0);
          expect(service.campaigns.get(campaignId)?.submission).toStrictEqual({ state: "draft" });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it("describes pending cancellation in cancel help", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* runCli("http://127.0.0.1:1", "", ["campaigns", "cancel", "--help"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("scheduled");
        expect(result.stdout).toContain("queued first send");
        expect(result.stdout).toContain("draft");
        expect(result.stdout).toContain("queued resume");
        expect(result.stdout).toContain("paused");
        expect(result.stdout).toContain("manual");
        expect(result.stdout).not.toContain("run token");
        expect(result.stdout).not.toContain("runToken");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it(
    "cancels a scheduled campaign back to draft",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: { state: "scheduled", sendAt: "2026-09-20T09:00:00.000Z" },
          });

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "cancel", campaignId]),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toMatchObject({
            submission: { state: "draft" },
          });
          expect(result.stdout).not.toContain("runToken");
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "cancels a queued resume to paused with reason manual",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: { state: "queued", queuedAt: createdAt },
          });
          service.startedAt.set(campaignId, createdAt);

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "cancel", campaignId]),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toMatchObject({
            submission: { state: "paused", reason: "manual", startedAt: createdAt },
          });
          expect(result.stdout).not.toContain("runToken");
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "reports a cancellation conflict on stderr and leaves a sending campaign unchanged",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          const sending: Schemas.Campaign = {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: {
              state: "sending",
              queuedAt: createdAt,
              startedAt: createdAt,
              progress: { accepted: 1, rejected: 0, uncertain: 0, skipped: 0 },
              feedback: { bounced: 0, complained: 0 },
            },
          };

          service.campaigns.set(campaignId, sending);

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "cancel", campaignId]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("CampaignCancellationConflict");
          expect(service.campaigns.get(campaignId)).toStrictEqual(sending);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it("lists campaigns as a JSON page", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        service.campaigns.set(campaignId, {
          id: campaignId,
          listId,
          subject: "Release notes",
          text: "Hello there",
          createdAt,
          submission: { state: "draft" },
        });

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["campaigns", "list"]),
        );

        expect(result.exitCode).toBe(0);

        const printed = yield* parseJson(result.stdout);

        expect(printed).toMatchObject({
          items: [{ id: campaignId, subject: "Release notes" }],
        });
        expect(printed).not.toHaveProperty("items.0.text");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it(
    "reports a 503 from send on stderr and exits nonzero",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token, { dispatchUnavailable: true });

          const outcome = yield* withService(service, (baseUrl) =>
            Effect.gen(function* () {
              yield* withTempFile("txt", textBody, (text) =>
                runCli(baseUrl, token, [
                  "campaigns",
                  "create",
                  "--list",
                  listId,
                  "--subject",
                  "Release notes",
                  "--text",
                  text,
                ]),
              );

              return yield* runCli(baseUrl, token, ["campaigns", "send", campaignId]);
            }),
          );

          expect(outcome.exitCode).not.toBe(0);
          expect(outcome.stdout).toBe("");
          expect(outcome.stderr).toContain("StorageUnavailable");
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "creates a campaign whose text and html are the contents of the --text and --html files",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);
          const html = "<p>Hello there</p>";

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("txt", textBody, (text) =>
              withTempFile("html", html, (file) =>
                runCli(baseUrl, token, [
                  "campaigns",
                  "create",
                  "--list",
                  listId,
                  "--subject",
                  "Release notes",
                  "--text",
                  text,
                  "--html",
                  file,
                ]),
              ),
            ),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toStrictEqual({
            id: campaignId,
            listId,
            subject: "Release notes",
            text: textBody,
            html,
            createdAt,
            submission: { state: "draft" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "creates a campaign whose filter is the merged --filter pairs",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("txt", textBody, (text) =>
              runCli(baseUrl, token, [
                "campaigns",
                "create",
                "--list",
                listId,
                "--subject",
                "Release notes",
                "--text",
                text,
                "--filter",
                "plan=pro",
                "--filter",
                "city=Berlin",
              ]),
            ),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toStrictEqual({
            id: campaignId,
            listId,
            subject: "Release notes",
            text: textBody,
            createdAt,
            submission: { state: "draft" },
            filter: { plan: "pro", city: "Berlin" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "rejects a missing --text file before issuing any request",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);
          const missing = `${tmpdir()}/emailer-${randomUUID()}.txt`;

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, [
              "campaigns",
              "create",
              "--list",
              listId,
              "--subject",
              "Release notes",
              "--text",
              missing,
            ]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout.startsWith("{")).toBe(false);
          expect(service.authorizations).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "rejects a missing --html file before issuing any request",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);
          const missing = `${tmpdir()}/emailer-${randomUUID()}.html`;

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("txt", textBody, (text) =>
              runCli(baseUrl, token, [
                "campaigns",
                "create",
                "--list",
                listId,
                "--subject",
                "Release notes",
                "--text",
                text,
                "--html",
                missing,
              ]),
            ),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout.startsWith("{")).toBe(false);
          expect(service.authorizations).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it("never writes diagnostics to stdout", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["lists", "get", listId]),
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("NotFound");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));
});

describe("contact and list management from the command line", () => {
  it("merges repeated --attr pairs into one attribute map", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          Effect.gen(function* () {
            yield* runCli(baseUrl, token, ["contacts", "create", "--email", "max@example.com"]);

            return yield* runCli(baseUrl, token, [
              "contacts",
              "update",
              contactId,
              "--attr",
              "plan=pro",
              "--attr",
              "city=Berlin",
            ]);
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(service.updates).toStrictEqual([{ plan: "pro", city: "Berlin" }]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("rejects a malformed import file before issuing any request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const file = `${tmpdir()}/emailer-import-${randomUUID()}.json`;

        const contents = yield* toJson({ contacts: [{ email: "not-an-address" }] });

        yield* Effect.promise(() => writeFile(file, contents));

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["lists", "import", listId, "--file", file]),
        );

        yield* Effect.promise(() => rm(file, { force: true }));

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout.startsWith("{")).toBe(false);
        expect(service.authorizations).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("rejects an import file naming one address twice, before issuing any request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const file = `${tmpdir()}/emailer-import-${randomUUID()}.json`;

        const contents = yield* toJson({
          contacts: [{ email: "Max@example.com" }, { email: "max@EXAMPLE.com" }],
        });

        yield* Effect.promise(() => writeFile(file, contents));

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["lists", "import", listId, "--file", file]),
        );

        yield* Effect.promise(() => rm(file, { force: true }));

        expect(result.exitCode).not.toBe(0);
        expect(service.authorizations).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("rejects a page size outside the contract before issuing any request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["contacts", "list", "--limit", "500"]),
        );

        expect(result.exitCode).not.toBe(0);
        expect(service.authorizations).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  // A page reports its cursor in the contract's own form, so the flag has to accept exactly that
  // string. The two halves are pinned apart — `Schemas.test.ts` that a page's value survives the
  // wire unchanged, and this that the flag takes it — because between them sits the client, which
  // is the layer that used to hand the CLI a value it could not be given back.
  it("accepts the cursor form a page reports, without a round trip to reject it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["contacts", "list", "--cursor", `${createdAt}#${contactId}`]),
        );

        expect(result.exitCode).toBe(0);
        expect(service.authorizations).toStrictEqual([token]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("lists, renames and deletes a list from the command line", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const outcome = yield* withService(service, (baseUrl) =>
          Effect.gen(function* () {
            yield* runCli(baseUrl, token, ["lists", "create", "--name", "Weekly"]);

            const renamed = yield* runCli(baseUrl, token, [
              "lists",
              "rename",
              listId,
              "--name",
              "Monthly",
            ]);

            const listed = yield* runCli(baseUrl, token, ["lists", "list"]);
            const deleted = yield* runCli(baseUrl, token, ["lists", "delete", listId]);
            const after = yield* runCli(baseUrl, token, ["lists", "get", listId]);

            return { renamed, listed, deleted, after };
          }),
        );

        expect(outcome.renamed.stdout).toContain("Monthly");
        expect(outcome.listed.stdout).toContain("Monthly");
        expect(outcome.deleted.exitCode).toBe(0);
        expect(outcome.after.exitCode).not.toBe(0);
        expect(outcome.after.stderr).toContain("NotFound");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  // The reporter wraps provisioning, so a configuration read that fails before any request still
  // produces one useful line on stderr rather than an empty nonzero exit.
  it("reports missing configuration on stderr and writes nothing to stdout", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["contacts", "get", contactId], { EMAILER_API_URL: "" }),
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("emailer:");
        expect(result.stderr.trim()).not.toBe("");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("refuses an attribute map the contract bounds, before any request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const oversized = ["--attr", `${"k".repeat(200)}=value`];

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["contacts", "update", contactId, ...oversized]),
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout.startsWith("{")).toBe(false);
        expect(service.updates).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  // An unexpected defect is the case the old per-call wrapper handled worst: it mapped every
  // failure to a tag and lost the rest. A defect must still reach stderr with something an
  // operator can act on, and must not reach stdout.
  it("reports an unexpected defect on stderr with a usable message", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["contacts", "get", contactId], {
            // A URL the client accepts and then cannot reach: the failure surfaces from inside
            // the request rather than from argument parsing.
            EMAILER_API_URL: "http://127.0.0.1:1",
          }),
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("emailer:");
        expect(result.stderr.length).toBeGreaterThan("emailer: ".length + 2);
      }).pipe(Effect.provide(NodeServices.layer)),
    ));
});

describe("address status and un-suppress from the command line", () => {
  it("prints the address record from addresses status and exits 0", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["addresses", "status", "--email", "Max@Example.com"]),
        );

        expect(result.exitCode).toBe(0);
        expect(yield* parseJson(result.stdout)).toStrictEqual({
          email: "Max@Example.com",
          status: "suppressed",
          suppression: { reason: "bounce", suppressedAt: "2026-09-15T10:00:00.000Z" },
          transientBounces: [],
          accountSuppression: { reason: "bounce", lastUpdateTime: "2026-09-15T10:00:00.000Z" },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it("prints the refreshed record from addresses unsuppress and exits 0", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["addresses", "unsuppress", "--email", "max@example.com"]),
        );

        expect(result.exitCode).toBe(0);
        expect(yield* parseJson(result.stdout)).toStrictEqual({
          email: "max@example.com",
          status: "mailable",
          transientBounces: [],
          accountSuppression: null,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ));
});
