import { Page, expect } from '@playwright/test';
import { mockFreighter, TEST_PUBLIC_KEY } from '../freighter-mock';

export async function connectFreighterWallet(
  page: Page,
  publicKey: string = TEST_PUBLIC_KEY
) {
  await mockFreighter(page, { publicKey });
  await page.goto('/');
  await expect(page.getByText('ELCARE-HUB').first()).toBeVisible({ timeout: 60_000 });

  const nav = page.locator('nav');
  const shortKey = `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`;

  if (!(await page.getByText(shortKey).isVisible().catch(() => false))) {
    await nav.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await page.getByRole('button', { name: /Freighter/i }).click();
  }

  await expect(
    page.getByTestId('wallet-connected').or(page.getByText(shortKey))
  ).toBeVisible({ timeout: 20_000 });
}

export async function openNewListingTab(page: Page) {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: /new listing/i }).click();
  await expect(page.getByText('List Your Artwork')).toBeVisible();
}

/**
 * Assert that a decorative element has no active animation or transition
 * under the reduced-motion preference (issue #1147).
 */
export async function expectReducedMotion(
  page: Page,
  selector: string
) {
  const locator = page.locator(selector).first();
  await expect(locator).toBeVisible({ timeout: 20_000 });

  const styles = await locator.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return {
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      transitionDuration: cs.transitionDuration,
    };
  });

  // animation-name should be 'none' (no decorative animation running)
  expect(styles.animationName).toBe('none');
  // animation-duration should be '0s' (no animation timing)
  expect(styles.animationDuration).toBe('0s');
  // transition-duration should be '0s' (no transition timing)
  expect(styles.transitionDuration).toBe('0s');
}

/**
 * Assert that essential transaction feedback (toast/status) remains visible
 * even under reduced-motion (issue #1147).
 */
export async function expectTransactionFeedbackVisible(
  page: Page,
  selector: string
) {
  const locator = page.locator(selector).first();
  await expect(locator).toBeVisible({ timeout: 20_000 });
  // Feedback must remain visible, not hidden by reduced-motion styles.
  await expect(locator).not.toHaveCSS('visibility', 'hidden');
  await expect(locator).not.toHaveCSS('display', 'none');
}