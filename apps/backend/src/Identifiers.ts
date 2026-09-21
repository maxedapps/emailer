import { Crypto, DateTime, Effect } from "effect";

export const newIdentifier = Effect.flatMap(Crypto.Crypto, (crypto) =>
  Effect.orDie(crypto.randomUUIDv4),
);

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
