import { makeEmailerClient } from "@emailer/api/Client";
import * as Errors from "@emailer/api/Errors";
import { Effect, Redacted, Result } from "effect";
import { describe, expect, it } from "vitest";

import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { newIdentifier } from "../Identifiers.ts";
import { mintToken } from "./Unsubscribe.ts";

import {
  accountSendQuota,
  awaitAddressStatus,
  awaitCampaignState,
  campaignStateTimeout,
  configuration,
  contactFor,
  live,
  liveStorage,
  sendRows,
  sendToSimulatorList,
  simulator,
  submitted,
  uniqueAddress,
  unsubscribeSettings,
} from "../../test/IntegrationSupport.ts";

const sendTestTimeout = 480_000;

describe("one-click unsubscribe", () => {
  const optOut = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.flatMap(HttpClient.HttpClient, (client) => client.execute(request));

  it(
    "honours an opt-out and then skips the next campaign to that address",
    {
      timeout: sendTestTimeout,
    },
    () =>
      live(
        Effect.gen(function* () {
          const settings = yield* configuration;
          const unsubscribe = yield* unsubscribeSettings;
          const client = yield* makeEmailerClient(settings.apiUrl, settings.token);
          const storage = yield* liveStorage(settings.tableName);
          const quota = yield* accountSendQuota;
          const timeout = campaignStateTimeout(1, quota?.MaxSendRate);
          const runId = yield* newIdentifier;
          const address = simulator("success", runId);
          const contactId = yield* contactFor(storage, address);
          const list = yield* client.lists.create({ payload: { name: `unsub-${runId}` } });

          yield* client.lists.addContact({ params: { listId: list.id, contactId } });

          const campaign = yield* client.campaigns.create({
            payload: {
              listId: list.id,
              subject: `Emailer unsubscribe ${runId}`,
              text: "This message carries the one-click unsubscribe headers and footer.",
            },
          });

          const sent = yield* sendToSimulatorList(client, list.id, campaign.id);

          // The API re-reads after enqueue, so a fast dispatcher can already have moved a
          // one-member campaign to sending or completed.
          expect(["queued", "sending", "completed"]).toContain(sent.submission.state);

          yield* awaitCampaignState(client, campaign.id, "completed", timeout);

          // The token names the mailbox, not the contact — ADR-0007. Minting from `contact.id` here
          // would build a link for a token payload that is not an address at all.
          const link = `${unsubscribe.baseUrl}/unsubscribe/${mintToken(unsubscribe.signingKey, address)}`;

          const offered = yield* optOut(HttpClientRequest.get(link));

          expect(offered.status).toBe(200);
          expect(yield* storage.addressStatus(address)).toBe("mailable");

          const honoured = yield* optOut(HttpClientRequest.post(link));

          expect(honoured.status).toBe(200);
          expect(yield* awaitAddressStatus(storage, address, "unsubscribed")).toBe("unsubscribed");

          const repeated = yield* optOut(HttpClientRequest.post(link));

          expect(repeated.status).toBe(200);

          // Moving the contact to another mailbox would escape the opt-out, so it is refused.
          const moved = yield* Effect.result(
            client.contacts.update({
              params: { id: contactId },
              payload: { email: "elsewhere@example.invalid" },
            }),
          );

          expect(Result.isFailure(moved) && moved.failure).toStrictEqual(
            new Errors.AddressOptedOut({ email: address }),
          );

          const second = yield* client.campaigns.create({
            payload: {
              listId: list.id,
              subject: `Emailer unsubscribe skipped ${runId}`,
              text: "This recipient must be skipped.",
            },
          });

          const resent = yield* sendToSimulatorList(client, list.id, second.id);

          expect(submitted.includes(resent.submission.state)).toBe(true);

          const skipped = yield* awaitCampaignState(client, second.id, "completed", timeout);

          expect(skipped.submission).toMatchObject({
            state: "completed",
            progress: { accepted: 0, rejected: 0, uncertain: 0, skipped: 1 },
          });

          const rows = yield* sendRows(second.id);

          expect(rows).toHaveLength(1);
          expect(rows[0]?.state).toBe("skipped");

          yield* Effect.logInfo("unsubscribe honoured", {
            campaignId: campaign.id,
            skippedCampaignId: second.id,
          });
        }),
      ),
  );

  it("refuses a forged token without opting anybody out", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const unsubscribe = yield* unsubscribeSettings;
        const storage = yield* liveStorage(settings.tableName);
        const address = yield* uniqueAddress;

        const forged = mintToken(Redacted.make("not the deployed key"), yield* newIdentifier);

        const refused = yield* optOut(
          HttpClientRequest.post(`${unsubscribe.baseUrl}/unsubscribe/${forged}`),
        );

        expect(refused.status).toBe(404);
        expect(yield* storage.addressStatus(address)).toBe("mailable");
      }),
    ));

  /**
   * The property ADR-0007 exists for, against real persistence. The link names the mailbox, so
   * editing the contact, deleting it, or re-importing it must not move the opt-out or break the
   * link — and the consent must outlive every one of them.
   */
  it("keeps naming the same mailbox when the contact is edited, deleted and re-imported", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const unsubscribe = yield* unsubscribeSettings;
        const storage = yield* liveStorage(settings.tableName);

        const original = yield* uniqueAddress;
        const moved = yield* uniqueAddress;

        const contactId = yield* contactFor(storage, original);
        const token = mintToken(unsubscribe.signingKey, original);
        const link = `${unsubscribe.baseUrl}/unsubscribe/${token}`;

        // Edited to another address *before* the link is used. A link that resolved a contact
        // would now opt out the new address; this one still names the old one.
        expect((yield* storage.updateContact(contactId, { email: moved })).email).toBe(moved);

        expect((yield* optOut(HttpClientRequest.post(link))).status).toBe(200);

        expect(yield* storage.addressStatus(original)).toBe("unsubscribed");
        expect(yield* storage.addressStatus(moved)).toBe("mailable");

        // Deleting the contact removes neither the consent nor the link's meaning.
        yield* storage.deleteContact(contactId);
        expect(yield* storage.addressStatus(original)).toBe("unsubscribed");
        expect((yield* optOut(HttpClientRequest.post(link))).status).toBe(200);

        // Re-imported at the original address: the consent is still there, because it was never
        // the contact's to carry.
        const reimported = yield* contactFor(storage, original);

        expect(yield* storage.addressStatus(original)).toBe("unsubscribed");
        expect(reimported).not.toBe(contactId);
      }),
    ));

  // ADR-0006's policy, against the real conditional transaction rather than a recording double.
  it("refuses to move an opted-out contact to another address", () =>
    live(
      Effect.gen(function* () {
        const settings = yield* configuration;
        const unsubscribe = yield* unsubscribeSettings;
        const storage = yield* liveStorage(settings.tableName);

        const address = yield* uniqueAddress;
        const elsewhere = yield* uniqueAddress;
        const contactId = yield* contactFor(storage, address);

        const link = `${unsubscribe.baseUrl}/unsubscribe/${mintToken(unsubscribe.signingKey, address)}`;

        expect((yield* optOut(HttpClientRequest.post(link))).status).toBe(200);

        expect(
          yield* Effect.flip(storage.updateContact(contactId, { email: elsewhere })),
        ).toStrictEqual(new Errors.AddressOptedOut({ email: address }));
        expect(yield* storage.addressStatus(elsewhere)).toBe("mailable");
      }),
    ));
});
