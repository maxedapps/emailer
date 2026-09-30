import * as Schemas from "@emailer/api/Schemas";
import { Effect, FileSystem, Option } from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";

import { inBatches, report, withClient } from "../Client.ts";
import { decodeCsvAttributes } from "../CsvContacts.ts";
import { entityPageFlags, idArgument, pageQuery } from "../Flags.ts";

/**
 * An attribute map as repeated `key=value` pairs. The same bounds the service enforces apply at
 * parsing: too many entries or an oversized key is refused here with a usable message rather than
 * as a 400 after a round trip. The typed client still validates, so this narrows the moment of
 * refusal, not the rule.
 */
const attributesFlag = (description: string) =>
  Flag.KeyValuePair("attr").pipe(
    Flag.withDescription(description),
    Flag.withSchema(Schemas.ContactAttributes),
    Flag.optional,
  );

const contactsCreate = Command.make(
  "create",
  {
    email: Flag.String("email").pipe(
      Flag.withDescription("The contact's email address"),
      Flag.withSchema(Schemas.EmailAddress),
    ),
    name: Flag.String("name").pipe(
      Flag.withDescription("The contact's display name"),
      Flag.withSchema(Schemas.EntityName),
      Flag.optional,
    ),
    attr: attributesFlag("The contact's attributes, as repeated key=value pairs"),
  },
  Effect.fn(function* (input) {
    const created = yield* withClient((client) =>
      client.contacts.create({
        payload: {
          email: input.email,
          name: Option.getOrUndefined(input.name),
          attributes: Option.getOrUndefined(input.attr),
        },
      }),
    );

    yield* report(created);
  }),
).pipe(
  Command.withDescription("Create a contact"),
  Command.withExamples([
    {
      command: "emailer contacts create --email sam@example.com --attr plan=pro --attr city=Berlin",
      description: "Create a contact with two attributes",
    },
  ]),
);

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
  attributes?: Schemas.AttributePatch | null;
}

const refuse = (userMessage: string) => new CliError.UserError({ cause: userMessage, userMessage });

/**
 * An omitted flag leaves a field alone; `--clear-name` and `--clear-attributes` are how a CLI
 * expresses the contract's null. `--attr` and `--unset` become one merge patch.
 */
const contactChange = (input: {
  readonly email: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly clearName: boolean;
  readonly attr: Option.Option<Schemas.ContactAttributes>;
  readonly unset: ReadonlyArray<string>;
  readonly clearAttributes: boolean;
}) => {
  const payload: ContactChange = {};

  if (Option.isSome(input.email)) {
    payload.email = input.email.value;
  }

  if (input.clearName) {
    payload.name = null;
  } else if (Option.isSome(input.name)) {
    payload.name = input.name.value;
  }

  if (input.clearAttributes) {
    payload.attributes = null;
  } else if (Option.isSome(input.attr) || input.unset.length > 0) {
    payload.attributes = {
      ...Option.getOrUndefined(input.attr),
      ...Object.fromEntries(input.unset.map((key) => [key, null])),
    };
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
    email: Flag.String("email").pipe(
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
    email: Flag.String("email").pipe(
      Flag.withDescription("A new address for the contact"),
      Flag.withSchema(Schemas.EmailAddress),
      Flag.optional,
    ),
    name: Flag.String("name").pipe(
      Flag.withDescription("A new display name"),
      Flag.withSchema(Schemas.EntityName),
      Flag.optional,
    ),
    clearName: Flag.Boolean("clear-name").pipe(
      Flag.withDescription("Remove the display name"),
      Flag.withDefault(false),
    ),
    attr: attributesFlag("Set attributes, as repeated key=value pairs; others are kept"),
    unset: Flag.String("unset").pipe(
      Flag.withDescription("Remove an attribute; repeat for each key"),
      Flag.between(0, Schemas.maxAttributeEntries),
    ),
    clearAttributes: Flag.Boolean("clear-attributes").pipe(
      Flag.withDescription("Remove every attribute"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* (input) {
    if (input.clearAttributes && (Option.isSome(input.attr) || input.unset.length > 0)) {
      return yield* refuse("Pass --clear-attributes alone, or --attr and --unset");
    }

    const payload = contactChange(input);

    yield* report(
      yield* withClient((client) => client.contacts.update({ params: { id: input.id }, payload })),
    );
  }),
).pipe(
  Command.withDescription("Change a contact; an omitted field is left alone"),
  Command.withExamples([
    {
      command:
        "emailer contacts update 0195f0a0-1111-4222-8333-44444444c001 --attr plan=pro --unset trial",
      description: "Set one attribute and remove another, keeping the rest",
    },
  ]),
);

/**
 * Read and decoded here, like an import file, so a row that fails is named by its line before any
 * request is made.
 */
const attributesFile = Flag.File("file", { mustExist: true }).pipe(
  Flag.withDescription("A CSV file: an email column, and one column per attribute to set"),
  Flag.mapEffect((path) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      return yield* decodeCsvAttributes(yield* fs.readFileString(path));
    }).pipe(
      Effect.mapError(
        (error) =>
          new CliError.InvalidValue({
            option: "file",
            value: path,
            expected: error.message,
            kind: "flag",
          }),
      ),
    ),
  ),
);

const contactsSetAttributes = Command.make(
  "set-attributes",
  { file: attributesFile },
  Effect.fn(function* (input) {
    const contacts = yield* inBatches(
      input.file.contacts,
      (client, batch) => client.contacts.setAttributes({ payload: { contacts: batch } }),
      "Updated",
    );

    yield* report({ contacts });
  }),
).pipe(
  Command.withDescription(
    "Merge attributes from a CSV file into the contacts holding its addresses",
  ),
  Command.withExamples([
    {
      command: "emailer contacts set-attributes --file segments.csv",
      description:
        "Set each row's attributes on the contact with its email, keeping the others; a blank cell changes nothing",
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
    contactsSetAttributes,
    contactsDelete,
  ]),
);
