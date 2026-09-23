import type * as dynamodb from "@distilled.cloud/aws/dynamodb";
import type * as Schemas from "@emailer/api/Schemas";
import type * as AWS from "alchemy/AWS";
import type { Effect } from "effect";
import { Duration, Schema, SchemaTransformation } from "effect";

export const tableLogicalId = "EmailerData";

export const recordVersion = 1;

export const operationTimeout = Duration.seconds(5);

/**
 * The sparse listing index. Written to listable `META` items (contact, list, campaign), so send
 * and feedback writes do not touch it. The name is a literal: deriving it from an Output or a
 * `Config` read is what makes an index name a cold-start hazard.
 */
export const listingIndexName = "gsi1";

export const str = (value: string) => ({ S: value });

export const strSet = (values: ReadonlyArray<string>) => ({ SS: [...values] });

export const num = (value: number) => ({ N: String(value) });

export const campaignKey = (campaignId: string) => ({
  pk: str(`CAMPAIGN#${campaignId}`),
  sk: str("META"),
});

export const bodyKey = (campaignId: string) => ({
  pk: str(`CAMPAIGN#${campaignId}`),
  sk: str("BODY"),
});

export const strMap = (values: Schemas.ContactAttributes) => ({
  M: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, str(value)])),
});

/**
 * The three attribute kinds this table stores, as codecs rather than as extraction helpers.
 *
 * An attribute of the wrong kind — a number where a string belongs, or a corrupt optional field —
 * is a decoding failure, which is what `corrupt` exists to report, rather than reading as absent.
 *
 * Composing them with a domain schema is `Schema.decodeTo(..., passthrough())`, so an item schema
 * states the wire shape and the domain rule in one place, and the same schema encodes back.
 */
export const StringAttribute = Schema.Struct({ S: Schema.String }).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (attribute: { readonly S: string }) => attribute.S,
      encode: (value: string) => ({ S: value }),
    }),
  ),
);

export const NumberAttribute = Schema.Struct({ N: Schema.FiniteFromString }).pipe(
  Schema.decodeTo(
    Schema.Finite,
    SchemaTransformation.transform({
      decode: (attribute: { readonly N: number }) => attribute.N,
      encode: (value: number) => ({ N: value }),
    }),
  ),
);

export const StringMapAttribute = Schema.Struct({
  M: Schema.Record(Schema.String, StringAttribute),
}).pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.String),
    SchemaTransformation.transform({
      decode: (attribute: { readonly M: Record<string, string> }) => attribute.M,
      encode: (value: Record<string, string>) => ({ M: value }),
    }),
  ),
);

/** Applies a domain rule to a string attribute: the wire kind and the rule in one schema. */
export const attributeOf = <T>(domain: Schema.Codec<T, string>) =>
  StringAttribute.pipe(Schema.decodeTo(domain, SchemaTransformation.passthrough()));

/**
 * The index attributes of a listable entity. `gsi1sk` is `<createdAt>#<id>`, which gives created
 * order and *is* `Schemas.EntityCursor`, so a page resumes from a domain value rather than from a
 * database key.
 */
export const listingAttributes = (kind: string, createdAt: string, id: string) => ({
  gsi1pk: str(kind),
  gsi1sk: str(`${createdAt}#${id}`),
});

type OptionalAttribute = readonly [name: string, value: string | undefined];

export const withOptional = (
  item: dynamodb.AttributeMap,
  attributes: ReadonlyArray<OptionalAttribute>,
): dynamodb.AttributeMap => {
  const merged: dynamodb.AttributeMap = { ...item };

  for (const [name, value] of attributes) {
    if (value !== undefined) {
      merged[name] = str(value);
    }
  }

  return merged;
};

const StoredVersion = Schema.Literal(recordVersion);

/** Every item carries the record version this code knows how to read; a different one is corrupt. */
export const StoredVersionAttribute = Schema.Struct({
  N: Schema.Literal(String(recordVersion)),
}).pipe(
  Schema.decodeTo(
    StoredVersion,
    SchemaTransformation.transform({
      decode: () => recordVersion,
      encode: () => ({ N: String(recordVersion) }),
    }),
  ),
);

export interface TableOperations {
  readonly getItem: (
    request: AWS.DynamoDB.GetItemRequest,
  ) => Effect.Effect<dynamodb.GetItemOutput, dynamodb.GetItemError>;
  readonly batchGetItem: (
    request: AWS.DynamoDB.BatchGetItemRequest,
  ) => Effect.Effect<dynamodb.BatchGetItemOutput, dynamodb.BatchGetItemError>;
  readonly putItem: (
    request: AWS.DynamoDB.PutItemRequest,
  ) => Effect.Effect<dynamodb.PutItemOutput, dynamodb.PutItemError>;
  readonly updateItem: (
    request: AWS.DynamoDB.UpdateItemRequest,
  ) => Effect.Effect<dynamodb.UpdateItemOutput, dynamodb.UpdateItemError>;
  readonly query: (
    request: AWS.DynamoDB.QueryRequest,
  ) => Effect.Effect<dynamodb.QueryOutput, dynamodb.QueryError>;
  readonly transactWriteItems: (
    request: AWS.DynamoDB.TransactWriteItemsRequest,
  ) => Effect.Effect<dynamodb.TransactWriteItemsOutput, dynamodb.TransactWriteItemsError>;
}
