import { NodeServices } from "@effect/platform-node";
import * as Schemas from "@emailer/api/Schemas";
import { Effect } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { randomUUID } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import
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
            text: "HELLO\n\nSome bold words and a link (https://example.com).",
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
});
