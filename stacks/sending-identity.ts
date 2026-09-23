/**
 * One-shot owner of the account-level SES sending identity and, when `EMAILER_DNS` names a
 * provider, of its DNS records.
 *
 * Deploy once per AWS account and Region at `--stage shared`. Never destroy this stack. With any
 * config, `alchemy unsafe nuke` must exclude `AWS.SES.*`; with this config it must not run at all,
 * because it would enumerate every DNS record the credentials reach. The MAIL FROM subdomain
 * (`bounce.<identity>`) sends nothing and receives only SES feedback at its MX; it must never be
 * used in a From address.
 */
import { RemovalPolicy, Stack } from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { Config, Effect, Layer, Option } from "effect";

import type { Input, StackServices } from "alchemy";

import {
  dkimRecordAt,
  dkimRecordsOf,
  dmarcRecord,
  dnsMode,
  dnsSettings,
  mailFromDomainOf,
  mailFromRecords,
  publisherFor,
} from "../apps/backend/src/identity/SendingDns.ts";
import { senderLogicalId } from "../apps/backend/src/identity/SendingIdentity.ts";

type AwsProviders = Layer.Success<ReturnType<typeof AWS.providers>>;

// `AWS.providers()` is typed with `any` requirements (wiki: version-specific traps); naming what it
// actually requires here keeps that `any` out of every layer built from it.
// oxlint-disable-next-line effecttsgo/any-unknown-in-error-context, typescript/no-unsafe-assignment
const awsProviders: Layer.Layer<AwsProviders, never, StackServices> = AWS.providers();

const withCloudflare = Layer.merge(awsProviders, Cloudflare.providers());

/**
 * Cloudflare's provider resolves its credentials as soon as its layer is built, so it joins only
 * when the records live on Cloudflare; every other deployer needs AWS credentials alone.
 */
const providers = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* dnsMode;

    return Option.getOrUndefined(mode) === "cloudflare" ? withCloudflare : awsProviders;
  }).pipe(Effect.orDie),
);

const sendingIdentity = (emailIdentity: string, mailFromDomain: Input<string>) =>
  AWS.SES.EmailIdentity(senderLogicalId, {
    emailIdentity,
    mailFromDomain,
    mailFromBehaviorOnMxFailure: "USE_DEFAULT_VALUE",
  }).pipe(RemovalPolicy.retain());

export default Stack(
  "EmailerSending",
  { providers, state: AWS.state() },
  Effect.gen(function* () {
    const emailIdentity = yield* Config.string("EMAILER_SENDER_IDENTITY");
    const dns = yield* dnsSettings;
    const mailFromDomain = mailFromDomainOf(emailIdentity);

    if (Option.isNone(dns.mode)) {
      const identity = yield* sendingIdentity(emailIdentity, mailFromDomain);

      return {
        emailIdentity: identity.emailIdentity,
        dkimRecords: dkimRecordsOf(identity.emailIdentity),
      };
    }

    const publish = yield* publisherFor(dns.mode.value, emailIdentity);
    const { region } = yield* AWS.AWSEnvironment.current;
    const [mx, spf] = mailFromRecords(emailIdentity, region);
    const mxName = yield* publish(mx);
    const spfName = yield* publish(spf);

    // SES probes the MX the moment MAIL FROM is set. Deriving the domain from both records' outputs
    // makes the identity set MAIL FROM only after both writes finish.
    const identity = yield* sendingIdentity(
      emailIdentity,
      Output.all(mxName, spfName).pipe(Output.map(() => mailFromDomain)),
    );

    const dkim = dkimRecordsOf(identity.emailIdentity);

    for (const index of [0, 1, 2] as const) {
      yield* publish(dkimRecordAt(dkim, index));
    }

    if (Option.isSome(dns.reportEmail)) {
      yield* publish(dmarcRecord(emailIdentity, dns.reportEmail.value));
    }

    return { emailIdentity: identity.emailIdentity, dkimRecords: dkim };
  }),
);
