import { defineConfig, devices } from '@playwright/test';

// ─────────────────────────────────────────────────────────────
// playwright.live.config.ts — live integration suite
//
// Runs against the real disposable-testnet stack brought up by
// scripts/live-e2e/setup.sh (docker-compose.live-e2e.yml), NOT the
// NEXT_PUBLIC_E2E_MOCK_CHAIN dev server that playwright.config.ts uses.
// Deliberately has no `webServer` block: this suite never starts its own
// server, because the whole point is exercising the real indexer +
// contracts + frontend wiring exactly as deployed, not a dev-mode
// reload of the frontend alone.
//
// Kept as a separate config (separate testDir, separate npm script)
// from the mocked suite so:
//   - `npm run test:e2e` stays fast and hermetic for everyday CI runs.
//   - `npm run test:e2e:live` is opt-in, requires the live stack to be
//     running, and is never accidentally picked up by the default
//     Playwright invocation.
// ─────────────────────────────────────────────────────────────
export default defineConfig({
  testDir: './tests/live-e2e',
  testMatch: /.*\.live\.spec\.ts/,
  fullyParallel: false, // seeded on-chain state (listing/auction/offer ids) is shared across tests
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 90 * 1000, // real ledger close (~5s) + RPC round trips are slower than mocked calls
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: 'playwright-report-live', open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.LIVE_E2E_FRONTEND_URL ?? 'http://localhost:3100',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    headless: true,
  },
  projects: [
    {
      name: 'chromium-live',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
