import { describe, expect, it } from "@effect/vitest";

import { liveGroups } from "../../apps/backend/test/LiveGroups.ts";
import { reach, selected } from "./LiveReach.ts";

describe("reach", () => {
  it.each([
    "README.md",
    "AGENTS.md",
    ".adr/0033-landing-gate-scoped-to-the-change.md",
    "LICENSE",
    "flakes.md",
    ".gitattributes",
    "apps/backend/test/README.md",
    "apps/backend/src/sending/Mailer.test.ts",
    "packages/api/src/Schemas.test.ts",
    "tools/stages/TestStage.test.ts",
    "apps/backend/src/storage/Testing.ts",
    "apps/cli/src/commands/Campaigns.ts",
    "stacks/sending-identity.ts",
    "apps/backend/src/identity/SendingDns.ts",
    "tools/stages/main.ts",
    "tools/gate/LiveReach.ts",
    "oxlint.config.ts",
  ])("%s reaches no group", (path) => {
    expect(reach(path)).toStrictEqual([]);
  });

  it.each([
    "alchemy.run.ts",
    "apps/backend/test/Live.integration.test.ts",
    "apps/backend/test/IntegrationSupport.ts",
    "apps/backend/test/LiveGroups.ts",
    "tools/stages/TestStage.ts",
    "vitest.config.ts",
    "tsconfig.base.json",
    "package.json",
    "apps/cli/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "packages/api/src/Schemas.ts",
    "apps/backend/src/api/Api.ts",
    "apps/backend/src/consent/Unsubscribe.ts",
    "apps/backend/src/storage/Feedback.ts",
    "apps/backend/src/identity/SendingIdentity.ts",
    "apps/backend/src/NewModule.ts",
    "somewhere/new.ts",
  ])("%s reaches every group", (path) => {
    expect(reach(path)).toBe("all");
  });

  it.each([
    ["apps/backend/src/api/Api.live.ts", ["api"]],
    ["apps/backend/src/campaigns/CampaignCancellation.live.ts", ["cancellation"]],
    ["apps/backend/src/campaigns/Drafting.live.ts", ["drafting"]],
    ["apps/backend/src/campaigns/Variants.live.ts", ["variants"]],
    ["apps/backend/src/consent/Unsubscribe.live.ts", ["unsubscribe"]],
    ["apps/backend/src/consent/Subscriptions.live.ts", ["subscriptions"]],
    ["apps/backend/src/feedback/Feedback.live.ts", ["feedback"]],
    ["apps/backend/src/campaigns/TestSends.ts", ["drafting"]],
    ["apps/backend/src/campaigns/PreviewPage.ts", ["drafting", "variants"]],
    ["apps/backend/src/consent/UnsubscribePage.ts", ["unsubscribe"]],
    ["apps/backend/src/consent/Subscriptions.ts", ["subscriptions"]],
    ["apps/backend/src/feedback/Feedback.ts", ["api", "drafting", "variants", "feedback"]],
  ])("%s reaches %j", (path, groups) => {
    expect(reach(path)).toStrictEqual(groups);
  });
});

describe("selected", () => {
  it("selects nothing for docs alone", () => {
    expect(selected(["README.md", ".adr/0001-x.md", "apps/cli/src/main.ts"])).toStrictEqual([]);
  });

  it("selects nothing for no change", () => {
    expect(selected([])).toStrictEqual([]);
  });

  it("unions the groups, in suite order", () => {
    expect(
      selected([
        "apps/backend/src/consent/UnsubscribePage.ts",
        "apps/backend/src/campaigns/PreviewPage.ts",
        "README.md",
      ]),
    ).toStrictEqual(["drafting", "variants", "unsubscribe"]);
  });

  it("selects every group when one path reaches all", () => {
    expect(selected(["apps/backend/src/campaigns/TestSends.ts", "pnpm-lock.yaml"])).toStrictEqual(
      liveGroups,
    );
  });
});
