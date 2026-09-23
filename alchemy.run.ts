import { Stack } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Config, Effect, Layer, Option } from "effect";

import ApiFunction from "./apps/backend/src/api/Api.ts";
import PreviewPage from "./apps/backend/src/campaigns/PreviewPage.ts";
import { PreviewFunction } from "./apps/backend/src/campaigns/Previews.ts";
import { dispatchFailures } from "./apps/backend/src/sending/Dispatch.ts";
import DispatcherFunction from "./apps/backend/src/sending/Dispatcher.ts";
import FeedbackFunction, { feedbackFailures } from "./apps/backend/src/feedback/Feedback.ts";
import { feedbackPublishing } from "./apps/backend/src/sending/Mailer.ts";
import { alertsTopic, reputationAlarms } from "./apps/backend/src/sending/Reputation.ts";
import { UnsubscribeFunction } from "./apps/backend/src/consent/Unsubscribe.ts";
import UnsubscribePage from "./apps/backend/src/consent/UnsubscribePage.ts";

export default Stack(
  "Emailer",
  {
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context, typescript/no-unsafe-assignment
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const api = yield* ApiFunction;

    const unsubscribe = yield* UnsubscribeFunction;

    const preview = yield* PreviewFunction;

    const feedback = yield* FeedbackFunction;
    yield* DispatcherFunction;
    const failures = yield* feedbackFailures;
    const failedDispatches = yield* dispatchFailures;

    yield* feedbackPublishing;

    const topic = yield* alertsTopic;
    yield* reputationAlarms;

    const alertEmail = yield* Config.option(Config.string("EMAILER_ALERT_EMAIL"));

    if (Option.isSome(alertEmail)) {
      yield* AWS.SNS.Subscription("AlertsEmail", {
        topicArn: topic.topicArn,
        protocol: "email",
        endpoint: alertEmail.value,
      });
    }

    // Deploy-time only, from attributes the composition has already resolved. Building these
    // inside the function's own props would run them at every cold start and resolve the function
    // from inside its own construction.
    //
    // Two separate questions, so two alarms. A visible message says the consumer accepted an event
    // and could not process it — there is something to replay. A destination-delivery failure says
    // Lambda could not even record that, which is the case where the event is actually lost.
    yield* AWS.CloudWatch.Alarm("FeedbackFailuresVisible", {
      AlarmDescription: "Feedback events Lambda could not process are waiting to be replayed.",
      Namespace: "AWS/SQS",
      MetricName: "ApproximateNumberOfMessagesVisible",
      Dimensions: [{ Name: "QueueName", Value: failures.queueName }],
      Statistic: "Maximum",
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [topic.topicArn],
      OKActions: [topic.topicArn],
    });

    yield* AWS.CloudWatch.Alarm("FeedbackDestinationDeliveryFailures", {
      AlarmDescription: "Lambda could not deliver a failed feedback event to its failure queue.",
      Namespace: "AWS/Lambda",
      MetricName: "DestinationDeliveryFailures",
      Dimensions: [{ Name: "FunctionName", Value: feedback.functionName }],
      Statistic: "Sum",
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [topic.topicArn],
      OKActions: [topic.topicArn],
    });

    yield* AWS.CloudWatch.Alarm("DispatchFailuresVisible", {
      AlarmDescription: "Dispatch wake-ups Lambda could not process are waiting to be replayed.",
      Namespace: "AWS/SQS",
      MetricName: "ApproximateNumberOfMessagesVisible",
      Dimensions: [{ Name: "QueueName", Value: failedDispatches.queueName }],
      Statistic: "Maximum",
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [topic.topicArn],
      OKActions: [topic.topicArn],
    });

    return {
      apiUrl: api.functionUrl,
      unsubscribeUrl: unsubscribe.functionUrl,
      previewUrl: preview.functionUrl,
      feedbackFunctionArn: feedback.functionArn,
      feedbackFailureQueueUrl: failures.queueUrl,
      alertsTopicArn: topic.topicArn,
    };
  }).pipe(
    // The public functions are declared as bare tags so Api.ts can reference their
    // URLs; without their .make Layers, planning fails with missingImplementation.
    Effect.provide(Layer.mergeAll(UnsubscribePage, PreviewPage)),
  ),
);
