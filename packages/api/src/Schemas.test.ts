import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";

import * as Errors from "./Errors.ts";
import * as Schemas from "./Schemas.ts";

describe("Timestamp", () => {
  const decode = Schema.decodeUnknownResult(Schemas.Timestamp);

  it.each([
    "2024-02-29T23:59:59.123Z",
    "2000-02-29T00:00:00.000Z",
    "2026-04-30T09:00:00.000Z",
    "0000-01-01T00:00:00.000Z",
    "9999-12-31T23:59:59.999Z",
  ])("preserves the valid canonical instant %s", (timestamp) => {
    expect(decode(timestamp)).toStrictEqual(Result.succeed(timestamp));
    expect(Schema.encodeResult(Schemas.Timestamp)(timestamp)).toStrictEqual(
      Result.succeed(timestamp),
    );
  });

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
  ])("rejects an invalid or noncanonical instant %s", (timestamp) => {
    expect(Result.isFailure(decode(timestamp))).toBe(true);
  });
});

describe("normalizeEmailAddress", () => {
  it("trims and lowercases only the domain", () => {
    expect(Schemas.normalizeEmailAddress("  Sam.R@EXAMPLE.COM  ")).toBe("Sam.R@example.com");
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
  const decode = Schema.decodeUnknownResult(Schemas.ListedEmailAddress);

  it("trims but keeps the case SES stores", () => {
    expect(decode(" User@Example.com ")).toStrictEqual(Result.succeed("User@Example.com"));
  });

  it("still rejects an address without a domain label", () => {
    expect(Result.isFailure(decode("sam@example"))).toBe(true);
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

  it("rejects an address longer than the RFC 5321 path limit", () => {
    expect(Result.isFailure(decode(`${"a".repeat(Schemas.maxEmailLength)}@example.com`))).toBe(
      true,
    );
  });

  it("rejects embedded CR/LF that would forge a header", () => {
    expect(Result.isFailure(decode("sam@example.com\r\nBcc: other@example.com"))).toBe(true);
  });
});

describe("EntityName", () => {
  const decode = Schema.decodeUnknownResult(Schemas.EntityName);

  it("trims while decoding", () => {
    expect(decode("  Newsletter  ")).toStrictEqual(Result.succeed("Newsletter"));
  });

  it("rejects a name that is only whitespace", () => {
    expect(Result.isFailure(decode("   "))).toBe(true);
  });

  it("accepts a name at the length limit", () => {
    const atLimit = "n".repeat(Schemas.maxNameLength);

    expect(decode(atLimit)).toStrictEqual(Result.succeed(atLimit));
  });

  it("rejects a name one character over the limit", () => {
    expect(Result.isFailure(decode("n".repeat(Schemas.maxNameLength + 1)))).toBe(true);
  });
});

describe("CampaignSubject", () => {
  const decode = Schema.decodeUnknownResult(Schemas.CampaignSubject);

  it("trims while decoding", () => {
    expect(decode("  Release notes ")).toStrictEqual(Result.succeed("Release notes"));
  });

  it("rejects a multi-line subject", () => {
    expect(Result.isFailure(decode("Release\nnotes"))).toBe(true);
  });

  it("rejects a carriage return", () => {
    expect(Result.isFailure(decode("Release\rnotes"))).toBe(true);
  });

  it("accepts a subject at the length limit", () => {
    const atLimit = "s".repeat(Schemas.maxSubjectLength);

    expect(decode(atLimit)).toStrictEqual(Result.succeed(atLimit));
  });

  it("rejects a subject that is only whitespace", () => {
    expect(Result.isFailure(decode("   "))).toBe(true);
  });

  it("rejects a subject that only exceeds the limit after trimming is applied", () => {
    expect(Result.isFailure(decode(` ${"s".repeat(Schemas.maxSubjectLength + 1)} `))).toBe(true);
  });

  it("rejects a subject over the length limit", () => {
    expect(Result.isFailure(decode("s".repeat(Schemas.maxSubjectLength + 1)))).toBe(true);
  });
});

describe("CampaignText", () => {
  const decode = Schema.decodeUnknownResult(Schemas.CampaignText);

  it("preserves literal whitespace and line breaks", () => {
    const body = "  Hello\n\n  World  \n";

    expect(decode(body)).toStrictEqual(Result.succeed(body));
  });

  it("rejects an empty body", () => {
    expect(Result.isFailure(decode(""))).toBe(true);
  });

  it("accepts a body at the byte limit", () => {
    const atLimit = "a".repeat(Schemas.maxTextBytes);

    expect(decode(atLimit)).toStrictEqual(Result.succeed(atLimit));
  });

  it("measures the limit in UTF-8 bytes, not characters", () => {
    const overLimitInBytes = "é".repeat(Schemas.maxTextBytes / 2 + 1);

    expect(overLimitInBytes.length).toBeLessThan(Schemas.maxTextBytes);

    expect(Result.isFailure(decode(overLimitInBytes))).toBe(true);
  });
});

describe("CampaignHtml", () => {
  const decode = Schema.decodeUnknownResult(Schemas.CampaignHtml);

  it("preserves literal whitespace and line breaks", () => {
    const body = "  <p>Hello</p>\n\n  <p>World</p>  \n";

    expect(decode(body)).toStrictEqual(Result.succeed(body));
  });

  it("rejects an empty body", () => {
    expect(Result.isFailure(decode(""))).toBe(true);
  });

  it("accepts a body at the byte limit", () => {
    const atLimit = "a".repeat(Schemas.maxHtmlBytes);

    expect(decode(atLimit)).toStrictEqual(Result.succeed(atLimit));
  });

  it("measures the limit in UTF-8 bytes, not characters", () => {
    const overLimitInBytes = "é".repeat(Schemas.maxHtmlBytes / 2 + 1);

    expect(overLimitInBytes.length).toBeLessThan(Schemas.maxHtmlBytes);

    expect(Result.isFailure(decode(overLimitInBytes))).toBe(true);
  });
});

describe("CreateContactPayload", () => {
  const decode = Schema.decodeUnknownResult(Schemas.CreateContactPayload);

  it("accepts an optional name", () => {
    expect(decode({ email: "sam@example.com" })).toStrictEqual(
      Result.succeed({
        email: "sam@example.com",
      }),
    );
  });

  it("drops unknown properties so they cannot become stored fields", () => {
    expect(decode({ email: "sam@example.com", isAdmin: true })).toStrictEqual(
      Result.succeed({
        email: "sam@example.com",
      }),
    );
  });
});

describe("CreateCampaignPayload", () => {
  const decode = Schema.decodeUnknownResult(Schemas.CreateCampaignPayload);

  const payload = {
    listId: "0195f0a0-1111-4222-8333-444444444442",
    subject: "Release notes",
    text: "Hello",
  };

  it("decodes without html", () => {
    expect(decode(payload)).toStrictEqual(Result.succeed(payload));
  });

  it("decodes with a string html", () => {
    const withHtml = { ...payload, html: "<p>Hello</p>" };

    expect(decode(withHtml)).toStrictEqual(Result.succeed(withHtml));
  });

  it("refuses html: undefined", () => {
    expect(Result.isFailure(decode({ ...payload, html: undefined }))).toBe(true);
  });

  it("refuses an empty html body", () => {
    expect(Result.isFailure(decode({ ...payload, html: "" }))).toBe(true);
  });

  it("decodes with a filter", () => {
    const withFilter = { ...payload, filter: { plan: "pro" } };

    expect(decode(withFilter)).toStrictEqual(Result.succeed(withFilter));
  });

  it("refuses filter: undefined", () => {
    expect(Result.isFailure(decode({ ...payload, filter: undefined }))).toBe(true);
  });
});

describe("ScheduleCampaignPayload", () => {
  const decode = Schema.decodeUnknownResult(Schemas.ScheduleCampaignPayload);

  it("decodes { sendAt }", () => {
    const payload = { sendAt: "2026-09-11T10:00:01.000Z" };

    expect(decode(payload)).toStrictEqual(Result.succeed(payload));
  });
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

  const decode = Schema.decodeUnknownResult(Schemas.Campaign);

  it.each([
    ["draft", { state: "draft" }],
    ["scheduled", { state: "scheduled", sendAt }],
    ["queued", { state: "queued", queuedAt }],
    ["sending", { state: "sending", queuedAt, startedAt, progress, feedback }],
    ["paused", { state: "paused", queuedAt, startedAt, progress, feedback, reason: "daily-quota" }],
    ["completed", { state: "completed", queuedAt, startedAt, finishedAt, progress, feedback }],
  ] as const)("accepts a %s campaign", (_state, submission) => {
    const campaign = Result.getOrThrow(decode({ ...base, submission }));

    expect(campaign.submission).toStrictEqual(submission);
  });

  it.each([
    "sending-paused",
    "daily-quota",
    "rate-limited",
    "reputation",
    "feedback",
    "manual",
  ] as const)("accepts a paused campaign with reason %s", (reason) => {
    const submission = { state: "paused", queuedAt, startedAt, progress, feedback, reason };

    const campaign = Result.getOrThrow(decode({ ...base, submission }));

    expect(campaign.submission).toStrictEqual(submission);
  });

  it("round-trips a paused campaign with reason manual", () => {
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

    expect(decode(campaign)).toStrictEqual(Result.succeed(campaign));
    expect(Schema.encodeResult(Schemas.Campaign)(campaign)).toStrictEqual(Result.succeed(campaign));
  });

  it("rejects an unrecognized pause reason", () => {
    expect(
      Result.isFailure(
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
  });

  it("rejects a sending campaign without progress", () => {
    expect(
      Result.isFailure(
        decode({ ...base, submission: { state: "sending", queuedAt, startedAt, feedback } }),
      ),
    ).toBe(true);
  });

  it("rejects a sending campaign without feedback", () => {
    expect(
      Result.isFailure(
        decode({ ...base, submission: { state: "sending", queuedAt, startedAt, progress } }),
      ),
    ).toBe(true);
  });

  it("rejects a malformed identifier", () => {
    expect(
      Result.isFailure(decode({ ...base, id: "not-a-uuid", submission: { state: "draft" } })),
    ).toBe(true);
  });

  it.each(["accepted", "unconfirmed", "rejected", "sent"])(
    "rejects former or unknown submission state %s",
    (state) => {
      expect(Result.isFailure(decode({ ...base, submission: { state } }))).toBe(true);
    },
  );

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

  it("rejects a timestamp that is not ISO UTC", () => {
    expect(
      Result.isFailure(
        decode({ ...base, createdAt: "2026-09-11 10:00:00", submission: { state: "draft" } }),
      ),
    ).toBe(true);
  });
});

describe("CampaignProgress", () => {
  const decode = Schema.decodeUnknownResult(Schemas.CampaignProgress);

  const progress = { accepted: 0, rejected: 1, uncertain: 2, skipped: 3 };

  it("round-trips counters so a get response can be decoded as stored", () => {
    expect(decode(progress)).toStrictEqual(Result.succeed(progress));
    expect(Schema.encodeResult(Schemas.CampaignProgress)(progress)).toStrictEqual(
      Result.succeed(progress),
    );
  });

  it("rejects a negative counter", () => {
    expect(Result.isFailure(decode({ ...progress, skipped: -1 }))).toBe(true);
  });
});

describe("CampaignFeedback", () => {
  const decode = Schema.decodeUnknownResult(Schemas.CampaignFeedback);

  const feedback = { bounced: 0, complained: 1 };

  it("round-trips counters so a get response can be decoded as stored", () => {
    expect(decode(feedback)).toStrictEqual(Result.succeed(feedback));
    expect(Schema.encodeResult(Schemas.CampaignFeedback)(feedback)).toStrictEqual(
      Result.succeed(feedback),
    );
  });

  it("rejects a negative counter", () => {
    expect(Result.isFailure(decode({ ...feedback, bounced: -1 }))).toBe(true);
  });
});

describe("AddressRecord", () => {
  const decode = Schema.decodeUnknownResult(Schemas.AddressRecord);

  const email = "sam@example.com";
  const at = "2026-09-11T10:00:00.000Z";

  const mailable = {
    email,
    status: "mailable" as const,
    transientBounces: [] as const,
    accountSuppression: null,
  };

  it("round-trips a mailable address with no optional rows and a null account entry", () => {
    expect(decode(mailable)).toStrictEqual(Result.succeed(mailable));
    expect(Schema.encodeResult(Schemas.AddressRecord)(mailable)).toStrictEqual(
      Result.succeed(mailable),
    );
  });

  it("round-trips the local unsubscribe and suppression rows when present", () => {
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

    expect(decode(record)).toStrictEqual(Result.succeed(record));
    expect(Schema.encodeResult(Schemas.AddressRecord)(record)).toStrictEqual(
      Result.succeed(record),
    );
  });

  it("round-trips a complaint suppression without the bounce-only subtype", () => {
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

    expect(decode(record)).toStrictEqual(Result.succeed(record));
    expect(Schema.encodeResult(Schemas.AddressRecord)(record)).toStrictEqual(
      Result.succeed(record),
    );
  });
});

describe("RejectionCode", () => {
  const decode = Schema.decodeUnknownResult(Schemas.RejectionCode);

  it("still decodes rate-limited, which later per-recipient rows carry", () => {
    expect(decode("rate-limited")).toStrictEqual(Result.succeed("rate-limited"));
  });

  it("rejects an unrecognized rejection code", () => {
    expect(Result.isFailure(decode("something-else"))).toBe(true);
  });
});

describe("mailboxKey", () => {
  it("lowercases the whole address, local part included, so identity matches consent", () => {
    expect(Schemas.mailboxKey("  Sam.R@Example.COM  ")).toBe("sam.r@example.com");
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

  it("rejects more entries than the contract admits", () => {
    const payload = Object.fromEntries(
      Array.from({ length: Schemas.maxAttributeEntries + 1 }, (_, index) => [`k${index}`, "v"]),
    );

    expect(Result.isFailure(decode(payload))).toBe(true);
  });

  it("rejects an over-long value", () => {
    const payload = { plan: "v".repeat(Schemas.maxAttributeValueLength + 1) };

    expect(Result.isFailure(decode(payload))).toBe(true);
  });

  it("keeps every entry that is within bounds", () => {
    expect(decode({ plan: "pro", city: "Berlin" })).toStrictEqual(
      Result.succeed({
        plan: "pro",
        city: "Berlin",
      }),
    );
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

describe("PageSize", () => {
  const decode = Schema.decodeUnknownResult(Schemas.PageSize);

  it.each([Schemas.minPageSize, Schemas.defaultPageSize, Schemas.maxPageSize])(
    "admits %i",
    (size) => {
      expect(decode(size)).toStrictEqual(Result.succeed(size));
    },
  );

  it.each([0, Schemas.maxPageSize + 1])("rejects %i", (size) => {
    expect(Result.isFailure(decode(size))).toBe(true);
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

describe("ImportContactsPayload", () => {
  const decode = Schema.decodeUnknownResult(Schemas.ImportContactsPayload);

  const entry = (email: string) => ({ email });

  it("rejects two entries that share one mailbox key", () => {
    expect(
      Result.isFailure(decode({ contacts: [entry("Sam@example.com"), entry("sam@EXAMPLE.com")] })),
    ).toBe(true);
  });

  it("admits distinct addresses up to the batch bound", () => {
    const contacts = Array.from({ length: Schemas.maxImportEntries }, (_, index) =>
      entry(`contact${index}@example.com`),
    );

    expect(Result.getOrThrow(decode({ contacts })).contacts).toHaveLength(Schemas.maxImportEntries);
  });

  it("rejects a batch beyond the bound", () => {
    const contacts = Array.from({ length: Schemas.maxImportEntries + 1 }, (_, index) =>
      entry(`contact${index}@example.com`),
    );

    expect(Result.isFailure(decode({ contacts }))).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(Result.isFailure(decode({ contacts: [] }))).toBe(true);
  });
});

describe("TestSendPayload", () => {
  const decode = Schema.decodeUnknownResult(Schemas.TestSendPayload);

  it("admits distinct addresses up to the recipient bound, or one list", () => {
    const to = Array.from({ length: Schemas.maxTestRecipients }, (_, n) => `r${n}@example.com`);

    expect(Result.isSuccess(decode({ to }))).toBe(true);
    expect(Result.isSuccess(decode({ listId: "0195f0a0-1111-4222-8333-44444444109e" }))).toBe(true);
  });

  it.each([
    [
      "more addresses than the bound",
      { to: Array.from({ length: 21 }, (_, n) => `r${n}@example.com`) },
    ],
    ["one mailbox twice", { to: ["a@example.com", "A@example.com"] }],
    ["no address", { to: [] }],
  ])("rejects %s", (_label, payload) => {
    expect(Result.isFailure(decode(payload))).toBe(true);
  });
});

describe("CampaignStateConflict", () => {
  it.each(["draft", "scheduled", "queued", "sending", "paused", "completed"] as const)(
    "encodes with state %s",
    (state) => {
      const error = new Errors.CampaignStateConflict({ state });
      const encoded = Result.getOrThrow(Schema.encodeResult(Errors.CampaignStateConflict)(error));

      expect(encoded._tag).toBe("CampaignStateConflict");
      expect(encoded.state).toBe(state);
      expect("runToken" in encoded).toBe(false);
    },
  );
});

describe("public error statuses", () => {
  const declared = [
    [Errors.Unauthorized, 401],
    [Errors.ContactNotFound, 404],
    [Errors.ListNotFound, 404],
    [Errors.CampaignNotFound, 404],
    [Errors.EmailAlreadyUsed, 409],
    [Errors.AddressOptedOut, 409],
    [Errors.SendAtNotInFuture, 409],
    [Errors.CampaignStateConflict, 409],
    [Errors.TestAudienceTooLarge, 409],
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

describe("UpdateCampaignPayload", () => {
  const decode = Schema.decodeUnknownResult(Schemas.UpdateCampaignPayload);

  it("keeps an absent field absent and an explicit null as null", () => {
    expect(decode({})).toStrictEqual(Result.succeed({}));
    expect(decode({ html: null, filter: null })).toStrictEqual(
      Result.succeed({
        html: null,
        filter: null,
      }),
    );
    expect(decode({ subject: "New", filter: { plan: "pro" } })).toStrictEqual(
      Result.succeed({
        subject: "New",
        filter: { plan: "pro" },
      }),
    );
  });

  it.each([{ text: null }, { subject: null }, { listId: null }, { html: "" }, { text: "" }])(
    "refuses %j",
    (payload) => {
      expect(Result.isFailure(decode(payload))).toBe(true);
    },
  );
});
