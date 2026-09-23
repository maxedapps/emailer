import * as Schemas from "@emailer/api/Schemas";
import { Option } from "effect";
import { Argument, Flag } from "effect/unstable/cli";

export const idArgument = (name: string) =>
  Argument.string(name).pipe(Argument.withSchema(Schemas.EntityId));

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
export const entityPageFlags = {
  limit: limitFlag,
  cursor: cursorFlag.pipe(Flag.withSchema(Schemas.EntityCursor), Flag.optional),
};

export const memberPageFlags = {
  limit: limitFlag,
  cursor: cursorFlag.pipe(Flag.withSchema(Schemas.MemberCursor), Flag.optional),
};

interface PageQuery<Cursor> {
  limit?: number;
  cursor?: Cursor;
}

export const pageQuery = <Cursor>(limit: Option.Option<number>, cursor: Option.Option<Cursor>) => {
  const query: PageQuery<Cursor> = {};

  if (Option.isSome(limit)) {
    query.limit = limit.value;
  }

  if (Option.isSome(cursor)) {
    query.cursor = cursor.value;
  }

  return query;
};
