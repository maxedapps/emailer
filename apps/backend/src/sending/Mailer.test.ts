import * as Retry from "@distilled.cloud/aws/Retry";
import * as AWS from "alchemy/AWS";
import { fromCredentials } from "alchemy/AWS/Credentials";
import { ConfigProvider, Effect, Layer, Redacted, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { mintToken } from "../consent/Unsubscribe.ts";
import { makeSend, SubmissionUncertain } from "./Mailer.ts";
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

const recipient = "max@example.com";

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

    return yield* Effect.result(
      makeSend(send, "news@example.com", postalAddress)(recipient, sent, purpose),
    );
  }).pipe(
    Effect.provide(sendEmailLayer(transport)),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({
        EMAILER_UNSUBSCRIBE_URL: `${unsubscribeBase}/`,
        EMAILER_UNSUBSCRIBE_SECRET: unsubscribeSecret,
      }),
    ),
  );

const acceptedBody = JSON.stringify({ MessageId: "0100018f-deadbeef" });

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

describe("makeSend", () => {
  it("submits one message with one recipient, the exact content and the bound configuration set", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, acceptedBody));

        const outcome = yield* sending(transport);

        expect(Result.isSuccess(outcome) && outcome.success).toStrictEqual({
          outcome: "accepted",
          messageId: "0100018f-deadbeef",
        });

        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0]?.method).toBe("POST");
        expect(transport.sent[0]?.url).toBe(
          "https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails",
        );

        const request = yield* parseJson(transport.sent[0]?.body ?? "{}");

        expect(request).toStrictEqual({
          FromEmailAddress: "news@example.com",
          Destination: { ToAddresses: ["max@example.com"] },
          Content: {
            Simple: {
              Subject: { Data: "Grüße 😀", Charset: "UTF-8" },
              Body: {
                Text: {
                  Data: `Hallo\n\nZeile zwei — ende${footerFor(unsubscribeUrl, postalAddress)}`,
                  Charset: "UTF-8",
                },
              },
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
      }),
    ));

  it("submits HTML with the footer before the closing body tag, the text footer, and the same headers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, acceptedBody));
        const html = "<html><body><p>Hallo</p></body></html>";

        const outcome = yield* sending(transport, { ...content, html });

        expect(Result.isSuccess(outcome) && outcome.success).toStrictEqual({
          outcome: "accepted",
          messageId: "0100018f-deadbeef",
        });

        const request = yield* parseJson(transport.sent[0]?.body ?? "{}");

        expect(request).toStrictEqual({
          FromEmailAddress: "news@example.com",
          Destination: { ToAddresses: ["max@example.com"] },
          Content: {
            Simple: {
              Subject: { Data: "Grüße 😀", Charset: "UTF-8" },
              Body: {
                Text: {
                  Data: `Hallo\n\nZeile zwei — ende${footerFor(unsubscribeUrl, postalAddress)}`,
                  Charset: "UTF-8",
                },
                Html: {
                  Data: `<html><body><p>Hallo</p>${htmlFooterFor(unsubscribeUrl, postalAddress)}</body></html>`,
                  Charset: "UTF-8",
                },
              },
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
      }),
    ));

  it("sends a test with the same content and headers but no message tags", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, acceptedBody));

        yield* sending(transport, content, { kind: "test" });

        const request = yield* parseJson(transport.sent[0]?.body ?? "{}");

        expect(request).toStrictEqual({
          FromEmailAddress: "news@example.com",
          Destination: { ToAddresses: ["max@example.com"] },
          Content: {
            Simple: {
              Subject: { Data: "Grüße 😀", Charset: "UTF-8" },
              Body: {
                Text: {
                  Data: `Hallo\n\nZeile zwei — ende${footerFor(unsubscribeUrl, postalAddress)}`,
                  Charset: "UTF-8",
                },
              },
              Headers: [
                { Name: "List-Unsubscribe", Value: `<${unsubscribeUrl}>` },
                { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
              ],
            },
          },
          ConfigurationSetName: "emailer-mail",
        });
      }),
    ));

  it("performs no HTTP call while the binding is being constructed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, acceptedBody));

        yield* AWS.SES.SendEmail(identity, configurationSet).pipe(
          Effect.provide(sendEmailLayer(transport)),
        );

        expect(transport.sent).toHaveLength(0);
      }),
    ));

  it("makes exactly one attempt when SES answers with a retryable throttle", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() =>
          awsJson(429, JSON.stringify({ message: "rate exceeded" }), "TooManyRequestsException"),
        );

        const outcome = yield* sending(transport);

        expect(Result.isSuccess(outcome) && outcome.success).toStrictEqual({
          outcome: "rejected",
          rejectionCode: "rate-limited",
        });
        expect(transport.sent).toHaveLength(1);
      }),
    ));

  it("would retry the same answer without the operation-local policy", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() =>
          awsJson(429, JSON.stringify({ message: "rate exceeded" }), "TooManyRequestsException"),
        );

        yield* Effect.gen(function* () {
          const send = yield* AWS.SES.SendEmail(identity, configurationSet);

          return yield* send({
            Destination: { ToAddresses: ["max@example.com"] },
            Content: { Simple: { Subject: { Data: "x" }, Body: { Text: { Data: "y" } } } },
          });
        }).pipe(
          Effect.provide(sendEmailLayer(transport)),
          Effect.timeout("2 seconds"),
          Effect.exit,
        );

        expect(transport.sent.length).toBeGreaterThan(1);
      }),
    ));

  it("treats a definitive refusal as a rejection with a bounded code", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() =>
          awsJson(400, JSON.stringify({ message: "not verified" }), "MessageRejected"),
        );

        const outcome = yield* sending(transport);

        expect(Result.isSuccess(outcome) && outcome.success).toStrictEqual({
          outcome: "rejected",
          rejectionCode: "message-rejected",
        });
        expect(transport.sent).toHaveLength(1);
      }),
    ));

  it("treats the common throttling error as a rejection, not as an uncertain outcome", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() =>
          awsJson(400, JSON.stringify({ message: "slow down" }), "ThrottlingException"),
        );

        const outcome = yield* sending(transport);

        expect(Result.isSuccess(outcome) && outcome.success).toStrictEqual({
          outcome: "rejected",
          rejectionCode: "rate-limited",
        });
        expect(transport.sent).toHaveLength(1);
      }),
    ));

  it("keeps an opaque server error uncertain rather than calling it a rejection", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() =>
          awsJson(500, JSON.stringify({ message: "we broke" })),
        );

        const outcome = yield* sending(transport);

        expect(Result.isFailure(outcome) ? outcome.failure : undefined).toBeInstanceOf(
          SubmissionUncertain,
        );
        expect(Result.isFailure(outcome) && outcome.failure.reason).toBe("transport");
      }),
    ));

  it("keeps a lost connection uncertain", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => {
          throw new TypeError("fetch failed: ECONNREFUSED");
        });

        const outcome = yield* sending(transport);

        expect(Result.isFailure(outcome) && outcome.failure.reason).toBe("transport");
        expect(transport.sent).toHaveLength(1);
      }),
    ));

  it("keeps an acceptance without a MessageId uncertain", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, JSON.stringify({})));

        const outcome = yield* sending(transport);

        expect(Result.isFailure(outcome) && outcome.failure.reason).toBe("malformed-response");
      }),
    ));

  it("does not put the message body or credentials in the failure it reports", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() =>
          awsJson(500, JSON.stringify({ message: "we broke" })),
        );

        const outcome = yield* sending(transport);
        const rendered = String(Result.isFailure(outcome) ? outcome.failure : "");

        expect(rendered).not.toContain(content.text);
        expect(rendered).not.toContain("not-a-real-secret");
      }),
    ));
});

describe("Retry.none", () => {
  it("is applied to the submission itself, not to the binding's construction", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() =>
          awsJson(429, JSON.stringify({ message: "rate exceeded" }), "TooManyRequestsException"),
        );

        yield* Effect.gen(function* () {
          const send = yield* AWS.SES.SendEmail(identity, configurationSet);

          return yield* send({
            Destination: { ToAddresses: ["max@example.com"] },
            Content: { Simple: { Subject: { Data: "x" }, Body: { Text: { Data: "y" } } } },
          }).pipe(Retry.none);
        }).pipe(Effect.provide(sendEmailLayer(transport)), Effect.exit);

        expect(transport.sent).toHaveLength(1);
      }),
    ));
});
