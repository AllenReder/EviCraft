import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/agent/{src,test}/**/*.{test,spec}.ts",
      "apps/cli/{src,test}/**/*.{test,spec}.ts",
      "packages/benchmark/{src,test}/**/*.{test,spec}.ts",
      "tasks/**/*.test.ts",
      "packages/server-host/test/**/*.test.ts",
      "runtime/sdk/typescript/test/**/*.test.ts",
    ],
    passWithNoTests: true,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: "forks",
  },
});
