import * as Schemas from "@emailer/api/Schemas";
import { DateTime, Effect, FileSystem, Option, Record, Schema, Stream } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { pathToFileURL } from "node:url";

import { report, withClient } from "../Client.ts";
import { entityPageFlags, idArgument, pageQuery } from "../Flags.ts";
import { renderMarkdown } from "../Markdown.ts";
import { openInBrowser, refuse } from "../Terminal.ts";

import type { DocumentHead } from "../Markdown.ts";

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
    Flag.optional,
  ),
  html: Flag.FileText("html").pipe(
    Flag.withDescription("Path to a file holding the HTML body; needs --text"),
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

/** The copy's language, which names months and days in its dates; absent means English. */
const languageFlag = Flag.String("language").pipe(
  Flag.withDescription(
    "The copy's language as a BCP 47 tag, such as de-DE, for its dates and its Markdown's HTML",
  ),
  Flag.withSchema(Schemas.Language),
  Flag.optional,
);

/** The field a set language adds to a payload, or nothing. */
const languageOf = (language: Option.Option<string>) =>
  Option.isSome(language) ? { language: language.value } : {};

const decodeBody = Schema.decodeUnknownEffect(Schemas.CampaignBody);

/** The head of a copy's Markdown document: its subject, in its language or the default one. */
const headOf = (subject: string, language: Option.Option<string>): DocumentHead => ({
  title: subject,
  language: Option.getOrElse(language, () => Schemas.defaultLanguage),
});

/**
 * The body to send. Markdown renders here, in a document with the copy's head, and a file's body
 * and rendered Markdown meet the same limits, checked before the request. A refusal names the part
 * and the limit, never the content, which can be a whole file. The head is only read when a Markdown
 * body needs it.
 */
const bodyOf = <E>(content: Content, head: Effect.Effect<DocumentHead, E>) => {
  const body: Effect.Effect<unknown, E> =
    content.kind === "body"
      ? Effect.succeed(content.body)
      : Effect.map(head, (document) => renderMarkdown(content.markdown, document));

  return Effect.flatMap(body, (value) =>
    decodeBody(value).pipe(
      Effect.mapError((failure) => refuse(`The campaign body is refused: ${failure.message}`)),
    ),
  );
};

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
    language: languageFlag,
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
      ...(yield* bodyOf(content.value, Effect.succeed(headOf(input.subject, input.language)))),
      ...languageOf(input.language),
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
  language?: string;
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
    language: languageFlag,
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
            // What the change leaves out, the draft keeps: its subject, its language.
            const head =
              Option.isSome(input.subject) && Option.isSome(input.language)
                ? Effect.succeed(headOf(input.subject.value, input.language))
                : Effect.map(client.campaigns.get({ params: { id: input.id } }), (draft) =>
                    headOf(
                      Option.getOrElse(input.subject, () => draft.subject),
                      Option.orElse(input.language, () => Option.fromUndefinedOr(draft.language)),
                    ),
                  );

            const body = yield* bodyOf(content.value, head);

            change.text = body.text;
            change.html = body.html ?? null;
          }

          if (Option.isSome(input.language)) {
            change.language = input.language.value;
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

const variantKeyArgument = Argument.String("key").pipe(
  Argument.withDescription("The variant's key: up to 32 letters, digits, _ or -"),
  Argument.withSchema(Schemas.VariantKey),
);

const decodeVariant = Schema.decodeUnknownEffect(Schemas.VariantPayload);

/** Adds a variant to a draft, or replaces the one under the same key where it stands. */
const variantsSet = Command.make(
  "set",
  {
    id: idArgument("id"),
    key: variantKeyArgument,
    subject: Flag.String("subject").pipe(
      Flag.withDescription("The variant's subject"),
      Flag.withSchema(Schemas.CampaignSubject),
    ),
    ...contentFlags,
    language: languageFlag,
    when: Flag.KeyValuePair("when").pipe(
      Flag.withDescription(
        "Send it to members whose attributes equal every key=value given; repeat per entry",
      ),
      Flag.optional,
    ),
    percent: Flag.Int("percent").pipe(
      Flag.withDescription("Send it to this share of the members no --when variant takes"),
      Flag.optional,
    ),
  },
  Effect.fn(function* (input) {
    const content = yield* chooseContent(input);

    if (Option.isNone(content)) {
      return yield* refuse("Pass --markdown, or --text with an optional --html");
    }

    if (Option.isSome(input.when) === Option.isSome(input.percent)) {
      return yield* refuse("Pass --when (repeatable) or --percent, one of the two");
    }

    const rule = Option.isSome(input.when)
      ? { when: input.when.value }
      : { percent: Option.getOrUndefined(input.percent) };

    const variant = yield* decodeVariant({
      subject: input.subject,
      ...(yield* bodyOf(content.value, Effect.succeed(headOf(input.subject, input.language)))),
      ...languageOf(input.language),
      ...rule,
    }).pipe(Effect.mapError((failure) => refuse(`The variant is refused: ${failure.message}`)));

    const params = { id: input.id, key: input.key };

    // The client takes one request shape per rule, so the variant is narrowed to its rule first.
    yield* report(
      yield* withClient((client) =>
        variant.when === undefined
          ? client.campaigns.setVariant({ params, payload: variant })
          : client.campaigns.setVariant({ params, payload: variant }),
      ),
    );
  }),
).pipe(
  Command.withDescription("Add a variant to a draft campaign, or replace the one with this key"),
  Command.withExamples([
    {
      command:
        'emailer campaigns variants set 0195f0a0-1111-4222-8333-4444444ca409 beginners --subject "Start here" --markdown beginners.md --when level=beginner',
      description: "Send members whose level is beginner their own copy",
    },
    {
      command:
        'emailer campaigns variants set 0195f0a0-1111-4222-8333-4444444ca409 b --subject "Release notes" --markdown b.md --percent 50',
      description: "Split everyone else evenly between this copy and the campaign's own",
    },
  ]),
);

const variantsGet = Command.make(
  "get",
  { id: idArgument("id"), key: variantKeyArgument },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.campaigns.getVariant({ params: { id: input.id, key: input.key } }),
      ),
    );
  }),
).pipe(Command.withDescription("Show one variant of a campaign with its rule and content"));

const variantsRemove = Command.make(
  "remove",
  { id: idArgument("id"), key: variantKeyArgument },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.campaigns.removeVariant({ params: { id: input.id, key: input.key } }),
      ),
    );
  }),
).pipe(Command.withDescription("Remove a variant from a draft; repeating it changes nothing"));

const campaignsVariants = Command.make("variants").pipe(
  Command.withDescription(
    "Alternate copies of a draft: the first --when variant a member matches, else a --percent share, else the campaign's own copy",
  ),
  Command.withSubcommands([variantsSet, variantsGet, variantsRemove]),
);

const campaignsDelete = Command.make(
  "delete",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    yield* withClient((client) => client.campaigns.remove({ params: { id: input.id } }));

    yield* report({ id: input.id, deleted: true });
  }),
).pipe(Command.withDescription("Delete a draft campaign"));

/** Whom a preview or test renders the copy for, and which copy. */
const renderFlags = {
  as: Flag.String("as").pipe(
    Flag.withDescription(
      "Render as the contact with this address; without it, every contact value falls back",
    ),
    Flag.withSchema(Schemas.EmailAddress),
    Flag.optional,
  ),
  variant: Flag.String("variant").pipe(
    Flag.withDescription("Render this variant's copy instead of the one the rules choose"),
    Flag.withSchema(Schemas.CopyKey),
    Flag.optional,
  ),
};

const campaignsTest = Command.make(
  "test",
  {
    id: idArgument("id"),
    to: Flag.String("to").pipe(
      Flag.withDescription(
        `An address to send the test to; repeat for up to ${Schemas.maxTestRecipients}`,
      ),
      Flag.withSchema(Schemas.EmailAddress),
      Flag.between(1, Schemas.maxTestRecipients),
    ),
    ...renderFlags,
  },
  Effect.fn(function* (input) {
    yield* report(
      yield* withClient((client) =>
        client.campaigns.test({
          params: { id: input.id },
          payload: {
            to: input.to,
            as: Option.getOrUndefined(input.as),
            variant: Option.getOrUndefined(input.variant),
          },
        }),
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Send a [Test] copy of a campaign now to the addresses named, and report each one's outcome",
  ),
  Command.withExamples([
    {
      command:
        "emailer campaigns test 0195f0a0-1111-4222-8333-4444444ca409 --to me@example.com --to colleague@example.com",
      description: "Send a test to two addresses, with every contact value falling back",
    },
    {
      command:
        "emailer campaigns test 0195f0a0-1111-4222-8333-4444444ca409 --to me@example.com --as ada@example.com",
      description: "Send yourself the copy the contact ada@example.com would get",
    },
  ]),
);

/** A rendered HTML part as a local file, so a browser can open it. */
const writeHtml = Effect.fn("writeHtml")(function* (html: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* fs.makeTempFile({ prefix: "emailer-render-", suffix: ".html" });

  yield* fs.writeFileString(path, html);

  return pathToFileURL(path).href;
});

const campaignsPreview = Command.make(
  "preview",
  {
    id: idArgument("id"),
    ...renderFlags,
    open: Flag.Boolean("open").pipe(
      Flag.withDescription("Also open the link, or with --as the rendered HTML, in the browser"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* (input) {
    if (Option.isNone(input.as)) {
      if (Option.isSome(input.variant)) {
        return yield* refuse("--variant needs --as; the preview link shows every copy");
      }

      const link = yield* withClient((client) =>
        client.campaigns.preview({ params: { id: input.id } }),
      );

      yield* report(link);

      if (input.open) {
        yield* openInBrowser(link.url);
      }

      return;
    }

    const as = input.as.value;

    const rendered = yield* withClient((client) =>
      client.campaigns.render({
        params: { id: input.id },
        payload: { as, variant: Option.getOrUndefined(input.variant) },
      }),
    );

    yield* report(rendered);

    if (input.open && rendered.html !== undefined) {
      yield* openInBrowser(yield* writeHtml(rendered.html));
    }
  }),
).pipe(
  Command.withDescription(
    "Create a 24-hour public link to every copy with its fallbacks, or print the copy one contact gets",
  ),
  Command.withExamples([
    {
      command: "emailer campaigns preview 0195f0a0-1111-4222-8333-4444444ca409 --open",
      description: "Print a preview link and open it in the local browser",
    },
    {
      command:
        "emailer campaigns preview 0195f0a0-1111-4222-8333-4444444ca409 --as ada@example.com --open",
      description: "Print the copy ada@example.com would get and open its HTML",
    },
  ]),
);

/** Every page of a check, added up, with its findings grouped the way they are fixed. */
const summarize = (campaignId: string, pages: ReadonlyArray<Schemas.CheckPage>) => {
  const add = (left: number, right: number) => left + right;

  const noSkips: Record<Schemas.UnmailableStatus, number> = {
    unsubscribed: 0,
    suppressed: 0,
    bouncing: 0,
  };

  const noRenders: Record<Schemas.CopyKey, number> = {};

  const findings = pages.flatMap((page) => page.findings);

  const fallbacks: Record<string, Array<string>> = {};

  for (const finding of findings) {
    if (finding.kind === "fallback") {
      (fallbacks[`${finding.copy}: contact.${finding.field}`] ??= []).push(finding.email);
    }
  }

  return {
    members: pages.reduce((sum, page) => sum + page.members, 0),
    filteredOut: pages.reduce((sum, page) => sum + page.filteredOut, 0),
    skipped: pages.reduce((sum, page) => Record.union(sum, page.skipped, add), noSkips),
    rendered: pages.reduce((sum, page) => Record.union(sum, page.rendered, add), noRenders),
    failures: findings.flatMap((finding) =>
      finding.kind === "failure"
        ? [{ email: finding.email, copy: finding.copy, message: finding.message }]
        : [],
    ),
    fallbacks,
    oddValues: findings.flatMap((finding) =>
      finding.kind === "odd-value"
        ? [
            {
              email: finding.email,
              copy: finding.copy,
              field: finding.field,
              problem: finding.problem,
            },
          ]
        : [],
    ),
    showOne: `emailer campaigns preview ${campaignId} --as <email>`,
  };
};

const campaignsCheck = Command.make(
  "check",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    const pages = yield* withClient((client) =>
      Stream.paginate(undefined, (cursor: string | undefined) =>
        client.campaigns
          .check({ params: { id: input.id }, payload: { cursor } })
          .pipe(Effect.map((page) => [[page], Option.fromUndefinedOr(page.nextCursor)] as const)),
      ).pipe(Stream.runCollect),
    );

    yield* report(summarize(input.id, pages));
  }),
).pipe(
  Command.withDescription(
    "Render the campaign for every member of its list without sending, and list what would go wrong or fall back",
  ),
  Command.withExamples([
    {
      command: "emailer campaigns check 0195f0a0-1111-4222-8333-4444444ca409",
      description:
        "Count who gets which copy and who is skipped, and name failed renders, fallbacks and odd values",
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
).pipe(
  Command.withDescription(
    "Retrieve a campaign, its submission status and, once it has started sending, its opens",
  ),
);

/** Earliest first open first; recipients who first opened at the same moment by address. */
const byFirstOpen = (left: Schemas.Opener, right: Schemas.Opener) =>
  left.firstOpenedAt.localeCompare(right.firstOpenedAt) || left.email.localeCompare(right.email);

const campaignsOpens = Command.make(
  "opens",
  { id: idArgument("id") },
  Effect.fn(function* (input) {
    const openers = yield* withClient((client) =>
      Stream.paginate(undefined, (cursor: string | undefined) =>
        client.campaigns
          .opens({ params: { id: input.id }, query: { cursor } })
          .pipe(
            Effect.map((page) => [page.items, Option.fromUndefinedOr(page.nextCursor)] as const),
          ),
      ).pipe(Stream.runCollect),
    );

    yield* report(openers.toSorted(byFirstOpen));
  }),
).pipe(
  Command.withDescription(
    "List who opened a campaign: each recipient's copy, first open and number of opens",
  ),
  Command.withExamples([
    {
      command: "emailer campaigns opens 0195f0a0-1111-4222-8333-4444444ca409",
      description: "Read every opener, earliest first open first",
    },
  ]),
);

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
    campaignsVariants,
    campaignsDelete,
    campaignsTest,
    campaignsPreview,
    campaignsCheck,
    campaignsGet,
    campaignsOpens,
    campaignsSend,
    campaignsResume,
    campaignsSchedule,
    campaignsCancel,
    campaignsList,
  ]),
);
