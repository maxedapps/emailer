import { Stack } from "alchemy";
import * as AWS from "@alchemy.run/aws";
import { Config, Effect, Layer, Option } from "effect";

import ApiFunction from "./apps/backend/src/api/Api.ts";
import PreviewPage from "./apps/backend/src/campaigns/PreviewPage.ts";
import { PreviewFunction } from "./apps/backend/src/campaigns/Previews.ts";
import { dispatchFailuresAlarm } from "./apps/backend/src/sending/Dispatch.ts";
import DispatcherFunction from "./apps/backend/src/sending/Dispatcher.ts";
import FeedbackFunction, {
  feedbackFailuresAlarm,
  feedbackRouting,
} from "./apps/backend/src/feedback/Feedback.ts";
import { feedbackPublishing } from "./apps/backend/src/sending/Mailer.ts";
import {
  accountReputationAlarms,
  alertsTopic,
  setReputationAlarms,
} from "./apps/backend/src/sending/Reputation.ts";
import { dataTable } from "./apps/backend/src/storage/Table.ts";
import { UnsubscribeFunction } from "./apps/backend/src/consent/Unsubscribe.ts";
import UnsubscribePage from "./apps/backend/src/consent/UnsubscribePage.ts";

export default Stack(
  "Emailer",
  {
    providers: AWS.providers(),
    state: AWS.state({ backend: "s3" }),
  },
  Effect.gen(function* () {
    const api = yield* ApiFunction;

    const unsubscribe = yield* UnsubscribeFunction;

    const preview = yield* PreviewFunction;

    yield* FeedbackFunction;
    yield* DispatcherFunction;
    yield* feedbackFailuresAlarm;
    yield* dispatchFailuresAlarm;

    yield* feedbackPublishing;
    yield* feedbackRouting;

    const topic = yield* alertsTopic;
    const [accountBounceRate] = yield* accountReputationAlarms;
    const [setBounceRate] = yield* setReputationAlarms;
    const table = yield* dataTable;

    const alertEmail = yield* Config.option(Config.String("EMAILER_ALERT_EMAIL"));

    if (Option.isSome(alertEmail)) {
      yield* AWS.SNS.Subscription("AlertsEmail", {
        topicArn: topic.topicArn,
        protocol: "email",
        endpoint: alertEmail.value,
      });
    }

    return {
      apiUrl: api.functionUrl,
      unsubscribeUrl: unsubscribe.functionUrl,
      previewUrl: preview.functionUrl,
      alertsTopicArn: topic.topicArn,
      // For the live suite, which deploys this stack itself.
      tableName: table.tableName,
      accountBounceAlarmName: accountBounceRate.alarmName,
      setBounceAlarmName: setBounceRate.alarmName,
    };
  }).pipe(
    // The public functions are declared as bare tags so the API's and the Dispatcher's props can
    // reference their URLs; without their .make Layers, planning fails with missingImplementation.
    Effect.provide(Layer.mergeAll(UnsubscribePage, PreviewPage)),
  ),
);
