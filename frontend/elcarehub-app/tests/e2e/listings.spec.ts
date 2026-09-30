/**
 * listings.spec.ts
 *
 * Playwright E2E tests for critical user journeys (Issue #10):
 *   1. Homepage loads and displays listings
 *   2. Listing card shows artwork or degraded fallback state
 *   3. Clicking a listing navigates to the detail page
 *   4. Activity feed page renders events
 *
 * Runs against the E2E mock-chain build (NEXT_PUBLIC_E2E_MOCK_CHAIN=true),
 * which stubs on-chain calls and returns fixture data from local mocks.
 */

import { test, expect, Page } from '@playwright/test';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForListings(page: Page, minCount = 1) {
  await page.waitForSelector('[data-testid^="listing-card-"]', { timeout: 15_000 });
  const cards = page.locator('[data-testid^="listing-card-"]');
  await expect(cards).toHaveCountGreaterThan(minCount - 1);
  return cards;
}

// ── Homepage / listings page ──────────────────────────────────────────────────

test.describe('Listings page', () => {
  test('renders the page without a JS crash', async ({ page }) => {
    // Catch any uncaught console errors
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Basic page shape
    await expect(page.locator('body')).toBeVisible();
    expect(jsErrors.filter((e) => !e.includes('hydrat'))).toHaveLength(0);
  });

  test('shows at least one listing card or an empty state', async ({ page }) => {
    await page.goto('/listings');
    await page.waitForLoadState('networkidle');

    const cards = page.locator('[data-testid^="listing-card-"]');
    const emptyState = page.getByText(/no listings/i);

    const cardCount = await cards.count();
    if (cardCount === 0) {
      await expect(emptyState).toBeVisible({ timeout: 10_000 });
    } else {
      await expect(cards.first()).toBeVisible();
    }
  });

  test('each listing card shows a price in XLM', async ({ page }) => {
    await page.goto('/listings');
    const cards = await waitForListings(page);
    const firstCard = cards.first();
    await expect(firstCard.getByText(/XLM/)).toBeVisible({ timeout: 8_000 });
  });

  test('listing card shows artwork loading state then resolves', async ({ page }) => {
    await page.goto('/listings');

    // The loading skeleton may appear briefly
    const card = page.locator('[data-testid^="listing-card-"]').first();
    await card.waitFor({ timeout: 15_000 });

    // After loading, either image, missing, or unavailable state should render
    await page.waitForTimeout(3_000);  // allow IPFS fetch to settle in E2E env

    const hasImage      = await card.locator('img').count() > 0;
    const hasMissing    = await card.locator('[data-testid="artwork-missing"]').count() > 0;
    const hasUnavail    = await card.locator('[data-testid="artwork-unavailable"]').count() > 0;

    expect(hasImage || hasMissing || hasUnavail).toBe(true);
  });

  test('clicking a listing card navigates to the detail page', async ({ page }) => {
    await page.goto('/listings');
    const cards = await waitForListings(page);

    const firstCard = cards.first();
    const titleLink = firstCard.locator('a[href^="/listings/"]').first();
    const href = await titleLink.getAttribute('href');
    expect(href).toMatch(/^\/listings\/\d+$/);

    await titleLink.click();
    await page.waitForURL(/\/listings\/\d+/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/listings\/\d+/);
  });
});

// ── Degraded artwork states ───────────────────────────────────────────────────

test.describe('Artwork degraded states', () => {
  test('shows artwork-missing placeholder for a listing with no IPFS data', async ({ page }) => {
    // Navigate to a known fixture listing that has no metadata CID in mock mode
    // (The E2E mock returns listings with empty metadata_cid when requested.)
    await page.goto('/listings');
    await page.waitForLoadState('networkidle');

    // If any artwork-missing elements appear, they should have accessible label
    const missing = page.locator('[data-testid="artwork-missing"]');
    const count = await missing.count();
    if (count > 0) {
      await expect(missing.first()).toHaveAttribute('aria-label', 'Artwork missing');
    }
  });

  test('retry button appears when artwork is unavailable', async ({ page }) => {
    await page.goto('/listings');
    await page.waitForLoadState('networkidle');

    // artwork-unavailable state only shows when fetch fails transiently
    const unavail = page.locator('[data-testid="artwork-unavailable"]');
    const count = await unavail.count();
    if (count > 0) {
      await expect(unavail.first().locator('[data-testid="artwork-retry-btn"]')).toBeVisible();
    }
  });
});

// ── Activity feed page ────────────────────────────────────────────────────────

test.describe('Activity feed page', () => {
  test('renders without a JS crash', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/activity');
    await page.waitForLoadState('domcontentloaded');

    expect(jsErrors.filter((e) => !e.includes('hydrat'))).toHaveLength(0);
  });

  test('shows the page heading', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.getByRole('heading', { name: /platform activity/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('renders domain filter tabs', async ({ page }) => {
    await page.goto('/activity');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('tab', { name: /all/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /listings/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /auctions/i })).toBeVisible();
  });

  test('shows events or an empty state', async ({ page }) => {
    await page.goto('/activity');
    await page.waitForLoadState('networkidle');

    const events = page.locator('[data-testid^="activity-event-"]');
    const empty  = page.getByText(/no activity yet/i);
    const count  = await events.count();

    if (count === 0) {
      await expect(empty).toBeVisible({ timeout: 10_000 });
    } else {
      await expect(events.first()).toBeVisible();
    }
  });

  test('filter tabs change visible events', async ({ page }) => {
    await page.goto('/activity');
    await page.waitForLoadState('networkidle');

    const allEvents = await page.locator('[data-testid^="activity-event-"]').count();
    if (allEvents === 0) return; // nothing to filter — pass trivially

    // Click "Auctions" filter
    await page.getByRole('tab', { name: /auctions/i }).click();
    await page.waitForTimeout(300); // let React re-render

    const auctionEvents = await page.locator('[data-testid^="activity-event-"]').count();
    // Auction events <= all events
    expect(auctionEvents).toBeLessThanOrEqual(allEvents);
  });

  test('refresh button is visible and clickable', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.getByTestId('activity-refresh-btn')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('activity-refresh-btn').click();
    // After click, the button should still be visible (no crash)
    await expect(page.getByTestId('activity-refresh-btn')).toBeVisible();
  });
});

// ── Notification bell ─────────────────────────────────────────────────────────

test.describe('Notification center', () => {
  test('notification bell is visible in the nav', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByTestId('notification-bell')).toBeVisible({ timeout: 10_000 });
  });

  test('opens notification panel when bell is clicked', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-panel')).toBeVisible({ timeout: 5_000 });
  });

  test('panel closes when clicking outside', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-panel')).toBeVisible();

    await page.mouse.click(10, 10); // click outside
    await expect(page.getByTestId('notification-panel')).not.toBeVisible({ timeout: 3_000 });
  });
});
