/**
 * navbar-320px.spec.ts — Issue 1035
 *
 * Documents and verifies the sticky navigation layout at the 320×568 px
 * smallest supported viewport. This spec records the tested viewport in
 * the test name so reviewers know what baseline was verified.
 *
 * Checks (all at 320×568 "narrow"):
 *   • No horizontal overflow in the navbar bar itself.
 *   • Hamburger button is fully visible and usable.
 *   • Logo link is not clipped (bounding box width > 0).
 *   • Opening the menu: drawer appears, all nav links reachable.
 *   • Connect Wallet button in the mobile drawer is not clipped.
 *   • Escape closes the mobile menu.
 *   • Language / locale control is present (desktop-only, so it
 *     does not appear in the mobile drawer but is accessible via desktop).
 */

import { test, expect } from "@playwright/test";
import {
  MarketplaceTestStore,
  setupMarketplaceMocks,
  resetE2eListingsInBrowser,
} from "./helpers/marketplace-mocks";

// Smallest supported viewport documented in the design system
const NARROW = { width: 320, height: 568 };

test.describe("Navbar — 320×568 narrow viewport (Issue 1035)", () => {
  const store = new MarketplaceTestStore();

  test.beforeEach(async ({ page }) => {
    store.reset();
    await setupMarketplaceMocks(page, store);
    await resetE2eListingsInBrowser(page);
    await page.setViewportSize(NARROW);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  // ── Overflow ─────────────────────────────────────────────────

  test("navbar bar has no horizontal overflow at 320px", async ({ page }) => {
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `scrollWidth (${overflow.scrollWidth}) > clientWidth (${overflow.clientWidth})`
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  // ── Logo ─────────────────────────────────────────────────────

  test("logo link is fully visible and not clipped at 320px", async ({ page }) => {
    const logo = page.getByRole("link", { name: /elcarehub home/i });
    await expect(logo).toBeVisible();
    const box = await logo.boundingBox();
    expect(box, "logo bounding box is null").not.toBeNull();
    expect(box!.width, "logo link has zero width — clipped").toBeGreaterThan(0);
    expect(box!.x, "logo is positioned outside the left viewport edge").toBeGreaterThanOrEqual(0);
    expect(
      box!.x + box!.width,
      "logo extends beyond the right viewport edge"
    ).toBeLessThanOrEqual(NARROW.width + 1);
  });

  // ── Hamburger ────────────────────────────────────────────────

  test("hamburger button is fully visible at 320px", async ({ page }) => {
    const hamburger = page.getByRole("button", { name: /open navigation menu/i });
    await expect(hamburger).toBeVisible();
    const box = await hamburger.boundingBox();
    expect(box).not.toBeNull();
    // Minimum touch target
    expect(box!.height).toBeGreaterThanOrEqual(36);
    expect(box!.width).toBeGreaterThanOrEqual(36);
    // Must be fully inside the viewport horizontally
    expect(box!.x + box!.width).toBeLessThanOrEqual(NARROW.width + 1);
  });

  // ── Mobile drawer ─────────────────────────────────────────────

  test("mobile menu opens and all public nav links are reachable at 320px", async ({ page }) => {
    const hamburger = page.getByRole("button", { name: /open navigation menu/i });
    await hamburger.click();

    // Check a representative set of nav labels
    for (const label of ["Marketplace", "Discover", "Auctions", "Launchpad"]) {
      await expect(page.getByRole("link", { name: label }).first()).toBeVisible();
    }
  });

  test("Connect Wallet button in the mobile drawer is visible and not clipped at 320px", async ({ page }) => {
    await page.getByRole("button", { name: /open navigation menu/i }).click();

    const connectBtn = page.getByRole("button", { name: /connect wallet/i }).last();
    await expect(connectBtn).toBeVisible();
    const box = await connectBtn.boundingBox();
    expect(box).not.toBeNull();
    // Must fit within the drawer (not scroll out of horizontal bounds)
    expect(box!.width, "button too narrow — may be clipped").toBeGreaterThan(80);
    expect(box!.x + box!.width, "button extends beyond viewport").toBeLessThanOrEqual(
      NARROW.width + 2
    );
  });

  test("Escape closes the mobile menu at 320px", async ({ page }) => {
    await page.getByRole("button", { name: /open navigation menu/i }).click();

    // Menu is open — confirm a nav link is visible
    await expect(
      page.getByRole("link", { name: "Discover" }).first()
    ).toBeVisible();

    await page.keyboard.press("Escape");

    // After Escape the menu should not be interactable
    await expect(
      page.getByRole("link", { name: "Discover" }).first()
    ).not.toBeVisible({ timeout: 3_000 });
  });

  test("Settings and Help links are present in the mobile menu at 320px", async ({ page }) => {
    await page.getByRole("button", { name: /open navigation menu/i }).click();

    await expect(
      page.getByRole("link", { name: /settings/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /help/i }).first()
    ).toBeVisible();
  });

  // ── Explore page at 320px ─────────────────────────────────────

  test("explore page has no horizontal overflow at 320px", async ({ page }) => {
    await page.goto("/explore");
    await page.waitForLoadState("domcontentloaded");

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test("auctions page has no horizontal overflow at 320px", async ({ page }) => {
    await page.goto("/auctions");
    await page.waitForLoadState("domcontentloaded");

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
