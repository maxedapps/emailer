import { configDefaults, defineConfig } from "vitest/config";

import { liveGroups } from "./apps/backend/test/LiveGroups.ts";

/** Where `pnpm gate` asks for a JSON report of the run, to rerun its failed tests alone (ADR-0035). */
const gateReport = process.env["GATE_TEST_REPORT"];

export default defineConfig({
  test: {
    // Vitest's default is one worker per core but one: too many on a machine many worktrees share.
    maxWorkers: 4,
    reporters:
      gateReport === undefined
        ? configDefaults.reporters
        : [...configDefaults.reporters, ["json", { outputFile: gateReport }]],
    projects: [
      {
        test: {
          name: "unit",
          include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tools/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "integration",
          // One file, because Alchemy's harness deploys one stage per file; it registers every suite.
          include: ["apps/backend/test/Live.integration.test.ts"],
          tags: liveGroups.map((name) => ({ name })),
          testTimeout: 120_000,
        },
      },
    ],
  },
});
