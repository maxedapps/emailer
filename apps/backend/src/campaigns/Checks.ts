import * as Schemas from "@emailer/api/Schemas";
import { Cache, Effect } from "effect";

import { postalAddress } from "../sending/Message.ts";
import { compileCopy, contactValues } from "../sending/Templates.ts";
import { chooseVariant, matchesAttributes } from "../sending/Variants.ts";
import { AudienceStore } from "../storage/Audience.ts";
import { CampaignStore } from "../storage/Campaigns.ts";
import { copyContent, placeholderUnsubscribeUrl } from "./Copies.ts";

/** Members a check reads per request: one page read and one batched contact read. */
const checkPageSize = 100;

/** Why a value a copy uses may read oddly in the mail, if it does. */
const oddness = (value: string) =>
  /[\r\n]/.test(value)
    ? ("line-break" as const)
    : value.trim() === value
      ? undefined
      : ("surrounding-whitespace" as const);

/** A finding for each field the copy reads that the member lacks, or holds an odd value for. */
const fieldFindings = (
  fields: ReadonlySet<string>,
  member: Schemas.Contact,
  copy: Schemas.CopyKey,
): Array<Schemas.CheckFinding> => {
  const values = contactValues(member);

  return [...fields].flatMap((field): Array<Schemas.CheckFinding> => {
    const value = values[field];

    if (value === undefined) {
      return [{ kind: "fallback", email: member.email, copy, field }];
    }

    const problem = oddness(value);

    return problem === undefined
      ? []
      : [{ kind: "odd-value", email: member.email, copy, field, problem }];
  });
};

/**
 * One page of a dry run of the campaign: each member of its list is taken as a send takes them —
 * the filter, their standing, the copy the rules choose — and rendered, never sent. The render
 * fails as the send would skip the member, and every `contact.*` value the copy uses that is
 * missing (its fallback shows) or odd is named. Nothing is written; it reads the list page, one
 * address item per member, the rules once and each copy it renders once.
 */
export const checkPage = Effect.fn("Checks.checkPage")(function* (
  campaignId: string,
  payload: Schemas.CheckPayload,
) {
  const audience = yield* AudienceStore;
  const campaigns = yield* CampaignStore;
  const postal = yield* postalAddress;

  const campaign = yield* campaigns.getSummary(campaignId);
  const page = yield* audience.listMembers(campaign.listId, checkPageSize, payload.cursor);
  const { routes } = yield* campaigns.getRoutes(campaignId);

  const copies = yield* Cache.make({
    capacity: Schemas.maxVariants + 1,
    lookup: (key: Schemas.CopyKey) => copyContent(campaign, key).pipe(Effect.flatMap(compileCopy)),
  });

  const skipped: Record<Schemas.UnmailableStatus, number> = {
    unsubscribed: 0,
    suppressed: 0,
    bouncing: 0,
  };

  const rendered: Record<Schemas.CopyKey, number> = {};
  const findings: Array<Schemas.CheckFinding> = [];
  let filteredOut = 0;

  for (const member of page.items) {
    if (campaign.filter !== undefined && !matchesAttributes(campaign.filter, member.attributes)) {
      filteredOut += 1;
      continue;
    }

    const status = yield* audience.addressStatus(member.email, campaign.listId);

    if (status !== "mailable") {
      skipped[status] += 1;
      continue;
    }

    const copy = (yield* chooseVariant(campaignId, member, routes))?.key ?? Schemas.defaultCopy;

    const failure = yield* Cache.get(copies, copy).pipe(
      Effect.flatMap((compiled) => {
        findings.push(...fieldFindings(compiled.fields, member, copy));

        return compiled.render({
          contact: member,
          unsubscribeUrl: placeholderUnsubscribeUrl,
          postalAddress: postal,
        });
      }),
      Effect.as(undefined),
      Effect.catchTags({
        InvalidTemplate: (error) => Effect.succeed(error.message),
        Unrenderable: (error) => Effect.succeed(error.message),
      }),
    );

    if (failure === undefined) {
      rendered[copy] = (rendered[copy] ?? 0) + 1;
    } else {
      findings.push({ kind: "failure", email: member.email, copy, message: failure });
    }
  }

  return {
    members: page.items.length,
    filteredOut,
    skipped,
    rendered,
    findings,
    nextCursor: page.nextCursor,
  } satisfies Schemas.CheckPage;
});
