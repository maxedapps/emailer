import { NodeCrypto } from "@effect/platform-node";
import { EmailerApi } from "@emailer/api/Api";
import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Duration, Effect, Layer, Option, Redacted } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import * as Addresses from "../audience/Addresses.ts";
import * as Contacts from "../audience/Contacts.ts";
import * as Lists from "../audience/Lists.ts";
import { CampaignScheduleLive } from "../campaigns/CampaignSchedule.ts";
import * as Campaigns from "../campaigns/Campaigns.ts";
import { PreviewFunction, previewLink, previewSecret } from "../campaigns/Previews.ts";
import { sendTest } from "../campaigns/TestSends.ts";
import { UnsubscribeFunction, unsubscribeSecret } from "../consent/Unsubscribe.ts";
import { publicly } from "../Diagnostics.ts";
import { lambdaBasics } from "../Lambda.ts";
import { CampaignWakeLive } from "../sending/Dispatch.ts";
import { MailerLive } from "../sending/Mailer.ts";
import { SendGuardLive, SendPacingLive } from "../sending/SendGuard.ts";
import { AudienceStoreLive } from "../storage/Audience.ts";
import { CampaignStoreLive } from "../storage/Campaigns.ts";
import { apiToken, authorizationUsing } from "./Auth.ts";

/**
 * Cold starts and pagination keep this a bound to validate against, not a completion guarantee
 * for every request.
 */
const invocationTimeout = Duration.seconds(60);

const pageOf = (query: { readonly limit?: number | undefined }) =>
  query.limit ?? Schemas.defaultPageSize;

const contactsHandlers = HttpApiBuilder.group(EmailerApi, "contacts", (handlers) =>
  handlers.handleAll({
    create: (request) => publicly(Contacts.create(request.payload)),
    get: (request) => publicly(Contacts.get(request.params.id)),
    getByEmail: (request) => publicly(Contacts.getByEmail(request.query.email)),
    list: (request) => publicly(Contacts.list(pageOf(request.query), request.query.cursor)),
    update: (request) => publicly(Contacts.update(request.params.id, request.payload)),
    remove: (request) => publicly(Contacts.remove(request.params.id)),
  }),
);

const listsHandlers = HttpApiBuilder.group(EmailerApi, "lists", (handlers) =>
  handlers.handleAll({
    create: (request) => publicly(Lists.create(request.payload)),
    get: (request) => publicly(Lists.get(request.params.id)),
    list: (request) => publicly(Lists.list(pageOf(request.query), request.query.cursor)),
    update: (request) => publicly(Lists.rename(request.params.id, request.payload)),
    remove: (request) => publicly(Lists.remove(request.params.id)),
    listMembers: (request) =>
      publicly(
        Lists.listMembers(request.params.listId, pageOf(request.query), request.query.cursor),
      ),
    addContact: (request) =>
      publicly(Lists.addContact(request.params.listId, request.params.contactId)),
    removeContact: (request) =>
      publicly(Lists.removeContact(request.params.listId, request.params.contactId)),
    import: (request) => publicly(Lists.importContacts(request.params.listId, request.payload)),
  }),
);

const campaignsHandlers = HttpApiBuilder.group(EmailerApi, "campaigns", (handlers) =>
  handlers.handleAll({
    create: (request) => publicly(Campaigns.create(request.payload)),
    list: (request) => publicly(Campaigns.list(pageOf(request.query), request.query.cursor)),
    get: (request) => publicly(Campaigns.get(request.params.id)),
    update: (request) => publicly(Campaigns.update(request.params.id, request.payload)),
    remove: (request) => publicly(Campaigns.remove(request.params.id)),
    test: (request) => publicly(sendTest(request.params.id, request.payload)),
    preview: (request) =>
      publicly(
        Campaigns.get(request.params.id).pipe(
          Effect.andThen(previewLink(request.params.id).pipe(Effect.orDie)),
        ),
      ),
    send: (request) => publicly(Campaigns.send(request.params.id)),
    resume: (request) => publicly(Campaigns.resume(request.params.id)),
    schedule: (request) => publicly(Campaigns.schedule(request.params.id, request.payload.sendAt)),
    cancel: (request) => publicly(Campaigns.cancel(request.params.id)),
  }),
);

const addressesHandlers = HttpApiBuilder.group(EmailerApi, "addresses", (handlers) =>
  handlers.handleAll({
    status: (request) => publicly(Addresses.status(request.query.email)),
    unsuppress: (request) => publicly(Addresses.unsuppress(request.payload.email)),
  }),
);

const tooLarge = HttpServerResponse.text(
  JSON.stringify(new Schemas.PayloadTooLarge({ limitBytes: Schemas.maxRequestBytes })),
  { status: 413, contentType: "application/json" },
);

const oversizedBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const declared = request.headers["content-length"];

  if (declared !== undefined && Number(declared) > Schemas.maxRequestBytes) {
    return Option.some(tooLarge);
  }

  const body = yield* request.text;

  return Schemas.utf8ByteLength(body) > Schemas.maxRequestBytes
    ? Option.some(tooLarge)
    : Option.none<HttpServerResponse.HttpServerResponse>();
});

const apiProps = Effect.gen(function* () {
  const { logGroupName, ...basics } = yield* lambdaBasics("Api", "api");

  // Bare tags, not the inline class form: the inline form always builds when
  // yielded, which would run the public functions' props and init inside this
  // Lambda at every cold start. The value references record the dependency
  // edges, so declaration order in the Stack generator is irrelevant.
  const unsubscribe = yield* UnsubscribeFunction;
  const unsubscribeKey = yield* unsubscribeSecret;
  const preview = yield* PreviewFunction;
  const previewKey = yield* previewSecret;

  return {
    ...basics,
    main: import.meta.url,
    memorySize: 512,
    timeout: invocationTimeout,
    functionUrl: { authType: "NONE" },
    env: {
      EMAILER_LOG_GROUP: logGroupName,
      EMAILER_UNSUBSCRIBE_URL: unsubscribe.functionUrl,
      EMAILER_UNSUBSCRIBE_SECRET: unsubscribeKey.text,
      EMAILER_PREVIEW_URL: preview.functionUrl,
      EMAILER_PREVIEW_SECRET: previewKey.text,
    },
  } as const;
});

/**
 * Builds the application once and returns the per-invocation handler. Construction is instance
 * work and the handler is request work; keeping them apart is also what makes the request scope
 * visible, since only the returned effect runs inside it. Nothing request-specific is captured
 * here: the credential check reads the incoming request, and finalizers belong to the invocation's
 * own scope.
 */
export const makeApiHandler = (token: Redacted.Redacted<string>) =>
  Effect.map(
    HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(EmailerApi).pipe(
        Layer.provide(
          Layer.mergeAll(contactsHandlers, listsHandlers, campaignsHandlers, addressesHandlers),
        ),
        Layer.provide(authorizationUsing(token)),
        Layer.provide(HttpServer.layerServices),
      ),
    ),
    (handle) =>
      Effect.gen(function* () {
        const refused = yield* oversizedBody;

        if (Option.isSome(refused)) {
          return refused.value;
        }

        const response = yield* handle;

        return response.status === 401
          ? HttpServerResponse.setHeader(response, "www-authenticate", "Bearer")
          : response;
      }),
  );

/** Every service the handlers use, bound once per instance. */
const ApiLive = Layer.mergeAll(
  AudienceStoreLive,
  CampaignStoreLive,
  Addresses.AccountSuppressionLive,
  CampaignWakeLive,
  CampaignScheduleLive,
  MailerLive,
  SendGuardLive,
  SendPacingLive,
).pipe(Layer.provideMerge(NodeCrypto.layer));

export default class ApiFunction extends AWS.Lambda.Function<ApiFunction>()(
  "Api",
  apiProps,
  Effect.gen(function* () {
    const token = yield* Effect.orDie(apiToken);
    // Built here rather than per request: the services are instance-lifetime, and the built
    // context carries no request scope into the handler.
    const services = yield* Layer.build(ApiLive);
    const handle = yield* makeApiHandler(token);

    return { fetch: Effect.provideContext(handle, services) };
  }),
) {}
