import { makeEmailerClient } from "@emailer/api/Client";
import type { EmailerClient } from "@emailer/api/Client";
import { Config, Console, Duration, Effect, Inspectable, Schedule } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";

/**
 * The CLI is the only thing that enforces a deadline on a request, so it is the only thing that
 * states one. It sits above the API function's sixty seconds so that a send which runs long is
 * answered by the service rather than abandoned by the caller, which would leave the outcome
 * unknown to the operator while the send completed anyway.
 */
const requestTimeout = Duration.seconds(70);

/**
 * Each request gets the deadline, not the command: an import makes thousands of requests. A request
 * that misses it failed in transit as far as the caller can tell, so it fails as a transport error,
 * which keeps the client's error type and lets a retry see it as transient.
 */
const withDeadline = (client: HttpClient.HttpClient) =>
  HttpClient.transform(client, (response, request) =>
    Effect.timeoutOrElse(response, {
      duration: requestTimeout,
      orElse: () =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: `No response within ${Duration.format(requestTimeout)}`,
            }),
          }),
        ),
    }),
  );

/**
 * Transport failures, timeouts, and 408, 429 and 5xx answers — a 503 is a throttled or unavailable
 * dependency — are sent again: about two minutes of jittered, doubling waits from half a second.
 * Only calls that are safe to repeat opt in. The deadline sits inside, so it bounds each attempt
 * rather than cutting the retries short.
 */
const retryingTransient = (client: HttpClient.HttpClient) =>
  HttpClient.retryTransient(client, {
    schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
    times: 8,
  });

const emailerClient = (transformClient: (client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const url = yield* Config.String("EMAILER_API_URL");
    const token = yield* Config.Redacted("EMAILER_API_TOKEN");

    return yield* makeEmailerClient(url, token, transformClient);
  });

export const withClient = <A, E>(
  use: (client: EmailerClient) => Effect.Effect<A, E>,
  options: { readonly retryTransient?: boolean } = {},
) =>
  Effect.gen(function* () {
    const client = yield* emailerClient(
      options.retryTransient === true
        ? (client) => retryingTransient(withDeadline(client))
        : withDeadline,
    );

    return yield* use(client);
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const report = <Value>(value: Value) => Console.log(Inspectable.toStringUnknown(value));
