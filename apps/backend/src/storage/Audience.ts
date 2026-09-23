import { Context, Crypto, Effect, Layer } from "effect";

import { addressReads, addressWrites } from "./Addresses.ts";
import { contactOperations } from "./Contacts.ts";
import { listOperations } from "./Lists.ts";
import { membershipOperations } from "./Membership.ts";
import { allPrimitives } from "./Primitives.ts";

import type { TransactionTokens } from "./Primitives.ts";
import { AllTableOperationsHttp, allTableOperations } from "./Table.ts";

import type { TableOperations } from "./Items.ts";

/**
 * Everything the administrative API does to the audience: contacts, lists, membership and imports,
 * plus the mailability question the send path asks about an address. These share transactions —
 * creating a contact writes its address reservation, importing writes members and reservations
 * together — so splitting them further would fragment a transaction across services without
 * narrowing a single permission.
 *
 * AudienceStore and CampaignStore both use all six operations.
 */
export const audienceOperations = (operations: TableOperations, tokens: TransactionTokens) => {
  const primitives = allPrimitives(operations, tokens);

  return {
    ...contactOperations(primitives),
    ...listOperations(primitives),
    ...membershipOperations(primitives),
    ...addressReads(primitives),
    ...addressWrites(primitives),
  } as const;
};

export type AudienceOperations = ReturnType<typeof audienceOperations>;

export class AudienceStore extends Context.Service<AudienceStore, AudienceOperations>()(
  "emailer/backend/AudienceStore",
) {}

export const AudienceStoreLive = Layer.effect(AudienceStore)(
  Effect.gen(function* () {
    const operations = yield* allTableOperations;
    const crypto = yield* Crypto.Crypto;

    return AudienceStore.of(audienceOperations(operations, Effect.orDie(crypto.randomUUIDv4)));
  }),
).pipe(Layer.provide(AllTableOperationsHttp));
