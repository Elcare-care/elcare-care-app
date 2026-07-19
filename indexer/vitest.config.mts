import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/__tests__/**/*.test.ts"],
    // Integration tests need live Postgres/Redis and run via
    // vitest.integration.config.mts in their own CI job.
    exclude: ["**/node_modules/**", "src/__tests__/integration/**"],
  },
});
