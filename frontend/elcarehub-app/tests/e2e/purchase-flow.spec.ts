import { test, expect } from '@playwright/test';
import { BUYER_PUBLIC_KEY, TEST_PUBLIC_KEY } from './freighter-mock';
import {
  E2E_METADATA_CID,
  MarketplaceTestStore,
  MOCK_ARTWORK_METADATA,
  setupMarketplaceMocks,
  resetE2eListingsInBrowser,
} from './helpers/marketplace-mocks';
import { connectFreighterWallet } from './helpers/wallet';

const DEFAULT_TOKEN =
  process.env.NEXT_PUBLIC_NATIVE_TOKEN_CONTRACT_ID ??
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

test.describe('Checkout and Purchase Flow', () => {
  const store = new MarketplaceTestStore();

  test.beforeEach(async ({ page }) => {
    store.reset();
    await setupMarketplaceMocks(page, store);
    await resetE2eListingsInBrowser(page);
  });

  test('checkout modal opens and displays listing price', async ({ page }) => {
    store.upsertActive({
      listing_id: 9001,
      artist: TEST_PUBLIC_KEY,
      metadata_cid: E2E_METADATA_CID,
      price: String(25 * 10_000_000),
      currency: 'XLM',
      token: DEFAULT_TOKEN,
      status: 'Active',
      owner: null,
      created_at: Math.floor(Date.now() / 1000),
      original_creator: TEST_PUBLIC_KEY,
      royalty_bps: 0,
      recipients: [{ address: TEST_PUBLIC_KEY, percentage: 100 }],
    });

    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await expect(page.getByText('Explore Artworks')).toBeVisible();
    await expect(page.getByText(MOCK_ARTWORK_METADATA.title)).toBeVisible();
    await expect(page.getByText('25 XLM')).toBeVisible();
  });

  test('crypto checkout simulates buy_artwork transaction', async ({ page }) => {
    store.upsertActive({
      listing_id: 9002,
      artist: TEST_PUBLIC_KEY,
      metadata_cid: E2E_METADATA_CID,
      price: String(10 * 10_000_000),
      currency: 'XLM',
      token: DEFAULT_TOKEN,
      status: 'Active',
      owner: null,
      created_at: Math.floor(Date.now() / 1000),
      original_creator: TEST_PUBLIC_KEY,
      royalty_bps: 0,
      recipients: [{ address: TEST_PUBLIC_KEY, percentage: 100 }],
    });

    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await page.getByRole('button', { name: /buy now/i }).first().click();
    await expect(page.getByText('Checkout')).toBeVisible();
    await page.getByRole('button', { name: /pay 10 xlm/i }).click();
    await expect(page.getByText('Checkout')).toBeHidden({ timeout: 15_000 });

    store.markSold(9002, BUYER_PUBLIC_KEY);
    await page.reload();
    await expect(page.getByRole('button', { name: /buy now/i })).toHaveCount(0);
  });

  test('checkout modal payment method selection works', async ({ page }) => {
    store.upsertActive({
      listing_id: 9003,
      artist: TEST_PUBLIC_KEY,
      metadata_cid: E2E_METADATA_CID,
      price: String(10 * 10_000_000),
      currency: 'XLM',
      token: DEFAULT_TOKEN,
      status: 'Active',
      owner: null,
      created_at: Math.floor(Date.now() / 1000),
      original_creator: TEST_PUBLIC_KEY,
      royalty_bps: 0,
      recipients: [{ address: TEST_PUBLIC_KEY, percentage: 100 }],
    });

    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await page.getByRole('button', { name: /buy now/i }).first().click();
    await expect(page.getByText('Checkout')).toBeVisible();
    await expect(page.getByText('Crypto')).toBeVisible();
    await expect(page.getByText('Credit Card')).toBeVisible();
    await page.getByText('Credit Card').click();
    await expect(page.getByText(/fiat purchase/i)).toBeVisible();
  });
});
