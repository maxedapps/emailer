/**
 * The shared storage test seam: a recording `TableOperations` double that serves scripted replies
 * by call order, plus the fixtures the item-owning modules' suites have in common. It lives beside
 * those modules rather than inside one of their `*.test.ts` files, because importing a test file
 * from another test file would re-register its suites.
 */
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import type * as AWS from "alchemy/AWS";
import { Cause, Effect, Exit, Result } from "effect";

import { allPrimitives } from "./Primitives.ts";

import type { TransactionTokens } from "./Primitives.ts";

import type { AudienceOperations } from "./Audience.ts";
import type { CampaignStoreOperations } from "./Campaigns.ts";

import type { TableOperations } from "./Items.ts";

type GetItemReply = Effect.Effect<dynamodb.GetItemOutput, dynamodb.GetItemError>;

type BatchGetItemReply = Effect.Effect<dynamodb.BatchGetItemOutput, dynamodb.BatchGetItemError>;

type PutItemReply = Effect.Effect<dynamodb.PutItemOutput, dynamodb.PutItemError>;

type UpdateItemReply = Effect.Effect<dynamodb.UpdateItemOutput, dynamodb.UpdateItemError>;

type QueryReply = Effect.Effect<dynamodb.QueryOutput, dynamodb.QueryError>;

export type TransactionReply = Effect.Effect<
  dynamodb.TransactWriteItemsOutput,
  dynamodb.TransactWriteItemsError
>;

export interface ScriptedReplies {
  readonly getItem?: ReadonlyArray<GetItemReply>;
  readonly batchGetItem?: ReadonlyArray<BatchGetItemReply>;
  readonly putItem?: ReadonlyArray<PutItemReply>;
  readonly updateItem?: ReadonlyArray<UpdateItemReply>;
  readonly query?: ReadonlyArray<QueryReply>;
  readonly transactWriteItems?: ReadonlyArray<TransactionReply>;
}

export interface Table {
  readonly operations: TableOperations;
  readonly getItemRequests: Array<AWS.DynamoDB.GetItemRequest>;
  readonly batchGetItemRequests: Array<AWS.DynamoDB.BatchGetItemRequest>;
  readonly putItemRequests: Array<AWS.DynamoDB.PutItemRequest>;
  readonly updateItemRequests: Array<AWS.DynamoDB.UpdateItemRequest>;
  readonly queryRequests: Array<AWS.DynamoDB.QueryRequest>;
  readonly transactionRequests: Array<AWS.DynamoDB.TransactWriteItemsRequest>;
}

/**
 * One operation of the double: it records each request and answers with the reply scripted for its
 * position in the call order, or the fallback once the script runs out.
 */
const recorder =
  <Request, A, E>(
    requests: Array<Request>,
    replies: ReadonlyArray<Effect.Effect<A, E>> | undefined,
    fallback: A,
  ) =>
  (request: Request): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      requests.push(request);

      return replies?.[requests.length - 1] ?? Effect.succeed(fallback);
    });

export const scriptedTable = (replies: ScriptedReplies): Table => {
  const getItemRequests: Array<AWS.DynamoDB.GetItemRequest> = [];
  const batchGetItemRequests: Array<AWS.DynamoDB.BatchGetItemRequest> = [];
  const putItemRequests: Array<AWS.DynamoDB.PutItemRequest> = [];
  const updateItemRequests: Array<AWS.DynamoDB.UpdateItemRequest> = [];
  const queryRequests: Array<AWS.DynamoDB.QueryRequest> = [];
  const transactionRequests: Array<AWS.DynamoDB.TransactWriteItemsRequest> = [];

  const operations: TableOperations = {
    getItem: recorder(getItemRequests, replies.getItem, {}),
    batchGetItem: recorder(batchGetItemRequests, replies.batchGetItem, {}),
    putItem: recorder(putItemRequests, replies.putItem, {}),
    updateItem: recorder(updateItemRequests, replies.updateItem, {}),
    query: recorder(queryRequests, replies.query, { Items: [] }),
    transactWriteItems: recorder(transactionRequests, replies.transactWriteItems, {}),
  };

  return {
    operations,
    getItemRequests,
    batchGetItemRequests,
    putItemRequests,
    updateItemRequests,
    queryRequests,
    transactionRequests,
  };
};

export const cancelled = (...codes: ReadonlyArray<string>): TransactionReply =>
  Effect.fail(
    new dynamodb.TransactionCanceledException({
      CancellationReasons: codes.map((Code) => ({ Code })),
    }),
  );

export const serverError = new dynamodb.InternalServerError({ message: "boom" });

/** A single-item write whose condition failed. Fails with `never` success, so it scripts any write. */
export const conditionFailed = Effect.fail(
  new dynamodb.ConditionalCheckFailedException({ message: "the conditional request failed" }),
);

/** The defect an operation died with, such as `CorruptItem`. Anything else fails the test. */
export const defectOf = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(operation), (exit) => {
    const defect = Exit.isFailure(exit) ? Cause.findDefect(exit.cause) : undefined;

    if (defect === undefined || Result.isFailure(defect)) {
      throw new Error("Expected the operation to die");
    }

    return defect.success;
  });

export const contactId = "0195f0a0-1111-4222-8333-44444444c001";

export const listId = "0195f0a0-1111-4222-8333-44444444109e";

export const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

export const createdAt = "2026-09-11T10:00:00.000Z";

/**
 * Deterministic transaction tokens, numbered by the requests already sent: the first logical call
 * carries `token-1`, and a call the store retries as a new one carries the next number, while a
 * repeat the client sends on its own carries the same token because nothing new was issued.
 */
export const tokensFor = (sent: ReadonlyArray<unknown>): TransactionTokens =>
  Effect.sync(() => `token-${sent.length + 1}`);

/**
 * Every primitive over a scripted table, so a suite can exercise one item group through its own
 * factory — `contactOperations(primitivesFor(table))` — instead of standing up a whole application
 * store.
 */
export const primitivesFor = (table: Table) =>
  allPrimitives(table.operations, tokensFor(table.transactionRequests));

const notExercised = (capability: string, operation: string) =>
  Effect.die(new Error(`${capability}.${operation} is not exercised by this test`));

/**
 * `AudienceStore` and `CampaignStore` are the two capabilities large enough that listing every
 * operation in every suite would be noise. Spreading one of these and overriding what a test
 * exercises reports an operation reached by accident rather than answering it with a
 * plausible-looking default.
 *
 * The narrow writers, `FeedbackStore` and `UnsubscribeStore`, have no stub: their suites state
 * those operations in full, which is the point of splitting them. A feedback test cannot reach a
 * contact read, because its service does not have one.
 */
export const unusedAudience: AudienceOperations = {
  createContact: () => notExercised("AudienceStore", "createContact"),
  getContact: () => notExercised("AudienceStore", "getContact"),
  getContactByEmail: () => notExercised("AudienceStore", "getContactByEmail"),
  listContacts: () => notExercised("AudienceStore", "listContacts"),
  updateContact: () => notExercised("AudienceStore", "updateContact"),
  deleteContact: () => notExercised("AudienceStore", "deleteContact"),
  createList: () => notExercised("AudienceStore", "createList"),
  getList: () => notExercised("AudienceStore", "getList"),
  listLists: () => notExercised("AudienceStore", "listLists"),
  renameList: () => notExercised("AudienceStore", "renameList"),
  deleteList: () => notExercised("AudienceStore", "deleteList"),
  addMember: () => notExercised("AudienceStore", "addMember"),
  removeMember: () => notExercised("AudienceStore", "removeMember"),
  listMembers: () => notExercised("AudienceStore", "listMembers"),
  importContacts: () => notExercised("AudienceStore", "importContacts"),
  addressStatus: () => notExercised("AudienceStore", "addressStatus"),
  addressRecord: () => notExercised("AudienceStore", "addressRecord"),
  unsuppress: () => notExercised("AudienceStore", "unsuppress"),
};

export const unusedCampaigns: CampaignStoreOperations = {
  createCampaign: () => notExercised("CampaignStore", "createCampaign"),
  getCampaignBody: () => notExercised("CampaignStore", "getCampaignBody"),
  getCampaign: () => notExercised("CampaignStore", "getCampaign"),
  listCampaigns: () => notExercised("CampaignStore", "listCampaigns"),
  getCampaignControl: () => notExercised("CampaignStore", "getCampaignControl"),
  newRun: () => notExercised("CampaignStore", "newRun"),
  cancelCampaign: () => notExercised("CampaignStore", "cancelCampaign"),
  updateDraft: () => notExercised("CampaignStore", "updateDraft"),
  deleteDraft: () => notExercised("CampaignStore", "deleteDraft"),
  beginRun: () => notExercised("CampaignStore", "beginRun"),
  claimRecipient: () => notExercised("CampaignStore", "claimRecipient"),
  skipRecipient: () => notExercised("CampaignStore", "skipRecipient"),
  settleRecipient: () => notExercised("CampaignStore", "settleRecipient"),
  checkpoint: () => notExercised("CampaignStore", "checkpoint"),
  completeRun: () => notExercised("CampaignStore", "completeRun"),
  pauseRun: () => notExercised("CampaignStore", "pauseRun"),
};
