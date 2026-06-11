import { Page } from '@playwright/test';

export const E2E_METADATA_CID = 'QmE2eTestMetadataCid';
export const E2E_IMAGE_CID = 'QmE2eTestImageCid';

export const MOCK_ARTWORK_METADATA = {
  title: 'E2E Serengeti Sunset',
  description: 'Automated test listing',
  artist: 'E2E Artist',
  image: `ipfs://${E2E_IMAGE_CID}`,
  year: '2024',
  category: 'Digital Art',
};

export interface E2eIndexerListing {
  listing_id: number;
  artist: string;
  metadata_cid: string;
  price: string;
  currency: string;
  token: string;
  status: string;
  owner: string | null;
  created_at: number;
  original_creator: string;
  royalty_bps: number;
  recipients: Array<{ address: string; percentage: number }>;
}

/** Shared across pages in a test — indexer mock reads from here. */
export class MarketplaceTestStore {
  listings: E2eIndexerListing[] = [];

  reset() {
    this.listings = [];
  }

  upsertActive(listing: E2eIndexerListing) {
    this.listings = this.listings.filter((l) => l.listing_id !== listing.listing_id);
    this.listings.push(listing);
  }

  markSold(listingId: number, buyer: string) {
    this.listings = this.listings.map((l) =>
      l.listing_id === listingId ? { ...l, status: 'Sold', owner: buyer } : l
    );
  }

  activeListings() {
    return this.listings.filter((l) => l.status === 'Active');
  }
}

const INDEXER_URL = (
  process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:4000'
).replace(/\/$/, '');

/**
 * Mocks IPFS uploads, metadata gateway reads, and indexer listing API.
 * Chain calls use NEXT_PUBLIC_E2E_MOCK_CHAIN on the dev server.
 */
export async function setupMarketplaceMocks(page: Page, store: MarketplaceTestStore) {
  await page.route('**/api/ipfs/upload-image', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cid: E2E_IMAGE_CID }),
    });
  });

  await page.route('**/api/ipfs/upload-metadata', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cid: E2E_METADATA_CID }),
    });
  });

  const fulfillMetadata = async (route: { fulfill: (opts: object) => Promise<void> }) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_ARTWORK_METADATA),
    });
  };

  await page.route('**/gateway.pinata.cloud/ipfs/**', fulfillMetadata);
  await page.route('**/ipfs.io/ipfs/**', fulfillMetadata);

  await page.route(`${INDEXER_URL}/listings**`, async (route) => {
    if (route.request().method() !== 'GET') {
      return route.continue();
    }

    const url = new URL(route.request().url());
    const statusFilter = url.searchParams.get('status');
    let rows = store.listings;
    if (statusFilter && statusFilter !== 'All') {
      rows = rows.filter((l) => l.status === statusFilter);
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ listings: rows, total: rows.length }),
    });
  });
}

export async function resetE2eListingsInBrowser(page: Page) {
  await page.evaluate(() => {
    (window as Window & { __E2E_RESET_LISTINGS__?: () => void }).__E2E_RESET_LISTINGS__?.();
  });
}
