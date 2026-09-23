import { NodeCrypto } from "@effect/platform-node";
import { EmailerApi } from "@emailer/api/Api";
import * as Schemas from "@emailer/api/Schemas";
import { Stack } from "alchemy";
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
import { apiToken, authorizationUsing } from "./Auth.ts";
import { publicly } from "../Diagnostics.ts";
import { campaignSchedule } from "../campaigns/CampaignSchedule.ts";
import * as Campaigns from "../campaigns/Campaigns.ts";
import * as Contacts from "../audience/Contacts.ts";
import {
  dispatchQueue,
  encodeDispatchMessage,
  scheduleGroup,
  schedulerRole,
} from "../sending/Dispatch.ts";
import * as Lists from "../audience/Lists.ts";
import { AudienceStore, AudienceStoreLive } from "../storage/Audience.ts";
import { CampaignStore, CampaignStoreLive } from "../storage/Campaigns.ts";
import { unavailable } from "../storage/Errors.ts";
import { UnsubscribeFunction, unsubscribeSecret } from "../consent/Unsubscribe.ts";

const logRetention = Duration.days(7);

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
  const { stage } = yield* Stack;
  const functionName = `emailer-${stage}-api`;

  const logGroup = yield* AWS.Logs.LogGroup("ApiLogs", {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logRetention,
  });

  // The bare tag, not the inline class form: the inline form always builds when
  // yielded, which would run the unsubscribe function's props and init inside
  // this Lambda at every cold start. The value reference records the dependency
  // edge, so declaration order in the Stack generator is irrelevant.
  const unsubscribe = yield* UnsubscribeFunction;
  const secret = yield* unsubscribeSecret;

  return {
    functionName,
    main: import.meta.url,
    runtime: "nodejs24.x",
    architecture: "arm64",
    memorySize: 512,
    timeout: invocationTimeout,
    functionUrl: { authType: "NONE" },
    env: {
      EMAILER_LOG_GROUP: logGroup.logGroupName,
      EMAILER_UNSUBSCRIBE_URL: unsubscribe.functionUrl,
      EMAILER_UNSUBSCRIBE_SECRET: secret.text,
    },
  } as const;
});

/**
 * Builds the application once and returns the per-invocation handler.
 *
 * The router used to be assembled inside the request effect, so every invocation rebuilt the
 * whole API — handlers, middleware and all — before answering. Construction is instance work and
 * the handler is request work; separating them is also what makes the request scope visible,
 * since only the returned effect runs inside it. Nothing request-specific is captured here: the
 * credential check reads the incoming request, and finalizers belong to the invocation's own scope.
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

export default class ApiFunction extends AWS.Lambda.Function<ApiFunction>()(
  "Api",
  apiProps,
  Effect.gen(function* () {
    const audience = yield* AudienceStore;
    const campaigns = yield* CampaignStore;
    const token = yield* Effect.orDie(apiToken);
    const getSuppressedDestination = yield* AWS.SES.GetSuppressedDestination();
    const deleteSuppressedDestination = yield* AWS.SES.DeleteSuppressedDestination();

    // Yielding the source queue registers it; T4 only registered the dead-letter queue.
    const queue = yield* dispatchQueue;
    const sendMessage = yield* AWS.SQS.SendMessage(queue);
    const queueArn = yield* queue.queueArn;

    const role = yield* schedulerRole;
    const group = yield* scheduleGroup;
    const createSchedule = yield* AWS.Scheduler.CreateSchedule(role, group);
    const deleteSchedule = yield* AWS.Scheduler.DeleteSchedule(group);

    // Built once and handed to each invocation as a context rather than a Layer: the services are
    // instance-lifetime, so rebuilding them per request would be work the request did not need.
    const capabilities = yield* Layer.build(
      Layer.mergeAll(
        Layer.succeed(AudienceStore)(audience),
        Layer.succeed(CampaignStore)(campaigns),
        Layer.succeed(Addresses.AccountSuppression)({
          getSuppressedDestination,
          deleteSuppressedDestination,
        }),
        Layer.succeed(Campaigns.CampaignWake)({
          enqueue: (campaignId, runToken) =>
            encodeDispatchMessage({ campaignId, runToken }).pipe(
              Effect.orDie,
              Effect.flatMap((MessageBody) => sendMessage({ MessageBody })),
              Effect.mapError(unavailable("dispatch")),
              Effect.asVoid,
            ),
        }),
        Layer.succeed(Campaigns.CampaignSchedule)(
          campaignSchedule(createSchedule, deleteSchedule, queueArn),
        ),
        NodeCrypto.layer,
      ),
    );

    const handle = yield* makeApiHandler(token);

    return { fetch: Effect.provideContext(handle, capabilities) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AudienceStoreLive,
        CampaignStoreLive,
        AWS.SQS.SendMessageHttp,
        AWS.Scheduler.CreateScheduleHttp,
        AWS.Scheduler.DeleteScheduleHttp,
        AWS.SES.GetSuppressedDestinationHttp,
        AWS.SES.DeleteSuppressedDestinationHttp,
      ).pipe(Layer.provide(NodeCrypto.layer)),
    ),
  ),
) {}
