import { makeEmailerClient } from "@emailer/api/Client";
import * as Errors from "@emailer/api/Errors";
import * as Schemas from "@emailer/api/Schemas";
import { Effect, Result } from "effect";
import { describe, expect } from "vitest";

import { newIdentifier } from "../Identifiers.ts";

import {
  awaitAddressStatus,
  campaignMeta,
  configuration,
  contactFor,
  fetchPage,
  htmlFooter,
  liveStorage,
  sendRows,
  simulator,
  testToSimulators,
  textFooter,
  type LiveTest,
} from "../../test/IntegrationSupport.ts";

const draftingTimeout = 180_000;

const counters = ["accepted", "rejected", "uncertain", "skipped", "bounced", "complained"] as const;

export const draftingSuite = (test: LiveTest) => {
  describe("drafting a campaign", () => {
    test(
      "edits a draft through both update shapes and then deletes it with its body",
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const runId = yield* newIdentifier;
        const list = yield* client.lists.create({ payload: { name: `drafting-${runId}` } });

        const campaign = yield* client.campaigns.create({
          payload: { listId: list.id, subject: `Draft ${runId}`, text: `First text${textFooter}` },
        });

        const filtered = yield* client.campaigns.update({
          params: { id: campaign.id },
          payload: {
            subject: `Edited ${runId}`,
            html: `<p>Now with HTML</p>${htmlFooter}`,
            filter: { plan: "pro" },
          },
        });

        expect(filtered).toMatchObject({
          subject: `Edited ${runId}`,
          text: `First text${textFooter}`,
          html: `<p>Now with HTML</p>${htmlFooter}`,
          filter: { plan: "pro" },
        });
        expect((yield* campaignMeta(campaign.id))["filter"]).toStrictEqual({
          M: { plan: { S: "pro" } },
        });

        const cleared = yield* client.campaigns.update({
          params: { id: campaign.id },
          payload: { text: `Second text${textFooter}`, html: null, filter: null },
        });

        expect(cleared).not.toHaveProperty("html");
        expect(cleared).not.toHaveProperty("filter");
        expect(yield* client.campaigns.get({ params: { id: campaign.id } })).toStrictEqual(cleared);
        expect(yield* campaignMeta(campaign.id)).not.toHaveProperty("filter");

        yield* client.campaigns.remove({ params: { id: campaign.id } });

        const gone = yield* Effect.result(client.campaigns.get({ params: { id: campaign.id } }));

        expect(Result.isFailure(gone) ? gone.failure : undefined).toStrictEqual(
          new Errors.CampaignNotFound(),
        );
      }),
      draftingTimeout,
    );

    test(
      "refuses to edit or delete a scheduled campaign until it is cancelled back to draft",
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const runId = yield* newIdentifier;
        const list = yield* client.lists.create({ payload: { name: `scheduled-${runId}` } });

        const campaign = yield* client.campaigns.create({
          payload: { listId: list.id, subject: `Scheduled ${runId}`, text: `Later${textFooter}` },
        });

        yield* client.campaigns.schedule({
          params: { id: campaign.id },
          payload: { sendAt: "2099-01-01T00:00:00.000Z" },
        });

        const edit = yield* Effect.result(
          client.campaigns.update({ params: { id: campaign.id }, payload: { subject: "x" } }),
        );

        const removal = yield* Effect.result(
          client.campaigns.remove({ params: { id: campaign.id } }),
        );

        const conflict = new Errors.CampaignStateConflict({ state: "scheduled" });

        expect(Result.isFailure(edit) ? edit.failure : undefined).toStrictEqual(conflict);
        expect(Result.isFailure(removal) ? removal.failure : undefined).toStrictEqual(conflict);

        yield* client.campaigns.cancel({ params: { id: campaign.id } });
        yield* client.campaigns.remove({ params: { id: campaign.id } });
      }),
      draftingTimeout,
    );

    test(
      "serves a preview of the current draft behind its protective headers, and refuses a forgery",
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const runId = yield* newIdentifier;
        const list = yield* client.lists.create({ payload: { name: `preview-${runId}` } });

        const campaign = yield* client.campaigns.create({
          payload: {
            listId: list.id,
            subject: `Preview ${runId}`,
            text: `Plain part${textFooter}`,
            html: `<p>First HTML part</p>${htmlFooter}`,
          },
        });

        const link = yield* client.campaigns.preview({ params: { id: campaign.id } });

        yield* client.campaigns.update({
          params: { id: campaign.id },
          payload: { html: `<p>Edited HTML part</p>${htmlFooter}` },
        });

        const page = yield* fetchPage(link.url);
        const body = yield* page.text;

        expect(page.status).toBe(200);
        expect(page.headers["content-security-policy"]).toContain("sandbox");
        expect(page.headers["referrer-policy"]).toBe("no-referrer");
        expect(page.headers["x-robots-tag"]).toBe("noindex, nofollow");
        expect(page.headers["cache-control"]).toBe("no-store");
        expect(body).toContain(`Preview ${runId}`);
        expect(body).toContain("Edited HTML part");
        expect(body).not.toContain("First HTML part");

        const forged = `${link.url.slice(0, -1)}${link.url.endsWith("a") ? "b" : "a"}`;

        expect((yield* fetchPage(forged)).status).toBe(404);

        yield* client.campaigns.remove({ params: { id: campaign.id } });

        expect((yield* fetchPage(link.url)).status).toBe(404);
      }),
      draftingTimeout,
    );
  });

  describe("test sends", () => {
    test(
      "sends [Test] copies only to the addresses named, as no contact or as one, without touching the campaign",
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const storage = yield* liveStorage(settings.tableName);
        const runId = yield* newIdentifier;
        const [named, unnamed] = [simulator("success", runId, 2), simulator("success", runId, 3)];
        const list = yield* client.lists.create({ payload: { name: `tests-${runId}` } });
        const ada = yield* client.contacts.create({ payload: { email: named, name: "Ada" } });

        for (const contactId of [ada.id, yield* contactFor(storage, unnamed)]) {
          yield* client.lists.addContact({ params: { listId: list.id, contactId } });
        }

        const campaign = yield* client.campaigns.create({
          payload: {
            listId: list.id,
            subject: `Tested ${runId}`,
            text: `Hi {{ contact.name | default: "there" }}${textFooter}`,
          },
        });

        const to = [simulator("success", runId, 0), simulator("success", runId, 1)];
        const plain = yield* testToSimulators(client, campaign.id, { to });

        const asAda = yield* testToSimulators(client, campaign.id, {
          to: to.slice(0, 1),
          as: named,
        });

        const outcomes = (result: Schemas.TestSendResult) =>
          result.recipients.map(({ email, outcome }) => [email, outcome]);

        expect(outcomes(plain)).toStrictEqual(to.map((email) => [email, "accepted"]));
        expect(outcomes(asAda)).toStrictEqual([[to[0], "accepted"]]);
        expect(
          yield* Effect.flip(
            testToSimulators(client, campaign.id, { to, as: simulator("success", runId, 9) }),
          ),
        ).toStrictEqual(new Errors.ContactNotFound());

        // What a member gets, and what every member gets, without sending anything.
        const rendered = yield* client.campaigns.render({
          params: { id: campaign.id },
          payload: { as: named },
        });

        expect(rendered).toMatchObject({ copy: Schemas.defaultCopy, subject: `Tested ${runId}` });
        expect(rendered.text.startsWith("Hi Ada\n")).toBe(true);

        const check = yield* client.campaigns.check({ params: { id: campaign.id }, payload: {} });

        expect(check).toStrictEqual({
          members: 2,
          filteredOut: 0,
          skipped: { unsubscribed: 0, suppressed: 0, bouncing: 0 },
          rendered: { [Schemas.defaultCopy]: 2 },
          findings: [
            { kind: "fallback", email: unnamed, copy: Schemas.defaultCopy, field: "name" },
          ],
        });

        const meta = yield* campaignMeta(campaign.id);

        expect(meta["state"]).toStrictEqual({ S: "draft" });

        for (const counter of counters) {
          expect(meta[counter]).toStrictEqual({ N: "0" });
        }

        expect(yield* sendRows(campaign.id)).toHaveLength(0);
      }),
      draftingTimeout,
    );

    test(
      "suppresses a bouncing test address without counting the bounce against the campaign",
      Effect.gen(function* () {
        const settings = yield* configuration;
        const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
        const storage = yield* liveStorage(settings.tableName);
        const runId = yield* newIdentifier;
        const bounce = simulator("bounce", runId);
        const list = yield* client.lists.create({ payload: { name: `test-bounce-${runId}` } });

        const campaign = yield* client.campaigns.create({
          payload: {
            listId: list.id,
            subject: `Test bounce ${runId}`,
            text: `Bounces.${textFooter}`,
          },
        });

        const result = yield* testToSimulators(client, campaign.id, { to: [bounce] });

        expect(result.recipients[0]?.outcome).toBe("accepted");
        expect(yield* awaitAddressStatus(storage, bounce, list.id, "suppressed")).toBe(
          "suppressed",
        );

        const meta = yield* campaignMeta(campaign.id);

        expect(meta["bounced"]).toStrictEqual({ N: "0" });
        expect(meta["runBounced"]).toStrictEqual({ N: "0" });

        const again = yield* testToSimulators(client, campaign.id, { to: [bounce] });

        expect(again.recipients).toStrictEqual([
          { email: bounce, outcome: "skipped", reason: "suppressed" },
        ]);
      }),
      draftingTimeout,
    );
  });
};
