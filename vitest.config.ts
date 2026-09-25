import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "integration",
          // One file, because Alchemy's harness deploys one stage per file; it registers every suite.
          include: ["apps/backend/test/Live.integration.test.ts"],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
