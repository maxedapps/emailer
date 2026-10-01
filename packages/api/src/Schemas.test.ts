import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";

import * as Errors from "./Errors.ts";
import * as Schemas from "./Schemas.ts";

/**
 * The contract's own rules: what it normalizes, what it refuses that a plain string or struct would
 * accept, and the conventions every consumer relies on. The bounds Effect Schema enforces for a
 * check this contract merely names (lengths, counts, literals) are Effect's to test.
 */

describe("Timestamp", () => {
  const decode = Schema.decodeUnknownResult(Schemas.Timestamp);

  it.each(["2024-02-29T23:59:59.123Z", "0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"])(
    "preserves the valid canonical instant %s",
    (timestamp) => {
      expect(decode(timestamp)).toStrictEqual(Result.succeed(timestamp));
    },
  );

  it.each([
    "2099-02-29T09:00:00.000Z",
    "2099-04-31T09:00:00.000Z",
    "2099-13-01T00:00:00.000Z",
    "2099-01-01T24:00:00.000Z",
    "2099-01-01T00:00:00Z",
    "2099-01-01T00:00:00.000+00:00",
  ])("rejects the impossible or noncanonical instant %s", (timestamp) => {
    expect(Result.isFailure(decode(timestamp))).toBe(true);
  });
});

describe("normalizeEmailAddress", () => {
  it("trims and lowercases only the domain", () => {
    expect(Schemas.normalizeEmailAddress("  Sam.R@EXAMPLE.COM  ")).toBe("Sam.R@example.com");
  });

  it("splits on the last separator so the whole local part is preserved", () => {
    expect(Schemas.normalizeEmailAddress("a@b@EXAMPLE.COM")).toBe("a@b@example.com");
  });
});

describe("mailboxKey", () => {
  it("lowercases the whole address, local part included, so identity matches consent", () => {
    expect(Schemas.mailboxKey("  Sam.R@Example.COM  ")).toBe("sam.r@example.com");
  });
});

describe("EmailAddress", () => {
  const decode = Schema.decodeUnknownResult(Schemas.EmailAddress);

  it("normalizes a valid address while decoding", () => {
    expect(decode(" Sam.R@Example.COM ")).toStrictEqual(Result.succeed("Sam.R@example.com"));
  });

  it("rejects an address without a domain label", () => {
    expect(Result.isFailure(decode("sam@example"))).toBe(true);
  });

  it("rejects a non-ASCII local part instead of claiming SMTPUTF8 support", () => {
    expect(Result.isFailure(decode("mäx@example.com"))).toBe(true);
  });

  it("rejects embedded CR/LF that would forge a header", () => {
    expect(Result.isFailure(decode("sam@example.com\r\nBcc: other@example.com"))).toBe(true);
  });
});

describe("ListedEmailAddress", () => {
  it("trims but keeps the case SES stores", () => {
    expect(Schema.decodeResult(Schemas.ListedEmailAddress)(" User@Example.com ")).toStrictEqual(
      Result.succeed("User@Example.com"),
    );
  });
});

describe("EntityName", () => {
  it("rejects a name that is only whitespace, which trimming leaves empty", () => {
    expect(Result.isFailure(Schema.decodeResult(Schemas.EntityName)("   "))).toBe(true);
  });
});

describe("CampaignSubject", () => {
  it.each(["Release\nnotes", "Release\rnotes"])("rejects the multi-line subject %j", (subject) => {
    expect(Result.isFailure(Schema.decodeResult(Schemas.CampaignSubject)(subject))).toBe(true);
  });
});

describe("CampaignText", () => {
  const decode = Schema.decodeUnknownResult(Schemas.CampaignText);

  it("preserves literal whitespace and line breaks", () => {
    const body = "  Hello\n\n  World  \n";

    expect(decode(body)).toStrictEqual(Result.succeed(body));
  });

  it("measures the limit in UTF-8 bytes, not characters", () => {
    const overLimitInBytes = "é".repeat(Schemas.maxTextBytes / 2 + 1);

    expect(overLimitInBytes.length).toBeLessThan(Schemas.maxTextBytes);
    expect(Result.isFailure(decode(overLimitInBytes))).toBe(true);
  });
});

describe("ContactAttributes", () => {
  const decode = Schema.decodeUnknownResult(Schemas.ContactAttributes);

  it("rejects an over-long key rather than silently dropping the entry", () => {
    const payload = { [`k${"x".repeat(Schemas.maxAttributeKeyLength)}`]: "v", plan: "pro" };

    expect(Result.isFailure(decode(payload))).toBe(true);
  });

  it("rejects an empty key rather than silently dropping the entry", () => {
    expect(Result.isFailure(decode({ "": "v" }))).toBe(true);
  });
});

describe("CreateCampaignPayload", () => {
  const payload = {
    listId: "0195f0a0-1111-4222-8333-444444444442",
    subject: "Release notes",
    text: "Hello",
  };

  it.each(["html", "filter"])(
    "refuses an explicit undefined %s, which carries no meaning",
    (key) => {
      expect(
        Result.isFailure(
          Schema.decodeResult(Schemas.CreateCampaignPayload)({
            ...payload,
            [key]: undefined,
          }),
        ),
      ).toBe(true);
    },
  );
});

describe("Campaign", () => {
  const queuedAt = "2026-09-11T10:00:01.000Z";
  const startedAt = "2026-09-11T10:00:02.000Z";
  const finishedAt = "2026-09-11T10:00:03.000Z";
  const progress = { accepted: 1, rejected: 2, uncertain: 0, skipped: 3 };
  const feedback = { bounced: 0, complained: 0 };

  const base = {
    id: "0195f0a0-1111-4222-8333-444444444441",
    listId: "0195f0a0-1111-4222-8333-444444444442",
    subject: "Release notes",
    text: "Hello",
    createdAt: "2026-09-11T10:00:00.000Z",
  };

  const decode = Schema.decodeUnknownResult(Schemas.Campaign);

  it.each([
    ["draft", { state: "draft" }],
    ["scheduled", { state: "scheduled", sendAt: queuedAt }],
    ["queued", { state: "queued", queuedAt }],
    ["sending", { state: "sending", queuedAt, startedAt, progress, feedback }],
    ["paused", { state: "paused", queuedAt, startedAt, progress, feedback, reason: "manual" }],
    ["completed", { state: "completed", queuedAt, startedAt, finishedAt, progress, feedback }],
  ] as const)("carries exactly what a %s submission holds", (_state, submission) => {
    expect(Result.getOrThrow(decode({ ...base, submission })).submission).toStrictEqual(submission);
  });

  it("does not let a draft smuggle terminal fields into the contract", () => {
    const campaign = Result.getOrThrow(
      decode({
        ...base,
        submission: {
          state: "draft",
          queuedAt,
          startedAt,
          finishedAt,
          progress,
          feedback,
          reason: "rate-limited",
        },
      }),
    );

    expect(campaign.submission).toStrictEqual({ state: "draft" });
  });
});

describe("UpdateContactPayload", () => {
  const decode = Schema.decodeUnknownResult(Schemas.UpdateContactPayload);

  it("distinguishes an absent field from an explicit null", () => {
    expect(decode({})).toStrictEqual(Result.succeed({}));
    expect(decode({ name: null })).toStrictEqual(Result.succeed({ name: null }));
  });

  it("refuses an explicit undefined, which carries no meaning", () => {
    expect(Result.isFailure(decode({ name: undefined }))).toBe(true);
  });
});

describe("UpdateCampaignPayload", () => {
  const decode = Schema.decodeUnknownResult(Schemas.UpdateCampaignPayload);

  it("keeps an absent field absent and an explicit null as null", () => {
    expect(decode({})).toStrictEqual(Result.succeed({}));
    expect(decode({ html: null, filter: null })).toStrictEqual(
      Result.succeed({ html: null, filter: null }),
    );
  });

  it.each([{ text: null }, { subject: null }, { listId: null }, { html: "" }, { text: "" }])(
    "refuses %j",
    (payload) => {
      expect(Result.isFailure(decode(payload))).toBe(true);
    },
  );
});

describe("VariantPayload", () => {
  // Default decoding, as the HTTP API decodes: excess properties are dropped there, not refused.
  const decode = Schema.decodeUnknownResult(Schemas.VariantPayload);

  const content = { subject: "Hello", text: "Body" };

  /** Four entries at their length bounds: the longest rule of ASCII the entry bounds allow. */
  const longestRule = (character: string) =>
    Object.fromEntries(
      ["a", "b", "c", "d"].map((prefix) => [
        prefix.repeat(Schemas.maxAttributeKeyLength),
        character.repeat(512),
      ]),
    );

  it.each([
    ["a targeted variant", { when: { level: "beginner" }, ...content }],
    ["a split variant", { percent: 50, ...content }],
    ["the longest rule of quotes, which JSON escapes", { when: longestRule('"'), ...content }],
  ])("admits %s", (_case, variant) => {
    expect(decode(variant)).toStrictEqual(Result.succeed(variant));
  });

  it.each([
    ["both selectors", { when: { level: "x" }, percent: 10, ...content }],
    ["neither selector", content],
    ["an empty targeting", { when: {}, ...content }],
    ["a percent over 100", { percent: 101, ...content }],
    // A control character escapes to six bytes, so this rule passes every entry bound but not
    // the bound that keeps fifty rules within one item.
    ["a rule past its byte bound", { when: longestRule("\u0001"), ...content }],
  ])("refuses %s", (_case, variant) => {
    expect(Result.isFailure(decode(variant))).toBe(true);
  });
});

describe("VariantRoutes", () => {
  const decode = Schema.decodeUnknownResult(Schemas.VariantRoutes);

  const routes = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ key: `v${index}`, when: { n: `${index}` } }));

  it("admits no routes, and as many as a campaign may hold", () => {
    expect(Result.isSuccess(decode([]))).toBe(true);
    expect(Result.isSuccess(decode(routes(Schemas.maxVariants)))).toBe(true);
  });

  it.each([
    ["one more than a campaign may hold", routes(Schemas.maxVariants + 1)],
    ["a route naming both selectors", [{ key: "b", when: { level: "x" }, percent: 10 }]],
    ["the default copy's key", [{ key: "default", percent: 10 }]],
    ["a key SES would refuse as a tag value", [{ key: "b.2", percent: 10 }]],
    [
      "a key named twice",
      [
        { key: "b", percent: 10 },
        { key: "b", when: { level: "x" } },
      ],
    ],
    [
      "percents adding up to more than 100",
      [
        { key: "b", percent: 60 },
        { key: "c", percent: 41 },
      ],
    ],
  ])("refuses %s", (_case, value) => {
    expect(Result.isFailure(decode(value))).toBe(true);
  });
});

describe("AttributePatch", () => {
  const decode = Schema.decodeUnknownResult(Schemas.AttributePatch);

  it("admits null, which removes a key", () => {
    expect(decode({ plan: "pro", city: null })).toStrictEqual(
      Result.succeed({ plan: "pro", city: null }),
    );
  });

  it("rejects an over-long key rather than silently dropping the entry", () => {
    expect(
      Result.isFailure(decode({ [`k${"x".repeat(Schemas.maxAttributeKeyLength)}`]: null })),
    ).toBe(true);
  });
});

describe("SetAttributesPayload", () => {
  it("refuses a payload naming one mailbox twice, in any case", () => {
    expect(
      Result.isFailure(
        Schema.decodeResult(Schemas.SetAttributesPayload)({
          contacts: [
            { email: "Sam@example.com", attributes: {} },
            { email: "sam@EXAMPLE.com", attributes: {} },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("EntityCursor", () => {
  const decode = Schema.decodeUnknownResult(Schemas.EntityCursor);

  const createdAt = "2026-09-11T10:00:00.000Z";

  const id = "0195f0a0-1111-4222-8333-44444444c001";

  // The cursor a page reports has to be the cursor the next request accepts, or paging is broken
  // for every client that echoes the value back — which is what the README promises scripts.
  it("accepts a well-formed cursor unchanged, so a page's value can be handed straight back", () => {
    const cursor = `${createdAt}#${id}`;

    expect(decode(cursor)).toStrictEqual(Result.succeed(cursor));
    expect(Schema.encodeResult(Schemas.EntityCursor)(cursor)).toStrictEqual(Result.succeed(cursor));
  });

  it("rejects a tampered cursor instead of passing it through", () => {
    expect(Result.isFailure(decode("not-a-cursor"))).toBe(true);
    expect(Result.isFailure(decode(`${createdAt}#not-a-uuid`))).toBe(true);
    expect(Result.isFailure(decode(`yesterday#${id}`))).toBe(true);
    expect(Result.isFailure(decode(`#${id}`))).toBe(true);
  });
});

describe("imports", () => {
  const entries = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ email: `contact${index}@example.com` }));

  it("refuses a payload naming one mailbox twice, in any case", () => {
    expect(
      Result.isFailure(
        Schema.decodeResult(Schemas.ImportContactsPayload)({
          contacts: [{ email: "Sam@example.com" }, { email: "sam@EXAMPLE.com" }],
        }),
      ),
    ).toBe(true);
  });

  it("admits a file larger than one call's batch", () => {
    const file = { contacts: entries(Schemas.maxBatchEntries + 1) };

    expect(
      Result.getOrThrow(Schema.decodeResult(Schemas.ImportContactsFile)(file)).contacts,
    ).toHaveLength(Schemas.maxBatchEntries + 1);
  });

  it("refuses a file naming one mailbox twice, even batches apart", () => {
    const file = entries(30);

    file[0] = { email: "Sam@example.com" };
    file[25] = { email: "sam@EXAMPLE.com" };

    expect(
      Result.isFailure(Schema.decodeResult(Schemas.ImportContactsFile)({ contacts: file })),
    ).toBe(true);
  });
});

describe("TestSendPayload", () => {
  const decode = Schema.decodeUnknownResult(Schemas.TestSendPayload);

  it("admits explicit addresses or one list", () => {
    expect(Result.isSuccess(decode({ to: ["a@example.com", "b@example.com"] }))).toBe(true);
    expect(Result.isSuccess(decode({ listId: "0195f0a0-1111-4222-8333-44444444109e" }))).toBe(true);
  });

  it("refuses one mailbox named twice, in any case", () => {
    expect(Result.isFailure(decode({ to: ["a@example.com", "A@example.com"] }))).toBe(true);
  });
});

// The CLI retries a 5xx answer, so a conflict declared as 503 would be retried as if transient.
describe("public error statuses", () => {
  const declared = [
    [Errors.Unauthorized, 401],
    [Errors.ContactNotFound, 404],
    [Errors.ListNotFound, 404],
    [Errors.CampaignNotFound, 404],
    [Errors.EmailAlreadyUsed, 409],
    [Errors.AddressOptedOut, 409],
    [Errors.ContactChanged, 409],
    [Errors.SendAtNotInFuture, 409],
    [Errors.CampaignStateConflict, 409],
    [Errors.TestAudienceTooLarge, 409],
    [Errors.VariantNotFound, 404],
    [Errors.DraftChanged, 409],
    [Errors.TooManyVariants, 422],
    [Errors.SplitOverfull, 422],
    [Errors.TooManyAttributes, 422],
    [Errors.SendingPaused, 503],
    [Errors.StorageUnavailable, 503],
    [Errors.EmailServiceUnavailable, 503],
    [Errors.QueueUnavailable, 503],
    [Errors.SchedulerUnavailable, 503],
    [Errors.AlarmsUnavailable, 503],
  ] as const;

  it.each(declared)("declares the status every consumer decodes against", (error, status) => {
    expect(error.ast.annotations?.httpApiStatus).toBe(status);
  });
});
