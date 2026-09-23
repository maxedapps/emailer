import * as Schemas from "@emailer/api/Schemas";
import { DateTime, Effect, Option, Schema } from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";

import { report, withClient } from "../Client.ts";
import { entityPageFlags, idArgument, pageQuery } from "../Flags.ts";
import { renderMarkdown } from "../Markdown.ts";
import { confirm, openInBrowser } from "../Terminal.ts";

const refuse = (userMessage: string) => new CliError.UserError({ cause: userMessage, userMessage });

/** A campaign body comes from one Markdown file, or from a text file and an optional HTML file. */
const contentFlags = {
  markdown: Flag.FileText("markdown").pipe(
    Flag.withDescription(
      "Path to a Markdown file; both the text and the HTML body are rendered from it",
    ),
    Flag.optional,
  ),
  text: Flag.FileText("text").pipe(
    Flag.withDescription("Path to a file holding the plain-text body"),
    Flag.withSchema(Schemas.CampaignText),
    Flag.optional,
  ),
  html: Flag.FileText("html").pipe(
    Flag.withDescription("Path to a file holding the HTML body; needs --text"),
    Flag.withSchema(Schemas.CampaignHtml),
    Flag.optional,
  ),
};

interface ContentFlags {
  readonly markdown: Option.Option<string>;
  readonly text: Option.Option<Schemas.CampaignText>;
  readonly html: Option.Option<Schemas.CampaignHtml>;
}

type Content =
  | { readonly kind: "markdown"; readonly markdown: string }
  | { readonly kind: "body"; readonly body: Schemas.CampaignBody };

/**
 * Which body the flags name, checked before any request. None means no content flag was given,
 * which only `update` accepts.
 */
const chooseContent = (
  flags: ContentFlags,
): Effect.Effect<Option.Option<Content>, CliError.UserError> => {
  if (Option.isSome(flags.markdown)) {
    return Option.isSome(flags.text) || Option.isSome(flags.html)
      ? Effect.fail(refuse("Pass either --markdown or --text with an optional --html, not both"))
      : Effect.succeedSome({ kind: "markdown", markdown: flags.markdown.value });
  }

  if (Option.isNone(flags.text)) {
    return Option.isSome(flags.html)
      ? Effect.fail(refuse("--html needs --text: every campaign carries a plain-text body"))
      : Effect.succeedNone;
  }

  const text = flags.text.value;

  return Effect.succeedSome({
    kind: "body",
    body: Option.isSome(flags.html) ? { text, html: flags.html.value } : { text },
  });
};

const decodeBody = Schema.decodeUnknownEffect(Schemas.CampaignBody);

/**
 * The body to send. Markdown renders here, titled by the subject, and its output meets the same
 * limits as a file's. The subject is only read when a Markdown body needs it.
 */
const bodyOf = <E>(content: Content, subject: Effect.Effect<string, E>) =>
  content.kind === "body"
    ? Effect.succeed(content.body)
    : Effect.flatMap(subject, (title) =>
        decodeBody(renderMarkdown(content.markdown, title)).pipe(
          Effect.mapError(() =>
            refuse("The rendered Markdown exceeds the service's body size limits"),
          ),
        ),
      );

const campaignsCreate = Command.make(
  "create",
  {
    list: Flag.String("list").pipe(
      Flag.withDescription("The list to send to"),
      Flag.withSchema(Schemas.EntityId),
    ),
    subject: Flag.String("subject").pipe(
      Flag.withDescription("The message subject"),
      Flag.withSchema(Schemas.CampaignSubject),
    ),
    ...contentFlags,
    filter: Flag.KeyValuePair("filter").pipe(
      Flag.withDescription(
        "Send only to members whose attributes equal every key=value given; repeat the flag per entry",
      ),
      Flag.withSchema(Schemas.ContactAttributes),
      Flag.optional,
    ),
  },
  Effect.fn(function* (input) {
    const content = yield* chooseContent(input);

    if (Option.isNone(content)) {
      return yield* refuse("Pass --markdown, or --text with an optional --html");
    }

    const payload = {
      listId: input.list,
      subject: input.subject,
      ...(yield* bodyOf(content.value, Effect.succeed(input.subject))),
    };

    yield* report(
      yield* withClient((client) =>
        client.campaigns.create({
          payload: Option.isSome(input.filter)
            ? { ...payload, filter: input.filter.value }
            : payload,
        }),
      ),
    );
  }),
).pipe(
  Command.withDescription("Create a draft campaign"),
  Command.withExamples([
    {
      command:
        'emailer campaigns create --list 0195f0a0-1111-4222-8333-44444444109e --subject "Release notes" --markdown newsletter.md',
      description: "Create a draft whose text and HTML bodies are rendered from one Markdown file",
    },
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

interface CampaignChange {
  listId?: string;
  subject?: string;
  text?: string;
  html?: string | null;
  filter?: Schemas.ContactAttributes | null;
}

const campaignsUpdate = Command.make(
  "update",
  {
    id: idArgument("id"),
    list: Flag.String("list").pipe(
      Flag.withDescription("Move the draft to another list"),
      Flag.withSchema(Schemas.EntityId),
      Flag.optional,
    ),
    subject: Flag.String("subject").pipe(
      Flag.withDescription("A new subject"),
      Flag.withSchema(Schemas.CampaignSubject),
      Flag.optional,
    ),
    ...contentFlags,
    filter: Flag.KeyValuePair("filter").pipe(
      Flag.withDescription("Replace the filter, as repeated key=value pairs"),
      Flag.withSchema(Schemas.ContactAttributes),
      Flag.optional,
    ),
    clearFilter: Flag.Boolean("clear-filter").pipe(
      Flag.withDescription("Remove the filter, so the draft goes to the whole list"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* (input) {
    const content = yield* chooseContent(input);

    yield* report(
      yield* withClient((client) =>
        Effect.gen(function* () {
          const change: CampaignChange = {};

          if (Option.isSome(input.list)) {
            change.listId = input.list.value;
          }

          if (Option.isSome(input.subject)) {
            change.subject = input.subject.value;
          }

          // Content flags replace the whole body, so a text file alone drops an earlier HTML body.
          if (Option.isSome(content)) {
            const subject = Option.isSome(input.subject)
              ? Effect.succeed(input.subject.value)
              : Effect.map(client.campaigns.get({ params: { id: input.id } }), (c) => c.subject);

            const body = yield* bodyOf(content.value, subject);

            change.text = body.text;
            change.html = body.html ?? null;
          }

          if (input.clearFilter) {
            change.filter = null;
          } else if (Option.isSome(input.filter)) {
            change.filter = input.filter.value;
          }

          return yield* client.campaigns.update({ params: { id: input.id }, payload: change });
        }),
      ),
    );
  }),
).pipe(
  Command.withDescription("Change a draft campaign; an omitted field is left alone"),
  Command.withExamples([
    {
      command:
        "emailer campaigns update 0195f0a0-1111-4222-8333-4444444ca409 --markdown newsletter.md",
      description: "Replace the draft's text and HTML bodies with a fresh rendering",
    },
    {
      command: "emailer campaigns update 0195f0a0-1111-4222-8333-4444444ca409 --clear-filter",
      description: "Send the draft to the whole list again",
    },
  ]),
);

const campaignsDelete = Command.make(
  "delete",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* withClient((client) => client.campaigns.remove({ params: { id: input.id } }));

    yield* report({ id: input.id, deleted: true });
  }),
).pipe(Command.withDescription("Delete a draft campaign"));

const campaignsTest = Command.make(
  "test",
  {
    id: idArgument("id"),
    to: Flag.String("to").pipe(
      Flag.withDescription(
        `An address to send the test to; repeat for up to ${Schemas.maxTestRecipients}`,
      ),
      Flag.withSchema(Schemas.EmailAddress),
      Flag.between(0, Schemas.maxTestRecipients),
    ),
    list: Flag.String("list").pipe(
      Flag.withDescription("Send the test to every member of this list, after confirming how many"),
      Flag.withSchema(Schemas.EntityId),
      Flag.optional,
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Send to --list without asking first"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* (input) {
    if (input.to.length > 0 === Option.isSome(input.list)) {
      return yield* refuse("Pass --to (repeatable) or --list, one of the two");
    }

    if (Option.isSome(input.list) && !input.yes) {
      const listId = input.list.value;

      // Its own request, so the time the operator takes to answer is not charged to the send's.
      const audience = yield* withClient((client) =>
        Effect.all({
          campaign: client.campaigns.get({ params: { id: input.id } }),
          list: client.lists.get({ params: { id: listId } }),
          members: client.lists.listMembers({
            params: { listId },
            query: { limit: Schemas.maxTestRecipients + 1 },
          }),
        }),
      );

      if (audience.members.nextCursor !== undefined) {
        return yield* refuse(
          `"${audience.list.name}" has more than ${Schemas.maxTestRecipients} members; a test reaches at most that many`,
        );
      }

      const confirmed = yield* confirm(
        `Send a test of "${audience.campaign.subject}" to ${audience.members.items.length} members of "${audience.list.name}"?`,
      );

      if (!confirmed) {
        return;
      }
    }

    const params = { id: input.id };

    yield* report(
      yield* withClient((client) =>
        Option.isSome(input.list)
          ? client.campaigns.test({ params, payload: { listId: input.list.value } })
          : client.campaigns.test({ params, payload: { to: input.to } }),
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Send a [Test] copy of a campaign now and report each recipient's outcome",
  ),
  Command.withExamples([
    {
      command:
        "emailer campaigns test 0195f0a0-1111-4222-8333-4444444ca409 --to me@example.com --to colleague@example.com",
      description: "Send a test to two addresses",
    },
    {
      command:
        "emailer campaigns test 0195f0a0-1111-4222-8333-4444444ca409 --list 0195f0a0-1111-4222-8333-44444444109e",
      description: "Send a test to a small list, after confirming how many members it reaches",
    },
  ]),
);

const campaignsPreview = Command.make(
  "preview",
  {
    id: idArgument("id"),
    open: Flag.Boolean("open").pipe(
      Flag.withDescription("Also open the link in this machine's browser"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* (input) {
    const link = yield* withClient((client) =>
      client.campaigns.preview({ params: { id: input.id } }),
    );

    yield* report(link);

    if (input.open) {
      yield* openInBrowser(link.url);
    }
  }),
).pipe(
  Command.withDescription(
    "Create a 24-hour public link to the campaign as recipients will see it; it follows later edits",
  ),
  Command.withExamples([
    {
      command: "emailer campaigns preview 0195f0a0-1111-4222-8333-4444444ca409 --open",
      description: "Print a preview link and open it in the local browser",
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
    at: Flag.String("at").pipe(
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

export const campaigns = Command.make("campaigns").pipe(
  Command.withDescription("Work with campaigns"),
  Command.withSubcommands([
    campaignsCreate,
    campaignsUpdate,
    campaignsDelete,
    campaignsTest,
    campaignsPreview,
    campaignsGet,
    campaignsSend,
    campaignsResume,
    campaignsSchedule,
    campaignsCancel,
    campaignsList,
  ]),
);
