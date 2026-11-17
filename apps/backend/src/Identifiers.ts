import { DateTime, Effect } from "effect";
import { SecureRandom } from "effect/crypto";

export const newIdentifier = Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV4());

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
