// ─────────────────────────────────────────────────────────────
// tests/e2e/visual-regression.spec.ts
//
// Frontend visual regression coverage.
//
// Strategy
// ────────
// Playwright's `toHaveScreenshot()` compares each page against a
// committed baseline PNG under tests/e2e/snapshots/ (configured via
// `snapshotDir` in playwright.config.ts). Baselines are reviewed in
// PR diffs, so any unintended visual change is caught in review and
// intentional changes update the baseline in the same PR.
//
// Determinism rules (all enforced below):
//   1. Data is mocked — marketplace-mocks serves fixed listings so
//      page content never depends on live indexer state.
//   2. Images use a deterministic placeholder — remote IPFS/Unsplash
//      images are blocked and replaced by an inline SVG data URI so
//      screenshots never depend on network image bytes.
//   3. Animations are disabled (`animations: 'disabled'`) and caret
//      is hidden (`caret: 'hide'`) to remove frame timing flake.
//   4. Fonts are pinned per-platform via maxDiffPixelRatio tolerance
//      plus platform-suffixed snapshot names (chromium-linux etc.)
//      because antialiasing differs across OSes.
//
// Updating baselines after an intentional UI change:
//   npm run test:visual:update     (local)
//   npx playwright test tests/e2e/visual-regression.spec.ts --update-snapshots
// ─────────────────────────────────────────────────────────────

import { test, expect, Page } from '@playwright/test';
import { setupMarketplaceMocks, MarketplaceTestStore, E2eIndexerListing } from './helpers/marketplace-mocks';

// ── Deterministic placeholder image ────────────────────────────
// Inline SVG data URI: identical bytes on every machine/network.
const PLACEHOLDER_IMAGE =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">` +
      `<rect width="400" height="400" fill="#e8ddd0"/>` +
      `<circle cx="200" cy="170" r="70" fill="#c9a86a"/>` +
      `<rect x="60" y="270" width="280" height="14" rx="7" fill="#8a6f4d"/>` +
      `<rect x="100" y="300" width="200" height="10" rx="5" fill="#b09a78"/>` +
      `</svg>`
  ).toString('base64');

/** Fixed clock anchor: every dynamic timestamp renders identically. */
const FROZEN_NOW = new Date('2026-01-15T12:00:00Z').getTime();

function makeListing(overrides: Partial<E2eIndexerListing> = {}): E2eIndexerListing {
  return {
    listing_id: 1,
    artist: 'GALACTICPIONEERARTISTXXXXXXXXXXXXXXXXXXXXXXX',
    metadata_cid: 'QmVisualRegressionMetadataCid',
    price: '250000000', // 25 XLM in stroops
    currency: 'XLM',
    token: 'CE2ECOLLECTIONPLACEHOLDER00000000000000001',
    status: 'Active',
    owner: null,
    created_at: Math.floor(FROZEN_NOW / 1000),
    original_creator: 'GALACTICPIONEERARTISTXXXXXXXXXXXXXXXXXXXXXXX',
    royalty_bps: 500,
    recipients: [{ address: 'GALACTICPIONEERARTISTXXXXXXXXXXXXXXXXXXXXXXX', percentage: 100 }],
    ...overrides,
  };
}

/**
 * Prepares a page for pixel-stable capture:
 *  - mocks indexer data with the provided store contents,
 *  - blocks all remote images and swaps in the deterministic SVG,
 *  - freezes Date.now() so relative timestamps ("2h ago") are stable,
 *  - disables CSS transitions/animations at the document level.
 */
async function prepareStablePage(
  page: Page,
  store: MarketplaceTestStore,
  path: string
) {
  await setupMarketplaceMocks(page, store);

  // Replace every remote image request with the deterministic placeholder.
  await page.route(/^https?:\/\/(?!localhost)/, async (route) => {
    const type = route.request().resourceType();
    if (type === 'image') {
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: Buffer.from(PLACEHOLDER_IMAGE.split(',')[1], 'base64'),
      });
      return;
    }
    await route.abort();
  });

  await page.goto(path, { waitUntil: 'networkidle' });

  // Freeze time + kill animations before any paint-dependent assertion.
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }`,
  });
  await page.evaluate((frozen) => {
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof DateConstructor>) {
        if (args.length === 0) {
          super(frozen);
        } else {
          super(...args);
        }
      }
      static now() {
        return frozen;
      }
    }
    window.Date = FrozenDate as unknown as DateConstructor;
  }, FROZEN_NOW);
}

/** Shared screenshot options — one place to tune tolerances. */
const screenshotOpts = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  maxDiffPixelRatio: 0.02, // tolerate minor font antialiasing across platforms
};

test.describe('Visual regression — public pages', () => {
  let store: MarketplaceTestStore;

  test.beforeEach(async () => {
    store = new MarketplaceTestStore();
    store.upsertActive(makeListing());
    store.upsertActive(makeListing({ listing_id: 2, price: '50000000' }));
    store.upsertActive(makeListing({ listing_id: 3, price: '120000000' }));
  });

  test('homepage hero matches baseline', async ({ page }) => {
    await prepareStablePage(page, store, '/');
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page).toHaveScreenshot('homepage-hero.png', screenshotOpts);
  });

  test('explore grid matches baseline', async ({ page }) => {
    await prepareStablePage(page, store, '/explore');
    await expect(page.locator('[data-testid="explore-page"]')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveScreenshot('explore-grid.png', screenshotOpts);
  });

  test('auctions page matches baseline', async ({ page }) => {
    await prepareStablePage(page, store, '/auctions');
    await expect(page.locator('h1')).toContainText('Auctions');
    await expect(page).toHaveScreenshot('auctions.png', screenshotOpts);
  });

  test('launchpad page matches baseline', async ({ page }) => {
    await prepareStablePage(page, store, '/launchpad');
    await expect(page.locator('h1')).toContainText('Launchpad');
    await expect(page).toHaveScreenshot('launchpad.png', screenshotOpts);
  });

  test('activity feed matches baseline', async ({ page }) => {
    await prepareStablePage(page, store, '/activity');
    await expect(page.locator('h1')).toContainText('Activity');
    await expect(page).toHaveScreenshot('activity.png', screenshotOpts);
  });
});

test.describe('Visual regression — responsive layouts', () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14-ish

  test.beforeEach(async () => {
    store = new MarketplaceTestStore();
    store.upsertActive(makeListing());
  });

  test('mobile homepage matches baseline', async ({ page }) => {
    await prepareStablePage(page, store, '/');
    await expect(page.locator('nav[aria-label="Primary navigation"]')).toBeVisible();
    await expect(page).toHaveScreenshot('homepage-mobile.png', screenshotOpts);
  });

  test('mobile explore matches baseline', async ({ page }) => {
    await prepareStablePage(page, store, '/explore');
    await expect(page.locator('[data-testid="explore-page"]')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveScreenshot('explore-mobile.png', screenshotOpts);
  });
});

test.describe('Visual regression — wallet-gated states', () => {
  test.beforeEach(async () => {
    store = new MarketplaceTestStore();
  });

  test('dashboard wallet-required state matches baseline', async ({ page }) => {
    await prepareStablePage(page, store, '/dashboard');
    await expect(page.getByText(/wallet connection required/i)).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveScreenshot('dashboard-wallet-required.png', screenshotOpts);
  });
});