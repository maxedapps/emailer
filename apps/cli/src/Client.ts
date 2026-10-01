import { makeEmailerClient } from "@emailer/api/Client";
import type { EmailerClient } from "@emailer/api/Client";
import * as Schemas from "@emailer/api/Schemas";
import { Array as Arr, Config, Console, Duration, Effect, Inspectable, Schedule } from "effect";
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

const emailerClient = Effect.fn("Client.emailerClient")(function* (
  transformClient: (client: HttpClient.HttpClient) => HttpClient.HttpClient,
) {
  const url = yield* Config.String("EMAILER_API_URL");
  const token = yield* Config.Redacted("EMAILER_API_TOKEN");

  return yield* makeEmailerClient(url, token, transformClient);
});

export const withClient = Effect.fn("Client.withClient")(function* <A, E>(
  use: (client: EmailerClient) => Effect.Effect<A, E>,
  options: { readonly retryTransient?: boolean } = {},
) {
  const client = yield* emailerClient(
    options.retryTransient === true
      ? (client) => retryingTransient(withDeadline(client))
      : withDeadline,
  );

  return yield* use(client);
}, Effect.provide(FetchHttpClient.layer));

export const report = <Value>(value: Value) => Console.log(Inspectable.toStringUnknown(value));

/**
 * Calls in flight at once. One list's member items share a DynamoDB partition, and past its limit
 * DynamoDB throttles the transactions and still bills their attempts. On the live gate, four calls
 * imported about 280 contacts a second with almost no throttling; eight were slower and used 38%
 * more write units (ADR-0025).
 */
const batchConcurrency = 4;

const progressStep = 1_000;

const count = (value: number) => value.toLocaleString("en-US");

/**
 * A file's contacts of any size go out in payloads of `maxBatchEntries`, several at once, with
 * progress on stderr. Each answer is the converged state of its batch, so the joined answers are the
 * file's, in file order, and running the same file again — after a failure too — changes nothing
 * it already did. `done` names what a confirmed batch did, as in "Imported 1,000 of 5,000".
 */
export const inBatches = <Entry, Answer extends { readonly contacts: ReadonlyArray<unknown> }, E>(
  entries: ReadonlyArray<Entry>,
  send: (client: EmailerClient, batch: ReadonlyArray<Entry>) => Effect.Effect<Answer, E>,
  done: string,
) => {
  const total = entries.length;
  let confirmed = 0;

  return withClient(
    (client) =>
      Effect.forEach(
        Arr.chunksOf(entries, Schemas.maxBatchEntries),
        (batch) =>
          send(client, batch).pipe(
            Effect.tap(() => {
              const before = confirmed;

              confirmed += batch.length;

              return Math.floor(confirmed / progressStep) > Math.floor(before / progressStep)
                ? Console.error(`${done} ${count(confirmed)} of ${count(total)} contacts`)
                : Effect.void;
            }),
          ),
        { concurrency: batchConcurrency },
      ),
    { retryTransient: true },
  ).pipe(
    Effect.map((answers) => answers.flatMap((answer): Answer["contacts"] => answer.contacts)),
    Effect.tapError(() =>
      Console.error(
        `Stopped with ${count(confirmed)} of ${count(total)} contacts confirmed; running the same file again is safe`,
      ),
    ),
  );
};
