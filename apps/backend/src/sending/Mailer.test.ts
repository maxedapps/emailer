import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import { describe, expect, it } from "@effect/vitest";
import * as AWS from "alchemy/AWS";
import { fromCredentials } from "alchemy/AWS/Credentials";
import { Effect, Layer, Logger, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { mintToken } from "../consent/Unsubscribe.ts";
import { makeSend } from "./Mailer.ts";
import { footerFor, htmlFooterFor } from "./Message.ts";

import type { SendPurpose } from "./Mailer.ts";
import type { MessageContent } from "./Message.ts";

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

interface Transport {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: Array<SentRequest>;
}

const transportReplying = (respond: (attempt: number) => Response): Transport => {
  const sent: Array<SentRequest> = [];

  const fetchStub: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);

    return request.text().then((body) => {
      sent.push({ url: request.url, method: request.method, body });

      return respond(sent.length);
    });
  };

  return { fetch: fetchStub, sent };
};

const awsJson = (status: number, body: string, errorType?: string) =>
  new Response(body, {
    status,
    headers:
      errorType === undefined
        ? { "content-type": "application/json" }
        : { "content-type": "application/json", "x-amzn-errortype": errorType },
  });

const credentials = fromCredentials(
  { accessKeyId: "AKIAEXAMPLEEXAMPLE00", secretAccessKey: "not-a-real-secret" },
  "eu-central-1",
);

const sendEmailLayer = (transport: Transport) =>
  Layer.provide(
    AWS.SES.SendEmailHttp,
    Layer.merge(
      credentials,
      Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, transport.fetch)),
    ),
  );

interface ResourceStandIn {
  readonly LogicalId: string;
}

const asResource = <Resource extends ResourceStandIn>(value: ResourceStandIn): Resource =>
  // SAFETY: outside a binding host the send binding reads only `LogicalId` and the one output each stand-in supplies.
  value as Resource;

const identityStandIn = {
  LogicalId: "EmailerSender",
  emailIdentity: Effect.succeed(Effect.succeed("news@example.com")),
};

const configurationSetStandIn = {
  LogicalId: "EmailerMail",
  configurationSetName: Effect.succeed(Effect.succeed("emailer-mail")),
};

const identity = asResource<AWS.SES.EmailIdentity>(identityStandIn);

const configurationSet = asResource<AWS.SES.ConfigurationSet>(configurationSetStandIn);

const unsubscribeBase = "https://unsub.lambda-url.eu-central-1.on.aws";

const unsubscribeSecret = "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4e5f60718293a4b5c6d7e8f90";

const recipient = "sam@example.com";

const unsubscribeUrl = `${unsubscribeBase}/unsubscribe/${mintToken(Redacted.make(unsubscribeSecret), recipient)}`;

const postalAddress = "Example GmbH, Example Street 1, 12345 Example City, Germany";

const content: MessageContent = {
  subject: "Grüße 😀",
  text: "Hallo\n\nZeile zwei — ende",
  html: undefined,
};

const campaignSend: SendPurpose = {
  kind: "campaign",
  campaignId: "0195f0a0-1111-4222-8333-4444444ca409",
  sendId: "0195f0a0-1111-4222-8333-44444444e5d1",
};

const sending = (
  transport: Transport,
  sent: MessageContent = content,
  purpose: SendPurpose = campaignSend,
) =>
  Effect.gen(function* () {
    const send = yield* AWS.SES.SendEmail(identity, configurationSet);

    return yield* makeSend(send, "news@example.com", postalAddress)(
      recipient,
      sent,
      unsubscribeUrl,
      purpose,
    );
  }).pipe(Effect.provide(sendEmailLayer(transport)));

/** Captures what a send logs, which is the only place an uncertain outcome says why. */
const loggedTo = (messages: Array<unknown>) =>
  Logger.layer([Logger.make((options) => messages.push(options.message))]);

const acceptedBody = JSON.stringify({ MessageId: "0100018f-deadbeef" });

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const textPart = {
  Data: `Hallo\n\nZeile zwei — ende${footerFor(unsubscribeUrl, postalAddress)}`,
  Charset: "UTF-8",
};

/** The exact SES request a campaign send of `content` makes, carrying the given body parts. */
const campaignRequest = (Body: sesv2.Body = { Text: textPart }) => ({
  FromEmailAddress: "news@example.com",
  Destination: { ToAddresses: ["sam@example.com"] },
  Content: {
    Simple: {
      Subject: { Data: "Grüße 😀", Charset: "UTF-8" },
      Body,
      Headers: [
        { Name: "List-Unsubscribe", Value: `<${unsubscribeUrl}>` },
        { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
      ],
    },
  },
  EmailTags: [
    { Name: "campaignId", Value: campaignSend.campaignId },
    { Name: "sendId", Value: campaignSend.sendId },
  ],
  ConfigurationSetName: "emailer-mail",
});

describe("makeSend", () => {
  it.effect(
    "submits one message with one recipient, the exact content and the bound configuration set",
    () =>
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, acceptedBody));

        const outcome = yield* sending(transport);

        expect(outcome).toStrictEqual({
          outcome: "accepted",
          messageId: "0100018f-deadbeef",
        });

        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0]?.method).toBe("POST");
        expect(transport.sent[0]?.url).toBe(
          "https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails",
        );
        expect(yield* parseJson(transport.sent[0]?.body ?? "{}")).toStrictEqual(campaignRequest());
      }),
  );

  it.effect(
    "submits HTML with the footer before the closing body tag, the text footer, and the same headers",
    () =>
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, acceptedBody));
        const html = "<html><body><p>Hallo</p></body></html>";

        const outcome = yield* sending(transport, { ...content, html });

        expect(outcome).toStrictEqual({
          outcome: "accepted",
          messageId: "0100018f-deadbeef",
        });
        expect(yield* parseJson(transport.sent[0]?.body ?? "{}")).toStrictEqual(
          campaignRequest({
            Text: textPart,
            Html: {
              Data: `<html><body><p>Hallo</p>${htmlFooterFor(unsubscribeUrl, postalAddress)}</body></html>`,
              Charset: "UTF-8",
            },
          }),
        );
      }),
  );

  it.effect("sends a test with the same content and headers but no message tags", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() => awsJson(200, acceptedBody));
      const { EmailTags: _campaignTags, ...testRequest } = campaignRequest();

      yield* sending(transport, content, { kind: "test" });

      expect(yield* parseJson(transport.sent[0]?.body ?? "{}")).toStrictEqual(testRequest);
    }),
  );

  it.effect("performs no HTTP call while the binding is being constructed", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() => awsJson(200, acceptedBody));

      yield* AWS.SES.SendEmail(identity, configurationSet).pipe(
        Effect.provide(sendEmailLayer(transport)),
      );

      expect(transport.sent).toHaveLength(0);
    }),
  );

  it.effect.each([
    {
      answer: "a retryable throttle",
      status: 429,
      errorType: "TooManyRequestsException",
      rejectionCode: "rate-limited",
    },
    {
      answer: "a definitive refusal",
      status: 400,
      errorType: "MessageRejected",
      rejectionCode: "message-rejected",
    },
    {
      answer: "the common throttling error",
      status: 400,
      errorType: "ThrottlingException",
      rejectionCode: "rate-limited",
    },
  ] as const)(
    "treats $answer ($errorType) as a $rejectionCode rejection after exactly one attempt",
    ({ status, errorType, rejectionCode }) =>
      Effect.gen(function* () {
        const transport = transportReplying(() =>
          awsJson(status, JSON.stringify({ message: "refused" }), errorType),
        );

        const outcome = yield* sending(transport);

        expect(outcome).toStrictEqual({ outcome: "rejected", rejectionCode });
        expect(transport.sent).toHaveLength(1);
      }),
  );

  // Live: Distilled's default retry backs off on the clock, so the retries this case counts
  // happen only as real time passes within its two-second bound.
  it.live("would retry the same answer without the operation-local policy", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() =>
        awsJson(429, JSON.stringify({ message: "rate exceeded" }), "TooManyRequestsException"),
      );

      yield* Effect.gen(function* () {
        const send = yield* AWS.SES.SendEmail(identity, configurationSet);

        return yield* send({
          Destination: { ToAddresses: ["sam@example.com"] },
          Content: { Simple: { Subject: { Data: "x" }, Body: { Text: { Data: "y" } } } },
        });
      }).pipe(Effect.provide(sendEmailLayer(transport)), Effect.timeout("2 seconds"), Effect.exit);

      expect(transport.sent.length).toBeGreaterThan(1);
    }),
  );

  it.effect("keeps an opaque server error uncertain rather than calling it a rejection", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() =>
        awsJson(500, JSON.stringify({ message: "we broke" })),
      );

      const outcome = yield* sending(transport);

      expect(outcome).toStrictEqual({ outcome: "uncertain" });
    }),
  );

  it.effect("keeps a lost connection uncertain", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      });

      const messages: Array<unknown> = [];
      const outcome = yield* sending(transport).pipe(Effect.provide(loggedTo(messages)));

      expect(outcome).toStrictEqual({ outcome: "uncertain" });
      expect(messages).toMatchObject([["submission uncertain", { reason: "transport" }]]);
      expect(transport.sent).toHaveLength(1);
    }),
  );

  it.effect("keeps an acceptance without a MessageId uncertain", () =>
    Effect.gen(function* () {
      const transport = transportReplying(() => awsJson(200, JSON.stringify({})));

      const messages: Array<unknown> = [];
      const outcome = yield* sending(transport).pipe(Effect.provide(loggedTo(messages)));

      expect(outcome).toStrictEqual({ outcome: "uncertain" });
      expect(messages).toMatchObject([["submission uncertain", { reason: "malformed-response" }]]);
    }),
  );

  it.effect.each([
    ["a campaign send", campaignSend],
    ["a test send", { kind: "test" } satisfies SendPurpose],
  ] as const)(
    "logs why %s ended uncertain, without the recipient's address, the body or credentials",
    ([_label, purpose]) =>
      Effect.gen(function* () {
        const transport = transportReplying(() =>
          awsJson(500, JSON.stringify({ message: `Unavailable while sending to ${recipient}` })),
        );

        const messages: Array<unknown> = [];

        const outcome = yield* sending(transport, content, purpose).pipe(
          Effect.provide(loggedTo(messages)),
        );

        expect(outcome).toStrictEqual({ outcome: "uncertain" });
        // Exact, so neither the address, the body nor a credential can be in it.
        expect(messages).toStrictEqual([
          ["submission uncertain", { ...purpose, reason: "transport", cause: "InternalError" }],
        ]);
      }),
  );
});
