import { Effect, Layer, type Redacted } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi";

import { AdminAuthorization, EmailerApi, SubscriptionAuthorization } from "./Api.ts";

/**
 * One credential for every endpoint: the server decides what it may reach, so an admin client and a
 * site's client differ only in the token they are given.
 */
const bearerLayer = (token: Redacted.Redacted) =>
  Layer.mergeAll(
    HttpApiMiddleware.layerClient(AdminAuthorization, ({ next, request }) =>
      next(HttpClientRequest.bearerToken(request, token)),
    ),
    HttpApiMiddleware.layerClient(SubscriptionAuthorization, ({ next, request }) =>
      next(HttpClientRequest.bearerToken(request, token)),
    ),
  );

export const makeEmailerClient = (
  baseUrl: string,
  token: Redacted.Redacted,
  transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient,
) =>
  HttpApiClient.make(EmailerApi, { baseUrl, transformClient }).pipe(
    Effect.provide(bearerLayer(token)),
  );

export type EmailerClient = Effect.Success<ReturnType<typeof makeEmailerClient>>;
