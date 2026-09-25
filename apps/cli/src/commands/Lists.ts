import * as Schemas from "@emailer/api/Schemas";
import { Array as Arr, Console, Effect, FileSystem, Schema } from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";

import { report, withClient } from "../Client.ts";
import { decodeCsvContacts } from "../CsvContacts.ts";
import { entityPageFlags, idArgument, memberPageFlags, pageQuery } from "../Flags.ts";

const listsCreate = Command.make(
  "create",
  {
    name: Flag.String("name").pipe(
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
    name: Flag.String("name").pipe(
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

const decodeImportFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schemas.ImportContactsFile),
  { onExcessProperty: "error" },
);

/**
 * Calls in flight at once. One list's member items share a DynamoDB partition, and past its limit
 * DynamoDB throttles the transactions and still bills their attempts. On the live gate, four calls
 * imported about 280 contacts a second with almost no throttling; eight were slower and used 38%
 * more write units (ADR-0025).
 */
const importConcurrency = 4;

const progressStep = 1_000;

const count = (value: number) => value.toLocaleString("en-US");

/**
 * Read and decoded here rather than through `Flag.FileSchema`, whose decode drops keys the contract
 * does not declare: a misspelled `attributs` would vanish and its contact would be imported without
 * attributes. Rejecting the key names it before any request is made. A `.csv` file is a CSV export
 * instead, whose columns name the fields.
 */
const importFile = Flag.File("file", { mustExist: true }).pipe(
  Flag.withDescription("A JSON or CSV (.csv) file holding the contacts to load"),
  Flag.mapEffect((path) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(path);

      return path.toLowerCase().endsWith(".csv")
        ? yield* decodeCsvContacts(text)
        : yield* decodeImportFile(text);
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

/**
 * A file of any size goes out in payloads of `maxImportEntries`, several at once. Each answer is the
 * converged state of its batch, so the joined answers are the file's, in file order, and running
 * the same file again — after a failure too — changes nothing it already did.
 */
const listsImport = Command.make(
  "import",
  { listId: idArgument("listId"), file: importFile },
  Effect.fn(function* (input) {
    const total = input.file.contacts.length;
    let confirmed = 0;

    const imported = yield* withClient(
      (client) =>
        Effect.forEach(
          Arr.chunksOf(input.file.contacts, Schemas.maxImportEntries),
          (contacts) =>
            client.lists.import({ params: { listId: input.listId }, payload: { contacts } }).pipe(
              Effect.tap(() => {
                const before = confirmed;

                confirmed += contacts.length;

                return Math.floor(confirmed / progressStep) > Math.floor(before / progressStep)
                  ? Console.error(`Imported ${count(confirmed)} of ${count(total)} contacts`)
                  : Effect.void;
              }),
            ),
          { concurrency: importConcurrency },
        ),
      { retryTransient: true },
    ).pipe(
      Effect.tapError(() =>
        Console.error(
          `Stopped with ${count(confirmed)} of ${count(total)} contacts confirmed; running the same file again is safe`,
        ),
      ),
    );

    yield* report({ contacts: imported.flatMap((batch) => batch.contacts) });
  }),
).pipe(
  Command.withDescription("Load a file of contacts into a list, several batches at a time"),
  Command.withExamples([
    {
      command: "emailer lists import 0195f0a0-1111-4222-8333-44444444109e --file contacts.json",
      description: "Load every contact in the file, reusing any that already hold their address",
    },
    {
      command: "emailer lists import 0195f0a0-1111-4222-8333-44444444109e --file export.csv",
      description:
        "Load a CSV export: an email column, an optional name, other columns as attributes",
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
