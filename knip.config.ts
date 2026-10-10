import type { KnipConfig } from "knip";

export default {
  // The machine's headroom queue the heavy scripts wait in (ADR-0035), installed outside the repository.
  ignoreBinaries: ["agents"],
  workspaces: {
    ".": {
      // Stack files the Alchemy CLI loads; nothing imports them, so knip cannot find them.
      entry: ["alchemy.run.ts", "stacks/sending-identity.ts"],
      // Vendored from dmmulroy/anti-slop and kept as upstream ships it.
      ignore: ["tools/oxlint/anti-slop/**"],
      // The tsconfig plugin name @effect/tsgo reads, not a package.
      ignoreDependencies: ["@effect/language-service"],
    },
    "packages/api": {
      // Its `./*` exports map makes every file an entry; only this repository imports the package,
      // so an export nothing here imports is dead rather than public.
      includeEntryExports: true,
    },
  },
} satisfies KnipConfig;
