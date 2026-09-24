import { NodeServices } from "@effect/platform-node";
import * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  campaignId,
  createdAt,
  inMemoryService,
  listId,
  parseJson,
  pausedSubmission,
  runCli,
  textBody,
  token,
  withService,
  withTempFile,
} from "../../test/CliHarness.ts";

describe("campaign management from the command line", () => {
  it(
    "resumes a paused campaign and leaves a non-paused campaign unchanged",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: pausedSubmission,
          });

          const outcome = yield* withService(service, (baseUrl) =>
            Effect.gen(function* () {
              const resumed = yield* runCli(baseUrl, token, ["campaigns", "resume", campaignId]);
              const again = yield* runCli(baseUrl, token, ["campaigns", "resume", campaignId]);

              return { resumed, again };
            }),
          );

          expect(outcome.resumed.exitCode).toBe(0);
          expect(yield* parseJson(outcome.resumed.stdout)).toMatchObject({
            submission: { state: "queued", queuedAt: createdAt },
          });

          expect(outcome.again.exitCode).toBe(0);
          expect(yield* parseJson(outcome.again.stdout)).toStrictEqual(
            yield* parseJson(outcome.resumed.stdout),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it.each([
    ["2026-09-20T09:00Z", "2026-09-20T09:00:00.000Z"],
    ["2026-09-20", "2026-09-20T00:00:00.000Z"],
    ["2028-02-29T00:30+02:00", "2028-02-28T22:30:00.000Z"],
    ["2026-09-20T09:00:12.1Z", "2026-09-20T09:00:12.100Z"],
    ["2026-09-20T09:00:12.123-05:30", "2026-09-20T14:30:12.123Z"],
  ])(
    "schedules the ISO input %s at %s",
    (input, sendAt) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: { state: "draft" },
          });

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "schedule", campaignId, "--at", input]),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toMatchObject({
            submission: { state: "scheduled", sendAt },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "reads a zone-less --at as UTC regardless of the operator's TZ",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: { state: "draft" },
          });

          const result = yield* withService(service, (baseUrl) =>
            runCli(
              baseUrl,
              token,
              ["campaigns", "schedule", campaignId, "--at", "2026-09-20T09:00"],
              { TZ: "Europe/Berlin" },
            ),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toMatchObject({
            submission: { state: "scheduled", sendAt: "2026-09-20T09:00:00.000Z" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it.each([
    "nonsense",
    "2099-02-29T09:00Z",
    "2099-04-31T09:00+02:00",
    "2099-01-01T24:00Z",
    "2099-01-01T09:00+24:00",
    "2099-01-01T09:00Z\n",
    "2099-01-01T09:00:00.1234Z",
    "9999-12-31T23:59-01:00",
  ])(
    "rejects invalid --at %s before issuing any request",
    (input) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: { state: "draft" },
          });

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "schedule", campaignId, "--at", input]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout.startsWith("{")).toBe(false);
          expect(service.authorizations).toHaveLength(0);
          expect(service.campaigns.get(campaignId)?.submission).toStrictEqual({ state: "draft" });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it("describes pending cancellation in cancel help", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* runCli("http://127.0.0.1:1", "", ["campaigns", "cancel", "--help"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("scheduled");
        expect(result.stdout).toContain("queued first send");
        expect(result.stdout).toContain("draft");
        expect(result.stdout).toContain("queued resume");
        expect(result.stdout).toContain("paused");
        expect(result.stdout).toContain("manual");
        expect(result.stdout).not.toContain("run token");
        expect(result.stdout).not.toContain("runToken");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it(
    "cancels a scheduled campaign back to draft",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: { state: "scheduled", sendAt: "2026-09-20T09:00:00.000Z" },
          });

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "cancel", campaignId]),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toMatchObject({
            submission: { state: "draft" },
          });
          expect(result.stdout).not.toContain("runToken");
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "cancels a queued resume to paused with reason manual",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: { state: "queued", queuedAt: createdAt },
          });
          service.startedAt.set(campaignId, createdAt);

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "cancel", campaignId]),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toMatchObject({
            submission: { state: "paused", reason: "manual", startedAt: createdAt },
          });
          expect(result.stdout).not.toContain("runToken");
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "reports a cancellation conflict on stderr and leaves a sending campaign unchanged",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          const sending: Schemas.Campaign = {
            id: campaignId,
            listId,
            subject: "Release notes",
            text: "Hello there",
            createdAt,
            submission: {
              state: "sending",
              queuedAt: createdAt,
              startedAt: createdAt,
              progress: { accepted: 1, rejected: 0, uncertain: 0, skipped: 0 },
              feedback: { bounced: 0, complained: 0 },
            },
          };

          service.campaigns.set(campaignId, sending);

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "cancel", campaignId]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("CampaignStateConflict");
          expect(service.campaigns.get(campaignId)).toStrictEqual(sending);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it("lists campaigns as a JSON page", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = inMemoryService(token);

        service.campaigns.set(campaignId, {
          id: campaignId,
          listId,
          subject: "Release notes",
          text: "Hello there",
          createdAt,
          submission: { state: "draft" },
        });

        const result = yield* withService(service, (baseUrl) =>
          runCli(baseUrl, token, ["campaigns", "list"]),
        );

        expect(result.exitCode).toBe(0);

        const printed = yield* parseJson(result.stdout);

        expect(printed).toMatchObject({
          items: [{ id: campaignId, subject: "Release notes" }],
        });
        expect(printed).not.toHaveProperty("items.0.text");
      }).pipe(Effect.provide(NodeServices.layer)),
    ));

  it(
    "reports a 503 from send on stderr and exits nonzero",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token, { dispatchUnavailable: true });

          const outcome = yield* withService(service, (baseUrl) =>
            Effect.gen(function* () {
              yield* withTempFile("txt", textBody, (text) =>
                runCli(baseUrl, token, [
                  "campaigns",
                  "create",
                  "--list",
                  listId,
                  "--subject",
                  "Release notes",
                  "--text",
                  text,
                ]),
              );

              return yield* runCli(baseUrl, token, ["campaigns", "send", campaignId]);
            }),
          );

          expect(outcome.exitCode).not.toBe(0);
          expect(outcome.stdout).toBe("");
          expect(outcome.stderr).toContain("StorageUnavailable");
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "creates a campaign whose text and html are the contents of the --text and --html files",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);
          const html = "<p>Hello there</p>";

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("txt", textBody, (text) =>
              withTempFile("html", html, (file) =>
                runCli(baseUrl, token, [
                  "campaigns",
                  "create",
                  "--list",
                  listId,
                  "--subject",
                  "Release notes",
                  "--text",
                  text,
                  "--html",
                  file,
                ]),
              ),
            ),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toStrictEqual({
            id: campaignId,
            listId,
            subject: "Release notes",
            text: textBody,
            html,
            createdAt,
            submission: { state: "draft" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "creates a campaign whose filter is the merged --filter pairs",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("txt", textBody, (text) =>
              runCli(baseUrl, token, [
                "campaigns",
                "create",
                "--list",
                listId,
                "--subject",
                "Release notes",
                "--text",
                text,
                "--filter",
                "plan=pro",
                "--filter",
                "city=Berlin",
              ]),
            ),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toStrictEqual({
            id: campaignId,
            listId,
            subject: "Release notes",
            text: textBody,
            createdAt,
            submission: { state: "draft" },
            filter: { plan: "pro", city: "Berlin" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "rejects a missing --text file before issuing any request",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);
          const missing = `${tmpdir()}/emailer-${randomUUID()}.txt`;

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, [
              "campaigns",
              "create",
              "--list",
              listId,
              "--subject",
              "Release notes",
              "--text",
              missing,
            ]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout.startsWith("{")).toBe(false);
          expect(service.authorizations).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  // Found by running the command: an oversized --text file was echoed back in full on stderr.
  it(
    "refuses a --text file over the size limit without echoing it, before any request",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);
          const oversized = "oversized-filler\n".repeat(4000);

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("txt", oversized, (text) =>
              runCli(baseUrl, token, [
                "campaigns",
                "create",
                "--list",
                listId,
                "--subject",
                "Release notes",
                "--text",
                text,
              ]),
            ),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("65536 UTF-8 bytes");
          expect(result.stderr).not.toContain("oversized-filler");
          expect(service.authorizations).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "rejects a missing --html file before issuing any request",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);
          const missing = `${tmpdir()}/emailer-${randomUUID()}.html`;

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("txt", textBody, (text) =>
              runCli(baseUrl, token, [
                "campaigns",
                "create",
                "--list",
                listId,
                "--subject",
                "Release notes",
                "--text",
                text,
                "--html",
                missing,
              ]),
            ),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout.startsWith("{")).toBe(false);
          expect(service.authorizations).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "creates a campaign from --markdown with the rendered layout and a text body free of Markdown",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);
          const markdown = "# Hello\n\nSome **bold** words and a [link](https://example.com).";

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("md", markdown, (file) =>
              runCli(baseUrl, token, [
                "campaigns",
                "create",
                "--list",
                listId,
                "--subject",
                "Release notes",
                "--markdown",
                file,
              ]),
            ),
          );

          expect(result.exitCode).toBe(0);

          const created = yield* parseJson(result.stdout);

          expect(created).toMatchObject({
            subject: "Release notes",
            text: "Hello\n\nSome bold words and a link (https://example.com).",
          });
          expect(created).toHaveProperty("html", expect.stringContaining("<!doctype html>"));
          expect(created).toHaveProperty(
            "html",
            expect.stringContaining("<title>Release notes</title>"),
          );
          expect(created).toHaveProperty(
            "html",
            expect.stringContaining(
              '<strong>bold</strong> words and a <a href="https://example.com"',
            ),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it.each([
    [["--markdown", "{md}", "--text", "{txt}"], "Pass either --markdown or --text"],
    [["--markdown", "{md}", "--html", "{txt}"], "Pass either --markdown or --text"],
    [["--html", "{txt}"], "--html needs --text"],
    [[], "Pass --markdown, or --text"],
  ])(
    "refuses the content flags %j before any request",
    (flags, message) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("md", "# Hello", (md) =>
              withTempFile("txt", textBody, (txt) =>
                runCli(baseUrl, token, [
                  "campaigns",
                  "create",
                  "--list",
                  listId,
                  "--subject",
                  "Release notes",
                  ...flags.map((flag) => flag.replace("{md}", md).replace("{txt}", txt)),
                ]),
              ),
            ),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain(message);
          expect(service.authorizations).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  const storedDraft: Schemas.Campaign = {
    id: campaignId,
    listId,
    subject: "Release notes",
    text: "Old text",
    html: "<p>Old</p>",
    createdAt,
    submission: { state: "draft" },
    filter: { plan: "pro" },
  };

  it(
    "updates a draft from --text alone, clearing the old html and, with --clear-filter, the filter",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, storedDraft);

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("txt", textBody, (text) =>
              runCli(baseUrl, token, [
                "campaigns",
                "update",
                campaignId,
                "--text",
                text,
                "--clear-filter",
              ]),
            ),
          );

          expect(result.exitCode).toBe(0);
          expect(service.campaignUpdates).toStrictEqual([
            { text: textBody, html: null, filter: null },
          ]);
          expect(yield* parseJson(result.stdout)).toStrictEqual({
            id: campaignId,
            listId,
            subject: "Release notes",
            text: textBody,
            createdAt,
            submission: { state: "draft" },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "renders an updated --markdown body under the draft's own subject when --subject is absent",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, storedDraft);

          const result = yield* withService(service, (baseUrl) =>
            withTempFile("md", "# Fresh", (file) =>
              runCli(baseUrl, token, ["campaigns", "update", campaignId, "--markdown", file]),
            ),
          );

          expect(result.exitCode).toBe(0);

          const [change] = service.campaignUpdates;

          expect(change).not.toHaveProperty("subject");
          expect(change).not.toHaveProperty("filter");
          expect(change?.text).toBe("Fresh");
          expect(change?.html).toContain("<title>Release notes</title>");
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "deletes a draft and reports it",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, storedDraft);

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "delete", campaignId]),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toStrictEqual({ id: campaignId, deleted: true });
          expect(service.campaigns.has(campaignId)).toBe(false);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "reports the state conflict when deleting a campaign that is no longer a draft",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, { ...storedDraft, submission: pausedSubmission });

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "delete", campaignId]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("CampaignStateConflict");
          expect(result.stderr).toContain("paused");
          expect(service.campaigns.has(campaignId)).toBe(true);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  const readers = ["one@example.com", "two@example.com", "three@example.com"];

  const testRun = (
    args: ReadonlyArray<string>,
    stdin = "",
    seed: ReadonlyArray<string> = readers,
  ) =>
    Effect.gen(function* () {
      const service = inMemoryService(token);

      service.campaigns.set(campaignId, storedDraft);
      service.seedList(seed);

      const result = yield* withService(service, (baseUrl) =>
        runCli(baseUrl, token, ["campaigns", "test", campaignId, ...args], {}, stdin),
      );

      return { service, result };
    });

  it(
    "sends a test to every --to address and prints each outcome",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { service, result } = yield* testRun([
            "--to",
            "a@example.com",
            "--to",
            "b@example.com",
          ]);

          expect(result.exitCode).toBe(0);
          expect(service.testSends).toStrictEqual([{ to: ["a@example.com", "b@example.com"] }]);
          expect(yield* parseJson(result.stdout)).toStrictEqual({
            recipients: [
              { email: "a@example.com", outcome: "accepted", messageId: "message-1" },
              { email: "b@example.com", outcome: "accepted", messageId: "message-2" },
            ],
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it.each([[["--to", "a@example.com", "--list", listId]], [[]]])(
    "refuses %j before any request",
    (args) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { service, result } = yield* testRun(args);

          expect(result.exitCode).not.toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("Pass --to (repeatable) or --list");
          expect(service.authorizations).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "asks on stderr before sending to a list, and sends once the answer is yes",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { service, result } = yield* testRun(["--list", listId], "y");

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain(
            'Send a test of "Release notes" to 3 members of "Readers"?',
          );
          expect(result.stdout).not.toContain("Send a test");
          expect(service.testSends).toStrictEqual([{ listId }]);
          expect(yield* parseJson(result.stdout)).toHaveProperty("recipients.2.email", readers[2]);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "sends nothing and prints nothing when the answer is no",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { service, result } = yield* testRun(["--list", listId], "n");

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toBe("");
          expect(service.testSends).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "stops with a --yes hint when stdin closes without an answer",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { service, result } = yield* testRun(["--list", listId]);

          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("pass --yes");
          expect(service.testSends).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "sends to a list without asking under --yes",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { service, result } = yield* testRun(["--list", listId, "--yes"]);

          expect(result.exitCode).toBe(0);
          expect(result.stderr).not.toContain("Send a test");
          expect(service.testSends).toStrictEqual([{ listId }]);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it.each([
    ["asking", ["--list", listId], "y"],
    ["--yes", ["--list", listId, "--yes"], undefined],
  ] as const)(
    "refuses a list of more than twenty members before sending, under %s",
    (_label, args, stdin) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const crowd = Array.from({ length: 21 }, (_, n) => `r${n}@example.com`);
          const { service, result } = yield* testRun([...args], stdin, crowd);

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain('"Readers" has more than 20 members');
          expect(result.stderr).not.toContain("Send a test");
          expect(service.testSends).toHaveLength(0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );

  it(
    "prints a preview link as JSON",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = inMemoryService(token);

          service.campaigns.set(campaignId, storedDraft);

          const result = yield* withService(service, (baseUrl) =>
            runCli(baseUrl, token, ["campaigns", "preview", campaignId]),
          );

          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toStrictEqual({
            url: `https://preview.example/previews/${campaignId}`,
            expiresAt: "2026-09-12T10:00:00.000Z",
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );
});
