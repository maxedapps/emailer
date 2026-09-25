import { NodeCrypto } from "@effect/platform-node";
import { EmailerApi } from "@emailer/api/Api";
import * as Schemas from "@emailer/api/Schemas";
import * as AWS from "alchemy/AWS";
import { Duration, Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import * as Addresses from "../audience/Addresses.ts";
import * as Contacts from "../audience/Contacts.ts";
import * as Lists from "../audience/Lists.ts";
import { CampaignSchedule } from "../campaigns/CampaignSchedule.ts";
import * as Campaigns from "../campaigns/Campaigns.ts";
import { PreviewFunction, previewLink, previewSecret } from "../campaigns/Previews.ts";
import { sendTest } from "../campaigns/TestSends.ts";
import { UnsubscribeFunction, unsubscribeSecret } from "../consent/Unsubscribe.ts";
import { functionServicesLayer, lambdaBasics } from "../Lambda.ts";
import { respondingToFailures } from "../Reporting.ts";
import { CampaignWake } from "../sending/Dispatch.ts";
import { Mailer } from "../sending/Mailer.ts";
import { SendGuard } from "../sending/SendGuard.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { apiToken, authorizationUsing } from "./Auth.ts";

/**
 * Cold starts and pagination keep this a bound to validate against, not a completion guarantee
 * for every request.
 */
const invocationTimeout = Duration.seconds(60);

const pageOf = (query: { readonly limit?: number | undefined }) =>
  query.limit ?? Schemas.defaultPageSize;

const contactsHandlers = HttpApiBuilder.group(EmailerApi, "contacts", (handlers) =>
  Effect.gen(function* () {
    const audience = yield* AudienceStore;

    return handlers.handleAll({
      create: (request) => Contacts.create(request.payload),
      get: (request) => audience.getContact(request.params.id),
      getByEmail: (request) => audience.getContactByEmail(request.query.email),
      list: (request) => audience.listContacts(pageOf(request.query), request.query.cursor),
      update: (request) => audience.updateContact(request.params.id, request.payload),
      remove: (request) => audience.deleteContact(request.params.id),
    });
  }),
);

const listsHandlers = HttpApiBuilder.group(EmailerApi, "lists", (handlers) =>
  Effect.gen(function* () {
    const audience = yield* AudienceStore;

    return handlers.handleAll({
      create: (request) => Lists.create(request.payload),
      get: (request) => audience.getList(request.params.id),
      list: (request) => audience.listLists(pageOf(request.query), request.query.cursor),
      update: (request) => audience.renameList(request.params.id, request.payload.name),
      remove: (request) => audience.deleteList(request.params.id),
      listMembers: (request) =>
        audience.listMembers(request.params.listId, pageOf(request.query), request.query.cursor),
      addContact: (request) => Lists.addContact(request.params.listId, request.params.contactId),
      removeContact: (request) =>
        audience.removeMember(request.params.listId, request.params.contactId),
      import: (request) => Lists.importContacts(request.params.listId, request.payload),
    });
  }),
);

const campaignsHandlers = HttpApiBuilder.group(EmailerApi, "campaigns", (handlers) =>
  Effect.gen(function* () {
    const campaigns = yield* CampaignStore;

    return handlers.handleAll({
      create: (request) => Campaigns.create(request.payload),
      list: (request) => campaigns.listCampaigns(pageOf(request.query), request.query.cursor),
      get: (request) => campaigns.getCampaign(request.params.id),
      update: (request) => Campaigns.update(request.params.id, request.payload),
      remove: (request) => Campaigns.remove(request.params.id),
      test: (request) => sendTest(request.params.id, request.payload),
      // The campaign's control item is enough to know it exists; its body is not read.
      preview: (request) =>
        campaigns
          .getCampaignControl(request.params.id)
          .pipe(Effect.andThen(previewLink(request.params.id).pipe(Effect.orDie))),
      send: (request) => Campaigns.send(request.params.id),
      resume: (request) => Campaigns.resume(request.params.id),
      schedule: (request) => Campaigns.schedule(request.params.id, request.payload.sendAt),
      cancel: (request) => Campaigns.cancel(request.params.id),
    });
  }),
);

const addressesHandlers = HttpApiBuilder.group(EmailerApi, "addresses", (handlers) =>
  handlers.handleAll({
    status: (request) => Addresses.status(request.query.email),
    unsuppress: (request) => Addresses.unsuppress(request.payload.email),
  }),
);

const apiProps = Effect.gen(function* () {
  const basics = yield* lambdaBasics("Api", "api");

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
      EMAILER_UNSUBSCRIBE_URL: unsubscribe.functionUrl,
      EMAILER_UNSUBSCRIBE_SECRET: unsubscribeKey.text,
      EMAILER_PREVIEW_URL: preview.functionUrl,
      EMAILER_PREVIEW_SECRET: previewKey.text,
    },
  } as const;
});

/**
 * Builds the application once, from the services in context, and returns the per-invocation
 * handler. Construction is instance work and the handler is request work; keeping them apart is
 * also what makes the request scope visible, since only the returned effect runs inside it.
 * Nothing request-specific is captured here: the credential check reads the incoming request, and
 * finalizers belong to the invocation's own scope.
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
      handle.pipe(
        Effect.map((response) =>
          response.status === 401
            ? HttpServerResponse.setHeader(response, "www-authenticate", "Bearer")
            : response,
        ),
        respondingToFailures,
      ),
  );

/** Every service the handlers use, bound once per instance. */
const apiLayer = Layer.mergeAll(
  AudienceStore.layer,
  CampaignStore.layer,
  Addresses.AccountSuppression.layer,
  CampaignWake.layer,
  CampaignSchedule.layer,
  Mailer.layer,
  SendGuard.layer,
  functionServicesLayer,
).pipe(Layer.provideMerge(NodeCrypto.layer));

export default class ApiFunction extends AWS.Lambda.Function<ApiFunction>()(
  "Api",
  apiProps,
  Effect.gen(function* () {
    const token = yield* Effect.orDie(apiToken);
    // Built here rather than per request: the services are instance-lifetime, and the built
    // context carries no request scope into the handler.
    const services = yield* Layer.build(apiLayer);
    const handle = yield* makeApiHandler(token).pipe(Effect.provideContext(services));

    return { fetch: Effect.provideContext(handle, services) };
  }),
) {}
