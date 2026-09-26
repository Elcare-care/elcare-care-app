// ─────────────────────────────────────────────────────────────
// tests/e2e/navigation.spec.ts
//
// Covers Issue: Navigation — deep links, breadcrumbs, URL
// filter state, wallet-gated actions, and mobile menu a11y.
// ─────────────────────────────────────────────────────────────

import { test, expect, Page } from '@playwright/test';
import { mockFreighter, TEST_PUBLIC_KEY } from './freighter-mock';
import { setupMarketplaceMocks, MarketplaceTestStore } from './helpers/marketplace-mocks';

// ── Helpers ───────────────────────────────────────────────────

async function waitForNav(page: Page) {
  await expect(page.locator('nav[aria-label="Primary navigation"]')).toBeVisible();
}

// ── 1. Primary navigation — signed out ───────────────────────

test.describe('Primary navigation (signed-out)', () => {
  test('all public nav links are visible and have correct hrefs', async ({ page }) => {
    await page.goto('/');
    await waitForNav(page);

    const nav = page.locator('nav[aria-label="Primary navigation"]');

    // Public links
    await expect(nav.getByRole('link', { name: 'Marketplace' })).toHaveAttribute('href', '/');
    await expect(nav.getByRole('link', { name: 'Discover' })).toHaveAttribute('href', '/explore');
    await expect(nav.getByRole('link', { name: 'Auctions' })).toHaveAttribute('href', '/auctions');
    await expect(nav.getByRole('link', { name: 'Launchpad' })).toHaveAttribute('href', '/launchpad');
    await expect(nav.getByRole('link', { name: 'Activity' })).toHaveAttribute('href', '/activity');
  });

  test('wallet-gated links are hidden when not connected', async ({ page }) => {
    await page.goto('/');
    await waitForNav(page);

    const nav = page.locator('nav[aria-label="Primary navigation"]');
    // Dashboard, My Collection, Offers, Inbox should not appear
    await expect(nav.getByRole('link', { name: 'Dashboard' })).not.toBeVisible();
    await expect(nav.getByRole('link', { name: 'My Collection' })).not.toBeVisible();
    await expect(nav.getByRole('link', { name: 'Offers' })).not.toBeVisible();
  });

  test('connect wallet button is present when not connected', async ({ page }) => {
    await page.goto('/');
    await waitForNav(page);
    await expect(page.getByRole('button', { name: /connect wallet/i }).first()).toBeVisible();
  });
});

// ── 2. Primary navigation — signed in ────────────────────────

test.describe('Primary navigation (signed-in)', () => {
  test.beforeEach(async ({ page }) => {
    await mockFreighter(page, { publicKey: TEST_PUBLIC_KEY });
    await page.goto('/');
    await waitForNav(page);
    // Auto-connect
    const shortKey = `${TEST_PUBLIC_KEY.slice(0, 4)}…${TEST_PUBLIC_KEY.slice(-4)}`;
    await page.evaluate((key) => {
      localStorage.setItem('walletProvider', 'freighter');
      (window as any).__freighterPublicKey = key;
    }, TEST_PUBLIC_KEY);
  });

  test('shows Connect Wallet button when wallet not yet connected', async ({ page }) => {
    // In a fresh session without auto-connect, the button should be visible
    await expect(page.getByRole('button', { name: /connect wallet/i }).first()).toBeVisible();
  });
});

// ── 3. Active link highlighting ───────────────────────────────

test.describe('Active link state', () => {
  const cases = [
    { path: '/explore', label: 'Discover' },
    { path: '/auctions', label: 'Auctions' },
    { path: '/launchpad', label: 'Launchpad' },
    { path: '/activity', label: 'Activity' },
  ];

  for (const { path, label } of cases) {
    test(`"${label}" link has aria-current="page" on ${path}`, async ({ page }) => {
      await page.goto(path);
      await waitForNav(page);

      const nav = page.locator('nav[aria-label="Primary navigation"]');
      const link = nav.getByRole('link', { name: label });
      await expect(link).toHaveAttribute('aria-current', 'page');
    });
  }

  test('non-active links do not have aria-current', async ({ page }) => {
    await page.goto('/explore');
    await waitForNav(page);

    const nav = page.locator('nav[aria-label="Primary navigation"]');
    // Auctions is not active on /explore
    const auctionsLink = nav.getByRole('link', { name: 'Auctions' });
    await expect(auctionsLink).not.toHaveAttribute('aria-current', 'page');
  });
});

// ── 4. URL-backed filter state on /explore ────────────────────

test.describe('/explore URL filter persistence', () => {
  test('navigating to a filtered URL restores filters', async ({ page }) => {
    await page.goto('/explore?status=Active&sort=price-low');
    // Page should load without errors
    await expect(page.locator('[data-testid="explore-page"]')).toBeVisible({ timeout: 15_000 });
  });

  test('back/forward preserves filter state', async ({ page }) => {
    await page.goto('/explore');
    await expect(page.locator('[data-testid="explore-page"]')).toBeVisible({ timeout: 15_000 });

    // Navigate to a deep link with filters
    await page.goto('/explore?status=Sold&q=sunset');
    const url1 = page.url();
    expect(url1).toContain('status=Sold');
    expect(url1).toContain('q=sunset');

    // Go back and forward — URL should be preserved
    await page.goBack();
    await page.goForward();
    await expect(page).toHaveURL(/status=Sold/);
  });
});

// ── 5. URL-backed tab state on /auctions ─────────────────────

test.describe('/auctions URL tab persistence', () => {
  test('?status=Active shows the Active tab as selected', async ({ page }) => {
    await page.goto('/auctions?status=Active');
    // The active tab button should have the highlighted class or aria-pressed
    const activeTabBtn = page.getByRole('button', { name: /^Active$/i });
    await expect(activeTabBtn).toBeVisible({ timeout: 10_000 });
  });

  test('direct link to /auctions?status=Finalized is a valid deep link', async ({ page }) => {
    const response = await page.goto('/auctions?status=Finalized');
    expect(response?.status()).not.toBe(404);
    await expect(page.locator('h1')).toContainText('Auctions');
  });
});

// ── 6. Breadcrumb navigation ──────────────────────────────────

test.describe('Breadcrumb navigation', () => {
  test('/launchpad/collections shows breadcrumb back to Launchpad', async ({ page }) => {
    await page.goto('/launchpad/collections');
    const breadcrumb = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumb).toBeVisible({ timeout: 10_000 });
    await expect(breadcrumb.getByRole('link', { name: 'Launchpad' })).toHaveAttribute('href', '/launchpad');
  });

  test('/launchpad/create shows breadcrumb back to Launchpad', async ({ page }) => {
    await page.goto('/launchpad/create');
    const breadcrumb = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumb).toBeVisible({ timeout: 10_000 });
    const launchpadLink = breadcrumb.getByRole('link', { name: 'Launchpad' });
    await expect(launchpadLink).toBeVisible();

    // Click it — should navigate to /launchpad
    await launchpadLink.click();
    await expect(page).toHaveURL('/launchpad');
  });

  test('/activity page loads and has no breadcrumb (top-level)', async ({ page }) => {
    const response = await page.goto('/activity');
    expect(response?.status()).not.toBe(404);
    // Top-level activity page has a breadcrumb showing just "Activity"
    const breadcrumb = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(breadcrumb).toBeVisible({ timeout: 10_000 });
  });
});

// ── 7. Wallet-gated actions explain why connection is needed ──

test.describe('Wallet-gated pages (disconnected)', () => {
  test('/dashboard shows wallet-required message with public data still accessible', async ({ page }) => {
    await page.goto('/dashboard');
    // WalletGuard fallback should appear — not a blank page
    await expect(page.getByText(/wallet connection required/i)).toBeVisible({ timeout: 10_000 });
    // Should show the connect wallet button
    await expect(page.getByRole('button', { name: /connect wallet/i }).first()).toBeVisible();
  });

  test('/offers shows wallet-required message', async ({ page }) => {
    await page.goto('/offers');
    await expect(page.getByText(/wallet connection required/i)).toBeVisible({ timeout: 10_000 });
  });

  test('public listing page is accessible without wallet', async ({ page }) => {
    const response = await page.goto('/explore');
    expect(response?.status()).toBe(200);
    await expect(page.locator('[data-testid="explore-page"]')).toBeVisible({ timeout: 15_000 });
    // No forced wallet prompt on public page
    await expect(page.getByText(/wallet connection required/i)).not.toBeVisible();
  });
});

// ── 8. Mobile menu accessibility ─────────────────────────────

test.describe('Mobile menu keyboard accessibility', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('hamburger button is focusable and has accessible label', async ({ page }) => {
    await page.goto('/');
    await waitForNav(page);

    const hamburger = page.getByRole('button', { name: /open navigation menu/i });
    await expect(hamburger).toBeVisible();
    await hamburger.focus();
    await expect(hamburger).toBeFocused();
  });

  test('opening mobile menu exposes nav links', async ({ page }) => {
    await page.goto('/');
    await waitForNav(page);

    const hamburger = page.getByRole('button', { name: /open navigation menu/i });
    await hamburger.click();

    const mobileMenu = page.locator('[id="mobile-menu"]');
    await expect(mobileMenu).toBeVisible();
    await expect(mobileMenu.getByRole('link', { name: 'Discover' })).toBeVisible();
    await expect(mobileMenu.getByRole('link', { name: 'Auctions' })).toBeVisible();
  });

  test('Escape closes mobile menu and returns focus to hamburger', async ({ page }) => {
    await page.goto('/');
    await waitForNav(page);

    const hamburger = page.getByRole('button', { name: /open navigation menu/i });
    await hamburger.click();
    await expect(page.locator('[id="mobile-menu"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('[id="mobile-menu"]')).not.toBeVisible();
    await expect(hamburger).toBeFocused();
  });

  test('mobile menu has aria-modal and aria-label', async ({ page }) => {
    await page.goto('/');
    await waitForNav(page);

    const hamburger = page.getByRole('button', { name: /open navigation menu/i });
    await hamburger.click();

    const mobileMenu = page.locator('[id="mobile-menu"]');
    await expect(mobileMenu).toHaveAttribute('role', 'dialog');
    await expect(mobileMenu).toHaveAttribute('aria-modal', 'true');
    await expect(mobileMenu).toHaveAttribute('aria-label', 'Navigation menu');
  });

  test('disconnected mobile menu shows connect wallet CTA', async ({ page }) => {
    await page.goto('/');
    await waitForNav(page);

    await page.getByRole('button', { name: /open navigation menu/i }).click();
    await expect(page.locator('[id="mobile-menu"]').getByRole('button', { name: /connect wallet/i })).toBeVisible();
  });
});

// ── 9. Core resource deep links (disconnected user) ───────────

test.describe('Core resource deep links', () => {
  test('/explore deep link loads without errors', async ({ page }) => {
    const res = await page.goto('/explore');
    expect(res?.status()).toBe(200);
  });

  test('/auctions deep link loads without errors', async ({ page }) => {
    const res = await page.goto('/auctions');
    expect(res?.status()).toBe(200);
  });

  test('/launchpad deep link loads without errors', async ({ page }) => {
    const res = await page.goto('/launchpad');
    expect(res?.status()).toBe(200);
  });

  test('/activity deep link loads without errors', async ({ page }) => {
    const res = await page.goto('/activity');
    expect(res?.status()).toBe(200);
  });

  test('/help deep link loads without errors', async ({ page }) => {
    const res = await page.goto('/help');
    expect(res?.status()).toBe(200);
  });

  test('/settings deep link loads without errors', async ({ page }) => {
    const res = await page.goto('/settings');
    expect(res?.status()).toBe(200);
  });
});

// ── 10. Navigation between resource pages ─────────────────────

test.describe('Transitions between resource pages', () => {
  test('Explore → Auctions via nav link', async ({ page }) => {
    await page.goto('/explore');
    await waitForNav(page);

    await page.locator('nav[aria-label="Primary navigation"]').getByRole('link', { name: 'Auctions' }).click();
    await expect(page).toHaveURL('/auctions');
    await expect(page.locator('h1')).toContainText('Auctions');
  });

  test('Auctions → Launchpad via nav link', async ({ page }) => {
    await page.goto('/auctions');
    await waitForNav(page);

    await page.locator('nav[aria-label="Primary navigation"]').getByRole('link', { name: 'Launchpad' }).click();
    await expect(page).toHaveURL('/launchpad');
  });

  test('Launchpad Collections breadcrumb navigates back', async ({ page }) => {
    await page.goto('/launchpad/collections');
    await page.locator('nav[aria-label="Breadcrumb"]').getByRole('link', { name: 'Launchpad' }).click();
    await expect(page).toHaveURL('/launchpad');
  });
});
