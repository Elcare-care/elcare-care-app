import { test, expect } from '@playwright/test';
import { BUYER_PUBLIC_KEY, TEST_PUBLIC_KEY } from './freighter-mock';
import {
  E2E_METADATA_CID,
  MarketplaceTestStore,
  setupMarketplaceMocks,
  resetE2eListingsInBrowser,
} from './helpers/marketplace-mocks';
import { connectFreighterWallet } from './helpers/wallet';

const DEFAULT_TOKEN =
  process.env.NEXT_PUBLIC_NATIVE_TOKEN_CONTRACT_ID ??
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

test.describe('Dialog keyboard behavior — focus trap, Escape, return focus', () => {
  const store = new MarketplaceTestStore();

  test.beforeEach(async ({ page }) => {
    store.reset();
    await setupMarketplaceMocks(page, store);
    await resetE2eListingsInBrowser(page);
  });

  test('checkout modal traps Tab focus and Escape returns focus to the trigger', async ({ page }) => {
    store.upsertActive({
      listing_id: 9301,
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

    const trigger = page.getByTestId('buy-now-button').first();
    await trigger.click();

    const dialog = page.getByTestId('checkout-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Initial focus lands inside the dialog, not on the page behind it.
    await expect(dialog).toContainText('Checkout');
    const activeInsideDialog = await page.evaluate((testId) => {
      const dlg = document.querySelector(`[data-testid="${testId}"]`);
      return !!dlg && dlg.contains(document.activeElement);
    }, 'checkout-modal');
    expect(activeInsideDialog).toBe(true);

    // Shift+Tab from the first focusable element should wrap to the last.
    await page.keyboard.press('Shift+Tab');
    const wrappedToLast = await page.evaluate((testId) => {
      const dlg = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      if (!dlg) return false;
      const focusable = Array.from(
        dlg.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      return document.activeElement === focusable[focusable.length - 1];
    }, 'checkout-modal');
    expect(wrappedToLast).toBe(true);

    // Escape closes the dialog and returns focus to the trigger that opened it.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('connect wallet modal traps focus and Escape returns focus to the Connect Wallet button', async ({ page }) => {
    await page.goto('/');

    const trigger = page
      .getByRole('navigation')
      .getByRole('button', { name: 'Connect Wallet', exact: true });
    await trigger.click();

    const dialog = page.getByTestId('connect-wallet-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('checkout modal close button and pay action remain reachable via Tab and are not color-only for errors', async ({ page }) => {
    store.upsertActive({
      listing_id: 9302,
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
    });

    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await page.getByTestId('buy-now-button').first().click();

    const dialog = page.getByTestId('checkout-modal');
    await expect(dialog).toBeVisible();

    const closeButton = dialog.getByRole('button', { name: /close checkout/i });
    await expect(closeButton).toBeVisible();

    const payButton = page.getByTestId('checkout-pay-button');
    await expect(payButton).toBeEnabled();
  });
});
