import { Duration, Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { nowIso } from "../Identifiers.ts";
import { functionServicesLayer, lambdaBasics } from "../Lambda.ts";
import { respondingToFailures } from "../Reporting.ts";
import { UnsubscribeStore } from "../storage/Unsubscribe.ts";
import {
  UnsubscribeFunction,
  maxTokenLength,
  unsubscribeSecret,
  unsubscribeSigningKey,
  verifyToken,
} from "./Unsubscribe.ts";

const invocationTimeout = Duration.seconds(30);

const route = "/unsubscribe/:token";

const page = (heading: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
<body>
<h1>${heading}</h1>
${body}
</body>
</html>
`;

// The form posts to the current URL, so the token is never interpolated into
// markup and HTML escaping never enters the picture.
const confirmation = HttpServerResponse.html(
  page(
    "Unsubscribe",
    `<p>Confirm that you no longer want to receive these emails.</p>
<form method="post"><button type="submit">Unsubscribe me</button></form>`,
  ),
);

const confirmed = HttpServerResponse.html(
  page("You are unsubscribed", "<p>You will not receive these emails again.</p>"),
);

const notFound = HttpServerResponse.text(page("Link not valid", "<p>This link is not valid.</p>"), {
  status: 404,
  contentType: "text/html",
});

const tokenOf = Effect.map(HttpRouter.params, (params) => params["token"] ?? "");

// A GET must change nothing: scanners, link prefetchers and security products
// issue them, and RFC 8058's mechanism is the POST. Verifying is not acting —
// it reads no storage — and it is what stops a link whose signing key has since
// rotated from offering a button that cannot work. The key rotates whenever the
// stage is destroyed, so such links are ordinary rather than hypothetical.
const offerOptOut = HttpRouter.add(
  "GET",
  route,
  Effect.gen(function* () {
    const signingKey = yield* unsubscribeSigningKey;

    return Option.isNone(verifyToken(signingKey, yield* tokenOf)) ? notFound : confirmation;
  }),
);

const recordOptOut = HttpRouter.add(
  "POST",
  route,
  // No payload is declared and the body is never read, which is how both of
  // RFC 8058's permitted encodings are accepted without parsing either.
  Effect.gen(function* () {
    const storage = yield* UnsubscribeStore;
    const signingKey = yield* unsubscribeSigningKey;

    const presented = verifyToken(signingKey, yield* tokenOf);

    if (Option.isNone(presented)) {
      // This is the only unauthenticated surface in the system, so a refusal
      // that left no trace would make abuse of it invisible. The token is not
      // logged: it is the whole of the authorization.
      yield* Effect.logWarning("unsubscribe token refused", { reason: "signature" });

      return notFound;
    }

    // The token named the mailbox, so there is nothing left to resolve. No
    // contact is read, which is why no concurrent edit or deletion can change
    // where this opt-out lands or make the link stop working.
    yield* storage.unsubscribeAddress({
      email: presented.value,
      unsubscribedAt: yield* nowIso,
    });

    // The mailbox is the whole payload, so it is what must not be logged.
    yield* Effect.logInfo("unsubscribe honoured");

    // No storage or configuration failure is turned into a page. A provider
    // treats a 2xx from the one-click POST as the opt-out being honoured and
    // does not retry, so claiming success without a durable write would turn a
    // transient fault into a permanent one on the single interaction the
    // recipient gets. A failure reaches the boundary instead, which reports it
    // without the mailbox and answers an empty 500.
    return confirmed;
  }),
);

// The router's default parameter cap is 100 characters and the token is longer
// than that, so a capped route would answer every real link with a 404. The cap
// is derived from the token's own bound rather than picked, so widening the
// address schema widens the route with it instead of silently 404ing the links
// that grew past a literal.
const routerConfig = Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: maxTokenLength });

/** Built once, like the API's: an invocation answers a request, it does not assemble a router. */
export const makeUnsubscribeHandler = HttpRouter.toHttpEffect(
  Layer.mergeAll(offerOptOut, recordOptOut),
).pipe(Effect.map(respondingToFailures), Effect.provide(routerConfig));

const unsubscribeProps = Effect.gen(function* () {
  const basics = yield* lambdaBasics("Unsubscribe", "unsubscribe");

  const secret = yield* unsubscribeSecret;

  return {
    ...basics,
    main: import.meta.url,
    memorySize: 256,
    timeout: invocationTimeout,
    // Deliberately public: a mail provider posting a one-click opt-out presents
    // no credential, so AWS_IAM is not an option and the signed token is the
    // only authorization. Reserved concurrency is the one axis that leaves
    // unprotected — a Function URL has no rate limiting of its own — so cap it.
    // The cap also reserves, which is the point: a flood against the only
    // unauthenticated surface cannot starve the API or the feedback consumer.
    reservedConcurrentExecutions: 10,
    functionUrl: { authType: "NONE" },
    env: {
      EMAILER_UNSUBSCRIBE_SECRET: secret.text,
    },
  } as const;
});

export default UnsubscribeFunction.make(
  unsubscribeProps,
  Effect.gen(function* () {
    const services = yield* Layer.build(
      Layer.mergeAll(UnsubscribeStore.layer, functionServicesLayer),
    );

    return { fetch: Effect.provideContext(yield* makeUnsubscribeHandler, services) };
  }),
);
