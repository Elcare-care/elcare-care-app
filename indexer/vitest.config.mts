import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Unit tests only — integration tests run via vitest.integration.config.mts
    include: ["src/__tests__/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "src/__tests__/integration/**",
    ],
    deps: {
      optimizer: {
        ssr: {
          exclude: ["prom-client"],
        },
      },
    },
  },
});
