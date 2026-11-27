import { InvalidTemplate } from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Data, Effect, Option, Predicate, Record, Schema, Struct } from "effect";
import { filters, Liquid, LiquidError } from "liquidjs";

import type { FilterImplOptions, LiquidOptions, Template } from "liquidjs";
import type { MessageContent } from "./Message.ts";

/**
 * Every copy is a Liquid template (ADR-0041). These are the names a template may read: the
 * recipient's contact as `contact.email`, `contact.name` and `contact.<attribute>`, and the two
 * values every message must carry.
 */
const contactVariable = "contact";

const unsubscribeVariable = "unsubscribe_url";

const postalVariable = "postal_address";

const knownVariables = new Set([contactVariable, unsubscribeVariable, postalVariable]);

const requiredVariables = [unsubscribeVariable, postalVariable] as const;

/** What a copy's templates are made of, as stored: a campaign's own copy or a variant. */
export interface CopySource extends MessageContent {
  readonly language?: string | undefined;
}

/** What a template sees, under the names it reads them by. */
interface Scope {
  readonly [contactVariable]: Readonly<Record<string, string>>;
  readonly [unsubscribeVariable]: string;
  readonly [postalVariable]: string;
}

/** Whom a copy is rendered for. Without a contact every `contact.*` value is missing. */
export interface Recipient {
  readonly contact: Schemas.Contact | undefined;
  readonly unsubscribeUrl: string;
  readonly postalAddress: string;
}

/** A copy that cannot be rendered for one recipient; the message never names the recipient. */
class Unrenderable extends Data.TaggedError("Unrenderable")<{ readonly message: string }> {}

/** Bounds one render, so no template can hold a function for long or fill its memory. */
const renderLimitMillis = 1000;

const memoryLimit = 8 * 1024 * 1024;

/** A copy is one template: nothing may pull in another. */
const refusedTags = ["include", "render", "layout"] as const;

const position = /, line:\d+, col:\d+$/;

/** A filter as a bare function, the form liquidjs registers its own in. */
type FilterHandler = Exclude<FilterImplOptions, { readonly handler: FilterImplOptions }>;

// SAFETY: liquidjs registers `date` as a plain filter function, never as an options object.
const liquidDate = filters["date"] as FilterHandler;

/** Text Liquid's `date` cannot read as a date: not blank, not `now` or `today`, no epoch seconds. */
const isUnreadableDate = Schema.is(
  Schema.String.check(
    Schema.makeFilter(
      (value: string) =>
        value.trim() !== "" &&
        value !== "now" &&
        value !== "today" &&
        !/^\d+$/.test(value) &&
        Number.isNaN(Date.parse(value)),
    ),
  ),
);

/** A value a template can hand `date`: a contact's text, a literal, or nothing. */
type DateInput = string | number | undefined;

/**
 * Liquid's `date` prints a value it cannot read unchanged, which would mail a raw value where a
 * date belongs. This one refuses it, so the recipient is skipped and `campaigns check` names them.
 * A missing or empty value still renders nothing, which an `{% if %}` or `default` covers.
 */
const strictDate: FilterHandler = function (
  value: DateInput,
  ...rest: Array<string | number>
): string {
  if (isUnreadableDate(value)) {
    throw new Error(`date: cannot read "${value}" as a date`);
  }

  // SAFETY: a readable value renders as formatted text; only an unreadable one comes back as is.
  return liquidDate.call(this, value, ...rest) as string;
};

/** Months and days in `date` follow the copy's language; times are UTC. */
const engine = (language: string, escape: boolean): Liquid => {
  const options: LiquidOptions = {
    strictFilters: true,
    ownPropertyOnly: true,
    // An empty in-memory file system: no template is ever read from disk.
    templates: {},
    locale: language,
    timezoneOffset: 0,
    renderLimit: renderLimitMillis,
    memoryLimit,
  };

  // Liquid's own `escape` takes any output, a missing value or a number included.
  const liquid = new Liquid(escape ? { ...options, outputEscape: "escape" } : options);

  for (const name of refusedTags) {
    liquid.registerTag(name, {
      parse() {
        throw new Error(`tag "${name}" is not available: a copy is a single template`);
      },
      render() {},
    });
  }

  liquid.registerFilter("date", strictDate);

  return liquid;
};

/** One part of a copy, parsed, with the `contact.*` fields it reads. */
interface CompiledPart {
  readonly templates: ReadonlyArray<Template>;
  readonly fields: ReadonlySet<string>;
}

/** A copy whose parts parsed and passed the checks a save makes; it renders per recipient. */
interface CompiledCopy {
  /** Every `contact.*` field any part reads. */
  readonly fields: ReadonlySet<string>;
  readonly render: (recipient: Recipient) => Effect.Effect<MessageContent, Unrenderable>;
}

/** Why Liquid refused a template or a render, and where in the template when it says. */
class LiquidFailure extends Data.TaggedError("LiquidFailure")<{
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}> {}

/** Runs Liquid, which reports a parse or render failure as a `LiquidError` located in the template. */
const runLiquid = <A>(evaluate: () => A): Effect.Effect<A, LiquidFailure> =>
  Effect.try({
    try: evaluate,
    catch: (error) => {
      const reported = error instanceof Error ? error.message : String(error);
      const message = reported.replace(position, "");
      const [line, column] = LiquidError.is(error) ? error.token.getPosition() : [];

      return line === undefined || column === undefined
        ? new LiquidFailure({ message })
        : new LiquidFailure({ message, line, column });
    },
  });

const parsePart = (liquid: Liquid, part: Schemas.TemplatePart, source: string) =>
  Effect.gen(function* () {
    const templates = yield* runLiquid(() => liquid.parse(source)).pipe(
      Effect.mapError(
        (failure) =>
          new InvalidTemplate({
            part,
            reason: failure.message,
            ...Struct.pick(failure, ["line", "column"]),
          }),
      ),
    );

    const { globals } = liquid.analyzeSync(templates, { partials: false });

    const [unknown] = Object.entries(globals).flatMap(([name, variables]) =>
      knownVariables.has(name) ? [] : variables.map(({ location }) => ({ name, location })),
    );

    if (unknown !== undefined) {
      return yield* new InvalidTemplate({
        part,
        reason: `unknown variable "${unknown.name}": use contact.${unknown.name} for a contact field, or ${unsubscribeVariable} or ${postalVariable}`,
        line: unknown.location.row,
        column: unknown.location.col,
      });
    }

    if (part !== "subject") {
      for (const name of requiredVariables) {
        if (!(name in globals)) {
          return yield* new InvalidTemplate({
            part,
            reason: `the ${part} part must carry {{ ${name} }}`,
          });
        }
      }
    }

    const fields = new Set(
      (globals[contactVariable] ?? []).flatMap((variable) => {
        const field = variable.segments[1];

        return Predicate.isString(field) ? [field] : [];
      }),
    );

    return { templates, fields } satisfies CompiledPart;
  });

/**
 * The values a contact offers a template. Its own fields take the place of same-named attributes,
 * even a name it lacks, and a blank value is left out, so it counts as missing: Liquid would treat
 * even "" as present.
 */
export const contactValues = (contact: Schemas.Contact | undefined): Record<string, string> =>
  contact === undefined
    ? {}
    : Record.filter(
        { ...contact.attributes, email: contact.email, name: contact.name ?? "" },
        (value) => value.trim() !== "",
      );

const renderPart = (liquid: Liquid, part: CompiledPart, scope: Scope) =>
  runLiquid(
    // SAFETY: without `keepOutputType`, Liquid joins every output into one string.
    () => liquid.renderSync([...part.templates], scope) as string,
  ).pipe(Effect.mapError(({ message }) => new Unrenderable({ message })));

const decodeSubject = Schema.decodeUnknownOption(Schemas.CampaignSubject);

/** A `name` tag's attributes, read past a `>` inside a quoted value. */
const tagPattern = (name: string) =>
  new RegExp(`<${name}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`, "gi");

const imageTag = tagPattern("img");

const metaTag = tagPattern("meta");

/** One attribute of a tag, as HTML tokenizes it: a name, then an optional quoted or bare value. */
const tagAttribute = /([^\s"'/=>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** A tag's `name` attribute, the first one winning as in a browser; `undefined` when it has none. */
const attributeOf = (attributes: string, name: string) => {
  for (const [, attribute, ...values] of attributes.matchAll(tagAttribute)) {
    if (attribute?.toLowerCase() === name) {
      return values.find((value) => value !== undefined) ?? "";
    }
  }

  return undefined;
};

/** Refuses the HTML part, pointing at the line and column of `index`. */
const refuseAt = (html: string, index: number, reason: string) => {
  const before = html.slice(0, index);

  return new InvalidTemplate({
    part: "html",
    reason,
    line: before.split("\n").length,
    column: index - before.lastIndexOf("\n"),
  });
};

const hostedImage = /^https:\/\//i;

/**
 * Refuses an HTML part with an image that loads from anything but an absolute https URL
 * (ADR-0044): a relative or local path has no host, Gmail blocks `data:`, no mail carries a `cid:`
 * attachment, and a value a Liquid tag decides cannot be checked before it is sent.
 */
const refuseUnhostedImages = Effect.fnUntraced(function* (html: string) {
  for (const match of html.matchAll(imageTag)) {
    const source = attributeOf(match[1] ?? "", "src");

    if (source !== undefined && !hostedImage.test(source)) {
      return yield* refuseAt(
        html,
        match.index,
        `image "${source}" must be an absolute https:// URL`,
      );
    }
  }
});

const colorSchemeNames = new Set(["color-scheme", "supported-color-schemes"]);

/** A `color-scheme` or `supported-color-schemes` CSS declaration, not `prefers-color-scheme`. */
const colorSchemeProperty = /(?<![\w-])(color-scheme|supported-color-schemes)\s*:\s*([^;}"'<>]*)/gi;

const darkMedia = /prefers-color-scheme\s*:\s*dark/i;

const namesDark = /\bdark\b/i;

const cssComment = /\/\*[\s\S]*?\*\//g;

const lightOnly = "campaigns are light only (ADR-0049)";

/**
 * Refuses an HTML part that declares dark-mode support (ADR-0049): a client such as Apple Mail
 * renders a copy dark only when it names `dark` in its `color-scheme` or `supported-color-schemes`
 * meta or CSS, or styles `prefers-color-scheme: dark`.
 */
const refuseDarkMode = Effect.fnUntraced(function* (html: string) {
  for (const match of html.matchAll(metaTag)) {
    const attributes = match[1] ?? "";
    const name = attributeOf(attributes, "name")?.toLowerCase();
    const content = attributeOf(attributes, "content") ?? "";

    if (name !== undefined && colorSchemeNames.has(name) && namesDark.test(content)) {
      return yield* refuseAt(
        html,
        match.index,
        `the ${name} meta "${content}" names dark: ${lightOnly}`,
      );
    }
  }

  // Blanked, not removed, so a refusal still points at the declaration's own line and column.
  const css = html.replace(cssComment, (comment) => " ".repeat(comment.length));

  for (const match of css.matchAll(colorSchemeProperty)) {
    const value = (match[2] ?? "").trim();

    if (namesDark.test(value)) {
      return yield* refuseAt(html, match.index, `${match[1]} "${value}" names dark: ${lightOnly}`);
    }
  }

  const media = darkMedia.exec(css);

  if (media !== null) {
    return yield* refuseAt(
      html,
      media.index,
      `a prefers-color-scheme: dark rule styles dark mode: ${lightOnly}`,
    );
  }
});

/**
 * Checks each part a draft edit gives, as a save does: Liquid syntax, known filters and tags, known
 * variables, the unsubscribe link and postal address in each body part, and hosted images and a light
 * look in the HTML part. Only a save checks the HTML part's images and look: every stored copy passed
 * one, so sending never pays.
 */
export const validateParts = Effect.fn("Templates.validateParts")(function* (parts: {
  readonly subject?: string | undefined;
  readonly text?: string | undefined;
  readonly html?: string | null | undefined;
}) {
  const plain = engine(Schemas.defaultLanguage, false);

  if (parts.subject !== undefined) {
    yield* parsePart(plain, "subject", parts.subject);
  }

  if (parts.text !== undefined) {
    yield* parsePart(plain, "text", parts.text);
  }

  if (parts.html !== undefined && parts.html !== null) {
    yield* parsePart(engine(Schemas.defaultLanguage, true), "html", parts.html);
    yield* refuseUnhostedImages(parts.html);
    yield* refuseDarkMode(parts.html);
  }
});

/**
 * Parses a copy once, for any number of recipients. A render fails, rather than mailing a broken
 * message, when a value is unusable, the subject no longer is one line within the limit, or a body
 * part lost the unsubscribe link or the postal address on the way.
 */
export const compileCopy = Effect.fn("Templates.compileCopy")(function* (copy: CopySource) {
  const language = copy.language ?? Schemas.defaultLanguage;
  const plain = engine(language, false);
  const escaped = engine(language, true);

  const subject = yield* parsePart(plain, "subject", copy.subject);
  const text = yield* parsePart(plain, "text", copy.text);
  const html = copy.html === undefined ? undefined : yield* parsePart(escaped, "html", copy.html);

  const fields = new Set([...subject.fields, ...text.fields, ...(html?.fields ?? [])]);

  const render = (recipient: Recipient) =>
    Effect.gen(function* () {
      const scope: Scope = {
        [contactVariable]: contactValues(recipient.contact),
        [unsubscribeVariable]: recipient.unsubscribeUrl,
        [postalVariable]: recipient.postalAddress,
      };

      const renderedSubject = decodeSubject(yield* renderPart(plain, subject, scope));

      if (Option.isNone(renderedSubject)) {
        return yield* new Unrenderable({
          message: "the subject renders empty, longer than 200 characters or over several lines",
        });
      }

      const renderedText = yield* renderPart(plain, text, scope);
      const renderedHtml = html === undefined ? undefined : yield* renderPart(escaped, html, scope);

      // The link and the address as the part's own engine prints them, escaped in the HTML part.
      const carries = (liquid: Liquid, body: string) =>
        runLiquid(() =>
          requiredVariables.every((name) =>
            // SAFETY: without `keepOutputType`, Liquid joins every output into one string.
            body.includes(liquid.parseAndRenderSync(`{{ ${name} }}`, scope) as string),
          ),
        ).pipe(Effect.mapError(({ message }) => new Unrenderable({ message })));

      if (!(yield* carries(plain, renderedText))) {
        return yield* new Unrenderable({
          message: "the text renders without the unsubscribe link or the postal address",
        });
      }

      if (renderedHtml !== undefined && !(yield* carries(escaped, renderedHtml))) {
        return yield* new Unrenderable({
          message: "the HTML renders without the unsubscribe link or the postal address",
        });
      }

      return {
        subject: renderedSubject.value,
        text: renderedText,
        html: renderedHtml,
      } satisfies MessageContent;
    });

  return { fields, render } satisfies CompiledCopy;
});
