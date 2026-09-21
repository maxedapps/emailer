import { Effect, type Redacted } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi";

import { Authorization, EmailerApi } from "./Api.ts";

const bearerLayer = (token: Redacted.Redacted) =>
  HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token)),
  );

export const makeEmailerClient = (baseUrl: string, token: Redacted.Redacted) =>
  HttpApiClient.make(EmailerApi, { baseUrl }).pipe(Effect.provide(bearerLayer(token)));

export type EmailerClient = Effect.Success<ReturnType<typeof makeEmailerClient>>;
