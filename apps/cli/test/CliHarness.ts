import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { AdminAuthorization, EmailerApi } from "@emailer/api/Api";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Queue,
  Redacted,
  Schema,
  Stream,
  Terminal,
} from "effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";

import { reporting } from "../src/Diagnostics.ts";
import { emailer } from "../src/Emailer.ts";

export const token = "3o4Xr7nJ1pQvKzB2sYtLwMhGfDcEaN9uRiVoP0qTzXY";

export const otherToken = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp_Oo-NnMmLlK";

export const contactId = "0195f0a0-1111-4222-8333-44444444c001";

export const listId = "0195f0a0-1111-4222-8333-44444444109e";

export const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

export const keyId = "0195f0a0-1111-4222-8333-44444444ce01";

export const createdAt = "2026-09-11T10:00:00.000Z";

export const confirmUrl = "https://www.example.com/newsletter/confirm";

export const textBody = "Hello there";

export const readers: Schemas.ContactList = { id: listId, name: "Readers", createdAt };

export const draft: Schemas.Campaign = {
  id: campaignId,
  listId,
  subject: "Release notes",
  text: "Old text",
  html: "<p>Old</p>",
  createdAt,
  submission: { state: "draft" },
  filter: { plan: "pro" },
};

/** What the fake service holds before a test runs, and how its endpoints fail. */
interface Seed {
  readonly contacts?: ReadonlyArray<Schemas.Contact>;
  readonly lists?: ReadonlyArray<Schemas.ContactList>;
  /** The members of `listId`, in order. */
  readonly members?: ReadonlyArray<Schemas.Contact>;
  readonly campaigns?: ReadonlyArray<Schemas.Campaign>;
  /** Errors `campaigns delete` answers with, one per call, before it succeeds. */
  readonly removeFailures?: ReadonlyArray<Errors.CampaignStateConflict>;
  /** Errors `lists import` answers with, one per call, before it succeeds. */
  readonly importFailures?: ReadonlyArray<Errors.StorageUnavailable>;
}

/** One request the service received: which endpoint, and what it carried. */
interface Received {
  readonly endpoint: string;
  readonly params?: unknown;
  readonly query?: unknown;
  readonly payload?: unknown;
}

/**
 * The real API contract served from seeded state. It answers each request from what a test seeded
 * and records it; it does not re-implement the service's transitions, which the backend suites
 * prove. Every request is decoded against the real contract, so what the CLI sends is checked there.
 */
export const fakeService = (seed: Seed = {}) => {
  const authorizations: Array<string> = [];
  const received: Array<Received> = [];
  const contacts = new Map((seed.contacts ?? []).map((contact) => [contact.id, contact]));
  const lists = new Map((seed.lists ?? []).map((list) => [list.id, list]));
  const campaigns = new Map((seed.campaigns ?? []).map((campaign) => [campaign.id, campaign]));
  const members = seed.members ?? [];
  const removeFailures = [...(seed.removeFailures ?? [])];
  const importFailures = [...(seed.importFailures ?? [])];
  let imported = 0;

  const receive = (endpoint: string, request: Omit<Received, "endpoint"> = {}) =>
    Effect.sync(() => {
      received.push({ endpoint, ...request });
    });

  /** The next scripted failure, if one is left. */
  const next = <E>(failures: Array<E>) =>
    Effect.suspend(() => {
      const failure = failures.shift();

      return failure === undefined ? Effect.void : Effect.fail(failure);
    });

  const found = <A, E>(value: A | undefined, missing: E) =>
    value === undefined ? Effect.fail(missing) : Effect.succeed(value);

  const unused = (endpoint: string) => () =>
    Effect.die(new Error(`${endpoint} is not exercised by these tests`));

  const authorization = Layer.succeed(AdminAuthorization)(
    AdminAuthorization.of({
      bearer: (httpEffect, options) => {
        const credential = Redacted.value(options.credential);

        authorizations.push(credential);

        return credential === token ? httpEffect : Effect.fail(new Errors.Unauthorized());
      },
    }),
  );

  const contactsGroup = HttpApiBuilder.group(EmailerApi, "contacts", (handlers) =>
    handlers.handleAll({
      create: (request) =>
        receive("contacts.create", { payload: request.payload }).pipe(
          Effect.as({ id: contactId, ...request.payload, createdAt }),
        ),
      get: (request) =>
        receive("contacts.get", { params: request.params }).pipe(
          Effect.andThen(found(contacts.get(request.params.id), new Errors.ContactNotFound())),
        ),
      list: (request) =>
        receive("contacts.list", { query: request.query }).pipe(
          Effect.as({ items: [...contacts.values()] }),
        ),
      update: (request) =>
        receive("contacts.update", { params: request.params, payload: request.payload }).pipe(
          Effect.andThen(found(contacts.get(request.params.id), new Errors.ContactNotFound())),
        ),
      getByEmail: unused("contacts.getByEmail"),
      remove: unused("contacts.remove"),
    }),
  );

  const listsGroup = HttpApiBuilder.group(EmailerApi, "lists", (handlers) =>
    handlers.handleAll({
      create: unused("lists.create"),
      get: (request) =>
        receive("lists.get", { params: request.params }).pipe(
          Effect.andThen(found(lists.get(request.params.id), new Errors.ListNotFound())),
        ),
      list: (request) =>
        receive("lists.list", { query: request.query }).pipe(
          Effect.as({ items: [...lists.values()] }),
        ),
      update: (request) =>
        receive("lists.update", { params: request.params, payload: request.payload }).pipe(
          Effect.andThen(found(lists.get(request.params.id), new Errors.ListNotFound())),
          Effect.map((list) => ({ ...list, name: request.payload.name })),
        ),
      remove: (request) => receive("lists.remove", { params: request.params }),
      listMembers: (request) =>
        receive("lists.listMembers", { params: request.params, query: request.query }).pipe(
          Effect.andThen(found(lists.get(request.params.listId), new Errors.ListNotFound())),
          Effect.map(() => {
            const limit = request.query.limit ?? Schemas.defaultPageSize;
            const page = members.slice(0, limit);
            const last = page.at(-1);

            // Like DynamoDB behind the real service, a full page reports a cursor.
            return page.length === limit && last !== undefined
              ? { items: page, nextCursor: last.id }
              : { items: page };
          }),
        ),
      addContact: (request) => receive("lists.addContact", { params: request.params }),
      removeContact: (request) => receive("lists.removeContact", { params: request.params }),
      import: (request) =>
        receive("lists.import", { params: request.params, payload: request.payload }).pipe(
          Effect.andThen(next(importFailures)),
          Effect.andThen(found(lists.get(request.params.listId), new Errors.ListNotFound())),
          Effect.map(() => ({
            contacts: request.payload.contacts.map((entry) => {
              imported += 1;

              return {
                email: entry.email,
                contactId: `0195f0a0-1111-4222-8333-4444444d${String(imported).padStart(4, "0")}`,
                member: true,
              };
            }),
          })),
        ),
    }),
  );

  const campaign = (id: string) => found(campaigns.get(id), new Errors.CampaignNotFound());

  const campaignsGroup = HttpApiBuilder.group(EmailerApi, "campaigns", (handlers) =>
    handlers.handleAll({
      create: (request) =>
        receive("campaigns.create", { payload: request.payload }).pipe(
          Effect.as({
            id: campaignId,
            ...request.payload,
            createdAt,
            submission: { state: "draft" },
          }),
        ),
      get: (request) =>
        receive("campaigns.get", { params: request.params }).pipe(
          Effect.andThen(campaign(request.params.id)),
        ),
      list: (request) =>
        receive("campaigns.list", { query: request.query }).pipe(
          Effect.as({ items: [...campaigns.values()] }),
        ),
      update: (request) =>
        receive("campaigns.update", { params: request.params, payload: request.payload }).pipe(
          Effect.andThen(campaign(request.params.id)),
        ),
      remove: (request) =>
        receive("campaigns.remove", { params: request.params }).pipe(
          Effect.andThen(next(removeFailures)),
        ),
      preview: (request) =>
        receive("campaigns.preview", { params: request.params }).pipe(
          Effect.as({
            url: `https://preview.example/previews/${request.params.id}`,
            expiresAt: "2026-09-12T10:00:00.000Z",
          }),
        ),
      test: (request) =>
        receive("campaigns.test", { params: request.params, payload: request.payload }).pipe(
          Effect.as({
            recipients: ("to" in request.payload
              ? request.payload.to
              : members.map((member) => member.email)
            ).map((email, index) => ({
              email,
              outcome: "accepted" as const,
              messageId: `message-${index + 1}`,
            })),
          }),
        ),
      send: (request) =>
        receive("campaigns.send", { params: request.params }).pipe(
          Effect.andThen(campaign(request.params.id)),
        ),
      resume: (request) =>
        receive("campaigns.resume", { params: request.params }).pipe(
          Effect.andThen(campaign(request.params.id)),
        ),
      schedule: (request) =>
        receive("campaigns.schedule", { params: request.params, payload: request.payload }).pipe(
          Effect.andThen(campaign(request.params.id)),
        ),
      cancel: (request) =>
        receive("campaigns.cancel", { params: request.params }).pipe(
          Effect.andThen(campaign(request.params.id)),
        ),
    }),
  );

  const addressesGroup = HttpApiBuilder.group(EmailerApi, "addresses", (handlers) =>
    handlers.handleAll({
      // The two answer differently so a test can tell which endpoint the CLI called.
      status: (request) =>
        receive("addresses.status", { query: request.query }).pipe(
          Effect.as({
            email: request.query.email,
            status: "suppressed" as const,
            optOuts: [listId],
            suppression: { reason: "bounce" as const, suppressedAt: createdAt },
            transientBounces: [],
            accountSuppression: { reason: "bounce" as const, lastUpdateTime: createdAt },
          }),
        ),
      unsuppress: (request) =>
        receive("addresses.unsuppress", { payload: request.payload }).pipe(
          Effect.as({
            email: request.payload.email,
            status: "mailable" as const,
            optOuts: [],
            transientBounces: [],
            accountSuppression: null,
          }),
        ),
    }),
  );

  const keysGroup = HttpApiBuilder.group(EmailerApi, "keys", (handlers) =>
    handlers.handleAll({
      create: (request) =>
        receive("keys.create", { payload: request.payload }).pipe(
          Effect.as({ id: keyId, ...request.payload, createdAt, key: `emk.${keyId}.${token}` }),
        ),
      list: () =>
        receive("keys.list").pipe(
          Effect.as([{ id: keyId, name: "Website", lists: [listId], confirmUrl, createdAt }]),
        ),
      revoke: (request) => receive("keys.revoke", { params: request.params }),
    }),
  );

  const routes = HttpApiBuilder.layer(EmailerApi).pipe(
    Layer.provide(
      Layer.mergeAll(contactsGroup, listsGroup, campaignsGroup, addressesGroup, keysGroup),
    ),
    Layer.provide(authorization),
    Layer.provide(HttpServer.layerServices),
  );

  /** What each call of one endpoint carried as its payload, in order. */
  const payloadsOf = (endpoint: string) =>
    received.flatMap((request) => (request.endpoint === endpoint ? [request.payload] : []));

  return { routes, authorizations, received, payloadsOf };
};

export type FakeService = ReturnType<typeof fakeService>;

/**
 * A terminal that answers a prompt with `answer`, one key press, or with nothing at all, as a
 * closed stdin does. What a prompt displays is collected rather than written anywhere.
 */
const scriptedTerminal = (answer: string | undefined, displayed: Array<string>) =>
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.gen(function* () {
      const input = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();

      if (answer !== undefined) {
        yield* Queue.offer(input, {
          input: Option.some(answer),
          key: { name: answer, ctrl: false, meta: false, shift: false },
        });
      }

      yield* Queue.end(input);

      return input;
    }),
    readLine: Effect.fail(new Terminal.QuitError()),
    display: (text) =>
      Effect.sync(() => {
        displayed.push(text);
      }),
  });

interface CliRun {
  readonly exit: Exit.Exit<void, unknown>;
  readonly stdout: string;
  readonly stderr: string;
  /** What prompts displayed, which the real CLI writes to stderr. */
  readonly prompted: string;
}

interface CliOptions {
  readonly credential?: string;
  /** Configuration besides the service's URL and the credential. */
  readonly env?: Readonly<Record<string, string>>;
  /** The key a prompt is answered with; without one, stdin is closed. */
  readonly answer?: string;
}

/**
 * Runs the command in this process, as `main.ts` runs it, against the fake service: its requests
 * go to the service's routes directly, its console is captured, and failures are reported the
 * way the executable reports them. What only a process shows — exit codes and which stream the
 * real terminal writes to — is `Emailer.test.ts`'s.
 */
export const runCli = (
  service: FakeService,
  args: ReadonlyArray<string>,
  options: CliOptions = {},
) =>
  Effect.gen(function* () {
    const { handler, dispose } = HttpRouter.toWebHandler(service.routes, { disableLogger: true });

    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const displayed: Array<string> = [];

    const exit = yield* Command.runWith(emailer, { version: "0.0.0" })(args).pipe(
      reporting,
      Effect.provideService(Terminal.Terminal, scriptedTerminal(options.answer, displayed)),
      Effect.provide(NodeServices.layer),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
        handler(new Request(input, init)),
      ),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          EMAILER_API_URL: "http://emailer.test",
          EMAILER_API_TOKEN: options.credential ?? token,
          ...options.env,
        }),
      ),
      Effect.exit,
    );

    const run: CliRun = {
      exit,
      stdout: (yield* TestConsole.logLines).join("\n"),
      stderr: (yield* TestConsole.errorLines).join("\n"),
      prompted: displayed.join(""),
    };

    return run;
  }).pipe(Effect.provide(TestConsole.layer), Effect.scoped);

export const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const toJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** A file for the CLI to read through a flag, removed when the enclosing scope closes. */
export const tempFile = (extension: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.makeTempFileScoped({ suffix: `.${extension}` });

    yield* fs.writeFileString(file, contents);

    return file;
  }).pipe(Effect.provide(NodeServices.layer));

interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** Runs the real executable, for what only a process shows: exit codes and output streams. */
export const runProcess = (
  baseUrl: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: Readonly<Record<string, string>>; readonly stdin?: string } = {},
): Effect.Effect<ProcessResult, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const command = ChildProcess.make("node", [main, ...args], {
      extendEnv: true,
      stdin: Stream.encodeText(Stream.make(options.stdin ?? "")),
    }).pipe(
      ChildProcess.setEnv({ EMAILER_API_URL: baseUrl, EMAILER_API_TOKEN: token, ...options.env }),
    );

    const handle = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, exitCode: Number(exitCode) };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Serves the fake service on a local port for the executable to reach. */
export const withServer = <A, E>(
  service: FakeService,
  use: (baseUrl: string) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    yield* HttpServer.serveEffect(yield* HttpRouter.toHttpEffect(service.routes));

    const baseUrl = yield* HttpServer.addressFormattedWith((address) =>
      Effect.succeed(address.replace("0.0.0.0", "127.0.0.1")),
    );

    return yield* use(baseUrl);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
