import React from 'react';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Module mocks (declared before importing the component under test)
// ---------------------------------------------------------------------------

const mockGetAuction = jest.fn();
const mockFetchMetadata = jest.fn();
const mockSubscribeToMarketplaceEvents = jest.fn();
const mockUsePlaceBid = jest.fn();
const mockUseIndexerFreshness = jest.fn();

jest.mock('@/lib/indexer', () => ({
  getAuction: (...args: unknown[]) => mockGetAuction(...args),
  fetchMetadata: (...args: unknown[]) => mockFetchMetadata(...args),
  subscribeToMarketplaceEvents: (...args: unknown[]) =>
    mockSubscribeToMarketplaceEvents(...args),
}));

jest.mock('@/hooks/usePlaceBid', () => ({
  usePlaceBid: (...args: unknown[]) => mockUsePlaceBid(...args),
}));

jest.mock('@/hooks/useIndexerFreshness', () => ({
  useIndexerFreshness: (...args: unknown[]) => mockUseIndexerFreshness(...args),
}));

// StaleBanner is a small presentational component; keep it real so we assert
// the actual copy and announcer semantics rendered to the user.
import AuctionDetailPage from '@/app/auctions/[id]/page';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUCTION_ID = 'auction-stale-1';

const staleAuctionFixture = {
  id: AUCTION_ID,
  seller: '0xseller',
  tokenId: '1',
  tokenAddress: '0xtoken',
  reservePrice: '1000000000000000000',
  highestBid: '2000000000000000000',
  highestBidder: '0xbidder',
  // A final-looking status coming from old indexer state. The page must not
  // present this as a live final status while the indexer is stale.
  status: 'finalized',
  endTime: '2020-01-01T00:00:00.000Z',
  startTime: '2019-12-01T00:00:00.000Z',
};

const staleMetadataFixture = {
  name: 'Stale Auction NFT',
  description: 'Metadata fetched from stale indexer state',
  image: 'https://example.invalid/image.png',
};

const staleFreshnessFixture = {
  status: 'stale' as const,
  isStale: true,
  isFresh: false,
  lastUpdated: '2020-01-01T00:00:00.000Z',
  staleSince: '2020-01-01T00:00:00.000Z',
};

const placeBidMock = jest.fn();

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AuctionDetailPage stale indexer data', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockGetAuction.mockResolvedValue(staleAuctionFixture);
    mockFetchMetadata.mockResolvedValue(staleMetadataFixture);
    mockSubscribeToMarketplaceEvents.mockReturnValue(jest.fn());
    mockUseIndexerFreshness.mockReturnValue(staleFreshnessFixture);
    mockUsePlaceBid.mockReturnValue({
      placeBid: placeBidMock,
      isPending: false,
      isSubmitting: false,
      error: null,
      disabled: true,
    });
  });

  afterEach(() => {
    cleanup();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('shows the stale banner copy and announcer semantics instead of a live final status', async () => {
    render(<AuctionDetailPage params={{ id: AUCTION_ID }} />);

    // Allow the async auction/metadata fetch to settle deterministically.
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockGetAuction).toHaveBeenCalledWith(AUCTION_ID);
    });

    // Stale banner copy is visible to sighted users.
    const banner = await screen.findByRole('status');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/stale/i);
    expect(banner).toHaveTextContent(/indexer/i);

    // Announcer semantics: the banner is a live region so screen readers
    // announce the stale state.
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveAttribute('role', 'status');

    // The stale final-looking status must not be presented as a live final
    // status. The page should not render a "Finalized" live status label.
    expect(screen.queryByText(/^finalized$/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/auction (has )?finalized/i),
    ).not.toBeInTheDocument();
  });

  it('does not submit a bid from stale state', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    render(<AuctionDetailPage params={{ id: AUCTION_ID }} />);

    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockGetAuction).toHaveBeenCalledWith(AUCTION_ID);
    });

    const bidButton = screen.queryByRole('button', { name: /place bid|bid/i });

    if (bidButton) {
      expect(bidButton).toBeDisabled();
      await user.click(bidButton);
    }

    // Regardless of whether the button is rendered, no bid submission should
    // occur while the indexer is stale.
    expect(placeBidMock).not.toHaveBeenCalled();
  });

  it('keeps network mocks deterministic and cleans up the event subscription', async () => {
    const unsubscribe = jest.fn();
    mockSubscribeToMarketplaceEvents.mockReturnValue(unsubscribe);

    const { unmount } = render(
      <AuctionDetailPage params={{ id: AUCTION_ID }} />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockGetAuction).toHaveBeenCalledTimes(1);
    });

    expect(mockGetAuction).toHaveBeenCalledWith(AUCTION_ID);
    expect(mockFetchMetadata).toHaveBeenCalledTimes(1);

    unmount();

    // Subscription cleanup should run on unmount.
    expect(unsubscribe).toHaveBeenCalled();
  });
});