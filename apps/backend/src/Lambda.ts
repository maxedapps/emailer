import * as Retry from "@distilled.cloud/aws/Retry";
import { Stack } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Duration, Effect, Layer, Schedule } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ReportingLive } from "./Reporting.ts";

const logRetention = Duration.days(7);

/**
 * What every function in the stack shares: a stage-scoped name, the runtime and architecture, and
 * its own log group with bounded retention, declared as `<id>Logs`. Each function keeps its
 * `main: import.meta.url`, because that is what points the bundler at its module.
 *
 * Each function passes `logGroupName` on as `EMAILER_LOG_GROUP`. Nothing reads that variable: it
 * exists only so the function depends on its log group, which is then created before the function.
 */
export const lambdaBasics = (id: string, name: string) =>
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const functionName = `emailer-${stage}-${name}`;

    const logGroup = yield* AWS.Logs.LogGroup(`${id}Logs`, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logRetention,
    });

    return {
      functionName,
      runtime: "nodejs24.x",
      architecture: "arm64",
      logGroupName: logGroup.logGroupName,
    } as const;
  });

/**
 * How long the AWS client keeps retrying a call: short of the five-second storage operation
 * timeout, so a call that keeps failing ends with the service's own error rather than a timeout.
 */
const retryBudget = Duration.seconds(4);

/**
 * The AWS client's own default retry policy, which honours a server's retry-after hint and backs off
 * at least 500 ms after a throttle, except that it schedules no attempt past the budget: it stops
 * when the next delay would end beyond it, not once time has already run out.
 */
const AwsRetryLive = Layer.succeed(Retry.Retry)((lastError) => {
  const policy = Retry.makeDefault(lastError);

  return {
    ...policy,
    schedule: Schedule.while(
      policy.schedule ?? Schedule.forever,
      ({ elapsed, duration }) =>
        elapsed + Duration.toMillis(duration) <= Duration.toMillis(retryBudget),
    ),
  };
});

/**
 * AWS replies are requested uncompressed, as the AWS SDKs request them. Node's fetch otherwise asks
 * for gzip, and DynamoDB labels its larger error replies — a throttled transaction's cancellation
 * among them — `Content-Encoding: gzip` without compressing them. Fetch then fails to decode the
 * reply, and the client reports a defect in place of the error DynamoDB sent.
 */
const UncompressedRepliesLive = Layer.effect(HttpClient.HttpClient)(
  Effect.map(
    HttpClient.HttpClient,
    HttpClient.mapRequest(HttpClientRequest.setHeader("accept-encoding", "identity")),
  ),
);

/**
 * What every function provides to each invocation: failures reported once, the AWS retry policy,
 * and uncompressed AWS replies. The mailer turns retries off for its one call.
 */
export const FunctionServicesLive = Layer.mergeAll(
  ReportingLive,
  AwsRetryLive,
  UncompressedRepliesLive,
);
