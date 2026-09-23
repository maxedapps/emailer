import * as Schemas from "@emailer/api/Schemas";
import { DateTime, Effect, Option, Schema } from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";

import { report, withClient } from "../Client.ts";
import { entityPageFlags, idArgument, pageQuery } from "../Flags.ts";
import { renderMarkdown } from "../Markdown.ts";

const refuse = (userMessage: string) => new CliError.UserError({ cause: userMessage, userMessage });

/** A campaign body comes from one Markdown file, or from a text file and an optional HTML file. */
const contentFlags = {
  markdown: Flag.fileText("markdown").pipe(
    Flag.withDescription(
      "Path to a Markdown file; both the text and the HTML body are rendered from it",
    ),
    Flag.optional,
  ),
  text: Flag.fileText("text").pipe(
    Flag.withDescription("Path to a file holding the plain-text body"),
    Flag.withSchema(Schemas.CampaignText),
    Flag.optional,
  ),
  html: Flag.fileText("html").pipe(
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

/** The body to send. Markdown renders here, and its output meets the same limits as a file's. */
const bodyOf = (content: Content, subject: string) =>
  content.kind === "body"
    ? Effect.succeed(content.body)
    : decodeBody(renderMarkdown(content.markdown, subject)).pipe(
        Effect.mapError(() =>
          refuse("The rendered Markdown exceeds the service's body size limits"),
        ),
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
    ...contentFlags,
    filter: Flag.keyValuePair("filter").pipe(
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
      ...(yield* bodyOf(content.value, input.subject)),
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

export const campaigns = Command.make("campaigns").pipe(
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
