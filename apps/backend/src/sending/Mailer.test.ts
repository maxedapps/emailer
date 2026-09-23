import * as Retry from "@distilled.cloud/aws/Retry";
import * as AWS from "alchemy/AWS";
import { fromCredentials } from "alchemy/AWS/Credentials";
import { Cause, ConfigProvider, Effect, Exit, Layer, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import {
  belongsToIdentity,
  footerFor,
  htmlFooterFor,
  mailerAddresses,
  makeSubmit,
  SenderNotOnIdentity,
  SubmissionUncertain,
} from "./Mailer.ts";

import type { OutgoingMessage } from "./Mailer.ts";

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

const unsubscribeUrl = "https://unsub.lambda-url.eu-central-1.on.aws/unsubscribe/token";

const postalAddress = "Example GmbH, Example Street 1, 12345 Example City, Germany";

const message: OutgoingMessage = {
  recipient: "max@example.com",
  subject: "Grüße 😀",
  text: "Hallo\n\nZeile zwei — ende",
  html: undefined,
  unsubscribeUrl,
  campaignId: "0195f0a0-1111-4222-8333-4444444ca409",
  sendId: "0195f0a0-1111-4222-8333-44444444e5d1",
};

const submitting = (transport: Transport, outgoing: OutgoingMessage = message) =>
  Effect.gen(function* () {
    const send = yield* AWS.SES.SendEmail(identity, configurationSet);

    return yield* Effect.result(makeSubmit(send, "news@example.com", postalAddress)(outgoing));
  }).pipe(Effect.provide(sendEmailLayer(transport)));

const acceptedBody = JSON.stringify({ MessageId: "0100018f-deadbeef" });

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

describe("makeSubmit", () => {
  it("submits one message with one recipient, the exact content and the bound configuration set", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, acceptedBody));

        const outcome = yield* submitting(transport);

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
            { Name: "campaignId", Value: message.campaignId },
            { Name: "sendId", Value: message.sendId },
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

        const outcome = yield* submitting(transport, { ...message, html });

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
            { Name: "campaignId", Value: message.campaignId },
            { Name: "sendId", Value: message.sendId },
          ],
          ConfigurationSetName: "emailer-mail",
        });
      }),
    ));

  it("inserts the HTML footer before an uppercase closing body tag", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, acceptedBody));
        const html = "<HTML><BODY><p>Hallo</p></BODY></HTML>";

        yield* submitting(transport, { ...message, html });

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
                  Data: `<HTML><BODY><p>Hallo</p>${htmlFooterFor(unsubscribeUrl, postalAddress)}</BODY></HTML>`,
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
            { Name: "campaignId", Value: message.campaignId },
            { Name: "sendId", Value: message.sendId },
          ],
          ConfigurationSetName: "emailer-mail",
        });
      }),
    ));

  it("inserts the HTML footer before </body> when the document contains İ", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, acceptedBody));
        const html = "<html><body>İçerik</body></html>";

        yield* submitting(transport, { ...message, html });

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
                  Data: `<html><body>İçerik${htmlFooterFor(unsubscribeUrl, postalAddress)}</body></html>`,
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
            { Name: "campaignId", Value: message.campaignId },
            { Name: "sendId", Value: message.sendId },
          ],
          ConfigurationSetName: "emailer-mail",
        });
      }),
    ));

  it("appends the HTML footer when the document has no closing body tag", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, acceptedBody));
        const html = "<p>Hallo</p>";

        yield* submitting(transport, { ...message, html });

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
                  Data: `${html}${htmlFooterFor(unsubscribeUrl, postalAddress)}`,
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
            { Name: "campaignId", Value: message.campaignId },
            { Name: "sendId", Value: message.sendId },
          ],
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

        const outcome = yield* submitting(transport);

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

        const outcome = yield* submitting(transport);

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

        const outcome = yield* submitting(transport);

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

        const outcome = yield* submitting(transport);

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

        const outcome = yield* submitting(transport);

        expect(Result.isFailure(outcome) && outcome.failure.reason).toBe("transport");
        expect(transport.sent).toHaveLength(1);
      }),
    ));

  it("keeps an acceptance without a MessageId uncertain", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() => awsJson(200, JSON.stringify({})));

        const outcome = yield* submitting(transport);

        expect(Result.isFailure(outcome) && outcome.failure.reason).toBe("malformed-response");
      }),
    ));

  it("does not put the message body or credentials in the failure it reports", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = transportReplying(() =>
          awsJson(500, JSON.stringify({ message: "we broke" })),
        );

        const outcome = yield* submitting(transport);
        const rendered = String(Result.isFailure(outcome) ? outcome.failure : "");

        expect(rendered).not.toContain(message.text);
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

describe("belongsToIdentity", () => {
  it("accepts an address whose domain is the identity", () => {
    expect(belongsToIdentity("no-reply@example.com", "example.com")).toBe(true);
  });

  it("accepts an address on a subdomain of the identity", () => {
    expect(belongsToIdentity("no-reply@mail.example.com", "example.com")).toBe(true);
  });

  it("refuses a domain that merely ends with the identity's characters", () => {
    expect(belongsToIdentity("no-reply@notexample.com", "example.com")).toBe(false);
  });

  it("refuses an unrelated domain", () => {
    expect(belongsToIdentity("no-reply@other.example.net", "example.com")).toBe(false);
  });

  it("refuses an address on the parent of a subdomain identity", () => {
    expect(belongsToIdentity("emailer-test@example.com", "mail.example.com")).toBe(false);
  });
});

describe("footerFor", () => {
  // The literal, not a composition of the same interpolations: asserting only
  // that the link and the address appear somewhere would pass if the two were
  // swapped, and every message would then label the postal address as the
  // unsubscribe link.
  it("labels the link and separates itself from the campaign body", () => {
    expect(footerFor(unsubscribeUrl, postalAddress)).toBe(
      `\n\n---\nUnsubscribe from these emails: ${unsubscribeUrl}\n\n${postalAddress}`,
    );
  });
});

describe("htmlFooterFor", () => {
  it("labels the link and the postal address as HTML paragraphs", () => {
    const postal = `Acme & Co <"O'Reilly">`;

    expect(htmlFooterFor(unsubscribeUrl, postal)).toBe(
      `<p>Unsubscribe from these emails: <a href="${unsubscribeUrl}">${unsubscribeUrl}</a></p><p>Acme &amp; Co &lt;&quot;O&#39;Reilly&quot;&gt;</p>`,
    );
  });
});

describe("mailerAddresses", () => {
  const resolving = (postal: string = postalAddress) =>
    Effect.result(mailerAddresses).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          EMAILER_SENDER_IDENTITY: "Example.COM",
          EMAILER_FROM_EMAIL: "no-reply@example.com",
          EMAILER_POSTAL_ADDRESS: postal,
        }),
      ),
    );

  it("refuses a blank postal address rather than sending non-compliant mail", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(Result.isFailure(yield* resolving("   "))).toBe(true);
      }),
    ));

  it("trims the configured postal address", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* resolving(`  ${postalAddress}  `);

        expect(Result.isSuccess(outcome) && outcome.success.postalAddress).toBe(postalAddress);
      }),
    ));

  it("dies when the From address is not on the identity", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(mailerAddresses).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({
              EMAILER_SENDER_IDENTITY: "mail.example.com",
              EMAILER_FROM_EMAIL: "emailer-test@example.com",
              EMAILER_POSTAL_ADDRESS: postalAddress,
            }),
          ),
        );

        if (!Exit.isFailure(exit)) {
          throw new Error("Expected mailerAddresses to die");
        }

        const defect = Cause.findDefect(exit.cause);

        expect(Result.isSuccess(defect) && defect.success instanceof SenderNotOnIdentity).toBe(
          true,
        );
      }),
    ));
});
