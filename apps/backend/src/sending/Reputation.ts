import * as AWS from "alchemy/AWS";
import { Effect } from "effect";

import type { Input } from "alchemy";

import { configurationSet } from "./Mailer.ts";

/**
 * Alert topic and every alarm that notifies it. This module is a leaf: it must not grow a Function
 * class, because the stack and the dispatcher both yield these resources and an inline Function
 * would pull a handler into the other bundle.
 *
 * A resource's props effect runs wherever it is first yielded, including the dispatcher's cold
 * start, which has no AWSEnvironment. The topic therefore takes no props, and the alarms read only
 * resource outputs (`topicArn`, `configurationSetName`, `queueName`).
 */

export const alertsTopic = AWS.SNS.Topic("Alerts");

/** What every alarm shares: it trips after one period at its threshold and tells the topic both ways. */
const alerting = Effect.map(alertsTopic, (topic) => ({
  EvaluationPeriods: 1,
  ComparisonOperator: "GreaterThanOrEqualToThreshold" as const,
  AlarmActions: [topic.topicArn],
  OKActions: [topic.topicArn],
}));

/** Messages a consumer could not process are waiting in `queue`'s dead-letter queue. */
export const queueBacklogAlarm = <R>(
  id: string,
  description: string,
  queue: Effect.Effect<AWS.SQS.Queue, never, R>,
) =>
  AWS.CloudWatch.Alarm(
    id,
    Effect.gen(function* () {
      const { queueName } = yield* queue;

      return {
        AlarmDescription: description,
        Namespace: "AWS/SQS",
        MetricName: "ApproximateNumberOfMessagesVisible",
        Dimensions: [{ Name: "QueueName", Value: queueName }],
        Statistic: "Maximum",
        Period: 60,
        Threshold: 1,
        TreatMissingData: "notBreaching",
        ...(yield* alerting),
      };
    }),
  );

/**
 * Set-level warning before AWS's review ratios; account-level at those ratios because a review
 * hits the whole account. Rates are CloudWatch units (0–1), not percents.
 */
const reputationThresholds = {
  set: { bounce: 0.02, complaint: 0.0005 },
  account: { bounce: 0.05, complaint: 0.001 },
} as const;

/** Which reputation a metric measures: the configuration set's, or the whole account's. */
interface MetricScope {
  readonly Dimensions?: Array<{ readonly Name: string; readonly Value: Input<string> }>;
}

const configurationSetMetric = Effect.map(configurationSet, (mail): MetricScope => ({
  Dimensions: [{ Name: "ses:configuration-set", Value: mail.configurationSetName }],
}));

const accountMetric = Effect.succeed<MetricScope>({});

/** An hourly SES reputation rate; missing data is ignored, as AWS recommends for these metrics. */
const reputationAlarm = <R>(
  id: string,
  description: string,
  metric: "Reputation.BounceRate" | "Reputation.ComplaintRate",
  threshold: number,
  scope: Effect.Effect<MetricScope, never, R>,
) =>
  AWS.CloudWatch.Alarm(
    id,
    Effect.gen(function* () {
      return {
        AlarmDescription: description,
        Namespace: "AWS/SES",
        MetricName: metric,
        ...(yield* scope),
        Statistic: "Maximum",
        Period: 3600,
        Threshold: threshold,
        TreatMissingData: "ignore",
        ...(yield* alerting),
      };
    }),
  );

export const reputationAlarms = Effect.all([
  reputationAlarm(
    "SetBounceRate",
    "Configuration-set bounce rate is at or above 2 percent.",
    "Reputation.BounceRate",
    reputationThresholds.set.bounce,
    configurationSetMetric,
  ),
  reputationAlarm(
    "SetComplaintRate",
    "Configuration-set complaint rate is at or above 0.05 percent.",
    "Reputation.ComplaintRate",
    reputationThresholds.set.complaint,
    configurationSetMetric,
  ),
  reputationAlarm(
    "AccountBounceRate",
    "Account bounce rate is at or above 5 percent.",
    "Reputation.BounceRate",
    reputationThresholds.account.bounce,
    accountMetric,
  ),
  reputationAlarm(
    "AccountComplaintRate",
    "Account complaint rate is at or above 0.1 percent.",
    "Reputation.ComplaintRate",
    reputationThresholds.account.complaint,
    accountMetric,
  ),
]);
