import { Cause, ConfigProvider, Effect, Exit, Option, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  DkimRecordsUnavailable,
  DmarcRequiresDnsMode,
  dkimRecords,
  dmarcRecord,
  dnsSettings,
  mailFromRecords,
} from "./SendingDns.ts";

describe("mailFromRecords", () => {
  it("publishes the regional SES feedback MX and the SPF record at the bounce subdomain", () => {
    expect(mailFromRecords("Mail.Example.com", "eu-west-1")).toStrictEqual([
      {
        id: "MailFromMx",
        type: "MX",
        name: "bounce.mail.example.com",
        host: "feedback-smtp.eu-west-1.amazonses.com",
        priority: 10,
      },
      {
        id: "MailFromSpf",
        type: "TXT",
        name: "bounce.mail.example.com",
        value: '"v=spf1 include:amazonses.com ~all"',
      },
    ]);
  });
});

describe("dmarcRecord", () => {
  it("publishes a monitoring-only policy that reports to the given address", () => {
    expect(dmarcRecord("Example.com", "dmarc@example.com")).toStrictEqual({
      id: "Dmarc",
      type: "TXT",
      name: "_dmarc.example.com",
      value: '"v=DMARC1; p=none; rua=mailto:dmarc@example.com"',
    });
  });
});

describe("dkimRecords", () => {
  const tokens = ["tokenone", "tokentwo", "tokenthree"];

  const failureOf = (outcome: Result.Result<unknown, DkimRecordsUnavailable>) =>
    Result.isFailure(outcome) ? outcome.failure.reason : undefined;

  it("points each token at the identity's own signing zone rather than a fixed one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const records = yield* dkimRecords("Mail.Example.com", {
          Tokens: tokens,
          SigningHostedZone: "dkim.us-west-2.amazonses.com",
        });

        expect(records).toStrictEqual([
          {
            id: "Dkim1",
            type: "CNAME",
            name: "tokenone._domainkey.mail.example.com",
            value: "tokenone.dkim.us-west-2.amazonses.com",
          },
          {
            id: "Dkim2",
            type: "CNAME",
            name: "tokentwo._domainkey.mail.example.com",
            value: "tokentwo.dkim.us-west-2.amazonses.com",
          },
          {
            id: "Dkim3",
            type: "CNAME",
            name: "tokenthree._domainkey.mail.example.com",
            value: "tokenthree.dkim.us-west-2.amazonses.com",
          },
        ]);
      }),
    ));

  it("refuses to guess a zone SES did not report", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* Effect.result(dkimRecords("example.com", { Tokens: tokens }));

        expect(failureOf(outcome)).toBe("no-signing-zone");
      }),
    ));

  it("refuses anything but Easy DKIM's three tokens", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const zone = "dkim.amazonses.com";

        const tooFew = yield* Effect.result(
          dkimRecords("example.com", { Tokens: tokens.slice(0, 2), SigningHostedZone: zone }),
        );

        const tooMany = yield* Effect.result(
          dkimRecords("example.com", { Tokens: [...tokens, "tokenfour"], SigningHostedZone: zone }),
        );

        expect([failureOf(tooFew), failureOf(tooMany)]).toStrictEqual([
          "unexpected-token-count",
          "unexpected-token-count",
        ]);
      }),
    ));
});

describe("dnsSettings", () => {
  const settingsFrom = (env: Record<string, string>) =>
    Effect.exit(dnsSettings).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
    );

  it("leaves DNS to the operator when no mode is set, including the example file's blank keys", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* settingsFrom({ EMAILER_DNS: "", EMAILER_DMARC_REPORT_EMAIL: "" });

        expect(
          Exit.isSuccess(exit) &&
            Option.isNone(exit.value.mode) &&
            Option.isNone(exit.value.reportEmail),
        ).toBe(true);
      }),
    ));

  it("reads a provider mode and a normalized report address", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* settingsFrom({
          EMAILER_DNS: "route53",
          EMAILER_DMARC_REPORT_EMAIL: " Reports@Example.com ",
        });

        expect(
          Exit.isSuccess(exit) && [
            Option.getOrUndefined(exit.value.mode),
            Option.getOrUndefined(exit.value.reportEmail),
          ],
        ).toStrictEqual(["route53", "Reports@example.com"]);
      }),
    ));

  it("rejects a provider it does not support", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* settingsFrom({ EMAILER_DNS: "godaddy" });

        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ));

  it("dies when a DMARC report address is set without a mode that would publish it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* settingsFrom({ EMAILER_DMARC_REPORT_EMAIL: "dmarc@example.com" });

        if (!Exit.isFailure(exit)) {
          throw new Error("Expected dnsSettings to die");
        }

        const defect = Cause.findDefect(exit.cause);

        expect(Result.isSuccess(defect) && defect.success instanceof DmarcRequiresDnsMode).toBe(
          true,
        );
      }),
    ));
});
