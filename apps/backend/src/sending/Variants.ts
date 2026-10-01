import * as Schemas from "@emailer/api/Schemas";
import { Crypto, Effect } from "effect";

const buckets = 100;

const utf8 = new TextEncoder();

/**
 * Where a contact falls in a campaign's split, 0 to 99: the first four bytes of the SHA-256 of the
 * two identifiers, as an unsigned integer, modulo 100. The same pair always lands in the same
 * bucket, whichever slice or deployment computes it, and each campaign draws its split afresh.
 */
export const bucketOf = Effect.fn("Variants.bucketOf")(function* (
  campaignId: string,
  contactId: string,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", utf8.encode(`${campaignId}/${contactId}`));

  return new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0) % buckets;
});

export const matchesAttributes = (
  wanted: Schemas.ContactAttributes,
  attributes: Schemas.ContactAttributes | undefined,
) => Object.entries(wanted).every(([key, value]) => attributes?.[key] === value);

/**
 * Which copy a contact gets: the first variant whose `when` its attributes match; otherwise the
 * `percent` variant whose range, in order, holds its bucket; otherwise none, which means the
 * campaign's own copy. The bucket is only computed when a split is left to decide.
 */
export const chooseVariant = Effect.fn("Variants.chooseVariant")(function* <
  Route extends Schemas.VariantRoute,
>(
  campaignId: string,
  contact: Pick<Schemas.Contact, "id" | "attributes">,
  routes: ReadonlyArray<Route>,
) {
  const targeted = routes.find(
    (route) => route.when !== undefined && matchesAttributes(route.when, contact.attributes),
  );

  if (targeted !== undefined) {
    return targeted;
  }

  const split = routes.filter((route) => route.percent !== undefined);

  if (split.length === 0) {
    return undefined;
  }

  const bucket = yield* bucketOf(campaignId, contact.id);
  let ceiling = 0;

  for (const route of split) {
    ceiling += route.percent ?? 0;

    if (bucket < ceiling) {
      return route;
    }
  }

  return undefined;
});
