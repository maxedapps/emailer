import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
          clearMocks: true,
          restoreMocks: true,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["apps/**/*.integration.test.ts", "packages/**/*.integration.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          clearMocks: true,
          restoreMocks: true,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // One live deployment, one shared account suppression list, labelled simulator addresses, and one
          // case that temporarily changes a function's concurrency. Files running in parallel
          // would be several suites editing the same few contacts and the same function at once,
          // and the failures that produces look like product bugs rather than test interference.
          // Concurrency *within* a file stays available, because some cases are about it.
          fileParallelism: false,
        },
      },
    ],
  },
});
