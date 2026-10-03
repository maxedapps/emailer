/**
 * The live suite: deploys `alchemy.run.ts` to its own stage, runs every live suite against it, and
 * destroys the stage. Alchemy's harness cannot share one deployment between test files, so this is
 * the one file, and each suite is a module it registers; select one with `-t`.
 */
// A synchronous guard that must run before any test is collected.
import { existsSync } from "node:fs";

import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Vitest";
import { Effect } from "effect";

import Stack from "../../../alchemy.run.ts";
import { apiSuite } from "../src/api/Api.live.ts";
import { cancellationSuite } from "../src/campaigns/CampaignCancellation.live.ts";
import { draftingSuite } from "../src/campaigns/Drafting.live.ts";
import { variantsSuite } from "../src/campaigns/Variants.live.ts";
import { subscriptionsSuite } from "../src/consent/Subscriptions.live.ts";
import { unsubscribeSuite } from "../src/consent/Unsubscribe.live.ts";
import { feedbackSuite } from "../src/feedback/Feedback.live.ts";
import * as TestStage from "../../../tools/stages/TestStage.ts";
import { awsClient, Deployment } from "./IntegrationSupport.ts";

import type { LiveTest } from "./IntegrationSupport.ts";

// Alchemy's harness reads `./.env` for every key the environment lacks, so a prod `.env` would leak
// into the test stage: its alert address, its API token.
if (existsSync(".env")) {
  throw new Error("Move ./.env to .env.prod before a live run: the test harness would read it.");
}

// A fresh stage per run, so parallel runs never share one (ADR-0031). Its name goes straight to
// stderr, which Vitest's agent reporter keeps for passing runs too, so a killed run can still be
// destroyed with `pnpm stages down`.
const stage = Effect.runSync(TestStage.make);

process.stderr.write(`Live suite stage: ${stage}\n`);

/** Deploying and destroying a whole stage, with its function bundles, takes minutes. */
const stageTimeout = 30 * 60_000;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
  state: AWS.state(),
  stage,
});

const outputs = beforeAll(deploy(Stack), { timeout: stageTimeout });

afterAll(destroy(Stack), { timeout: stageTimeout });

const deployment = Effect.gen(function* () {
  const deployed = yield* outputs;

  if (deployed.apiUrl === undefined || deployed.unsubscribeUrl === undefined) {
    return yield* Effect.die(new Error("The stack deployed without its Function URLs."));
  }

  return Deployment.of({
    stage,
    apiUrl: deployed.apiUrl,
    unsubscribeUrl: deployed.unsubscribeUrl,
    tableName: deployed.tableName,
    setBounceAlarmName: deployed.setBounceAlarmName,
  });
});

const live: LiveTest = (name, body, timeout) =>
  test(
    name,
    body.pipe(Effect.provideServiceEffect(Deployment, deployment), Effect.provide(awsClient)),
    timeout === undefined ? undefined : { timeout },
  );

apiSuite(live);

cancellationSuite(live);

draftingSuite(live);

variantsSuite(live);

unsubscribeSuite(live);

subscriptionsSuite(live);

feedbackSuite(live);
