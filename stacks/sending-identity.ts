/**
 * One-shot owner of the account-level SES sending identity.
 *
 * Deploy once per AWS account and Region at `--stage shared`. Never destroy
 * this stack. `alchemy unsafe nuke` must exclude `AWS.SES.*`.
 * The MAIL FROM subdomain (`bounce.<identity>`) sends nothing and receives
 * only SES feedback at its MX; it must never be used in a From address.
 */
import { RemovalPolicy, Stack } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Config, Effect } from "effect";

import { senderLogicalId } from "../apps/backend/src/SendingIdentity.ts";

export default Stack(
  "EmailerSending",
  {
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context, typescript/no-unsafe-assignment
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const emailIdentity = yield* Config.string("EMAILER_SENDER_IDENTITY");

    const identity = yield* AWS.SES.EmailIdentity(senderLogicalId, {
      emailIdentity,
      mailFromDomain: `bounce.${emailIdentity}`,
      mailFromBehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    }).pipe(RemovalPolicy.retain());

    return {
      emailIdentity: identity.emailIdentity,
      dkimTokens: identity.dkimTokens,
    };
  }),
);
