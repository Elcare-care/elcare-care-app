import { test, expect } from '@playwright/test';
import { installRealSigner } from './helpers/real-signer';

// ─────────────────────────────────────────────────────────────
// tests/live-e2e/listing-to-purchase.live.spec.ts
//
// Exercises real listing → purchase, auction bidding, and offer flows
// against the disposable-testnet stack from docker-compose.live-e2e.yml,
// using the state seeded by scripts/live-e2e/seed.sh. No mocked chain,
// no mocked indexer — every assertion here can fail for reasons the
// mocked tests/e2e suite structurally cannot: a wrong contract argument
// order, a Soroban event the indexer's parser doesn't recognize,
// indexer replication lag, or a real wallet/network mismatch.
//
// Requires scripts/live-e2e/.env.live-e2e to be sourced into the
// environment before Playwright starts (see scripts/live-e2e/README.md
// and the `test:e2e:live` root npm script).
//
// Tests run serially (see playwright.live.config.ts: fullyParallel=false,
// workers=1) because they act on shared on-chain state seeded once for
// the whole run, and a purchase/bid on one listing must not race a
// concurrent test reading the same indexer rows.
// ─────────────────────────────────────────────────────────────

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Run scripts/live-e2e/setup.sh and source scripts/live-e2e/.env.live-e2e before running this suite.`
    );
  }
  return value;
}

const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
const INDEXER_URL = process.env.LIVE_E2E_INDEXER_URL ?? 'http://localhost:4100';

test.describe('Live integration — listing, auction, offer, collection', () => {
  test('a freshly deployed collection is visible through the real indexer', async ({ page }) => {
    const collectionAddress = requiredEnv('SEED_COLLECTION_ADDRESS');
    const sellerPublicKey = requiredEnv('LIVE_E2E_SELLER_PUBLIC');

    // Poll rather than a single request: the indexer only sees this
    // collection once its poller has processed the deploy ledger, which
    // takes real wall-clock time on testnet (unlike the mocked suite).
    await expect(async () => {
      const res = await page.request.get(`${INDEXER_URL}/collections?creator=${sellerPublicKey}`);
      expect(res.ok()).toBe(true);
      const collections: Array<{ address: string }> = await res.json();
      expect(collections.some((c) => c.address === collectionAddress)).toBe(true);
    }).toPass({ timeout: 60_000, intervals: [2_000] });
  });

  test('buyer can complete a real purchase of the seeded listing', async ({ page }) => {
    const buyerPublicKey = requiredEnv('LIVE_E2E_BUYER_PUBLIC');
    const buyerSecretKey = requiredEnv('LIVE_E2E_BUYER_SECRET');
    const listingId = requiredEnv('SEED_LISTING_ID');

    await installRealSigner(page, {
      publicKey: buyerPublicKey,
      secretKey: buyerSecretKey,
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    await page.goto(`/listings/${listingId}`);
    await expect(page.getByRole('button', { name: /connect wallet/i })).toBeVisible();
    await page.getByRole('button', { name: /connect wallet/i }).click();
    await page.getByRole('button', { name: /freighter/i }).click();

    // Real signature request round-trips through the injected signer and a
    // real Soroban RPC submission — this is materially slower than the
    // mocked suite's instant resolution.
    await expect(page.getByText(buyerPublicKey.slice(0, 6))).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('buy-now-button').first().click();
    await page.getByTestId('checkout-pay-button').click();
    await expect(page.getByTestId('checkout-pay-button')).toBeEnabled({ timeout: 5_000 });
    await page.getByTestId('checkout-pay-button').click();

    await expect(page.getByText(/purchase (successful|complete)/i)).toBeVisible({ timeout: 45_000 });

    // Confirm the indexer's view converged on the same outcome as the
    // chain — this is exactly the kind of indexer-lag / event-parsing gap
    // a mocked test cannot detect.
    await expect(async () => {
      const res = await page.request.get(`${INDEXER_URL}/listings/${listingId}`);
      const body = await res.json();
      expect(body.status).toBe('Sold');
    }).toPass({ timeout: 30_000, intervals: [2_000] });
  });

  test('buyer can place a real bid on the seeded auction', async ({ page }) => {
    const buyerPublicKey = requiredEnv('LIVE_E2E_BUYER_PUBLIC');
    const buyerSecretKey = requiredEnv('LIVE_E2E_BUYER_SECRET');
    const auctionId = requiredEnv('SEED_AUCTION_ID');

    await installRealSigner(page, {
      publicKey: buyerPublicKey,
      secretKey: buyerSecretKey,
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    await page.goto(`/auctions/${auctionId}`);
    await page.getByRole('button', { name: /connect wallet/i }).click();
    await page.getByRole('button', { name: /freighter/i }).click();
    await expect(page.getByText(buyerPublicKey.slice(0, 6))).toBeVisible({ timeout: 30_000 });

    const bidInput = page.getByPlaceholder(/min\./i);
    const minBid = await bidInput.getAttribute('placeholder');
    const amount = minBid?.match(/[\d.]+/)?.[0] ?? '5.0000001';
    await bidInput.fill(amount);
    await page.getByRole('button', { name: /bid/i }).click();

    await expect(page.getByText(/bid placed successfully/i)).toBeVisible({ timeout: 45_000 });

    await expect(async () => {
      const res = await page.request.get(`${INDEXER_URL}/auctions/${auctionId}`);
      const body = await res.json();
      expect(Number(body.highest_bid)).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000, intervals: [2_000] });
  });

  test('buyer can make a real offer on the seeded offer-flow listing', async ({ page }) => {
    const buyerPublicKey = requiredEnv('LIVE_E2E_BUYER_PUBLIC');
    const buyerSecretKey = requiredEnv('LIVE_E2E_BUYER_SECRET');
    const listingId = requiredEnv('SEED_OFFER_LISTING_ID');

    await installRealSigner(page, {
      publicKey: buyerPublicKey,
      secretKey: buyerSecretKey,
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    await page.goto(`/listings/${listingId}`);
    await page.getByRole('button', { name: /connect wallet/i }).click();
    await page.getByRole('button', { name: /freighter/i }).click();
    await expect(page.getByText(buyerPublicKey.slice(0, 6))).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('make-offer-trigger').click();
    await page.getByTestId('offer-amount-input').fill('20');
    await page.getByTestId('offer-submit-btn').click();

    await expect(page.getByTestId('offer-modal-success')).toBeVisible({ timeout: 45_000 });

    await expect(async () => {
      const res = await page.request.get(`${INDEXER_URL}/offers?listing_id=${listingId}`);
      const offers: unknown[] = await res.json();
      expect(offers.length).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000, intervals: [2_000] });
  });
});
