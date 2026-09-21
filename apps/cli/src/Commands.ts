import { makeEmailerClient } from "@emailer/api/Client";
import type { EmailerClient } from "@emailer/api/Client";
import * as Schemas from "@emailer/api/Schemas";
import {
  Config,
  Console,
  DateTime,
  Duration,
  Effect,
  Inspectable,
  Layer,
  Option,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

/**
 * The CLI is the only thing that enforces a deadline on a request, so it is the only thing that
 * states one. It sits above the API function's sixty seconds so that a send which runs long is
 * answered by the service rather than abandoned by the caller, which would leave the outcome
 * unknown to the operator while the send completed anyway.
 */
export const requestTimeout = Duration.seconds(70);

const emailerClient = Effect.gen(function* () {
  const url = yield* Config.string("EMAILER_API_URL");
  const token = yield* Config.redacted("EMAILER_API_TOKEN");

  return yield* makeEmailerClient(url, token);
});

const withClient = <A>(
  use: (client: EmailerClient) => Effect.Effect<A, { readonly _tag: string }>,
) =>
  Effect.gen(function* () {
    const client = yield* emailerClient;

    return yield* use(client);
  }).pipe(Effect.timeout(requestTimeout), Effect.provide(Layer.mergeAll(FetchHttpClient.layer)));

const report = <Value>(value: Value) => Console.log(Inspectable.toStringUnknown(value));

const idArgument = (name: string) =>
  Argument.string(name).pipe(Argument.withSchema(Schemas.EntityId));

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

const limitFlag = Flag.integer("limit").pipe(
  Flag.withDescription("How many entries to return, 1-100"),
  Flag.withSchema(Schemas.PageSize),
  Flag.optional,
);

const cursorFlag = Flag.string("cursor").pipe(
  Flag.withDescription("Continue from the cursor a previous page reported"),
);

/**
 * The cursor is validated against the same schema the service decodes it with, so a mistyped one
 * fails here rather than as a 400 after a round trip.
 */
const entityPageFlags = {
  limit: limitFlag,
  cursor: cursorFlag.pipe(Flag.withSchema(Schemas.EntityCursor), Flag.optional),
};

const memberPageFlags = {
  limit: limitFlag,
  cursor: cursorFlag.pipe(Flag.withSchema(Schemas.MemberCursor), Flag.optional),
};

interface PageQuery<Cursor> {
  limit?: number;
  cursor?: Cursor;
}

const pageQuery = <Cursor>(limit: Option.Option<number>, cursor: Option.Option<Cursor>) => {
  const query: PageQuery<Cursor> = {};

  if (Option.isSome(limit)) {
    query.limit = limit.value;
  }

  if (Option.isSome(cursor)) {
    query.cursor = cursor.value;
  }

  return query;
};

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

const contacts = Command.make("contacts").pipe(
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

const lists = Command.make("lists").pipe(
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

const campaignsCreate = Command.make(
  "create",
  {
    list: Flag.string("list").pipe(
      Flag.withDescription("The list to send to"),
      Flag.withSchema(Schemas.EntityId),
    ),
    subject: Flag.string("subject").pipe(
      Flag.withDescription("The message subject"),
      Flag.withSchema(Schemas.CampaignSubject),
    ),
    text: Flag.fileText("text").pipe(
      Flag.withDescription("Path to a file holding the plain-text body"),
      Flag.withSchema(Schemas.CampaignText),
    ),
    html: Flag.fileText("html").pipe(
      Flag.withDescription("Path to a file holding the HTML body; the text body is still required"),
      Flag.withSchema(Schemas.CampaignHtml),
      Flag.optional,
    ),
    filter: Flag.keyValuePair("filter").pipe(
      Flag.withDescription(
        "Send only to members whose attributes equal every key=value given; repeat the flag per entry",
      ),
      Flag.withSchema(Schemas.ContactAttributes),
      Flag.optional,
    ),
  },
  Effect.fn(function* (input) {
    const payload = {
      listId: input.list,
      subject: input.subject,
      text: input.text,
    };

    const withHtml = Option.isSome(input.html) ? { ...payload, html: input.html.value } : payload;

    yield* report(
      yield* withClient((client) =>
        client.campaigns.create({
          payload: Option.isSome(input.filter)
            ? { ...withHtml, filter: input.filter.value }
            : withHtml,
        }),
      ),
    );
  }),
).pipe(
  Command.withDescription("Create a draft campaign"),
  Command.withExamples([
    {
      command:
        'emailer campaigns create --list 0195f0a0-1111-4222-8333-44444444109e --subject "Release notes" --text newsletter.txt --html newsletter.html',
      description: "Create a draft whose text and HTML bodies are read from files",
    },
    {
      command:
        'emailer campaigns create --list 0195f0a0-1111-4222-8333-44444444109e --subject "Release notes" --text newsletter.txt --filter plan=pro --filter city=Berlin',
      description: "Create a draft that sends only to members matching every filter entry",
    },
  ]),
);

const campaignsGet = Command.make(
  "get",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) => client.campaigns.get({ params: { id: input.id } })),
    );
  }),
).pipe(Command.withDescription("Retrieve a campaign and its submission status"));

const campaignsSend = Command.make(
  "send",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) => client.campaigns.send({ params: { id: input.id } })),
    );
  }),
).pipe(
  Command.withDescription("Queue a campaign for sending"),
  Command.withExamples([
    {
      command: "emailer campaigns send 0195f0a0-1111-4222-8333-4444444ca409",
      description: "Queue a draft campaign; poll campaigns get for progress",
    },
  ]),
);

const campaignsResume = Command.make(
  "resume",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) => client.campaigns.resume({ params: { id: input.id } })),
    );
  }),
).pipe(
  Command.withDescription("Resume a paused campaign"),
  Command.withExamples([
    {
      command: "emailer campaigns resume 0195f0a0-1111-4222-8333-4444444ca409",
      description: "Queue a paused campaign to continue from where it stopped",
    },
  ]),
);

const isTimestamp = Schema.is(Schemas.Timestamp);

const instantInputPattern =
  /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const scheduleInstant = Schema.String.check(
  Schema.makeFilter((value: string) => {
    const parts = instantInputPattern.exec(value);
    const invalid = "Expected an ISO-8601 date or date-time with valid calendar fields";

    if (parts === null || parts[0] !== value) {
      return invalid;
    }

    const [, date, hour = "00", minute = "00", second = "00", fraction = ""] = parts;

    // Validate the entered calendar fields before the parser applies the zone or normalizes them.
    return isTimestamp(`${date}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0")}Z`)
      ? undefined
      : invalid;
  }),
).pipe(Schema.decodeTo(Schema.DateTimeUtcFromString));

const campaignsSchedule = Command.make(
  "schedule",
  {
    id: idArgument("id"),
    at: Flag.string("at").pipe(
      Flag.withDescription(
        "When to send, as an ISO-8601 date or date-time (up to milliseconds); no zone means UTC",
      ),
      Flag.withSchema(scheduleInstant),
      Flag.map(DateTime.formatIso),
      Flag.withSchema(Schemas.Timestamp),
    ),
  },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.campaigns.schedule({ params: { id: input.id }, payload: { sendAt: input.at } }),
      ),
    );
  }),
).pipe(
  Command.withDescription("Schedule a campaign to send at a future instant"),
  Command.withExamples([
    {
      command:
        "emailer campaigns schedule 0195f0a0-1111-4222-8333-4444444ca409 --at 2026-09-20T09:00Z",
      description: "Queue a draft campaign for a future instant; poll campaigns get for progress",
    },
  ]),
);

const campaignsCancel = Command.make(
  "cancel",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) => client.campaigns.cancel({ params: { id: input.id } })),
    );
  }),
).pipe(
  Command.withDescription("Cancel a pending campaign run"),
  Command.withExamples([
    {
      command: "emailer campaigns cancel 0195f0a0-1111-4222-8333-4444444ca409",
      description: "Return a scheduled campaign or a queued first send to draft",
    },
    {
      command: "emailer campaigns cancel 0195f0a0-1111-4222-8333-4444444ca409",
      description: "Return a queued resume to paused with reason manual",
    },
  ]),
);

const campaignsList = Command.make(
  "list",
  entityPageFlags,
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.campaigns.list({ query: pageQuery(input.limit, input.cursor) }),
      ),
    );
  }),
).pipe(Command.withDescription("List campaigns in the order they were created"));

const campaigns = Command.make("campaigns").pipe(
  Command.withDescription("Work with campaigns"),
  Command.withSubcommands([
    campaignsCreate,
    campaignsGet,
    campaignsSend,
    campaignsResume,
    campaignsSchedule,
    campaignsCancel,
    campaignsList,
  ]),
);

const addressesStatus = Command.make(
  "status",
  {
    email: Flag.string("email").pipe(
      Flag.withDescription("The address to inspect, exactly as SES lists it"),
      Flag.withSchema(Schemas.ListedEmailAddress),
    ),
  },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) => client.addresses.status({ query: { email: input.email } })),
    );
  }),
).pipe(Command.withDescription("Show an address's local and account suppression state"));

const addressesUnsuppress = Command.make(
  "unsuppress",
  {
    email: Flag.string("email").pipe(
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

const addresses = Command.make("addresses").pipe(
  Command.withDescription("Inspect and clear address suppression"),
  Command.withSubcommands([addressesStatus, addressesUnsuppress]),
);

export const emailer = Command.make("emailer").pipe(
  Command.withDescription("Manage contacts, lists, campaigns and addresses"),
  Command.withSubcommands([contacts, lists, campaigns, addresses]),
);
