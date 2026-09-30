import { test, expect } from '@playwright/test';
import { BUYER_PUBLIC_KEY, TEST_PUBLIC_KEY, mockFreighterWrongNetwork } from './freighter-mock';
import {
  E2E_METADATA_CID,
  MarketplaceTestStore,
  MOCK_ARTWORK_METADATA,
  setupMarketplaceMocks,
  resetE2eListingsInBrowser,
  seedE2eChainListing,
} from './helpers/marketplace-mocks';
import { connectFreighterWallet } from './helpers/wallet';
import { setE2eFailureMode } from './helpers/failure-mode';

// ─────────────────────────────────────────────────────────────────────────────
// Issue #525 — End-to-end wallet failure matrix
//
// Exercises the purchase write surface (checkout / buy_artwork) against nine
// deterministic wallet, RPC, chain, and indexer failure scenarios, asserting
// that every one of them ends in an actionable, non-sensitive UI state
// instead of a crash, a stuck spinner, or a raw stack trace.
//
// Failures are injected via window.__E2E_SET_FAILURE_MODE__ (see
// src/lib/e2e-chain-mock.ts), which throws the same kind of error message a
// real Freighter / Soroban RPC / Horizon failure would produce, so this
// suite exercises the real classifyTxError + TxErrorPanel code path — the
// mock only decides *when* to fail, never how the app reacts.
//
// See docs/e2e-wallet-failure-matrix.md for scenario coverage and known
// provider-specific limitations.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TOKEN =
  process.env.NEXT_PUBLIC_NATIVE_TOKEN_CONTRACT_ID ??
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

let nextListingId = 9200;

function freshListingId() {
  return nextListingId++;
}

test.describe('Wallet failure matrix (mock chain)', () => {
  const store = new MarketplaceTestStore();

  test.beforeEach(async ({ page }) => {
    store.reset();
    await setupMarketplaceMocks(page, store);
    await resetE2eListingsInBrowser(page);
  });

  async function seedListing(page: import('@playwright/test').Page, listingId: number) {
    store.upsertActive({
      listing_id: listingId,
      artist: TEST_PUBLIC_KEY,
      metadata_cid: E2E_METADATA_CID,
      price: String(15 * 10_000_000),
      currency: 'XLM',
      token: DEFAULT_TOKEN,
      status: 'Active',
      owner: null,
      created_at: Math.floor(Date.now() / 1000),
      original_creator: TEST_PUBLIC_KEY,
      royalty_bps: 0,
      recipients: [{ address: TEST_PUBLIC_KEY, percentage: 100 }],
    });
    await seedE2eChainListing(page, {
      listing_id: listingId,
      artist: TEST_PUBLIC_KEY,
      metadata_cid: E2E_METADATA_CID,
      price: String(15 * 10_000_000),
      token: DEFAULT_TOKEN,
    });
  }

  async function openCheckoutAndAttemptPay(
    page: import('@playwright/test').Page,
    listingId: number
  ) {
    await page.goto('/explore');
    await expect(page.getByTestId('explore-page')).toBeVisible({ timeout: 60_000 });
    const listingCard = page.getByTestId(`listing-card-${listingId}`);
    await listingCard.getByTestId('buy-now-button').click();
    await expect(page.getByTestId('checkout-modal')).toBeVisible();

    // First click: preview → confirm. Second click: confirm → submit.
    await page.getByTestId('checkout-pay-button').click();
    await page.getByTestId('checkout-pay-button').click();
  }

  // ── 1. Wallet rejection ──────────────────────────────────────────────────
  test('rejection: declining in-flight leaves the draft editable with a retry-friendly panel', async ({
    page,
  }) => {
    const listingId = freshListingId();
    await seedListing(page, listingId);
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await setE2eFailureMode(page, 'wallet_rejection');
    await seedListing(page, listingId);

    await openCheckoutAndAttemptPay(page, listingId);

    const errorPanel = page.getByTestId('tx-error-panel');
    await expect(errorPanel).toBeVisible({ timeout: 10_000 });
    await expect(errorPanel).toContainText(/declined/i);
    // Nothing was charged, the checkout stays open so the user can retry —
    // never a silent crash or a modal that disappears mid-failure.
    await expect(page.getByTestId('checkout-modal')).toBeVisible();
    await expect(page.getByRole('button', { name: /try again/i })).toBeVisible();
    // Diagnostics redaction: the buyer's full public key never appears
    // anywhere in the error surface, only the truncated form the navbar
    // already shows for the connected wallet.
    await expect(errorPanel).not.toContainText(BUYER_PUBLIC_KEY);
  });

  // ── 2. Disconnect ─────────────────────────────────────────────────────────
  test('disconnect: buying while disconnected prompts reconnect instead of crashing', async ({
    page,
  }) => {
    const listingId = freshListingId();
    await seedListing(page, listingId);

    await page.goto('/explore');
    await expect(page.getByTestId('explore-page')).toBeVisible({ timeout: 60_000 });

    const listingCard = page.getByTestId(`listing-card-${listingId}`);
    await listingCard.getByTestId('buy-now-button').click();

    // GuardButton intercepts the click before checkout ever opens.
    await expect(page.getByRole('heading', { name: /connect wallet/i })).toBeVisible();
    await expect(page.getByTestId('checkout-modal')).toHaveCount(0);
  });

  // ── 3. Network mismatch ──────────────────────────────────────────────────
  test('network mismatch: wrong-network wallet blocks purchase with a switch-network prompt', async ({
    page,
  }) => {
    const listingId = freshListingId();
    store.upsertActive({
      listing_id: listingId,
      artist: TEST_PUBLIC_KEY,
      metadata_cid: E2E_METADATA_CID,
      price: String(15 * 10_000_000),
      currency: 'XLM',
      token: DEFAULT_TOKEN,
      status: 'Active',
      owner: null,
      created_at: Math.floor(Date.now() / 1000),
      original_creator: TEST_PUBLIC_KEY,
      royalty_bps: 0,
      recipients: [{ address: TEST_PUBLIC_KEY, percentage: 100 }],
    });

    await mockFreighterWrongNetwork(page);
    await page.goto('/explore');
    await expect(page.getByTestId('explore-page')).toBeVisible({ timeout: 60_000 });

    const listingCard = page.getByTestId(`listing-card-${listingId}`);
    await listingCard.getByTestId('buy-now-button').click();

    await expect(page.getByText(/wrong network/i)).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('checkout-modal')).toHaveCount(0);
  });

  // ── 4. Simulation failure ────────────────────────────────────────────────
  test('simulation failure: preflight rejection tells the buyer to refresh and retry', async ({
    page,
  }) => {
    const listingId = freshListingId();
    await seedListing(page, listingId);
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await setE2eFailureMode(page, 'simulation_failure');
    await seedListing(page, listingId);

    await openCheckoutAndAttemptPay(page, listingId);

    const errorPanel = page.getByTestId('tx-error-panel');
    await expect(errorPanel).toBeVisible({ timeout: 10_000 });
    await expect(errorPanel).toContainText(/simulat|preview/i);
    await expect(errorPanel).toContainText(/refresh/i);
  });

  // ── 5. Insufficient balance ──────────────────────────────────────────────
  test('insufficient balance: a clear funds message, no raw contract dump', async ({ page }) => {
    const listingId = freshListingId();
    await seedListing(page, listingId);
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await setE2eFailureMode(page, 'insufficient_balance');
    await seedListing(page, listingId);

    await openCheckoutAndAttemptPay(page, listingId);

    const errorPanel = page.getByTestId('tx-error-panel');
    await expect(errorPanel).toBeVisible({ timeout: 10_000 });
    await expect(errorPanel).toContainText(/insufficient/i);
    // The raw technical message is only reachable behind the collapsed
    // "Technical details" <details> — never shown inline by default.
    await expect(page.getByText(/technical details/i)).toBeVisible();
  });

  // ── 6. Submission timeout ────────────────────────────────────────────────
  test('submission timeout: a stalled submit surfaces a network-error panel with retry', async ({
    page,
  }) => {
    const listingId = freshListingId();
    await seedListing(page, listingId);
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await setE2eFailureMode(page, 'submission_timeout');
    await seedListing(page, listingId);

    await openCheckoutAndAttemptPay(page, listingId);

    const errorPanel = page.getByTestId('tx-error-panel');
    await expect(errorPanel).toBeVisible({ timeout: 10_000 });
    await expect(errorPanel).toContainText(/network error|try again/i);
    await expect(page.getByRole('button', { name: /try again/i })).toBeVisible();
  });

  // ── 7. Chain failure ─────────────────────────────────────────────────────
  test('chain failure: a Horizon/RPC outage surfaces a network-error panel with retry', async ({
    page,
  }) => {
    const listingId = freshListingId();
    await seedListing(page, listingId);
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await setE2eFailureMode(page, 'chain_failure');
    await seedListing(page, listingId);

    await openCheckoutAndAttemptPay(page, listingId);

    const errorPanel = page.getByTestId('tx-error-panel');
    await expect(errorPanel).toBeVisible({ timeout: 10_000 });
    await expect(errorPanel).toContainText(/network error/i);
    await expect(page.getByRole('button', { name: /try again/i })).toBeVisible();
  });

  // ── 8. Indexer lag ───────────────────────────────────────────────────────
  test('indexer lag: a confirmed purchase shows a "waiting for indexer" state, not a dead spinner', async ({
    page,
  }) => {
    const listingId = freshListingId();
    await seedListing(page, listingId);
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await seedListing(page, listingId);

    await openCheckoutAndAttemptPay(page, listingId);

    // On-chain confirmation is immediate in the mock chain, so the flow
    // moves straight into the indexer_pending phase — a real deploy waits
    // up to indexerConfirmTimeoutMs (default 30s) here before declaring
    // success; we only assert the transient state is reachable and labelled,
    // not that it resolves (see docs/e2e-wallet-failure-matrix.md limitations).
    await expect(
      page.getByRole('button', { name: /waiting for indexer confirmation/i })
    ).toBeVisible({ timeout: 8000 });
  });

  // ── 9. Reorg reset ───────────────────────────────────────────────────────
  test('reorg reset: a listing that reverts after confirmation settles back without a stuck UI', async ({
    page,
  }) => {
    const listingId = freshListingId();
    await seedListing(page, listingId);
    await connectFreighterWallet(page, BUYER_PUBLIC_KEY);
    await seedListing(page, listingId);

    await openCheckoutAndAttemptPay(page, listingId);
    await expect(page.getByTestId('purchase-success')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('checkout-modal')).toBeHidden();

    // Simulate an indexer rollback: the confirmed sale is briefly reverted
    // to Active before the indexer reconciles back to Sold (Stellar/Soroban
    // has fast finality — this models an indexer-side reconciliation blip
    // rather than a true consensus reorg).
    store.upsertActive({
      listing_id: listingId,
      artist: TEST_PUBLIC_KEY,
      metadata_cid: E2E_METADATA_CID,
      price: String(15 * 10_000_000),
      currency: 'XLM',
      token: DEFAULT_TOKEN,
      status: 'Active',
      owner: null,
      created_at: Math.floor(Date.now() / 1000),
      original_creator: TEST_PUBLIC_KEY,
      royalty_bps: 0,
      recipients: [{ address: TEST_PUBLIC_KEY, percentage: 100 }],
    });
    await page.goto('/explore');
    await expect(page.getByTestId(`listing-card-${listingId}`)).not.toContainText('Sold');
    // No crash, no leaked internal error state on a plain re-render.
    await expect(page.getByTestId('tx-error-panel')).toHaveCount(0);

    store.markSold(listingId, BUYER_PUBLIC_KEY);
    await page.goto('/explore');
    await expect(page.getByTestId(`listing-card-${listingId}`)).toContainText('Sold');
  });
});
