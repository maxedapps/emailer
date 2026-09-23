import { makeEmailerClient } from "@emailer/api/Client";
import type { EmailerClient } from "@emailer/api/Client";
import { Config, Console, Duration, Effect, Inspectable, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

/**
 * The CLI is the only thing that enforces a deadline on a request, so it is the only thing that
 * states one. It sits above the API function's sixty seconds so that a send which runs long is
 * answered by the service rather than abandoned by the caller, which would leave the outcome
 * unknown to the operator while the send completed anyway.
 */
const requestTimeout = Duration.seconds(70);

const emailerClient = Effect.gen(function* () {
  const url = yield* Config.string("EMAILER_API_URL");
  const token = yield* Config.redacted("EMAILER_API_TOKEN");

  return yield* makeEmailerClient(url, token);
});

export const withClient = <A>(
  use: (client: EmailerClient) => Effect.Effect<A, { readonly _tag: string }>,
) =>
  Effect.gen(function* () {
    const client = yield* emailerClient;

    return yield* use(client);
  }).pipe(Effect.timeout(requestTimeout), Effect.provide(Layer.mergeAll(FetchHttpClient.layer)));

export const report = <Value>(value: Value) => Console.log(Inspectable.toStringUnknown(value));
