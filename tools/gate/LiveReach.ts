/**
 * Which live-suite groups a changed path reaches (ADR-0033). Import reach cannot tell: the live file
 * imports the whole stack, and every group drives it through the API. So each rule names the paths
 * by the contract they serve, the first matching rule wins, and a path no rule names reaches every
 * group.
 */
import { matchesGlob } from "node:path";

import { liveGroups } from "../../apps/backend/test/LiveGroups.ts";

import type { LiveGroup } from "../../apps/backend/test/LiveGroups.ts";

/** Every group, or the groups named (none for an empty list). */
export type Reach = "all" | ReadonlyArray<LiveGroup>;

const backend = (file: string) => `apps/backend/src/${file}`;

const rules: ReadonlyArray<readonly [Reach, ReadonlyArray<string>]> = [
  // Docs, wherever they sit.
  [[], ["**/*.md", ".adr/**", "LICENSE"]],
  // What every run deploys, loads or installs.
  [
    "all",
    [
      "alchemy.run.ts",
      "apps/backend/test/**",
      "tools/stages/TestStage.ts",
      "vitest.config.ts",
      "tsconfig*.json",
      "**/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ],
  ],
  // What only `pnpm check` runs or reads, and what no live run deploys.
  [
    [],
    [
      "**/*.test.ts",
      backend("storage/Testing.ts"),
      "apps/cli/**",
      "stacks/**",
      backend("identity/SendingDns.ts"),
      "tools/**",
      "oxlint.config.ts",
      "knip.config.ts",
      ".oxfmtrc.json",
      ".editorconfig",
      ".gitignore",
      ".env.example",
    ],
  ],
  // Contracts only some groups exercise.
  [["api"], [backend("api/Api.live.ts")]],
  [["cancellation"], [backend("campaigns/CampaignCancellation.live.ts")]],
  [["drafting"], [backend("campaigns/Drafting.live.ts"), backend("campaigns/TestSends.ts")]],
  [["variants"], [backend("campaigns/Variants.live.ts")]],
  [
    ["drafting", "variants"],
    [
      backend("campaigns/Previews.ts"),
      backend("campaigns/PreviewPage.ts"),
      backend("campaigns/Copies.ts"),
    ],
  ],
  [
    ["unsubscribe"],
    [backend("consent/Unsubscribe.live.ts"), backend("consent/UnsubscribePage.ts")],
  ],
  [
    ["subscriptions"],
    [backend("consent/Subscriptions.live.ts"), backend("consent/Subscriptions.ts")],
  ],
  [["feedback"], [backend("feedback/Feedback.live.ts")]],
  [
    ["api", "drafting", "variants", "feedback"],
    [backend("feedback/Feedback.ts"), backend("feedback/FeedbackClassification.ts")],
  ],
];

export const reach = (path: string): Reach =>
  rules.find(([, globs]) => globs.some((glob) => matchesGlob(path, glob)))?.[0] ?? "all";

/** The groups any of `paths` reaches, in suite order. */
export const selected = (paths: ReadonlyArray<string>): ReadonlyArray<LiveGroup> => {
  const reached = paths.map(reach).map((groups) => (groups === "all" ? liveGroups : groups));

  return liveGroups.filter((group) => reached.some((groups) => groups.includes(group)));
};
