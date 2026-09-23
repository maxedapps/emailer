import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Schemas from "@emailer/api/Schemas";
import { RemovalPolicy } from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { Config, Data, Effect, Match, Option } from "effect";

import type { Input } from "alchemy";

/**
 * DNS records of the sending identity, declared by the one-shot identity stack when `EMAILER_DNS`
 * names a provider. Deploy-time only: no Lambda imports this module, so neither the Cloudflare
 * provider nor the SES lookup below reaches a function bundle.
 */

export type DnsMode = "route53" | "cloudflare";

export const dnsMode = Config.option(Config.literals(["route53", "cloudflare"], "EMAILER_DNS"));

export class DmarcRequiresDnsMode extends Data.TaggedError("DmarcRequiresDnsMode")<{
  readonly reportEmail: string;
}> {}

/**
 * DMARC is a policy for the whole domain and often exists already, so the stack publishes it only
 * on request — and only where it publishes the other records. A report address without a mode
 * would be silently ignored, so it fails construction instead.
 */
export const dnsSettings = Effect.gen(function* () {
  const mode = yield* dnsMode;

  const reportEmail = yield* Config.option(
    Config.schema(Schemas.EmailAddress, "EMAILER_DMARC_REPORT_EMAIL"),
  );

  if (Option.isNone(mode) && Option.isSome(reportEmail)) {
    return yield* Effect.die(new DmarcRequiresDnsMode({ reportEmail: reportEmail.value }));
  }

  return { mode, reportEmail };
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

export const dmarcRecord = (domain: string, reportEmail: string): TextRecord => ({
  id: "Dmarc",
  type: "TXT",
  name: `_dmarc.${domain}`.toLowerCase(),
  value: `"v=DMARC1; p=none; rua=mailto:${reportEmail}"`,
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
