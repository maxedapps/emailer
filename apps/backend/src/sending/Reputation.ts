import * as AWS from "alchemy/AWS";
import { Effect } from "effect";

import { configurationSet } from "./Mailer.ts";

/**
 * Alert topic and SES reputation alarms. This module is a leaf: it must not grow a Function class,
 * because the stack and the dispatcher both yield these resources and an inline Function would pull
 * a handler into the other bundle.
 *
 * A resource's props effect runs wherever it is first yielded, including the dispatcher's cold
 * start, which has no AWSEnvironment. The topic therefore takes no props, and the alarms read only
 * resource outputs (`topicArn`, `configurationSetName`).
 */

export const alertsTopic = AWS.SNS.Topic("Alerts");

/**
 * Set-level warning before AWS's review ratios; account-level at those ratios because a review
 * hits the whole account. Rates are CloudWatch units (0–1), not percents.
 */
export const reputationThresholds = {
  set: { bounce: 0.02, complaint: 0.0005 },
  account: { bounce: 0.05, complaint: 0.001 },
} as const;

const setBounceRate = AWS.CloudWatch.Alarm(
  "SetBounceRate",
  Effect.gen(function* () {
    const topic = yield* alertsTopic;
    const mail = yield* configurationSet;

    return {
      AlarmDescription: "Configuration-set bounce rate is at or above 2 percent.",
      Namespace: "AWS/SES",
      MetricName: "Reputation.BounceRate",
      Dimensions: [{ Name: "ses:configuration-set", Value: mail.configurationSetName }],
      Statistic: "Maximum",
      Period: 3600,
      EvaluationPeriods: 1,
      Threshold: reputationThresholds.set.bounce,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "ignore",
      AlarmActions: [topic.topicArn],
      OKActions: [topic.topicArn],
    };
  }),
);

const setComplaintRate = AWS.CloudWatch.Alarm(
  "SetComplaintRate",
  Effect.gen(function* () {
    const topic = yield* alertsTopic;
    const mail = yield* configurationSet;

    return {
      AlarmDescription: "Configuration-set complaint rate is at or above 0.05 percent.",
      Namespace: "AWS/SES",
      MetricName: "Reputation.ComplaintRate",
      Dimensions: [{ Name: "ses:configuration-set", Value: mail.configurationSetName }],
      Statistic: "Maximum",
      Period: 3600,
      EvaluationPeriods: 1,
      Threshold: reputationThresholds.set.complaint,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "ignore",
      AlarmActions: [topic.topicArn],
      OKActions: [topic.topicArn],
    };
  }),
);

const accountBounceRate = AWS.CloudWatch.Alarm(
  "AccountBounceRate",
  Effect.gen(function* () {
    const topic = yield* alertsTopic;

    return {
      AlarmDescription: "Account bounce rate is at or above 5 percent.",
      Namespace: "AWS/SES",
      MetricName: "Reputation.BounceRate",
      Statistic: "Maximum",
      Period: 3600,
      EvaluationPeriods: 1,
      Threshold: reputationThresholds.account.bounce,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "ignore",
      AlarmActions: [topic.topicArn],
      OKActions: [topic.topicArn],
    };
  }),
);

const accountComplaintRate = AWS.CloudWatch.Alarm(
  "AccountComplaintRate",
  Effect.gen(function* () {
    const topic = yield* alertsTopic;

    return {
      AlarmDescription: "Account complaint rate is at or above 0.1 percent.",
      Namespace: "AWS/SES",
      MetricName: "Reputation.ComplaintRate",
      Statistic: "Maximum",
      Period: 3600,
      EvaluationPeriods: 1,
      Threshold: reputationThresholds.account.complaint,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "ignore",
      AlarmActions: [topic.topicArn],
      OKActions: [topic.topicArn],
    };
  }),
);

export const reputationAlarms = Effect.gen(function* () {
  const setBounce = yield* setBounceRate;
  const setComplaint = yield* setComplaintRate;
  const accountBounce = yield* accountBounceRate;
  const accountComplaint = yield* accountComplaintRate;

  return [setBounce, setComplaint, accountBounce, accountComplaint] as const;
});
