import type { KnipConfig } from "knip";

export default {
  workspaces: {
    ".": {
      // Stack files the Alchemy CLI loads; nothing imports them, so knip cannot find them.
      entry: ["alchemy.run.ts", "stacks/*.ts"],
      // Vendored from dmmulroy/anti-slop and kept as upstream ships it.
      ignore: ["tools/oxlint/anti-slop/**"],
      // The tsconfig plugin name @effect/tsgo reads, not a package.
      ignoreDependencies: ["@effect/language-service"],
    },
    "apps/backend": {
      // One-off operator scripts run with node; nothing imports them.
      entry: ["scripts/*.ts"],
    },
    "packages/api": {
      // Its `./*` exports map makes every file an entry; only this repository imports the package,
      // so an export nothing here imports is dead rather than public.
      includeEntryExports: true,
    },
  },
} satisfies KnipConfig;
