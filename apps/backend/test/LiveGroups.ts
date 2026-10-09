/**
 * The live suite's groups, one per suite module, as Vitest tags: `pnpm gate` runs only the groups
 * a change reaches (ADR-0033).
 */
export const liveGroups = [
  "api",
  "cancellation",
  "drafting",
  "variants",
  "unsubscribe",
  "subscriptions",
  "feedback",
] as const;

export type LiveGroup = (typeof liveGroups)[number];

declare module "vitest" {
  interface TestTags {
    tags: LiveGroup;
  }
}
