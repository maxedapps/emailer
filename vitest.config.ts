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
          include: ["apps/**/*.integration.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // One live deployment, one shared account suppression list, labelled simulator addresses, and one
          // case that temporarily disables the dispatcher's event-source mapping. Files running in parallel
          // would be several suites editing the same few contacts and the same function at once,
          // and the failures that produces look like product bugs rather than test interference.
          // Concurrency *within* a file stays available, because some cases are about it.
          fileParallelism: false,
        },
      },
    ],
  },
});
