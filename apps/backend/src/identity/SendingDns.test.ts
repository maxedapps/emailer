import { describe, expect, it } from "@effect/vitest";
import * as Output from "alchemy/Output";
import { Cause, ConfigProvider, Effect, Exit, Option, Result } from "effect";

import {
  DkimRecordsUnavailable,
  DmarcReports,
  IgnoredDnsSetting,
  dkimRecords,
  dmarcRecord,
  dmarcValue,
  dnsSettings,
  identitySpfRecord,
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

describe("dmarcValue", () => {
  it("states the policy and the report address", () => {
    expect([
      dmarcValue("none", "dmarc@example.com"),
      dmarcValue("reject", "0123abcd@dmarc-reports.cloudflare.net"),
    ]).toStrictEqual([
      '"v=DMARC1; p=none; rua=mailto:dmarc@example.com"',
      '"v=DMARC1; p=reject; rua=mailto:0123abcd@dmarc-reports.cloudflare.net"',
    ]);
  });
});

describe("dmarcRecord", () => {
  it("lives at the domain's lowercased _dmarc name", () => {
    expect(dmarcRecord("Example.com", "none", Output.asOutput("dmarc@example.com")).name).toBe(
      "_dmarc.example.com",
    );
  });
});

describe("identitySpfRecord", () => {
  it("publishes the given SPF policy at the From domain itself, not the bounce subdomain", () => {
    expect(identitySpfRecord("Example.com", "v=spf1 include:spf.example.net ~all")).toStrictEqual({
      id: "IdentitySpf",
      type: "TXT",
      name: "example.com",
      value: '"v=spf1 include:spf.example.net ~all"',
    });
  });
});

describe("dkimRecords", () => {
  const tokens = ["tokenone", "tokentwo", "tokenthree"];

  const failureOf = (outcome: Result.Result<unknown, DkimRecordsUnavailable>) =>
    Result.isFailure(outcome) ? outcome.failure.reason : undefined;

  it.effect("points each token at the identity's own signing zone rather than a fixed one", () =>
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
  );

  it.effect("refuses to guess a zone SES did not report", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(dkimRecords("example.com", { Tokens: tokens }));

      expect(failureOf(outcome)).toBe("no-signing-zone");
    }),
  );

  it.effect("refuses anything but Easy DKIM's three tokens", () =>
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
  );
});

describe("dnsSettings", () => {
  const settingsFrom = (env: Record<string, string>) =>
    Effect.exit(dnsSettings).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
    );

  const ignoredSettingOf = (exit: Exit.Exit<unknown, unknown>) => {
    if (!Exit.isFailure(exit)) {
      return undefined;
    }

    const defect = Cause.findDefect(exit.cause);

    return Result.isSuccess(defect) && defect.success instanceof IgnoredDnsSetting
      ? defect.success.setting
      : undefined;
  };

  it.effect(
    "leaves DNS to the operator when no mode is set, including the example file's blank keys",
    () =>
      Effect.gen(function* () {
        const exit = yield* settingsFrom({
          EMAILER_DNS: "",
          EMAILER_DMARC_REPORTS: "",
          EMAILER_DMARC_POLICY: "",
          EMAILER_IDENTITY_SPF: "",
        });

        expect(
          Exit.isSuccess(exit) && [
            Option.isNone(exit.value.mode),
            Option.isNone(exit.value.dmarc),
            Option.isNone(exit.value.identitySpf),
          ],
        ).toStrictEqual([true, true, true]);
      }),
  );

  it.effect("reports to a normalized mailbox under a monitoring-only policy by default", () =>
    Effect.gen(function* () {
      const exit = yield* settingsFrom({
        EMAILER_DNS: "route53",
        EMAILER_DMARC_REPORTS: " Reports@Example.com ",
      });

      expect(
        Exit.isSuccess(exit) && [
          Option.getOrUndefined(exit.value.mode),
          Option.getOrUndefined(exit.value.dmarc),
        ],
      ).toStrictEqual([
        "route53",
        { policy: "none", reports: DmarcReports.Mailbox({ address: "Reports@example.com" }) },
      ]);
    }),
  );

  it.effect("reads Cloudflare reports, an enforcing policy and a trimmed SPF record", () =>
    Effect.gen(function* () {
      const exit = yield* settingsFrom({
        EMAILER_DNS: "cloudflare",
        EMAILER_DMARC_REPORTS: "cloudflare",
        EMAILER_DMARC_POLICY: "quarantine",
        EMAILER_IDENTITY_SPF: " v=spf1 include:spf.example.net ~all ",
      });

      expect(
        Exit.isSuccess(exit) && [
          Option.getOrUndefined(exit.value.dmarc),
          Option.getOrUndefined(exit.value.identitySpf),
        ],
      ).toStrictEqual([
        { policy: "quarantine", reports: DmarcReports.Cloudflare() },
        "v=spf1 include:spf.example.net ~all",
      ]);
    }),
  );

  it.effect("fails on an SPF value that is not an SPF record", () =>
    Effect.gen(function* () {
      const exit = yield* settingsFrom({
        EMAILER_DNS: "cloudflare",
        EMAILER_IDENTITY_SPF: "include:spf.example.net",
      });

      expect(Exit.isFailure(exit) && ignoredSettingOf(exit) === undefined).toBe(true);
    }),
  );

  it.effect("dies on every setting that nothing would publish", () =>
    Effect.gen(function* () {
      const exits = yield* Effect.all([
        settingsFrom({ EMAILER_DMARC_REPORTS: "dmarc@example.com" }),
        settingsFrom({ EMAILER_IDENTITY_SPF: "v=spf1 ~all" }),
        settingsFrom({ EMAILER_DNS: "cloudflare", EMAILER_DMARC_POLICY: "reject" }),
        settingsFrom({ EMAILER_DNS: "route53", EMAILER_DMARC_REPORTS: "cloudflare" }),
      ]);

      expect(exits.map(ignoredSettingOf)).toStrictEqual([
        "EMAILER_DMARC_REPORTS",
        "EMAILER_IDENTITY_SPF",
        "EMAILER_DMARC_POLICY",
        "EMAILER_DMARC_REPORTS=cloudflare",
      ]);
    }),
  );
});
