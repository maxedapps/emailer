import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import * as Schemas from "./Schemas.ts";

const isRejected = <A>(attempt: Effect.Effect<A, Schema.SchemaError>) =>
  Effect.map(Effect.result(attempt), Result.isFailure);

describe("Timestamp", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.Timestamp);

  it.each([
    "2024-02-29T23:59:59.123Z",
    "2000-02-29T00:00:00.000Z",
    "2026-04-30T09:00:00.000Z",
    "0000-01-01T00:00:00.000Z",
    "9999-12-31T23:59:59.999Z",
  ])("preserves the valid canonical instant %s", (timestamp) =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode(timestamp)).toBe(timestamp);
        expect(yield* Schema.encodeEffect(Schemas.Timestamp)(timestamp)).toBe(timestamp);
      }),
    ),
  );

  it.each([
    "2099-13-01T00:00:00.000Z",
    "2099-00-01T00:00:00.000Z",
    "2099-02-29T09:00:00.000Z",
    "2100-02-29T09:00:00.000Z",
    "2099-04-31T09:00:00.000Z",
    "2099-01-00T00:00:00.000Z",
    "2099-01-01T24:00:00.000Z",
    "2099-01-01T00:60:00.000Z",
    "2099-01-01T00:00:60.000Z",
    "2099-01-01T00:00:00Z",
    "2099-01-01T00:00:00.000+00:00",
    "2099-01-01T00:00:00.000Z\n",
  ])("rejects an invalid or noncanonical instant %s", (timestamp) =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode(timestamp))).toBe(true);
      }),
    ),
  );
});

describe("normalizeEmailAddress", () => {
  it("trims and lowercases only the domain", () => {
    expect(Schemas.normalizeEmailAddress("  Max.S@EXAMPLE.COM  ")).toBe("Max.S@example.com");
  });

  it("leaves a value without a mailbox separator alone apart from trimming", () => {
    expect(Schemas.normalizeEmailAddress("  not-an-address  ")).toBe("not-an-address");
  });

  it("splits on the last separator so the whole local part is preserved", () => {
    expect(Schemas.normalizeEmailAddress("a@b@EXAMPLE.COM")).toBe("a@b@example.com");
  });
});

describe("utf8ByteLength", () => {
  it("counts UTF-8 bytes rather than UTF-16 code units", () => {
    expect(Schemas.utf8ByteLength("é")).toBe(2);
    expect(Schemas.utf8ByteLength("😀")).toBe(4);
  });
});

describe("ListedEmailAddress", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.ListedEmailAddress);

  it("trims but keeps the case SES stores", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode(" User@Example.com ")).toBe("User@Example.com");
      }),
    ));

  it("still rejects an address without a domain label", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("max@example"))).toBe(true);
      }),
    ));
});

describe("EmailAddress", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.EmailAddress);

  it("normalizes a valid address while decoding", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode(" Max.S@Example.COM ")).toBe("Max.S@example.com");
      }),
    ));

  it("rejects an address without a domain label", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("max@example"))).toBe(true);
      }),
    ));

  it("rejects a non-ASCII local part instead of claiming SMTPUTF8 support", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("mäx@example.com"))).toBe(true);
      }),
    ));

  it("rejects an address longer than the RFC 5321 path limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode(`${"a".repeat(Schemas.maxEmailLength)}@example.com`))).toBe(
          true,
        );
      }),
    ));

  it("rejects embedded CR/LF that would forge a header", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("max@example.com\r\nBcc: other@example.com"))).toBe(true);
      }),
    ));
});

describe("EntityName", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.EntityName);

  it("trims while decoding", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode("  Newsletter  ")).toBe("Newsletter");
      }),
    ));

  it("rejects a name that is only whitespace", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("   "))).toBe(true);
      }),
    ));

  it("accepts a name at the length limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const atLimit = "n".repeat(Schemas.maxNameLength);

        expect(yield* decode(atLimit)).toBe(atLimit);
      }),
    ));

  it("rejects a name one character over the limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("n".repeat(Schemas.maxNameLength + 1)))).toBe(true);
      }),
    ));
});

describe("CampaignSubject", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.CampaignSubject);

  it("trims while decoding", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode("  Release notes ")).toBe("Release notes");
      }),
    ));

  it("rejects a multi-line subject", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("Release\nnotes"))).toBe(true);
      }),
    ));

  it("rejects a carriage return", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("Release\rnotes"))).toBe(true);
      }),
    ));

  it("accepts a subject at the length limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const atLimit = "s".repeat(Schemas.maxSubjectLength);

        expect(yield* decode(atLimit)).toBe(atLimit);
      }),
    ));

  it("rejects a subject that is only whitespace", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("   "))).toBe(true);
      }),
    ));

  it("rejects a subject that only exceeds the limit after trimming is applied", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode(` ${"s".repeat(Schemas.maxSubjectLength + 1)} `))).toBe(
          true,
        );
      }),
    ));

  it("rejects a subject over the length limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("s".repeat(Schemas.maxSubjectLength + 1)))).toBe(true);
      }),
    ));
});

describe("CampaignText", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.CampaignText);

  it("preserves literal whitespace and line breaks", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = "  Hello\n\n  World  \n";

        expect(yield* decode(body)).toBe(body);
      }),
    ));

  it("rejects an empty body", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode(""))).toBe(true);
      }),
    ));

  it("accepts a body at the byte limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const atLimit = "a".repeat(Schemas.maxTextBytes);

        expect(yield* decode(atLimit)).toBe(atLimit);
      }),
    ));

  it("measures the limit in UTF-8 bytes, not characters", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const overLimitInBytes = "é".repeat(Schemas.maxTextBytes / 2 + 1);

        expect(overLimitInBytes.length).toBeLessThan(Schemas.maxTextBytes);

        expect(yield* isRejected(decode(overLimitInBytes))).toBe(true);
      }),
    ));
});

describe("CampaignHtml", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.CampaignHtml);

  it("preserves literal whitespace and line breaks", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = "  <p>Hello</p>\n\n  <p>World</p>  \n";

        expect(yield* decode(body)).toBe(body);
      }),
    ));

  it("rejects an empty body", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode(""))).toBe(true);
      }),
    ));

  it("accepts a body at the byte limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const atLimit = "a".repeat(Schemas.maxHtmlBytes);

        expect(yield* decode(atLimit)).toBe(atLimit);
      }),
    ));

  it("measures the limit in UTF-8 bytes, not characters", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const overLimitInBytes = "é".repeat(Schemas.maxHtmlBytes / 2 + 1);

        expect(overLimitInBytes.length).toBeLessThan(Schemas.maxHtmlBytes);

        expect(yield* isRejected(decode(overLimitInBytes))).toBe(true);
      }),
    ));
});

describe("CreateContactPayload", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.CreateContactPayload);

  it("accepts an optional name", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode({ email: "max@example.com" })).toStrictEqual({
          email: "max@example.com",
        });
      }),
    ));

  it("drops unknown properties so they cannot become stored fields", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode({ email: "max@example.com", isAdmin: true })).toStrictEqual({
          email: "max@example.com",
        });
      }),
    ));
});

describe("CreateCampaignPayload", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.CreateCampaignPayload);

  const payload = {
    listId: "0195f0a0-1111-4222-8333-444444444442",
    subject: "Release notes",
    text: "Hello",
  };

  it("decodes without html", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode(payload)).toStrictEqual(payload);
      }),
    ));

  it("decodes with a string html", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const withHtml = { ...payload, html: "<p>Hello</p>" };

        expect(yield* decode(withHtml)).toStrictEqual(withHtml);
      }),
    ));

  it("refuses html: undefined", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode({ ...payload, html: undefined }))).toBe(true);
      }),
    ));

  it("refuses an empty html body", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode({ ...payload, html: "" }))).toBe(true);
      }),
    ));

  it("decodes with a filter", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const withFilter = { ...payload, filter: { plan: "pro" } };

        expect(yield* decode(withFilter)).toStrictEqual(withFilter);
      }),
    ));

  it("refuses filter: undefined", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode({ ...payload, filter: undefined }))).toBe(true);
      }),
    ));
});

describe("ScheduleCampaignPayload", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.ScheduleCampaignPayload);

  it("decodes { sendAt }", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const payload = { sendAt: "2026-09-11T10:00:01.000Z" };

        expect(yield* decode(payload)).toStrictEqual(payload);
      }),
    ));
});

describe("Campaign", () => {
  const campaignId = "0195f0a0-1111-4222-8333-444444444441";
  const listId = "0195f0a0-1111-4222-8333-444444444442";
  const createdAt = "2026-09-11T10:00:00.000Z";
  const queuedAt = "2026-09-11T10:00:01.000Z";
  const sendAt = queuedAt;
  const startedAt = "2026-09-11T10:00:02.000Z";
  const finishedAt = "2026-09-11T10:00:03.000Z";
  const progress = { accepted: 1, rejected: 2, uncertain: 0, skipped: 3 };
  const feedback = { bounced: 0, complained: 0 };

  const base = {
    id: campaignId,
    listId,
    subject: "Release notes",
    text: "Hello",
    createdAt,
  };

  const decode = Schema.decodeUnknownEffect(Schemas.Campaign);

  it.each([
    ["draft", { state: "draft" }],
    ["scheduled", { state: "scheduled", sendAt }],
    ["queued", { state: "queued", queuedAt }],
    ["sending", { state: "sending", queuedAt, startedAt, progress, feedback }],
    ["paused", { state: "paused", queuedAt, startedAt, progress, feedback, reason: "daily-quota" }],
    ["completed", { state: "completed", queuedAt, startedAt, finishedAt, progress, feedback }],
  ] as const)("accepts a %s campaign", (_state, submission) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const campaign = yield* decode({ ...base, submission });

        expect(campaign.submission).toStrictEqual(submission);
      }),
    ),
  );

  it.each([
    "sending-paused",
    "daily-quota",
    "rate-limited",
    "reputation",
    "feedback",
    "manual",
  ] as const)("accepts a paused campaign with reason %s", (reason) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const submission = { state: "paused", queuedAt, startedAt, progress, feedback, reason };

        const campaign = yield* decode({ ...base, submission });

        expect(campaign.submission).toStrictEqual(submission);
      }),
    ),
  );

  it("round-trips a paused campaign with reason manual", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const campaign = {
          ...base,
          submission: {
            state: "paused" as const,
            queuedAt,
            startedAt,
            progress,
            feedback,
            reason: "manual" as const,
          },
        };

        expect(yield* decode(campaign)).toStrictEqual(campaign);
        expect(yield* Schema.encodeEffect(Schemas.Campaign)(campaign)).toStrictEqual(campaign);
      }),
    ));

  it("rejects an unrecognized pause reason", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* isRejected(
            decode({
              ...base,
              submission: {
                state: "paused",
                queuedAt,
                startedAt,
                progress,
                feedback,
                reason: "something-else",
              },
            }),
          ),
        ).toBe(true);
      }),
    ));

  it("rejects a sending campaign without progress", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* isRejected(
            decode({ ...base, submission: { state: "sending", queuedAt, startedAt, feedback } }),
          ),
        ).toBe(true);
      }),
    ));

  it("rejects a sending campaign without feedback", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* isRejected(
            decode({ ...base, submission: { state: "sending", queuedAt, startedAt, progress } }),
          ),
        ).toBe(true);
      }),
    ));

  it("rejects a malformed identifier", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* isRejected(decode({ ...base, id: "not-a-uuid", submission: { state: "draft" } })),
        ).toBe(true);
      }),
    ));

  it.each(["accepted", "unconfirmed", "rejected", "sent"])(
    "rejects former or unknown submission state %s",
    (state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          expect(yield* isRejected(decode({ ...base, submission: { state } }))).toBe(true);
        }),
      ),
  );

  it("does not let a draft smuggle terminal fields into the contract", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const campaign = yield* decode({
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
        });

        expect(campaign.submission).toStrictEqual({ state: "draft" });
      }),
    ));

  it("rejects a timestamp that is not ISO UTC", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* isRejected(
            decode({ ...base, createdAt: "2026-09-11 10:00:00", submission: { state: "draft" } }),
          ),
        ).toBe(true);
      }),
    ));
});

describe("CampaignProgress", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.CampaignProgress);

  const progress = { accepted: 0, rejected: 1, uncertain: 2, skipped: 3 };

  it("round-trips counters so a get response can be decoded as stored", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode(progress)).toStrictEqual(progress);
        expect(yield* Schema.encodeEffect(Schemas.CampaignProgress)(progress)).toStrictEqual(
          progress,
        );
      }),
    ));

  it("rejects a negative counter", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode({ ...progress, skipped: -1 }))).toBe(true);
      }),
    ));
});

describe("CampaignFeedback", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.CampaignFeedback);

  const feedback = { bounced: 0, complained: 1 };

  it("round-trips counters so a get response can be decoded as stored", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode(feedback)).toStrictEqual(feedback);
        expect(yield* Schema.encodeEffect(Schemas.CampaignFeedback)(feedback)).toStrictEqual(
          feedback,
        );
      }),
    ));

  it("rejects a negative counter", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode({ ...feedback, bounced: -1 }))).toBe(true);
      }),
    ));
});

describe("AddressRecord", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.AddressRecord);

  const email = "max@example.com";
  const at = "2026-09-11T10:00:00.000Z";

  const mailable = {
    email,
    status: "mailable" as const,
    transientBounces: [] as const,
    accountSuppression: null,
  };

  it("round-trips a mailable address with no optional rows and a null account entry", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode(mailable)).toStrictEqual(mailable);
        expect(yield* Schema.encodeEffect(Schemas.AddressRecord)(mailable)).toStrictEqual(mailable);
      }),
    ));

  it("round-trips the local unsubscribe and suppression rows when present", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const record = {
          email,
          status: "suppressed" as const,
          unsubscribedAt: at,
          suppression: {
            reason: "bounce" as const,
            suppressedAt: at,
            bounceSubType: "General",
          },
          transientBounces: [`${at}#feedback-1`],
          accountSuppression: {
            reason: "complaint" as const,
            lastUpdateTime: at,
          },
        };

        expect(yield* decode(record)).toStrictEqual(record);
        expect(yield* Schema.encodeEffect(Schemas.AddressRecord)(record)).toStrictEqual(record);
      }),
    ));

  it("round-trips a complaint suppression without the bounce-only subtype", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const record = {
          email,
          status: "unsubscribed" as const,
          unsubscribedAt: at,
          suppression: {
            reason: "complaint" as const,
            suppressedAt: at,
            complaintFeedbackType: "abuse",
            complaintSubType: "OnAccountSuppressionList",
          },
          transientBounces: [],
          accountSuppression: null,
        };

        expect(yield* decode(record)).toStrictEqual(record);
        expect(yield* Schema.encodeEffect(Schemas.AddressRecord)(record)).toStrictEqual(record);
      }),
    ));
});

describe("RejectionCode", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.RejectionCode);

  it("still decodes rate-limited, which later per-recipient rows carry", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode("rate-limited")).toBe("rate-limited");
      }),
    ));

  it("rejects an unrecognized rejection code", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("something-else"))).toBe(true);
      }),
    ));
});

describe("mailboxKey", () => {
  it("lowercases the whole address, local part included, so identity matches consent", () => {
    expect(Schemas.mailboxKey("  Max.S@Example.COM  ")).toBe("max.s@example.com");
  });
});

describe("ContactAttributes", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.ContactAttributes);

  it("rejects an over-long key rather than silently dropping the entry", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const payload = { [`k${"x".repeat(Schemas.maxAttributeKeyLength)}`]: "v", plan: "pro" };

        expect(yield* isRejected(decode(payload))).toBe(true);
      }),
    ));

  it("rejects an empty key rather than silently dropping the entry", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode({ "": "v" }))).toBe(true);
      }),
    ));

  it("rejects more entries than the contract admits", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const payload = Object.fromEntries(
          Array.from({ length: Schemas.maxAttributeEntries + 1 }, (_, index) => [`k${index}`, "v"]),
        );

        expect(yield* isRejected(decode(payload))).toBe(true);
      }),
    ));

  it("rejects an over-long value", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const payload = { plan: "v".repeat(Schemas.maxAttributeValueLength + 1) };

        expect(yield* isRejected(decode(payload))).toBe(true);
      }),
    ));

  it("keeps every entry that is within bounds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode({ plan: "pro", city: "Berlin" })).toStrictEqual({
          plan: "pro",
          city: "Berlin",
        });
      }),
    ));
});

describe("UpdateContactPayload", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.UpdateContactPayload);

  it("distinguishes an absent field from an explicit null", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode({})).toStrictEqual({});
        expect(yield* decode({ name: null })).toStrictEqual({ name: null });
      }),
    ));

  it("refuses an explicit undefined, which carries no meaning", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode({ name: undefined }))).toBe(true);
      }),
    ));
});

describe("PageSize", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.PageSize);

  it.each([Schemas.minPageSize, Schemas.defaultPageSize, Schemas.maxPageSize])(
    "admits %i",
    (size) =>
      Effect.runPromise(
        Effect.gen(function* () {
          expect(yield* decode(size)).toBe(size);
        }),
      ),
  );

  it.each([0, Schemas.maxPageSize + 1])("rejects %i", (size) =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode(size))).toBe(true);
      }),
    ),
  );
});

describe("EntityCursor", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.EntityCursor);

  const createdAt = "2026-09-11T10:00:00.000Z";

  const id = "0195f0a0-1111-4222-8333-44444444c001";

  // The cursor a page reports has to be the cursor the next request accepts, or paging is broken
  // for every client that echoes the value back — which is what the README promises scripts.
  it("accepts a well-formed cursor unchanged, so a page's value can be handed straight back", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const cursor = `${createdAt}#${id}`;

        expect(yield* decode(cursor)).toBe(cursor);
        expect(yield* Schema.encodeEffect(Schemas.EntityCursor)(cursor)).toBe(cursor);
      }),
    ));

  it("rejects a tampered cursor instead of passing it through", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode("not-a-cursor"))).toBe(true);
        expect(yield* isRejected(decode(`${createdAt}#not-a-uuid`))).toBe(true);
        expect(yield* isRejected(decode(`yesterday#${id}`))).toBe(true);
        expect(yield* isRejected(decode(`#${id}`))).toBe(true);
      }),
    ));
});

describe("ImportContactsPayload", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.ImportContactsPayload);

  const entry = (email: string) => ({ email });

  it("rejects two entries that share one mailbox key", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const attempt = decode({ contacts: [entry("Max@example.com"), entry("max@EXAMPLE.com")] });

        expect(yield* isRejected(attempt)).toBe(true);
      }),
    ));

  it("admits distinct addresses up to the batch bound", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const contacts = Array.from({ length: Schemas.maxImportEntries }, (_, index) =>
          entry(`max${index}@example.com`),
        );

        expect((yield* decode({ contacts })).contacts).toHaveLength(Schemas.maxImportEntries);
      }),
    ));

  it("rejects a batch beyond the bound", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const contacts = Array.from({ length: Schemas.maxImportEntries + 1 }, (_, index) =>
          entry(`max${index}@example.com`),
        );

        expect(yield* isRejected(decode({ contacts }))).toBe(true);
      }),
    ));

  it("rejects an empty batch", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* isRejected(decode({ contacts: [] }))).toBe(true);
      }),
    ));
});

describe("PauseReason", () => {
  it("encodes and decodes manual", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* Schema.decodeEffect(Schemas.PauseReason)("manual")).toBe("manual");
        expect(yield* Schema.encodeEffect(Schemas.PauseReason)("manual")).toBe("manual");
      }),
    ));
});

describe("CampaignStateConflict", () => {
  it.each(["draft", "scheduled", "queued", "sending", "paused", "completed"] as const)(
    "encodes with state %s",
    (state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const error = new Schemas.CampaignStateConflict({ state });
          const encoded = yield* Schema.encodeEffect(Schemas.CampaignStateConflict)(error);

          expect(encoded._tag).toBe("CampaignStateConflict");
          expect(encoded.state).toBe(state);
          expect("runToken" in encoded).toBe(false);
        }),
      ),
  );
});

describe("public error statuses", () => {
  const declared = [
    [Schemas.NotFound, 404],
    [Schemas.EmailAlreadyUsed, 409],
    [Schemas.AddressOptedOut, 409],
    [Schemas.SendAtNotInFuture, 409],
    [Schemas.CampaignStateConflict, 409],
    [Schemas.PayloadTooLarge, 413],
    [Schemas.StorageUnavailable, 503],
  ] as const;

  it.each(declared)("declares the status every consumer decodes against", (error, status) => {
    expect(error.ast.annotations?.httpApiStatus).toBe(status);
  });
});

describe("UpdateCampaignPayload", () => {
  const decode = Schema.decodeUnknownEffect(Schemas.UpdateCampaignPayload);

  it("keeps an absent field absent and an explicit null as null", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* decode({})).toStrictEqual({});
        expect(yield* decode({ html: null, filter: null })).toStrictEqual({
          html: null,
          filter: null,
        });
        expect(yield* decode({ subject: "New", filter: { plan: "pro" } })).toStrictEqual({
          subject: "New",
          filter: { plan: "pro" },
        });
      }),
    ));

  it.each([{ text: null }, { subject: null }, { listId: null }, { html: "" }, { text: "" }])(
    "refuses %j",
    (payload) =>
      Effect.runPromise(
        Effect.gen(function* () {
          expect(Result.isFailure(yield* Effect.result(decode(payload)))).toBe(true);
        }),
      ),
  );
});
