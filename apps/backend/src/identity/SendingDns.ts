import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Schemas from "@emailer/api/Schemas";
import { RemovalPolicy } from "alchemy";
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import { Config, Data, Effect, Match, Option, Schema } from "effect";

import type { Input } from "alchemy";

/**
 * DNS records of the sending identity, declared by the one-shot identity stack when `EMAILER_DNS`
 * names a provider. Deploy-time only: no Lambda imports this module, so neither the Cloudflare
 * provider nor the SES lookup below reaches a function bundle.
 */

export type DnsMode = "route53" | "cloudflare";

export const dnsMode = Config.option(Config.Literals(["route53", "cloudflare"], "EMAILER_DNS"));

export type DmarcPolicy = "none" | "quarantine" | "reject";

/** Where aggregate DMARC reports go: a mailbox, or Cloudflare DMARC Management on the zone. */
export type DmarcReports = Data.TaggedEnum<{
  Mailbox: { readonly address: string };
  Cloudflare: {};
}>;

export const DmarcReports = Data.taggedEnum<DmarcReports>();

export interface DmarcSettings {
  readonly policy: DmarcPolicy;
  readonly reports: DmarcReports;
}

/** A setting that would be silently ignored without the one it requires. */
export class IgnoredDnsSetting extends Data.TaggedError("IgnoredDnsSetting")<{
  readonly setting: string;
  readonly requires: string;
}> {}

const dmarcReportsConfig = Config.schema(
  Schema.Union([Schema.Literal("cloudflare"), Schemas.EmailAddress]),
  "EMAILER_DMARC_REPORTS",
);

const dmarcPolicyConfig = Config.Literals(["none", "quarantine", "reject"], "EMAILER_DMARC_POLICY");

const spfPattern = /^v=spf1( |$)/;

const identitySpfConfig = Config.schema(
  Schema.Trim.pipe(
    Schema.decodeTo(
      Schema.String.check(Schema.isPattern(spfPattern, { message: "Expected v=spf1 …" })),
    ),
  ),
  "EMAILER_IDENTITY_SPF",
);

/**
 * DMARC is a policy for the whole domain and often exists already, so the stack publishes it only
 * when `EMAILER_DMARC_REPORTS` names where its reports go — and only where it publishes the other
 * records. The From domain's own SPF record serves its other senders, so it too is opt-in. A
 * setting that would be silently ignored fails construction instead.
 */
export const dnsSettings = Effect.gen(function* () {
  const mode = yield* dnsMode;
  const reports = yield* Config.option(dmarcReportsConfig);
  const policy = yield* Config.option(dmarcPolicyConfig);
  const identitySpf = yield* Config.option(identitySpfConfig);

  const ignored = [
    {
      setting: "EMAILER_DMARC_REPORTS",
      requires: "EMAILER_DNS",
      when: Option.isSome(reports) && Option.isNone(mode),
    },
    {
      setting: "EMAILER_IDENTITY_SPF",
      requires: "EMAILER_DNS",
      when: Option.isSome(identitySpf) && Option.isNone(mode),
    },
    {
      setting: "EMAILER_DMARC_POLICY",
      requires: "EMAILER_DMARC_REPORTS",
      when: Option.isSome(policy) && Option.isNone(reports),
    },
    {
      setting: "EMAILER_DMARC_REPORTS=cloudflare",
      requires: "EMAILER_DNS=cloudflare",
      when: Option.contains(reports, "cloudflare") && !Option.contains(mode, "cloudflare"),
    },
  ].find(({ when }) => when);

  if (ignored !== undefined) {
    const { setting, requires } = ignored;

    return yield* Effect.die(new IgnoredDnsSetting({ setting, requires }));
  }

  const dmarc = Option.map(reports, (target): DmarcSettings => ({
    policy: Option.getOrElse(policy, (): DmarcPolicy => "none"),
    reports:
      target === "cloudflare"
        ? DmarcReports.Cloudflare()
        : DmarcReports.Mailbox({ address: target }),
  }));

  return { mode, dmarc, identitySpf };
});

export interface MxRecord {
  readonly id: string;
  readonly type: "MX";
  readonly name: string;
  readonly host: string;
  readonly priority: number;
}

export interface TextRecord {
  readonly id: string;
  readonly type: "CNAME" | "TXT";
  readonly name: string;
  readonly value: string;
}

/** A text record whose name and value may still be unresolved stack outputs. */
export interface TextRecordInput {
  readonly id: string;
  readonly type: "CNAME" | "TXT";
  readonly name: Input<string>;
  readonly value: Input<string>;
}

export type DnsRecord = MxRecord | TextRecordInput;

export type DkimRecords = readonly [TextRecord, TextRecord, TextRecord];

export const mailFromDomainOf = (domain: string): string => `bounce.${domain}`;

/** SES verifies only the MX; the SPF record is what makes `spf=pass` align. */
export const mailFromRecords = (
  domain: string,
  region: string,
): readonly [MxRecord, TextRecord] => {
  const name = mailFromDomainOf(domain).toLowerCase();

  return [
    {
      id: "MailFromMx",
      type: "MX",
      name,
      host: `feedback-smtp.${region}.amazonses.com`,
      priority: 10,
    },
    { id: "MailFromSpf", type: "TXT", name, value: '"v=spf1 include:amazonses.com ~all"' },
  ];
};

export const dmarcValue = (policy: DmarcPolicy, reportAddress: string): string =>
  `"v=DMARC1; p=${policy}; rua=mailto:${reportAddress}"`;

export const dmarcRecord = <Req>(
  domain: string,
  policy: DmarcPolicy,
  reportAddress: Output.Output<string, Req>,
): TextRecordInput => ({
  id: "Dmarc",
  type: "TXT",
  name: `_dmarc.${domain}`.toLowerCase(),
  value: reportAddress.pipe(Output.map((address: string) => dmarcValue(policy, address))),
});

/** The From domain's own SPF record, for the domain's other senders; SES uses `bounce.<domain>`. */
export const identitySpfRecord = (domain: string, value: string): TextRecord => ({
  id: "IdentitySpf",
  type: "TXT",
  name: domain.toLowerCase(),
  value: `"${value}"`,
});

export class DkimRecordsUnavailable extends Data.TaggedError("DkimRecordsUnavailable")<{
  readonly identity: string;
  readonly reason: "no-signing-zone" | "unexpected-token-count";
}> {}

/**
 * Easy DKIM's three CNAMEs. The target zone varies by Region and by identity, so it is read from
 * SES and never assumed.
 */
export const dkimRecords = (
  domain: string,
  attributes: sesv2.DkimAttributes | undefined,
): Effect.Effect<DkimRecords, DkimRecordsUnavailable> => {
  const zone = attributes?.SigningHostedZone;
  const [first, second, third, ...rest] = attributes?.Tokens ?? [];

  if (zone === undefined) {
    return Effect.fail(new DkimRecordsUnavailable({ identity: domain, reason: "no-signing-zone" }));
  }

  if (first === undefined || second === undefined || third === undefined || rest.length > 0) {
    return Effect.fail(
      new DkimRecordsUnavailable({ identity: domain, reason: "unexpected-token-count" }),
    );
  }

  const record = (id: string, token: string): TextRecord => ({
    id,
    type: "CNAME",
    name: `${token}._domainkey.${domain}`.toLowerCase(),
    value: `${token}.${zone}`,
  });

  return Effect.succeed([record("Dkim1", first), record("Dkim2", second), record("Dkim3", third)]);
};

/**
 * Looks the records up from SES whenever the stack resolves them, keyed on the identity's name.
 * That attribute is stable, so the records resolve at plan time even while the identity itself
 * updates — which keeps an existing record's adoption check in play.
 */
export const dkimRecordsOf = <Req>(emailIdentity: Output.Output<string, Req>) =>
  emailIdentity.pipe(
    Output.mapEffect((domain: string) =>
      sesv2.getEmailIdentity({ EmailIdentity: domain }).pipe(
        Effect.flatMap((identity) => dkimRecords(domain, identity.DkimAttributes)),
        Effect.orDie,
      ),
    ),
  );

/** One DKIM record of the looked-up set, as a declarable record whose parts are outputs. */
export const dkimRecordAt = <Req>(
  records: Output.Output<DkimRecords, Req>,
  index: 0 | 1 | 2,
): TextRecordInput => ({
  id: `Dkim${index + 1}`,
  type: "CNAME",
  name: records.pipe(Output.map((all) => all[index].name)),
  value: records.pipe(Output.map((all) => all[index].value)),
});

/** A bare number would be read as milliseconds. */
const route53Ttl = "300 seconds";

const publishToRoute53 = (record: DnsRecord) =>
  Match.value(record).pipe(
    Match.when({ type: "MX" }, (mx) =>
      AWS.Route53.Record(mx.id, {
        name: mx.name,
        type: "MX",
        ttl: route53Ttl,
        records: [`${mx.priority} ${mx.host}`],
      }),
    ),
    Match.orElse((text) =>
      AWS.Route53.Record(text.id, {
        name: text.name,
        type: text.type,
        ttl: route53Ttl,
        records: [text.value],
      }),
    ),
    RemovalPolicy.retain(),
    Effect.map((published) => published.name),
  );

const publishToCloudflare = (zoneId: string) => (record: DnsRecord) =>
  Match.value(record).pipe(
    Match.when({ type: "MX" }, (mx) =>
      Cloudflare.DNS.Record(mx.id, {
        zoneId,
        name: mx.name,
        type: "MX",
        content: mx.host,
        priority: mx.priority,
      }),
    ),
    Match.when({ type: "CNAME" }, (cname) =>
      Cloudflare.DNS.Record(cname.id, {
        zoneId,
        name: cname.name,
        type: "CNAME",
        content: cname.value,
        proxied: false,
      }),
    ),
    Match.orElse((txt) =>
      Cloudflare.DNS.Record(txt.id, { zoneId, name: txt.name, type: "TXT", content: txt.value }),
    ),
    RemovalPolicy.retain(),
    Effect.map((published) => published.name),
  );

const cloudflareZoneOf = (domain: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    return yield* Cloudflare.Zone.resolveZoneId({
      accountId,
      zone: undefined,
      hostname: domain.toLowerCase(),
    });
  }).pipe(Effect.orDie);

/**
 * Returns how to declare a record in the selected provider. Route 53 infers the hosted zone at
 * apply time; Cloudflare's zone is resolved here, once, so every record's props are plain strings
 * at plan time.
 */
export const publisherFor = (mode: DnsMode, domain: string) =>
  Match.value(mode).pipe(
    Match.when("route53", () => Effect.succeed(publishToRoute53)),
    Match.when("cloudflare", () => Effect.map(cloudflareZoneOf(domain), publishToCloudflare)),
    Match.exhaustive,
  );

class CloudflareReportAddressUnavailable extends Data.TaggedError(
  "CloudflareReportAddressUnavailable",
)<{
  readonly zoneId: string;
}> {}

/** The host Cloudflare DMARC Management receives reports at; it authorizes every zone it serves. */
const cloudflareReportHost = "dmarc-reports.cloudflare.net";

/**
 * Turns on Cloudflare DMARC Management for the zone and returns its report address. Enabling makes
 * Cloudflare add that address to the existing `_dmarc` record; the DMARC record, which waits for
 * the address, then writes the whole value, so the stack stays the record's only owner.
 */
const cloudflareReportAddress = (domain: string) =>
  Effect.gen(function* () {
    const zoneId = yield* cloudflareZoneOf(domain);

    const reports = yield* Cloudflare.Email.DmarcReports("DmarcReports", { zone: zoneId }).pipe(
      RemovalPolicy.retain(),
    );

    return reports.ruaPrefix.pipe(
      Output.mapEffect((prefix: string | undefined) =>
        prefix === undefined
          ? Effect.die(new CloudflareReportAddressUnavailable({ zoneId }))
          : Effect.succeed(`${prefix}@${cloudflareReportHost}`),
      ),
    );
  });

/** Where the DMARC record sends its reports, as a stack output. */
export const reportAddressOf = (reports: DmarcReports, domain: string) =>
  DmarcReports.$match(reports, {
    Mailbox: ({ address }) => Effect.succeed(Output.asOutput(address)),
    Cloudflare: () => cloudflareReportAddress(domain),
  });
