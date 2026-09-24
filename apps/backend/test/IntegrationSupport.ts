/**
 * The one source of configuration, AWS clients and fixtures the integration suites share.
 *
 * It lives outside `src/` so the unit project never picks it up, and outside any one suite so that
 * splitting the suites did not mean three copies of the live storage composition and three
 * different ideas of which simulator address means what.
 *
 * Automated sends go only to SES mailbox-simulator addresses. `submitToSimulatorList` is the
 * test-side guard: it pages a list and refuses to run the submit if any member is not a simulator
 * address. `sendToSimulatorList` is the send form of that guard, and `testToSimulators` the form
 * for test sends, which also checks explicit addresses.
 */
import { NodeCrypto } from "@effect/platform-node";
import { fromChain } from "@distilled.cloud/aws/Credentials";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as sqs from "@distilled.cloud/aws/sqs";
import type { EmailerClient } from "@emailer/api/Client";
import * as Schemas from "@emailer/api/Schemas";
import {
  Config,
  Crypto,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { newIdentifier, nowIso } from "../src/Identifiers.ts";
import { campaignKey, itemReader, str, tableLogicalId } from "../src/storage/Items.ts";
import { suppressionWrites, unsubscribeWrites } from "../src/storage/Addresses.ts";
import { audienceOperations } from "../src/storage/Audience.ts";
import { campaignStoreOperations } from "../src/storage/Campaigns.ts";
import { feedbackWrites } from "../src/storage/Feedback.ts";
import { transactionPrimitives, writePrimitives } from "../src/storage/Primitives.ts";
import { unsubscribeSigningKey } from "../src/consent/Unsubscribe.ts";
import { feedbackRedelivery } from "../src/feedback/Feedback.ts";
import { encodeDispatchMessage } from "../src/sending/Dispatch.ts";

import type { AddressStatus } from "@emailer/api/Schemas";
import type { TableOperations } from "../src/storage/Items.ts";

const simulatorHost = "@simulator.amazonses.com";

/** States a send response can carry: the API re-reads after enqueue, so the dispatcher may be ahead. */
export const submitted: ReadonlyArray<string> = ["queued", "sending", "completed"];

const campaignWaitFloorSeconds = 180;

const mappingReadyTimeout = Duration.minutes(5);

const staleWakeLogTimeout = Duration.minutes(5);

/**
 * How long a campaign's bounce and complaint counts may take to settle once its sends are done:
 * SES and EventBridge latency, plus one redelivery of an event whose count update lost every retry
 * to the dispatcher's writes on the same campaign item.
 */
const feedbackSettleTimeout = Duration.sum(feedbackRedelivery, Duration.minutes(2));

const mappingPoll = Schedule.spaced("3 seconds");

/** Longer than the 20-second long poll Lambda's SQS pollers use, so an idle canary is not luck. */
const pollerQuietWindow = Duration.seconds(25);

const mappingUpdateRetry = Schedule.max([Schedule.recurs(20), Schedule.spaced("5 seconds")]);

const readSendRow = itemReader(
  Schema.Struct({
    contactId: Schemas.EntityId,
    recipient: Schema.String,
    state: Schema.Literals(["unconfirmed", "accepted", "rejected", "uncertain", "skipped"]),
    finishedAt: Schema.optionalKey(Schemas.Timestamp),
    skipReason: Schema.optionalKey(Schema.String),
  }),
);

const RateLimitWindow = Schema.Struct({ count: Schema.Int, expiresAt: Schema.Finite });

const readRateLimitWindow = itemReader(RateLimitWindow);

export type SimulatorKind = "success" | "bounce" | "complaint";

type RateLimitWindow = typeof RateLimitWindow.Type;

/**
 * Labelled mailbox-simulator addresses, unique per run. `n` indexes success and bounce addresses.
 * Complaint stays unique per run without `n`.
 */
export const simulator = (kind: SimulatorKind, runId: string, n = 0): string => {
  switch (kind) {
    case "success":
      return `success+${runId}-${n}${simulatorHost}`;
    case "bounce":
      return `bounce+${runId}-${n}${simulatorHost}`;
    case "complaint":
      return `complaint+${runId}${simulatorHost}`;
  }
};

export const configuration = Effect.gen(function* () {
  const apiUrl = yield* Config.String("EMAILER_API_URL");
  const token = yield* Config.Redacted("EMAILER_API_TOKEN");
  const tableName = yield* Config.String("EMAILER_TEST_TABLE_NAME");
  const dispatchFailuresQueueUrl = yield* Config.String("EMAILER_TEST_DISPATCH_FAILURES_QUEUE_URL");

  return { apiUrl, token, tableName, dispatchFailuresQueueUrl };
});

// Read only where it is needed: both keys are copied out of the deployment, so a
// run that exercises nothing else should not require them.
export const unsubscribeSettings = Effect.gen(function* () {
  const baseUrl = yield* Config.String("EMAILER_UNSUBSCRIBE_URL");
  const signingKey = yield* unsubscribeSigningKey;

  return { baseUrl: baseUrl.replace(/\/+$/, ""), signingKey };
});

const awsClient = Layer.mergeAll(FetchHttpClient.layer, fromChain(), NodeCrypto.layer);

/**
 * Runs `effect` on the first execution and is a no-op after that, including when the first
 * execution fails. Wrap `beforeCommit` interference with this: a TransactionConflict retry would
 * otherwise apply the hook again.
 */
export const once = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | void, E, R> => {
  let remaining = true;

  return Effect.suspend(() => {
    if (!remaining) {
      return Effect.void;
    }

    remaining = false;

    return effect;
  });
};

/** Last physical `TransactWriteItems` request a capturing `liveStorage` sent. */
export interface TransactionCapture {
  last: dynamodb.TransactWriteItemsInput | undefined;
}

/**
 * Every capability composed over one live table.
 *
 * `beforeCommit` runs immediately before each transaction is sent — after any advisory read the
 * operation has already made. That is the one moment a test can change the world deterministically
 * between a read and the commit that depends on it, which is what proves a condition rather than
 * a scheduler.
 *
 * The hook is not one-shot by itself: a TransactionConflict retry calls it again. Wrap interference
 * with `once`. Inside the hook, use a separate ordinary `liveStorage(tableName)` (no hook) so the
 * hook cannot recurse.
 */
export const liveStorage = (
  tableName: string,
  beforeCommit: Effect.Effect<unknown> = Effect.void,
  capture?: TransactionCapture,
) =>
  Effect.gen(function* () {
    const getItem = yield* dynamodb.getItem;
    const batchGetItem = yield* dynamodb.batchGetItem;
    const putItem = yield* dynamodb.putItem;
    const updateItem = yield* dynamodb.updateItem;
    const query = yield* dynamodb.query;
    const transactWriteItems = yield* dynamodb.transactWriteItems;

    const named = <Item extends { readonly Table: string }>(item: Item) => {
      const { Table, ...rest } = item;

      if (Table !== tableLogicalId) {
        throw new Error(`Transaction item references an unbound table: ${Table}`);
      }

      return { ...rest, TableName: tableName };
    };

    const operations: TableOperations = {
      getItem: (request) => getItem({ ...request, TableName: tableName }),
      // The binding rewrites logical IDs to the physical name on the way in, and AWS answers under
      // that physical name. Reproducing both halves here is what makes the integration suite able
      // to falsify the re-keying that the unit stub can only describe.
      batchGetItem: (request) =>
        batchGetItem({
          ...request,
          RequestItems: Object.fromEntries(
            Object.entries(request.RequestItems).map(([logicalId, keys]) => {
              if (logicalId !== tableLogicalId) {
                throw new Error(`Batch request references an unbound table: ${logicalId}`);
              }

              return [tableName, keys];
            }),
          ),
        }),
      putItem: (request) => putItem({ ...request, TableName: tableName }),
      updateItem: (request) => updateItem({ ...request, TableName: tableName }),
      query: (request) => query({ ...request, TableName: tableName }),
      transactWriteItems: (request) => {
        const physical: dynamodb.TransactWriteItemsInput = {
          ...request,
          TransactItems: request.TransactItems.map((item) => {
            if (item.ConditionCheck !== undefined) {
              return { ConditionCheck: named(item.ConditionCheck) };
            }

            if (item.Put !== undefined) {
              return { Put: named(item.Put) };
            }

            if (item.Update !== undefined) {
              return { Update: named(item.Update) };
            }

            if (item.Delete !== undefined) {
              return { Delete: named(item.Delete) };
            }

            throw new Error("Transaction item carries no operation");
          }),
        };

        return Effect.gen(function* () {
          yield* beforeCommit;

          if (capture !== undefined) {
            capture.last = physical;
          }

          return yield* transactWriteItems(physical);
        });
      },
    };

    // The suite drives every capability against one live table, so it composes all four stores'
    // operations over it rather than any one function's service.
    const crypto = yield* Crypto.Crypto;
    const tokens = Effect.orDie(crypto.randomUUIDv4);
    const writes = writePrimitives(operations);
    const transactions = transactionPrimitives(operations, tokens);

    return {
      ...audienceOperations(operations, tokens),
      ...campaignStoreOperations(operations, tokens),
      ...suppressionWrites(writes),
      ...unsubscribeWrites(writes),
      ...feedbackWrites(transactions),
    } as const;
  });

/** A fresh contact for a labelled address. Addresses are unique, so reuse is a test bug. */
export const contactFor = (storage: LiveStorage, email: string) =>
  Effect.gen(function* () {
    const id = yield* newIdentifier;
    const createdAt = yield* nowIso;

    yield* storage.createContact({ id, email, createdAt });

    return id;
  });

/** Every member's address, paged at the largest size the contract admits. */
const memberAddresses = (client: EmailerClient, listId: string) =>
  Stream.paginate(undefined, (cursor: string | undefined) =>
    client.lists
      .listMembers({ params: { listId }, query: { limit: Schemas.maxPageSize, cursor } })
      .pipe(Effect.map((page) => [page.items, Option.fromUndefinedOr(page.nextCursor)] as const)),
  ).pipe(
    Stream.map((member) => member.email),
    Stream.runCollect,
  );

/** The one simulator guard: refuses, before anything is sent, on any other address. */
const requireSimulators = (addresses: ReadonlyArray<string>, refusal: string) => {
  const other = addresses.find((address) => !address.endsWith(simulatorHost));

  if (other !== undefined) {
    throw new Error(`${refusal}: ${other} is not a simulator address`);
  }
};

/**
 * Pages every member and refuses unless each address is a mailbox-simulator address, then runs
 * `submit`. Every live send in the suite goes through this.
 */
export const submitToSimulatorList = <A, E, R>(
  client: EmailerClient,
  listId: string,
  campaignId: string,
  submit: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    requireSimulators(
      yield* memberAddresses(client, listId),
      `refusing to send campaign ${campaignId}`,
    );

    return yield* submit;
  });

/** The send form of `submitToSimulatorList`. */
export const sendToSimulatorList = (client: EmailerClient, listId: string, campaignId: string) =>
  submitToSimulatorList(
    client,
    listId,
    campaignId,
    client.campaigns.send({ params: { id: campaignId } }),
  );

/** A test send, refused before any request unless every recipient is a simulator address. */
export const testToSimulators = (
  client: EmailerClient,
  campaignId: string,
  recipients: { readonly to: ReadonlyArray<string> } | { readonly listId: string },
) =>
  Effect.gen(function* () {
    requireSimulators(
      "to" in recipients ? recipients.to : yield* memberAddresses(client, recipients.listId),
      `refusing to test-send campaign ${campaignId}`,
    );

    const params = { id: campaignId };

    return yield* "to" in recipients
      ? client.campaigns.test({ params, payload: { to: recipients.to } })
      : client.campaigns.test({ params, payload: { listId: recipients.listId } });
  });

export const accountSendQuota = Effect.gen(function* () {
  const getAccount = yield* sesv2.getAccount;
  const account = yield* getAccount({});

  return account.SendQuota;
});

export const setAlarmState = (alarmName: string, state: cloudwatch.StateValue) =>
  Effect.gen(function* () {
    const set = yield* cloudwatch.setAlarmState;

    yield* set({
      AlarmName: alarmName,
      StateValue: state,
      StateReason: "emailer integration test",
    });
  });

export const describeAlarms = (alarmName: string) =>
  Effect.gen(function* () {
    const describe = yield* cloudwatch.describeAlarms;
    const page = yield* describe({ AlarmNames: [alarmName] });
    const alarm = page.MetricAlarms?.[0];

    if (alarm === undefined) {
      throw new Error(`alarm ${alarmName} was not returned by DescribeAlarms`);
    }

    return alarm;
  });

export const putSuppressedDestination = (email: string) =>
  Effect.gen(function* () {
    const put = yield* sesv2.putSuppressedDestination;

    yield* put({ EmailAddress: email, Reason: "BOUNCE" });
  });

export const deleteSuppressedDestination = (email: string) =>
  Effect.gen(function* () {
    const del = yield* sesv2.deleteSuppressedDestination;

    yield* del({ EmailAddress: email });
  });

export const getSuppressedDestination = (email: string) =>
  Effect.gen(function* () {
    const get = yield* sesv2.getSuppressedDestination;

    return yield* get({ EmailAddress: email });
  });

export const addressRecord = (client: EmailerClient, email: string) =>
  client.addresses.status({ query: { email } });

export const unsuppress = (client: EmailerClient, email: string) =>
  client.addresses.unsuppress({ payload: { email } });

/** The dispatcher's paced limit: `max(1, floor(MaxSendRate × 0.8))`. */
export const pacedSendLimit = (maxSendRate: number | undefined): number =>
  maxSendRate === undefined ? 1 : Math.max(1, Math.floor(maxSendRate * 0.8));

/**
 * How long `awaitCampaignState` should wait for a campaign of `members` recipients.
 *
 * Sized as `ceil(members / pacedLimit) + 30s`, with a 3-minute floor for cold starts and the two
 * SQS hops a two-page campaign needs.
 */
export const campaignStateTimeout = (
  members: number,
  maxSendRate: number | undefined,
): Duration.Duration => {
  const seconds = Math.ceil(members / pacedSendLimit(maxSendRate)) + 30;

  return Duration.seconds(Math.max(seconds, campaignWaitFloorSeconds));
};

export const awaitCampaignState = (
  client: EmailerClient,
  id: string,
  state: Schemas.CampaignSubmission["state"],
  timeout: Duration.Input,
  failOn: ReadonlyArray<Schemas.CampaignSubmission["state"]> = [],
) =>
  client.campaigns.get({ params: { id } }).pipe(
    Effect.tap((campaign) => {
      if (!failOn.includes(campaign.submission.state)) {
        return Effect.void;
      }

      const reason =
        campaign.submission.state === "paused" ? campaign.submission.reason : undefined;

      return Effect.die(
        new Error(
          `campaign ${id} reached ${campaign.submission.state}${
            reason === undefined ? "" : ` (${reason})`
          } while waiting for ${state}`,
        ),
      );
    }),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (campaign: Schemas.Campaign) => campaign.submission.state === state,
    }),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.die(new Error(`campaign ${id} did not reach ${state}`)),
    }),
  );

const campaignFeedback = (campaign: Schemas.Campaign): Schemas.CampaignFeedback | undefined => {
  switch (campaign.submission.state) {
    case "sending":
    case "paused":
    case "completed":
      return campaign.submission.feedback;
    default:
      return undefined;
  }
};

export const awaitCampaignFeedback = (
  client: EmailerClient,
  id: string,
  expected: { readonly bounced: number; readonly complained: number },
) =>
  client.campaigns.get({ params: { id } }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (campaign: Schemas.Campaign) => {
        const feedback = campaignFeedback(campaign);

        return (
          feedback !== undefined &&
          feedback.bounced === expected.bounced &&
          feedback.complained === expected.complained
        );
      },
    }),
    Effect.timeoutOrElse({
      duration: feedbackSettleTimeout,
      orElse: () =>
        Effect.die(
          new Error(
            `campaign ${id} feedback did not reach bounced=${expected.bounced} complained=${expected.complained}`,
          ),
        ),
    }),
  );

/** Every SEND row of a campaign, across pages: Distilled carries `LastEvaluatedKey` forward. */
export const sendRows = (campaignId: string) =>
  Effect.gen(function* () {
    const tableName = yield* Config.String("EMAILER_TEST_TABLE_NAME");

    return yield* dynamodb.query
      .items({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": str(`CAMPAIGN#${campaignId}`),
          ":prefix": str("SEND#"),
        },
        ConsistentRead: true,
      })
      .pipe(
        Stream.mapEffect((item) => readSendRow("sendRows", item)),
        Stream.runCollect,
      );
  });

export const campaignMeta = (campaignId: string) =>
  Effect.gen(function* () {
    const tableName = yield* Config.String("EMAILER_TEST_TABLE_NAME");
    const getItem = yield* dynamodb.getItem;

    const response = yield* getItem({
      TableName: tableName,
      Key: campaignKey(campaignId),
      ConsistentRead: true,
    });

    if (response.Item === undefined) {
      throw new Error(`META for campaign ${campaignId} is missing`);
    }

    return response.Item;
  });

export const replayTransactWrite = (request: dynamodb.TransactWriteItemsInput) =>
  Effect.gen(function* () {
    const transactWriteItems = yield* dynamodb.transactWriteItems;

    return yield* transactWriteItems(request);
  });

const dispatcherFunctionName = Config.String("EMAILER_TEST_DISPATCHER_FUNCTION_NAME");

const dispatcherLogGroup = (functionName: string) => `/aws/lambda/${functionName}`;

const setMappingEnabled = (uuid: string, enabled: boolean) =>
  Effect.gen(function* () {
    const update = yield* lambda.updateEventSourceMapping;

    yield* update({ UUID: uuid, Enabled: enabled });
  }).pipe(
    Effect.retry({
      schedule: mappingUpdateRetry,
      while: (error) =>
        Predicate.isTagged("ResourceInUseException")(error) ||
        Predicate.isTagged("ResourceConflictException")(error),
    }),
  );

const mappingState = (uuid: string) =>
  Effect.gen(function* () {
    const get = yield* lambda.getEventSourceMapping;
    const mapping = yield* get({ UUID: uuid });

    return mapping.State;
  });

const awaitMappingState = (uuid: string, expected: string) =>
  mappingState(uuid).pipe(
    Effect.repeat({
      schedule: mappingPoll,
      until: (state: string | undefined) => state === expected,
    }),
    Effect.timeoutOrElse({
      duration: mappingReadyTimeout,
      orElse: () => Effect.die(new Error(`event source mapping ${uuid} did not reach ${expected}`)),
    }),
  );

const dispatcherMapping = Effect.gen(function* () {
  const functionName = yield* dispatcherFunctionName;
  const list = yield* lambda.listEventSourceMappings;
  const page = yield* list({ FunctionName: functionName });
  const mappings = page.EventSourceMappings ?? [];

  if (mappings.length !== 1) {
    throw new Error(`expected one dispatch mapping for ${functionName}, found ${mappings.length}`);
  }

  const mapping = mappings[0];
  const uuid = mapping?.UUID;
  const queueArn = mapping?.EventSourceArn;

  if (mapping === undefined || uuid === undefined || queueArn === undefined) {
    throw new Error(`dispatch mapping for ${functionName} has no UUID or source queue`);
  }

  return { uuid, state: mapping.State, queueArn };
});

/**
 * "Disabled" is reported before Lambda's pollers stop: on 2026-09-23 a wake enqueued a second after
 * the mapping reached Disabled was still consumed, and one enqueued two minutes later was not. A
 * canary settles it without guessing a delay. It is a stale wake the dispatcher discards, left on
 * the queue until it has sat unreceived for longer than a long poll; while pollers still run, each
 * canary is consumed and another is sent. Restoring the mapping later discards the canaries.
 */
const awaitPollersStopped = (queueArn: string) =>
  Effect.gen(function* () {
    const getQueueUrl = yield* sqs.getQueueUrl;
    const sendMessage = yield* sqs.sendMessage;
    const getQueueAttributes = yield* sqs.getQueueAttributes;
    const { QueueUrl } = yield* getQueueUrl({ QueueName: queueArn.split(":").at(-1) ?? "" });

    if (QueueUrl === undefined) {
      throw new Error(`no URL for dispatch queue ${queueArn}`);
    }

    const canaryIdle = Effect.gen(function* () {
      const canary = yield* encodeDispatchMessage({
        campaignId: yield* newIdentifier,
        runToken: yield* newIdentifier,
      });

      yield* sendMessage({ QueueUrl, MessageBody: canary });
      yield* Effect.sleep(pollerQuietWindow);

      const { Attributes } = yield* getQueueAttributes({
        QueueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      });

      return (
        Number(Attributes?.ApproximateNumberOfMessages ?? "0") >= 1 &&
        Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? "1") === 0
      );
    });

    yield* canaryIdle.pipe(
      Effect.repeat({ until: (idle: boolean) => idle }),
      Effect.timeoutOrElse({
        duration: mappingReadyTimeout,
        orElse: () => Effect.die(new Error(`pollers of ${queueArn} kept receiving`)),
      }),
    );
  });

/**
 * Disables only the owned test dispatcher SQS mapping, waits until Disabled and its pollers have
 * stopped, and restores the original Enabled state when the scope closes — including on failure.
 */
export const disableDispatcherMapping = Effect.acquireRelease(
  Effect.gen(function* () {
    const mapping = yield* dispatcherMapping;
    const originalEnabled = mapping.state === "Enabled" || mapping.state === "Enabling";

    if (mapping.state !== "Disabled") {
      yield* setMappingEnabled(mapping.uuid, false);
    }

    return { uuid: mapping.uuid, queueArn: mapping.queueArn, originalEnabled };
  }),
  (acquired) =>
    Effect.gen(function* () {
      yield* setMappingEnabled(acquired.uuid, acquired.originalEnabled);
      yield* awaitMappingState(acquired.uuid, acquired.originalEnabled ? "Enabled" : "Disabled");
    }).pipe(Effect.orDie),
).pipe(
  // The waits run once the restore is registered, so a wait that fails still re-enables the mapping.
  Effect.tap((acquired) =>
    awaitMappingState(acquired.uuid, "Disabled").pipe(
      Effect.andThen(awaitPollersStopped(acquired.queueArn)),
    ),
  ),
);

const staleWakeLogged = (blob: string, campaignId: string, runToken: string) =>
  blob.includes(campaignId) && blob.includes(runToken) && blob.includes("stale");

export const awaitStaleWakeLog = (campaignId: string, runToken: string, sinceMs: number) =>
  Effect.gen(function* () {
    const functionName = yield* dispatcherFunctionName;
    const filterLogEvents = yield* logs.filterLogEvents;
    const logGroupName = dispatcherLogGroup(functionName);

    yield* Effect.gen(function* () {
      const page = yield* filterLogEvents({
        logGroupName,
        startTime: sinceMs,
        filterPattern: `"${campaignId}"`,
      });

      const blob = (page.events ?? []).map((event) => event.message ?? "").join("\n");

      return staleWakeLogged(blob, campaignId, runToken);
    }).pipe(
      Effect.repeat({
        schedule: mappingPoll,
        until: (matched: boolean) => matched,
      }),
      Effect.timeoutOrElse({
        duration: staleWakeLogTimeout,
        orElse: () =>
          Effect.die(
            new Error(`no stale-wake log for campaign ${campaignId} with the captured run token`),
          ),
      }),
    );
  });

export const rateLimitItem = Effect.gen(function* () {
  const tableName = yield* Config.String("EMAILER_TEST_TABLE_NAME");
  const getItem = yield* dynamodb.getItem;

  const response = yield* getItem({
    TableName: tableName,
    Key: { pk: str("RATELIMIT#ses-send"), sk: str("RATELIMIT") },
    ConsistentRead: true,
  });

  if (response.Item === undefined) {
    throw new Error("RATELIMIT#ses-send is missing");
  }

  return yield* readRateLimitWindow("rateLimitItem", response.Item);
});

export const dispatchFailureCount = Effect.gen(function* () {
  const queueUrl = yield* Config.String("EMAILER_TEST_DISPATCH_FAILURES_QUEUE_URL");
  const getQueueAttributes = yield* sqs.getQueueAttributes;

  const result = yield* getQueueAttributes({
    QueueUrl: queueUrl,
    AttributeNames: ["ApproximateNumberOfMessages"],
  });

  const raw = result.Attributes?.ApproximateNumberOfMessages;

  if (raw === undefined) {
    throw new Error("DispatchFailures did not report ApproximateNumberOfMessages");
  }

  return Number.parseInt(raw, 10);
});

/** Every capability composed over one live table: what this suite drives, not what any function holds. */
export type LiveStorage = ReturnType<typeof audienceOperations> &
  ReturnType<typeof campaignStoreOperations> &
  ReturnType<typeof suppressionWrites> &
  ReturnType<typeof unsubscribeWrites> &
  ReturnType<typeof feedbackWrites>;

const statusDeadline = "60 seconds";

export const awaitAddressStatus = (storage: LiveStorage, email: string, expected: AddressStatus) =>
  storage.addressStatus(email).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status: AddressStatus) => status === expected,
    }),
    Effect.timeoutOrElse({
      duration: statusDeadline,
      orElse: () => Effect.die(new Error(`${email} did not become ${expected}`)),
    }),
  );

export type AwsClient = Layer.Success<typeof awsClient>;

export const live = <A, E>(use: Effect.Effect<A, E, AwsClient>) =>
  Effect.runPromise(Effect.provide(use, awsClient));

/** A fresh address nothing else in a run will touch. Never a simulator address. */
export const uniqueAddress = Effect.map(newIdentifier, (id) => `probe-${id}@example.invalid`);
