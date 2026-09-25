import * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { report, withClient } from "../Client.ts";

const addressesStatus = Command.make(
  "status",
  {
    email: Flag.String("email").pipe(
      Flag.withDescription("The address to inspect, exactly as SES lists it"),
      Flag.withSchema(Schemas.ListedEmailAddress),
    ),
  },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) => client.addresses.status({ query: { email: input.email } })),
    );
  }),
).pipe(
  Command.withDescription(
    "Show the lists an address left, its consents and pending sign-ups, and its suppression",
  ),
);

const addressesUnsuppress = Command.make(
  "unsuppress",
  {
    email: Flag.String("email").pipe(
      Flag.withDescription("The address to remove from suppression, exactly as SES lists it"),
      Flag.withSchema(Schemas.ListedEmailAddress),
    ),
  },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.addresses.unsuppress({ payload: { email: input.email } }),
      ),
    );
  }),
).pipe(Command.withDescription("Clear local and account suppression for an address"));

export const addresses = Command.make("addresses").pipe(
  Command.withDescription("Inspect and clear address suppression"),
  Command.withSubcommands([addressesStatus, addressesUnsuppress]),
);
