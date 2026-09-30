import { Page } from '@playwright/test';

/** Mirrors E2eFailureMode in src/lib/e2e-chain-mock.ts. */
export type E2eFailureMode =
  | 'none'
  | 'wallet_rejection'
  | 'simulation_failure'
  | 'insufficient_balance'
  | 'submission_timeout'
  | 'chain_failure';

/**
 * Forces the next mock-chain write (e.g. buy_artwork) to fail in a specific,
 * deterministic way. Registered on window by E2eMockChainInit on first paint
 * (NEXT_PUBLIC_E2E_MOCK_CHAIN=true), so callers must navigate first.
 */
export async function setE2eFailureMode(page: Page, mode: E2eFailureMode) {
  await page.waitForFunction(
    () => typeof (window as unknown as { __E2E_SET_FAILURE_MODE__?: unknown }).__E2E_SET_FAILURE_MODE__ === 'function'
  );
  await page.evaluate((m) => {
    (window as unknown as { __E2E_SET_FAILURE_MODE__: (mode: string) => void }).__E2E_SET_FAILURE_MODE__(m);
  }, mode);
}
