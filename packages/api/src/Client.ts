import { Effect, type Redacted } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi";

import { Authorization, EmailerApi } from "./Api.ts";

const bearerLayer = (token: Redacted.Redacted) =>
  HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token)),
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
