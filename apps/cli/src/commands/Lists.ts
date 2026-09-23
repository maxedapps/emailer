import * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { report, withClient } from "../Client.ts";
import { entityPageFlags, idArgument, memberPageFlags, pageQuery } from "../Flags.ts";

const listsCreate = Command.make(
  "create",
  {
    name: Flag.string("name").pipe(
      Flag.withDescription("The list's name"),
      Flag.withSchema(Schemas.EntityName),
    ),
  },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) => client.lists.create({ payload: { name: input.name } })),
    );
  }),
).pipe(Command.withDescription("Create a list"));

const listsGet = Command.make(
  "get",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* report(yield* withClient((client) => client.lists.get({ params: { id: input.id } })));
  }),
).pipe(Command.withDescription("Retrieve a list by id"));

const listsAddContact = Command.make(
  "add-contact",
  { listId: idArgument("listId"), contactId: idArgument("contactId") },
  Effect.fn(function* (input) {
    yield* withClient((client) =>
      client.lists.addContact({ params: { listId: input.listId, contactId: input.contactId } }),
    );

    yield* report({ listId: input.listId, contactId: input.contactId, member: true });
  }),
).pipe(Command.withDescription("Add a contact to a list; repeating it changes nothing"));

const listsList = Command.make(
  "list",
  entityPageFlags,
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.lists.list({ query: pageQuery(input.limit, input.cursor) }),
      ),
    );
  }),
).pipe(Command.withDescription("List lists in the order they were created"));

const listsMembers = Command.make(
  "members",
  { listId: idArgument("listId"), ...memberPageFlags },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.lists.listMembers({
          params: { listId: input.listId },
          query: pageQuery(input.limit, input.cursor),
        }),
      ),
    );
  }),
).pipe(Command.withDescription("List the contacts in a list"));

const listsRename = Command.make(
  "rename",
  {
    id: idArgument("id"),
    name: Flag.string("name").pipe(
      Flag.withDescription("The list's new name"),
      Flag.withSchema(Schemas.EntityName),
    ),
  },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.lists.update({ params: { id: input.id }, payload: { name: input.name } }),
      ),
    );
  }),
).pipe(Command.withDescription("Rename a list"));

const listsDelete = Command.make(
  "delete",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* withClient((client) => client.lists.remove({ params: { id: input.id } }));

    yield* report({ id: input.id, deleted: true });
  }),
).pipe(Command.withDescription("Delete a list and every membership in it"));

const listsRemoveContact = Command.make(
  "remove-contact",
  { listId: idArgument("listId"), contactId: idArgument("contactId") },
  Effect.fn(function* (input) {
    yield* withClient((client) =>
      client.lists.removeContact({
        params: { listId: input.listId, contactId: input.contactId },
      }),
    );

    yield* report({ listId: input.listId, contactId: input.contactId, member: false });
  }),
).pipe(Command.withDescription("Remove a contact from a list; repeating it changes nothing"));

const listsImport = Command.make(
  "import",
  {
    listId: idArgument("listId"),
    file: Flag.fileSchema("file", Schemas.ImportContactsPayload, { format: "json" }).pipe(
      Flag.withDescription("A JSON file holding the contacts to load"),
    ),
  },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.lists.import({ params: { listId: input.listId }, payload: input.file }),
      ),
    );
  }),
).pipe(
  Command.withDescription("Load a batch of contacts into a list"),
  Command.withExamples([
    {
      command: "emailer lists import 0195f0a0-1111-4222-8333-44444444109e --file contacts.json",
      description: "Load up to 20 contacts, reusing any that already hold their address",
    },
  ]),
);

export const lists = Command.make("lists").pipe(
  Command.withDescription("Work with lists"),
  Command.withSubcommands([
    listsCreate,
    listsGet,
    listsList,
    listsMembers,
    listsRename,
    listsDelete,
    listsAddContact,
    listsRemoveContact,
    listsImport,
  ]),
);
