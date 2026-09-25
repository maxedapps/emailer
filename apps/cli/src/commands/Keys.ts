import * as Schemas from "@emailer/api/Schemas";
import { Array as Arr, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { report, withClient } from "../Client.ts";
import { idArgument } from "../Flags.ts";

const keysCreate = Command.make(
  "create",
  {
    name: Flag.String("name").pipe(
      Flag.withDescription("What the key is for, such as the site that holds it"),
      Flag.withSchema(Schemas.EntityName),
    ),
    lists: Flag.String("list").pipe(
      Flag.withDescription("A list the key may add subscribers to; repeat it for several"),
      Flag.withSchema(Schemas.EntityId),
      Flag.atLeast(1),
      // `atLeast` guarantees one; this states it in the type the payload asks for.
      Flag.filterMap(Option.liftPredicate(Arr.isReadonlyArrayNonEmpty), () => "Expected a --list"),
    ),
    confirmUrl: Flag.String("confirm-url").pipe(
      Flag.withDescription("The site's https page that confirms a sign-up"),
      Flag.withSchema(Schemas.ConfirmUrl),
    ),
  },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.keys.create({
          payload: { name: input.name, lists: input.lists, confirmUrl: input.confirmUrl },
        }),
      ),
    );
  }),
).pipe(Command.withDescription("Create a scoped key for a site's sign-up form; shown only once"));

const keysList = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    yield* report(yield* withClient((client) => client.keys.list()));
  }),
).pipe(Command.withDescription("List the scoped keys, without their secrets"));

const keysRevoke = Command.make(
  "revoke",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* withClient((client) => client.keys.revoke({ params: { id: input.id } }));

    yield* report({ id: input.id, revoked: true });
  }),
).pipe(Command.withDescription("Revoke a scoped key; it stops working at once"));

export const keys = Command.make("keys").pipe(
  Command.withDescription("Manage the scoped keys that sites sign subscribers up with"),
  Command.withSubcommands([keysCreate, keysList, keysRevoke]),
);
