import { test, expect } from '@playwright/test';
import path from 'path';
import { connectFreighterWallet, openNewListingTab } from './helpers/wallet';
import { MarketplaceTestStore, setupMarketplaceMocks, resetE2eListingsInBrowser } from './helpers/marketplace-mocks';

test.describe('NFT Listing Flow', () => {
  const store = new MarketplaceTestStore();

  test.beforeEach(async ({ page }) => {
    store.reset();
    await setupMarketplaceMocks(page, store);
    await resetE2eListingsInBrowser(page);
    await connectFreighterWallet(page);
  });

  test('listing form renders all required fields', async ({ page }) => {
    await openNewListingTab(page);
    await expect(page.getByText('List Your Artwork')).toBeVisible();
    await expect(page.getByPlaceholder(/serengeti/i)).toBeVisible();
    await expect(page.getByPlaceholder(/name or alias/i)).toBeVisible();
    await expect(page.getByText('Category')).toBeVisible();
    await expect(page.getByText('Price')).toBeVisible();
  });

  test('listing form validates required fields', async ({ page }) => {
    await openNewListingTab(page);
    const submitBtn = page.getByRole('button', { name: /create listing/i });
    await expect(submitBtn).toBeDisabled();
  });

  test('listing form accepts image file selection', async ({ page }) => {
    await openNewListingTab(page);
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByText('Select Your Artwork').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(__dirname, 'fixtures/test-art.png'));
    await expect(page.locator('img[alt="Preview"]')).toBeVisible({ timeout: 5000 });
  });
});
