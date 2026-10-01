import * as Schemas from "@emailer/api/Schemas";
import { parse } from "csv-parse/sync";
import { Data, Effect, Schema } from "effect";

class InvalidCsv extends Data.TaggedError("InvalidCsv")<{ readonly message: string }> {}

/**
 * `csv-parse` types its output as rows of strings whatever the options. With `info`, each row is
 * the record and a snapshot of the parser's position, so the output is decoded rather than cast.
 */
const Rows = Schema.Array(
  Schema.Struct({
    record: Schema.Array(Schema.String),
    info: Schema.Struct({ lines: Schema.Int }),
  }),
);

const decodeRows = Schema.decodeUnknownEffect(Rows);

const decodeEntry = Schema.decodeUnknownEffect(Schemas.ImportContactEntry);

const decodeFile = Schema.decodeUnknownEffect(Schemas.ImportContactsFile);

const decodeAttributeUpdate = Schema.decodeUnknownEffect(Schemas.AttributeUpdate);

const decodeAttributesFile = Schema.decodeUnknownEffect(Schemas.SetAttributesFile);

/** `email` and `name` in any case name those fields; any other header is an attribute's key. */
const fieldOf = (column: string) => {
  const lower = column.toLowerCase();

  return lower === "email" || lower === "name" ? lower : column;
};

/** An entry as a CSV row spells it, before it passes the checks a JSON entry does. */
interface RowEntry {
  email?: string;
  name?: string;
  attributes?: Record<string, string>;
}

/** A blank cell is left out, so it never becomes an empty name or attribute. */
const entryOf = (fields: ReadonlyArray<string>, record: ReadonlyArray<string>) => {
  const entry: RowEntry = {};

  fields.forEach((field, index) => {
    const cell = record[index];

    if (cell === undefined || cell === "") {
      return;
    }

    if (field === "email" || field === "name") {
      entry[field] = cell;
    } else {
      entry.attributes = { ...entry.attributes, [field]: cell };
    }
  });

  return entry;
};

/**
 * A CSV export's rows as entries, each with the line it came from. The first row names the
 * columns: `email` is required and `name` optional, in any case, and every other column is an
 * attribute under its header.
 */
const readEntries = Effect.fn("readEntries")(function* (text: string) {
  const [header, ...rows] = yield* decodeRows(
    yield* Effect.try({
      try: () => parse(text, { bom: true, skip_empty_lines: true, info: true }),
      catch: (error) =>
        new InvalidCsv({ message: error instanceof Error ? error.message : String(error) }),
    }),
  );

  if (header === undefined) {
    return yield* new InvalidCsv({ message: "The file is empty" });
  }

  const fields = header.record.map(fieldOf);
  const repeated = fields.find((field, index) => fields.indexOf(field) !== index);

  if (repeated !== undefined) {
    return yield* new InvalidCsv({ message: `The column "${repeated}" appears twice` });
  }

  if (!fields.includes("email")) {
    return yield* new InvalidCsv({ message: "The header has no email column" });
  }

  return {
    fields,
    rows: rows.map(({ record, info }) => ({ entry: entryOf(fields, record), line: info.lines })),
  };
});

/** Each row passes the checks a JSON entry does, and a row that fails is named by its line. */
const decodeEach = <A>(
  rows: ReadonlyArray<{ readonly entry: RowEntry; readonly line: number }>,
  decode: (entry: RowEntry) => Effect.Effect<A, Schema.SchemaError>,
) =>
  Effect.forEach(rows, ({ entry, line }) =>
    decode(entry).pipe(
      Effect.mapError((error) => new InvalidCsv({ message: `line ${line}: ${error.message}` })),
    ),
  );

/** Reads a CSV export as an import file. */
export const decodeCsvContacts = Effect.fn("decodeCsvContacts")(function* (text: string) {
  const { rows } = yield* readEntries(text);

  return yield* decodeFile({ contacts: yield* decodeEach(rows, decodeEntry) });
});

/**
 * Reads a CSV file as attributes to merge into existing contacts: the email column and one column
 * per attribute. A blank cell leaves that attribute alone. A name column is refused rather than
 * read as an attribute called `name`, which it names everywhere else.
 */
export const decodeCsvAttributes = Effect.fn("decodeCsvAttributes")(function* (text: string) {
  const { fields, rows } = yield* readEntries(text);

  if (fields.includes("name")) {
    return yield* new InvalidCsv({
      message: "The file has a name column; it sets attributes only, so remove the column",
    });
  }

  const contacts = yield* decodeEach(rows, (entry) =>
    decodeAttributeUpdate({ email: entry.email, attributes: entry.attributes ?? {} }),
  );

  return yield* decodeAttributesFile({ contacts });
});
