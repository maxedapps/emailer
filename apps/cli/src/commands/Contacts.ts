import * as Schemas from "@emailer/api/Schemas";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { report, withClient } from "../Client.ts";
import { entityPageFlags, idArgument, pageQuery } from "../Flags.ts";

const contactsCreate = Command.make(
  "create",
  {
    email: Flag.string("email").pipe(
      Flag.withDescription("The contact's email address"),
      Flag.withSchema(Schemas.EmailAddress),
    ),
    name: Flag.string("name").pipe(
      Flag.withDescription("The contact's display name"),
      Flag.withSchema(Schemas.EntityName),
      Flag.optional,
    ),
  },
  Effect.fn(function* (input) {
    const created = yield* withClient((client) =>
      client.contacts.create({
        payload: Option.isSome(input.name)
          ? { email: input.email, name: input.name.value }
          : { email: input.email },
      }),
    );

    yield* report(created);
  }),
).pipe(Command.withDescription("Create a contact"));

const contactsGet = Command.make(
  "get",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* report(yield* withClient((client) => client.contacts.get({ params: { id: input.id } })));
  }),
).pipe(Command.withDescription("Retrieve a contact by id"));

interface ContactChange {
  email?: string;
  name?: string | null;
  attributes?: Schemas.ContactAttributes;
}

/** An omitted flag leaves a field alone; `--clear-name` is how a CLI expresses the contract's null. */
const contactChange = (
  email: Option.Option<string>,
  name: Option.Option<string>,
  clearName: boolean,
  attributes: Option.Option<Schemas.ContactAttributes>,
) => {
  const payload: ContactChange = {};

  if (Option.isSome(email)) {
    payload.email = email.value;
  }

  if (clearName) {
    payload.name = null;
  } else if (Option.isSome(name)) {
    payload.name = name.value;
  }

  if (Option.isSome(attributes)) {
    payload.attributes = attributes.value;
  }

  return payload;
};

const contactsList = Command.make(
  "list",
  entityPageFlags,
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.contacts.list({ query: pageQuery(input.limit, input.cursor) }),
      ),
    );
  }),
).pipe(Command.withDescription("List contacts in the order they were created"));

const contactsByEmail = Command.make(
  "by-email",
  {
    email: Flag.string("email").pipe(
      Flag.withDescription("The address to look up"),
      Flag.withSchema(Schemas.EmailAddress),
    ),
  },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) => client.contacts.getByEmail({ query: { email: input.email } })),
    );
  }),
).pipe(Command.withDescription("Find the contact that holds an address"));

const contactsUpdate = Command.make(
  "update",
  {
    id: idArgument("id"),
    email: Flag.string("email").pipe(
      Flag.withDescription("A new address for the contact"),
      Flag.withSchema(Schemas.EmailAddress),
      Flag.optional,
    ),
    name: Flag.string("name").pipe(
      Flag.withDescription("A new display name"),
      Flag.withSchema(Schemas.EntityName),
      Flag.optional,
    ),
    clearName: Flag.boolean("clear-name").pipe(
      Flag.withDescription("Remove the display name"),
      Flag.withDefault(false),
    ),
    attr: Flag.keyValuePair("attr").pipe(
      Flag.withDescription("Replace the whole attribute map, as repeated key=value pairs"),
      // The same bounds the service enforces, applied at parsing: too many entries or an
      // oversized key is refused here with a usable message rather than as a 400 after a round
      // trip. The typed client still validates, so this narrows the moment of refusal, not the rule.
      Flag.withSchema(Schemas.ContactAttributes),
      Flag.optional,
    ),
  },
  Effect.fn(function* (input) {
    const payload = contactChange(input.email, input.name, input.clearName, input.attr);

    yield* report(
      yield* withClient((client) => client.contacts.update({ params: { id: input.id }, payload })),
    );
  }),
).pipe(
  Command.withDescription("Change a contact; an omitted field is left alone"),
  Command.withExamples([
    {
      command: "emailer contacts update 0195f0a0-1111-4222-8333-44444444c001 --attr plan=pro",
      description: "Replace the attribute map with a single entry",
    },
  ]),
);

const contactsDelete = Command.make(
  "delete",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* withClient((client) => client.contacts.remove({ params: { id: input.id } }));

    yield* report({ id: input.id, deleted: true });
  }),
).pipe(Command.withDescription("Delete a contact and every membership it holds"));

export const contacts = Command.make("contacts").pipe(
  Command.withDescription("Work with contacts"),
  Command.withSubcommands([
    contactsCreate,
    contactsGet,
    contactsByEmail,
    contactsList,
    contactsUpdate,
    contactsDelete,
  ]),
);
