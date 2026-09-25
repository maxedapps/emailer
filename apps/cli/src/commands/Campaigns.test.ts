import { describe, expect, it } from "@effect/vitest";
import * as Errors from "@emailer/api/Errors";
import type * as Schemas from "@emailer/api/Schemas";
import { Effect, Exit } from "effect";

import {
  campaignId,
  createdAt,
  draft,
  fakeService,
  listId,
  parseJson,
  readers,
  runCli,
  tempFile,
  textBody,
} from "../../test/CliHarness.ts";

const create = ["campaigns", "create", "--list", listId, "--subject", "Release notes"] as const;

const member = (n: number): Schemas.Contact => ({
  id: `0195f0a0-1111-4222-8333-4444444c${String(n).padStart(4, "0")}`,
  email: `r${n}@example.com`,
  createdAt,
});

describe("campaign commands", () => {
  it.effect.each([
    ["send", "campaigns.send"],
    ["resume", "campaigns.resume"],
    ["cancel", "campaigns.cancel"],
    ["get", "campaigns.get"],
  ] as const)("%s calls its endpoint and prints the campaign it answers", ([command, endpoint]) =>
    Effect.gen(function* () {
      const service = fakeService({ campaigns: [draft] });

      const run = yield* runCli(service, ["campaigns", command, campaignId]);

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(service.received).toStrictEqual([{ endpoint, params: { id: campaignId } }]);
      expect(yield* parseJson(run.stdout)).toStrictEqual(draft);
    }),
  );

  it.effect("prints a preview link as JSON", () =>
    Effect.gen(function* () {
      const run = yield* runCli(fakeService({ campaigns: [draft] }), [
        "campaigns",
        "preview",
        campaignId,
      ]);

      expect(yield* parseJson(run.stdout)).toStrictEqual({
        url: `https://preview.example/previews/${campaignId}`,
        expiresAt: "2026-09-12T10:00:00.000Z",
      });
    }),
  );

  it.effect("lists campaigns as a page of summaries", () =>
    Effect.gen(function* () {
      const run = yield* runCli(fakeService({ campaigns: [draft] }), ["campaigns", "list"]);

      const printed = yield* parseJson(run.stdout);

      expect(printed).toMatchObject({ items: [{ id: campaignId, subject: "Release notes" }] });
      expect(printed).not.toHaveProperty("items.0.text");
    }),
  );

  it.effect("deletes a draft and reports it", () =>
    Effect.gen(function* () {
      const service = fakeService({ campaigns: [draft] });

      const run = yield* runCli(service, ["campaigns", "delete", campaignId]);

      expect(service.received).toStrictEqual([
        { endpoint: "campaigns.remove", params: { id: campaignId } },
      ]);
      expect(yield* parseJson(run.stdout)).toStrictEqual({ id: campaignId, deleted: true });
    }),
  );

  it.effect("reports the service's refusal on stderr with its fields, and prints nothing", () =>
    Effect.gen(function* () {
      const service = fakeService({
        campaigns: [draft],
        removeFailures: [new Errors.CampaignStateConflict({ state: "paused" })],
      });

      const run = yield* runCli(service, ["campaigns", "delete", campaignId]);

      expect(Exit.isFailure(run.exit)).toBe(true);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("CampaignStateConflict");
      expect(run.stderr).toContain("paused");
    }),
  );
});

describe("campaigns schedule", () => {
  it.effect.each([
    ["2026-09-20", "2026-09-20T00:00:00.000Z"],
    ["2028-02-29T00:30+02:00", "2028-02-28T22:30:00.000Z"],
  ] as const)("sends the ISO input %s as the instant %s", ([input, sendAt]) =>
    Effect.gen(function* () {
      const service = fakeService({ campaigns: [draft] });

      yield* runCli(service, ["campaigns", "schedule", campaignId, "--at", input]);

      expect(service.payloadsOf("campaigns.schedule")).toStrictEqual([{ sendAt }]);
    }),
  );

  it.effect.each(["2099-02-29T09:00Z", "2099-04-31T09:00+02:00"])(
    "refuses the impossible date %s before any request",
    (input) =>
      Effect.gen(function* () {
        const service = fakeService({ campaigns: [draft] });

        const run = yield* runCli(service, ["campaigns", "schedule", campaignId, "--at", input]);

        expect(Exit.isFailure(run.exit)).toBe(true);
        expect(service.received).toStrictEqual([]);
      }),
  );
});

describe("campaign content", () => {
  it.effect("creates a campaign from the contents of the --text and --html files", () =>
    Effect.gen(function* () {
      const service = fakeService();
      const html = "<p>Hello there</p>";

      const run = yield* runCli(service, [
        ...create,
        "--text",
        yield* tempFile("txt", textBody),
        "--html",
        yield* tempFile("html", html),
      ]);

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(service.payloadsOf("campaigns.create")).toStrictEqual([
        { listId, subject: "Release notes", text: textBody, html },
      ]);
    }),
  );

  it.effect("creates a campaign whose filter is the merged --filter pairs", () =>
    Effect.gen(function* () {
      const service = fakeService();

      yield* runCli(service, [
        ...create,
        "--text",
        yield* tempFile("txt", textBody),
        "--filter",
        "plan=pro",
        "--filter",
        "city=Berlin",
      ]);

      expect(service.payloadsOf("campaigns.create")).toMatchObject([
        { filter: { plan: "pro", city: "Berlin" } },
      ]);
    }),
  );

  it.effect(
    "creates a campaign from --markdown with the rendered layout and a text body free of Markdown",
    () =>
      Effect.gen(function* () {
        const service = fakeService();
        const markdown = "# Hello\n\nSome **bold** words and a [link](https://example.com).";

        yield* runCli(service, [...create, "--markdown", yield* tempFile("md", markdown)]);

        const [payload] = service.payloadsOf("campaigns.create");

        expect(payload).toMatchObject({
          subject: "Release notes",
          text: "Hello\n\nSome bold words and a link (https://example.com).",
        });
        expect(payload).toHaveProperty("html", expect.stringContaining("<!doctype html>"));
        expect(payload).toHaveProperty(
          "html",
          expect.stringContaining("<title>Release notes</title>"),
        );
        expect(payload).toHaveProperty(
          "html",
          expect.stringContaining(
            '<strong>bold</strong> words and a <a href="https://example.com"',
          ),
        );
      }),
  );

  // Found by running the command: an oversized --text file was echoed back in full on stderr.
  it.effect(
    "refuses a --text file over the size limit without echoing it, before any request",
    () =>
      Effect.gen(function* () {
        const service = fakeService();

        const run = yield* runCli(service, [
          ...create,
          "--text",
          yield* tempFile("txt", "oversized-filler\n".repeat(4000)),
        ]);

        expect(Exit.isFailure(run.exit)).toBe(true);
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("65536 UTF-8 bytes");
        expect(run.stderr).not.toContain("oversized-filler");
        expect(service.received).toStrictEqual([]);
      }),
  );

  it.effect.each([
    [["--markdown", "{md}", "--text", "{txt}"], "Pass either --markdown or --text"],
    [["--markdown", "{md}", "--html", "{txt}"], "Pass either --markdown or --text"],
    [["--html", "{txt}"], "--html needs --text"],
    [[], "Pass --markdown, or --text"],
  ] as const)("refuses the content flags %j before any request", ([flags, message]) =>
    Effect.gen(function* () {
      const service = fakeService();
      const md = yield* tempFile("md", "# Hello");
      const txt = yield* tempFile("txt", textBody);

      const run = yield* runCli(service, [
        ...create,
        ...flags.map((flag) => flag.replace("{md}", md).replace("{txt}", txt)),
      ]);

      expect(Exit.isFailure(run.exit)).toBe(true);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain(message);
      expect(service.received).toStrictEqual([]);
    }),
  );

  it.effect(
    "updates a draft from --text alone, clearing the old html and, with --clear-filter, the filter",
    () =>
      Effect.gen(function* () {
        const service = fakeService({ campaigns: [draft] });

        yield* runCli(service, [
          "campaigns",
          "update",
          campaignId,
          "--text",
          yield* tempFile("txt", textBody),
          "--clear-filter",
        ]);

        expect(service.payloadsOf("campaigns.update")).toStrictEqual([
          { text: textBody, html: null, filter: null },
        ]);
      }),
  );

  it.effect(
    "renders an updated --markdown body under the draft's own subject when --subject is absent",
    () =>
      Effect.gen(function* () {
        const service = fakeService({ campaigns: [draft] });

        yield* runCli(service, [
          "campaigns",
          "update",
          campaignId,
          "--markdown",
          yield* tempFile("md", "# Fresh"),
        ]);

        const [change] = service.payloadsOf("campaigns.update");

        expect(change).not.toHaveProperty("subject");
        expect(change).not.toHaveProperty("filter");
        expect(change).toHaveProperty("text", "Fresh");
        expect(change).toHaveProperty(
          "html",
          expect.stringContaining("<title>Release notes</title>"),
        );
      }),
  );
});

describe("campaigns test", () => {
  const withReaders = (members: ReadonlyArray<Schemas.Contact>) =>
    fakeService({ campaigns: [draft], lists: [readers], members });

  const three = [member(1), member(2), member(3)];

  it.effect("sends a test to every --to address and prints each outcome", () =>
    Effect.gen(function* () {
      const service = withReaders(three);

      const run = yield* runCli(service, [
        "campaigns",
        "test",
        campaignId,
        "--to",
        "a@example.com",
        "--to",
        "b@example.com",
      ]);

      expect(service.payloadsOf("campaigns.test")).toStrictEqual([
        { to: ["a@example.com", "b@example.com"] },
      ]);
      expect(yield* parseJson(run.stdout)).toStrictEqual({
        recipients: [
          { email: "a@example.com", outcome: "accepted", messageId: "message-1" },
          { email: "b@example.com", outcome: "accepted", messageId: "message-2" },
        ],
      });
    }),
  );

  it.effect.each([[["--to", "a@example.com", "--list", listId]], [[]]] as const)(
    "refuses %j before any request",
    ([args]) =>
      Effect.gen(function* () {
        const service = withReaders(three);

        const run = yield* runCli(service, ["campaigns", "test", campaignId, ...args]);

        expect(Exit.isFailure(run.exit)).toBe(true);
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("Pass --to (repeatable) or --list");
        expect(service.received).toStrictEqual([]);
      }),
  );

  it.effect("asks before sending to a list, and sends once the answer is yes", () =>
    Effect.gen(function* () {
      const service = withReaders(three);

      const run = yield* runCli(service, ["campaigns", "test", campaignId, "--list", listId], {
        answer: "y",
      });

      expect(run.prompted).toContain('Send a test of "Release notes" to 3 members of "Readers"?');
      expect(service.payloadsOf("campaigns.test")).toStrictEqual([{ listId }]);
      expect(yield* parseJson(run.stdout)).toHaveProperty("recipients.2.email", "r3@example.com");
    }),
  );

  it.effect("sends nothing and prints nothing when the answer is no", () =>
    Effect.gen(function* () {
      const service = withReaders(three);

      const run = yield* runCli(service, ["campaigns", "test", campaignId, "--list", listId], {
        answer: "n",
      });

      expect(Exit.isSuccess(run.exit)).toBe(true);
      expect(run.stdout).toBe("");
      expect(service.payloadsOf("campaigns.test")).toHaveLength(0);
    }),
  );

  it.effect("stops with a --yes hint when stdin closes without an answer", () =>
    Effect.gen(function* () {
      const service = withReaders(three);

      const run = yield* runCli(service, ["campaigns", "test", campaignId, "--list", listId]);

      expect(Exit.isFailure(run.exit)).toBe(true);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("pass --yes");
      expect(service.payloadsOf("campaigns.test")).toHaveLength(0);
    }),
  );

  it.effect("sends to a list without asking under --yes", () =>
    Effect.gen(function* () {
      const service = withReaders(three);

      const run = yield* runCli(service, [
        "campaigns",
        "test",
        campaignId,
        "--list",
        listId,
        "--yes",
      ]);

      expect(run.prompted).toBe("");
      expect(service.payloadsOf("campaigns.test")).toStrictEqual([{ listId }]);
    }),
  );

  it.effect.each([
    ["asking", [], "y"],
    ["--yes", ["--yes"], undefined],
  ] as const)(
    "refuses a list of more than twenty members before sending, under %s",
    ([_label, flags, answer]) =>
      Effect.gen(function* () {
        const service = withReaders(Array.from({ length: 21 }, (_, n) => member(n)));

        const run = yield* runCli(
          service,
          ["campaigns", "test", campaignId, "--list", listId, ...flags],
          answer === undefined ? {} : { answer },
        );

        expect(Exit.isFailure(run.exit)).toBe(true);
        expect(run.stderr).toContain('"Readers" has more than 20 members');
        expect(run.prompted).toBe("");
        expect(service.payloadsOf("campaigns.test")).toHaveLength(0);
      }),
  );
});
