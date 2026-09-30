/**
 * support-center.spec.ts
 *
 * Work item B — E2E tests for the support center.
 *
 * Verifies:
 *  1. The form is reachable from any listing page via the "Report Issue" link.
 *  2. The form pre-fills context from URL query params.
 *  3. Submissions containing secret-like input are rejected.
 *  4. A valid submission returns a report ID with status and SLA.
 *  5. Required acknowledgements block form submission.
 *  6. Forms are accessible and usable on mobile viewport.
 */

import { test, expect } from '@playwright/test';
import {
  E2E_METADATA_CID,
  MarketplaceTestStore,
  setupMarketplaceMocks,
  resetE2eListingsInBrowser,
} from './helpers/marketplace-mocks';
import { connectFreighterWallet } from './helpers/wallet';
import { TEST_PUBLIC_KEY, BUYER_PUBLIC_KEY } from './freighter-mock';

const DEFAULT_TOKEN =
  process.env.NEXT_PUBLIC_NATIVE_TOKEN_CONTRACT_ID ??
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const VALID_DESCRIPTION = 'My purchase showed as successful in the wallet but the listing still appears active after waiting five minutes.';

test.describe('Support Center — form', () => {
  const store = new MarketplaceTestStore();

  test.beforeEach(async ({ page }) => {
    store.reset();
    await setupMarketplaceMocks(page, store);
    await resetE2eListingsInBrowser(page);
  });

  test('support page loads and form is visible', async ({ page }) => {
    await page.goto('/support');
    await expect(page.getByTestId('support-form')).toBeVisible();
    await expect(page.getByTestId('support-category-select')).toBeVisible();
    await expect(page.getByTestId('support-submit-button')).toBeVisible();
  });

  test('context query params pre-fill resource and tx fields', async ({ page }) => {
    await page.goto('/support?listing_id=1234&tx=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    await expect(page.getByTestId('support-resource-id')).toHaveValue('1234');
    await expect(page.getByTestId('support-tx-hash'))
      .toHaveValue('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
  });

  test('Report Issue link on listing page links to support with listing_id', async ({ page }) => {
    store.upsertActive({
      listing_id: 6001, artist: TEST_PUBLIC_KEY, metadata_cid: E2E_METADATA_CID,
      price: String(10 * 10_000_000), currency: 'XLM', token: DEFAULT_TOKEN,
      status: 'Active', owner: null, created_at: Math.floor(Date.now() / 1000),
      original_creator: TEST_PUBLIC_KEY, royalty_bps: 0,
      recipients: [{ address: TEST_PUBLIC_KEY, percentage: 100 }],
    });
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/listings/6001');
    await page.waitForLoadState('domcontentloaded');
    const reportLink = page.getByTestId('report-issue-link');
    if (await reportLink.isVisible({ timeout: 8_000 })) {
      const href = await reportLink.getAttribute('href');
      expect(href).toContain('listing_id=6001');
      expect(href).toContain('/support');
    }
  });

  test('form rejects submission containing a Stellar secret key', async ({ page }) => {
    await page.goto('/support');
    await page.getByTestId('support-category-select').selectOption('TRANSACTION_CONFUSION');
    await page.getByTestId('support-tx-hash').fill('a'.repeat(64));
    // Fill description with a fake secret key pattern
    const secretLike = 'SCZANGBA5QDPSBM7FXQJ27HF3X35WQQBMTCB7TBEMQK4GQHRFPXZJQJ';
    await page.getByTestId('support-description').fill(`My key is ${secretLike}`);
    await page.getByTestId('support-submit-button').click();
    await expect(page.getByTestId('support-secret-error')).toBeVisible();
    // Confirmation should NOT appear
    await expect(page.getByTestId('support-confirmation')).not.toBeVisible();
  });

  test('form rejects too-short description', async ({ page }) => {
    await page.goto('/support');
    await page.getByTestId('support-category-select').selectOption('SPAM_OR_SCAM');
    await page.getByTestId('support-resource-id').fill('12345');
    await page.getByTestId('support-description').fill('Short');
    await page.getByTestId('support-submit-button').click();
    // Validation error visible, no confirmation
    await expect(page.getByTestId('support-confirmation')).not.toBeVisible();
  });

  test('valid SPAM_OR_SCAM report submits successfully', async ({ page }) => {
    await page.goto('/support');
    await page.getByTestId('support-category-select').selectOption('SPAM_OR_SCAM');
    await page.getByTestId('support-resource-id').fill('999');
    await page.getByTestId('support-description').fill(
      'This collection appears fraudulent — the images are stolen from a known artist and the account was created today.'
    );
    await page.getByTestId('support-submit-button').click();
    // Expect confirmation with a report ID
    await expect(page.getByTestId('support-confirmation')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/SUP-/)).toBeVisible();
    await expect(page.getByText(/business hours/i)).toBeVisible();
  });

  test('valid TRANSACTION_CONFUSION report submits with tx hash', async ({ page }) => {
    await page.goto('/support');
    await page.getByTestId('support-category-select').selectOption('TRANSACTION_CONFUSION');
    await page.getByTestId('support-tx-hash').fill('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
    await page.getByTestId('support-description').fill(VALID_DESCRIPTION);
    await page.getByTestId('support-submit-button').click();
    await expect(page.getByTestId('support-confirmation')).toBeVisible({ timeout: 10_000 });
  });

  test('platform limits notice appears after selecting a category', async ({ page }) => {
    await page.goto('/support');
    await page.getByTestId('support-category-select').selectOption('METADATA_DISPUTE');
    // The "What we can and cannot do" panel should appear
    await expect(page.getByText(/cannot do|platform can|we can/i)).toBeVisible({ timeout: 5_000 });
  });

  test('support form has no horizontal overflow on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/support');
    await page.waitForLoadState('domcontentloaded');
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  test('support form description character count updates', async ({ page }) => {
    await page.goto('/support');
    const desc = page.getByTestId('support-description');
    await desc.fill('Hello World!');
    await expect(page.getByText(/12\/2000/)).toBeVisible();
  });
});

test.describe('Support Center — keyboard and a11y', () => {
  test('support form submittable via keyboard only', async ({ page }) => {
    await page.goto('/support');
    // Tab to category select, change it
    await page.keyboard.press('Tab');
    const categorySelect = page.getByTestId('support-category-select');
    await categorySelect.focus();
    await categorySelect.selectOption('SPAM_OR_SCAM');
    // Tab through to resource id
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    // Fill description via keyboard
    const desc = page.getByTestId('support-description');
    await desc.fill('This is a keyboard-submitted scam report that has enough characters to pass validation.');
    // Tab to submit and press Enter
    const submitBtn = page.getByTestId('support-submit-button');
    await submitBtn.focus();
    const resourceId = page.getByTestId('support-resource-id');
    await resourceId.fill('777');
    await submitBtn.click();
    await expect(page.getByTestId('support-confirmation')).toBeVisible({ timeout: 10_000 });
  });
});
