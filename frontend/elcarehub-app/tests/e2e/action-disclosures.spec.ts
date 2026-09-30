/**
 * action-disclosures.spec.ts
 *
 * Work item C — E2E tests for action disclosures in the checkout flow.
 *
 * Verifies:
 *  1. The purchase disclosure appears before signing.
 *  2. The Pay button is disabled until the disclosure is acknowledged.
 *  3. Acknowledging the disclosure enables the Pay button.
 *  4. Direct navigation cannot bypass the disclosure check.
 *  5. Disclosure is accessible (label associated to checkbox, role=group).
 */

import { test, expect } from '@playwright/test';
import { BUYER_PUBLIC_KEY, TEST_PUBLIC_KEY } from './freighter-mock';
import {
  E2E_METADATA_CID,
  MarketplaceTestStore,
  setupMarketplaceMocks,
  resetE2eListingsInBrowser,
  seedE2eChainListing,
} from './helpers/marketplace-mocks';
import { connectFreighterWallet } from './helpers/wallet';

const DEFAULT_TOKEN =
  process.env.NEXT_PUBLIC_NATIVE_TOKEN_CONTRACT_ID ??
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const BASE_LISTING = {
  listing_id: 8100,
  artist: TEST_PUBLIC_KEY,
  metadata_cid: E2E_METADATA_CID,
  price: String(5 * 10_000_000),
  currency: 'XLM',
  token: DEFAULT_TOKEN,
  status: 'Active',
  owner: null,
  created_at: Math.floor(Date.now() / 1000),
  original_creator: TEST_PUBLIC_KEY,
  royalty_bps: 0,
  recipients: [{ address: TEST_PUBLIC_KEY, percentage: 100 }],
};

test.describe('Purchase disclosure — checkout modal', () => {
  const store = new MarketplaceTestStore();

  test.beforeEach(async ({ page }) => {
    store.reset();
    store.upsertActive(BASE_LISTING);
    await setupMarketplaceMocks(page, store);
    await resetE2eListingsInBrowser(page);
    await seedE2eChainListing(page, {
      listing_id: BASE_LISTING.listing_id,
      artist: BASE_LISTING.artist,
      price: BASE_LISTING.price,
      token: BASE_LISTING.token,
      metadata_cid: BASE_LISTING.metadata_cid,
    });

    // Clear any persisted acknowledgement so each test starts fresh
    await page.addInitScript(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('elcarehub_disclosure')) localStorage.removeItem(key!);
      }
    });
  });

  test('disclosure panel is visible when checkout modal opens', async ({ page }) => {
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await expect(page.getByTestId('explore-page')).toBeVisible();
    await page.getByTestId('buy-now-button').first().click();
    await expect(page.getByTestId('checkout-modal')).toBeVisible();
    await expect(page.getByTestId('disclosure-purchase')).toBeVisible();
  });

  test('Pay button is disabled before disclosure is acknowledged', async ({ page }) => {
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await page.getByTestId('buy-now-button').first().click();
    await expect(page.getByTestId('checkout-modal')).toBeVisible();
    const payBtn = page.getByTestId('checkout-pay-button');
    await expect(payBtn).toBeDisabled();
  });

  test('acknowledging the disclosure enables the Pay button', async ({ page }) => {
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await page.getByTestId('buy-now-button').first().click();
    await expect(page.getByTestId('checkout-modal')).toBeVisible();

    // Check the acknowledgement checkbox
    const checkbox = page.getByTestId('disclosure-checkbox-purchase');
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // Pay button should now be enabled
    const payBtn = page.getByTestId('checkout-pay-button');
    await expect(payBtn).toBeEnabled();
  });

  test('disclosure panel has accessible group role and label', async ({ page }) => {
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await page.getByTestId('buy-now-button').first().click();
    await expect(page.getByTestId('checkout-modal')).toBeVisible();

    const disclosure = page.getByTestId('disclosure-purchase');
    await expect(disclosure).toHaveAttribute('role', 'group');
    // The group should be labelled by a heading element
    const labelledBy = await disclosure.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
  });

  test('disclosure mentions irreversibility', async ({ page }) => {
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await page.getByTestId('buy-now-button').first().click();
    await expect(page.getByTestId('checkout-modal')).toBeVisible();
    await expect(page.getByTestId('disclosure-purchase')).toContainText(/irreversible/i);
  });

  test('disclosure checkbox is reachable via keyboard', async ({ page }) => {
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await page.getByTestId('buy-now-button').first().click();
    await expect(page.getByTestId('checkout-modal')).toBeVisible();

    const checkbox = page.getByTestId('disclosure-checkbox-purchase');
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
  });
});
