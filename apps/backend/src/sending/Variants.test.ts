import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import type * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";

import { bucketOf, chooseVariant } from "./Variants.ts";

const campaignId = "0195f0a0-1111-4222-8333-4444444ca409";

const contactId = (index: number) =>
  `0195f0a0-1111-4222-8333-${index.toString(16).padStart(12, "0")}`;

const beginners: Schemas.VariantRoute = { key: "beginners", when: { level: "beginner" } };

const berlin: Schemas.VariantRoute = { key: "berlin", when: { city: "Berlin" } };

const tenPercent: Schemas.VariantRoute = { key: "ten", percent: 10 };

const thirty: Schemas.VariantRoute = { key: "thirty", percent: 30 };

describe("bucketOf", () => {
  it.effect("puts the same contact of the same campaign in the same bucket every time", () =>
    Effect.gen(function* () {
      const first = yield* bucketOf(campaignId, contactId(1));

      expect(yield* bucketOf(campaignId, contactId(1))).toBe(first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(100);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("spreads contacts evenly enough that a split's shares hold", () =>
    Effect.gen(function* () {
      const total = 10_000;

      const buckets = yield* Effect.forEach(
        Array.from({ length: total }, (_, index) => contactId(index)),
        (id) => bucketOf(campaignId, id),
      );

      // Each tenth of the range within two points of its tenth of the contacts.
      for (let tenth = 0; tenth < 10; tenth += 1) {
        const share = buckets.filter((bucket) => Math.floor(bucket / 10) === tenth).length / total;

        expect(Math.abs(share - 0.1)).toBeLessThan(0.02);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe("chooseVariant", () => {
  const choose = (
    routes: ReadonlyArray<Schemas.VariantRoute>,
    attributes: Schemas.ContactAttributes | undefined,
    id = contactId(1),
  ) =>
    chooseVariant(campaignId, attributes === undefined ? { id } : { id, attributes }, routes).pipe(
      Effect.map((route) => route?.key),
      Effect.provide(NodeCrypto.layer),
    );

  it.effect("takes the first targeted variant a contact matches, in order", () =>
    Effect.gen(function* () {
      const both = { level: "beginner", city: "Berlin" };

      expect(yield* choose([beginners, berlin], both)).toBe("beginners");
      expect(yield* choose([berlin, beginners], both)).toBe("berlin");
    }),
  );

  it.effect("targets before it splits, whatever the bucket", () =>
    Effect.gen(function* () {
      expect(yield* choose([{ key: "all", percent: 100 }, berlin], { city: "Berlin" })).toBe(
        "berlin",
      );
    }),
  );

  it.effect("falls to the campaign's own copy when nothing targets and no split is set", () =>
    Effect.gen(function* () {
      expect(yield* choose([beginners], { level: "advanced" })).toBeUndefined();
      expect(yield* choose([beginners], undefined)).toBeUndefined();
    }),
  );

  it.effect(
    "gives each split variant its range of buckets in order, and the rest to the own copy",
    () =>
      Effect.gen(function* () {
        for (let index = 0; index < 200; index += 1) {
          const id = contactId(index);
          const bucket = yield* bucketOf(campaignId, id).pipe(Effect.provide(NodeCrypto.layer));
          const expected = bucket < 10 ? "ten" : bucket < 40 ? "thirty" : undefined;

          expect(yield* choose([tenPercent, beginners, thirty], {}, id)).toBe(expected);
        }
      }),
  );
});
